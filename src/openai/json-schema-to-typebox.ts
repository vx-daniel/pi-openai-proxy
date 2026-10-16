/**
 * JSON Schema -> TypeBox conversion for OpenAI function tool parameters.
 *
 * Contract:
 * - Support a documented subset of JSON Schema only
 * - Reject unsupported schema constructs with ConversionError
 * - Do not silently downgrade schemas: every keyword is carried over, dropped as meta, or rejected
 *
 * Supported subset:
 * - type: object, string, number, integer, boolean, array, null
 * - properties, required, items
 * - enum (string enums)
 * - nullable via type: [T, "null"]
 * - anyOf for nullable types and simple unions (max 10 branches)
 * - annotations on any node: description, title, default, examples, deprecated, readOnly, writeOnly
 * - constraints per type, carried over (see CONSTRAINT_KEYWORDS):
 *   string minLength, maxLength, pattern, format, const; number and integer minimum, maximum,
 *   exclusiveMinimum, exclusiveMaximum, multipleOf, const; boolean const; array minItems,
 *   maxItems, uniqueItems; object minProperties, maxProperties, additionalProperties (boolean)
 *
 * Dropped, logged at debug: $schema, $id, $comment (they say nothing to the model).
 *
 * Rejected:
 * - $ref, oneOf, allOf, not, if/then/else, patternProperties
 * - recursive schemas
 * - additionalProperties as a schema (boolean true/false allowed)
 * - any other keyword, or a supported keyword with a value of the wrong kind
 */

import { proxyLogger } from '@proxy/logging'
import { isRecord } from '@proxy/utils/guards'
import { type TSchema, Type } from 'typebox'

export interface SchemaConversionSuccess {
  readonly ok: true
  readonly schema: TSchema
}

export interface SchemaConversionError {
  readonly ok: false
  readonly message: string
  readonly path: string
}

export type SchemaConversionResult = SchemaConversionSuccess | SchemaConversionError

/**
 * Unsupported JSON Schema keywords that we reject explicitly.
 * Note: `anyOf` is handled separately for common patterns (nullable types, simple unions).
 */
const REJECTED_KEYWORDS = [
  '$ref',
  'oneOf',
  'allOf',
  'if',
  'then',
  'else',
  'patternProperties',
  'not'
] as const

const schemaLogger = proxyLogger('openai', 'schema')

const MAX_ANY_OF_BRANCHES = 10
const NULLABLE_TYPE_ARRAY_LENGTH = 2

/** What a keyword's value must be. `count` is a non-negative integer, `json` any JSON value. */
type KeywordValueKind = 'string' | 'number' | 'count' | 'boolean' | 'array' | 'json'

/** For each kind of keyword value: how errors describe it, and whether a value is one. */
const KEYWORD_VALUE_KINDS: Readonly<
  Record<
    KeywordValueKind,
    { readonly description: string; accepts(keywordValue: unknown): boolean }
  >
> = {
  string: { description: 'a string', accepts: (keywordValue) => typeof keywordValue === 'string' },
  number: {
    description: 'a finite number',
    accepts: (keywordValue) => typeof keywordValue === 'number' && Number.isFinite(keywordValue)
  },
  count: {
    description: 'a non-negative integer',
    accepts: (keywordValue) =>
      typeof keywordValue === 'number' && Number.isInteger(keywordValue) && keywordValue >= 0
  },
  boolean: {
    description: 'a boolean',
    accepts: (keywordValue) => typeof keywordValue === 'boolean'
  },
  array: { description: 'an array', accepts: (keywordValue) => Array.isArray(keywordValue) },
  json: { description: 'a JSON value', accepts: (keywordValue) => keywordValue !== undefined }
}

/** Annotations: allowed on any node, carried into the converted schema. */
const ANNOTATION_KEYWORDS: ReadonlyMap<string, KeywordValueKind> = new Map([
  ['description', 'string'],
  ['title', 'string'],
  ['default', 'json'],
  ['examples', 'array'],
  ['deprecated', 'boolean'],
  ['readOnly', 'boolean'],
  ['writeOnly', 'boolean']
])

/** Meta declarations: they say nothing to the model, so they are dropped (logged at debug). */
const META_KEYWORDS: ReadonlySet<string> = new Set(['$schema', '$id', '$comment'])

const NUMBER_CONSTRAINTS: ReadonlyMap<string, KeywordValueKind> = new Map([
  ['minimum', 'number'],
  ['maximum', 'number'],
  ['exclusiveMinimum', 'number'],
  ['exclusiveMaximum', 'number'],
  ['multipleOf', 'number'],
  ['const', 'json']
])

/** Validation keywords per type, carried into the converted schema. */
const CONSTRAINT_KEYWORDS: ReadonlyMap<string, ReadonlyMap<string, KeywordValueKind>> = new Map([
  [
    'string',
    new Map<string, KeywordValueKind>([
      ['minLength', 'count'],
      ['maxLength', 'count'],
      ['pattern', 'string'],
      ['format', 'string'],
      ['const', 'json']
    ])
  ],
  ['number', NUMBER_CONSTRAINTS],
  ['integer', NUMBER_CONSTRAINTS],
  ['boolean', new Map<string, KeywordValueKind>([['const', 'json']])],
  ['null', new Map<string, KeywordValueKind>()],
  [
    'array',
    new Map<string, KeywordValueKind>([
      ['minItems', 'count'],
      ['maxItems', 'count'],
      ['uniqueItems', 'boolean']
    ])
  ],
  [
    'object',
    new Map<string, KeywordValueKind>([
      ['minProperties', 'count'],
      ['maxProperties', 'count'],
      ['additionalProperties', 'boolean']
    ])
  ]
])

const NO_CONSTRAINTS: ReadonlyMap<string, KeywordValueKind> = new Map()

/** Keywords a type's converter reads itself, besides `type`. */
const STRUCTURAL_KEYWORDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['object', ['properties', 'required']],
  ['array', ['items']]
])

/**
 * Convert a JSON Schema object to a TypeBox TSchema.
 *
 * Returns a ConversionError for unsupported constructs.
 */
export function jsonSchemaToTypebox(schema: unknown, path = ''): SchemaConversionResult {
  const result = convertSchema(schema, path)
  if (result.ok) {
    schemaLogger.trace('Converted JSON Schema at {path}', { path: path || 'root' })
  } else {
    schemaLogger.debug('Rejected JSON Schema at {path}: {reason}', {
      path: result.path || 'root',
      reason: result.message
    })
  }
  return result
}

function convertSchema(schema: unknown, path: string): SchemaConversionResult {
  if (!isRecord(schema)) {
    return {
      ok: false,
      message: 'Schema must be an object',
      path
    }
  }

  const rejected = findRejectedKeyword(schema, path)
  if (rejected !== undefined) {
    return rejected
  }

  // Handle anyOf: common patterns like nullable types and simple type unions.
  // Example: anyOf: [{type: "string"}, {type: "null"}] -> Union(String, Null)
  const anyOf = schema['anyOf']
  if (Array.isArray(anyOf)) {
    const keywords = collectKeywords(schema, path, {
      structural: ['anyOf'],
      constraints: NO_CONSTRAINTS
    })
    return keywords.ok ? convertAnyOf(anyOf, path, keywords.opts) : keywords
  }

  // Handle enum
  const enumValues = schema['enum']
  if (Array.isArray(enumValues)) {
    const keywords = collectKeywords(schema, path, {
      structural: ['enum', 'type'],
      constraints: NO_CONSTRAINTS
    })
    return keywords.ok ? convertEnum(enumValues, path, keywords.opts) : keywords
  }

  // Determine the type
  const rawType = schema['type']

  // Handle nullable via type: [T, "null"]
  if (Array.isArray(rawType)) {
    return convertNullableType(rawType, schema, path)
  }

  if (typeof rawType !== 'string') {
    return convertUntyped(schema, path)
  }

  return convertTyped(rawType, schema, path)
}

function findRejectedKeyword(
  schema: Record<string, unknown>,
  path: string
): SchemaConversionResult | undefined {
  for (const keyword of REJECTED_KEYWORDS) {
    if (schema[keyword] !== undefined) {
      schemaLogger.debug('Unsupported JSON Schema keyword {keyword} at {path}', {
        keyword,
        path: path || 'root'
      })
      return {
        ok: false,
        message: `Unsupported JSON Schema keyword '${keyword}' at ${path || 'root'}`,
        path
      }
    }
  }
  return undefined
}

type KeywordCollection =
  | { readonly ok: true; readonly opts: Record<string, unknown> }
  | SchemaConversionError

/** What a node may carry besides annotations and meta keywords. */
interface AllowedKeywords {
  /** Keywords the node's converter reads itself. */
  readonly structural: readonly string[]
  /** Validation keywords carried into the converted schema. */
  readonly constraints: ReadonlyMap<string, KeywordValueKind>
  /** The node's `type`, named in the error for a keyword it does not support. */
  readonly typeName?: string
}

const ANNOTATIONS_ONLY: AllowedKeywords = { structural: [], constraints: NO_CONSTRAINTS }

/**
 * Check that every keyword of a node is allowed on it, and collect its annotations and
 * constraints as TypeBox options. Meta keywords are dropped (logged at debug); anything else is
 * rejected, so nothing is lost silently.
 */
function collectKeywords(
  schema: Record<string, unknown>,
  path: string,
  allowed: AllowedKeywords
): KeywordCollection {
  const opts: Record<string, unknown> = {}
  for (const [keyword, keywordValue] of Object.entries(schema)) {
    if (allowed.structural.includes(keyword)) {
      continue
    }
    if (META_KEYWORDS.has(keyword)) {
      schemaLogger.debug('Dropped meta keyword {keyword} at {path}', {
        keyword,
        path: path || 'root'
      })
      continue
    }
    const kind = ANNOTATION_KEYWORDS.get(keyword) ?? allowed.constraints.get(keyword)
    if (kind === undefined) {
      const forType = allowed.typeName === undefined ? '' : ` for type '${allowed.typeName}'`
      return {
        ok: false,
        message: `Unsupported JSON Schema keyword '${keyword}'${forType} at ${path || 'root'}`,
        path
      }
    }
    const valueKind = KEYWORD_VALUE_KINDS[kind]
    if (!valueKind.accepts(keywordValue)) {
      return {
        ok: false,
        message: `'${keyword}' must be ${valueKind.description} at ${path || 'root'}`,
        path
      }
    }
    opts[keyword] = keywordValue
  }
  return { ok: true, opts }
}

/**
 * No type specified: an unconstrained schema, allowed only when it carries nothing but
 * annotations (e.g. `{}` or `{ description }`).
 */
function convertUntyped(schema: Record<string, unknown>, path: string): SchemaConversionResult {
  const onlyAnnotations = Object.keys(schema).every(
    (keyword) => ANNOTATION_KEYWORDS.has(keyword) || META_KEYWORDS.has(keyword)
  )
  if (!onlyAnnotations) {
    return {
      ok: false,
      message: `Missing or invalid 'type' at ${path || 'root'}`,
      path
    }
  }
  const keywords = collectKeywords(schema, path, ANNOTATIONS_ONLY)
  return keywords.ok ? { ok: true, schema: Type.Unknown(keywords.opts) } : keywords
}

function convertTyped(
  rawType: string,
  schema: Record<string, unknown>,
  path: string
): SchemaConversionResult {
  const constraints = CONSTRAINT_KEYWORDS.get(rawType)
  if (constraints === undefined) {
    return {
      ok: false,
      message: `Unsupported type '${rawType}' at ${path || 'root'}`,
      path
    }
  }
  const keywords = collectKeywords(schema, path, {
    structural: ['type', ...(STRUCTURAL_KEYWORDS.get(rawType) ?? [])],
    constraints,
    typeName: rawType
  })
  if (!keywords.ok) {
    return keywords
  }
  const { opts } = keywords

  switch (rawType) {
    case 'object':
      return convertObject(schema, path, opts)
    case 'string':
      return { ok: true, schema: Type.String(opts) }
    case 'number':
      return { ok: true, schema: Type.Number(opts) }
    case 'integer':
      return { ok: true, schema: Type.Integer(opts) }
    case 'boolean':
      return { ok: true, schema: Type.Boolean(opts) }
    case 'array':
      return convertArray(schema, path, opts)
    case 'null':
      return { ok: true, schema: Type.Null(opts) }
    default:
      // Unreachable: CONSTRAINT_KEYWORDS has an entry for exactly the types handled above.
      return { ok: false, message: `Unsupported type '${rawType}' at ${path || 'root'}`, path }
  }
}

/**
 * Convert anyOf to a TypeBox Union.
 *
 * Supports:
 * - Nullable: anyOf: [{type: T}, {type: "null"}]
 * - Simple unions of supported types (max 10 branches)
 */
function convertAnyOf(
  branches: unknown[],
  path: string,
  opts: Record<string, unknown>
): SchemaConversionResult {
  if (branches.length === 0) {
    return { ok: false, message: `Empty 'anyOf' at ${path || 'root'}`, path }
  }
  if (branches.length > MAX_ANY_OF_BRANCHES) {
    return {
      ok: false,
      message: `'anyOf' with more than 10 branches is not supported at ${path || 'root'}`,
      path
    }
  }

  const converted: TSchema[] = []
  for (let branchIndex = 0; branchIndex < branches.length; branchIndex++) {
    const branchPath = `${path || 'root'}.anyOf[${String(branchIndex)}]`
    const result = convertSchema(branches[branchIndex], branchPath)
    if (!result.ok) {
      return result
    }
    converted.push(result.schema)
  }

  return { ok: true, schema: Type.Union(converted, opts) }
}

function convertEnum(
  values: unknown[],
  path: string,
  opts: Record<string, unknown>
): SchemaConversionResult {
  const stringValues: string[] = []
  for (const enumValue of values) {
    if (typeof enumValue !== 'string') {
      return {
        ok: false,
        message: `Only string enums are supported at ${path || 'root'}`,
        path
      }
    }
    stringValues.push(enumValue)
  }
  if (stringValues.length === 0) {
    return {
      ok: false,
      message: `Empty enum at ${path || 'root'}`,
      path
    }
  }
  // Use Type.Union of literals for string enums
  const literals = stringValues.map((enumValue) => Type.Literal(enumValue))
  return { ok: true, schema: Type.Union(literals, opts) }
}

/**
 * `type: [T, "null"]`: the annotations go on the union, everything else on the `T` branch, which
 * is converted (and checked) as if `type` were `T`.
 */
function convertNullableType(
  typeArray: unknown[],
  schema: Record<string, unknown>,
  path: string
): SchemaConversionResult {
  const nonNullTypes = typeArray.filter((typeName) => typeName !== 'null')
  if (nonNullTypes.length !== 1 || typeArray.length !== NULLABLE_TYPE_ARRAY_LENGTH) {
    return {
      ok: false,
      message: `Only [type, "null"] nullable types are supported at ${path || 'root'}`,
      path
    }
  }

  const innerType = nonNullTypes[0]
  if (typeof innerType !== 'string') {
    return {
      ok: false,
      message: `Invalid nullable type at ${path || 'root'}`,
      path
    }
  }

  const annotationSchema: Record<string, unknown> = {}
  const innerSchema: Record<string, unknown> = {}
  for (const [keyword, keywordValue] of Object.entries(schema)) {
    if (ANNOTATION_KEYWORDS.has(keyword)) {
      annotationSchema[keyword] = keywordValue
    } else {
      innerSchema[keyword] = keywordValue
    }
  }
  innerSchema['type'] = innerType

  const annotations = collectKeywords(annotationSchema, path, ANNOTATIONS_ONLY)
  if (!annotations.ok) {
    return annotations
  }
  const innerResult = convertSchema(innerSchema, path)
  if (!innerResult.ok) {
    return innerResult
  }

  return {
    ok: true,
    schema: Type.Union([innerResult.schema, Type.Null()], annotations.opts)
  }
}

function convertObject(
  schema: Record<string, unknown>,
  path: string,
  opts: Record<string, unknown>
): SchemaConversionResult {
  const rawProperties = schema['properties']
  const rawRequired = schema['required']

  // Object with no properties -- just return an empty object type
  if (rawProperties === undefined) {
    return { ok: true, schema: Type.Object({}, opts) }
  }

  if (!isRecord(rawProperties)) {
    return {
      ok: false,
      message: `'properties' must be an object at ${path || 'root'}`,
      path
    }
  }

  const requiredSet = new Set<string>()
  if (Array.isArray(rawRequired)) {
    for (const requiredName of rawRequired) {
      if (typeof requiredName === 'string') {
        requiredSet.add(requiredName)
      }
    }
  }

  const typeboxProperties: Record<string, TSchema> = {}

  for (const [key, propSchema] of Object.entries(rawProperties)) {
    const propPath = path.length > 0 ? `${path}.${key}` : key
    const result = convertSchema(propSchema, propPath)
    if (!result.ok) {
      return result
    }

    if (requiredSet.has(key)) {
      typeboxProperties[key] = result.schema
    } else {
      typeboxProperties[key] = Type.Optional(result.schema)
    }
  }

  return { ok: true, schema: Type.Object(typeboxProperties, opts) }
}

function convertArray(
  schema: Record<string, unknown>,
  path: string,
  opts: Record<string, unknown>
): SchemaConversionResult {
  const items = schema['items']
  if (items === undefined) {
    // Array with no items schema -- allow any items
    return { ok: true, schema: Type.Array(Type.Unknown(), opts) }
  }

  const itemPath = path.length > 0 ? `${path}.items` : 'items'
  const itemResult = convertSchema(items, itemPath)
  if (!itemResult.ok) {
    return itemResult
  }

  return { ok: true, schema: Type.Array(itemResult.schema, opts) }
}

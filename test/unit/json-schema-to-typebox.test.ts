import { jsonSchemaToTypebox } from '@proxy/openai/json-schema-to-typebox'
import { describe, expect, test } from 'vite-plus/test'

function schemaValue(schema: unknown, key: string): unknown {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return undefined
  }
  return Object.getOwnPropertyDescriptor(schema, key)?.value
}

describe('jsonSchemaToTypebox', () => {
  describe('primitive types', () => {
    test('converts string type', () => {
      const result = jsonSchemaToTypebox({ type: 'string' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(schemaValue(result.schema, 'type')).toBe('string')
    })

    test('converts number type', () => {
      const result = jsonSchemaToTypebox({ type: 'number' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(schemaValue(result.schema, 'type')).toBe('number')
    })

    test('converts integer type', () => {
      const result = jsonSchemaToTypebox({ type: 'integer' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(schemaValue(result.schema, 'type')).toBe('integer')
    })

    test('converts boolean type', () => {
      const result = jsonSchemaToTypebox({ type: 'boolean' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(schemaValue(result.schema, 'type')).toBe('boolean')
    })

    test('converts null type', () => {
      const result = jsonSchemaToTypebox({ type: 'null' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(schemaValue(result.schema, 'type')).toBe('null')
    })

    test('preserves description', () => {
      const result = jsonSchemaToTypebox({
        type: 'string',
        description: 'A name'
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(schemaValue(result.schema, 'description')).toBe('A name')
    })
  })

  describe('object type', () => {
    test('converts empty object', () => {
      const result = jsonSchemaToTypebox({ type: 'object' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(schemaValue(result.schema, 'type')).toBe('object')
    })

    test('converts object with properties', () => {
      const result = jsonSchemaToTypebox({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' }
        },
        required: ['name']
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(schemaValue(result.schema, 'type')).toBe('object')
      expect(schemaValue(result.schema, 'required')).toContain('name')
    })

    test('makes non-required properties optional', () => {
      const result = jsonSchemaToTypebox({
        type: 'object',
        properties: {
          name: { type: 'string' },
          nickname: { type: 'string' }
        },
        required: ['name']
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(schemaValue(result.schema, 'type')).toBe('object')
    })
  })

  describe('array type', () => {
    test('converts array with item schema', () => {
      const result = jsonSchemaToTypebox({
        type: 'array',
        items: { type: 'string' }
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(schemaValue(result.schema, 'type')).toBe('array')
    })

    test('converts array without items', () => {
      const result = jsonSchemaToTypebox({ type: 'array' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(schemaValue(result.schema, 'type')).toBe('array')
    })

    test('converts nested array of objects', () => {
      const result = jsonSchemaToTypebox({
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            tags: { type: 'array', items: { type: 'string' } }
          },
          required: ['id']
        }
      })
      expect(result.ok).toBe(true)
    })
  })

  describe('enum', () => {
    test('converts string enum', () => {
      const result = jsonSchemaToTypebox({
        enum: ['red', 'green', 'blue']
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(schemaValue(result.schema, 'anyOf')).toBeDefined()
    })

    test('rejects non-string enum values', () => {
      const result = jsonSchemaToTypebox({
        enum: [1, 2, 3]
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toContain('string enums')
    })

    test('rejects empty enum', () => {
      const result = jsonSchemaToTypebox({ enum: [] })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toContain('Empty enum')
    })
  })

  describe('nullable types', () => {
    test('converts nullable string', () => {
      const result = jsonSchemaToTypebox({
        type: ['string', 'null']
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(schemaValue(result.schema, 'anyOf')).toBeDefined()
    })

    test('rejects multi-type arrays beyond nullable', () => {
      const result = jsonSchemaToTypebox({
        type: ['string', 'number', 'null']
      })
      expect(result.ok).toBe(false)
    })
  })

  describe('rejected keywords', () => {
    test('rejects $ref', () => {
      const result = jsonSchemaToTypebox({
        $ref: '#/definitions/Foo'
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toContain('$ref')
    })

    test('rejects oneOf', () => {
      const result = jsonSchemaToTypebox({
        oneOf: [{ type: 'string' }, { type: 'number' }]
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toContain('oneOf')
    })

    test('rejects allOf', () => {
      const result = jsonSchemaToTypebox({
        allOf: [{ type: 'object' }]
      })
      expect(result.ok).toBe(false)
    })

    test('rejects patternProperties', () => {
      const result = jsonSchemaToTypebox({
        type: 'object',
        patternProperties: { '^S_': { type: 'string' } }
      })
      expect(result.ok).toBe(false)
    })
  })

  describe('edge cases', () => {
    test('rejects non-object schema', () => {
      const result = jsonSchemaToTypebox('not an object')
      expect(result.ok).toBe(false)
    })

    test('handles empty object as unconstrained', () => {
      const result = jsonSchemaToTypebox({})
      expect(result.ok).toBe(true)
    })

    test('rejects unknown type', () => {
      const result = jsonSchemaToTypebox({ type: 'date' })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toContain('date')
    })

    test('tracks path through nested properties', () => {
      const result = jsonSchemaToTypebox({
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: {
              bad: { $ref: '#/definitions/Bad' }
            }
          }
        }
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.path).toBe('nested.bad')
    })
  })

  describe('anyOf support', () => {
    test('converts nullable anyOf (string | null)', () => {
      const result = jsonSchemaToTypebox({
        anyOf: [{ type: 'string' }, { type: 'null' }]
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(schemaValue(result.schema, 'anyOf')).toHaveLength(2)
    })

    test('converts simple type union via anyOf', () => {
      const result = jsonSchemaToTypebox({
        anyOf: [{ type: 'string' }, { type: 'number' }]
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(schemaValue(result.schema, 'anyOf')).toHaveLength(2)
    })

    test('converts anyOf with object branch', () => {
      const result = jsonSchemaToTypebox({
        anyOf: [
          {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name']
          },
          { type: 'null' }
        ]
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(schemaValue(result.schema, 'anyOf')).toHaveLength(2)
    })

    test('preserves description on anyOf', () => {
      const result = jsonSchemaToTypebox({
        description: 'A timezone or null',
        anyOf: [{ type: 'string' }, { type: 'null' }]
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(schemaValue(result.schema, 'description')).toBe('A timezone or null')
    })

    test('rejects empty anyOf', () => {
      const result = jsonSchemaToTypebox({
        anyOf: []
      })
      expect(result.ok).toBe(false)
    })

    test('rejects anyOf with more than 10 branches', () => {
      const branches = Array.from({ length: 11 }, () => ({ type: 'string' }))
      const result = jsonSchemaToTypebox({ anyOf: branches })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toContain('10 branches')
    })

    test('rejects anyOf with unsupported branch', () => {
      const result = jsonSchemaToTypebox({
        anyOf: [{ type: 'string' }, { $ref: '#/bad' }]
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toContain('$ref')
    })

    test('works as property type in object schema', () => {
      const result = jsonSchemaToTypebox({
        type: 'object',
        properties: {
          timezone: {
            description: 'IANA timezone',
            anyOf: [{ type: 'string' }, { type: 'null' }]
          }
        }
      })
      expect(result.ok).toBe(true)
    })
  })

  describe('keywords beyond the structure', () => {
    /** The converted schema as sent upstream; TypeBox's symbol keys never leave the process. */
    function convertedJson(schema: Record<string, unknown>): unknown {
      const result = jsonSchemaToTypebox(schema, 'p')
      return result.ok ? JSON.parse(JSON.stringify(result.schema)) : result
    }

    // Catches a constraint or annotation dropped, renamed or moved for its type (#37). Each
    // schema converts to itself: every keyword is carried over unchanged.
    test.each([
      {
        type: 'string',
        minLength: 1,
        maxLength: 5,
        pattern: '^a',
        format: 'date-time',
        const: 'abc'
      },
      {
        type: 'number',
        minimum: 0,
        maximum: 1.5,
        exclusiveMinimum: -1,
        exclusiveMaximum: 2,
        multipleOf: 0.5
      },
      { type: 'integer', minimum: 1, maximum: 9, multipleOf: 1, const: 3 },
      { type: 'boolean', const: true },
      { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3, uniqueItems: true },
      {
        type: 'object',
        properties: {},
        minProperties: 1,
        maxProperties: 4,
        additionalProperties: true
      },
      {
        type: 'null',
        description: 'nothing',
        title: 'Nothing',
        default: null,
        examples: [null],
        deprecated: true,
        readOnly: true,
        writeOnly: false
      }
    ])('$type keeps its keywords', (schema) => {
      expect(convertedJson(schema)).toEqual(schema)
    })

    // Catches a constraint applied to the nullable union instead of the typed branch, where it
    // would also constrain `null`, or the annotations copied onto both.
    test('a nullable type puts constraints on its branch and annotations on the union', () => {
      expect(
        convertedJson({
          type: ['string', 'null'],
          maxLength: 3,
          description: 'zone',
          default: null
        })
      ).toEqual({
        anyOf: [{ type: 'string', maxLength: 3 }, { type: 'null' }],
        description: 'zone',
        default: null
      })
    })

    // Catches meta declarations forwarded upstream or refused: they mean nothing to the model.
    test('$schema, $id and $comment are dropped', () => {
      expect(
        convertedJson({
          $schema: 'http://json-schema.org/draft-07/schema#',
          $id: 'urn:weather',
          $comment: 'internal',
          type: 'object',
          properties: { city: { type: 'string', $comment: 'free text' } }
        })
      ).toEqual({ type: 'object', properties: { city: { type: 'string' } } })
    })

    // Catches a keyword outside the supported subset silently dropped instead of refused, a
    // keyword accepted on a type it does not apply to, a value of the wrong kind sent upstream to
    // fail there, or an inherited property name (`toString`) mistaken for a supported keyword.
    test.each([
      [
        { 'type': 'string', 'x-display': 'City' },
        "Unsupported JSON Schema keyword 'x-display' for type 'string' at p"
      ],
      [
        { type: 'integer', maxLength: 3 },
        "Unsupported JSON Schema keyword 'maxLength' for type 'integer' at p"
      ],
      [
        { type: 'string', toString: 'x' },
        "Unsupported JSON Schema keyword 'toString' for type 'string' at p"
      ],
      [
        { type: 'string', nullable: true },
        "Unsupported JSON Schema keyword 'nullable' for type 'string' at p"
      ],
      [
        { anyOf: [{ type: 'string' }], minLength: 1 },
        "Unsupported JSON Schema keyword 'minLength' at p"
      ],
      [
        { type: 'string', enum: ['a'], pattern: 'a' },
        "Unsupported JSON Schema keyword 'pattern' at p"
      ],
      [{ minimum: 1 }, "Missing or invalid 'type' at p"],
      [{ type: 'string', minLength: -1 }, "'minLength' must be a non-negative integer at p"],
      [{ type: 'array', maxItems: 1.5 }, "'maxItems' must be a non-negative integer at p"],
      [
        { type: 'number', exclusiveMinimum: true },
        "'exclusiveMinimum' must be a finite number at p"
      ],
      [{ type: 'string', pattern: 1 }, "'pattern' must be a string at p"],
      [{ type: 'array', uniqueItems: 'yes' }, "'uniqueItems' must be a boolean at p"],
      [{ type: 'string', examples: 'a' }, "'examples' must be an array at p"],
      [{ type: 'string', description: 1 }, "'description' must be a string at p"],
      [
        { type: 'object', additionalProperties: { type: 'string' } },
        "'additionalProperties' must be a boolean at p"
      ]
    ])('%j is refused', (schema, message) => {
      expect(jsonSchemaToTypebox(schema, 'p')).toEqual({ ok: false, message, path: 'p' })
    })
  })
})

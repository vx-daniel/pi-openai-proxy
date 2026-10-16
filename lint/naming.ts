/**
 * Naming rules: abbreviations, single-character names, and generic iteration names.
 *
 * Ported from the Biome GritQL plugin `ai-project-ts/.biome/naming.grit`. It is a plain
 * ESLint-style plugin (only type imports), so Oxlint and ESLint can both load it. Each Grit
 * tier is its own rule so each keeps its own severity:
 *
 *   naming/no-abbreviations            Grit error: abbreviation_binding + abbreviation_key
 *   naming/no-single-char-bindings     Grit warn:  single_char_binding
 *   naming/no-single-char-keys         Grit error: single_char_key
 *   naming/no-generic-iteration-names  Grit info:  generic_iteration_callback_var + _loop_var
 *
 * "Binding" means a JS declaration name: variable, parameter, function, class, catch
 * parameter, or import (Biome's `JsIdentifierBinding`). Type names, type parameters and
 * enum names are TypeScript bindings and are not checked. "Key" means a non-computed
 * identifier key on an object literal or pattern, a class member, an interface/type-literal
 * member, or an enum member (Biome's `JsLiteralMemberName`). Shorthand properties and
 * quoted, numeric, computed or private keys are not checked, as in the Grit original.
 *
 * Allowlist (the Grit `is_allowlisted` predicate): exact, case-sensitive names that are never
 * flagged. Put names every rule should accept in the shared lint settings, and names only one
 * rule should accept in that rule's options. Both are merged:
 *
 *   settings: { naming: { allow: ['z'] } }                     every naming rule
 *   'naming/no-abbreviations': ['error', { allow: ['ctx'] }]   one rule
 *
 * Add a name only with a receipt, such as a library's documented import convention, a
 * published API field, or a spec term. Unlike the Grit original, `z` is not built in: allow it
 * in config where the project uses zod's `import * as z`.
 */

import type { Context, ESTree, Plugin, Rule } from 'vite-plus/lint/plugins'

// Ported from eslint-plugin-unicorn's prevent-abbreviations dictionary, minus sanctioned
// conventions (`err`, `opts`) and high-noise names (`args`, `env`). Keep it one alternation.
const ABBREVIATION =
  /^(?:acc|amt|arr|attr|attrs|attType|auth|btn|buf|cb|cc|cfg|cn|cnt|conf|cr|ctx|cur|curr|cx|df|dir|dirs|dist|doc|docs|dst|el|elem|elems|ev|evt|ext|exts|func|hdr|idx|inp|len|lib|mod|msg|num|obj|out|pkg|qs|qty|req|res|ret|retval|sep|sig|sn|src|stdDev|str|tbl|td|temp|tit|tmp|ts|util|utils|val|vars|ver|win|bx|cmd|dec|dur|hi|lo|mem|prs|wf|sk|er)$/
// `_` never matches; the key tier also exempts `e` (as in the Grit original).
const SINGLE_CHAR = /^[a-z]$/
const GENERIC_ITERATION_NAME = /^(?:index|count|value|result|data|item|entry|text|name|id|obj|arr)$/

const ITERATION_METHODS = new Set(['map', 'filter', 'find', 'forEach', 'some', 'every', 'flatMap'])
const JS_BINDING_DEFINITIONS = new Set([
  'Variable',
  'Parameter',
  'FunctionName',
  'ClassName',
  'CatchClause',
  'ImportBinding'
])

const ALLOW_SCHEMA = [
  {
    type: 'object',
    properties: { allow: { type: 'array', items: { type: 'string' } } },
    additionalProperties: false
  }
]

type NameCheck = (name: string) => boolean

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((candidate): candidate is string => typeof candidate === 'string')
}

function allowField(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'allow' in value ? value.allow : undefined
}

/** Names exempt from this rule: shared `settings.naming.allow` plus the rule's `allow` option. */
function allowedNames(context: Context): ReadonlySet<string> {
  const shared = allowField(context.settings['naming'])
  const [options] = context.options
  return new Set([...stringArray(shared), ...stringArray(allowField(options))])
}

/** Reports every JS binding (declared name) whose name passes `check`. */
function checkBindings(context: Context, check: NameCheck, messageId: string): void {
  const allow = allowedNames(context)
  for (const scope of context.sourceCode.scopeManager.scopes) {
    for (const variable of scope.variables) {
      for (const definition of variable.defs) {
        const { name } = definition.name
        if (JS_BINDING_DEFINITIONS.has(definition.type) && check(name) && !allow.has(name)) {
          context.report({ node: definition.name, messageId })
        }
      }
    }
  }
}

type KeyVisitor = (key: ESTree.Node, computed: boolean) => void

/** Visitors for every member-key shape (the Grit `JsLiteralMemberName`). */
function memberKeyVisitors(visit: KeyVisitor): Record<string, (node: never) => void> {
  return {
    Property(node: ESTree.ObjectProperty | ESTree.BindingProperty) {
      if (!node.shorthand) visit(node.key, node.computed)
    },
    MethodDefinition(node: ESTree.MethodDefinition) {
      visit(node.key, node.computed)
    },
    PropertyDefinition(node: ESTree.PropertyDefinition) {
      visit(node.key, node.computed)
    },
    AccessorProperty(node: ESTree.AccessorProperty) {
      visit(node.key, node.computed)
    },
    TSPropertySignature(node: ESTree.TSPropertySignature) {
      visit(node.key, node.computed)
    },
    TSMethodSignature(node: ESTree.TSMethodSignature) {
      visit(node.key, node.computed)
    },
    TSEnumMember(node: ESTree.TSEnumMember) {
      visit(node.id, node.computed)
    }
  }
}

/** Visitors that report every member key whose name passes `check`. */
function reportKeys(
  context: Context,
  check: NameCheck,
  messageId: string
): Record<string, (node: never) => void> {
  const allow = allowedNames(context)
  return memberKeyVisitors((key, computed) => {
    if (computed || key.type !== 'Identifier') return
    if (check(key.name) && !allow.has(key.name)) {
      context.report({ node: key, messageId })
    }
  })
}

const noAbbreviations: Rule = {
  meta: {
    type: 'suggestion',
    schema: ALLOW_SCHEMA,
    messages: {
      binding:
        'Abbreviated name — use the full word (config, context, request, response, message, callback, index, element, …). A required external name goes in `settings.naming.allow`.',
      key: 'Abbreviated property key — use the full word (`ts` → `timestamp`, `dir` → `directory`, `cmd` → `command`, `cnt` → `count`). A required external name goes in `settings.naming.allow`.'
    }
  },
  create(context) {
    return {
      ...reportKeys(context, (name) => ABBREVIATION.test(name), 'key'),
      'Program:exit'() {
        checkBindings(context, (name) => ABBREVIATION.test(name), 'binding')
      }
    }
  }
}

const noSingleCharBindings: Rule = {
  meta: {
    type: 'suggestion',
    schema: ALLOW_SCHEMA,
    messages: {
      binding:
        'Single-character name — use a descriptive name. A required external name (such as zod’s `z`) goes in `settings.naming.allow`.'
    }
  },
  create(context) {
    return {
      'Program:exit'() {
        checkBindings(context, (name) => SINGLE_CHAR.test(name), 'binding')
      }
    }
  }
}

const noSingleCharKeys: Rule = {
  meta: {
    type: 'suggestion',
    schema: ALLOW_SCHEMA,
    messages: {
      key: 'Single-character property key — use a descriptive field name (`{ n: … }` → `{ count: … }`). Exempt: e. A required external name goes in `settings.naming.allow`.'
    }
  },
  create(context) {
    return reportKeys(context, (name) => SINGLE_CHAR.test(name) && name !== 'e', 'key')
  }
}

// The Grit templates match `(item)` / `(item, _)` callbacks and `reduce((_, item) => …[, init])`.
const MAX_ITERATION_CALLBACK_PARAMS = 2
const REDUCE_CALLBACK_PARAMS = 2
const MAX_REDUCE_ARGUMENTS = 2

/** The iteration variable of `xs.map(...)`-style and `xs.reduce(...)` arrow callbacks. */
function callbackIterationParam(node: ESTree.CallExpression): ESTree.Node | undefined {
  const { callee, arguments: callArguments } = node
  if (callee.type !== 'MemberExpression' || callee.computed) return undefined
  if (callee.property.type !== 'Identifier') return undefined
  const [callback] = callArguments
  if (callback?.type !== 'ArrowFunctionExpression') return undefined
  const method = callee.property.name
  const { params } = callback
  if (ITERATION_METHODS.has(method) && params.length <= MAX_ITERATION_CALLBACK_PARAMS) {
    return params[0]
  }
  const isReduce = method === 'reduce' && params.length === REDUCE_CALLBACK_PARAMS
  if (isReduce && callArguments.length <= MAX_REDUCE_ARGUMENTS) return params[1]
  return undefined
}

const noGenericIterationNames: Rule = {
  meta: {
    type: 'suggestion',
    schema: ALLOW_SCHEMA,
    messages: {
      generic:
        'Generic iteration variable — name what it walks (`sessions.map((s) => …)` → `(session) => …`, `for (let i = 0; i < rows.length; ...)` → `rowIndex`). Greppability wins in an agent codebase.'
    }
  },
  create(context) {
    const allow = allowedNames(context)
    const flag = (node: ESTree.Node | null | undefined): void => {
      if (node?.type !== 'Identifier') return
      if (GENERIC_ITERATION_NAME.test(node.name) && !allow.has(node.name)) {
        context.report({ node, messageId: 'generic' })
      }
    }
    const flagDeclaration = (declaration: ESTree.Node | null): void => {
      if (declaration?.type !== 'VariableDeclaration') return
      for (const variable of context.sourceCode.scopeManager.getDeclaredVariables(declaration)) {
        for (const identifier of variable.identifiers) flag(identifier)
      }
    }
    return {
      CallExpression(node: ESTree.CallExpression) {
        flag(callbackIterationParam(node))
      },
      ForStatement(node: ESTree.ForStatement) {
        flagDeclaration(node.init)
      },
      ForOfStatement(node: ESTree.ForOfStatement) {
        flagDeclaration(node.left)
      }
    }
  }
}

const plugin: Plugin = {
  meta: { name: 'naming' },
  rules: {
    'no-abbreviations': noAbbreviations,
    'no-single-char-bindings': noSingleCharBindings,
    'no-single-char-keys': noSingleCharKeys,
    'no-generic-iteration-names': noGenericIterationNames
  }
}

export default plugin

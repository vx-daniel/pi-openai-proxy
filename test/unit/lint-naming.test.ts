/**
 * The naming lint rules (lint/naming.ts), ported from the Biome GritQL plugin. Pins which
 * shapes each tier flags and which it deliberately leaves alone.
 */

import { RuleTester } from 'vite-plus/lint/plugins-dev'
import { describe, it } from 'vite-plus/test'

import naming from '../../lint/naming'

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

function rule(name: string): NonNullable<typeof naming.rules>[string] {
  const found = naming.rules[name]
  if (found === undefined) throw new Error(`naming/${name} is not defined`)
  return found
}

tester.run('no-abbreviations', rule('no-abbreviations'), {
  valid: [
    'const config = 1',
    'try { run() } catch (err) { report(err) }',
    "const options = { 'ts': 1 }",
    'type ctx = string',
    'function wrap<ctx>(value: ctx): ctx { return value }',
    'const value = request.ctx',
    { code: 'const ctx = 1', options: [{ allow: ['ctx'] }] },
    // Catches: the accessor / method-signature visitors flagging full words.
    'class Counter { accessor count = 0 }',
    'interface Lookup { index(): number }'
  ],
  invalid: [
    { code: 'const ctx = 1', errors: [{ messageId: 'binding' }] },
    {
      code: 'function handle(req, res) {}',
      errors: [{ messageId: 'binding' }, { messageId: 'binding' }]
    },
    { code: "import { config as cfg } from 'x'", errors: [{ messageId: 'binding' }] },
    { code: 'try { run() } catch (er) {}', errors: [{ messageId: 'binding' }] },
    { code: 'const { msg } = payload', errors: [{ messageId: 'binding' }] },
    { code: 'const event = { ts: 1 }', errors: [{ messageId: 'key' }] },
    { code: 'const { ts: timestamp } = event', errors: [{ messageId: 'key' }] },
    {
      code: 'class Counter { cnt = 0; idx() { return 0 } }',
      errors: [{ messageId: 'key' }, { messageId: 'key' }]
    },
    { code: 'interface Paths { dir: string }', errors: [{ messageId: 'key' }] },
    { code: 'enum Kind { tmp }', errors: [{ messageId: 'key' }] },
    // Catches: dropping the AccessorProperty visitor, so `accessor` fields go unchecked.
    {
      code: 'class Counter { accessor cnt = 0 }',
      errors: [{ messageId: 'key', line: 1, column: 25, endColumn: 28 }]
    },
    // Catches: dropping the TSMethodSignature visitor, so interface methods go unchecked.
    {
      code: 'interface Lookup { idx(): number }',
      errors: [{ messageId: 'key', line: 1, column: 19, endColumn: 22 }]
    }
  ]
})

tester.run('no-single-char-bindings', rule('no-single-char-bindings'), {
  valid: [
    'const _ = 1',
    { code: "import * as z from 'zod'", settings: { naming: { allow: ['z'] } } },
    'type T = string',
    'function identity<T>(value: T): T { return value }',
    'const { x: horizontal } = point'
  ],
  invalid: [
    { code: 'let i = 0', errors: [{ messageId: 'binding' }] },
    { code: 'rows.map((r) => r.id)', errors: [{ messageId: 'binding' }] },
    { code: 'for (let j = 0; j < 2; j++) {}', errors: [{ messageId: 'binding' }] },
    { code: "import * as z from 'zod'", errors: [{ messageId: 'binding' }] },
    {
      code: 'const a = 1; const b = 2',
      settings: { naming: { allow: ['a'] } },
      options: [{ allow: ['c'] }],
      errors: [{ messageId: 'binding' }]
    }
  ]
})

tester.run('no-single-char-keys', rule('no-single-char-keys'), {
  valid: [
    'const flags = { e: 1, _: 3 }',
    { code: 'const schema = { z: 1 }', settings: { naming: { allow: ['z'] } } },
    'const n = 1; const wrapped = { n }',
    "const units = { 's': 1000 }"
  ],
  invalid: [
    { code: 'const total = { n: 1 }', errors: [{ messageId: 'key' }] },
    { code: 'const schema = { z: 1 }', errors: [{ messageId: 'key' }] },
    { code: 'interface Point { x: number }', errors: [{ messageId: 'key' }] },
    { code: 'const { x: horizontal } = point', errors: [{ messageId: 'key' }] }
  ]
})

tester.run('no-generic-iteration-names', rule('no-generic-iteration-names'), {
  valid: [
    'orders.map((order) => order.id)',
    'orders.map((item, position, all) => item)',
    'orders.reduce((total, item) => total, 0, extra)',
    'function describe(item) { return item }',
    'for (const item in lookup) {}',
    { code: 'orders.map((item) => item)', options: [{ allow: ['item'] }] }
  ],
  invalid: [
    { code: 'orders.map((item) => item.id)', errors: [{ messageId: 'generic' }] },
    { code: 'orders.filter(entry => entry.open)', errors: [{ messageId: 'generic' }] },
    {
      code: 'orders.reduce((total, value) => total + value, 0)',
      errors: [{ messageId: 'generic' }]
    },
    { code: 'for (const item of orders) {}', errors: [{ messageId: 'generic' }] },
    { code: 'for (let index = 0; index < 2; index++) {}', errors: [{ messageId: 'generic' }] },
    {
      code: 'for (const [index, value] of orders.entries()) {}',
      errors: [{ messageId: 'generic' }, { messageId: 'generic' }]
    }
  ]
})

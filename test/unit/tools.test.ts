import { convertTools } from '@proxy/openai/tools'
import { assert, describe, expect, test } from 'vite-plus/test'

describe('convertTools', () => {
  /** The schema pi sends upstream, as JSON: TypeBox adds symbol keys that never leave the process. */
  function asJson(schema: unknown): unknown {
    return JSON.parse(JSON.stringify(schema))
  }

  // Catches a converter that ignores `parameters` (an empty object schema would pass a type check),
  // drops `required` or descriptions, or encodes an enum as something other than const branches.
  // Constraint keywords are locked per type in json-schema-to-typebox.test.ts.
  test('converts a function tool into exactly the schema sent upstream', () => {
    const result = convertTools([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the weather for a city',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string', description: 'The city name' },
              unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
              days: { type: 'integer' },
              tags: { type: 'array', items: { type: 'string' } }
            },
            required: ['city']
          }
        }
      }
    ])
    assert(result.ok, 'expected the tool to convert')
    const [tool] = result.tools

    expect(tool?.name).toBe('get_weather')
    expect(tool?.description).toBe('Get the weather for a city')
    expect(asJson(tool?.parameters)).toEqual({
      type: 'object',
      required: ['city'],
      properties: {
        city: { type: 'string', description: 'The city name' },
        unit: {
          anyOf: [
            { type: 'string', const: 'celsius' },
            { type: 'string', const: 'fahrenheit' }
          ]
        },
        days: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } }
      }
    })
  })

  // Catches a tool without `parameters` sent with no schema, which providers reject.
  test('gives a tool without parameters an empty object schema', () => {
    const result = convertTools([
      { type: 'function', function: { name: 'list_all', description: 'List everything' } }
    ])
    assert(result.ok, 'expected the tool to convert')

    expect(asJson(result.tools[0]?.parameters)).toEqual({ type: 'object', properties: {} })
  })

  test('converts multiple tools', () => {
    const result = convertTools([
      {
        type: 'function',
        function: {
          name: 'tool_a',
          description: 'Tool A',
          parameters: { type: 'object', properties: {} }
        }
      },
      {
        type: 'function',
        function: {
          name: 'tool_b',
          description: 'Tool B',
          parameters: { type: 'object', properties: { amount: { type: 'number' } } }
        }
      }
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools).toHaveLength(2)
  })

  test('rejects tools with unsupported JSON Schema', () => {
    const result = convertTools([
      {
        type: 'function',
        function: {
          name: 'bad_tool',
          description: 'Bad tool',
          parameters: {
            type: 'object',
            properties: {
              data: { $ref: '#/definitions/Data' }
            }
          }
        }
      }
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('$ref')
    expect(result.param).toContain('tools[0]')
  })

  test('handles tool with empty description', () => {
    const result = convertTools([
      {
        type: 'function',
        function: {
          name: 'no_desc',
          parameters: { type: 'object' }
        }
      }
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const tool = result.tools[0]
    expect(tool).toBeDefined()
    if (tool === undefined) return
    expect(tool.description).toBe('')
  })

  test('converts tools with nested object parameters', () => {
    const result = convertTools([
      {
        type: 'function',
        function: {
          name: 'create_user',
          description: 'Create a user',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              address: {
                type: 'object',
                properties: {
                  street: { type: 'string' },
                  city: { type: 'string' },
                  zip: { type: 'string' }
                },
                required: ['street', 'city']
              }
            },
            required: ['name']
          }
        }
      }
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools).toHaveLength(1)
  })

  test('converts tools with array parameters', () => {
    const result = convertTools([
      {
        type: 'function',
        function: {
          name: 'process_items',
          description: 'Process items',
          parameters: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of items to process'
              }
            },
            required: ['items']
          }
        }
      }
    ])
    expect(result.ok).toBe(true)
  })
})

/**
 * A tool's `strict` flag end to end, per API family: what each provider receives. The proxy maps
 * `strict: true` to pi's constrained sampling ("prefer", #44); pi decides per model whether strict
 * applies, makes the schema strict, and writes `strict` in that API's own shape.
 *
 * The mock answers in OpenAI chat-completions format only, so Responses and Anthropic calls fail
 * after sending; these tests read the request pi sent, which is complete either way.
 */

import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testApp } from '../helpers'

const MOCK_KEY = 'notarealsecret-mock-provider-key'

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  const answer = sse([...textChunks('ok'), finishChunk('stop')])
  mock = await startMockProvider({
    'gpt-strict': answer,
    'gpt-plain': answer,
    'responses-strict': answer,
    'claude-strict': answer
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        completions: {
          baseUrl: `${mock.origin}/v1`,
          api: 'openai-completions',
          apiKey: MOCK_KEY,
          models: [{ id: 'gpt-strict', compat: { supportsStrictMode: true } }, { id: 'gpt-plain' }]
        },
        responses: {
          baseUrl: `${mock.origin}/v1`,
          api: 'openai-responses',
          apiKey: MOCK_KEY,
          models: [{ id: 'responses-strict', compat: { supportsStrictMode: true } }]
        },
        anthropic: {
          baseUrl: mock.origin,
          api: 'anthropic-messages',
          apiKey: MOCK_KEY,
          models: [{ id: 'claude-strict', compat: { supportsStrictTools: true } }]
        }
      }
    }
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/** `city` required, `unit` optional: strict mode must make both required, `unit` nullable. */
const WEATHER_PARAMETERS = {
  type: 'object',
  properties: { city: { type: 'string' }, unit: { type: 'string' } },
  required: ['city']
}

/** The same parameters as pi makes them strict: every property required, optional ones nullable. */
const STRICT_WEATHER_PARAMETERS = {
  type: 'object',
  required: ['city', 'unit'],
  properties: {
    city: { type: 'string' },
    unit: { anyOf: [{ type: 'string' }, { type: 'null' }] }
  },
  additionalProperties: false
}

/** Send one tool to `model`, and return the first tool definition the provider received. */
async function upstreamTool(
  model: string,
  parameters: Record<string, unknown>,
  strict: boolean | null | undefined
): Promise<Record<string, unknown>> {
  const before = mock.requests.length
  await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Weather',
            parameters,
            ...(strict === undefined ? {} : { strict })
          }
        }
      ]
    })
  })
  expect(mock.requests).toHaveLength(before + 1)
  const body = mock.requests.at(-1)?.body
  const tools = isRecord(body) ? body['tools'] : undefined
  const [tool] = Array.isArray(tools) ? tools : []
  if (!isRecord(tool)) throw new Error(`expected a tool definition, got ${JSON.stringify(tools)}`)
  return tool
}

describe('strict: true reaches each API family in its own shape', () => {
  // Catches strict lost on the way to an OpenAI chat-completions model that supports it, or sent
  // with the client's schema as is, which OpenAI's strict mode refuses (optional properties).
  test('openai-completions: strict on the function, with the schema made strict', async () => {
    expect(await upstreamTool('completions/gpt-strict', WEATHER_PARAMETERS, true)).toEqual({
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Weather',
        parameters: STRICT_WEATHER_PARAMETERS,
        strict: true
      }
    })
  })

  // Catches the regression #44 fixed: strict reached only chat completions, because the proxy
  // patched `tools[i].function.strict`, and Responses tools have no `function` object.
  test('openai-responses: strict at the top level of the tool, with the schema made strict', async () => {
    expect(await upstreamTool('responses/responses-strict', WEATHER_PARAMETERS, true)).toEqual({
      type: 'function',
      name: 'get_weather',
      description: 'Weather',
      parameters: STRICT_WEATHER_PARAMETERS,
      strict: true
    })
  })

  // Catches strict dropped for Anthropic, which before #44 never received it.
  test('anthropic-messages: strict on the tool, with a strict input_schema', async () => {
    const tool = await upstreamTool('anthropic/claude-strict', WEATHER_PARAMETERS, true)

    expect(tool['strict']).toBe(true)
    expect(tool['input_schema']).toEqual(STRICT_WEATHER_PARAMETERS)
  })
})

describe('where strict cannot apply, the tool is sent without it', () => {
  // Catches strict forced onto a model pi does not mark strict-capable (the old patch did, for
  // every chat-completions endpoint), or the request refused instead of sent ("prefer", #44).
  test('a model that is not strict-capable gets the plain tool', async () => {
    expect(await upstreamTool('completions/gpt-plain', WEATHER_PARAMETERS, true)).toEqual({
      type: 'function',
      function: { name: 'get_weather', description: 'Weather', parameters: WEATHER_PARAMETERS }
    })
  })

  // Catches a schema outside the provider's strict subset (Anthropic strict refuses `minimum`)
  // refused, or sent as strict anyway, instead of sent plain with the client's schema intact.
  test('a schema the provider cannot make strict is sent plain, keyword kept', async () => {
    const parameters = {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1 } },
      required: ['days']
    }
    const tool = await upstreamTool('anthropic/claude-strict', parameters, true)

    expect(tool['strict']).toBeUndefined()
    expect(tool['input_schema']).toEqual(parameters)
  })
})

describe('without strict: true, no strict sampling', () => {
  // Catches `strict: false`, `null` or an absent flag treated as strict, which would rewrite the
  // client's schema (every property required) and constrain the model when it was not asked to.
  test.each([
    ['false', false],
    ['null', null],
    ['absent', undefined]
  ])('strict %s on a strict-capable model sends the schema unchanged', async (_label, strict) => {
    const tool = await upstreamTool('completions/gpt-strict', WEATHER_PARAMETERS, strict)

    expect(tool['function']).toEqual({
      name: 'get_weather',
      description: 'Weather',
      parameters: WEATHER_PARAMETERS,
      strict: false
    })
  })
})

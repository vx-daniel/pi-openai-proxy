/**
 * Tool parameter schemas end to end: what reaches the provider, what the client gets back when a
 * schema is refused, and what the operator sees in the log either way.
 */

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testApp } from '../helpers'

const HTTP_OK = 200
const HTTP_UNPROCESSABLE = 422

let mock: MockProvider
let agentDir: FixtureAgentDir
/** Every JSON log line written, with its LogTape level and message. */
const records: { level: string; message: string }[] = []

beforeAll(async () => {
  mock = await startMockProvider({ echo: sse([...textChunks('ok'), finishChunk('stop')]) })
  // Strict-capable, so `strict: true` applies and pi checks the schema against strict mode (#44).
  const provider = {
    ...mock.provider(),
    models: [{ id: 'echo', compat: { supportsStrictMode: true } }]
  }
  agentDir = await loadFixtureAgentDir({ modelsJson: { providers: { mock: provider } } })
  configureLogging({
    level: 'trace',
    format: 'json',
    write: (line) => {
      const parsed: unknown = JSON.parse(line)
      const field = (name: string): string =>
        isRecord(parsed) && typeof parsed[name] === 'string' ? parsed[name] : ''
      records.push({ level: field('level'), message: field('message') })
    }
  })
})

beforeEach(() => {
  records.length = 0
})

afterAll(async () => {
  resetSync()
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/** Ask `mock/echo` something with one strict tool whose parameters are `parameters`. */
async function chatWithTool(parameters: Record<string, unknown>): Promise<Response> {
  return testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mock/echo',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'Weather', parameters, strict: true }
        }
      ]
    })
  })
}

/** The `tools` of the last request the provider received. */
function lastUpstreamTools(): unknown {
  const body = mock.requests.at(-1)?.body
  return isRecord(body) ? body['tools'] : undefined
}

describe('tool parameter schemas', () => {
  // Catches the #37 regression: constraints, and `additionalProperties: false` which OpenAI's
  // strict mode requires on every object, dropped on the way upstream, or `strict` lost.
  test('constraints and additionalProperties reach the provider with strict', async () => {
    const response = await chatWithTool({
      type: 'object',
      properties: {
        city: { type: 'string', minLength: 1, pattern: '^[A-Z]' },
        days: { type: 'integer', minimum: 1, maximum: 7 },
        units: {
          type: 'object',
          properties: { metric: { type: 'boolean' } },
          required: ['metric'],
          additionalProperties: false
        }
      },
      required: ['city', 'days', 'units'],
      additionalProperties: false
    })

    expect(response.status).toBe(HTTP_OK)
    expect(lastUpstreamTools()).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Weather',
          parameters: {
            type: 'object',
            required: ['city', 'days', 'units'],
            properties: {
              city: { type: 'string', minLength: 1, pattern: '^[A-Z]' },
              days: { type: 'integer', minimum: 1, maximum: 7 },
              units: {
                type: 'object',
                required: ['metric'],
                properties: { metric: { type: 'boolean' } },
                additionalProperties: false
              }
            },
            additionalProperties: false
          },
          strict: true
        }
      }
    ])
  })

  // Catches a `$schema` declaration (zod-to-json-schema adds one to every schema) being sent
  // upstream, rejected, or dropped without a trace an operator can find.
  test('$schema is dropped, and the drop is logged at debug', async () => {
    const response = await chatWithTool({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {}
    })

    expect(response.status).toBe(HTTP_OK)
    // The tool is strict and the model strict-capable, so pi adds `required` and
    // `additionalProperties`; `$schema` must not be among the keys.
    expect(lastUpstreamTools()).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({
          parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
        })
      })
    ])
    expect(records).toContainEqual({
      level: 'DEBUG',
      message: 'Dropped meta keyword "$schema" at "tools[0].function.parameters"'
    })
  })

  // Catches an unknown keyword silently dropped (the model then sees a looser schema than the
  // client wrote) instead of refused, the request still sent upstream, or no warning logged.
  test('an unknown keyword is refused with 422 naming it, and logged as a warning', async () => {
    const upstreamBefore = mock.requests.length
    const response = await chatWithTool({
      type: 'object',
      properties: { city: { 'type': 'string', 'x-display': 'City' } }
    })

    expect(response.status).toBe(HTTP_UNPROCESSABLE)
    expect(await response.json()).toEqual({
      error: {
        message:
          "Unsupported JSON Schema keyword 'x-display' for type 'string' at tools[0].function.parameters.city",
        type: 'invalid_request_error',
        param: 'tools[0].function.parameters.city',
        code: 'unsupported_parameter'
      }
    })
    expect(mock.requests).toHaveLength(upstreamBefore)
    expect(records).toContainEqual({
      level: 'WARN',
      message:
        'Rejected parameters schema of tool "get_weather" at "tools[0].function.parameters.city": "Unsupported JSON Schema keyword \'x-display\' for type \'string\' at tools[0].function.parameters.city"'
    })
  })
})

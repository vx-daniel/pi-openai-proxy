/**
 * Integration tests for POST /v1/chat/completions validation: request parsing, validation and
 * error responses. Requests that need a model to resolve use a fixture provider (literal key,
 * unreachable base URL) and are rejected before any upstream call. Requests that must pass
 * validation use a mock provider model, so the test sees the answer a client gets.
 */

import type { ProxyEnv } from '@proxy/server/types'
import { isRecord } from '@proxy/utils/guards'
import type { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir, offlineProvider } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { isErrorBody, isErrorLike, jsonBody, present, testApp, testConfig } from '../helpers'

const FIXTURE_MODEL = 'validation-fixture/model'
/** A model the mock provider answers with "ok". */
const MOCK_MODEL = 'mock/echo'
const HTTP_OK = 200

let app: Hono<ProxyEnv>
let agentDir: FixtureAgentDir
let mock: MockProvider

beforeAll(async () => {
  mock = await startMockProvider({ echo: sse([...textChunks('ok'), finishChunk('stop')]) })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: { 'validation-fixture': offlineProvider('model'), 'mock': mock.provider() }
    }
  })
  app = testApp()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/** The completion a client gets for the mock's "ok" answer. */
function okCompletion(response: Response): Record<string, unknown> {
  return {
    id: response.headers.get('x-request-id'),
    object: 'chat.completion',
    created: expect.any(Number) as number,
    model: MOCK_MODEL,
    system_fingerprint: null,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }
    },
    x_pi: {
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cache_read_tokens: 0,
      cache_write_tokens: 0
    }
  }
}

describe('POST /v1/chat/completions - validation', () => {
  test('rejects invalid JSON', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json'
    })
    expect(response.status).toBe(400)
    const body = await jsonBody(response)
    expect(isErrorBody(body)).toBe(true)
    if (!isErrorBody(body)) return
    expect(body.error.type).toBe('invalid_request_error')
  })

  test('rejects missing model', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    expect(response.status).toBe(400)
  })

  test('rejects empty messages', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        messages: []
      })
    })
    expect(response.status).toBe(400)
  })

  // Catches a request with a valid tool refused by validation or conversion, or answered without
  // the tool reaching the provider.
  test('accepts a function tool and sends it to the provider', async () => {
    const weatherTool = {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get the weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city']
        }
      }
    }
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MOCK_MODEL,
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [weatherTool]
      })
    })

    expect({ status: response.status, body: await jsonBody(response) }).toEqual({
      status: HTTP_OK,
      body: okCompletion(response)
    })
    const upstreamBody = present(mock.requests.at(-1), 'an upstream request').body
    expect(isRecord(upstreamBody) ? upstreamBody['tools'] : undefined).toEqual([weatherTool])
  })

  test('rejects unsupported tool schemas with 422', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: FIXTURE_MODEL,
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'bad_tool',
              parameters: {
                type: 'object',
                properties: {
                  data: { $ref: '#/definitions/Data' }
                }
              }
            }
          }
        ]
      })
    })
    expect(response.status).toBe(422)
    const body = await jsonBody(response)
    expect(isErrorBody(body)).toBe(true)
    if (!isErrorBody(body)) return
    expect(body.error.code).toBe('unsupported_parameter')
  })

  test('rejects permanently rejected fields with 422', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        // oxlint-disable-next-line naming/no-single-char-keys -- "n" is OpenAI's request parameter under test
        n: 2
      })
    })
    expect(response.status).toBe(422)
    const body = await jsonBody(response)
    expect(isErrorLike(body)).toBe(true)
    if (!isErrorLike(body)) return
    const param = (body.error as Record<string, unknown>)['param']
    expect(param).toBe('n')
  })

  test('rejects unknown fields with 422', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        totally_made_up: true
      })
    })
    expect(response.status).toBe(422)
  })

  test('returns 404 for non-existent model', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fakeprovider/fake-model',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    expect(response.status).toBe(404)
    const body = await jsonBody(response)
    expect(isErrorBody(body)).toBe(true)
    if (!isErrorBody(body)) return
    expect(body.error.code).toBe('model_not_found')
  })

  test('returns request-id header', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    const requestId = response.headers.get('x-request-id')
    expect(requestId).toBeDefined()
    expect(requestId).toMatch(/^piproxy-/)
  })

  test('echoes x-client-request-id', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Request-Id': 'client-123'
      },
      body: JSON.stringify({
        model: 'fakeprovider/fake-model',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    expect(response.headers.get('x-client-request-id')).toBe('client-123')
  })
})

describe('POST /v1/chat/completions - proxy auth', () => {
  test('blocks requests when proxy auth is configured', async () => {
    const authedApp = testApp({
      ...testConfig(),
      proxyAuthToken: 'secret-token'
    })

    const response = await authedApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    expect(response.status).toBe(401)
  })

  test('accepts requests with correct proxy auth', async () => {
    const authedApp = testApp({
      ...testConfig(),
      proxyAuthToken: 'secret-token'
    })

    const response = await authedApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer secret-token'
      },
      body: JSON.stringify({
        model: 'fakeprovider/fake-model',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    expect(response.status).toBe(404)
  })
})

describe('POST /v1/chat/completions - body size limit', () => {
  test('rejects requests exceeding body size limit', async () => {
    const smallLimitApp = testApp({
      ...testConfig(),
      maxBodySize: 100
    })

    const response = await smallLimitApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '200'
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: 'a'.repeat(150) }]
      })
    })
    expect(response.status).toBe(413)
    const body = await jsonBody(response)
    expect(isErrorLike(body)).toBe(true)
    if (!isErrorLike(body)) return
    expect(body.error.message).toContain('too large')
  })

  // Catches the limit applied with `>=` instead of `>`, refusing a body exactly at the limit, or
  // the limit middleware consuming the body so the request no longer parses.
  test('allows a body exactly at the limit', async () => {
    const requestBody = JSON.stringify({
      model: MOCK_MODEL,
      messages: [{ role: 'user', content: 'Hello' }]
    })
    const bodyBytes = Buffer.byteLength(requestBody)
    const exactLimitApp = testApp({ ...testConfig(), maxBodySize: bodyBytes })

    const response = await exactLimitApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(bodyBytes) },
      body: requestBody
    })

    expect({ status: response.status, body: await jsonBody(response) }).toEqual({
      status: HTTP_OK,
      body: okCompletion(response)
    })
  })

  test('does not apply body size limit to GET requests', async () => {
    const smallLimitApp = testApp({
      ...testConfig(),
      maxBodySize: 10
    })

    const response = await smallLimitApp.request('/v1/models', {
      method: 'GET',
      headers: {
        'Content-Length': '999999'
      }
    })
    expect(response.status).toBe(200)
  })
})

describe('POST /v1/chat/completions - upstream API key override', () => {
  // Catches the header ignored (the provider's configured key sent instead), or the request
  // refused because of it.
  test('sends the X-Pi-Upstream-Api-Key value to the provider instead of its configured key', async () => {
    const upstreamKey = 'notarealsecret-per-request-upstream-key'
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pi-Upstream-Api-Key': upstreamKey },
      body: JSON.stringify({
        model: MOCK_MODEL,
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })

    expect({ status: response.status, body: await jsonBody(response) }).toEqual({
      status: HTTP_OK,
      body: okCompletion(response)
    })
    expect(present(mock.requests.at(-1), 'an upstream request').headers.authorization).toBe(
      `Bearer ${upstreamKey}`
    )
  })
})

describe('unsupported endpoints', () => {
  const endpoints = ['/v1/completions', '/v1/embeddings', '/v1/assistants']

  test.each(endpoints)('returns 404 for %s', async (endpoint) => {
    const response = await app.request(endpoint, { method: 'POST' })
    expect(response.status).toBe(404)
    const body = await jsonBody(response)
    expect(isErrorLike(body)).toBe(true)
    if (!isErrorLike(body)) return
    expect(body.error.message).toContain('not supported')
  })
})

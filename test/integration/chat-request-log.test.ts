/**
 * Request logging through the real app, at the most verbose level.
 *
 * The model is a fixture provider (literal key, unreachable base URL). Requests are rejected after
 * the model resolves and before any upstream call, so nothing leaves the machine.
 */

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import type { ProxyEnv } from '@proxy/server/types'
import type { Hono } from 'hono'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { testApp, testConfig } from '../helpers'

const FIXTURE_PROVIDER = 'log-fixture'
const FIXTURE_MODEL = `${FIXTURE_PROVIDER}/model`

let app: Hono<ProxyEnv>
let agentDir: FixtureAgentDir
let lines: string[] = []

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        [FIXTURE_PROVIDER]: {
          baseUrl: 'http://127.0.0.1:9/v1',
          api: 'openai-completions',
          apiKey: 'notarealsecret-log-key',
          models: [{ id: 'model' }]
        }
      }
    }
  })
  app = testApp()
})

afterAll(() => {
  vi.unstubAllEnvs()
  agentDir.remove()
})

// Trace, the most verbose level: no log line at any level may carry message content.
beforeEach(() => {
  lines = []
  configureLogging({ level: 'trace', format: 'json', write: (line) => lines.push(line) })
})

afterEach(() => {
  resetSync()
})

interface LogRecordJson {
  logger: string
  level: string
  message: string
  properties: Record<string, unknown>
}

function logged(logger: string): LogRecordJson[] {
  return lines
    .map((line) => JSON.parse(line) as LogRecordJson)
    .filter((record) => record.logger === logger)
}

const REJECTED_TOOL = {
  type: 'function',
  function: {
    name: 'bad_tool',
    parameters: { type: 'object', properties: { data: { $ref: '#/definitions/Data' } } }
  }
}

describe('chat request logging', () => {
  // Catches the chat line not being written, or written with the wrong ids, once a model resolves;
  // and any log line, at any level, carrying the prompt.
  test('logs the requested and resolved model once, with the request ids, and never the prompt', async () => {
    const canonicalId = FIXTURE_MODEL

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-request-id': 'client-abc' },
      body: JSON.stringify({
        model: canonicalId,
        stream: true,
        messages: [{ role: 'user', content: 'this text must never be logged' }],
        tools: [REJECTED_TOOL]
      })
    })

    expect(response.status).toBe(422)
    const chatLines = logged('pi-openai-proxy.server.chat').filter((record) =>
      record.message.startsWith('Chat request for')
    )
    expect(chatLines).toHaveLength(1)
    expect(chatLines[0]?.properties).toMatchObject({
      clientRequestId: 'client-abc',
      requestId: response.headers.get('x-request-id'),
      requestedModel: canonicalId,
      model: canonicalId,
      provider: FIXTURE_PROVIDER,
      stream: true
    })
    expect(lines.join('')).not.toContain('this text must never be logged')
  })

  // Catches the chat line being logged for a model that never resolved: it would name a model
  // that served nothing, and the 404 already says what was asked.
  test('does not log a chat request when the model is not found', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'no-such-provider/no-such-model',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })

    expect(response.status).toBe(404)
    expect(
      logged('pi-openai-proxy.server.chat').filter((record) =>
        record.message.startsWith('Chat request for')
      )
    ).toEqual([])
  })

  // Catches a request or its response going unlogged, or the two lines not sharing the request id.
  test('logs each request and its response with the same request id', async () => {
    const response = await app.request('/v1/models')
    const requestId = response.headers.get('x-request-id')

    const http = logged('pi-openai-proxy.server.http')
    expect(http.map((record) => record.properties['requestId'])).toEqual([requestId, requestId])
    expect(http[1]?.properties).toMatchObject({ method: 'GET', path: '/v1/models', status: 200 })
  })

  // Catches a container healthcheck flooding the default-level log, a failing check being hidden
  // with it, or real clients' model listings being hidden as well.
  test('logs a passing health check at debug and a failed one or a model list at info', async () => {
    lines = []
    configureLogging({ level: 'info', format: 'json', write: (line) => lines.push(line) })
    const authApp = testApp({ ...testConfig(), proxyAuthToken: 'notarealsecret-token' })

    await authApp.request('/healthz')
    expect(logged('pi-openai-proxy.server.http')).toEqual([])

    const rejected = await authApp.request('/healthz/models')
    expect(rejected.status).toBe(401)
    await app.request('/v1/models')
    const answered = logged('pi-openai-proxy.server.http').filter((record) =>
      record.message.includes('answered')
    )
    expect(
      answered.map((record) => [
        record.level,
        record.properties['path'],
        record.properties['status']
      ])
    ).toEqual([
      ['INFO', '/healthz/models', 401],
      ['INFO', '/v1/models', 200]
    ])
  })
})

describe('proxy auth logging', () => {
  const configuredToken = 'notarealsecret-configured-token'
  const wrongToken = 'notarealsecret-wrong-token'

  // Catches a credential reaching the logs: neither the configured token nor the one a client sent
  // may appear in any line, at any level, while the rejection itself is still logged.
  test('logs a rejected token as a warning without the token or the header value', async () => {
    const authApp = testApp({ ...testConfig(), proxyAuthToken: configuredToken })

    const rejected = await authApp.request('/v1/models', {
      headers: { Authorization: `Bearer ${wrongToken}` }
    })
    const accepted = await authApp.request('/v1/models', {
      headers: { Authorization: `Bearer ${configuredToken}` }
    })

    expect([rejected.status, accepted.status]).toEqual([401, 200])
    const authRecords = logged('pi-openai-proxy.server.auth')
    expect(authRecords.some((record) => record.level === 'WARN')).toBe(true)
    expect(lines.join('')).not.toContain(wrongToken)
    expect(lines.join('')).not.toContain(configuredToken)
  })
})

/**
 * A chat request whose provider credential fails to resolve: the 401 and the default-level logs
 * carry pi's summary of the failure, never the detail after it.
 *
 * pi's OAuth refresh errors run `<summary>. url=…; body=<token endpoint response>; stack=<install
 * paths>`. Refreshing a real token is not possible offline, so this uses a models.json key command
 * that resolves to nothing: pi's error then quotes the command, which is written in that shape.
 */

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { testApp } from '../helpers'

const LEAKED_DETAIL = 'notarealsecret-token-endpoint-response'
const LEAKED_PATH = 'notarealsecret-install-path'

let agentDir: FixtureAgentDir
/** Every JSON log line written, with its LogTape level (`TRACE`, `DEBUG`, `INFO`, `WARN`, …) and logger. */
const records: { level: string; logger: string; line: string }[] = []
const BELOW_DEFAULT_LEVEL = new Set(['TRACE', 'DEBUG'])

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        'auth-broken': {
          baseUrl: 'http://127.0.0.1:9/v1',
          api: 'openai-completions',
          // Runs, prints nothing, exits 0: pi treats the key as unresolved and quotes the command.
          apiKey: `!true; body=${LEAKED_DETAIL}; stack=at file:///${LEAKED_PATH}/index.js`,
          models: [{ id: 'broken-model' }]
        }
      }
    }
  })
  configureLogging({
    level: 'trace',
    format: 'json',
    write: (line) => {
      const parsed: unknown = JSON.parse(line)
      const field = (name: string): string =>
        isRecord(parsed) && typeof parsed[name] === 'string' ? parsed[name] : ''
      records.push({ level: field('level'), logger: field('logger'), line })
    }
  })
})

afterAll(() => {
  resetSync()
  vi.unstubAllEnvs()
  agentDir.remove()
})

describe('chat request with a credential that fails to resolve', () => {
  // Catches pi's raw credential error, which can quote the token endpoint's response and the
  // install's paths, reaching the client or a log line a default deployment writes.
  test('answers 401 with the summary only, and keeps the detail out of default-level logs', async () => {
    const response = await testApp().request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'auth-broken/broken-model',
        messages: [{ role: 'user', content: 'Hello' }]
      })
    })
    const text = await response.text()

    expect(response.status).toBe(401)
    expect(text).toContain("Could not resolve request auth for provider 'auth-broken'")
    expect(text).not.toContain(LEAKED_DETAIL)
    expect(text).not.toContain(LEAKED_PATH)

    const atInfoOrAbove = records.filter((record) => !BELOW_DEFAULT_LEVEL.has(record.level))
    // The failure is still reported where a default deployment sees it, as a warning.
    expect(
      atInfoOrAbove.some(
        (record) => record.level === 'WARN' && record.logger === 'pi-openai-proxy.pi.registry'
      )
    ).toBe(true)
    for (const record of atInfoOrAbove) {
      expect(record.line).not.toContain(LEAKED_DETAIL)
      expect(record.line).not.toContain(LEAKED_PATH)
    }

    // The detail is kept for whoever turns debug on, but pi's stack never is.
    const debugDetail = records.filter(
      (record) => record.level === 'DEBUG' && record.line.includes(LEAKED_DETAIL)
    )
    expect(debugDetail).not.toEqual([])
    for (const record of records) expect(record.line).not.toContain(LEAKED_PATH)
  })
})

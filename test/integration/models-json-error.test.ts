/**
 * A models.json that fails to load: `/healthz/models` and the startup log say so without quoting
 * the file. JSON.parse messages can include a slice of the text around the fault, and in a
 * models.json that is often a key.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { initRegistry } from '@proxy/pi/registry'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { testApp } from '../helpers'

const KEY = 'notarealsecret-models-json-key'

let agentDir = ''
let lines: string[] = []

/** Load `contents` as models.json with every log line captured, and return the health body. */
async function healthWith(contents: string): Promise<{ status: number; text: string }> {
  vi.stubEnv('ANTHROPIC_API_KEY', undefined)
  vi.stubEnv('OPENAI_API_KEY', undefined)
  agentDir = mkdtempSync(join(tmpdir(), 'pi-proxy-models-json-'))
  writeFileSync(join(agentDir, 'models.json'), contents)
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
  lines = []
  configureLogging({ level: 'trace', format: 'json', write: (line) => lines.push(line) })
  await initRegistry()
  const response = await testApp().request('/healthz/models')
  return { status: response.status, text: await response.text() }
}

afterEach(() => {
  resetSync()
  vi.unstubAllEnvs()
  rmSync(agentDir, { recursive: true, force: true })
})

describe('a models.json that fails to load', () => {
  // Catches the parse error's slice of the file (here, most of a key) reaching the health body or
  // any log line, at any level.
  test('reports where it is not valid JSON, never what the file says there', async () => {
    const { text } = await healthWith(
      `{"providers":{"x":{"baseUrl":"http://127.0.0.1:9/v1","apiKey": ${KEY}}}}`
    )

    // The exact wording (with or without a position) depends on Node's JSON.parse message, which
    // test/unit/models-json-error.test.ts pins form by form.
    expect(text).toMatch(/"modelsJsonError":"models\.json is not valid JSON( at [^"]+)?"/)
    expect(text).not.toContain('notarealsec')
    expect(lines.some((line) => line.includes('models.json is not valid JSON'))).toBe(true)
    for (const line of lines) expect(line).not.toContain('notarealsec')
  })

  // Catches the reduction throwing away the position, which is how an operator finds the fault.
  test('keeps the line and column when the parser gives them', async () => {
    const { text } = await healthWith(`{"providers":{"x":{"apiKey":"${KEY}", oops}}}`)

    expect(text).toMatch(/"modelsJsonError":"models\.json is not valid JSON at line 1 column \d+"/)
    expect(text).not.toContain(KEY)
  })

  // Catches the reduction hiding a schema error, which names the property at fault and never its
  // value, so it can pass through whole.
  test('passes a schema error through, which names properties but not values', async () => {
    const { text } = await healthWith(
      `{"providers":{"x":{"baseUrl":"http://127.0.0.1:9/v1","apiKey":12345,"models":[{"id":"m","cost":"${KEY}"}]}}}`
    )

    expect(text).toContain('providers.x.apiKey: must be string')
    expect(text).toContain('providers.x.models.0.cost: must be object')
    expect(text).not.toContain(KEY)
  })
})

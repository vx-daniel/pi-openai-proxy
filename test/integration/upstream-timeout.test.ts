/**
 * The upstream timeout through the real app and pi's real OpenAI-compatible provider, against a
 * local mock provider: it limits silence, not the length of the call.
 *
 * Real time, not fake timers: the timeout races real socket reads inside pi's provider and the
 * HTTP stack, which fake timers cannot drive. The intervals are kept to tenths of a second.
 */

import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  silent,
  sse,
  stall,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testApp, testConfig } from '../helpers'

/** Shorter than the whole steady answer, ten times the gap between its chunks. */
const IDLE_TIMEOUT_MS = 1000
const CHUNK_INTERVAL_MS = 100
/** 15 chunks 100 ms apart: about 1.5 s in total, past the 1 s timeout. */
const STEADY_CHUNKS = 15

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  mock = await startMockProvider({
    // A chunk every 100 ms, then the finish: the whole answer outlasts the timeout.
    steady: sse(
      [...textChunks(...Array.from({ length: STEADY_CHUNKS }, () => 'x')), finishChunk('stop')],
      { intervalMs: CHUNK_INTERVAL_MS }
    ),
    // One chunk, then nothing.
    stall: stall(textChunks('x')),
    // Not even headers.
    silent: silent()
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: { providers: { 'timeout-mock': mock.provider() } }
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

const app = () => testApp({ ...testConfig(), upstreamTimeoutMs: IDLE_TIMEOUT_MS })

async function chat(model: string, stream: boolean): Promise<Response> {
  return app().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `timeout-mock/${model}`,
      stream,
      messages: [{ role: 'user', content: 'Hello' }]
    })
  })
}

describe('upstream timeout', () => {
  // Catches the timeout capping the whole call again: an answer that keeps arriving must finish,
  // however long it takes in total.
  test('does not cut off an answer that keeps arriving, streamed or not', async () => {
    const complete = await chat('steady', false)
    const completeBody: unknown = await complete.json()
    expect(complete.status).toBe(200)
    expect(completeBody).toMatchObject({
      choices: [{ message: { content: 'x'.repeat(STEADY_CHUNKS) }, finish_reason: 'stop' }]
    })

    const streamed = await (await chat('steady', true)).text()
    expect(streamed).not.toContain('"error"')
    expect(streamed).toContain('"finish_reason":"stop"')
    expect(streamed.endsWith('data: [DONE]\n\n')).toBe(true)
  })

  // Catches a stalled provider hanging the request, or failing it as a generic upstream error that
  // does not say it timed out.
  test('ends a stalled call as a timeout: 504, or an error event once streaming', async () => {
    const complete = await chat('stall', false)
    expect(complete.status).toBe(504)
    expect(await complete.json()).toMatchObject({ error: { code: 'timeout' } })

    const streamed = await (await chat('stall', true)).text()
    expect(streamed).toContain(
      `data: ${JSON.stringify({ error: { message: 'Upstream request timed out', type: 'server_error', param: null, code: 'timeout' } })}\n\n`
    )
    expect(streamed.endsWith('data: [DONE]\n\n')).toBe(true)
  })

  // Catches the case the old whole-call timeout covered: a provider that never responds must still
  // be timed out, though no event ever restarts the wait.
  test('times out a provider that never answers', async () => {
    const complete = await chat('silent', false)
    expect(complete.status).toBe(504)
    expect(await complete.json()).toMatchObject({ error: { code: 'timeout' } })
  })
})

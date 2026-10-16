/**
 * The upstream timeout through the real app and pi's real OpenAI-compatible provider, against a
 * local mock provider: it limits silence, not the length of the call.
 *
 * Real time, not fake timers: the timeout races real socket reads inside pi's provider and the
 * HTTP stack, which fake timers cannot drive. The intervals are kept to tenths of a second.
 */

import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { initRegistry } from '@proxy/pi/registry'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { testApp, testConfig } from '../helpers'

/** Shorter than the whole steady answer, ten times the gap between its chunks. */
const IDLE_TIMEOUT_MS = 1000
const CHUNK_INTERVAL_MS = 100
/** 15 chunks 100 ms apart: about 1.5 s in total, past the 1 s timeout. */
const STEADY_CHUNKS = 15

let server: Server
let agentDir = ''

function chunk(content: string, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'mock',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock',
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }]
  })}\n\n`
}

/**
 * `steady` streams a chunk every 100 ms, then stops; `stall` sends one chunk and goes quiet;
 * `silent` never answers at all, not even with headers.
 */
async function answer(model: string, response: ServerResponse): Promise<void> {
  if (model === 'silent') return
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (model === 'stall') {
    response.write(chunk('x', null))
    return
  }
  for (let chunkIndex = 0; chunkIndex < STEADY_CHUNKS; chunkIndex++) {
    response.write(chunk('x', null))
    await sleep(CHUNK_INTERVAL_MS)
  }
  response.end(`${chunk('', 'stop')}data: [DONE]\n\n`)
}

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (part: Buffer) => {
      body += part.toString()
    })
    request.on('end', () => {
      const parsed: unknown = JSON.parse(body)
      const model = isRecord(parsed) && typeof parsed['model'] === 'string' ? parsed['model'] : ''
      void answer(model, response)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock provider not on TCP')
  const { port } = address

  agentDir = mkdtempSync(join(tmpdir(), 'pi-proxy-upstream-timeout-'))
  writeFileSync(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'timeout-mock': {
          baseUrl: `http://127.0.0.1:${String(port)}/v1`,
          api: 'openai-completions',
          apiKey: 'notarealsecret-timeout-key',
          models: [{ id: 'steady' }, { id: 'stall' }, { id: 'silent' }]
        }
      }
    })
  )
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
  await initRegistry()
})

afterAll(() => {
  vi.unstubAllEnvs()
  server.closeAllConnections()
  server.close()
  rmSync(agentDir, { recursive: true, force: true })
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
    expect(streamed).toContain('Upstream timeout: the provider sent nothing for 1 s')
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

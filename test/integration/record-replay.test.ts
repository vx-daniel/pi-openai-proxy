/**
 * Record and replay, offline: the recorder sits between pi and the mock provider (standing in for
 * a real one), the recording is saved to a temp dir, and replaying it through the mock gives the
 * client the same answer. The live counterpart, `pnpm run test:live:record`, puts the same
 * recorder in front of a real provider.
 */

import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isRecord } from '@proxy/utils/guards'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks,
  toolCallChunks
} from '../fixtures/mock-provider'
import {
  type CapturedExchange,
  loadRecording,
  type Recorder,
  type Recording,
  replay,
  saveRecording,
  startRecorder
} from '../fixtures/recording'
import { testApp } from '../helpers'

const PROVIDER_KEY = 'notarealsecret-recorded-provider-key'
const HTTP_BAD_GATEWAY = 502

let upstream: MockProvider
let recorder: Recorder
let recordingsDir = ''
const agentDirs: FixtureAgentDir[] = []

beforeAll(async () => {
  upstream = await startMockProvider({
    'two-tools': sse([
      ...toolCallChunks(0, {
        id: 'call_a',
        name: 'get_weather',
        argumentParts: ['{"city":', '"Oslo"}']
      }),
      ...toolCallChunks(1, { id: 'call_b', name: 'get_time', argumentParts: ['{"zone":"CET"}'] }),
      finishChunk('tool_calls', { prompt_tokens: 9, completion_tokens: 4 })
    ]),
    // A provider that echoes the caller's credential back: the recording must refuse to keep it.
    'echo-key': (response, request) => {
      const key = request.headers.authorization ?? ''
      void sse([...textChunks(`you sent ${key}`), finishChunk('stop')])(response, request)
    }
  })
  recorder = await startRecorder(upstream.origin)
  recordingsDir = mkdtempSync(join(tmpdir(), 'pi-proxy-recordings-'))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

afterAll(async () => {
  await recorder.close()
  await upstream.close()
  for (const agentDir of agentDirs) agentDir.remove()
  rmSync(recordingsDir, { recursive: true, force: true })
})

/** pi pointed at `baseUrl` as provider `rec`, serving `model`. */
async function useProvider(baseUrl: string, model: string): Promise<void> {
  agentDirs.push(
    await loadFixtureAgentDir({
      modelsJson: {
        providers: {
          rec: { baseUrl, api: 'openai-completions', apiKey: PROVIDER_KEY, models: [{ id: model }] }
        }
      }
    })
  )
}

async function chat(model: string): Promise<unknown> {
  const response = await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `rec/${model}`, messages: [{ role: 'user', content: 'Hi' }] })
  })
  expect(response.status).toBe(200)
  return response.json()
}

function named(exchange: CapturedExchange, scenario: string): Recording {
  return {
    version: 1,
    api: 'openai-completions',
    scenario,
    model: 'two-tools',
    recordedAt: '2026-10-16T00:00:00.000Z',
    piVersion: 'test',
    ...exchange
  }
}

/** The parts of a completion that come from the provider, not from this request's id or clock. */
function answer(completion: unknown): unknown {
  if (!isRecord(completion)) throw new Error('expected a chat completion object')
  return expect.objectContaining({ choices: completion['choices'], usage: completion['usage'] })
}

describe('record and replay', () => {
  // Catches a recording that does not reproduce what the client got: lost chunk boundaries, a
  // dropped event, or a changed status or content type.
  test('a saved recording, replayed, gives the client the same answer', async () => {
    await useProvider(`${recorder.baseUrl}/v1`, 'two-tools')
    const live = await chat('two-tools')
    const captured = recorder.exchanges.at(-1)
    if (captured === undefined) throw new Error('the recorder captured nothing')

    const path = saveRecording(
      named(captured.exchange, 'two-tools'),
      captured.secrets,
      recordingsDir
    )
    const saved = readFileSync(path, 'utf8')
    expect(saved).not.toContain(PROVIDER_KEY)
    expect(captured.exchange.request.headers).not.toHaveProperty('authorization')
    expect(captured.exchange.request.body).toMatchObject({ model: 'two-tools', stream: true })

    const replayer = await startMockProvider({
      'two-tools': replay(loadRecording('openai-completions', 'two-tools', recordingsDir))
    })
    try {
      await useProvider(`${replayer.origin}/v1`, 'two-tools')
      expect(await chat('two-tools')).toEqual(answer(live))
    } finally {
      await replayer.close()
    }
  })

  // Catches a credential reaching a committed fixture because a provider quoted it back.
  test('refuses to save a recording whose response contains the credential the request sent', async () => {
    await useProvider(`${recorder.baseUrl}/v1`, 'echo-key')
    await chat('echo-key')
    const captured = recorder.exchanges.at(-1)
    if (captured === undefined) throw new Error('the recorder captured nothing')

    expect(() =>
      saveRecording(named(captured.exchange, 'echo-key'), captured.secrets, recordingsDir)
    ).toThrow('contains a credential')
  })
})

describe('recorder whose upstream cannot be reached', () => {
  // Catches an unreachable upstream recorded as an exchange (a fixture of the recorder's own
  // failure) or answered as anything a provider client would retry or take for a real answer.
  test('answers 502 with the reason and keeps no exchange', async () => {
    const unreachable = await closedOrigin()
    const deadEnd = await startRecorder(unreachable)
    try {
      const response = await fetch(`${deadEnd.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'two-tools', messages: [{ role: 'user', content: 'Hi' }] })
      })

      expect({
        status: response.status,
        contentType: response.headers.get('content-type'),
        text: await response.text(),
        exchanges: deadEnd.exchanges
      }).toEqual({
        status: HTTP_BAD_GATEWAY,
        contentType: 'text/plain',
        // The proxy's part of the message; the cause after it is Node's wording.
        text: expect.stringMatching(
          new RegExp(`^recorder could not reach ${unreachable.replaceAll('.', '\\.')}: .+`)
        ),
        exchanges: []
      })
    } finally {
      await deadEnd.close()
    }
  })
})

/** An origin nothing listens on: a port the OS just handed out, then released. */
async function closedOrigin(): Promise<string> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  server.close()
  await once(server, 'close')
  return `http://127.0.0.1:${String(address.port)}`
}

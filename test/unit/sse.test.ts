import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import { encodeDone, encodeSSE, streamToSSE } from '@proxy/openai/sse'
import { afterEach, describe, expect, test } from 'vite-plus/test'

describe('encodeSSE', () => {
  test('encodes a chunk as SSE data frame', () => {
    const chunk = {
      id: 'req-1',
      object: 'chat.completion.chunk' as const,
      created: 1234567890,
      model: 'openai/gpt-4o',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant' as const },
          finish_reason: null
        }
      ]
    }

    const result = encodeSSE(chunk)
    expect(result).toMatch(/^data: /)
    expect(result).toMatch(/\n\n$/)

    const parsed = JSON.parse(result.slice(6))
    expect(parsed.id).toBe('req-1')
    expect(parsed.object).toBe('chat.completion.chunk')
    expect(parsed.choices[0].delta.role).toBe('assistant')
  })
})

describe('encodeDone', () => {
  test('returns [DONE] sentinel', () => {
    expect(encodeDone()).toBe('data: [DONE]\n\n')
  })
})

function makeErrorMessage(errorMessage: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-5.4-mini',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'error',
    errorMessage,
    timestamp: Date.now()
  }
}

async function* yieldEvents(
  events: AssistantMessageEvent[]
): AsyncGenerator<AssistantMessageEvent> {
  for (const event of events) yield event
}

describe('streamToSSE', () => {
  // Catches an upstream failure ending the stream as a normal stop, without `[DONE]`, or with the
  // upstream message in the frame instead of the fixed mapped text (#54).
  test('emits the mapped error frame and [DONE] for an upstream error event', async () => {
    const upstreamMessage = '401 {"error":{"message":"notarealsecret-quoted-in-error"}}'
    const events: AssistantMessageEvent[] = [
      { type: 'error', reason: 'error', error: makeErrorMessage(upstreamMessage) }
    ]

    const frames: string[] = []
    for await (const frame of streamToSSE(
      yieldEvents(events),
      'req-1',
      'openai/gpt-5.4-mini',
      false
    )) {
      frames.push(frame)
    }

    expect(frames).toEqual([
      `data: ${JSON.stringify({ error: { message: 'Upstream authentication failed', type: 'server_error', param: null, code: 'upstream_auth_error' } })}\n\n`,
      'data: [DONE]\n\n'
    ])
  })

  test('emits normal stop for successful done events', async () => {
    const doneMsg = makeErrorMessage('')
    doneMsg.stopReason = 'stop'
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial: doneMsg },
      { type: 'done', reason: 'stop', message: doneMsg }
    ]

    const frames: string[] = []
    for await (const frame of streamToSSE(yieldEvents(events), 'req-1', 'test/model', false)) {
      frames.push(frame)
    }

    // start chunk + finish chunk + [DONE]
    expect(frames).toHaveLength(3)
    const finishFrame = JSON.parse(frames[1]?.slice(6) ?? '')
    expect(finishFrame.choices[0].finish_reason).toBe('stop')
  })
})

describe('upstream error logging', () => {
  afterEach(() => {
    resetSync()
  })

  // Some providers quote the request back in their error text. Catches that text reaching a level a
  // default deployment writes, while keeping it available to someone debugging.
  async function logLinesFor(level: 'info' | 'debug'): Promise<string[]> {
    const lines: string[] = []
    configureLogging({ level, format: 'json', write: (line) => lines.push(line) })
    const echoed = makeErrorMessage('Invalid request: "echoed user prompt" is too long')
    const events: AssistantMessageEvent[] = [{ type: 'error', reason: 'error', error: echoed }]
    for await (const frame of streamToSSE(yieldEvents(events), 'req-1', 'p/m', false)) {
      expect(frame.length).toBeGreaterThan(0)
    }
    return lines
  }

  test('logs the error without the provider text at info', async () => {
    const lines = await logLinesFor('info')
    expect(lines.some((line) => line.includes('"ERROR"'))).toBe(true)
    expect(lines.join('')).not.toContain('echoed user prompt')
  })

  test('keeps the provider text for debugging at debug', async () => {
    const lines = await logLinesFor('debug')
    const detailLines = lines.filter((line) => line.includes('echoed user prompt'))
    expect(detailLines).toHaveLength(1)
    expect(detailLines[0]).toContain('"DEBUG"')
  })
})

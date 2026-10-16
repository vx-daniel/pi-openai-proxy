/**
 * The upstream idle timeout on pi's real event stream, with the clock driven by fake timers.
 */

import {
  type AssistantMessage,
  type AssistantMessageEvent,
  createAssistantMessageEventStream
} from '@earendil-works/pi-ai'
import { startUpstreamIdleTimeout, watchUpstreamActivity } from '@proxy/pi/upstream-idle'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

const IDLE_MS = 1000

function message(
  stopReason: AssistantMessage['stopReason'],
  errorMessage?: string
): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'mock',
    model: 'm1',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: 0
  }
}

const textDelta: AssistantMessageEvent = {
  type: 'text_delta',
  contentIndex: 0,
  delta: 'x',
  partial: message('stop')
}

function abortedEvent(): AssistantMessageEvent {
  return { type: 'error', reason: 'aborted', error: message('aborted', 'Request was aborted.') }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('upstream idle timeout', () => {
  // Catches the timer counting the whole call: events closer together than the timeout keep it
  // from firing however long the call runs.
  test('each upstream event restarts the wait', () => {
    const idle = startUpstreamIdleTimeout(IDLE_MS)
    const stream = createAssistantMessageEventStream()
    watchUpstreamActivity(stream, idle, undefined)

    for (let eventIndex = 0; eventIndex < 10; eventIndex++) {
      vi.advanceTimersByTime(IDLE_MS - 1)
      stream.push(textDelta)
    }
    expect(idle.signal.aborted).toBe(false)

    vi.advanceTimersByTime(IDLE_MS)
    expect(idle.signal.aborted).toBe(true)
  })

  // Catches a timed-out call being reported as the SDK's generic abort, which maps to 502.
  test('names the timeout in the error event it caused', () => {
    const idle = startUpstreamIdleTimeout(IDLE_MS)
    const stream = createAssistantMessageEventStream()
    watchUpstreamActivity(stream, idle, undefined)

    vi.advanceTimersByTime(IDLE_MS)
    const event = abortedEvent()
    stream.push(event)

    expect(event.type === 'error' ? event.error.errorMessage : undefined).toBe(
      'Upstream timeout: the provider sent nothing for 1 s'
    )
  })

  // Catches a client that left being logged as an upstream timeout when both fired.
  test('leaves the error alone when the client disconnected', () => {
    const idle = startUpstreamIdleTimeout(IDLE_MS)
    const client = new AbortController()
    const stream = createAssistantMessageEventStream()
    watchUpstreamActivity(stream, idle, client.signal)

    client.abort()
    vi.advanceTimersByTime(IDLE_MS)
    const event = abortedEvent()
    stream.push(event)

    expect(event.type === 'error' ? event.error.errorMessage : undefined).toBe(
      'Request was aborted.'
    )
  })

  // Catches a timer left running after the stream ended, aborting a finished call later.
  test('stops once the stream ends', async () => {
    const idle = startUpstreamIdleTimeout(IDLE_MS)
    const stream = createAssistantMessageEventStream()
    watchUpstreamActivity(stream, idle, undefined)

    stream.push({ type: 'done', reason: 'stop', message: message('stop') })
    await stream.result()
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2)

    expect(idle.signal.aborted).toBe(false)
  })
})

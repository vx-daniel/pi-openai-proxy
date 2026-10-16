/**
 * The upstream idle timeout on pi's real event stream, with the clock driven by fake timers.
 */

import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream
} from '@earendil-works/pi-ai'
import { relayUpstreamActivity, startUpstreamIdleTimeout } from '@proxy/pi/upstream-idle'
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

const MODEL = { api: 'openai-completions', provider: 'mock', id: 'm1' } as const

function relayed(clientSignal?: AbortSignal) {
  const idle = startUpstreamIdleTimeout(IDLE_MS)
  const upstream = createAssistantMessageEventStream()
  const downstream = relayUpstreamActivity(upstream, idle, clientSignal, MODEL)
  return { idle, upstream, downstream }
}

/** A pi stream whose iteration throws after one event, which pi's own streams never do. */
function throwingStream(): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  stream[Symbol.asyncIterator] = async function* () {
    yield textDelta
    await Promise.resolve()
    throw new Error('notarealsecret-upstream-detail')
  }
  return stream
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<string[]> {
  const types: string[] = []
  for await (const event of stream) types.push(event.type)
  return types
}

describe('upstream idle timeout', () => {
  // Catches the timer counting the whole call: events closer together than the timeout keep it
  // from firing however long the call runs.
  test('each upstream event restarts the wait', async () => {
    const { idle, upstream } = relayed()

    for (let eventIndex = 0; eventIndex < 10; eventIndex++) {
      await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
      upstream.push(textDelta)
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(idle.signal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(idle.signal.aborted).toBe(true)
  })

  // Catches the relay dropping or reordering events, above all the final one that settles the
  // result, which a consumer needs to finish the response.
  test('passes every event and the final message on', async () => {
    const { upstream, downstream } = relayed()
    const final = message('stop')

    upstream.push(textDelta)
    upstream.push(textDelta)
    upstream.push({ type: 'done', reason: 'stop', message: final })

    expect(await collect(downstream)).toEqual(['text_delta', 'text_delta', 'done'])
    expect(await downstream.result()).toBe(final)
  })

  // Catches a provider that ends its stream with a result but no done event leaving the relayed
  // stream unsettled, so the response never finishes.
  test('passes on a result the provider ended with, without a done event', async () => {
    const { upstream, downstream } = relayed()
    const final = message('stop')

    upstream.push(textDelta)
    upstream.end(final)

    expect(await collect(downstream)).toEqual(['text_delta'])
    expect(await downstream.result()).toBe(final)
  })

  // Catches a timed-out call being reported as the SDK's generic abort, which maps to 502.
  test('names the timeout in the error event it caused', async () => {
    const { upstream, downstream } = relayed()

    await vi.advanceTimersByTimeAsync(IDLE_MS)
    upstream.push(abortedEvent())

    expect((await downstream.result()).errorMessage).toBe(
      'Upstream timeout: the provider sent nothing for 1 s'
    )
  })

  // Catches a client that left being logged as an upstream timeout when both fired.
  test('leaves the error alone when the client disconnected', async () => {
    const client = new AbortController()
    const { upstream, downstream } = relayed(client.signal)

    client.abort()
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    upstream.push(abortedEvent())

    expect((await downstream.result()).errorMessage).toBe('Request was aborted.')
  })

  // Catches a timer left running after the stream ended, aborting a finished call later.
  test('stops once the stream ends', async () => {
    const { idle, upstream, downstream } = relayed()

    upstream.push({ type: 'done', reason: 'stop', message: message('stop') })
    await downstream.result()
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2)

    expect(idle.signal.aborted).toBe(false)
  })

  // Catches a throwing upstream leaving the response hanging forever (and an unhandled rejection),
  // or its raw error text reaching the client.
  test('ends with an error event if reading the upstream stream throws', async () => {
    const idle = startUpstreamIdleTimeout(IDLE_MS)
    const downstream = relayUpstreamActivity(throwingStream(), idle, undefined, MODEL)

    expect(await collect(downstream)).toEqual(['text_delta', 'error'])
    const final = await downstream.result()
    expect(final.stopReason).toBe('error')
    expect(final.errorMessage).toBe('Upstream stream failed')
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2)
    expect(idle.signal.aborted).toBe(false)
  })
})

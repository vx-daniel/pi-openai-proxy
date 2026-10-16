/**
 * The upstream timeout: how long the provider may go without sending anything.
 *
 * It restarts on every event pi receives (thinking, text, tool calls), so a long answer that keeps
 * arriving is never cut off, while a call that stalls (no response, or a stream that stops) is
 * aborted after `idleMs`. It replaced a timeout on the whole call, which cut off long thinking and
 * long streamed answers mid-text.
 */

import {
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream
} from '@earendil-works/pi-ai'

const MS_PER_SECOND = 1000

/** An abort signal that fires once `touch()` has not been called for `idleMs`. */
export interface UpstreamIdleTimeout {
  readonly signal: AbortSignal
  readonly idleMs: number
  /** Restart the wait: the provider sent something. */
  touch(): void
  /** Stop the timer: the call is over. */
  dispose(): void
}

export function startUpstreamIdleTimeout(idleMs: number): UpstreamIdleTimeout {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(`No data from the provider for ${String(idleMs)} ms`, 'TimeoutError')
    )
  }, idleMs)
  // A pending upstream call must not keep the process alive on shutdown.
  timer.unref()
  return {
    signal: controller.signal,
    idleMs,
    touch() {
      // refresh() restarts the same timer: no allocation per streamed event.
      if (!controller.signal.aborted) timer.refresh()
    },
    dispose() {
      clearTimeout(timer)
    }
  }
}

/** What a caller sees when the idle timeout ended the call; "timeout" maps it to HTTP 504. */
export function idleTimeoutMessage(idleMs: number): string {
  const duration =
    idleMs < MS_PER_SECOND
      ? `${String(idleMs)} ms`
      : `${String(Math.round(idleMs / MS_PER_SECOND))} s`
  return `Upstream timeout: the provider sent nothing for ${duration}`
}

/** Restart the wait for any event, or name the timeout in the error event it caused. */
function observe(
  event: AssistantMessageEvent,
  idle: UpstreamIdleTimeout,
  clientSignal: AbortSignal | undefined
): void {
  if (event.type !== 'error') {
    idle.touch()
  } else if (idle.signal.aborted && clientSignal?.aborted !== true) {
    // The idle timeout, not the client leaving, ended the call: say so instead of the provider
    // SDK's generic "aborted".
    event.error.errorMessage = idleTimeoutMessage(idle.idleMs)
  }
}

/**
 * Read pi's event stream as the provider fills it, restart `idle` on every event, and pass each
 * one on through a new stream, which is what the caller reads. The timer stops when the upstream
 * stream ends.
 *
 * Only pi's public stream API is used (async iteration, `createAssistantMessageEventStream`). The
 * relay reads as fast as the provider writes, whatever the client does with the relayed stream
 * (both queue without limit), so a client that reads slowly cannot make an active upstream look
 * idle.
 */
export function relayUpstreamActivity(
  upstream: AssistantMessageEventStream,
  idle: UpstreamIdleTimeout,
  clientSignal: AbortSignal | undefined
): AssistantMessageEventStream {
  const relayed = createAssistantMessageEventStream()
  const relay = async (): Promise<void> => {
    let terminated = false
    try {
      for await (const event of upstream) {
        observe(event, idle, clientSignal)
        terminated ||= event.type === 'done' || event.type === 'error'
        relayed.push(event)
      }
    } finally {
      idle.dispose()
    }
    // A done or error event already settled the relayed stream. Otherwise the provider ended the
    // stream without one: pass on whatever result it ended with.
    if (!terminated) relayed.end(await upstream.result())
  }
  void relay()
  return relayed
}

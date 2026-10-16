/**
 * The upstream timeout: how long the provider may go without sending anything.
 *
 * It restarts on every event pi receives (thinking, text, tool calls), so a long answer that keeps
 * arriving is never cut off, while a call that stalls (no response, or a stream that stops) is
 * aborted after `idleMs`. It replaced a timeout on the whole call, which cut off long thinking and
 * long streamed answers mid-text.
 */

import type { AssistantMessageEvent, AssistantMessageEventStream } from '@earendil-works/pi-ai'

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
  return `Upstream timeout: the provider sent nothing for ${String(Math.round(idleMs / MS_PER_SECOND))} s`
}

/**
 * Restart `idle` on every event the provider pushes into `stream`, and stop it when the stream
 * ends. The hook sits on `push`, the provider's side, not on the consumer's iteration: a client
 * that reads slowly must not make an active upstream look idle.
 *
 * When the idle timeout is what ended the call, the error event's message says so, instead of the
 * provider SDK's generic "aborted".
 */
export function watchUpstreamActivity(
  stream: AssistantMessageEventStream,
  idle: UpstreamIdleTimeout
): void {
  const push = stream.push.bind(stream)
  stream.push = (event: AssistantMessageEvent): void => {
    if (event.type === 'error' && idle.signal.aborted) {
      event.error.errorMessage = idleTimeoutMessage(idle.idleMs)
    } else {
      idle.touch()
    }
    push(event)
  }
  void stream.result().finally(() => {
    idle.dispose()
  })
}

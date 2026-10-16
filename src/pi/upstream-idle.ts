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

/**
 * Restart `idle` on every event the provider pushes into `stream`, and stop it when the stream
 * ends. The hook sits on `push`, the provider's side, not on the consumer's iteration: a client
 * that reads slowly must not make an active upstream look idle.
 *
 * This replaces `push` on pi's EventStream instance, which pi's providers call through the
 * instance. A pi release that stops doing so would leave the timer running out on every call
 * longer than `idleMs`; `test/integration/upstream-timeout.test.ts` runs a real pi provider past
 * the timeout and fails if that happens, so check it on every pi upgrade.
 *
 * When the idle timeout, and not the client leaving, is what ended the call, the error event's
 * message says so instead of the provider SDK's generic "aborted".
 */
export function watchUpstreamActivity(
  stream: AssistantMessageEventStream,
  idle: UpstreamIdleTimeout,
  clientSignal: AbortSignal | undefined
): void {
  const push = stream.push.bind(stream)
  stream.push = (event: AssistantMessageEvent): void => {
    if (event.type !== 'error') {
      idle.touch()
    } else if (idle.signal.aborted && clientSignal?.aborted !== true) {
      event.error.errorMessage = idleTimeoutMessage(idle.idleMs)
    }
    push(event)
  }
  void stream.result().finally(() => {
    idle.dispose()
  })
}

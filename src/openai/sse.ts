/**
 * SSE encoder: bridge pi AssistantMessageEvent stream -> OpenAI SSE chunks.
 *
 * Phase 0 contract:
 * - First chunk has delta.role = "assistant"
 * - Text deltas map to delta.content
 * - Tool call deltas map to delta.tool_calls
 * - Stable chunk ID across the full response
 * - Final [DONE] sentinel
 * - If stream_options.include_usage, emit final usage chunk with empty choices
 * - Do not emit non-standard reasoning fields on the stable path
 */

import type { AssistantMessageEvent, Usage } from '@earendil-works/pi-ai'
import { proxyLogger } from '@proxy/logging'
import { mapFinishReason, mapUsage } from '@proxy/openai/responses'

const sseLogger = proxyLogger('openai', 'sse')

export interface SSEChunk {
  readonly id: string
  readonly object: 'chat.completion.chunk'
  readonly created: number
  readonly model: string
  readonly choices: SSEChunkChoice[]
  readonly usage?: ReturnType<typeof mapUsage> | null
}

export interface SSEChunkChoice {
  readonly index: number
  readonly delta: SSEChunkDelta
  readonly finish_reason: string | null
}

export interface SSEChunkDelta {
  readonly role?: 'assistant'
  readonly content?: string
  readonly tool_calls?: SSEToolCallDelta[]
}

export interface SSEToolCallDelta {
  readonly index: number
  readonly id?: string
  readonly type?: 'function'
  readonly function?: {
    readonly name?: string
    readonly arguments?: string
  }
}

/**
 * Encode a single SSE data frame.
 */
export function encodeSSE(chunk: SSEChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

/**
 * Encode the terminal [DONE] frame.
 */
export function encodeDone(): string {
  return 'data: [DONE]\n\n'
}

const MS_PER_SECOND = 1000

interface ChunkMeta {
  readonly id: string
  readonly created: number
  readonly model: string
}

interface StreamState {
  sentFirstChunk: boolean
  finishReason: string | null
  finalUsage: Usage | undefined
  terminated: boolean
  // Track tool call indexes for stable delta sequencing
  readonly toolCallIndexes: Map<number, boolean>
}

function encodeChoiceChunk(
  meta: ChunkMeta,
  delta: SSEChunkDelta,
  finishReason: string | null = null
): string {
  return encodeSSE({
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason
      }
    ]
  })
}

function encodeTextDelta(meta: ChunkMeta, state: StreamState, text: string): string {
  if (state.sentFirstChunk) {
    return encodeChoiceChunk(meta, { content: text })
  }
  state.sentFirstChunk = true
  return encodeChoiceChunk(meta, { role: 'assistant', content: text })
}

function encodeToolCallStart(
  meta: ChunkMeta,
  state: StreamState,
  event: Extract<AssistantMessageEvent, { type: 'toolcall_start' }>
): string[] {
  const ci = event.contentIndex
  const toolCallContent = event.partial.content[ci]
  if (toolCallContent === undefined || toolCallContent.type !== 'toolCall') {
    sseLogger.debug('Dropped toolcall_start whose content {contentIndex} is not a tool call', {
      contentIndex: ci
    })
    return []
  }
  // Determine the tool call index within the message's tool calls
  const tcIndex = state.toolCallIndexes.size
  state.toolCallIndexes.set(ci, true)
  return [
    encodeChoiceChunk(meta, {
      tool_calls: [
        {
          index: tcIndex,
          id: toolCallContent.id,
          type: 'function',
          function: {
            name: toolCallContent.name,
            arguments: ''
          }
        }
      ]
    })
  ]
}

function encodeToolCallDelta(
  meta: ChunkMeta,
  state: StreamState,
  contentIndex: number,
  delta: string
): string[] {
  // Find the tool call index
  let tcIndex = 0
  for (const [ci] of state.toolCallIndexes) {
    if (ci === contentIndex) {
      return [
        encodeChoiceChunk(meta, {
          tool_calls: [
            {
              index: tcIndex,
              function: {
                arguments: delta
              }
            }
          ]
        })
      ]
    }
    tcIndex++
  }
  sseLogger.debug('Dropped toolcall_delta for content {contentIndex} with no started tool call', {
    contentIndex
  })
  return []
}

function encodeUpstreamError(errorMessage: string | undefined): string[] {
  // Surface upstream errors as SSE error frames instead of silent stop.
  // Write an error data frame so the client sees the failure.
  const errorChunk = JSON.stringify({
    error: {
      message: errorMessage ?? 'Upstream provider error',
      type: 'server_error',
      param: null,
      code: 'upstream_error'
    }
  })
  return [`data: ${errorChunk}\n\n`, encodeDone()]
}

/**
 * Map one pi event to the SSE frames it produces, updating stream state.
 */
function eventToFrames(
  event: AssistantMessageEvent,
  meta: ChunkMeta,
  state: StreamState
): string[] {
  switch (event.type) {
    case 'start':
      // Emit the first chunk with role
      state.sentFirstChunk = true
      return [encodeChoiceChunk(meta, { role: 'assistant' })]
    case 'text_delta':
      return [encodeTextDelta(meta, state, event.delta)]
    case 'toolcall_start':
      return encodeToolCallStart(meta, state, event)
    case 'toolcall_delta':
      return encodeToolCallDelta(meta, state, event.contentIndex, event.delta)
    case 'done':
      state.finishReason = mapFinishReason(event.reason)
      state.finalUsage = event.message.usage
      sseLogger.debug('Upstream stream done: {stopReason} -> {finishReason}', {
        stopReason: event.reason,
        finishReason: state.finishReason
      })
      return []
    case 'error':
      state.terminated = true
      logUpstreamStreamError(event)
      return encodeUpstreamError(event.error.errorMessage)
    // Not mapped to SSE output in the stable path.
    case 'text_start':
    case 'text_end':
    case 'thinking_start':
    case 'thinking_delta':
    case 'thinking_end':
    case 'toolcall_end':
      break
  }
  return []
}

/**
 * Log an upstream error event. The provider's raw message goes to debug only, as in the route's
 * handler: some providers quote parts of the request back, and request content is never logged at a
 * level a default deployment writes.
 */
function logUpstreamStreamError(event: Extract<AssistantMessageEvent, { type: 'error' }>): void {
  // `aborted` is the upstream call cancelled, usually because the client disconnected.
  if (event.reason === 'aborted') {
    sseLogger.warn('Upstream stream aborted', { stopReason: event.reason })
  } else {
    sseLogger.error('Upstream error inside stream ({stopReason})', { stopReason: event.reason })
  }
  const detail = event.error.errorMessage
  if (detail !== undefined) {
    sseLogger.debug('Upstream stream error detail: {detail}', { detail })
  }
}

/**
 * The frames after the last upstream event: the finish_reason chunk, the usage chunk when
 * requested, and the terminal sentinel.
 */
function closingFrames(
  meta: ChunkMeta,
  state: StreamState,
  includeUsage: boolean,
  eventCount: number
): string[] {
  const frames: string[] = []
  if (state.finishReason === null) {
    sseLogger.warn('Upstream stream ended without a done event; sending no finish_reason', {
      eventCount
    })
  } else {
    frames.push(encodeChoiceChunk(meta, {}, state.finishReason))
  }

  if (includeUsage && state.finalUsage !== undefined) {
    frames.push(
      encodeSSE({
        id: meta.id,
        object: 'chat.completion.chunk',
        created: meta.created,
        model: meta.model,
        choices: [],
        usage: mapUsage(state.finalUsage)
      })
    )
  }

  frames.push(encodeDone())
  return frames
}

/**
 * Create an async generator that yields SSE text frames from a pi event stream.
 */
export async function* streamToSSE(
  events: AsyncIterable<AssistantMessageEvent>,
  requestId: string,
  model: string,
  includeUsage: boolean
): AsyncGenerator<string> {
  const meta: ChunkMeta = { id: requestId, created: Math.floor(Date.now() / MS_PER_SECOND), model }
  const state: StreamState = {
    sentFirstChunk: false,
    finishReason: null,
    finalUsage: undefined,
    terminated: false,
    toolCallIndexes: new Map<number, boolean>()
  }

  sseLogger.debug('Starting stream for {model}', { model, includeUsage })
  const startedAt = performance.now()
  let eventCount = 0
  let frameCount = 0
  let completed = false
  let failed = false

  try {
    for await (const event of events) {
      eventCount++
      sseLogger.trace('Upstream event {eventType}', { eventType: event.type })
      const frames = eventToFrames(event, meta, state)
      frameCount += frames.length
      yield* frames
      if (state.terminated) {
        completed = true
        return
      }
    }

    const frames = closingFrames(meta, state, includeUsage, eventCount)
    frameCount += frames.length
    yield* frames
    completed = true
  } catch (error) {
    failed = true
    throw error
  } finally {
    logStreamEnd(state, {
      completed,
      failed,
      eventCount,
      frameCount,
      durationMs: Math.round(performance.now() - startedAt)
    })
  }
}

interface StreamEndSummary {
  readonly completed: boolean
  readonly failed: boolean
  readonly eventCount: number
  readonly frameCount: number
  readonly durationMs: number
}

/** One line for how a stream ended: finished, failed (the caller logs the error), or abandoned. */
function logStreamEnd(state: StreamState, summary: StreamEndSummary): void {
  const { completed, failed, ...counts } = summary
  if (failed) {
    sseLogger.debug('Stream failed after {eventCount} events and {frameCount} frames', counts)
    return
  }
  if (!completed) {
    sseLogger.debug('Client closed the stream after {frameCount} frames', counts)
    return
  }
  const usage = state.finalUsage
  sseLogger.debug('Stream finished: {finishReason}, {frameCount} frames in {durationMs} ms', {
    ...counts,
    finishReason: state.finishReason,
    upstreamError: state.terminated,
    toolCallCount: state.toolCallIndexes.size,
    promptTokens: usage === undefined ? null : usage.input + usage.cacheRead + usage.cacheWrite,
    completionTokens: usage?.output ?? null,
    totalTokens: usage?.totalTokens ?? null,
    cacheReadTokens: usage?.cacheRead ?? null,
    cacheWriteTokens: usage?.cacheWrite ?? null
  })
}

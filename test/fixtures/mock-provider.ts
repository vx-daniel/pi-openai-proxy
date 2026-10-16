/**
 * A local mock of an OpenAI-compatible provider (`POST /v1/chat/completions`, pi's
 * `openai-completions` API) for tests that need a real upstream: pi's real provider code calls it
 * over real HTTP on 127.0.0.1, and each model ID is answered by a scripted reply. It records every
 * request it receives, so a test can check what pi sent.
 *
 * Point a fixture `models.json` at it with `mock.provider(...)` (see `test/fixtures/agent-dir.ts`).
 */

import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

import { isRecord } from '@proxy/utils/guards'

export interface MockRequest {
  readonly path: string
  readonly headers: IncomingHttpHeaders
  readonly body: unknown
}

/** Answers one request. It may write slowly, stop partway, or never write at all. */
export type MockReply = (response: ServerResponse, request: MockRequest) => void | Promise<void>

export interface MockProvider {
  readonly baseUrl: string
  /** Every request received, in order. */
  readonly requests: readonly MockRequest[]
  /**
   * A `models.json` provider entry pointing at this server, with a literal fake key and one model
   * per scripted reply.
   */
  provider(): Record<string, unknown>
  close(): Promise<void>
}

const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const HTTP_NOT_FOUND = 404

/** The body as JSON, the raw text when it is not JSON, or undefined when empty. */
function parseBody(text: string): unknown {
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Start the mock on a free port. `replies` maps a model ID to how requests for it are answered. */
export async function startMockProvider(
  replies: Readonly<Record<string, MockReply>>
): Promise<MockProvider> {
  const requests: MockRequest[] = []
  const server: Server = createServer((incoming, response) => {
    let text = ''
    incoming.on('data', (part: Buffer) => {
      text += part.toString()
    })
    incoming.on('end', () => {
      const body = parseBody(text)
      const request: MockRequest = { path: incoming.url ?? '', headers: incoming.headers, body }
      requests.push(request)
      // Recorded either way, so a test can see what pi sent; but a provider would refuse it.
      if (typeof body === 'string') {
        void httpError(HTTP_BAD_REQUEST, {
          error: { message: 'mock got a body that is not JSON' }
        })(response, request)
        return
      }
      const model = isRecord(body) && typeof body['model'] === 'string' ? body['model'] : ''
      const reply = replies[model]
      if (reply === undefined) {
        void httpError(HTTP_NOT_FOUND, { error: { message: `mock has no model ${model}` } })(
          response,
          request
        )
        return
      }
      void reply(response, request)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock provider not on TCP')
  const baseUrl = `http://127.0.0.1:${String(address.port)}/v1`

  return {
    baseUrl,
    requests,
    provider: () => ({
      baseUrl,
      api: 'openai-completions',
      apiKey: 'notarealsecret-mock-provider-key',
      models: Object.keys(replies).map((modelId) => ({ id: modelId }))
    }),
    async close() {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    }
  }
}

/** One `chat.completion.chunk` with this delta and finish reason. */
export function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra
  }
}

/** Text deltas, one chunk per part. */
export function textChunks(...parts: string[]): Record<string, unknown>[] {
  return parts.map((content, partIndex) =>
    chunk(partIndex === 0 ? { role: 'assistant', content } : { content })
  )
}

/** One tool call's deltas: its id and name first, then its arguments split across chunks. */
export function toolCallChunks(
  toolIndex: number,
  call: { readonly id: string; readonly name: string; readonly argumentParts: readonly string[] }
): Record<string, unknown>[] {
  const [first = '', ...rest] = call.argumentParts
  return [
    chunk({
      tool_calls: [
        {
          index: toolIndex,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: first }
        }
      ]
    }),
    ...rest.map((argumentsPart) =>
      chunk({ tool_calls: [{ index: toolIndex, function: { arguments: argumentsPart } }] })
    )
  ]
}

/** The closing chunk: a finish reason, and usage when given (as `stream_options.include_usage`). */
export function finishChunk(
  finishReason: string,
  usage?: { readonly prompt_tokens: number; readonly completion_tokens: number }
): Record<string, unknown> {
  return chunk(
    {},
    finishReason,
    usage === undefined
      ? {}
      : { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } }
  )
}

/** A complete SSE answer: each chunk as a `data:` event, `intervalMs` apart, then `[DONE]`. */
export function sse(
  chunks: readonly Record<string, unknown>[],
  options: { readonly intervalMs?: number } = {}
): MockReply {
  return async (response) => {
    response.writeHead(HTTP_OK, { 'content-type': 'text/event-stream' })
    for (const [chunkIndex, event] of chunks.entries()) {
      if (chunkIndex > 0 && options.intervalMs !== undefined) await sleep(options.intervalMs)
      response.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    response.end('data: [DONE]\n\n')
  }
}

/** Starts answering, sends these chunks, then goes quiet without ending the response. */
export function stall(chunks: readonly Record<string, unknown>[]): MockReply {
  return (response) => {
    response.writeHead(HTTP_OK, { 'content-type': 'text/event-stream' })
    for (const event of chunks) response.write(`data: ${JSON.stringify(event)}\n\n`)
  }
}

/** Never answers: no status, no headers, no body. */
export function silent(): MockReply {
  return () => undefined
}

/** Answers with this HTTP status and JSON body. */
export function httpError(status: number, body: unknown): MockReply {
  return (response) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
}

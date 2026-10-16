/**
 * The exact SSE a streaming client receives, end to end: the mock provider streams OpenAI chunks,
 * pi's real `openai-completions` client parses them, and the proxy re-encodes pi's events. Each
 * test locks the whole chunk sequence, so a dropped, reordered, merged or reshaped chunk fails.
 *
 * One field is not in OpenAI's schema on purpose: `prompt_tokens_details.cache_write_tokens`,
 * which clients of this proxy read alongside `cached_tokens`.
 */

import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks,
  toolCallChunks
} from '../fixtures/mock-provider'
import { testApp } from '../helpers'

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  const weatherCall = toolCallChunks(0, {
    id: 'call_a',
    name: 'get_weather',
    argumentParts: ['{"city":', '"Oslo"}']
  })
  const timeCall = toolCallChunks(1, {
    id: 'call_b',
    name: 'get_time',
    argumentParts: ['{"zone":', '"CET"}']
  })
  mock = await startMockProvider({
    'two-tools': sse([
      ...weatherCall,
      ...timeCall,
      finishChunk('tool_calls', { prompt_tokens: 9, completion_tokens: 4 })
    ]),
    // Both calls opened, then the argument fragments: OpenAI's format allows this, since each
    // fragment names its call by index.
    'interleaved-tools': sse([
      ...weatherCall.slice(0, 1),
      ...timeCall.slice(0, 1),
      ...weatherCall.slice(1),
      ...timeCall.slice(1),
      finishChunk('tool_calls')
    ]),
    'text': sse([
      ...textChunks('Hel', 'lo'),
      finishChunk('stop', { prompt_tokens: 3, completion_tokens: 2 })
    ]),
    'truncated': sse([
      ...textChunks('Once upon'),
      finishChunk('length', { prompt_tokens: 3, completion_tokens: 2 })
    ])
  })
  agentDir = await loadFixtureAgentDir({ modelsJson: { providers: { mock: mock.provider() } } })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

/**
 * Stream `model`, with `include_usage` unless `includeUsage` is false (then `stream_options` is
 * omitted, as most clients do), and return the request ID and the chunks, without `[DONE]`.
 */
async function streamed(
  model: string,
  includeUsage = true
): Promise<{ requestId: string | null; chunks: unknown[] }> {
  const response = await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `mock/${model}`,
      stream: true,
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      messages: [{ role: 'user', content: 'Hi' }]
    })
  })
  expect(response.status).toBe(200)
  const body = await response.text()
  expect(body.endsWith('data: [DONE]\n\n')).toBe(true)
  const chunks = body
    .split('\n\n')
    .filter((event) => event.startsWith('data: {'))
    .map((event): unknown => JSON.parse(event.slice('data: '.length)))
  return { requestId: response.headers.get('x-request-id'), chunks }
}

/** A chunk of this response: the same id, a creation time, the requested public model ID. */
function chunk(requestId: string | null, model: string, fields: Record<string, unknown>): unknown {
  return {
    id: requestId,
    object: 'chat.completion.chunk',
    created: expect.any(Number) as number,
    model: `mock/${model}`,
    ...fields
  }
}

function delta(
  value: Record<string, unknown>,
  finishReason: string | null = null
): Record<string, unknown> {
  return { choices: [{ index: 0, delta: value, finish_reason: finishReason }] }
}

describe('streamed chat completions', () => {
  // Catches a tool call's index shifted or shared, its id or name lost, argument fragments merged,
  // dropped or reordered, or the finish and usage chunks reshaped.
  test('two tool calls stream as OpenAI deltas, each call opened then filled in', async () => {
    const { requestId, chunks } = await streamed('two-tools')
    const of = (fields: Record<string, unknown>): unknown => chunk(requestId, 'two-tools', fields)

    expect(requestId).toBeTypeOf('string')
    expect(chunks).toEqual([
      of(delta({ role: 'assistant' })),
      of(
        delta({
          tool_calls: [
            {
              index: 0,
              id: 'call_a',
              type: 'function',
              function: { name: 'get_weather', arguments: '' }
            }
          ]
        })
      ),
      of(delta({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] })),
      of(delta({ tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] })),
      of(
        delta({
          tool_calls: [
            {
              index: 1,
              id: 'call_b',
              type: 'function',
              function: { name: 'get_time', arguments: '' }
            }
          ]
        })
      ),
      of(delta({ tool_calls: [{ index: 1, function: { arguments: '{"zone":' } }] })),
      of(delta({ tool_calls: [{ index: 1, function: { arguments: '"CET"}' } }] })),
      of(delta({}, 'tool_calls')),
      of({
        choices: [],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 4,
          total_tokens: 13,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }
        }
      })
    ])
  })

  // Catches argument fragments attached to the most recently opened call instead of their own:
  // the sequential test above cannot, since each call there is complete before the next opens.
  test('interleaved fragments of two tool calls each keep their own index', async () => {
    const { requestId, chunks } = await streamed('interleaved-tools', false)
    const of = (fields: Record<string, unknown>): unknown =>
      chunk(requestId, 'interleaved-tools', fields)

    expect(chunks).toEqual([
      of(delta({ role: 'assistant' })),
      of(
        delta({
          tool_calls: [
            {
              index: 0,
              id: 'call_a',
              type: 'function',
              function: { name: 'get_weather', arguments: '' }
            }
          ]
        })
      ),
      of(delta({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] })),
      of(
        delta({
          tool_calls: [
            {
              index: 1,
              id: 'call_b',
              type: 'function',
              function: { name: 'get_time', arguments: '' }
            }
          ]
        })
      ),
      of(delta({ tool_calls: [{ index: 1, function: { arguments: '{"zone":' } }] })),
      of(delta({ tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] })),
      of(delta({ tool_calls: [{ index: 1, function: { arguments: '"CET"}' } }] })),
      of(delta({}, 'tool_calls'))
    ])
  })

  // Catches text deltas lost or merged, the role chunk missing, or the final chunk carrying
  // content or the wrong finish reason.
  test('text streams as a role chunk, content deltas, the finish, then usage', async () => {
    const { requestId, chunks } = await streamed('text')
    const of = (fields: Record<string, unknown>): unknown => chunk(requestId, 'text', fields)

    expect(chunks).toEqual([
      of(delta({ role: 'assistant' })),
      of(delta({ content: 'Hel' })),
      of(delta({ content: 'lo' })),
      of(delta({}, 'stop')),
      of({
        choices: [],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }
        }
      })
    ])
  })

  // Catches the route ignoring the client's choice: a usage chunk sent to a client that did not
  // ask for one breaks strict parsers that expect every chunk to have a choice.
  test('without include_usage the stream ends at the finish chunk', async () => {
    const { requestId, chunks } = await streamed('text', false)
    const of = (fields: Record<string, unknown>): unknown => chunk(requestId, 'text', fields)

    expect(chunks).toEqual([
      of(delta({ role: 'assistant' })),
      of(delta({ content: 'Hel' })),
      of(delta({ content: 'lo' })),
      of(delta({}, 'stop'))
    ])
  })

  // Catches a truncated answer reported as `stop`, which hides the truncation from clients that
  // continue or warn on `length`.
  test('an answer cut off at the token limit finishes with length', async () => {
    const { requestId, chunks } = await streamed('truncated', false)
    const of = (fields: Record<string, unknown>): unknown => chunk(requestId, 'truncated', fields)

    expect(chunks).toEqual([
      of(delta({ role: 'assistant' })),
      of(delta({ content: 'Once upon' })),
      of(delta({}, 'length'))
    ])
  })
})

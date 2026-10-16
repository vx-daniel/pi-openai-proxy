/**
 * Chat completions end to end against the local mock provider: pi's real `openai-completions`
 * client reads the mock's SSE over HTTP, and the proxy turns pi's result into OpenAI output.
 */

import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  httpError,
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
  mock = await startMockProvider({
    'two-tools': sse([
      ...toolCallChunks(0, {
        id: 'call_weather',
        name: 'get_weather',
        argumentParts: ['{"city":', '"Oslo"}']
      }),
      ...toolCallChunks(1, {
        id: 'call_time',
        name: 'get_time',
        argumentParts: ['{"zone":"CET"}']
      }),
      finishChunk('tool_calls', { prompt_tokens: 12, completion_tokens: 7 })
    ]),
    'rate-limited': httpError(429, {
      error: { message: 'Rate limit reached for requests', type: 'rate_limit_error' }
    }),
    'hello': sse([...textChunks('Hel', 'lo, ', 'Oslo'), finishChunk('stop')])
  })
  agentDir = await loadFixtureAgentDir({ modelsJson: { providers: { mock: mock.provider() } } })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

async function chat(model: string, stream = false): Promise<Response> {
  return testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `mock/${model}`,
      stream,
      messages: [{ role: 'user', content: 'Weather and time in Oslo?' }]
    })
  })
}

/** The JSON payloads of an SSE body's `data:` events, without the closing `[DONE]`. */
function sseEvents(body: string): unknown[] {
  return body
    .split('\n\n')
    .filter((event) => event.startsWith('data: ') && event !== 'data: [DONE]')
    .map((event): unknown => JSON.parse(event.slice('data: '.length)))
}

describe('chat completions through the mock provider', () => {
  // Catches tool calls lost, merged or misordered between pi and the OpenAI response, or arguments
  // split across deltas not reassembled.
  test('returns two streamed tool calls as one message, with usage', async () => {
    const response = await chat('two-tools')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      object: 'chat.completion',
      model: 'mock/two-tools',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_weather',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Oslo"}' }
              },
              {
                id: 'call_time',
                type: 'function',
                function: { name: 'get_time', arguments: '{"zone":"CET"}' }
              }
            ]
          }
        }
      ],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 }
    })
    // pi streams upstream even for a non-streaming client request.
    expect(mock.requests.at(-1)?.body).toMatchObject({ model: 'two-tools', stream: true })
  })

  // Catches an upstream rate limit reaching the client as a generic 502.
  test('answers an upstream 429 with a 429', async () => {
    const response = await chat('rate-limited')

    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ error: { code: 'rate_limit' } })
  })

  // Catches streamed text lost, reordered or not ended between pi and the client's SSE.
  test('streams text to the client in order, then the finish and [DONE]', async () => {
    const response = await chat('hello', true)
    const body = await response.text()

    expect(response.status).toBe(200)
    const choices = sseEvents(body).flatMap((event): unknown[] =>
      isRecord(event) && Array.isArray(event['choices']) ? event['choices'] : []
    )
    const text = choices
      .map((choice) =>
        isRecord(choice) &&
        isRecord(choice['delta']) &&
        typeof choice['delta']['content'] === 'string'
          ? choice['delta']['content']
          : ''
      )
      .join('')
    expect(text).toBe('Hello, Oslo')
    expect(choices.at(-1)).toMatchObject({ finish_reason: 'stop' })
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true)
  })
})

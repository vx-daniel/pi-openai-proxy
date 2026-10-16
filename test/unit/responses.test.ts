import type { AssistantMessage, StopReason } from '@earendil-works/pi-ai'
import { buildChatCompletion, mapFinishReason, mapUsage } from '@proxy/openai/responses'
import { describe, expect, test } from 'vite-plus/test'

describe('mapFinishReason', () => {
  const cases: [StopReason, string][] = [
    ['stop', 'stop'],
    ['length', 'length'],
    ['toolUse', 'tool_calls'],
    ['error', 'stop'],
    ['aborted', 'stop']
  ]

  for (const [piReason, expected] of cases) {
    test(`maps '${piReason}' -> '${expected}'`, () => {
      expect(mapFinishReason(piReason)).toBe(expected)
    })
  }
})

describe('mapUsage', () => {
  // Catches prompt_tokens reporting only Pi's uncached `input`: with prompt caching, a client
  // that sizes its context from prompt_tokens would see a tiny fraction of the real prompt.
  test('reports the whole prompt in prompt_tokens and breaks the cached part out', () => {
    const result = mapUsage({
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 165,
      cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 }
    })

    expect(result.prompt_tokens).toBe(115)
    expect(result.prompt_tokens_details).toEqual({ cached_tokens: 10, cache_write_tokens: 5 })
    expect(result.completion_tokens).toBe(50)
    expect(result.total_tokens).toBe(165)
  })
})

describe('buildChatCompletion', () => {
  function assistantMessage(
    content: AssistantMessage['content'],
    stopReason: StopReason
  ): AssistantMessage {
    return {
      role: 'assistant',
      content,
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      usage: {
        input: 10,
        output: 5,
        cacheRead: 200,
        cacheWrite: 30,
        totalTokens: 245,
        cost: { input: 0.001, output: 0.002, cacheRead: 0.0004, cacheWrite: 0.0003, total: 0.0037 }
      },
      stopReason,
      timestamp: 0
    }
  }

  // Catches any drift in the public response: a field dropped or renamed, an extra field at the
  // top level, or pi metadata leaving `x_pi` (AGENTS.md: pi-specific metadata goes under `x_pi`).
  test('a text answer has exactly the OpenAI chat.completion shape, with pi metadata under x_pi', () => {
    const result = buildChatCompletion(
      'req-123',
      'anthropic/claude-haiku-5-5',
      assistantMessage([{ type: 'text', text: 'Hello there!' }], 'stop')
    )

    expect(result).toEqual({
      id: 'req-123',
      object: 'chat.completion',
      created: expect.any(Number) as number,
      model: 'anthropic/claude-haiku-5-5',
      system_fingerprint: null,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello there!' },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: 240,
        completion_tokens: 5,
        total_tokens: 245,
        prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 30 }
      },
      x_pi: {
        cost: { input: 0.001, output: 0.002, cacheRead: 0.0004, cacheWrite: 0.0003, total: 0.0037 },
        cache_read_tokens: 200,
        cache_write_tokens: 30
      }
    })
  })

  // Catches tool calls mis-shaped: arguments sent as an object instead of a JSON string, a call
  // lost or reordered, text where OpenAI clients expect null, or the wrong finish reason.
  test('tool calls have exactly the OpenAI shape, in order, with arguments as JSON text', () => {
    const result = buildChatCompletion(
      'req-456',
      'anthropic/claude-haiku-5-5',
      assistantMessage(
        [
          { type: 'toolCall', id: 'tc_1', name: 'get_weather', arguments: { city: 'Oslo' } },
          { type: 'toolCall', id: 'tc_2', name: 'get_time', arguments: { zone: 'CET' } }
        ],
        'toolUse'
      )
    )

    expect(result.choices).toEqual([
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Oslo"}' }
            },
            {
              id: 'tc_2',
              type: 'function',
              function: { name: 'get_time', arguments: '{"zone":"CET"}' }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ])
  })

  // Catches the text a model writes before calling a tool being dropped (content forced to null
  // whenever tool calls exist), or text blocks split around the call not joined in order.
  test('text around a tool call stays in content, next to the call', () => {
    const result = buildChatCompletion(
      'req-789',
      'anthropic/claude-haiku-5-5',
      assistantMessage(
        [
          { type: 'text', text: 'Checking the weather. ' },
          { type: 'toolCall', id: 'tc_1', name: 'get_weather', arguments: { city: 'Oslo' } },
          { type: 'text', text: 'One moment.' }
        ],
        'toolUse'
      )
    )

    expect(result.choices).toEqual([
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Checking the weather. One moment.',
          tool_calls: [
            {
              id: 'tc_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Oslo"}' }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ])
  })
})

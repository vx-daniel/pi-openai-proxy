/**
 * SDK conformance: tool call completions.
 *
 * Uses the official openai Node SDK against the proxy.
 * Runs once with a mid-tier model (tool calls need capable models).
 * Skips when no credentials are available.
 */

import type OpenAI from 'openai'
import { assert, describe, expect, test } from 'vite-plus/test'

import { createTestClient, getTestModels, setup } from './helpers'

const weatherTool: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' }
      },
      required: ['city']
    }
  }
}

function getToolModel(): string | undefined {
  // Prefer mid-tier for tool calls, fall back to fast
  const mid = getTestModels('mid')
  if (mid.length > 0) return mid[0]?.id
  const fast = getTestModels('fast')
  return fast[0]?.id
}

describe('SDK tool call conformance', () => {
  test('non-streaming tool call parses without SDK errors', async () => {
    const modelId = getToolModel()
    if (modelId === undefined) return

    const { app } = setup()
    const client = createTestClient(app)

    const completion = await client.chat.completions.create({
      model: modelId,
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      tools: [weatherTool],
      max_completion_tokens: 128
    })

    expect(completion.object).toBe('chat.completion')

    const choice = completion.choices[0]
    expect(choice).toBeDefined()

    // Model may or may not use the tool -- validate shape if it did
    const usedTool = choice?.finish_reason === 'tool_calls'
    const toolCalls = usedTool ? (choice.message.tool_calls ?? []) : []
    expect(toolCalls.length > 0).toBe(usedTool)

    for (const tc of toolCalls.slice(0, 1)) {
      expect(tc.id).toBeTypeOf('string')
      expect(tc.type).toBe('function')
      assert(tc.type === 'function')
      expect(tc.function.name).toBeTypeOf('string')
      expect(tc.function.arguments).toBeTypeOf('string')
      expect(() => {
        JSON.parse(tc.function.arguments)
      }).not.toThrow()
    }
  })

  test('streaming tool call parses all chunks without SDK errors', async () => {
    const modelId = getToolModel()
    if (modelId === undefined) return

    const { app } = setup()
    const client = createTestClient(app)

    const stream = await client.chat.completions.create({
      model: modelId,
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      tools: [weatherTool],
      max_completion_tokens: 128,
      stream: true
    })

    let chunkCount = 0
    let lastFinishReason: string | null = null

    for await (const chunk of stream) {
      chunkCount++
      expect(chunk.object).toBe('chat.completion.chunk')

      if (chunk.choices.length > 0) {
        const choice = chunk.choices[0]
        if (choice !== undefined) {
          lastFinishReason = choice.finish_reason
        }
      }
    }

    expect(chunkCount).toBeGreaterThan(0)
    expect(lastFinishReason).not.toBeNull()
  })
})

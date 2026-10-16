import { convertMessages } from '@proxy/openai/messages'
import type { OpenAIMessage } from '@proxy/openai/schemas'
import { assert, describe, expect, test } from 'vite-plus/test'

describe('convertMessages', () => {
  test('converts system messages into systemPrompt', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' }
    ]
    const result = convertMessages(messages)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.systemPrompt).toBe('You are helpful.')
    expect(result.context.messages).toHaveLength(1)
    expect(result.context.messages[0]?.role).toBe('user')
  })

  test('merges system and developer messages', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'developer', content: 'Developer context' },
      { role: 'user', content: 'Hello' }
    ]
    const result = convertMessages(messages)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.systemPrompt).toBe('System prompt\n\nDeveloper context')
  })

  test('converts user text messages', () => {
    const messages: OpenAIMessage[] = [{ role: 'user', content: 'Hello world' }]
    const result = convertMessages(messages)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.messages).toHaveLength(1)
    const message = result.context.messages[0]
    expect(message?.role).toBe('user')
    assert(message?.role === 'user')
    expect(message.content).toBe('Hello world')
  })

  test('converts assistant messages into history', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'How are you?' }
    ]
    const result = convertMessages(messages)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.messages).toHaveLength(3)
    const assistant = result.context.messages[1]
    expect(assistant?.role).toBe('assistant')
  })
})

/** An assistant turn that called these tools, as an OpenAI client sends it back in history. */
function assistantCalling(
  ...calls: { readonly id: string; readonly name: string; readonly arguments: string }[]
): OpenAIMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: 'function' as const,
      function: { name: call.name, arguments: call.arguments }
    }))
  }
}

function convertedMessages(messages: OpenAIMessage[]): unknown[] {
  const result = convertMessages(messages)
  assert(result.ok, 'expected the messages to convert')
  return result.context.messages
}

describe('convertMessages: tool calls and results', () => {
  // Catches the 7ab6e143 regression: a tool result sent without its tool's name, which Gemini
  // rejects (`function_response.name: REQUIRED_FIELD_MISSING`). OpenAI's tool message carries only
  // the call ID, so the name has to come from the assistant turn that made the call.
  test('a tool result carries the name, ID and content of the call it answers', () => {
    const [, , toolResult] = convertedMessages([
      { role: 'user', content: "What's the weather?" },
      assistantCalling({ id: 'tc_1', name: 'get_weather', arguments: '{"city":"SF"}' }),
      { role: 'tool', content: '{"temp":72}', tool_call_id: 'tc_1' }
    ])

    expect(toolResult).toEqual({
      role: 'toolResult',
      toolCallId: 'tc_1',
      toolName: 'get_weather',
      content: [{ type: 'text', text: '{"temp":72}' }],
      isError: false,
      timestamp: expect.any(Number) as number
    })
  })

  // Catches names matched by position instead of call ID: results answered out of order.
  test('each result gets its own call’s name when results come back in another order', () => {
    const messages = convertedMessages([
      { role: 'user', content: 'Weather and time?' },
      assistantCalling(
        { id: 'tc_weather', name: 'get_weather', arguments: '{}' },
        { id: 'tc_time', name: 'get_time', arguments: '{}' }
      ),
      { role: 'tool', content: '12:00', tool_call_id: 'tc_time' },
      { role: 'tool', content: 'sunny', tool_call_id: 'tc_weather' }
    ])

    expect(messages.slice(2)).toEqual([
      expect.objectContaining({ toolCallId: 'tc_time', toolName: 'get_time' }),
      expect.objectContaining({ toolCallId: 'tc_weather', toolName: 'get_weather' })
    ])
  })

  // Catches a result for an unknown call being dropped (losing what the client sent) instead of
  // forwarded with the only name the proxy can give it.
  test('a result for a call no assistant turn made is kept, with an empty name', () => {
    const [, toolResult] = convertedMessages([
      { role: 'user', content: 'Hi' },
      { role: 'tool', content: 'orphan', tool_call_id: 'tc_unknown' }
    ])

    expect(toolResult).toMatchObject({
      role: 'toolResult',
      toolCallId: 'tc_unknown',
      toolName: '',
      content: [{ type: 'text', text: 'orphan' }]
    })
  })

  // Catches history tool calls lost, renamed, or sent with their arguments as a string.
  test('assistant tool calls become toolCall parts with parsed arguments', () => {
    const [, assistant] = convertedMessages([
      { role: 'user', content: "What's the weather?" },
      assistantCalling({ id: 'tc_1', name: 'get_weather', arguments: '{"city":"SF","days":2}' })
    ])

    expect(assistant).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'tc_1', name: 'get_weather', arguments: { city: 'SF', days: 2 } }
      ]
    })
  })

  // Catches a malformed history call failing the whole request: providers need an object, and
  // an earlier turn's arguments are not worth refusing the next turn over.
  test.each([
    ['not JSON', '{"city":'],
    ['JSON but not an object', '["SF"]']
  ])('arguments that are %s are sent as an empty object', (_case, rawArguments) => {
    const [, assistant] = convertedMessages([
      { role: 'user', content: 'Hi' },
      assistantCalling({ id: 'tc_1', name: 'get_weather', arguments: rawArguments })
    ])

    expect(assistant).toMatchObject({
      content: [{ type: 'toolCall', id: 'tc_1', name: 'get_weather', arguments: {} }]
    })
  })
})

describe('convertMessages: images', () => {
  test('rejects remote image URLs', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'https://example.com/image.png' } }
        ]
      }
    ]
    const result = convertMessages(messages)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('Remote image URLs are not supported')
  })

  test('accepts base64 data URI images', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' }
          }
        ]
      }
    ]
    const result = convertMessages(messages)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.context.messages).toHaveLength(1)
    const message = result.context.messages[0]
    assert(message?.role === 'user' && Array.isArray(message.content))
    expect(message.content).toHaveLength(2)
    const imagePart = message.content[1]
    assert(imagePart?.type === 'image')
    expect(imagePart.mimeType).toBe('image/png')
    expect(imagePart.data).toBe('iVBORw0KGgo=')
  })

  test('rejects unsupported image MIME types', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/bmp;base64,iVBORw0KGgo=' }
          }
        ]
      }
    ]
    const result = convertMessages(messages)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('Unsupported image MIME type')
    expect(result.message).toContain('image/bmp')
  })

  test('rejects invalid base64 data URI format', () => {
    const messages: OpenAIMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:notbase64content' }
          }
        ]
      }
    ]
    const result = convertMessages(messages)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('Invalid base64 data URI format')
  })

  test('accepts all supported image MIME types', () => {
    const mimeTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
    for (const mime of mimeTypes) {
      const messages: OpenAIMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mime};base64,iVBORw0KGgo=` }
            }
          ]
        }
      ]
      const result = convertMessages(messages)
      expect(result.ok).toBe(true)
    }
  })
})

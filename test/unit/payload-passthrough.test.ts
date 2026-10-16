/**
 * Unit tests for onPayload passthrough logic in pi/complete.ts.
 *
 * Tests OpenAI-compatible flat field injection via collectPayloadFields.
 * Provider translation and tool strict flags live in sibling test files.
 */

import { collectPayloadFields } from '@proxy/pi/complete'
import { describe, expect, test } from 'vite-plus/test'

import { minimalRequest } from './payload-passthrough-helpers'

// --- collectPayloadFields: tool_choice ---

describe('collectPayloadFields: tool_choice', () => {
  test('includes tool_choice string value in payload fields', () => {
    const fields = collectPayloadFields(
      minimalRequest({ tool_choice: 'required' }),
      'openai-completions'
    )
    expect(fields).toBeDefined()
    expect(fields?.['tool_choice']).toBe('required')
  })

  test("includes tool_choice 'auto' in payload fields", () => {
    const fields = collectPayloadFields(
      minimalRequest({ tool_choice: 'auto' }),
      'openai-completions'
    )
    expect(fields).toBeDefined()
    expect(fields?.['tool_choice']).toBe('auto')
  })

  test("includes tool_choice 'none' in payload fields", () => {
    const fields = collectPayloadFields(
      minimalRequest({ tool_choice: 'none' }),
      'openai-completions'
    )
    expect(fields).toBeDefined()
    expect(fields?.['tool_choice']).toBe('none')
  })

  test('includes named tool_choice in payload fields', () => {
    const namedChoice = {
      type: 'function' as const,
      function: { name: 'get_weather' }
    }
    const fields = collectPayloadFields(
      minimalRequest({ tool_choice: namedChoice }),
      'openai-completions'
    )
    expect(fields).toBeDefined()
    expect(fields?.['tool_choice']).toEqual(namedChoice)
  })

  test('omits tool_choice when not provided', () => {
    const fields = collectPayloadFields(minimalRequest(), 'openai-completions')
    expect(fields).toBeUndefined()
  })

  test('skips passthrough for unsupported APIs', () => {
    const unsupportedApis = ['bedrock-converse-stream', 'some-unknown-api']
    for (const api of unsupportedApis) {
      const fields = collectPayloadFields(
        minimalRequest({ tool_choice: 'required', top_p: 0.9, seed: 42 }),
        api
      )
      expect(fields).toBeUndefined()
    }
  })

  test('dispatches to Anthropic translator for anthropic-messages', () => {
    const fields = collectPayloadFields(
      minimalRequest({ tool_choice: 'required' }),
      'anthropic-messages'
    )
    expect(fields).toBeDefined()
    // Anthropic format: "required" -> { type: "any" }
    expect(fields?.['tool_choice']).toEqual({ type: 'any' })
  })

  test('returns undefined for Google APIs (uses nested patching)', () => {
    const googleApis = ['google-generative-ai', 'google-gemini-cli', 'google-vertex']
    for (const api of googleApis) {
      const fields = collectPayloadFields(minimalRequest({ tool_choice: 'auto', top_p: 0.9 }), api)
      expect(fields).toBeUndefined()
    }
  })

  test('allows full passthrough for OpenAI-compatible APIs', () => {
    const compatibleApis = [
      'openai-completions',
      'openai-responses',
      'azure-openai-responses',
      'mistral-conversations'
    ]
    for (const api of compatibleApis) {
      const fields = collectPayloadFields(
        minimalRequest({ tool_choice: 'auto', top_p: 0.9, seed: 42 }),
        api
      )
      expect(fields).toBeDefined()
      expect(fields?.['tool_choice']).toBe('auto')
      expect(fields?.['top_p']).toBe(0.9)
      expect(fields?.['seed']).toBe(42)
    }
  })

  test('codex-responses only passes tool_choice and parallel_tool_calls', () => {
    const fields = collectPayloadFields(
      minimalRequest({
        tool_choice: 'required',
        parallel_tool_calls: false,
        top_p: 0.9,
        seed: 42,
        stop: 'END',
        user: 'test'
      }),
      'openai-codex-responses'
    )
    expect(fields).toBeDefined()
    expect(fields?.['tool_choice']).toBe('required')
    expect(fields?.['parallel_tool_calls']).toBe(false)
    // These should NOT be included for codex
    expect(fields?.['top_p']).toBeUndefined()
    expect(fields?.['seed']).toBeUndefined()
    expect(fields?.['stop']).toBeUndefined()
    expect(fields?.['user']).toBeUndefined()
  })

  test('tool_choice coexists with other passthrough fields', () => {
    const fields = collectPayloadFields(
      minimalRequest({
        tool_choice: 'auto',
        top_p: 0.9,
        seed: 42
      }),
      'openai-completions'
    )
    expect(fields).toBeDefined()
    expect(fields?.['tool_choice']).toBe('auto')
    expect(fields?.['top_p']).toBe(0.9)
    expect(fields?.['seed']).toBe(42)
  })
})

// --- parallel_tool_calls ---

describe('collectPayloadFields: parallel_tool_calls', () => {
  test('includes parallel_tool_calls: false in payload fields', () => {
    const fields = collectPayloadFields(
      minimalRequest({ parallel_tool_calls: false }),
      'openai-completions'
    )
    expect(fields).toBeDefined()
    expect(fields?.['parallel_tool_calls']).toBe(false)
  })

  test('includes parallel_tool_calls: true in payload fields', () => {
    const fields = collectPayloadFields(
      minimalRequest({ parallel_tool_calls: true }),
      'openai-completions'
    )
    expect(fields).toBeDefined()
    expect(fields?.['parallel_tool_calls']).toBe(true)
  })

  test('omits parallel_tool_calls when not provided', () => {
    const fields = collectPayloadFields(minimalRequest(), 'openai-completions')
    expect(fields).toBeUndefined()
  })

  test('translates parallel_tool_calls for Anthropic', () => {
    const fields = collectPayloadFields(
      minimalRequest({ parallel_tool_calls: false }),
      'anthropic-messages'
    )
    expect(fields).toBeDefined()
    // Anthropic: parallel_tool_calls: false -> tool_choice.disable_parallel_tool_use: true
    expect(fields?.['tool_choice']).toEqual({ type: 'auto', disable_parallel_tool_use: true })
  })
})

// --- metadata ---

describe('collectPayloadFields: metadata', () => {
  test('includes metadata in payload fields', () => {
    const metadata = { task: 'autocomplete', chat_id: 'abc-123' }
    const fields = collectPayloadFields(minimalRequest({ metadata }), 'openai-completions')
    expect(fields).toBeDefined()
    expect(fields?.['metadata']).toEqual(metadata)
  })

  test('omits metadata when not provided', () => {
    const fields = collectPayloadFields(minimalRequest(), 'openai-completions')
    expect(fields).toBeUndefined()
  })

  test('skips arbitrary metadata for Anthropic (only user_id supported)', () => {
    // Anthropic only accepts metadata.user_id, not arbitrary keys
    const fields = collectPayloadFields(
      minimalRequest({ metadata: { task: 'test' } }),
      'anthropic-messages'
    )
    // No user field set, so no metadata translation
    expect(fields).toBeUndefined()
  })
})

// --- prediction ---

describe('collectPayloadFields: prediction', () => {
  test('includes prediction with string content in payload fields', () => {
    const prediction = { type: 'content' as const, content: 'predicted output' }
    const fields = collectPayloadFields(minimalRequest({ prediction }), 'openai-completions')
    expect(fields).toBeDefined()
    expect(fields?.['prediction']).toEqual(prediction)
  })

  test('includes prediction with array content in payload fields', () => {
    const prediction = {
      type: 'content' as const,
      content: [{ type: 'text' as const, text: 'predicted' }]
    }
    const fields = collectPayloadFields(minimalRequest({ prediction }), 'openai-completions')
    expect(fields).toBeDefined()
    expect(fields?.['prediction']).toEqual(prediction)
  })

  test('omits prediction when not provided', () => {
    const fields = collectPayloadFields(minimalRequest(), 'openai-completions')
    expect(fields).toBeUndefined()
  })

  test('skips prediction for non-OpenAI APIs', () => {
    for (const api of ['bedrock-converse-stream', 'anthropic-messages']) {
      const fields = collectPayloadFields(
        minimalRequest({ prediction: { type: 'content', content: 'test' } }),
        api
      )
      // Anthropic returns undefined because prediction isn't a translated field
      // Bedrock returns undefined because it's unsupported
      expect(fields).toBeUndefined()
    }
  })
})

// --- collectPayloadFields: the whole payload, per API family ---

describe('collectPayloadFields: whole payload per API family', () => {
  /** Every passthrough field the proxy accepts, set at once. */
  const everyField = minimalRequest({
    tool_choice: 'required',
    parallel_tool_calls: false,
    top_p: 0.9,
    seed: 42,
    stop: ['END'],
    user: 'user-1',
    frequency_penalty: 0.5,
    presence_penalty: 0.2,
    metadata: { team: 'j5' },
    response_format: { type: 'json_object' }
  })

  const OPENAI_PAYLOAD = {
    stop: ['END'],
    user: 'user-1',
    top_p: 0.9,
    frequency_penalty: 0.5,
    presence_penalty: 0.2,
    seed: 42,
    response_format: { type: 'json_object' },
    tool_choice: 'required',
    parallel_tool_calls: false,
    metadata: { team: 'j5' }
  }

  // Catches an extra field forwarded to a provider that rejects unknown fields (Anthropic, Codex),
  // a field lost or renamed in translation, or Google and Bedrock getting flat fields at all.
  test.each([
    ['openai-completions', OPENAI_PAYLOAD],
    ['openai-responses', OPENAI_PAYLOAD],
    ['azure-openai-responses', OPENAI_PAYLOAD],
    ['mistral-conversations', OPENAI_PAYLOAD],
    [
      'anthropic-messages',
      {
        top_p: 0.9,
        stop_sequences: ['END'],
        tool_choice: { type: 'any', disable_parallel_tool_use: true },
        metadata: { user_id: 'user-1' }
      }
    ],
    ['openai-codex-responses', { tool_choice: 'required', parallel_tool_calls: false }],
    ['google-generative-ai', undefined],
    ['bedrock-converse-stream', undefined]
  ])('%s gets exactly its payload', (api, expected) => {
    expect(collectPayloadFields(everyField, api)).toEqual(expected)
  })
})

/**
 * Unit tests for provider-specific onPayload passthrough translation in pi/complete.ts.
 *
 * - Anthropic: translated field names/formats
 * - Google: nested generationConfig patching
 */

import {
  collectAnthropicPayloadFields,
  patchGooglePayload,
  translateToolChoiceForAnthropic
} from '@proxy/pi/complete'
import { describe, expect, test } from 'vite-plus/test'

import { minimalRequest } from './payload-passthrough-helpers'

// --- Anthropic translation ---

describe('collectAnthropicPayloadFields', () => {
  test('translates top_p (same name, natively supported)', () => {
    const fields = collectAnthropicPayloadFields(minimalRequest({ top_p: 0.9 }))
    expect(fields).toBeDefined()
    expect(fields?.['top_p']).toBe(0.9)
  })

  test('translates stop string to stop_sequences array', () => {
    const fields = collectAnthropicPayloadFields(minimalRequest({ stop: 'END' }))
    expect(fields).toBeDefined()
    expect(fields?.['stop_sequences']).toEqual(['END'])
  })

  test('translates stop array to stop_sequences', () => {
    const fields = collectAnthropicPayloadFields(minimalRequest({ stop: ['END', 'STOP'] }))
    expect(fields).toBeDefined()
    expect(fields?.['stop_sequences']).toEqual(['END', 'STOP'])
  })

  test('translates user to metadata.user_id', () => {
    const fields = collectAnthropicPayloadFields(minimalRequest({ user: 'user-123' }))
    expect(fields).toBeDefined()
    expect(fields?.['metadata']).toEqual({ user_id: 'user-123' })
  })

  // Catches an Anthropic translation that leaks an unsupported field (seed, penalties,
  // response_format, prediction, arbitrary metadata) into the request, which Anthropic rejects:
  // with every passthrough field set, only the translated fields may come out.
  test('sends only translated fields when every passthrough field is set', () => {
    const fields = collectAnthropicPayloadFields(
      minimalRequest({
        tool_choice: 'required',
        parallel_tool_calls: false,
        top_p: 0.9,
        seed: 42,
        stop: 'END',
        user: 'user-123',
        frequency_penalty: 0.5,
        presence_penalty: 0.5,
        metadata: { task: 'test', chat_id: 'abc' },
        response_format: { type: 'json_object' },
        prediction: { type: 'content', content: 'test' }
      })
    )
    expect(fields).toEqual({
      top_p: 0.9,
      stop_sequences: ['END'],
      tool_choice: { type: 'any', disable_parallel_tool_use: true },
      metadata: { user_id: 'user-123' }
    })
  })

  // Catches unsupported fields alone producing a non-empty patch.
  test('returns undefined when only unsupported fields are set', () => {
    const fields = collectAnthropicPayloadFields(
      minimalRequest({
        seed: 42,
        frequency_penalty: 0.5,
        presence_penalty: 0.5,
        metadata: { task: 'test', chat_id: 'abc' },
        response_format: { type: 'json_object' },
        prediction: { type: 'content', content: 'test' }
      })
    )
    expect(fields).toBeUndefined()
  })
})

describe('translateToolChoiceForAnthropic', () => {
  test('auto -> { type: auto }', () => {
    expect(translateToolChoiceForAnthropic('auto')).toEqual({ type: 'auto' })
  })

  test('none -> { type: none }', () => {
    expect(translateToolChoiceForAnthropic('none')).toEqual({ type: 'none' })
  })

  test('required -> { type: any }', () => {
    expect(translateToolChoiceForAnthropic('required')).toEqual({ type: 'any' })
  })

  test('named function -> { type: tool, name }', () => {
    const choice = { type: 'function' as const, function: { name: 'get_weather' } }
    expect(translateToolChoiceForAnthropic(choice)).toEqual({
      type: 'tool',
      name: 'get_weather'
    })
  })

  test('undefined -> undefined', () => {
    expect(translateToolChoiceForAnthropic(undefined)).toBeUndefined()
  })
})

describe('collectAnthropicPayloadFields: tool_choice + parallel', () => {
  test('tool_choice auto with parallel disabled', () => {
    const fields = collectAnthropicPayloadFields(
      minimalRequest({ tool_choice: 'auto', parallel_tool_calls: false })
    )
    expect(fields?.['tool_choice']).toEqual({ type: 'auto', disable_parallel_tool_use: true })
  })

  test('tool_choice required with parallel disabled', () => {
    const fields = collectAnthropicPayloadFields(
      minimalRequest({ tool_choice: 'required', parallel_tool_calls: false })
    )
    expect(fields?.['tool_choice']).toEqual({ type: 'any', disable_parallel_tool_use: true })
  })

  test('parallel disabled without explicit tool_choice defaults to auto', () => {
    const fields = collectAnthropicPayloadFields(minimalRequest({ parallel_tool_calls: false }))
    expect(fields?.['tool_choice']).toEqual({ type: 'auto', disable_parallel_tool_use: true })
  })

  test('parallel true does not add disable flag', () => {
    const fields = collectAnthropicPayloadFields(
      minimalRequest({ tool_choice: 'auto', parallel_tool_calls: true })
    )
    expect(fields?.['tool_choice']).toEqual({ type: 'auto' })
  })

  test('named function with parallel disabled', () => {
    const fields = collectAnthropicPayloadFields(
      minimalRequest({
        tool_choice: { type: 'function', function: { name: 'calc' } },
        parallel_tool_calls: false
      })
    )
    expect(fields?.['tool_choice']).toEqual({
      type: 'tool',
      name: 'calc',
      disable_parallel_tool_use: true
    })
  })
})

// --- Google nested patching ---

describe('patchGooglePayload', () => {
  /** Build a minimal Google-shaped payload. */
  function googlePayload(genConfig: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: 'gemini-2.5-flash',
      contents: [],
      config: {
        generationConfig: genConfig
      }
    }
  }

  test('patches topP into generationConfig', () => {
    const payload = googlePayload()
    const patched = patchGooglePayload(payload, minimalRequest({ top_p: 0.9 }))
    expect(patched).toBe(true)
    const config = payload['config'] as Record<string, unknown>
    const gen = config['generationConfig'] as Record<string, unknown>
    expect(gen['topP']).toBe(0.9)
  })

  test('patches stopSequences from string stop', () => {
    const payload = googlePayload()
    patchGooglePayload(payload, minimalRequest({ stop: 'END' }))
    const config = payload['config'] as Record<string, unknown>
    const gen = config['generationConfig'] as Record<string, unknown>
    expect(gen['stopSequences']).toEqual(['END'])
  })

  test('patches stopSequences from array stop', () => {
    const payload = googlePayload()
    patchGooglePayload(payload, minimalRequest({ stop: ['END', 'STOP'] }))
    const config = payload['config'] as Record<string, unknown>
    const gen = config['generationConfig'] as Record<string, unknown>
    expect(gen['stopSequences']).toEqual(['END', 'STOP'])
  })

  test('patches seed', () => {
    const payload = googlePayload()
    patchGooglePayload(payload, minimalRequest({ seed: 42 }))
    const config = payload['config'] as Record<string, unknown>
    const gen = config['generationConfig'] as Record<string, unknown>
    expect(gen['seed']).toBe(42)
  })

  test('patches frequencyPenalty', () => {
    const payload = googlePayload()
    patchGooglePayload(payload, minimalRequest({ frequency_penalty: 0.5 }))
    const config = payload['config'] as Record<string, unknown>
    const gen = config['generationConfig'] as Record<string, unknown>
    expect(gen['frequencyPenalty']).toBe(0.5)
  })

  test('patches presencePenalty', () => {
    const payload = googlePayload()
    patchGooglePayload(payload, minimalRequest({ presence_penalty: -0.5 }))
    const config = payload['config'] as Record<string, unknown>
    const gen = config['generationConfig'] as Record<string, unknown>
    expect(gen['presencePenalty']).toBe(-0.5)
  })

  test('patches tool_choice to toolConfig mode AUTO', () => {
    const payload = googlePayload()
    patchGooglePayload(payload, minimalRequest({ tool_choice: 'auto' }))
    const config = payload['config'] as Record<string, unknown>
    const tc = config['toolConfig'] as Record<string, unknown>
    const fc = tc['functionCallingConfig'] as Record<string, unknown>
    expect(fc['mode']).toBe('AUTO')
  })

  test('patches tool_choice none to NONE', () => {
    const payload = googlePayload()
    patchGooglePayload(payload, minimalRequest({ tool_choice: 'none' }))
    const config = payload['config'] as Record<string, unknown>
    const tc = config['toolConfig'] as Record<string, unknown>
    const fc = tc['functionCallingConfig'] as Record<string, unknown>
    expect(fc['mode']).toBe('NONE')
  })

  test('patches tool_choice required to ANY', () => {
    const payload = googlePayload()
    patchGooglePayload(payload, minimalRequest({ tool_choice: 'required' }))
    const config = payload['config'] as Record<string, unknown>
    const tc = config['toolConfig'] as Record<string, unknown>
    const fc = tc['functionCallingConfig'] as Record<string, unknown>
    expect(fc['mode']).toBe('ANY')
  })

  test('preserves existing generationConfig fields', () => {
    const payload = googlePayload({ temperature: 0.7 })
    patchGooglePayload(payload, minimalRequest({ top_p: 0.9 }))
    const config = payload['config'] as Record<string, unknown>
    const gen = config['generationConfig'] as Record<string, unknown>
    expect(gen['temperature']).toBe(0.7)
    expect(gen['topP']).toBe(0.9)
  })

  test('returns false when no fields to patch', () => {
    const payload = googlePayload()
    const patched = patchGooglePayload(payload, minimalRequest())
    expect(patched).toBe(false)
  })

  test('returns false when payload has no config', () => {
    const payload: Record<string, unknown> = { model: 'test' }
    const patched = patchGooglePayload(payload, minimalRequest({ top_p: 0.9 }))
    expect(patched).toBe(false)
  })

  // Catches a named tool_choice mapped to AUTO (the model could then skip the tool) or dropped:
  // Google cannot force one function, so the closest is ANY.
  test('maps a named tool_choice to mode ANY', () => {
    const payload = googlePayload()
    const patched = patchGooglePayload(
      payload,
      minimalRequest({ tool_choice: { type: 'function', function: { name: 'get_weather' } } })
    )
    expect(patched).toBe(true)
    expect(payload).toEqual({
      model: 'gemini-2.5-flash',
      contents: [],
      config: {
        generationConfig: {},
        toolConfig: { functionCallingConfig: { mode: 'ANY' } }
      }
    })
  })

  // Catches an unsupported field (user, metadata, response_format, prediction,
  // parallel_tool_calls) leaking into Google's payload, or a supported one landing in the wrong
  // place: with every passthrough field set, the whole payload is pinned.
  test('patches only supported fields when every passthrough field is set', () => {
    const payload = googlePayload()
    patchGooglePayload(
      payload,
      minimalRequest({
        tool_choice: 'required',
        parallel_tool_calls: false,
        top_p: 0.9,
        seed: 42,
        stop: 'END',
        user: 'user-123',
        frequency_penalty: 0.5,
        presence_penalty: -0.5,
        metadata: { task: 'test' },
        response_format: { type: 'json_object' },
        prediction: { type: 'content', content: 'test' }
      })
    )
    expect(payload).toEqual({
      model: 'gemini-2.5-flash',
      contents: [],
      config: {
        generationConfig: {
          topP: 0.9,
          stopSequences: ['END'],
          seed: 42,
          frequencyPenalty: 0.5,
          presencePenalty: -0.5
        },
        toolConfig: { functionCallingConfig: { mode: 'ANY' } }
      }
    })
  })
})

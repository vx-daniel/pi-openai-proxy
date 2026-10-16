/**
 * Shared helpers for the payload passthrough unit tests.
 */

import type { ChatCompletionRequest } from '@proxy/openai/schemas'
import { isRecord } from '@proxy/utils/guards'

/**
 * Narrow a value to Record<string, unknown> with a runtime check.
 * Throws if the value is not an object — test will fail with a clear message.
 */
export function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be a record, got ${typeof value}`)
  }
  return value
}

/** Minimal valid request for collectPayloadFields tests. */
export function minimalRequest(
  overrides: Partial<ChatCompletionRequest> = {}
): ChatCompletionRequest {
  return {
    model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides
  }
}

/**
 * Request validation: parse and reject unsupported fields.
 *
 * Phase 2 contract: unknown fields -> 422, rejected fields -> 422
 */

import { proxyLogger } from '@proxy/logging'
import {
  type ChatCompletionRequest,
  chatCompletionRequestSchema,
  rejectedFields
} from '@proxy/openai/schemas'
import { isRecord } from '@proxy/utils/guards'

const validateLogger = proxyLogger('openai', 'validate')

/** Accepted fields the proxy forwards upstream without interpreting them. */
const PASSTHROUGH_FIELDS = ['metadata', 'prediction'] as const

export interface ValidationSuccess {
  readonly ok: true
  readonly data: ChatCompletionRequest
}

export interface ValidationError {
  readonly ok: false
  readonly status: number
  readonly message: string
  readonly param: string | null
}

export type ValidationResult = ValidationSuccess | ValidationError

/**
 * Validate a raw request body against the Phase 1 schema.
 *
 * Also checks for known rejected fields to give friendly errors.
 */
export function validateChatRequest(body: unknown): ValidationResult {
  // Check for rejected fields before schema parsing
  if (isRecord(body)) {
    for (const field of rejectedFields) {
      if (body[field] !== undefined) {
        validateLogger.warn('Rejected unsupported field {field}', { field })
        return {
          ok: false,
          status: 422,
          message: `'${field}' is not supported in this version of the proxy`,
          param: field
        }
      }
    }
  }

  const result = chatCompletionRequestSchema.safeParse(body)

  if (result.success) {
    const { data } = result
    validateLogger.debug('Validated chat request for {model}', () => ({
      model: data.model,
      stream: data.stream === true,
      messageCount: data.messages.length,
      toolCount: data.tools?.length ?? 0,
      fields: Object.keys(data),
      passthroughFields: PASSTHROUGH_FIELDS.filter((field) => data[field] !== undefined)
    }))
    return { ok: true, data }
  }

  // Extract the first Zod error for a clean message
  const firstIssue = result.error.issues[0]
  if (firstIssue !== undefined) {
    const path = firstIssue.path.join('.')
    if (firstIssue.code === 'unrecognized_keys') {
      validateLogger.warn('Rejected unknown fields {fields}', { fields: firstIssue.keys })
      return {
        ok: false,
        status: 422,
        message: `Unknown parameter(s): ${firstIssue.keys.join(', ')}`,
        param: firstIssue.keys[0] ?? null
      }
    }
    // The issue code and path only: an issue message can quote the rejected value.
    validateLogger.warn('Rejected invalid value at {path} ({code})', {
      path: path.length > 0 ? path : '(root)',
      code: firstIssue.code,
      issueCount: result.error.issues.length
    })
    return {
      ok: false,
      status: 400,
      message: `Invalid value for '${path}': ${firstIssue.message}`,
      param: path.length > 0 ? path : null
    }
  }

  validateLogger.warn('Rejected request body with no validation issue detail')
  return {
    ok: false,
    status: 400,
    message: 'Invalid request body',
    param: null
  }
}

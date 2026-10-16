import {
  invalidRequest,
  mapUpstreamError,
  modelNotFound,
  unsupportedParameter
} from '@proxy/server/errors'
import { describe, expect, test } from 'vite-plus/test'

describe('error helpers', () => {
  test('invalidRequest creates correct shape', () => {
    const err = invalidRequest('bad input', 'model')
    expect(err.error.message).toBe('bad input')
    expect(err.error.type).toBe('invalid_request_error')
    expect(err.error.param).toBe('model')
    expect(err.error.code).toBeNull()
  })

  test('modelNotFound creates correct shape', () => {
    const err = modelNotFound('fake/model')
    expect(err.error.message).toContain('fake/model')
    expect(err.error.code).toBe('model_not_found')
  })

  test('unsupportedParameter creates correct shape', () => {
    const err = unsupportedParameter('tools')
    expect(err.error.param).toBe('tools')
    expect(err.error.code).toBe('unsupported_parameter')
  })
})

describe('mapUpstreamError', () => {
  /** Upstream error text can quote the request, a key or an account: none of it may pass through. */
  const SECRET = 'notarealsecret-upstream-quoted-key'

  function upstreamBody(message: string, code: string): unknown {
    return { error: { message, type: 'server_error', param: null, code } }
  }

  // Catches a branch answering with the wrong status, a body that is not the fixed text for it,
  // or the upstream message (and whatever it quotes) reaching the client.
  test.each([
    [
      'a rate limit',
      `rate limit exceeded for ${SECRET}`,
      429,
      upstreamBody('Upstream rate limit exceeded', 'rate_limit')
    ],
    [
      'a socket timeout',
      `connect ETIMEDOUT ${SECRET}`,
      504,
      upstreamBody('Upstream request timed out', 'timeout')
    ],
    [
      'the proxy’s upstream idle timeout',
      'Upstream timeout: the provider sent nothing for 120 s',
      504,
      upstreamBody('Upstream request timed out', 'timeout')
    ],
    [
      'an upstream auth failure',
      `401 Unauthorized: invalid x-api-key ${SECRET}`,
      502,
      upstreamBody('Upstream authentication failed', 'upstream_auth_error')
    ],
    [
      'an overloaded provider',
      `529 overloaded ${SECRET}`,
      503,
      upstreamBody('Upstream provider is overloaded', 'provider_overloaded')
    ],
    [
      'anything else',
      `400 {"error":"prompt contained ${SECRET}"}`,
      502,
      upstreamBody('Upstream provider error', 'upstream_error')
    ]
  ])('maps %s to its status and fixed text', (_case, upstreamMessage, status, body) => {
    const mapped = mapUpstreamError(new Error(upstreamMessage))

    expect(mapped).toEqual({ status, body })
    expect(JSON.stringify(mapped)).not.toContain(SECRET)
  })

  const RATE_LIMITED = {
    status: 429,
    body: upstreamBody('Upstream rate limit exceeded', 'rate_limit')
  }
  const TIMED_OUT = { status: 504, body: upstreamBody('Upstream request timed out', 'timeout') }
  const AUTH_FAILED = {
    status: 502,
    body: upstreamBody('Upstream authentication failed', 'upstream_auth_error')
  }
  const UNAVAILABLE = {
    status: 503,
    body: upstreamBody('Upstream provider is unavailable', 'provider_unavailable')
  }
  const PROVIDER_FAILED = {
    status: 502,
    body: upstreamBody('Upstream provider error', 'upstream_error')
  }

  // Catches the status read from the wrong place (#42): pi 1.3.0 reports it in fixed positions per
  // SDK, and those decide over the wording; a number elsewhere in the text, or a word inside
  // another word, must not.
  test.each([
    [
      'OpenAI quota, no "rate limit" wording',
      '429: {"message":"You exceeded your current quota","type":"insufficient_quota"}',
      RATE_LIMITED
    ],
    [
      'Anthropic 429 worded "Too many requests"',
      '429 {"type":"error","error":{"type":"api_error","message":"Too many requests"}}',
      RATE_LIMITED
    ],
    [
      'a 401 whose text says "rate limit"',
      '401: {"message":"Invalid key for the rate limit tier"}',
      AUTH_FAILED
    ],
    [
      'Responses/Azure with a label',
      'OpenAI API error (429): {"message":"Slow down"}',
      RATE_LIMITED
    ],
    [
      // No wording any fallback matches: only the body's `code` can say this is an auth failure.
      'Google error body',
      '{"error":{"code":401,"message":"Request had invalid authentication credentials.","status":"UNAUTHENTICATED"}}',
      AUTH_FAILED
    ],
    [
      'Google mid-stream',
      'got status: 503. {"error":{"code":503,"message":"The model is overloaded"}}',
      UNAVAILABLE
    ],
    ['an upstream 504', '504: {"message":"Gateway Timeout"}', TIMED_OUT],
    ['an upstream 408', '408 Request Timeout', TIMED_OUT],
    ['an upstream 503', '503: {"message":"Service Unavailable"}', UNAVAILABLE],
    [
      'an upstream 500 that mentions a rate limit',
      '500: {"message":"rate limiter crashed"}',
      PROVIDER_FAILED
    ],
    [
      '401 only as data, no status',
      'Invalid prompt: 401 tokens over the 200000 limit',
      PROVIDER_FAILED
    ],
    ['"generate" is not "rate"', 'Could not generate limit-compliant output', PROVIDER_FAILED],
    [
      'Bedrock throttling, no status',
      'Too many requests, please wait before trying again.',
      RATE_LIMITED
    ],
    [
      'Bedrock unavailable, no status',
      'ServiceUnavailableException: Service unavailable',
      UNAVAILABLE
    ],
    ['a dropped connection', 'terminated', PROVIDER_FAILED]
  ])('maps %s', (_case, upstreamMessage, expected) => {
    expect(mapUpstreamError(new Error(upstreamMessage))).toEqual(expected)
  })

  test('maps a thrown value that is not an Error to the generic 502', () => {
    expect(mapUpstreamError(`string error ${SECRET}`)).toEqual({
      status: 502,
      body: upstreamBody('Upstream provider error', 'upstream_error')
    })
  })
})

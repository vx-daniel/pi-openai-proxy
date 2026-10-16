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

  test('maps a thrown value that is not an Error to the generic 502', () => {
    expect(mapUpstreamError(`string error ${SECRET}`)).toEqual({
      status: 502,
      body: upstreamBody('Upstream provider error', 'upstream_error')
    })
  })
})

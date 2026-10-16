/**
 * Hono middleware: request ID injection, proxy auth, body size limits, structured logging.
 */

import type { ServerConfig } from '@proxy/config/env'
import { authenticationError, invalidRequest } from '@proxy/server/errors'
import { HTTP_PAYLOAD_TOO_LARGE, HTTP_UNAUTHORIZED } from '@proxy/server/http-status'
import { logDisconnect, logRequest, logResponse } from '@proxy/server/logging'
import { generateRequestId } from '@proxy/server/request-id'
import type { ProxyEnv } from '@proxy/server/types'
import type { MiddlewareHandler } from 'hono'

const BEARER_PREFIX = 'Bearer '

/**
 * Inject request ID, upstream API key, and logging context into every request.
 */
export function requestIdMiddleware(): MiddlewareHandler<ProxyEnv> {
  return async (context, next) => {
    const requestId = generateRequestId()
    const clientRequestId = context.req.header('x-client-request-id')
    const upstreamApiKey = context.req.header('x-pi-upstream-api-key')
    const start = performance.now()

    context.set('requestId', requestId)
    context.set('clientRequestId', clientRequestId)
    context.set('upstreamApiKey', upstreamApiKey)

    logRequest({
      requestId,
      clientRequestId,
      method: context.req.method,
      path: context.req.path
    })

    // Set response headers
    context.header('x-request-id', requestId)
    if (clientRequestId !== undefined) {
      context.header('x-client-request-id', clientRequestId)
    }

    await next()

    const duration = performance.now() - start
    logResponse(
      { requestId, clientRequestId, method: context.req.method, path: context.req.path },
      context.res.status,
      duration
    )
  }
}

/**
 * Optional proxy auth middleware.
 * Only active when PI_PROXY_AUTH_TOKEN is set.
 */
export function proxyAuthMiddleware(config: ServerConfig): MiddlewareHandler<ProxyEnv> {
  return async (context, next) => {
    if (config.proxyAuthToken === undefined) {
      await next()
      return undefined
    }

    const authHeader = context.req.header('authorization')
    if (authHeader === undefined) {
      return context.json(authenticationError('Missing Authorization header'), HTTP_UNAUTHORIZED)
    }

    const token = authHeader.startsWith(BEARER_PREFIX)
      ? authHeader.slice(BEARER_PREFIX.length)
      : undefined

    if (token !== config.proxyAuthToken) {
      return context.json(
        authenticationError('Invalid proxy authentication token'),
        HTTP_UNAUTHORIZED
      )
    }

    await next()
    return undefined
  }
}

/**
 * Client disconnect detection middleware.
 * Creates an AbortController for upstream cancellation.
 */
export function disconnectMiddleware(): MiddlewareHandler<ProxyEnv> {
  return async (context, next) => {
    const controller = new AbortController()
    context.set('abortController', controller)

    // Listen for client disconnect via the request signal
    const reqSignal = context.req.raw.signal
    const onAbort = (): void => {
      const requestId = context.get('requestId')
      logDisconnect({
        requestId,
        method: context.req.method,
        path: context.req.path
      })
      controller.abort()
    }
    if (reqSignal.aborted) {
      onAbort()
    } else {
      reqSignal.addEventListener('abort', onAbort, { once: true })
    }

    await next()
  }
}

/**
 * Request body size limit middleware.
 * Rejects requests with Content-Length exceeding the configured maximum.
 * Only applies to POST/PUT/PATCH methods.
 */
export function bodySizeLimitMiddleware(config: ServerConfig): MiddlewareHandler<ProxyEnv> {
  return async (context, next) => {
    const method = context.req.method
    if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
      await next()
      return undefined
    }

    const contentLength = context.req.header('content-length')
    if (contentLength !== undefined) {
      const length = Number.parseInt(contentLength, 10)
      if (Number.isFinite(length) && length > config.maxBodySize) {
        return context.json(
          invalidRequest(
            `Request body too large. Maximum size: ${String(config.maxBodySize)} bytes`
          ),
          HTTP_PAYLOAD_TOO_LARGE
        )
      }
    }

    await next()
    return undefined
  }
}

/**
 * Hono middleware: request ID injection, proxy auth, body size limits, request logging.
 */

import { withContext } from '@logtape/logtape'
import type { ServerConfig } from '@proxy/config/env'
import { proxyLogger } from '@proxy/logging'
import { authenticationError, invalidRequest } from '@proxy/server/errors'
import {
  HTTP_MULTIPLE_CHOICES,
  HTTP_PAYLOAD_TOO_LARGE,
  HTTP_UNAUTHORIZED
} from '@proxy/server/http-status'
import { generateRequestId } from '@proxy/server/request-id'
import type { ProxyEnv } from '@proxy/server/types'
import type { MiddlewareHandler } from 'hono'

const httpLogger = proxyLogger('server', 'http')
const authLogger = proxyLogger('server', 'auth')

const BEARER_PREFIX = 'Bearer '
const MODEL_LIST_PATH = '/v1/models'

/**
 * Inject the request ID and upstream API key into every request, and log the request and its
 * response. Everything downstream runs inside `withContext({ requestId, clientRequestId })`, so
 * every log line a request causes carries its IDs without passing them around.
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

    // Set response headers
    context.header('x-request-id', requestId)
    if (clientRequestId !== undefined) {
      context.header('x-client-request-id', clientRequestId)
    }

    const { method, path } = context.req
    // A model list is what healthchecks and clients poll, often every few seconds: its lines go to
    // debug, except an answer that is not 2xx, which stays at info.
    const polling = method === 'GET' && path === MODEL_LIST_PATH
    await withContext({ requestId, clientRequestId }, async () => {
      const received = {
        method,
        path,
        requestId,
        hasUpstreamApiKey: upstreamApiKey !== undefined
      }
      if (polling) httpLogger.debug('{method} {path} received ({requestId})', received)
      else httpLogger.info('{method} {path} received ({requestId})', received)
      await next()
      const status = context.res.status
      const answered = {
        method,
        path,
        status,
        durationMs: Math.round(performance.now() - start),
        requestId
      }
      const message = '{method} {path} answered {status} in {durationMs} ms ({requestId})'
      if (polling && status < HTTP_MULTIPLE_CHOICES) httpLogger.debug(message, answered)
      else httpLogger.info(message, answered)
    })
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
      authLogger.warn('Rejected {method} {path}: missing Authorization header', {
        method: context.req.method,
        path: context.req.path
      })
      return context.json(authenticationError('Missing Authorization header'), HTTP_UNAUTHORIZED)
    }

    const isBearer = authHeader.startsWith(BEARER_PREFIX)
    const token = isBearer ? authHeader.slice(BEARER_PREFIX.length) : undefined

    if (token !== config.proxyAuthToken) {
      // Never the header or token value: only whether the scheme was right.
      authLogger.warn('Rejected {method} {path}: invalid proxy auth token', {
        method: context.req.method,
        path: context.req.path,
        bearerScheme: isBearer
      })
      return context.json(
        authenticationError('Invalid proxy authentication token'),
        HTTP_UNAUTHORIZED
      )
    }

    authLogger.debug('Proxy auth accepted for {method} {path}', {
      method: context.req.method,
      path: context.req.path
    })
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
      // An abort listener runs outside the request's async context, so the IDs are passed here.
      httpLogger.info('Client disconnected from {method} {path} ({requestId})', {
        method: context.req.method,
        path: context.req.path,
        requestId: context.get('requestId'),
        clientRequestId: context.get('clientRequestId')
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
        httpLogger.warn(
          'Rejected {method} {path}: body of {contentLength} bytes exceeds limit of {maxBodySize}',
          { method, path: context.req.path, contentLength: length, maxBodySize: config.maxBodySize }
        )
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

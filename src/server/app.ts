/**
 * Hono application assembly: middleware + routes.
 */

import type { ServerConfig } from '@proxy/config/env'
import { proxyLogger } from '@proxy/logging'
import { createHealthRoutes } from '@proxy/server/health'
import {
  bodySizeLimitMiddleware,
  disconnectMiddleware,
  proxyAuthMiddleware,
  requestIdMiddleware
} from '@proxy/server/middleware'
import { createRoutes, type ExposureConfigReader, fileConfigReader } from '@proxy/server/routes'
import type { ProxyEnv } from '@proxy/server/types'
import { Hono } from 'hono'

const lifecycleLogger = proxyLogger('server')

export function createApp(
  config: ServerConfig,
  configReader?: ExposureConfigReader
): Hono<ProxyEnv> {
  const app = new Hono<ProxyEnv>()

  // Global middleware
  app.use('*', requestIdMiddleware())
  app.use('*', disconnectMiddleware())
  app.use('*', bodySizeLimitMiddleware(config))
  app.use('/v1/*', proxyAuthMiddleware(config))
  // `/healthz` itself stays open for liveness probes; its detail endpoints name providers and
  // models. Not `/healthz/*`: Hono's wildcard also matches the bare `/healthz`.
  app.use('/healthz/:check{.+}', proxyAuthMiddleware(config))

  // Routes
  app.route('/', createHealthRoutes(configReader ?? fileConfigReader))
  app.route('/', createRoutes(config, configReader))

  lifecycleLogger.debug('App wired: proxy auth {authMode}, exposure config from {exposureSource}', {
    authMode: config.proxyAuthToken === undefined ? 'disabled' : 'enabled',
    exposureSource: configReader === undefined ? 'config file' : 'custom reader'
  })
  return app
}

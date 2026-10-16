/**
 * Operational health endpoints. They are not part of the OpenAI-compatible surface (`/v1/*`).
 *
 *   GET /healthz          Liveness: the proxy is listening and pi's model runtime is loaded. No
 *                         authentication, no body beyond `{ "status": "ok" }`, no upstream calls:
 *                         cheap enough for a container healthcheck every few seconds.
 *   GET /healthz/models   The model runtime: models.json load error, available and exposed model
 *                         counts, exposure modes. 503 when no model is exposed or the exposure
 *                         config is invalid.
 *   GET /healthz/creds    Per provider: how pi is authenticated (OAuth or API key, and where the
 *                         credential came from) and how many of its models are available. Local
 *                         state only; `?verify=true` asks pi to resolve each credential now, which
 *                         may refresh an OAuth token over the network. 503 when no provider has a
 *                         credential, or a verified one fails.
 *
 * The detail endpoints sit behind proxy authentication when it is on (they name providers and
 * models); `/healthz` never does. None of them returns a credential.
 */

import { proxyLogger } from '@proxy/logging'
import { computeModelExposure } from '@proxy/openai/model-exposure'
import { getAvailableModels, getCredentialStatuses, getModelsJsonError } from '@proxy/pi/registry'
import { HTTP_SERVICE_UNAVAILABLE } from '@proxy/server/http-status'
import type { ExposureConfigReader } from '@proxy/server/routes'
import type { ProxyEnv } from '@proxy/server/types'
import { Hono } from 'hono'

const healthLogger = proxyLogger('server', 'health')

export function createHealthRoutes(configReader: ExposureConfigReader): Hono<ProxyEnv> {
  const routes = new Hono<ProxyEnv>()

  routes.get('/healthz', (context) => context.json({ status: 'ok' }))

  routes.get('/healthz/models', async (context) => {
    const config = await configReader()
    const available = getAvailableModels()
    const exposure = computeModelExposure(available, config)
    const exposedModelCount = exposure.ok ? exposure.models.length : 0
    const healthy = exposure.ok && exposedModelCount > 0
    const body = {
      status: healthy ? 'ok' : 'unavailable',
      availableModelCount: available.length,
      exposedModelCount,
      modelExposureMode: config.modelExposureMode,
      publicModelIdMode: config.publicModelIdMode,
      exposureError: exposure.ok ? null : exposure.message,
      modelsJsonError: getModelsJsonError() ?? null
    }
    if (!healthy) {
      healthLogger.warn('Model health check failed: {exposedModelCount} models exposed', body)
      return context.json(body, HTTP_SERVICE_UNAVAILABLE)
    }
    return context.json(body)
  })

  routes.get('/healthz/creds', async (context) => {
    const verify = context.req.query('verify') === 'true'
    const providers = await getCredentialStatuses(verify)
    const failed = providers.filter((provider) => provider.verified === false)
    const healthy = providers.length > 0 && failed.length === 0
    const body = { status: healthy ? 'ok' : 'unavailable', verified: verify, providers }
    if (!healthy) {
      healthLogger.warn(
        'Credential health check failed: {providerCount} providers, {failedCount} failed to verify',
        { providerCount: providers.length, failedCount: failed.length, verify }
      )
      return context.json(body, HTTP_SERVICE_UNAVAILABLE)
    }
    return context.json(body)
  })

  return routes
}

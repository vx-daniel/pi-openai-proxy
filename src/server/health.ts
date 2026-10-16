/**
 * Operational health endpoints. They are not part of the OpenAI-compatible surface (`/v1/*`).
 *
 *   GET /healthz          Liveness. The server starts listening only after pi's model runtime has
 *                         loaded, so any answer means both. No authentication, no body beyond
 *                         `{ "status": "ok" }`, no upstream calls: cheap enough for a container
 *                         healthcheck every few seconds.
 *   GET /healthz/models   The model runtime: models.json load error, available and exposed model
 *                         counts, exposure modes. 503 when no model is exposed or the exposure
 *                         config is invalid.
 *   GET /healthz/creds    Per provider: how pi is authenticated (OAuth or API key, and where the
 *                         credential came from) and how many of its models are available. Local
 *                         state only; `?verify=true` asks pi to resolve each credential now, which
 *                         may refresh an OAuth token over the network. 503 when no provider has a
 *                         credential, or a verified one fails.
 *
 * A detail check that throws (an unreadable config file, say) answers 503 rather than 500: it is a
 * failed check. Its message goes to the log, not the response.
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
import { type Context, Hono } from 'hono'

const healthLogger = proxyLogger('server', 'health')

type HealthContext = Context<ProxyEnv>

function failedCheck(context: HealthContext, check: string, error: unknown): Response {
  healthLogger.warn('The {check} health check threw: {error}', {
    check,
    error: error instanceof Error ? error.message : String(error)
  })
  return context.json(
    { status: 'unavailable', error: `the ${check} check failed; see the proxy log` },
    HTTP_SERVICE_UNAVAILABLE
  )
}

async function checkModels(
  context: HealthContext,
  configReader: ExposureConfigReader
): Promise<Response> {
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
    healthLogger.warn(
      'Model health check failed: {exposedModelCount} of {availableModelCount} models exposed',
      { exposedModelCount, availableModelCount: available.length, exposureValid: exposure.ok }
    )
    return context.json(body, HTTP_SERVICE_UNAVAILABLE)
  }
  return context.json(body)
}

async function checkCredentials(context: HealthContext): Promise<Response> {
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
}

export function createHealthRoutes(configReader: ExposureConfigReader): Hono<ProxyEnv> {
  const routes = new Hono<ProxyEnv>()

  routes.get('/healthz', (context) => context.json({ status: 'ok' }))

  routes.get('/healthz/models', async (context) => {
    try {
      return await checkModels(context, configReader)
    } catch (error) {
      return failedCheck(context, 'models', error)
    }
  })

  routes.get('/healthz/creds', async (context) => {
    try {
      return await checkCredentials(context)
    } catch (error) {
      return failedCheck(context, 'credentials', error)
    }
  })

  return routes
}

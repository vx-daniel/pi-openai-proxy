/**
 * Pi ModelRuntime and SettingsManager integration.
 *
 * Initializes pi's model runtime (file-based auth and models.json storage), reads the global
 * `enabledModels` setting from pi's SettingsManager, and exposes lookup functions used by the
 * proxy routes.
 *
 * Pi 1.x replaced `AuthStorage` + `ModelRegistry.create()` with the async `ModelRuntime`, which
 * owns credentials, catalogs and request authentication in one place.
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent'
import { proxyLogger } from '@proxy/logging'

const registryLogger = proxyLogger('pi', 'registry')

let runtime: ModelRuntime | undefined
let settingsManager: SettingsManager | undefined

/** Outcome of resolving request auth for a model: usable, or why not. */
export type RequestAuthResult = { ok: true } | { ok: false; error: string }

/**
 * Initialize the runtime and settings. Call once at startup.
 * Returns the load error if models.json failed to parse, or undefined on success.
 */
export async function initRegistry(): Promise<string | undefined> {
  const cwd = process.cwd()
  runtime = await ModelRuntime.create()
  settingsManager = SettingsManager.create(cwd)
  const loadError = runtime.getError()
  if (loadError !== undefined) {
    registryLogger.warn('models.json failed to load; using built-in models only: {error}', {
      error: loadError
    })
  }
  registryLogger.info('Model runtime ready with {availableModelCount} available models', {
    availableModelCount: runtime.getAvailableSnapshot().length,
    settingsCwd: cwd,
    modelsJsonLoaded: loadError === undefined
  })
  return loadError
}

/** The initialized model runtime, which also runs completions (see `src/pi/complete.ts`). */
export function getRuntime(): ModelRuntime {
  if (runtime === undefined) {
    throw new Error('ModelRuntime not initialized. Call initRegistry() first.')
  }
  return runtime
}

export function getSettingsManager(): SettingsManager {
  if (settingsManager === undefined) {
    throw new Error('SettingsManager not initialized. Call initRegistry() first.')
  }
  return settingsManager
}

/**
 * Get all models available (have auth configured).
 *
 * This reads the runtime's availability snapshot, taken when `initRegistry()` ran: a model whose
 * credentials were added afterwards appears after a restart. Pi 0.x behaved the same way (its
 * synchronous `getAvailable()` checked credentials loaded at startup), so listing stays
 * synchronous and cheap.
 */
export function getAvailableModels(): Model<Api>[] {
  return [...getRuntime().getAvailableSnapshot()]
}

/**
 * Check that Pi can authenticate a request to this model right now.
 *
 * Completions resolve their own auth through the runtime (API keys, OAuth with refresh,
 * model-specific headers, dynamic models.json headers); this exists so a route can answer 401
 * before starting a response, instead of failing mid-stream with a less actionable error.
 */
export async function getRequestAuth(model: Model<Api>): Promise<RequestAuthResult> {
  const { provider, id: modelId } = model
  try {
    const credentials = await getRuntime().getAuth(model)
    if (credentials === undefined) {
      registryLogger.debug('No credentials configured for provider {provider}', {
        provider,
        modelId,
        credentialsResolved: false
      })
      return { ok: false, error: `no credentials configured for provider '${model.provider}'` }
    }
    registryLogger.debug('Credentials resolved for provider {provider}', {
      provider,
      modelId,
      credentialsResolved: true
    })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    registryLogger.warn('Credential resolution failed for provider {provider}: {error}', {
      provider,
      modelId,
      credentialsResolved: false,
      error: message
    })
    return { ok: false, error: message }
  }
}

/**
 * Get the `enabledModels` patterns from pi's global settings.
 *
 * These are the canonical model IDs (e.g. "anthropic/claude-sonnet-4-6")
 * persisted by the `/scoped-models` TUI when the user presses Ctrl+S.
 *
 * Returns undefined when no filter is configured (all models enabled).
 */
export async function getEnabledModels(): Promise<readonly string[] | undefined> {
  const manager = getSettingsManager()
  await manager.reload()
  const enabledModels = manager.getEnabledModels()
  registryLogger.debug('Read enabledModels from pi settings: {enabledModelCount} patterns', {
    enabledModelCount: enabledModels?.length ?? 0,
    filterConfigured: enabledModels !== undefined && enabledModels.length > 0
  })
  return enabledModels
}

/** Why models.json failed to load, or undefined when it loaded (or there is none). */
export function getModelsJsonError(): string | undefined {
  return getRuntime().getError()
}

/** How one provider is authenticated, for the health endpoint. Never the credential itself. */
export interface ProviderCredentialStatus {
  readonly provider: string
  /** `oauth` for a subscription login, `api_key` otherwise. */
  readonly type: 'oauth' | 'api_key'
  /** Where pi found the credential: `stored`, `environment`, `models_json_key`, … */
  readonly source: string | undefined
  readonly availableModelCount: number
  /**
   * Only when verification was asked for: whether pi resolved a usable credential just now, which
   * may refresh an OAuth token over the network. `error` says why not.
   */
  readonly verified?: boolean
  readonly error?: string
}

/** Longest verification error returned, after the stack is cut. */
const MAX_AUTH_ERROR_LENGTH = 500

/**
 * Pi's refresh errors append `; stack=…` with file paths of the install, which an HTTP response
 * should not carry. Keep the summary: the provider, the token URL, the upstream status and body.
 */
function summarizeAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const [summary = message] = message.split('; stack=')
  const [firstLine = summary] = summary.split('\n')
  return firstLine.slice(0, MAX_AUTH_ERROR_LENGTH)
}

async function verifyProvider(
  provider: string
): Promise<Pick<ProviderCredentialStatus, 'verified' | 'error'>> {
  try {
    const resolved = await getRuntime().getAuth(provider)
    return resolved === undefined
      ? { verified: false, error: 'no credentials configured' }
      : { verified: true }
  } catch (error) {
    const summary = summarizeAuthError(error)
    registryLogger.warn('Credential verification failed for {provider}', { provider })
    // The summary quotes the token endpoint's response: debug only, like other upstream error text.
    registryLogger.debug('Credential verification error for {provider}: {error}', {
      provider,
      error: summary
    })
    return { verified: false, error: summary }
  }
}

/**
 * Every provider pi has a credential for, with how it is configured and how many of its models are
 * available. Reads local state only, unless `verify` asks pi to resolve each credential (which may
 * refresh an OAuth token over the network).
 */
export async function getCredentialStatuses(verify: boolean): Promise<ProviderCredentialStatus[]> {
  const modelRuntime = getRuntime()
  const availableByProvider = new Map<string, number>()
  for (const model of modelRuntime.getAvailableSnapshot()) {
    availableByProvider.set(model.provider, (availableByProvider.get(model.provider) ?? 0) + 1)
  }
  const configured = modelRuntime
    .getProviders()
    .filter((provider) => modelRuntime.hasConfiguredAuth(provider.id))
  const statuses = await Promise.all(
    configured.map(async ({ id }): Promise<ProviderCredentialStatus> => {
      const base: ProviderCredentialStatus = {
        provider: id,
        type: modelRuntime.isUsingOAuth(id) ? 'oauth' : 'api_key',
        source: modelRuntime.getProviderAuthStatus(id).source,
        availableModelCount: availableByProvider.get(id) ?? 0
      }
      return verify ? { ...base, ...(await verifyProvider(id)) } : base
    })
  )
  registryLogger.debug('Credential status for {providerCount} providers', {
    providerCount: statuses.length,
    verify
  })
  return statuses
}

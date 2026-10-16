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

/**
 * Outcome of resolving request auth for a model: usable, or why not. `error` is already
 * summarized (`summarizeAuthError`), so a route may put it in a response.
 */
export type RequestAuthResult = { ok: true } | { ok: false; error: string }

/** pi appends the file's path to every models.json error after this separator. */
const MODELS_JSON_FILE_SEPARATOR = '\n\nFile: '
const MODELS_JSON_PARSE_PREFIX = 'Failed to parse models.json:'
const JSON_ERROR_LINE_COLUMN = /\(line (\d+) column (\d+)\)/
const JSON_ERROR_OFFSET = /position (\d+)/

/**
 * pi's models.json error split into its message and the file's path. The last separator is the
 * one pi appended: a parse snippet before it is file content and could, in principle, contain the
 * same text.
 */
function splitModelsJsonError(error: string): { detail: string; path: string | undefined } {
  const separator = error.lastIndexOf(MODELS_JSON_FILE_SEPARATOR)
  return separator === -1
    ? { detail: error, path: undefined }
    : {
        detail: error.slice(0, separator),
        path: error.slice(separator + MODELS_JSON_FILE_SEPARATOR.length)
      }
}

/**
 * pi's models.json error, reduced to what cannot quote the file. JSON.parse messages can include a
 * slice of the text around the fault (`Unexpected token 'o', ..."apiKey": notarealsec"... is not
 * valid JSON`), which is often a key, so a parse error keeps only where it is. Load errors (the
 * fs message) and schema errors (property paths, which name the user's providers and models, and
 * TypeBox's fixed messages) quote no values and pass through. The file's path is dropped; callers
 * that log it take it separately.
 */
export function describeModelsJsonError(error: string): string {
  const { detail } = splitModelsJsonError(error)
  if (!detail.startsWith(MODELS_JSON_PARSE_PREFIX)) return detail
  const lineColumn = JSON_ERROR_LINE_COLUMN.exec(detail)
  if (lineColumn !== null) {
    return `models.json is not valid JSON at line ${String(lineColumn[1])} column ${String(lineColumn[2])}`
  }
  const offset = JSON_ERROR_OFFSET.exec(detail)
  return offset === null
    ? 'models.json is not valid JSON'
    : `models.json is not valid JSON at position ${String(offset[1])}`
}

/**
 * Initialize the runtime and settings. Call once at startup.
 * Returns the models.json error (`describeModelsJsonError`), or undefined on success.
 */
export async function initRegistry(): Promise<string | undefined> {
  const cwd = process.cwd()
  runtime = await ModelRuntime.create()
  settingsManager = SettingsManager.create(cwd)
  const rawError = runtime.getError()
  const loadError = rawError === undefined ? undefined : describeModelsJsonError(rawError)
  if (rawError !== undefined) {
    registryLogger.warn('models.json failed to load; using built-in models only: {error}', {
      error: loadError,
      path: splitModelsJsonError(rawError).path
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

/** Longest credential error line logged at debug. */
const MAX_AUTH_ERROR_LENGTH = 500
/** Longest summary an HTTP response carries, before the status suffix. */
const MAX_AUTH_SUMMARY_LENGTH = 200

/**
 * Pi's credential errors run `<summary>. url=…; body=…; details=…; stack=…`: the body and details
 * quote the token endpoint's response, and the stack names files of the install. The HTTP response
 * gets the summary up to the first of those fields, or the first JSON or array literal for an
 * error worded some other way, plus the upstream status when there is one.
 */
const AUTH_ERROR_DETAIL = /[;\s](?:body|details|stack|response)=|[{[\n]/
const AUTH_ERROR_STATUS = /\bstatus=(\d{3})\b/

function firstLine(message: string): string {
  const [line = message] = message.split('\n')
  return line.slice(0, MAX_AUTH_ERROR_LENGTH)
}

/** A credential error as an HTTP response may carry it: no upstream body, no stack. */
export function summarizeAuthError(message: string): string {
  const [summary = message] = message.split(AUTH_ERROR_DETAIL)
  const trimmed = summary
    .trim()
    .replace(/[;:,]$/, '')
    .slice(0, MAX_AUTH_SUMMARY_LENGTH)
  const status = AUTH_ERROR_STATUS.exec(message)?.[1]
  return status === undefined ? trimmed : `${trimmed} (HTTP ${status})`
}

/** Which credential lookup failed: one for a model's chat request, or a provider's health check. */
interface AuthFailureSource {
  readonly action: 'resolution' | 'verification'
  readonly provider: string
  readonly modelId?: string
}

/**
 * Log a credential failure and return what an HTTP response may carry. The warning names the
 * provider (and model, for a chat request) and the summary; the raw first line, which can quote
 * the token endpoint's response, goes to debug only, like other upstream error text. pi's stack
 * trace goes nowhere.
 */
function reportAuthFailure(source: AuthFailureSource, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const summary = summarizeAuthError(message)
  registryLogger.warn('Credential {action} failed for provider {provider}: {reason}', {
    ...source,
    reason: summary,
    credentialsResolved: false
  })
  registryLogger.debug('Credential {action} error for {provider}: {error}', {
    ...source,
    error: firstLine(message.split('; stack=')[0] ?? message)
  })
  return summary
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
    return {
      ok: false,
      error: reportAuthFailure({ action: 'resolution', provider, modelId }, error)
    }
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

/**
 * Why models.json failed to load, or undefined when it loaded (or there is none). Reduced by
 * `describeModelsJsonError`, so a response or a log line may carry it.
 */
export function getModelsJsonError(): string | undefined {
  const error = getRuntime().getError()
  return error === undefined ? undefined : describeModelsJsonError(error)
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

async function verifyProvider(
  provider: string
): Promise<Pick<ProviderCredentialStatus, 'verified' | 'error'>> {
  try {
    const resolved = await getRuntime().getAuth(provider)
    return resolved === undefined
      ? { verified: false, error: 'no credentials configured' }
      : { verified: true }
  } catch (error) {
    return {
      verified: false,
      error: reportAuthFailure({ action: 'verification', provider }, error)
    }
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

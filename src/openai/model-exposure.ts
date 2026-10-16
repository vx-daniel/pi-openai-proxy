/**
 * Shared model-exposure engine.
 *
 * Computes the exposed model set and public IDs from config + available models.
 * Used by models endpoints, model detail lookup, and chat request model resolution.
 *
 * Public ID modes:
 *   - "collision-prefixed": prefix only providers in conflict groups
 *   - "universal": raw model IDs only; duplicates are a config error
 *   - "always-prefixed": always prefix with <public-prefix>/<model-id>
 *
 * Exposure modes (all modes only expose auth-configured models):
 *   - "all": expose every available model
 *   - "scoped": delegates to pi's global `enabledModels` setting
 *     (the canonical IDs persisted by `/scoped-models` Ctrl+S in pi)
 *   - "custom": same per-model filtering as "scoped" but independently
 *     managed via the proxy's own `customModels` config
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import type { ModelExposureMode, PublicModelIdMode } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'

const exposureLogger = proxyLogger('openai', 'exposure')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExposedModel {
  /** The public ID exposed on the HTTP API. */
  readonly publicId: string
  /** The canonical internal ID: "provider/model-id". */
  readonly canonicalId: string
  /** The underlying pi model. */
  readonly model: Model<Api>
  /** The provider key. */
  readonly provider: string
}

export interface ModelExposureConfig {
  readonly publicModelIdMode: PublicModelIdMode
  readonly modelExposureMode: ModelExposureMode
  /**
   * Canonical model IDs from pi's global `enabledModels` setting.
   * Read from `SettingsManager.getEnabledModels()` at request time.
   * Undefined or empty means no filter (all available models exposed).
   * Used only when modelExposureMode is "scoped".
   */
  readonly enabledModels: readonly string[] | undefined
  readonly customModels: readonly string[]
  readonly providerPrefixes: Readonly<Record<string, string>>
}

export interface ModelExposureResult {
  readonly ok: true
  /** All exposed models with public IDs. */
  readonly models: readonly ExposedModel[]
  /** Public ID -> ExposedModel for O(1) lookup. */
  readonly byPublicId: ReadonlyMap<string, ExposedModel>
  /** Canonical ID -> ExposedModel for backward-compat fallback. */
  readonly byCanonicalId: ReadonlyMap<string, ExposedModel>
}

export interface ModelExposureError {
  readonly ok: false
  readonly message: string
}

export type ModelExposureOutcome = ModelExposureResult | ModelExposureError

// ---------------------------------------------------------------------------
// Exposure filtering
// ---------------------------------------------------------------------------

function filterExposedModels(
  available: readonly Model<Api>[],
  config: ModelExposureConfig
): Model<Api>[] {
  // "all": expose all auth-configured models — same as pi's getAvailable().
  if (config.modelExposureMode === 'all') {
    return [...available]
  }

  // "scoped" delegates to pi's global `enabledModels` setting — the canonical IDs
  // persisted by `/scoped-models` (Ctrl+S) in pi's interactive mode.
  // "custom" uses the same per-model canonical ID filtering, but from the
  // proxy's own `customModels` config instead of pi's settings.
  // When no filter is configured, all available models are exposed.
  const enabled = config.modelExposureMode === 'scoped' ? config.enabledModels : config.customModels
  if (enabled === undefined || enabled.length === 0) {
    exposureLogger.debug('No {modelExposureMode} model filter configured; exposing every model', {
      modelExposureMode: config.modelExposureMode
    })
    return [...available]
  }
  const allowed = new Set(enabled)
  const filtered = available.filter((model) => allowed.has(`${model.provider}/${model.id}`))
  if (filtered.length < allowed.size) {
    exposureLogger.debug(
      '{unmatchedCount} {modelExposureMode} model IDs match no available model',
      () => {
        const availableIds = new Set(available.map((model) => `${model.provider}/${model.id}`))
        const unmatched = [...allowed].filter((canonicalId) => !availableIds.has(canonicalId))
        return {
          modelExposureMode: config.modelExposureMode,
          unmatchedCount: unmatched.length,
          unmatched
        }
      }
    )
  }
  return filtered
}

// ---------------------------------------------------------------------------
// Public ID generation
// ---------------------------------------------------------------------------

/**
 * Get the public prefix label for a provider.
 * Uses the configured override if present, otherwise the provider key itself.
 */
function getPublicPrefix(provider: string, prefixes: Readonly<Record<string, string>>): string {
  const override = prefixes[provider]
  return override !== undefined && override.length > 0 ? override : provider
}

/**
 * Find connected conflict groups: sets of providers that share at least one raw model ID.
 *
 * If provider A and B share a model ID, and B and C share a different model ID,
 * then {A, B, C} form one connected conflict group.
 */
function findConflictGroups(models: readonly Model<Api>[]): Set<string>[] {
  // Map each raw model ID to the set of providers that offer it
  const modelToProviders = new Map<string, Set<string>>()
  for (const model of models) {
    const existing = modelToProviders.get(model.id)
    if (existing === undefined) {
      modelToProviders.set(model.id, new Set([model.provider]))
    } else {
      existing.add(model.provider)
    }
  }

  // Union-Find for providers
  const parent = new Map<string, string>()

  function find(provider: string): string {
    let root = provider
    while (parent.get(root) !== root) {
      const parentProvider = parent.get(root)
      if (parentProvider === undefined) break
      root = parentProvider
    }
    // Path compression
    let current = provider
    while (current !== root) {
      const next = parent.get(current)
      if (next === undefined) break
      parent.set(current, root)
      current = next
    }
    return root
  }

  function union(firstProvider: string, secondProvider: string): void {
    const rootA = find(firstProvider)
    const rootB = find(secondProvider)
    if (rootA !== rootB) {
      parent.set(rootA, rootB)
    }
  }

  // Initialize each provider as its own root
  for (const model of models) {
    if (!parent.has(model.provider)) {
      parent.set(model.provider, model.provider)
    }
  }

  // Union providers that share any model ID
  for (const providers of modelToProviders.values()) {
    if (providers.size <= 1) continue
    const sharingProviders = [...providers]
    const first = sharingProviders[0]
    if (first === undefined) continue
    for (let providerIndex = 1; providerIndex < sharingProviders.length; providerIndex++) {
      const other = sharingProviders[providerIndex]
      if (other !== undefined) {
        union(first, other)
      }
    }
  }

  // Collect groups by root
  const groupsByRoot = new Map<string, Set<string>>()
  for (const provider of parent.keys()) {
    const root = find(provider)
    const existing = groupsByRoot.get(root)
    if (existing === undefined) {
      groupsByRoot.set(root, new Set([provider]))
    } else {
      existing.add(provider)
    }
  }

  // Return only groups with more than one provider (actual conflicts)
  return [...groupsByRoot.values()].filter((group) => group.size > 1)
}

function generateCollisionPrefixedIds(
  models: readonly Model<Api>[],
  prefixes: Readonly<Record<string, string>>
): Map<Model<Api>, string> {
  const conflictGroups = findConflictGroups(models)
  const prefixedProviders = new Set<string>()
  for (const group of conflictGroups) {
    for (const provider of group) {
      prefixedProviders.add(provider)
    }
  }
  if (conflictGroups.length > 0) {
    exposureLogger.debug(
      'Model ID collisions in {conflictGroupCount} provider groups; prefixing {prefixedProviders}',
      () => ({
        conflictGroupCount: conflictGroups.length,
        conflictGroups: conflictGroups.map((group) => [...group]),
        prefixedProviders: [...prefixedProviders]
      })
    )
  }

  const result = new Map<Model<Api>, string>()
  for (const model of models) {
    if (prefixedProviders.has(model.provider)) {
      const prefix = getPublicPrefix(model.provider, prefixes)
      result.set(model, `${prefix}/${model.id}`)
    } else {
      result.set(model, model.id)
    }
  }
  return result
}

function generateUniversalIds(models: readonly Model<Api>[]): Map<Model<Api>, string> | string {
  // Check for duplicates
  const seen = new Map<string, string>()
  for (const model of models) {
    const existing = seen.get(model.id)
    if (existing !== undefined) {
      return (
        `Universal mode conflict: model ID '${model.id}' is provided by both ` +
        `'${existing}' and '${model.provider}'. Use 'collision-prefixed' or ` +
        `'always-prefixed' mode, or reduce the exposed model set.`
      )
    }
    seen.set(model.id, model.provider)
  }

  const result = new Map<Model<Api>, string>()
  for (const model of models) {
    result.set(model, model.id)
  }
  return result
}

function generateAlwaysPrefixedIds(
  models: readonly Model<Api>[],
  prefixes: Readonly<Record<string, string>>
): Map<Model<Api>, string> {
  const result = new Map<Model<Api>, string>()
  for (const model of models) {
    const prefix = getPublicPrefix(model.provider, prefixes)
    result.set(model, `${prefix}/${model.id}`)
  }
  return result
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validatePrefixUniqueness(
  models: readonly Model<Api>[],
  prefixes: Readonly<Record<string, string>>,
  mode: PublicModelIdMode
): string | undefined {
  if (mode === 'universal') return undefined

  // Collect providers that will use prefixes
  const providers = new Set<string>()
  if (mode === 'always-prefixed') {
    for (const model of models) {
      providers.add(model.provider)
    }
  } else {
    // collision-prefixed: only conflicting providers get prefixed
    const conflictGroups = findConflictGroups(models)
    for (const group of conflictGroups) {
      for (const provider of group) {
        providers.add(provider)
      }
    }
  }

  // Check that resolved prefix labels are unique
  const labelToProvider = new Map<string, string>()
  for (const provider of providers) {
    const label = getPublicPrefix(provider, prefixes)
    const existing = labelToProvider.get(label)
    if (existing !== undefined) {
      return (
        `Duplicate prefix label '${label}' used by providers ` +
        `'${existing}' and '${provider}'. Configure distinct providerPrefixes.`
      )
    }
    labelToProvider.set(label, provider)
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the full model-exposure result from config and available models.
 *
 * @param available - Models with auth configured (pi's getAvailable())
 * @param config - Model exposure configuration
 *
 * Call this at startup and whenever config or the model registry changes.
 */
export function computeModelExposure(
  available: readonly Model<Api>[],
  config: ModelExposureConfig
): ModelExposureOutcome {
  // 1. Filter to exposed set
  const exposed = filterExposedModels(available, config)

  // 2. Validate prefix uniqueness (before generating IDs)
  const prefixError = validatePrefixUniqueness(
    exposed,
    config.providerPrefixes,
    config.publicModelIdMode
  )
  if (prefixError !== undefined) {
    exposureLogger.warn('Model exposure configuration error: {message}', {
      message: prefixError,
      publicModelIdMode: config.publicModelIdMode
    })
    return { ok: false, message: prefixError }
  }

  // 3. Generate public IDs based on mode
  let idMap: Map<Model<Api>, string>

  switch (config.publicModelIdMode) {
    case 'collision-prefixed':
      idMap = generateCollisionPrefixedIds(exposed, config.providerPrefixes)
      break

    case 'universal': {
      const result = generateUniversalIds(exposed)
      if (typeof result === 'string') {
        exposureLogger.warn('Model exposure configuration error: {message}', {
          message: result,
          publicModelIdMode: config.publicModelIdMode
        })
        return { ok: false, message: result }
      }
      idMap = result
      break
    }

    case 'always-prefixed':
      idMap = generateAlwaysPrefixedIds(exposed, config.providerPrefixes)
      break
  }

  // 4. Build exposed model objects and lookup maps
  const models: ExposedModel[] = []
  const byPublicId = new Map<string, ExposedModel>()
  const byCanonicalId = new Map<string, ExposedModel>()

  for (const model of exposed) {
    const publicId = idMap.get(model)
    if (publicId === undefined) continue

    const canonicalId = `${model.provider}/${model.id}`
    const entry: ExposedModel = {
      publicId,
      canonicalId,
      model,
      provider: model.provider
    }

    models.push(entry)
    byPublicId.set(publicId, entry)
    byCanonicalId.set(canonicalId, entry)
  }

  exposureLogger.debug(
    'Computed exposure: {exposedCount} of {availableCount} models ({modelExposureMode}, {publicModelIdMode})',
    {
      modelExposureMode: config.modelExposureMode,
      publicModelIdMode: config.publicModelIdMode,
      availableCount: available.length,
      exposedCount: models.length,
      prefixOverrideCount: Object.keys(config.providerPrefixes).length
    }
  )

  return { ok: true, models, byPublicId, byCanonicalId }
}

/**
 * Resolve a model ID from an incoming request against the exposure result.
 *
 * Resolution order:
 *   1. Exact public ID match
 *   2. Exact canonical ID match (backward compat, only if model is exposed)
 */
export function resolveExposedModel(
  exposure: ModelExposureResult,
  requestModelId: string
): ExposedModel | undefined {
  // 1. Try exact public ID
  const byPublic = exposure.byPublicId.get(requestModelId)
  if (byPublic !== undefined) {
    exposureLogger.debug('Resolved public model ID {requestedModel} to {canonicalId}', {
      requestedModel: requestModelId,
      canonicalId: byPublic.canonicalId
    })
    return byPublic
  }

  // 2. Try canonical ID fallback (only for exposed models)
  const byCanonical = exposure.byCanonicalId.get(requestModelId)
  if (byCanonical === undefined) {
    exposureLogger.debug('Model {requestedModel} is not exposed', {
      requestedModel: requestModelId,
      exposedCount: exposure.models.length
    })
  } else {
    exposureLogger.debug('Resolved canonical model ID {requestedModel} (public ID {publicId})', {
      requestedModel: requestModelId,
      publicId: byCanonical.publicId
    })
  }
  return byCanonical
}

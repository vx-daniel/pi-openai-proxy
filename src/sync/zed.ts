/**
 * Zed settings.json model sync.
 *
 * Discovers Zed's settings file, maps exposed proxy models to Zed's
 * openai_compatible available_models shape, and writes them back using
 * jsonc-parser's modify() to preserve comments and formatting.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { proxyLogger } from '@proxy/logging'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import {
  applyEdits,
  type ModificationOptions,
  modify,
  type ParseError,
  parse,
  printParseErrorCode
} from 'jsonc-parser'

const zedLogger = proxyLogger('sync', 'zed')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ZedAvailableModel {
  readonly name: string
  readonly display_name: string
  readonly max_tokens: number
  readonly max_output_tokens: number
  readonly capabilities: {
    readonly tools: boolean
    readonly images: boolean
    readonly parallel_tool_calls: boolean
    readonly prompt_cache_key: boolean
    readonly chat_completions: boolean
  }
}

export interface ZedSyncOptions {
  /** Provider label in Zed settings (e.g. "Pi Proxy"). */
  readonly providerName: string
  /** API URL written into the provider block. */
  readonly apiUrl: string
  /** Preview changes without writing to disk. */
  readonly dryRun: boolean
}

export interface ZedSyncResult {
  readonly ok: boolean
  readonly configPath: string
  readonly added: number
  readonly removed: number
  readonly unchanged: number
  readonly summary: string
  readonly error?: string | undefined
}

// ---------------------------------------------------------------------------
// Settings file discovery
// ---------------------------------------------------------------------------

/**
 * Resolve Zed's global settings.json path.
 *
 * Resolution order:
 * 1. CUSTOM_DATA_DIR env var (Zed's own override)
 * 2. ~/.config/zed/settings.json (macOS + Linux standard)
 * 3. $XDG_CONFIG_HOME/zed/settings.json (Linux XDG)
 */
export function findZedSettings(): string | undefined {
  const candidates: { source: string; settingsPath: string }[] = []

  const customDir = process.env.CUSTOM_DATA_DIR
  if (customDir !== undefined && customDir.length > 0) {
    candidates.push({
      source: 'CUSTOM_DATA_DIR',
      settingsPath: resolve(customDir, 'settings.json')
    })
  }

  const home = process.env.HOME
  if (home !== undefined && home.length > 0) {
    candidates.push({
      source: 'HOME',
      settingsPath: resolve(home, '.config', 'zed', 'settings.json')
    })
  }

  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg !== undefined && xdg.length > 0) {
    candidates.push({
      source: 'XDG_CONFIG_HOME',
      settingsPath: resolve(xdg, 'zed', 'settings.json')
    })
  }

  for (const { source, settingsPath } of candidates) {
    if (existsSync(settingsPath)) {
      zedLogger.debug('Found Zed settings at {settingsPath} (from {source})', {
        settingsPath,
        source
      })
      return settingsPath
    }
    zedLogger.debug('No Zed settings at {settingsPath} (from {source})', { settingsPath, source })
  }

  zedLogger.debug('Zed settings not found after checking {candidateCount} locations', {
    candidateCount: candidates.length
  })
  return undefined
}

// ---------------------------------------------------------------------------
// Model mapping
// ---------------------------------------------------------------------------

/**
 * Map an ExposedModel to Zed's available_models entry.
 */
export function toZedModel(exposed: ExposedModel): ZedAvailableModel {
  const model = exposed.model
  return {
    name: exposed.publicId,
    display_name: model.name,
    max_tokens: model.contextWindow,
    max_output_tokens: model.maxTokens,
    capabilities: {
      tools: true,
      images: model.input.includes('image'),
      parallel_tool_calls: true,
      prompt_cache_key: false,
      chat_completions: true
    }
  }
}

// ---------------------------------------------------------------------------
// JSONC surgical edit
// ---------------------------------------------------------------------------

const MODIFY_OPTIONS: ModificationOptions = {
  isArrayInsertion: false,
  formattingOptions: {
    tabSize: 2,
    insertSpaces: true,
    eol: '\n'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read the current available_models for a provider from Zed settings.
 * Returns the parsed model names, or an empty array if the path does not exist.
 */
function readCurrentModelNames(text: string, providerName: string): string[] {
  const parseErrors: ParseError[] = []
  // Zed accepts trailing commas; allowing them only silences those errors, the parsed value is the same.
  const root: unknown = parse(text, parseErrors, { allowTrailingComma: true })
  if (parseErrors.length > 0) {
    const [firstError] = parseErrors
    zedLogger.warn('Zed settings has {parseErrorCount} JSONC parse errors; reading what parsed', {
      parseErrorCount: parseErrors.length,
      firstErrorCode: firstError === undefined ? undefined : printParseErrorCode(firstError.error),
      firstErrorOffset: firstError?.offset
    })
  }
  if (!isRecord(root)) {
    zedLogger.debug('Zed settings root is not an object; treating as no existing models')
    return []
  }

  const langModels: unknown = root['language_models']
  if (!isRecord(langModels)) return []

  const compat: unknown = langModels['openai_compatible']
  if (!isRecord(compat)) return []

  const provider: unknown = compat[providerName]
  if (!isRecord(provider)) {
    zedLogger.debug('No existing Zed provider block for {providerName}', { providerName })
    return []
  }

  const models: unknown = provider['available_models']
  if (!Array.isArray(models)) {
    zedLogger.debug('Zed provider {providerName} has no available_models array', { providerName })
    return []
  }

  const names: string[] = []
  for (const availableModel of models) {
    if (isRecord(availableModel)) {
      const modelName: unknown = availableModel['name']
      if (typeof modelName === 'string') {
        names.push(modelName)
      }
    }
  }
  return names
}

/**
 * Apply the full provider block (api_url + available_models) to the JSONC text.
 * Returns the new text with edits applied.
 */
function applyProviderBlock(
  text: string,
  providerName: string,
  apiUrl: string,
  models: readonly ZedAvailableModel[]
): string {
  const providerBlock = {
    api_url: apiUrl,
    available_models: models
  }

  const edits = modify(
    text,
    ['language_models', 'openai_compatible', providerName],
    providerBlock,
    MODIFY_OPTIONS
  )

  return applyEdits(text, edits)
}

/** Read the settings file, logging a failure before it propagates. */
function readSettingsText(configPath: string): string {
  try {
    return readFileSync(configPath, 'utf-8')
  } catch (error) {
    zedLogger.error('Failed to read Zed settings {configPath}: {error}', {
      configPath,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

/** Write the settings file, logging a failure before it propagates. */
function writeSettingsText(configPath: string, text: string): void {
  try {
    writeFileSync(configPath, text, 'utf-8')
  } catch (error) {
    zedLogger.error('Failed to write Zed settings {configPath}: {error}', {
      configPath,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

/** How the new model names differ from the ones already in Zed settings. */
function countModelChanges(
  currentNames: ReadonlySet<string>,
  newNames: ReadonlySet<string>
): { added: number; removed: number; unchanged: number } {
  let added = 0
  let removed = 0
  let unchanged = 0

  for (const modelName of newNames) {
    if (currentNames.has(modelName)) {
      unchanged += 1
    } else {
      added += 1
    }
  }
  for (const modelName of currentNames) {
    if (!newNames.has(modelName)) {
      removed += 1
    }
  }
  return { added, removed, unchanged }
}

// ---------------------------------------------------------------------------
// Public sync API
// ---------------------------------------------------------------------------

/**
 * Sync exposed models into Zed's settings.json.
 */
export function syncToZed(
  exposedModels: readonly ExposedModel[],
  options: ZedSyncOptions
): ZedSyncResult {
  const configPath = findZedSettings()
  if (configPath === undefined) {
    zedLogger.warn('Zed sync skipped: settings.json not found')
    return {
      ok: false,
      configPath: '',
      added: 0,
      removed: 0,
      unchanged: 0,
      summary: '',
      error:
        'Zed settings.json not found. Checked ~/.config/zed/settings.json and $XDG_CONFIG_HOME/zed/settings.json'
    }
  }

  const originalText = readSettingsText(configPath)
  const currentNames = new Set(readCurrentModelNames(originalText, options.providerName))
  const zedModels = exposedModels.map(toZedModel)
  const newNames = new Set(zedModels.map((zedModel) => zedModel.name))

  const { added, removed, unchanged } = countModelChanges(currentNames, newNames)

  const parts: string[] = []
  if (added > 0) parts.push(`${String(added)} added`)
  if (removed > 0) parts.push(`${String(removed)} removed`)
  if (unchanged > 0) parts.push(`${String(unchanged)} unchanged`)
  const summary = parts.length > 0 ? parts.join(', ') : 'no changes'

  const outcome = {
    configPath,
    providerName: options.providerName,
    modelCount: zedModels.length,
    added,
    removed,
    unchanged,
    dryRun: options.dryRun
  }

  if (options.dryRun) {
    zedLogger.info('Zed sync dry run for {configPath}: {summary}', { ...outcome, summary })
    return {
      ok: true,
      configPath,
      added,
      removed,
      unchanged,
      summary: `[dry-run] ${summary}`
    }
  }

  const newText = applyProviderBlock(originalText, options.providerName, options.apiUrl, zedModels)
  writeSettingsText(configPath, newText)
  zedLogger.info('Wrote {modelCount} models to Zed settings {configPath}: {summary}', {
    ...outcome,
    summary,
    bytesWritten: Buffer.byteLength(newText, 'utf-8')
  })

  return {
    ok: true,
    configPath,
    added,
    removed,
    unchanged,
    summary
  }
}

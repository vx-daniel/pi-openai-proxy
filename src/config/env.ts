/**
 * Server configuration loading.
 *
 * Priority: CLI args > env vars > JSON config file > defaults.
 *
 * The JSON config file (~/.pi/agent/proxy-config.json) is the shared config
 * written by the pi extension's /proxy config panel. Env vars and CLI args
 * override it for one-off adjustments or container use.
 */

import { getLogLevels, isLogLevel, type LogLevel } from '@logtape/logtape'
import type { ModelExposureMode, PublicModelIdMode } from '@proxy/config/schema'
import { BYTES_PER_MB, loadConfigFromFile, MS_PER_SECOND } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'

const configLogger = proxyLogger('config')

export interface ServerConfig {
  /** Host to bind to. */
  readonly host: string
  /** Port to listen on. */
  readonly port: number
  /** Optional proxy auth bearer token. Undefined = no auth. */
  readonly proxyAuthToken: string | undefined
  /** Whether agentic mode is enabled. */
  readonly agenticEnabled: boolean
  /** Whether remote image URL fetching is enabled. */
  readonly remoteImagesEnabled: boolean
  /** Maximum request body size in bytes. */
  readonly maxBodySize: number
  /** Upstream request timeout in milliseconds. */
  readonly upstreamTimeoutMs: number
  /** How public model IDs are generated. */
  readonly publicModelIdMode: PublicModelIdMode
  /** Which models are exposed. */
  readonly modelExposureMode: ModelExposureMode
  /** Canonical model IDs for "custom" exposure mode. */
  readonly customModels: readonly string[]
  /** Provider key -> custom public prefix label. */
  readonly providerPrefixes: Readonly<Record<string, string>>
  /** Lowest log level written. */
  readonly logLevel: LogLevel
}

/** Env vars `loadConfig` reads. Only their names are logged, never their values. */
const CONFIG_ENV_VARS = [
  'PI_PROXY_HOST',
  'PI_PROXY_PORT',
  'PI_PROXY_AUTH_TOKEN',
  'PI_PROXY_REMOTE_IMAGES',
  'PI_PROXY_MAX_BODY_SIZE',
  'PI_PROXY_UPSTREAM_TIMEOUT_MS',
  'PI_PROXY_AGENTIC',
  'PI_PROXY_LOG_LEVEL'
] as const

/** The env var's level when it names a LogTape level; otherwise the file's. */
function envLogLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  if (raw === undefined) return fallback
  if (isLogLevel(raw)) return raw
  configLogger.warn('Ignoring PI_PROXY_LOG_LEVEL={value}: not one of {levels}; using {fallback}', {
    value: raw,
    levels: getLogLevels(),
    fallback
  })
  return fallback
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    configLogger.warn('Ignoring {name}={value}: not a positive integer; using {fallback}', {
      name,
      value: raw,
      fallback
    })
    return fallback
  }
  return parsed
}

function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  if (raw !== 'true' && raw !== 'false') {
    configLogger.warn('{name}={value} is not "true" or "false"; treating it as false', {
      name,
      value: raw
    })
  }
  return raw === 'true'
}

export interface CliOverrides {
  host?: string | undefined
  port?: number | undefined
  authToken?: string | undefined
  remoteImages?: boolean | undefined
  maxBodySizeMb?: number | undefined
  upstreamTimeoutSec?: number | undefined
  logLevel?: LogLevel | undefined
}

/**
 * Load config with priority: CLI args > env vars > JSON file > defaults.
 */
export function loadConfig(cli: CliOverrides = {}): ServerConfig {
  const file = loadConfigFromFile()

  configLogger.debug('Config overrides: CLI {cliOverrides}, env {envOverrides}', {
    cliOverrides: Object.entries(cli)
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name),
    envOverrides: CONFIG_ENV_VARS.filter((envVar) => process.env[envVar] !== undefined)
  })

  const host = cli.host ?? process.env.PI_PROXY_HOST ?? file.host
  const port = cli.port ?? parsePositiveInt('PI_PROXY_PORT', process.env.PI_PROXY_PORT, file.port)

  // Auth token: CLI > env > file (empty string in file = disabled)
  const fileToken = file.authToken.length > 0 ? file.authToken : undefined
  const proxyAuthToken = cli.authToken ?? process.env.PI_PROXY_AUTH_TOKEN ?? fileToken

  const remoteImagesEnabled =
    cli.remoteImages ??
    parseBoolean('PI_PROXY_REMOTE_IMAGES', process.env.PI_PROXY_REMOTE_IMAGES, file.remoteImages)

  const maxBodySize =
    cli.maxBodySizeMb === undefined
      ? parsePositiveInt(
          'PI_PROXY_MAX_BODY_SIZE',
          process.env.PI_PROXY_MAX_BODY_SIZE,
          file.maxBodySizeMb * BYTES_PER_MB
        )
      : cli.maxBodySizeMb * BYTES_PER_MB

  const upstreamTimeoutMs =
    cli.upstreamTimeoutSec === undefined
      ? parsePositiveInt(
          'PI_PROXY_UPSTREAM_TIMEOUT_MS',
          process.env.PI_PROXY_UPSTREAM_TIMEOUT_MS,
          file.upstreamTimeoutSec * MS_PER_SECOND
        )
      : cli.upstreamTimeoutSec * MS_PER_SECOND

  const agenticEnabled = process.env.PI_PROXY_AGENTIC === 'true'

  return {
    host,
    port,
    proxyAuthToken,
    agenticEnabled,
    remoteImagesEnabled,
    maxBodySize,
    upstreamTimeoutMs,
    publicModelIdMode: file.publicModelIdMode,
    modelExposureMode: file.modelExposureMode,
    customModels: file.customModels,
    providerPrefixes: file.providerPrefixes,
    logLevel: cli.logLevel ?? envLogLevel(process.env.PI_PROXY_LOG_LEVEL, file.logLevel)
  }
}

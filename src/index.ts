/**
 * pi-openai-proxy entry point.
 *
 * Proper CLI with citty: args, help, version.
 * Config priority: CLI args > env vars > JSON config file > defaults.
 */

import { serve } from '@hono/node-server'
import { getLogLevels, isLogLevel, type LogLevel } from '@logtape/logtape'
import { type CliOverrides, loadConfig, type ServerConfig } from '@proxy/config/env'
import { getConfigPath, loadConfigFromFile } from '@proxy/config/schema'
import {
  configureLogging,
  isLogFormat,
  LOG_FORMATS,
  proxyLogger,
  resolveLogFormat
} from '@proxy/logging'
import { getAvailableModels, initRegistry } from '@proxy/pi/registry'
import { createApp } from '@proxy/server/app'
import { defineCommand, runMain } from 'citty'

const lifecycleLogger = proxyLogger('server')

const JSON_INDENT = 2
const MASKED_TOKEN = '***'

/** Whether a bind address only accepts connections from this machine. */
function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

/** Parse a CLI integer argument; returns undefined unless it is a positive finite integer. */
function parsePositiveIntArg(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  lifecycleLogger.warn('Ignoring --{name}={value}: not a positive integer', { name, value })
  return undefined
}

interface CliArgs {
  'host'?: string | undefined
  'port'?: string | undefined
  'auth-token'?: string | undefined
  'remote-images'?: boolean | undefined
  'max-body-size'?: string | undefined
  'upstream-timeout'?: string | undefined
  'log-level'?: string | undefined
  'log-format'?: string | undefined
}

/** Why a logging flag is unusable, or undefined. A typo fails the start, never a stack trace. */
function invalidLoggingFlag(args: CliArgs): string | undefined {
  const level = args['log-level']
  if (level !== undefined && !isLogLevel(level)) {
    return `--log-level must be one of: ${getLogLevels().join(', ')}`
  }
  const format = args['log-format']
  if (format !== undefined && !isLogFormat(format)) {
    return `--log-format must be one of: ${LOG_FORMATS.join(', ')}`
  }
  return undefined
}

/** Build CLI overrides from parsed args. */
function buildCliOverrides(args: CliArgs): CliOverrides {
  const cli: CliOverrides = {}
  if (args.host !== undefined) {
    cli.host = args.host
  }
  const port = parsePositiveIntArg('port', args.port)
  if (port !== undefined) cli.port = port
  if (args['auth-token'] !== undefined) {
    cli.authToken = args['auth-token']
  }
  if (args['remote-images'] !== undefined) {
    cli.remoteImages = args['remote-images']
  }
  const mb = parsePositiveIntArg('max-body-size', args['max-body-size'])
  if (mb !== undefined) cli.maxBodySizeMb = mb
  const sec = parsePositiveIntArg('upstream-timeout', args['upstream-timeout'])
  if (sec !== undefined) cli.upstreamTimeoutSec = sec
  const logLevel = args['log-level']
  if (logLevel !== undefined && isLogLevel(logLevel)) cli.logLevel = logLevel
  return cli
}

/**
 * Configure logging, then load the config. Config loading logs too, so logging is configured first
 * with the level the CLI or env asks for, then again with the fully resolved level (which may come
 * from the config file). Undefined, with exit code 1, when a logging flag is unusable.
 */
function loadConfigWithLogging(args: CliArgs): ServerConfig | undefined {
  const invalidFlag = invalidLoggingFlag(args)
  if (invalidFlag !== undefined) {
    process.stderr.write(`${invalidFlag}\n`)
    process.exitCode = 1
    return undefined
  }

  const format = resolveLogFormat(args['log-format'], process.env.PI_PROXY_LOG_FORMAT)
  const earlyLogLevel =
    [args['log-level'], process.env.PI_PROXY_LOG_LEVEL].find(
      (candidate): candidate is LogLevel => candidate !== undefined && isLogLevel(candidate)
    ) ?? 'info'
  configureLogging({ level: earlyLogLevel, format })

  const config = loadConfig(buildCliOverrides(args))
  configureLogging({ level: config.logLevel, format })
  const envFormat = process.env.PI_PROXY_LOG_FORMAT
  if (envFormat !== undefined && !isLogFormat(envFormat)) {
    lifecycleLogger.warn('Ignoring PI_PROXY_LOG_FORMAT={value}: not one of {formats}', {
      value: envFormat,
      formats: LOG_FORMATS
    })
  }
  lifecycleLogger.debug('Logging at {level} as {format}', { level: config.logLevel, format })
  return config
}

const main = defineCommand({
  meta: {
    name: 'pi-openai-proxy',
    description: "OpenAI-compatible HTTP proxy for pi's multi-provider model registry"
  },
  args: {
    'host': {
      type: 'string',
      description: 'Bind address (default: from config or 127.0.0.1)'
    },
    'port': {
      type: 'string',
      description: 'Listen port (default: from config or 4141)'
    },
    'auth-token': {
      type: 'string',
      description: 'Bearer token for proxy authentication'
    },
    'remote-images': {
      type: 'boolean',
      description: 'Enable remote image URL fetching'
    },
    'max-body-size': {
      type: 'string',
      description: 'Maximum request body size in MB (default: 50)'
    },
    'upstream-timeout': {
      type: 'string',
      description:
        'Seconds the upstream provider may send nothing before a call is aborted (default: 120)'
    },
    'log-level': {
      type: 'string',
      description: `Lowest log level written: ${getLogLevels().join(', ')} (default: from config or info)`
    },
    'log-format': {
      type: 'string',
      description: `Log output: ${LOG_FORMATS.join(', ')} (default: pretty on a terminal, json otherwise)`
    },
    'config': {
      type: 'boolean',
      description: 'Show effective configuration and exit'
    }
  },
  run: async ({ args }) => {
    // --config: show effective config and exit. Command output, not a log line, so it goes to stdout,
    // where it is easily piped or captured: the auth token is masked.
    if (args.config === true) {
      const file = loadConfigFromFile()
      const shown = { ...file, authToken: file.authToken.length > 0 ? MASKED_TOKEN : '' }
      process.stdout.write(`Config file: ${getConfigPath()}\n`)
      process.stdout.write(`${JSON.stringify(shown, null, JSON_INDENT)}\n`)
      return
    }

    const config = loadConfigWithLogging(args)
    if (config === undefined) return

    // Never the auth token itself: only whether proxy auth is on.
    lifecycleLogger.debug('Effective config', {
      configPath: getConfigPath(),
      host: config.host,
      port: config.port,
      proxyAuthEnabled: config.proxyAuthToken !== undefined,
      agenticEnabled: config.agenticEnabled,
      remoteImagesEnabled: config.remoteImagesEnabled,
      maxBodySize: config.maxBodySize,
      upstreamTimeoutMs: config.upstreamTimeoutMs,
      publicModelIdMode: config.publicModelIdMode,
      modelExposureMode: config.modelExposureMode,
      customModelCount: config.customModels.length,
      providerPrefixCount: Object.keys(config.providerPrefixes).length,
      logLevel: config.logLevel
    })
    if (config.proxyAuthToken === undefined) {
      // Off-loopback without auth is an exposure worth seeing at the default level.
      if (isLoopbackHost(config.host)) {
        lifecycleLogger.debug(
          'Proxy auth is disabled: /v1 endpoints accept unauthenticated requests'
        )
      } else {
        lifecycleLogger.warn(
          'Proxy auth is disabled and the proxy listens on {host}: any client that can reach it can use your provider credentials',
          { host: config.host }
        )
      }
    }

    // Initialize pi integration; initRegistry logs a models.json load failure itself.
    await initRegistry()

    const models = getAvailableModels()
    const app = createApp(config)

    lifecycleLogger.info('Listening on http://{host}:{port} with {modelCount} models', {
      host: config.host,
      port: config.port,
      modelCount: models.length,
      logLevel: config.logLevel
    })

    // --- Graceful shutdown ---
    let shutdownInitiated = false

    function handleShutdown(signal: string): void {
      if (shutdownInitiated) return
      shutdownInitiated = true

      lifecycleLogger.info('Received {signal}, shutting down', { signal })

      const SHUTDOWN_TIMEOUT_MS = 10_000

      server.close()

      setTimeout(() => {
        lifecycleLogger.warn('Shutdown timed out after {timeoutMs} ms; forcing exit', {
          timeoutMs: SHUTDOWN_TIMEOUT_MS
        })
        process.exit(1)
      }, SHUTDOWN_TIMEOUT_MS).unref()
    }

    process.on('SIGTERM', () => handleShutdown('SIGTERM'))
    process.on('SIGINT', () => handleShutdown('SIGINT'))

    const server = serve({
      fetch: app.fetch,
      port: config.port,
      hostname: config.host
    })
  }
})

void runMain(main)

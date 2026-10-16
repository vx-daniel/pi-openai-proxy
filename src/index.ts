/**
 * pi-openai-proxy entry point.
 *
 * Proper CLI with citty: args, help, version.
 * Config priority: CLI args > env vars > JSON config file > defaults.
 */

import { serve } from '@hono/node-server'
import { getLogLevels, isLogLevel } from '@logtape/logtape'
import { type CliOverrides, loadConfig } from '@proxy/config/env'
import { getConfigPath, loadConfigFromFile } from '@proxy/config/schema'
import { configureLogging, defaultLogFormat, proxyLogger } from '@proxy/logging'
import { getAvailableModels, initRegistry } from '@proxy/pi/registry'
import { createApp } from '@proxy/server/app'
import { defineCommand, runMain } from 'citty'

const lifecycleLogger = proxyLogger('server')

const JSON_INDENT = 2

/** Parse a CLI integer argument; returns undefined unless it is a positive finite integer. */
function parsePositiveIntArg(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

interface CliArgs {
  'host'?: string | undefined
  'port'?: string | undefined
  'auth-token'?: string | undefined
  'remote-images'?: boolean | undefined
  'max-body-size'?: string | undefined
  'upstream-timeout'?: string | undefined
  'log-level'?: string | undefined
}

/** Build CLI overrides from parsed args. */
function buildCliOverrides(args: CliArgs): CliOverrides {
  const cli: CliOverrides = {}
  if (args.host !== undefined) {
    cli.host = args.host
  }
  const port = parsePositiveIntArg(args.port)
  if (port !== undefined) cli.port = port
  if (args['auth-token'] !== undefined) {
    cli.authToken = args['auth-token']
  }
  if (args['remote-images'] !== undefined) {
    cli.remoteImages = args['remote-images']
  }
  const mb = parsePositiveIntArg(args['max-body-size'])
  if (mb !== undefined) cli.maxBodySizeMb = mb
  const sec = parsePositiveIntArg(args['upstream-timeout'])
  if (sec !== undefined) cli.upstreamTimeoutSec = sec
  const logLevel = args['log-level']
  if (logLevel !== undefined) {
    if (!isLogLevel(logLevel)) {
      throw new Error(`--log-level must be one of: ${getLogLevels().join(', ')}`)
    }
    cli.logLevel = logLevel
  }
  return cli
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
      description: 'Upstream timeout in seconds (default: 120)'
    },
    'log-level': {
      type: 'string',
      description: `Lowest log level written: ${getLogLevels().join(', ')} (default: from config or info)`
    },
    'config': {
      type: 'boolean',
      description: 'Show effective configuration and exit'
    }
  },
  run: async ({ args }) => {
    // --config: show effective config and exit. Command output, not a log line, so it goes to stdout.
    if (args.config === true) {
      const file = loadConfigFromFile()
      process.stdout.write(`Config file: ${getConfigPath()}\n`)
      process.stdout.write(`${JSON.stringify(file, null, JSON_INDENT)}\n`)
      return
    }

    const config = loadConfig(buildCliOverrides(args))
    configureLogging({ level: config.logLevel, format: defaultLogFormat() })

    // Initialize pi integration
    const loadError = await initRegistry()
    if (loadError !== undefined) {
      lifecycleLogger.warn('models.json failed to load; continuing with built-in models only', {
        error: loadError
      })
    }

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

/**
 * Pi extension: /proxy command family with config panel.
 *
 * Command family:
 *   /proxy            Open settings panel
 *   /proxy start      Start the proxy server
 *   /proxy stop       Stop the proxy server
 *   /proxy status     Show proxy status
 *   /proxy verify     Validate model exposure config against available models
 *   /proxy models     List all exposed models with their public IDs
 *   /proxy zed-sync   Sync exposed models to Zed settings.json (--dry-run)
 *   /proxy config     Open settings panel (alias)
 *   /proxy show       Summarize current config and exposure policy
 *   /proxy path       Show config file location
 *   /proxy reset      Restore default settings
 *   /proxy help       Usage line
 *
 * Config schema imported from @vx-daniel/pi-openai-proxy/config (SSOT).
 * Model-exposure engine imported from @vx-daniel/pi-openai-proxy/exposure.
 *
 * pi loads this directory as one extension through its index.ts; the sibling modules are
 * imported here and are not discovered as separate extensions.
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import {
  DEFAULT_CONFIG,
  getConfigPath,
  loadConfigFromFile,
  saveConfigToFile
} from '@vx-daniel/pi-openai-proxy/config'
import { configureFileLogging, proxyLogger } from '@vx-daniel/pi-openai-proxy/logging'

import {
  refreshStatus,
  restartProxy,
  showStatus,
  startProxy,
  stopProxy,
  stopSessionProcess
} from './process'
import { showConfig, showModels, verifyExposure } from './reports'
import { openSettingsPanel } from './settings-panel'
import { createProxyState, type ProxyState, useModelRegistry } from './state'
import { handleZedSync, maybeAutoSyncZed } from './zed-sync'

const SUBCOMMANDS = [
  'start',
  'stop',
  'restart',
  'status',
  'verify',
  'models',
  'zed-sync',
  'config',
  'show',
  'path',
  'reset',
  'help'
]
const extensionLogger = proxyLogger('extension')

const USAGE =
  '/proxy [start|stop|restart|status|verify|models|zed-sync|config|show|path|reset|help]'

type SubcommandHandler = (
  state: ProxyState,
  context: ExtensionCommandContext,
  args: string
) => Promise<void> | void

/** Subcommands other than the settings panel (`""` and `config`). */
const SUBCOMMAND_HANDLERS: Record<string, SubcommandHandler> = {
  'start': startProxy,
  'stop': stopProxy,
  'restart': restartProxy,
  'status': showStatus,
  'verify': verifyExposure,
  'models': showModels,
  'zed-sync': handleZedSync,
  'show': showConfig,
  'path': (_state, context) => {
    context.ui.notify(getConfigPath(), 'info')
  },
  'reset': (state, context) => {
    state.config = { ...DEFAULT_CONFIG }
    saveConfigToFile(state.config)
    extensionLogger.info('Proxy settings reset to defaults and saved to {configPath}', {
      configPath: getConfigPath()
    })
    context.ui.notify('Proxy settings reset to defaults', 'info')
  },
  'help': (_state, context) => {
    context.ui.notify(USAGE, 'info')
  }
}

async function openSettingsPanelIfInteractive(
  state: ProxyState,
  context: ExtensionCommandContext
): Promise<void> {
  if (!context.hasUI) {
    extensionLogger.warn('Settings panel requested without an interactive UI')
    context.ui.notify('/proxy requires interactive mode. Use /proxy show instead.', 'warning')
    return
  }
  await openSettingsPanel(state, context)
}

export default function proxyExtension(pi: ExtensionAPI): void {
  // Opt-in logging: the extension writes nothing unless PI_PROXY_EXTENSION_LOG_FILE names a file,
  // because console output would corrupt pi's terminal UI.
  const logFile = process.env.PI_PROXY_EXTENSION_LOG_FILE
  if (logFile !== undefined && logFile.length > 0) {
    const level = loadConfigFromFile().logLevel
    configureFileLogging(logFile, level)
    extensionLogger.info('Extension file logging enabled at level {level}', { level, logFile })
  }

  // This file lives at <package root>/extensions/proxy/index.ts.
  const extensionDir = dirname(fileURLToPath(import.meta.url))
  const state = createProxyState(resolve(extensionDir, '..', '..'))

  // --- Lifecycle ---

  pi.on('session_start', async (_event, context) => {
    extensionLogger.info('Session started; loading config from {configPath}', {
      configPath: getConfigPath()
    })
    await useModelRegistry(state, context)
    state.config = loadConfigFromFile()
    extensionLogger.debug(
      'Config loaded: lifetime {lifetime}, {host}:{port}, exposure {exposure}',
      {
        lifetime: state.config.lifetime,
        host: state.config.host,
        port: state.config.port,
        exposure: state.config.modelExposureMode,
        logLevel: state.config.logLevel
      }
    )
    await maybeAutoSyncZed(state, context)
    await refreshStatus(state, context)
  })

  pi.on('session_shutdown', async () => {
    extensionLogger.info('Session shutting down')
    stopSessionProcess(state)
  })

  // --- Command family ---

  pi.registerCommand('proxy', {
    description: 'Manage the OpenAI-compatible proxy',
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart()
      const matches = SUBCOMMANDS.filter((subcommand) => subcommand.startsWith(trimmed))
      return matches.length > 0
        ? matches.map((subcommand) => ({ value: subcommand, label: subcommand }))
        : null
    },
    handler: async (args, context) => {
      await useModelRegistry(state, context)
      const sub = args.trim().split(/\s+/)[0] ?? ''
      extensionLogger.debug('Dispatching /proxy subcommand {subcommand}', {
        subcommand: sub === '' ? '(panel)' : sub
      })

      if (sub === '' || sub === 'config') {
        await openSettingsPanelIfInteractive(state, context)
        return
      }
      const run = Object.hasOwn(SUBCOMMAND_HANDLERS, sub) ? SUBCOMMAND_HANDLERS[sub] : undefined
      if (run === undefined) {
        extensionLogger.warn('Unknown /proxy subcommand {subcommand}', { subcommand: sub })
        context.ui.notify(USAGE, 'warning')
        return
      }
      await run(state, context, args)
    }
  })
}

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
 * Config schema imported from @victor-software-house/pi-openai-proxy/config (SSOT).
 * Model-exposure engine imported from @victor-software-house/pi-openai-proxy/exposure.
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
} from '@victor-software-house/pi-openai-proxy/config'

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
const USAGE =
  '/proxy [start|stop|restart|status|verify|models|zed-sync|config|show|path|reset|help]'

type SubcommandHandler = (
  state: ProxyState,
  ctx: ExtensionCommandContext,
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
  'path': (_state, ctx) => {
    ctx.ui.notify(getConfigPath(), 'info')
  },
  'reset': (state, ctx) => {
    state.config = { ...DEFAULT_CONFIG }
    saveConfigToFile(state.config)
    ctx.ui.notify('Proxy settings reset to defaults', 'info')
  },
  'help': (_state, ctx) => {
    ctx.ui.notify(USAGE, 'info')
  }
}

async function openSettingsPanelIfInteractive(
  state: ProxyState,
  ctx: ExtensionCommandContext
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify('/proxy requires interactive mode. Use /proxy show instead.', 'warning')
    return
  }
  await openSettingsPanel(state, ctx)
}

export default function proxyExtension(pi: ExtensionAPI): void {
  // This file lives at <package root>/extensions/proxy/index.ts.
  const extensionDir = dirname(fileURLToPath(import.meta.url))
  const state = createProxyState(resolve(extensionDir, '..', '..'))

  // --- Lifecycle ---

  pi.on('session_start', async (_event, ctx) => {
    await useModelRegistry(state, ctx)
    state.config = loadConfigFromFile()
    await maybeAutoSyncZed(state, ctx)
    await refreshStatus(state, ctx)
  })

  pi.on('session_shutdown', async () => {
    stopSessionProcess(state)
  })

  // --- Command family ---

  pi.registerCommand('proxy', {
    description: 'Manage the OpenAI-compatible proxy',
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart()
      const matches = SUBCOMMANDS.filter((s) => s.startsWith(trimmed))
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null
    },
    handler: async (args, ctx) => {
      await useModelRegistry(state, ctx)
      const sub = args.trim().split(/\s+/)[0] ?? ''

      if (sub === '' || sub === 'config') {
        await openSettingsPanelIfInteractive(state, ctx)
        return
      }
      const run = Object.hasOwn(SUBCOMMAND_HANDLERS, sub) ? SUBCOMMAND_HANDLERS[sub] : undefined
      if (run === undefined) {
        ctx.ui.notify(USAGE, 'warning')
        return
      }
      await run(state, ctx, args)
    }
  })
}

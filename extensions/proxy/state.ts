/**
 * Shared mutable state for the /proxy extension, plus model registry access.
 */

import type { ChildProcess } from 'node:child_process'

import type { Api, Model } from '@earendil-works/pi-ai'
import {
  type ExtensionContext,
  type ModelRegistry,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import { loadConfigFromFile, type ProxyConfig } from '@vx-daniel/pi-openai-proxy/config'
import type { ModelExposureConfig } from '@vx-daniel/pi-openai-proxy/exposure'

export interface ProxyState {
  config: ProxyConfig
  sessionProcess: ChildProcess | undefined
  modelRegistry: ModelRegistry | undefined
  readonly settingsManager: SettingsManager
  /** Package root: the directory holding package.json, dist/, and extensions/. */
  readonly packageRoot: string
}

export function createProxyState(packageRoot: string): ProxyState {
  return {
    config: loadConfigFromFile(),
    sessionProcess: undefined,
    modelRegistry: undefined,
    settingsManager: SettingsManager.create(process.cwd()),
    packageRoot
  }
}

// Pi 1.x no longer lets an extension build its own registry (`AuthStorage` and
// `ModelRegistry.create()` are gone). Every entry point here starts from a handler that has a
// context, so each one calls useModelRegistry() first. It also refreshes the registry (from
// models.json and stored credentials, no network), because the old code refreshed before every
// read and a model list taken at session start would miss a later `/login`.
export async function useModelRegistry(
  state: ProxyState,
  context: ExtensionContext
): Promise<void> {
  state.modelRegistry = context.modelRegistry
  await state.modelRegistry.refresh({ allowNetwork: false })
}

export function getAvailableModels(state: ProxyState): Model<Api>[] {
  if (state.modelRegistry === undefined) {
    throw new Error('The model registry is only available once a session has started.')
  }
  return state.modelRegistry.getAvailable()
}

export async function getEnabledModels(state: ProxyState): Promise<readonly string[] | undefined> {
  await state.settingsManager.reload()
  return state.settingsManager.getEnabledModels()
}

export async function buildExposureConfig(state: ProxyState): Promise<ModelExposureConfig> {
  return {
    publicModelIdMode: state.config.publicModelIdMode,
    modelExposureMode: state.config.modelExposureMode,
    enabledModels: await getEnabledModels(state),
    customModels: state.config.customModels,
    providerPrefixes: state.config.providerPrefixes
  }
}

export function proxyUrl(config: ProxyConfig): string {
  return `http://${config.host}:${String(config.port)}`
}

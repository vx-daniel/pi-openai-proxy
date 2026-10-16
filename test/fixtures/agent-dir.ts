/**
 * A throwaway pi agent directory for a test: pi reads `models.json` and `auth.json` from it, so a
 * test decides exactly which providers, models and credentials exist, with no real login.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initRegistry } from '@proxy/pi/registry'
import { vi } from 'vite-plus/test'

export interface FixtureAgentDirFiles {
  /** Written as JSON. */
  readonly modelsJson?: unknown
  /** Written as is, for a models.json that is deliberately broken. Wins over `modelsJson`. */
  readonly modelsJsonText?: string
  /** Written as JSON, owner-only, as pi expects. */
  readonly authJson?: unknown
}

export interface FixtureAgentDir {
  readonly path: string
  /** Delete the directory. The `PI_CODING_AGENT_DIR` stub is undone by `vi.unstubAllEnvs()`. */
  remove(): void
}

const OWNER_ONLY = 0o600

/** A base URL nothing listens on: a request that reaches it fails at once, on this machine. */
const UNREACHABLE_BASE_URL = 'http://127.0.0.1:9/v1'

/**
 * A `models.json` provider entry with a literal fake key and these models, at an address nothing
 * listens on: for tests whose requests are answered (or refused) before any upstream call.
 * A model is a bare ID, or an object for extra fields such as `input: ['text', 'image']`.
 */
export function offlineProvider(
  ...models: (string | { readonly id: string; readonly [field: string]: unknown })[]
): Record<string, unknown> {
  return {
    baseUrl: UNREACHABLE_BASE_URL,
    api: 'openai-completions',
    apiKey: 'notarealsecret-fixture-provider-key',
    models: models.map((model) => (typeof model === 'string' ? { id: model } : model))
  }
}

/**
 * Write the files into a new temp directory, point pi at it (`PI_CODING_AGENT_DIR`) and load pi's
 * model runtime from it.
 */
export async function loadFixtureAgentDir(
  files: FixtureAgentDirFiles = {}
): Promise<FixtureAgentDir> {
  const path = mkdtempSync(join(tmpdir(), 'pi-proxy-fixture-'))
  const modelsJson =
    files.modelsJsonText ??
    (files.modelsJson === undefined ? undefined : JSON.stringify(files.modelsJson))
  if (modelsJson !== undefined) writeFileSync(join(path, 'models.json'), modelsJson)
  if (files.authJson !== undefined) {
    writeFileSync(join(path, 'auth.json'), JSON.stringify(files.authJson), { mode: OWNER_ONLY })
  }
  vi.stubEnv('PI_CODING_AGENT_DIR', path)
  await initRegistry()
  return {
    path,
    remove() {
      rmSync(path, { recursive: true, force: true })
    }
  }
}

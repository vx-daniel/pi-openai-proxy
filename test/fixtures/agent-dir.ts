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

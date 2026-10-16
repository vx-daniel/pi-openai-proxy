/**
 * Runs before every unit and integration test file (the `offline` project in vite.config.ts).
 *
 * No offline test may see the developer's pi login or provider credentials: they make results
 * depend on whose machine runs them, and a test that resolves a real OAuth credential can refresh
 * it, which rotates the refresh token under every other copy of that login. So each file starts
 * with pi pointed at an empty agent directory and with every credential-shaped environment
 * variable removed. A test that needs models loads them with `loadFixtureAgentDir`
 * (`test/fixtures/agent-dir.ts`); `test/conformance` (the `live` project) is the only place that
 * uses a real login.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll } from 'vite-plus/test'

/** pi reads provider credentials from variables named like these (`ANTHROPIC_API_KEY`, …). */
const CREDENTIAL_VARIABLE = /(?:_API_KEY|_TOKEN|_ACCESS_KEY|_ACCESS_KEY_ID|_SECRET_ACCESS_KEY)$/

// Removed for good, not stubbed: `vi.unstubAllEnvs()` in a test would put a stubbed one back.
for (const variableName of Object.keys(process.env)) {
  if (CREDENTIAL_VARIABLE.test(variableName)) Reflect.deleteProperty(process.env, variableName)
}

const emptyAgentDir = mkdtempSync(join(tmpdir(), 'pi-proxy-offline-'))
process.env.PI_CODING_AGENT_DIR = emptyAgentDir

afterAll(() => {
  rmSync(emptyAgentDir, { recursive: true, force: true })
})

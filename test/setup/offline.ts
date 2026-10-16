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

/**
 * What pi reads credentials from (`pi-ai/dist/env-api-keys.js`): `<PROVIDER>_API_KEY` and
 * `*_TOKEN` variables, plus ambient cloud credentials that are not key-shaped. Amazon Bedrock
 * counts as configured from `AWS_PROFILE`, `AWS_BEARER_TOKEN_BEDROCK`, container or web-identity
 * variables; Vertex from `GOOGLE_APPLICATION_CREDENTIALS` (or the gcloud ADC file) plus
 * `GOOGLE_CLOUD_PROJECT`/`GCLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`; Anthropic federation from
 * `ANTHROPIC_*`. Whole prefixes go, so a variable pi adds later in those families goes too.
 * `test/unit/offline-isolation.test.ts` fails if any provider still counts as configured.
 */
const CREDENTIAL_VARIABLE =
  /(?:_API_KEY|_TOKEN|_ACCESS_KEY|_ACCESS_KEY_ID|_SECRET_ACCESS_KEY)$|^(?:ANTHROPIC|AWS|AZURE|GOOGLE|GCLOUD|CLOUDSDK)_/

// Removed for good, not stubbed: `vi.unstubAllEnvs()` in a test would put a stubbed one back.
for (const variableName of Object.keys(process.env)) {
  if (CREDENTIAL_VARIABLE.test(variableName)) Reflect.deleteProperty(process.env, variableName)
}

const emptyAgentDir = mkdtempSync(join(tmpdir(), 'pi-proxy-offline-'))
process.env.PI_CODING_AGENT_DIR = emptyAgentDir

afterAll(() => {
  rmSync(emptyAgentDir, { recursive: true, force: true })
})

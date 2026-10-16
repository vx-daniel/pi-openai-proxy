/**
 * What `test/setup/offline.ts` promises every offline test: pi sees no login and no provider
 * credential, whatever the developer's machine has (`~/.pi/agent/auth.json`, `ANTHROPIC_API_KEY`,
 * `AWS_PROFILE`, gcloud ADC, …).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { getAvailableModels, getRuntime, initRegistry } from '@proxy/pi/registry'
import { beforeAll, describe, expect, test } from 'vite-plus/test'

beforeAll(async () => {
  await initRegistry()
})

describe('offline test isolation', () => {
  // Catches the setup no longer pointing pi away from the developer's own agent dir.
  test("pi does not read the developer's agent dir", () => {
    expect(getAgentDir()).not.toBe(join(homedir(), '.pi', 'agent'))
  })

  // Catches a credential source the setup does not remove (a new pi env var, an ambient cloud
  // login): on a machine that has one, the provider shows up here and this fails.
  test('no provider counts as configured, and no model is available', () => {
    const runtime = getRuntime()
    const configured = runtime
      .getProviders()
      .filter((provider) => runtime.hasConfiguredAuth(provider.id))
      .map((provider) => provider.id)

    expect(configured).toEqual([])
    expect(getAvailableModels()).toEqual([])
  })
})

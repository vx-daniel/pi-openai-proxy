/**
 * Model exposure configurations through the HTTP routes, against fixture providers `alpha`
 * (`a1`, `a2`) and `beta` (`b1`), whose model IDs do not collide. Each mode's exact public ID list
 * is known, so each test asserts the list itself.
 */

import type { ServerConfig } from '@proxy/config/env'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir, offlineProvider } from '../fixtures/agent-dir'
import { isErrorBody, isModelListBody, jsonBody, present, testApp, testConfig } from '../helpers'

let agentDir: FixtureAgentDir

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir({
    modelsJson: { providers: { alpha: offlineProvider('a1', 'a2'), beta: offlineProvider('b1') } }
  })
})

afterAll(() => {
  vi.unstubAllEnvs()
  agentDir.remove()
})

/** The public model IDs `GET /v1/models` lists under this config, sorted. */
async function listedIds(overrides: Partial<ServerConfig>): Promise<string[]> {
  const response = await testApp({ ...testConfig(), ...overrides }).request('/v1/models')
  expect(response.status).toBe(200)
  const body = await jsonBody(response)
  expect(isModelListBody(body)).toBe(true)
  return (isModelListBody(body) ? body.data : []).map((model) => model.id).toSorted()
}

describe('publicModelIdMode through HTTP', () => {
  test('always-prefixed lists every model as provider/model', async () => {
    expect(await listedIds({ publicModelIdMode: 'always-prefixed' })).toEqual([
      'alpha/a1',
      'alpha/a2',
      'beta/b1'
    ])
  })

  // Catches a prefix applied where no model ID collides.
  test('collision-prefixed lists bare IDs when nothing collides', async () => {
    expect(await listedIds({ publicModelIdMode: 'collision-prefixed' })).toEqual(['a1', 'a2', 'b1'])
  })
})

describe('modelExposureMode through HTTP', () => {
  // Catches the custom allowlist being ignored, or matched on anything but the canonical ID.
  test('custom exposes only the listed canonical IDs', async () => {
    expect(
      await listedIds({ modelExposureMode: 'custom', customModels: ['alpha/a1', 'beta/b1'] })
    ).toEqual(['a1', 'b1'])
  })

  test('custom with an empty list exposes every available model', async () => {
    expect(await listedIds({ modelExposureMode: 'custom', customModels: [] })).toEqual([
      'a1',
      'a2',
      'b1'
    ])
  })

  test('all exposes every available model', async () => {
    expect(await listedIds({ modelExposureMode: 'all' })).toEqual(['a1', 'a2', 'b1'])
  })
})

describe('providerPrefixes through HTTP', () => {
  // Catches a prefix override applied to the wrong provider, or not at all.
  test('always-prefixed uses the custom label for that provider only', async () => {
    expect(
      await listedIds({
        publicModelIdMode: 'always-prefixed',
        providerPrefixes: { alpha: 'custom' }
      })
    ).toEqual(['beta/b1', 'custom/a1', 'custom/a2'])
  })
})

describe('model resolution with exposure configs', () => {
  // Catches a hidden model still reachable by its canonical ID.
  test('a model outside the custom allowlist is a 404 on chat completions', async () => {
    const app = testApp({
      ...testConfig(),
      modelExposureMode: 'custom',
      customModels: ['alpha/a1']
    })
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'beta/b1', messages: [{ role: 'user', content: 'Hello' }] })
    })
    const body = await jsonBody(response)

    expect(response.status).toBe(404)
    expect(present(isErrorBody(body) ? body.error : undefined, 'an error body').code).toBe(
      'model_not_found'
    )
  })

  test('an always-prefixed public ID resolves on the detail route', async () => {
    const app = testApp({ ...testConfig(), publicModelIdMode: 'always-prefixed' })
    const response = await app.request(`/v1/models/${encodeURIComponent('alpha/a1')}`)

    expect(response.status).toBe(200)
    expect(await jsonBody(response)).toMatchObject({ id: 'alpha/a1', owned_by: 'alpha' })
  })
})

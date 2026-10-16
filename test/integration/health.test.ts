/**
 * The health endpoints through the real app, against a throwaway pi agent directory: a models.json
 * provider with a literal API key, so the credential is known and nothing leaves the machine.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initRegistry } from '@proxy/pi/registry'
import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { jsonBody, testApp, testConfig } from '../helpers'

const PROVIDER_KEY = 'notarealsecret-health-provider-key'
const PROXY_TOKEN = 'notarealsecret-health-proxy-token'

const agentDirs: string[] = []

/** Point pi at a fresh agent directory holding only `models.json` (when given), and load it. */
async function loadAgentDir(modelsJson?: Record<string, unknown>): Promise<void> {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-proxy-health-'))
  agentDirs.push(agentDir)
  if (modelsJson !== undefined) {
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify(modelsJson))
  }
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
  await initRegistry()
}

const MOCK_PROVIDER = {
  providers: {
    'health-mock': {
      baseUrl: 'http://127.0.0.1:9/v1',
      api: 'openai-completions',
      apiKey: PROVIDER_KEY,
      models: [{ id: 'health-model' }]
    }
  }
}

beforeAll(async () => {
  // Credentials from the environment would show up as configured providers.
  vi.stubEnv('ANTHROPIC_API_KEY', undefined)
  vi.stubEnv('OPENAI_API_KEY', undefined)
  await loadAgentDir(MOCK_PROVIDER)
})

afterAll(() => {
  vi.unstubAllEnvs()
  for (const agentDir of agentDirs) rmSync(agentDir, { recursive: true, force: true })
})

const authed = { headers: { Authorization: `Bearer ${PROXY_TOKEN}` } }

describe('health endpoint authentication', () => {
  // Catches liveness probes needing the token, or the detail endpoints, which name providers and
  // models, answering without it.
  test('/healthz answers without the token; its detail endpoints require it', async () => {
    const app = testApp({ ...testConfig(), proxyAuthToken: PROXY_TOKEN })

    const live = await app.request('/healthz')
    expect(live.status).toBe(200)
    expect(await jsonBody(live)).toEqual({ status: 'ok' })

    const unauthenticated = await Promise.all(
      ['/healthz/models', '/healthz/creds'].map(async (path) => (await app.request(path)).status)
    )
    expect(unauthenticated).toEqual([401, 401])

    const authenticated = await Promise.all(
      ['/healthz/models', '/healthz/creds'].map(
        async (path) => (await app.request(path, authed)).status
      )
    )
    expect(authenticated).toEqual([200, 200])
  })
})

describe('/healthz/models', () => {
  test('reports the available and exposed model counts', async () => {
    const response = await testApp().request('/healthz/models')

    expect(response.status).toBe(200)
    expect(await jsonBody(response)).toMatchObject({
      status: 'ok',
      availableModelCount: 1,
      exposedModelCount: 1,
      exposureError: null,
      modelsJsonError: null
    })
  })

  // Catches a proxy that can serve no model passing its health check.
  test('answers 503 when the exposure config exposes no model', async () => {
    const app = testApp({
      ...testConfig(),
      modelExposureMode: 'custom',
      customModels: ['health-mock/no-such-model']
    })
    const response = await app.request('/healthz/models')

    expect(response.status).toBe(503)
    expect(await jsonBody(response)).toMatchObject({
      status: 'unavailable',
      availableModelCount: 1,
      exposedModelCount: 0
    })
  })
})

describe('/healthz/creds', () => {
  // Catches the credential itself reaching the response, or the provider not being listed.
  test('lists the configured provider and how it is authenticated, never the key', async () => {
    const response = await testApp().request('/healthz/creds?verify=true')
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).not.toContain(PROVIDER_KEY)
    const body: unknown = JSON.parse(text)
    expect(isRecord(body) ? body['providers'] : undefined).toEqual([
      {
        provider: 'health-mock',
        type: 'api_key',
        source: 'models_json_key',
        availableModelCount: 1,
        verified: true
      }
    ])
  })

  // Catches a proxy without any credential passing the check it exists for.
  test('answers 503 when no provider has a credential', async () => {
    await loadAgentDir()
    try {
      const response = await testApp().request('/healthz/creds')
      expect(response.status).toBe(503)
      expect(await jsonBody(response)).toEqual({
        status: 'unavailable',
        verified: false,
        providers: []
      })
    } finally {
      await loadAgentDir(MOCK_PROVIDER)
    }
  })

  // Catches a credential that cannot resolve passing verification, or a verification failure
  // failing the whole endpoint instead of being reported against its provider.
  test('answers 503 and names the provider whose credential fails to verify', async () => {
    await loadAgentDir({
      providers: {
        ...MOCK_PROVIDER.providers,
        'health-broken': {
          baseUrl: 'http://127.0.0.1:9/v1',
          api: 'openai-completions',
          apiKey: '!exit 3',
          models: [{ id: 'broken-model' }]
        }
      }
    })
    try {
      const response = await testApp().request('/healthz/creds?verify=true')
      const body = await jsonBody(response)

      expect(response.status).toBe(503)
      const providers = isRecord(body) ? body['providers'] : undefined
      expect(providers).toEqual([
        expect.objectContaining({ provider: 'health-mock', verified: true }),
        expect.objectContaining({
          provider: 'health-broken',
          source: 'models_json_command',
          verified: false,
          error: expect.stringContaining('health-broken')
        })
      ])
    } finally {
      await loadAgentDir(MOCK_PROVIDER)
    }
  })
})

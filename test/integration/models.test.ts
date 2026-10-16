/**
 * Integration tests for GET /v1/models and GET /v1/models/:model, through pi's real model runtime
 * and the model-exposure engine, against fixture providers:
 *
 * - `alpha` and `beta` both have `shared-model`, so in the default `collision-prefixed` mode every
 *   model of both is listed with its provider prefix.
 * - `gamma` has `org/model-x`, a model ID with a slash (as on OpenRouter), listed bare because it
 *   collides with nothing. Its canonical ID, `gamma/org/model-x`, has two slashes, which is why
 *   `GET /v1/models/{model}` must take URL-encoded IDs (AGENTS.md).
 */

import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir, offlineProvider } from '../fixtures/agent-dir'
import { isErrorBody, isModelListBody, isModelObject, jsonBody, present, testApp } from '../helpers'

let agentDir: FixtureAgentDir

beforeAll(async () => {
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        alpha: offlineProvider('shared-model', 'alpha-only'),
        beta: offlineProvider('shared-model'),
        gamma: offlineProvider('org/model-x')
      }
    }
  })
})

afterAll(() => {
  vi.unstubAllEnvs()
  agentDir.remove()
})

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const response = await testApp().request(path)
  return { status: response.status, body: await jsonBody(response) }
}

describe('GET /v1/models', () => {
  // Catches a model missing from the list, a collision left unprefixed, or a prefix applied to a
  // provider that collides with nothing.
  test('lists every exposed model under its public ID, in the OpenAI list shape', async () => {
    const { status, body } = await getJson('/v1/models')

    expect(status).toBe(200)
    expect(isModelListBody(body)).toBe(true)
    const list = isModelListBody(body) ? body.data : []
    expect(list.map((model) => model.id).toSorted()).toEqual([
      'alpha/alpha-only',
      'alpha/shared-model',
      'beta/shared-model',
      'org/model-x'
    ])
    expect(list).toEqual(
      list.map(
        (): unknown =>
          expect.objectContaining({
            object: 'model',
            created: expect.any(Number) as number,
            owned_by: expect.any(String) as string
          }) as unknown
      )
    )
  })
})

describe('GET /v1/models/:model', () => {
  // Catches a public ID that the list advertises but the detail route cannot resolve, above all
  // one with a slash that only works URL-encoded.
  test.each(['alpha/shared-model', 'beta/shared-model', 'org/model-x'])(
    'returns %s by its URL-encoded public ID',
    async (publicId) => {
      const { status, body } = await getJson(`/v1/models/${encodeURIComponent(publicId)}`)

      expect(status).toBe(200)
      expect(isModelObject(body)).toBe(true)
      expect(body).toMatchObject({ id: publicId, object: 'model' })
    }
  )

  // Catches the canonical-ID fallback breaking for a model whose public ID differs from it.
  test('returns a model by its canonical ID, URL-encoded', async () => {
    const { status, body } = await getJson(`/v1/models/${encodeURIComponent('gamma/org/model-x')}`)

    expect(status).toBe(200)
    expect(body).toMatchObject({ object: 'model', owned_by: 'gamma' })
  })

  // Catches the route only matching one path segment, so an unencoded ID with slashes is a 404.
  test('returns a model by its canonical ID unencoded, slashes and all', async () => {
    const { status, body } = await getJson('/v1/models/gamma/org/model-x')

    expect(status).toBe(200)
    expect(body).toMatchObject({ object: 'model', owned_by: 'gamma' })
  })

  test('returns 404 model_not_found for an unknown model', async () => {
    const { status, body } = await getJson('/v1/models/nonexistent%2Fmodel')

    expect(status).toBe(404)
    expect(isErrorBody(body)).toBe(true)
    expect(present(isErrorBody(body) ? body.error : undefined, 'an error body')).toMatchObject({
      type: 'invalid_request_error',
      code: 'model_not_found'
    })
  })
})

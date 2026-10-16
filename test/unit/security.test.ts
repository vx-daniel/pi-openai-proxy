/**
 * Security tests for image URL handling: remote URLs are blocked, oversized payloads are rejected,
 * and only supported MIME types are accepted.
 *
 * The model is a fixture provider (literal key, unreachable base URL): every request here is
 * rejected before any upstream call, so nothing leaves the machine and no login is needed.
 */

import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  finishChunk,
  type MockProvider,
  sse,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { isErrorLike, jsonBody, testApp } from '../helpers'

const MODEL_ID = 'security-fixture/vision-model'
/** One byte over the 20 MB limit on a decoded image. */
const OVERSIZED_BASE64 = 'A'.repeat(21 * 1024 * 1024)

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  mock = await startMockProvider({
    'vision-model': sse([...textChunks('A small PNG.'), finishChunk('stop')])
  })
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        'security-fixture': {
          ...mock.provider(),
          models: [{ id: 'vision-model', input: ['text', 'image'] }]
        }
      }
    }
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

async function sendImage(imageUrl: string): Promise<Response> {
  return testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }
      ]
    })
  })
}

describe('image URL security', () => {
  // Catches an image the proxy must not fetch or forward getting through: a remote URL (which the
  // proxy would have to fetch, server-side), a payload over the size limit, a type the providers do
  // not take, or a malformed data URI.
  test.each([
    ['a remote HTTP URL', 'http://example.com/image.png', 'Remote image URLs are not supported'],
    ['a remote HTTPS URL', 'https://example.com/image.png', 'Remote image URLs are not supported'],
    ['a localhost URL', 'http://localhost:8080/image.png', 'Remote image URLs are not supported'],
    ['a private-range URL', 'http://192.168.1.1/image.png', 'Remote image URLs are not supported'],
    [
      'an oversized base64 payload',
      `data:image/png;base64,${OVERSIZED_BASE64}`,
      'exceeds maximum size'
    ],
    [
      'an unsupported MIME type',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'Unsupported image MIME type'
    ],
    ['a malformed data URI', 'data:not-valid', 'Invalid base64 data URI']
  ])('rejects %s with 400', async (_case, imageUrl, reason) => {
    const upstreamCallsBefore = mock.requests.length
    const response = await sendImage(imageUrl)
    const body = await jsonBody(response)

    expect(response.status).toBe(400)
    expect(isErrorLike(body) ? body.error.message : body).toEqual(expect.stringContaining(reason))
    // Refused before the provider was asked anything.
    expect(mock.requests.length).toBe(upstreamCallsBefore)
  })

  // Catches the cases above passing because the model, not the image, was refused: the same
  // request with a valid image is answered, and the image reaches the provider.
  test('accepts a valid base64 PNG and forwards it, so the rejections above are about the image', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const response = await sendImage(png)

    expect(response.status).toBe(200)
    expect(JSON.stringify(mock.requests.at(-1)?.body)).toContain(png)
  })
})

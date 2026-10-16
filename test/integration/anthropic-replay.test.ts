/**
 * Real Anthropic traffic, replayed: each recording in `test/fixtures/recordings/anthropic-messages`
 * (made by `pnpm run test:live:record`) is served by the mock provider to pi's real Anthropic
 * client, and the proxy's answer is checked against what the provider actually sent.
 *
 * Expected values are read from the recording, not written out, so a re-recording with different
 * wording still tests the same thing: the client gets exactly what the provider produced.
 */

import { isRecord } from '@proxy/utils/guards'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import { type MockProvider, startMockProvider } from '../fixtures/mock-provider'
import { loadRecording, type Recording, replay } from '../fixtures/recording'
import { testApp } from '../helpers'

const API = 'anthropic-messages'
const SCENARIOS = ['text', 'two-tool-calls', 'thinking', 'cache-read', 'model-not-found'] as const
type Scenario = (typeof SCENARIOS)[number]

const recordings = new Map<Scenario, Recording>(
  SCENARIOS.map((scenario) => [scenario, loadRecording(API, scenario)])
)

function recording(scenario: Scenario): Recording {
  const found = recordings.get(scenario)
  if (found === undefined) throw new Error(`no recording for ${scenario}`)
  return found
}

/** The `data:` payloads of the provider's SSE, as it sent them. */
function providerEvents(scenario: Scenario): Record<string, unknown>[] {
  return recording(scenario)
    .response.chunks.join('')
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line): unknown => JSON.parse(line.slice('data: '.length)))
    .filter(isRecord)
}

/** Every delta of one kind (`text_delta`, `thinking_delta`, `input_json_delta`) the provider sent. */
function deltas(scenario: Scenario, kind: string, field: string): string[] {
  return providerEvents(scenario).flatMap((event) => {
    const delta = event['delta']
    return isRecord(delta) && delta['type'] === kind && typeof delta[field] === 'string'
      ? [delta[field]]
      : []
  })
}

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  mock = await startMockProvider(
    Object.fromEntries(SCENARIOS.map((scenario) => [scenario, replay(recording(scenario))]))
  )
  agentDir = await loadFixtureAgentDir({
    modelsJson: { providers: { recorded: mock.provider('anthropic-messages') } }
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await mock.close()
  agentDir.remove()
})

async function chat(scenario: Scenario, stream = false): Promise<Response> {
  return testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `recorded/${scenario}`,
      stream,
      messages: [{ role: 'user', content: 'Replayed' }]
    })
  })
}

async function completion(scenario: Scenario): Promise<Record<string, unknown>> {
  const response = await chat(scenario)
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  if (!isRecord(body)) throw new Error('expected a chat completion object')
  return body
}

function firstMessage(body: Record<string, unknown>): Record<string, unknown> {
  const choices = body['choices']
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined
  const message = isRecord(first) ? first['message'] : undefined
  if (!isRecord(message)) throw new Error('expected choices[0].message')
  return message
}

describe('replayed Anthropic traffic', () => {
  // Catches text lost or altered between Anthropic's SSE, pi and the OpenAI response.
  test('text: the client gets exactly the text Anthropic streamed', async () => {
    const message = firstMessage(await completion('text'))

    expect(message['content']).toBe(deltas('text', 'text_delta', 'text').join(''))
  })

  // Catches the streaming path dropping, reordering or duplicating text deltas.
  test('text, streamed: the deltas the client gets join to the same text', async () => {
    const response = await chat('text', true)
    const body = await response.text()
    const content = body
      .split('\n\n')
      .filter((event) => event.startsWith('data: {'))
      .map((event): unknown => JSON.parse(event.slice('data: '.length)))
      .flatMap((event): unknown[] =>
        isRecord(event) && Array.isArray(event['choices']) ? event['choices'] : []
      )
      .map((choice) =>
        isRecord(choice) &&
        isRecord(choice['delta']) &&
        typeof choice['delta']['content'] === 'string'
          ? choice['delta']['content']
          : ''
      )
      .join('')

    expect(content).toBe(deltas('text', 'text_delta', 'text').join(''))
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true)
  })

  // Catches tool calls lost, merged or misordered, or their streamed JSON not reassembled.
  test('two-tool-calls: both calls arrive, in order, with their arguments', async () => {
    const body = await completion('two-tool-calls')
    const message = firstMessage(body)
    const names = providerEvents('two-tool-calls').flatMap((event) => {
      const block = event['content_block']
      return isRecord(block) && block['type'] === 'tool_use' && typeof block['name'] === 'string'
        ? [block['name']]
        : []
    })

    expect(names).toHaveLength(2)
    const toolCalls = message['tool_calls']
    expect(Array.isArray(toolCalls) ? toolCalls.length : 0).toBe(2)
    expect(toolCalls).toEqual(
      names.map(
        (toolName): unknown =>
          expect.objectContaining({
            type: 'function',
            function: { name: toolName, arguments: expect.stringMatching(/^\{.*\}$/) as string }
          }) as unknown
      )
    )
    expect(body['choices']).toEqual([expect.objectContaining({ finish_reason: 'tool_calls' })])
  })

  // Catches thinking text leaking into the answer the client sees.
  test('thinking: the answer is the text only, without the thinking', async () => {
    const thinking = deltas('thinking', 'thinking_delta', 'thinking').join('')
    const message = firstMessage(await completion('thinking'))

    expect(thinking).not.toBe('')
    expect(message['content']).toBe(deltas('thinking', 'text_delta', 'text').join(''))
  })

  // Catches cached input tokens dropped from usage or left out of prompt_tokens.
  test('cache-read: cached tokens reach usage and count toward prompt_tokens', async () => {
    const start = providerEvents('cache-read').find((event) => event['type'] === 'message_start')
    const startMessage = isRecord(start) ? start['message'] : undefined
    const usage = isRecord(startMessage) ? startMessage['usage'] : undefined
    const cacheRead = isRecord(usage) ? usage['cache_read_input_tokens'] : undefined
    const body = await completion('cache-read')

    expect(cacheRead).toBeTypeOf('number')
    expect(cacheRead).toBeGreaterThan(0)
    expect(body['usage']).toMatchObject({ prompt_tokens_details: { cached_tokens: cacheRead } })
    const promptTokens = isRecord(body['usage']) ? body['usage']['prompt_tokens'] : undefined
    expect(promptTokens).toBeGreaterThanOrEqual(
      typeof cacheRead === 'number' ? cacheRead : Infinity
    )
  })

  // Catches an upstream error passed to the client as Anthropic's raw body (with its request id).
  test('model-not-found: an upstream 404 answers as an OpenAI error without the raw body', async () => {
    const response = await chat('model-not-found')
    const text = await response.text()

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(JSON.parse(text)).toMatchObject({ error: { message: expect.any(String) as string } })
    expect(text).not.toContain('request_id')
  })
})

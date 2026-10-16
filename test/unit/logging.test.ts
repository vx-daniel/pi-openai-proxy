/**
 * Structured logging tests: the chat_request line.
 */

import { logChatRequest } from '@proxy/server/logging'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  type MockInstance,
  vi
} from 'vite-plus/test'

type ErrorSpy = MockInstance<Console['error']>

let errorSpy: ErrorSpy

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  errorSpy.mockRestore()
})

function loggedLines(): Record<string, unknown>[] {
  return errorSpy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
}

describe('logChatRequest', () => {
  // Catches a chat call that cannot be traced to the model that served it: the `request` and
  // `response` lines carry no model, and a client may send an alias or a prefixed public id.
  test('records the requested id, the resolved canonical id, the provider and the mode', () => {
    logChatRequest(
      {
        requestId: 'req-1',
        clientRequestId: 'client-9',
        method: 'POST',
        path: '/v1/chat/completions'
      },
      {
        requestedModel: 'claude-sonnet',
        model: 'anthropic/claude-sonnet-5-5',
        provider: 'anthropic',
        stream: true
      }
    )

    const [entry, ...rest] = loggedLines()
    expect(rest).toEqual([])
    expect(entry).toMatchObject({
      level: 'info',
      event: 'chat_request',
      requestId: 'req-1',
      clientRequestId: 'client-9',
      method: 'POST',
      path: '/v1/chat/completions',
      requestedModel: 'claude-sonnet',
      model: 'anthropic/claude-sonnet-5-5',
      provider: 'anthropic',
      stream: true
    })
    expect(typeof entry?.['ts']).toBe('string')
  })

  // Catches message content or a credential being added to a line that is written to stderr for
  // every request. The key set is pinned on purpose: adding a field must be a decision.
  test('logs ids and flags only, nothing from the request body or credentials', () => {
    logChatRequest(
      { requestId: 'req-2', clientRequestId: 'c-2', method: 'POST', path: '/v1/chat/completions' },
      { requestedModel: 'm', model: 'p/m', provider: 'p', stream: false }
    )

    const [entry] = loggedLines()
    expect(Object.keys(entry ?? {}).toSorted()).toEqual([
      'clientRequestId',
      'event',
      'level',
      'method',
      'model',
      'path',
      'provider',
      'requestId',
      'requestedModel',
      'stream',
      'ts'
    ])
  })

  // A model string comes from the client; JSON encoding must keep a hostile one on one line.
  test('keeps a requested model containing a newline on a single log line', () => {
    logChatRequest(
      { requestId: 'req-3', method: 'POST', path: '/v1/chat/completions' },
      { requestedModel: 'evil"\n{"event":"forged"}', model: 'p/m', provider: 'p', stream: false }
    )

    expect(errorSpy.mock.calls).toHaveLength(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).not.toContain('\n')
    expect(loggedLines()[0]?.['requestedModel']).toBe('evil"\n{"event":"forged"}')
  })
})

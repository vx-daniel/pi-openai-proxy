/**
 * Upstream failures end to end: the mock provider answers with a provider's error status and body,
 * pi's real OpenAI and Anthropic clients turn that into an error, and the proxy answers the client.
 * Also a stream the provider cuts off partway through.
 *
 * pi does not retry by default (`maxRetries` is 0 and the proxy does not set it), so each client
 * request is one upstream attempt; the tests pin that, as a retry multiplies upstream calls.
 */

import { afterAll, beforeAll, describe, expect, test, vi } from 'vite-plus/test'

import { type FixtureAgentDir, loadFixtureAgentDir } from '../fixtures/agent-dir'
import {
  httpError,
  type MockProvider,
  type MockReply,
  startMockProvider,
  textChunks
} from '../fixtures/mock-provider'
import { testApp } from '../helpers'

const HTTP_OK = 200
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_INTERNAL_SERVER_ERROR = 500
const HTTP_BAD_GATEWAY = 502
const HTTP_SERVICE_UNAVAILABLE = 503
const HTTP_ANTHROPIC_OVERLOADED = 529

const APIS = ['openai-completions', 'anthropic-messages'] as const
type Api = (typeof APIS)[number]

/** The models.json provider name each API is served under. */
const PROVIDER_NAMES: Readonly<Record<Api, string>> = {
  'openai-completions': 'openai-mock',
  'anthropic-messages': 'anthropic-mock'
}

const AUTH_FAILED = {
  status: HTTP_BAD_GATEWAY,
  body: {
    error: {
      message: 'Upstream authentication failed',
      type: 'server_error',
      param: null,
      code: 'upstream_auth_error'
    }
  }
}
const PROVIDER_FAILED = {
  status: HTTP_BAD_GATEWAY,
  body: {
    error: {
      message: 'Upstream provider error',
      type: 'server_error',
      param: null,
      code: 'upstream_error'
    }
  }
}

/** An upstream error status, what each provider sends with it, and what the client should get. */
interface StatusCase {
  readonly status: number
  readonly bodies: Readonly<Record<Api, unknown>>
  readonly expected: { readonly status: number; readonly body: unknown }
}

const STATUS_CASES: readonly StatusCase[] = [
  {
    status: HTTP_UNAUTHORIZED,
    bodies: {
      'openai-completions': {
        error: {
          message: 'Incorrect API key provided: notareal***-key.',
          type: 'invalid_request_error',
          code: 'invalid_api_key'
        }
      },
      'anthropic-messages': {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' }
      }
    },
    expected: AUTH_FAILED
  },
  {
    status: HTTP_FORBIDDEN,
    bodies: {
      'openai-completions': {
        error: {
          message: 'You are not allowed to sample from this model',
          type: 'invalid_request_error',
          code: 'model_not_permitted'
        }
      },
      'anthropic-messages': {
        type: 'error',
        error: {
          type: 'permission_error',
          message: 'Your API key does not have permission to use the specified resource.'
        }
      }
    },
    expected: AUTH_FAILED
  },
  {
    status: HTTP_TOO_MANY_REQUESTS,
    bodies: {
      'openai-completions': {
        error: {
          message:
            'Rate limit reached for gpt-4o on tokens per min (TPM): Limit 30000, Used 30000, Requested 120. Please try again in 240ms.',
          type: 'tokens',
          code: 'rate_limit_exceeded'
        }
      },
      'anthropic-messages': {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message:
            'Number of request tokens has exceeded your per-minute rate limit. Please try again later.'
        }
      }
    },
    expected: {
      status: HTTP_TOO_MANY_REQUESTS,
      body: {
        error: {
          message: 'Upstream rate limit exceeded',
          type: 'server_error',
          param: null,
          code: 'rate_limit'
        }
      }
    }
  },
  {
    status: HTTP_INTERNAL_SERVER_ERROR,
    bodies: {
      'openai-completions': {
        error: {
          message: 'The server had an error while processing your request. Sorry about that!',
          type: 'server_error',
          code: null
        }
      },
      'anthropic-messages': {
        type: 'error',
        error: { type: 'api_error', message: 'Internal server error' }
      }
    },
    expected: PROVIDER_FAILED
  },
  {
    status: HTTP_SERVICE_UNAVAILABLE,
    bodies: {
      'openai-completions': {
        error: { message: 'Service Unavailable', type: 'server_error', code: 'service_unavailable' }
      },
      'anthropic-messages': {
        type: 'error',
        error: { type: 'api_error', message: 'Service unavailable' }
      }
    },
    expected: PROVIDER_FAILED
  },
  {
    status: HTTP_ANTHROPIC_OVERLOADED,
    bodies: {
      'openai-completions': {
        error: {
          message: 'The server is overloaded or not ready yet.',
          type: 'server_error',
          code: null
        }
      },
      'anthropic-messages': {
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' }
      }
    },
    expected: {
      status: HTTP_SERVICE_UNAVAILABLE,
      body: {
        error: {
          message: 'Upstream provider is overloaded',
          type: 'server_error',
          param: null,
          code: 'provider_overloaded'
        }
      }
    }
  }
]

const TRUNCATED_MODEL = 'truncated'

/** The mock model that answers `api` requests with this upstream status. */
function failingModel(api: Api, status: number): string {
  return `${api}-${String(status)}`
}

/** Starts a stream, sends these text deltas, then drops the connection: no finish, no `[DONE]`. */
function cutOff(...parts: string[]): MockReply {
  return (response) => {
    response.writeHead(HTTP_OK, { 'content-type': 'text/event-stream' })
    const events = textChunks(...parts)
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join('')
    // Destroyed once written: destroying right after `write` can drop the data unsent.
    response.write(events, () => response.destroy())
  }
}

let mock: MockProvider
let agentDir: FixtureAgentDir

beforeAll(async () => {
  const replies: Record<string, MockReply> = { [TRUNCATED_MODEL]: cutOff('Hel', 'lo') }
  for (const statusCase of STATUS_CASES) {
    for (const api of APIS) {
      replies[failingModel(api, statusCase.status)] = httpError(
        statusCase.status,
        statusCase.bodies[api]
      )
    }
  }
  mock = await startMockProvider(replies)
  agentDir = await loadFixtureAgentDir({
    modelsJson: {
      providers: {
        [PROVIDER_NAMES['openai-completions']]: mock.provider('openai-completions'),
        [PROVIDER_NAMES['anthropic-messages']]: mock.provider('anthropic-messages')
      }
    }
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  agentDir.remove()
  await mock.close()
})

/** What the client got for one chat request, and how many requests reached the provider. */
interface ChatOutcome {
  readonly status: number
  readonly contentType: string | null
  readonly text: string
  readonly attempts: number
}

async function chat(model: string, stream: boolean): Promise<ChatOutcome> {
  const before = mock.requests.length
  const response = await testApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'Hi' }] })
  })
  const text = await response.text()
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    text,
    attempts: mock.requests.length - before
  }
}

/** Each SSE event's data: parsed JSON, or the `[DONE]` sentinel as is. */
function dataEvents(text: string): unknown[] {
  return text
    .split('\n\n')
    .filter((event) => event !== '')
    .map((event): unknown => {
      if (!event.startsWith('data: ')) throw new Error(`not an SSE data event: ${event}`)
      const data = event.slice('data: '.length)
      return data === '[DONE]' ? data : JSON.parse(data)
    })
}

/** One streamed text chunk as the proxy sends it; the id and clock come from the request. */
function textChunk(model: string, delta: Record<string, unknown>): unknown {
  return {
    id: expect.any(String),
    object: 'chat.completion.chunk',
    created: expect.any(Number),
    model,
    choices: [{ index: 0, delta, finish_reason: null }]
  }
}

describe.each(APIS)('upstream HTTP error through %s', (api) => {
  const providerName = PROVIDER_NAMES[api]

  // Catches an upstream failure answered with the wrong status or code (a rate limit the client
  // cannot back off from, an auth failure blamed on the client, an overload reported as a crash),
  // the provider's raw error text reaching the client, or pi starting to retry each failure.
  test.each(STATUS_CASES)(
    'upstream $status is answered as $expected.status, in one attempt',
    async ({ status, expected }) => {
      const outcome = await chat(`${providerName}/${failingModel(api, status)}`, false)
      const body: unknown = JSON.parse(outcome.text)

      expect({
        status: outcome.status,
        body,
        attempts: outcome.attempts
      }).toEqual({ ...expected, attempts: 1 })
    }
  )

  // Catches a failed stream that ends silently, or with a normal finish, instead of an error event
  // and the `[DONE]` sentinel: a client would take the empty answer as complete. The message and
  // code are not pinned: today the frame carries pi's raw message (the provider's whole error
  // body) and always `upstream_error`, unlike the non-streaming mapping.
  test.each(STATUS_CASES)(
    'upstream $status ends the stream with an error event',
    async ({ status }) => {
      const outcome = await chat(`${providerName}/${failingModel(api, status)}`, true)

      expect({
        status: outcome.status,
        contentType: outcome.contentType,
        events: dataEvents(outcome.text),
        attempts: outcome.attempts
      }).toEqual({
        status: HTTP_OK,
        contentType: 'text/event-stream',
        events: [
          {
            error: {
              message: expect.any(String),
              type: 'server_error',
              param: null,
              code: expect.any(String)
            }
          },
          '[DONE]'
        ],
        attempts: 1
      })
    }
  )
})

describe('upstream stream cut off before it finished', () => {
  const model = `${PROVIDER_NAMES['openai-completions']}/${TRUNCATED_MODEL}`

  // Catches a truncated answer passed off as complete: a `stop` finish after the partial text, or
  // the stream ending without an error event, so the client keeps half an answer as the whole.
  test('streams the text that arrived, then an error event and [DONE], with no finish reason', async () => {
    const outcome = await chat(model, true)

    expect({
      status: outcome.status,
      events: dataEvents(outcome.text),
      attempts: outcome.attempts
    }).toEqual({
      status: HTTP_OK,
      events: [
        textChunk(model, { role: 'assistant' }),
        textChunk(model, { content: 'Hel' }),
        textChunk(model, { content: 'lo' }),
        {
          error: {
            message: 'terminated',
            type: 'server_error',
            param: null,
            code: 'upstream_error'
          }
        },
        '[DONE]'
      ],
      attempts: 1
    })
  })

  // Catches the partial text returned as a successful completion when the upstream connection
  // dropped partway.
  test('answers a non-streaming request with 502 and none of the partial text', async () => {
    const outcome = await chat(model, false)
    const body: unknown = JSON.parse(outcome.text)

    expect({
      status: outcome.status,
      body,
      attempts: outcome.attempts
    }).toEqual({ ...PROVIDER_FAILED, attempts: 1 })
  })
})

/**
 * Hono route handlers for the OpenAI-compatible proxy endpoints.
 *
 * Stable endpoints:
 * - GET  /v1/models
 * - GET  /v1/models/:model  (supports URL-encoded IDs with slashes)
 * - POST /v1/chat/completions
 */

import type { ServerConfig } from '@proxy/config/env'
import { loadConfigFromFile } from '@proxy/config/schema'
import { proxyLogger } from '@proxy/logging'
import { type ConversionSuccess, convertMessages } from '@proxy/openai/messages'
import {
  computeModelExposure,
  type ExposedModel,
  type ModelExposureConfig,
  type ModelExposureResult,
  resolveExposedModel
} from '@proxy/openai/model-exposure'
import { buildModelList, toOpenAIModel } from '@proxy/openai/models'
import { buildChatCompletion } from '@proxy/openai/responses'
import { streamToSSE } from '@proxy/openai/sse'
import { convertTools } from '@proxy/openai/tools'
import { type ValidationSuccess, validateChatRequest } from '@proxy/openai/validate'
import { type CompletionOptions, piComplete, piStream } from '@proxy/pi/complete'
import { getAvailableModels, getEnabledModels, getRequestAuth } from '@proxy/pi/registry'
import {
  authenticationError,
  invalidRequest,
  mapUpstreamError,
  modelNotFound,
  type OpenAIError,
  type UpstreamErrorStatus,
  unsupportedParameter
} from '@proxy/server/errors'
import {
  HTTP_BAD_REQUEST,
  HTTP_NOT_FOUND,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_TOO_MANY_REQUESTS,
  HTTP_UNAUTHORIZED,
  HTTP_UNPROCESSABLE_ENTITY
} from '@proxy/server/http-status'
import type { ProxyEnv } from '@proxy/server/types'
import { type Context, Hono } from 'hono'
import { stream as honoStream } from 'hono/streaming'

/**
 * Read exposure config. In production this re-reads the config file on each
 * request (<1KB JSON, negligible vs upstream API latency). Tests pass a
 * configReader that returns fixed values.
 */
export type ExposureConfigReader = () => ModelExposureConfig | Promise<ModelExposureConfig>

async function fileConfigReader(): Promise<ModelExposureConfig> {
  const file = loadConfigFromFile()
  return {
    publicModelIdMode: file.publicModelIdMode,
    modelExposureMode: file.modelExposureMode,
    enabledModels: await getEnabledModels(),
    customModels: file.customModels,
    providerPrefixes: file.providerPrefixes
  }
}

const CHAT_PATH = '/v1/chat/completions'
const MODELS_PREFIX = '/v1/models/'

type ProxyContext = Context<ProxyEnv>
type ChatRequest = ValidationSuccess['data']
type PiModel = ExposedModel['model']
type PiContext = ConversionSuccess['context']

/** Either a successfully produced value or an early error response. */
type Step<T> = { ok: true; value: T } | { ok: false; response: Response }

async function getExposure(configReader: ExposureConfigReader): Promise<ModelExposureResult> {
  const available = getAvailableModels()
  const outcome = computeModelExposure(available, await configReader())
  if (!outcome.ok) {
    throw new Error(`Model exposure configuration error: ${outcome.message}`)
  }
  return outcome
}

const chatLogger = proxyLogger('server', 'chat')

/**
 * Map an upstream error and log it: an error line for the failure, plus a warning for rate limiting
 * or overload so those can be counted apart from real failures. The request's IDs come from the
 * logging context.
 */
function handleUpstreamError(err: unknown): { status: UpstreamErrorStatus; body: OpenAIError } {
  const mapped = mapUpstreamError(err)
  chatLogger.error('Upstream call failed with {status}: {message}', {
    status: mapped.status,
    message: mapped.body.error.message,
    code: mapped.body.error.code,
    detail: err instanceof Error ? err.message : undefined
  })
  if (mapped.status === HTTP_TOO_MANY_REQUESTS || mapped.status === HTTP_SERVICE_UNAVAILABLE) {
    chatLogger.warn('Upstream overloaded ({upstreamStatus}, {code})', {
      upstreamStatus: mapped.status,
      code: mapped.body.error.code ?? 'unknown'
    })
  }
  return mapped
}

/** Parse the JSON body and validate it as a chat completion request. */
async function parseChatRequest(context: ProxyContext): Promise<Step<ChatRequest>> {
  let body: unknown
  try {
    body = await context.req.json()
  } catch {
    return {
      ok: false,
      response: context.json(invalidRequest('Invalid JSON in request body'), HTTP_BAD_REQUEST)
    }
  }

  const validation = validateChatRequest(body)
  if (validation.ok) {
    return { ok: true, value: validation.data }
  }
  if (validation.status === HTTP_UNPROCESSABLE_ENTITY) {
    return {
      ok: false,
      response: context.json(
        unsupportedParameter(validation.param ?? 'unknown', validation.message),
        HTTP_UNPROCESSABLE_ENTITY
      )
    }
  }
  return {
    ok: false,
    response: context.json(
      invalidRequest(validation.message, validation.param ?? undefined),
      HTTP_BAD_REQUEST
    )
  }
}

/** Convert the OpenAI messages and tools into a pi Context. */
function buildPiContext(
  honoContext: ProxyContext,
  model: PiModel,
  request: ChatRequest
): Step<PiContext> {
  const conversion = convertMessages(request.messages)
  if (!conversion.ok) {
    return {
      ok: false,
      response: honoContext.json(
        invalidRequest(conversion.message, conversion.param),
        HTTP_BAD_REQUEST
      )
    }
  }

  const context = conversion.context

  // The Codex Responses API requires the `instructions` field (system prompt).
  // When no system/developer message is provided, set an empty string so the
  // request doesn't fail with "Instructions are required". An empty string is
  // neutral — the proxy should not inject behavioral instructions.
  // See: OpenAI Codex CLI uses a long agent-specific prompt; LiteLLM's ChatGPT
  // config uses a configurable default. Both are opinionated. A translation
  // proxy should be transparent.
  if (model.api === 'openai-codex-responses' && context.systemPrompt === undefined) {
    context.systemPrompt = ''
  }

  // Convert tools if provided
  if (request.tools !== undefined && request.tools.length > 0) {
    const toolConversion = convertTools(request.tools)
    if (!toolConversion.ok) {
      return {
        ok: false,
        response: honoContext.json(
          unsupportedParameter(toolConversion.param, toolConversion.message),
          HTTP_UNPROCESSABLE_ENTITY
        )
      }
    }
    context.tools = toolConversion.tools
  }

  return { ok: true, value: context }
}

/**
 * Pre-check upstream request auth: if no per-request override and Pi cannot
 * resolve request auth for the selected model, reject early instead of
 * letting the provider fail later with a less actionable error.
 */
async function checkRequestAuth(
  context: ProxyContext,
  model: PiModel,
  upstreamApiKey: string | undefined
): Promise<Response | undefined> {
  if (upstreamApiKey !== undefined) return undefined
  const requestAuth = await getRequestAuth(model)
  if (requestAuth.ok) return undefined
  return context.json(
    authenticationError(
      `Could not resolve request auth for provider '${model.provider}'. ${requestAuth.error}. ` +
        "Configure credentials via 'pi /login' or pass X-Pi-Upstream-Api-Key header."
    ),
    HTTP_UNAUTHORIZED
  )
}

/** Everything needed to run an upstream completion for one request. */
interface CompletionJob {
  readonly requestId: string
  readonly canonicalModelId: string
  readonly model: PiModel
  readonly context: PiContext
  readonly request: ChatRequest
  readonly options: CompletionOptions
}

function streamChat(honoContext: ProxyContext, job: CompletionJob): Response {
  const { requestId, canonicalModelId, model, context, request, options } = job
  const includeUsage =
    request.stream_options !== null &&
    request.stream_options !== undefined &&
    request.stream_options.include_usage === true

  honoContext.header('content-type', 'text/event-stream')
  honoContext.header('cache-control', 'no-cache')
  honoContext.header('connection', 'keep-alive')

  return honoStream(honoContext, async (stream) => {
    try {
      const eventStream = await piStream(model, context, request, options)

      for await (const frame of streamToSSE(
        eventStream,
        requestId,
        canonicalModelId,
        includeUsage
      )) {
        await stream.write(frame)
      }
    } catch (err: unknown) {
      const mapped = handleUpstreamError(err)
      // For streams, write an error event and close
      const errorChunk = JSON.stringify({
        error: mapped.body.error
      })
      await stream.write(`data: ${errorChunk}\n\n`)
      await stream.write('data: [DONE]\n\n')
    }
  })
}

async function completeChat(honoContext: ProxyContext, job: CompletionJob): Promise<Response> {
  const { requestId, canonicalModelId, model, context, request, options } = job
  try {
    const message = await piComplete(model, context, request, options)

    // Detect upstream errors reported via stopReason
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      const errorMessage = message.errorMessage ?? 'Upstream provider error'
      const mapped = handleUpstreamError(new Error(errorMessage))
      return honoContext.json(mapped.body, mapped.status)
    }

    return honoContext.json(buildChatCompletion(requestId, canonicalModelId, message))
  } catch (err: unknown) {
    const mapped = handleUpstreamError(err)
    return honoContext.json(mapped.body, mapped.status)
  }
}

async function handleChatCompletion(
  context: ProxyContext,
  config: ServerConfig,
  configReader: ExposureConfigReader
): Promise<Response> {
  const requestId = context.get('requestId')
  const upstreamApiKey = context.get('upstreamApiKey')

  const parsed = await parseChatRequest(context)
  if (!parsed.ok) return parsed.response
  const request = parsed.value

  // Resolve model through the exposure engine
  const exposure = await getExposure(configReader)
  const resolved = resolveExposedModel(exposure, request.model)
  if (resolved === undefined) {
    return context.json(modelNotFound(request.model), HTTP_NOT_FOUND)
  }

  const model = resolved.model
  const canonicalModelId = resolved.canonicalId

  // The request and response lines carry no model, so this one ties the call to the model that
  // served it. Ids only, never message content or credentials.
  chatLogger.info('Chat request for {requestedModel} resolved to {model}', {
    requestedModel: request.model,
    model: canonicalModelId,
    provider: model.provider,
    stream: request.stream === true
  })

  const built = buildPiContext(context, model, request)
  if (!built.ok) return built.response

  const authFailure = await checkRequestAuth(context, model, upstreamApiKey)
  if (authFailure !== undefined) return authFailure

  const job: CompletionJob = {
    requestId,
    canonicalModelId,
    model,
    context: built.value,
    request,
    options: {
      upstreamApiKey,
      signal: context.get('abortController').signal,
      upstreamTimeoutMs: config.upstreamTimeoutMs
    }
  }

  return request.stream === true ? streamChat(context, job) : completeChat(context, job)
}

const unsupportedEndpoints = [
  '/v1/completions',
  '/v1/embeddings',
  '/v1/audio/*',
  '/v1/images/*',
  '/v1/assistants',
  '/v1/assistants/*',
  '/v1/threads',
  '/v1/threads/*',
  '/v1/files',
  '/v1/files/*',
  '/v1/batches',
  '/v1/batches/*',
  '/v1/fine_tuning/*'
]

export function createRoutes(
  config: ServerConfig,
  configReader: ExposureConfigReader = fileConfigReader
): Hono<ProxyEnv> {
  const routes = new Hono<ProxyEnv>()

  // --- GET /v1/models ---
  routes.get('/v1/models', async (context) => {
    const exposure = await getExposure(configReader)
    return context.json(buildModelList(exposure.models))
  })

  // --- GET /v1/models/:model ---
  // Use a wildcard to capture slash-containing model IDs
  routes.get('/v1/models/*', async (context) => {
    const rawPath = context.req.path
    // Strip the "/v1/models/" prefix to get the full (possibly multi-segment) model ID
    if (!rawPath.startsWith(MODELS_PREFIX)) {
      return context.json(modelNotFound(''), HTTP_NOT_FOUND)
    }
    const modelIdEncoded = rawPath.slice(MODELS_PREFIX.length)
    if (modelIdEncoded.length === 0) {
      // This was handled by the exact /v1/models route
      return context.json(modelNotFound(''), HTTP_NOT_FOUND)
    }
    const modelId = decodeURIComponent(modelIdEncoded)

    const exposure = await getExposure(configReader)
    const resolved = resolveExposedModel(exposure, modelId)
    if (resolved === undefined) {
      return context.json(modelNotFound(modelId), HTTP_NOT_FOUND)
    }

    return context.json(toOpenAIModel(resolved))
  })

  // --- POST /v1/chat/completions ---
  routes.post(CHAT_PATH, (context) => handleChatCompletion(context, config, configReader))

  // --- Unsupported endpoints: clear errors ---
  for (const path of unsupportedEndpoints) {
    routes.all(path, (context) => {
      return context.json(
        invalidRequest(`Endpoint '${context.req.path}' is not supported by this proxy`, undefined),
        HTTP_NOT_FOUND
      )
    })
  }

  return routes
}

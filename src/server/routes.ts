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

const chatLogger = proxyLogger('server', 'chat')
const httpLogger = proxyLogger('server', 'http')

/** The exposure config from the proxy's config file and pi's enabledModels setting. */
export async function fileConfigReader(): Promise<ModelExposureConfig> {
  const file = loadConfigFromFile()
  const enabledModels = await getEnabledModels()
  chatLogger.debug('Read exposure config: {modelExposureMode}, {publicModelIdMode}', {
    modelExposureMode: file.modelExposureMode,
    publicModelIdMode: file.publicModelIdMode,
    enabledModelCount: enabledModels?.length,
    customModelCount: file.customModels.length,
    providerPrefixCount: Object.keys(file.providerPrefixes).length
  })
  return {
    publicModelIdMode: file.publicModelIdMode,
    modelExposureMode: file.modelExposureMode,
    enabledModels,
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
    // Thrown to Hono, which answers 500: the exposure config cannot serve any request.
    chatLogger.error('Model exposure configuration error: {message}', {
      message: outcome.message,
      availableModelCount: available.length
    })
    throw new Error(`Model exposure configuration error: ${outcome.message}`)
  }
  chatLogger.debug('Exposing {exposedModelCount} of {availableModelCount} available models', {
    exposedModelCount: outcome.models.length,
    availableModelCount: available.length
  })
  return outcome
}

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
    code: mapped.body.error.code
  })
  // The raw upstream message stays at debug: some providers quote parts of the request back.
  if (err instanceof Error) {
    chatLogger.debug('Upstream error detail: {detail}', { detail: err.message })
  }
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
    // Not the parser's message: newer engines quote a slice of the body in it.
    chatLogger.warn('Rejected chat request: body is not valid JSON', {
      contentLength: context.req.header('content-length')
    })
    return {
      ok: false,
      response: context.json(invalidRequest('Invalid JSON in request body'), HTTP_BAD_REQUEST)
    }
  }

  const validation = validateChatRequest(body)
  if (validation.ok) {
    return { ok: true, value: validation.data }
  }
  // The field name only: validation messages can echo request values.
  chatLogger.warn('Rejected chat request: invalid field {param} ({status})', {
    param: validation.param ?? 'unknown',
    status: validation.status
  })
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
    chatLogger.warn('Rejected chat request: message conversion failed at {param}', {
      param: conversion.param,
      messageCount: request.messages.length
    })
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
    chatLogger.debug('No system prompt for {api}; sending empty instructions', { api: model.api })
    context.systemPrompt = ''
  }

  // Convert tools if provided
  if (request.tools !== undefined && request.tools.length > 0) {
    const toolConversion = convertTools(request.tools)
    if (!toolConversion.ok) {
      chatLogger.warn('Rejected chat request: tool conversion failed at {param}', {
        param: toolConversion.param,
        toolCount: request.tools.length
      })
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

  chatLogger.debug('Built pi context: {messageCount} messages, {toolCount} tools', {
    messageCount: context.messages.length,
    toolCount: context.tools?.length ?? 0,
    hasSystemPrompt: context.systemPrompt !== undefined
  })
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
  if (upstreamApiKey !== undefined) {
    chatLogger.debug('Using per-request upstream API key for {provider}', {
      provider: model.provider
    })
    return undefined
  }
  const requestAuth = await getRequestAuth(model)
  if (requestAuth.ok) {
    chatLogger.debug('Resolved upstream auth for {provider} from pi', { provider: model.provider })
    return undefined
  }
  chatLogger.warn('Rejected chat request: no upstream auth for {provider}: {reason}', {
    provider: model.provider,
    model: `${model.provider}/${model.id}`,
    reason: requestAuth.error
  })
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
    const start = performance.now()
    let frameCount = 0
    try {
      const eventStream = await piStream(model, context, request, options)
      chatLogger.debug('Streaming {model} with includeUsage={includeUsage}', {
        model: canonicalModelId,
        includeUsage
      })

      for await (const frame of streamToSSE(
        eventStream,
        requestId,
        canonicalModelId,
        includeUsage
      )) {
        await stream.write(frame)
        frameCount += 1
      }
      chatLogger.debug('Stream finished: {frameCount} frames in {durationMs} ms', {
        frameCount,
        durationMs: Math.round(performance.now() - start),
        aborted: stream.aborted
      })
    } catch (err: unknown) {
      const mapped = handleUpstreamError(err)
      chatLogger.debug('Ending stream with an error event after {frameCount} frames', {
        frameCount,
        durationMs: Math.round(performance.now() - start)
      })
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
  const start = performance.now()
  try {
    const message = await piComplete(model, context, request, options)
    chatLogger.debug('Completion for {model} finished: {stopReason} in {durationMs} ms', {
      model: canonicalModelId,
      stopReason: message.stopReason,
      durationMs: Math.round(performance.now() - start)
    })

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
    chatLogger.warn('Rejected chat request: model {requestedModel} is not exposed', {
      requestedModel: request.model,
      exposedModelCount: exposure.models.length
    })
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

  chatLogger.debug('Dispatching {model} as {mode}', {
    model: canonicalModelId,
    mode: request.stream === true ? 'stream' : 'complete',
    upstreamTimeoutMs: config.upstreamTimeoutMs
  })
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
    chatLogger.debug('Listing {modelCount} models', { modelCount: exposure.models.length })
    return context.json(buildModelList(exposure.models))
  })

  // --- GET /v1/models/:model ---
  // Use a wildcard to capture slash-containing model IDs
  routes.get('/v1/models/*', async (context) => {
    const rawPath = context.req.path
    // Strip the "/v1/models/" prefix to get the full (possibly multi-segment) model ID
    if (!rawPath.startsWith(MODELS_PREFIX)) {
      chatLogger.debug('Model detail request without a model ID: {path}', { path: rawPath })
      return context.json(modelNotFound(''), HTTP_NOT_FOUND)
    }
    const modelIdEncoded = rawPath.slice(MODELS_PREFIX.length)
    if (modelIdEncoded.length === 0) {
      // This was handled by the exact /v1/models route
      chatLogger.debug('Model detail request without a model ID: {path}', { path: rawPath })
      return context.json(modelNotFound(''), HTTP_NOT_FOUND)
    }
    const modelId = decodeURIComponent(modelIdEncoded)

    const exposure = await getExposure(configReader)
    const resolved = resolveExposedModel(exposure, modelId)
    if (resolved === undefined) {
      chatLogger.debug('Model detail for {modelId}: not exposed', {
        modelId,
        exposedModelCount: exposure.models.length
      })
      return context.json(modelNotFound(modelId), HTTP_NOT_FOUND)
    }

    chatLogger.debug('Model detail for {modelId} resolved to {model}', {
      modelId,
      model: resolved.canonicalId
    })
    return context.json(toOpenAIModel(resolved))
  })

  // --- POST /v1/chat/completions ---
  routes.post(CHAT_PATH, (context) => handleChatCompletion(context, config, configReader))

  // --- Unsupported endpoints: clear errors ---
  for (const path of unsupportedEndpoints) {
    routes.all(path, (context) => {
      httpLogger.warn('Rejected {method} {path}: endpoint not supported', {
        method: context.req.method,
        path: context.req.path
      })
      return context.json(
        invalidRequest(`Endpoint '${context.req.path}' is not supported by this proxy`, undefined),
        HTTP_NOT_FOUND
      )
    })
  }

  return routes
}

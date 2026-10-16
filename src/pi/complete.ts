/**
 * Pi completion integration: non-streaming and streaming.
 *
 * Bridges validated OpenAI requests to pi's completeSimple() and streamSimple().
 */

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  ThinkingLevel
} from '@earendil-works/pi-ai'
import { proxyLogger } from '@proxy/logging'
import type { ChatCompletionRequest, OpenAIFunctionTool } from '@proxy/openai/schemas'
import { getRuntime } from '@proxy/pi/registry'
import { isRecord } from '@proxy/utils/guards'

const completeLogger = proxyLogger('pi', 'complete')

/**
 * Map OpenAI reasoning_effort to pi ThinkingLevel.
 *
 * OpenAI: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
 * Pi: "minimal" | "low" | "medium" | "high" | "xhigh"
 *
 * "none" maps to "minimal" (pi has no "none" level).
 */
const REASONING_EFFORT_MAP: Record<string, ThinkingLevel> = {
  none: 'minimal',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh'
}

/**
 * APIs that accept the full set of OpenAI passthrough fields (stop, seed, top_p,
 * tool_choice, frequency_penalty, etc.) as top-level payload properties.
 */
const OPENAI_FULL_PASSTHROUGH_APIS = new Set([
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'mistral-conversations'
])

/**
 * The Codex Responses API accepts only tool_choice and parallel_tool_calls.
 * Other standard fields (top_p, seed, stop, user, frequency_penalty, etc.)
 * are rejected with "Unsupported parameter". The SDK hardcodes
 * tool_choice: "auto" and parallel_tool_calls: true; onPayload overrides
 * those when the client sends explicit values.
 */
const CODEX_APIS = new Set(['openai-codex-responses'])

const ANTHROPIC_APIS = new Set(['anthropic-messages'])

const GOOGLE_APIS = new Set(['google-generative-ai', 'google-gemini-cli', 'google-vertex'])

// ---------------------------------------------------------------------------
// OpenAI-compatible payload fields
// ---------------------------------------------------------------------------

/** Request fields forwarded verbatim to OpenAI-compatible APIs, in payload order. */
const OPENAI_PASSTHROUGH_FIELDS = [
  'stop',
  'user',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'seed',
  'response_format',
  'tool_choice',
  'parallel_tool_calls',
  'metadata',
  'prediction'
] as const satisfies readonly (keyof ChatCompletionRequest)[]

/**
 * Collect OpenAI-format fields for OpenAI-compatible APIs.
 * Fields are injected as flat top-level properties on the payload.
 *
 * @internal Exported for unit testing only.
 */
export function collectOpenAIPayloadFields(
  request: ChatCompletionRequest
): Record<string, unknown> | undefined {
  const fields: Record<string, unknown> = {}
  let hasFields = false

  for (const key of OPENAI_PASSTHROUGH_FIELDS) {
    const value = request[key]
    if (value !== undefined) {
      fields[key] = value
      hasFields = true
    }
  }

  return hasFields ? fields : undefined
}

// ---------------------------------------------------------------------------
// Anthropic payload translation
// ---------------------------------------------------------------------------

/**
 * Translate OpenAI tool_choice to Anthropic tool_choice format.
 *
 * OpenAI "auto" -> { type: "auto" }
 * OpenAI "none" -> { type: "none" } (Anthropic skips tool calling)
 * OpenAI "required" -> { type: "any" } (force tool use)
 * OpenAI { type: "function", function: { name } } -> { type: "tool", name }
 *
 * @internal Exported for unit testing only.
 */
export function translateToolChoiceForAnthropic(
  toolChoice: ChatCompletionRequest['tool_choice']
): Record<string, unknown> | undefined {
  if (toolChoice === undefined) {
    return undefined
  }
  if (toolChoice === 'auto') {
    return { type: 'auto' }
  }
  if (toolChoice === 'none') {
    return { type: 'none' }
  }
  if (toolChoice === 'required') {
    return { type: 'any' }
  }
  // Named function choice: { type: "function", function: { name } }
  return { type: 'tool', name: toolChoice.function.name }
}

/**
 * Collect Anthropic-format fields translated from the OpenAI request.
 *
 * Supported translations:
 * - top_p -> top_p (same name, natively supported)
 * - stop -> stop_sequences (different field name)
 * - tool_choice -> Anthropic tool_choice format (object with type)
 * - parallel_tool_calls: false -> disable_parallel_tool_use on tool_choice
 * - user -> metadata.user_id
 *
 * Not supported (silently skipped — these concepts don't exist in Anthropic):
 * - seed, frequency_penalty, presence_penalty, response_format, prediction, metadata (arbitrary keys)
 *
 * @internal Exported for unit testing only.
 */
export function collectAnthropicPayloadFields(
  request: ChatCompletionRequest
): Record<string, unknown> | undefined {
  const fields: Record<string, unknown> = {}
  let hasFields = false

  if (request.top_p !== undefined) {
    fields['top_p'] = request.top_p
    hasFields = true
  }

  if (request.stop !== undefined) {
    const sequences = Array.isArray(request.stop) ? request.stop : [request.stop]
    fields['stop_sequences'] = sequences
    hasFields = true
  }

  // Build tool_choice with optional disable_parallel_tool_use
  const toolChoice = translateToolChoiceForAnthropic(request.tool_choice)
  const disableParallel = request.parallel_tool_calls === false

  if (toolChoice !== undefined) {
    if (disableParallel) {
      toolChoice['disable_parallel_tool_use'] = true
    }
    fields['tool_choice'] = toolChoice
    hasFields = true
  } else if (disableParallel) {
    // No explicit tool_choice but parallel disabled: set auto with flag
    fields['tool_choice'] = { type: 'auto', disable_parallel_tool_use: true }
    hasFields = true
  }

  // Map user to metadata.user_id (Anthropic only accepts user_id in metadata)
  if (request.user !== undefined) {
    fields['metadata'] = { user_id: request.user }
    hasFields = true
  }

  return hasFields ? fields : undefined
}

// ---------------------------------------------------------------------------
// Google payload translation
// ---------------------------------------------------------------------------

/**
 * Translate OpenAI tool_choice to Google FunctionCallingConfigMode string.
 *
 * OpenAI "auto" -> "AUTO"
 * OpenAI "none" -> "NONE"
 * OpenAI "required" -> "ANY"
 * Named function choice -> "ANY" (Google doesn't support per-function forcing
 * in the same way, but ANY forces tool use)
 */
function translateToolChoiceForGoogle(
  toolChoice: ChatCompletionRequest['tool_choice']
): string | undefined {
  if (toolChoice === undefined) {
    return undefined
  }
  if (toolChoice === 'auto') {
    return 'AUTO'
  }
  if (toolChoice === 'none') {
    return 'NONE'
  }
  // "required" or named function -> force tool use
  return 'ANY'
}

/**
 * Patch Google's nested payload structure with translated fields.
 *
 * Google's payload shape: { model, contents, config: { generationConfig, toolConfig, ... } }
 * Fields go into config.generationConfig (camelCase) or config.toolConfig.
 *
 * Supported translations:
 * - top_p -> config.generationConfig.topP (camelCase, nested)
 * - stop -> config.generationConfig.stopSequences (array, nested)
 * - seed -> config.generationConfig.seed (nested)
 * - frequency_penalty -> config.generationConfig.frequencyPenalty (nested)
 * - presence_penalty -> config.generationConfig.presencePenalty (nested)
 * - tool_choice -> config.toolConfig.functionCallingConfig.mode (nested)
 *
 * Not supported (silently skipped):
 * - response_format, metadata, prediction, parallel_tool_calls, user
 *
 * @internal Exported for unit testing only.
 */
export function patchGooglePayload(
  payload: Record<string, unknown>,
  request: ChatCompletionRequest
): boolean {
  // Access or create config.generationConfig
  const config = isRecord(payload['config']) ? payload['config'] : undefined
  if (config === undefined) {
    return false
  }

  let patched = false
  const genFields = collectGoogleGenerationFields(request)
  if (Object.keys(genFields).length > 0) {
    const genConfig = isRecord(config['generationConfig']) ? config['generationConfig'] : {}
    Object.assign(genConfig, genFields)
    config['generationConfig'] = genConfig
    patched = true
  }

  // Tool choice -> toolConfig.functionCallingConfig.mode
  const mode = translateToolChoiceForGoogle(request.tool_choice)
  if (mode !== undefined) {
    const toolConfig = isRecord(config['toolConfig']) ? config['toolConfig'] : {}
    const funcConfig = isRecord(toolConfig['functionCallingConfig'])
      ? toolConfig['functionCallingConfig']
      : {}
    funcConfig['mode'] = mode
    toolConfig['functionCallingConfig'] = funcConfig
    config['toolConfig'] = toolConfig
    patched = true
  }

  return patched
}

/**
 * Collect Google generationConfig fields (camelCase) translated from the request.
 */
function collectGoogleGenerationFields(request: ChatCompletionRequest): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  if (request.top_p !== undefined) {
    fields['topP'] = request.top_p
  }
  if (request.stop !== undefined) {
    fields['stopSequences'] = Array.isArray(request.stop) ? request.stop : [request.stop]
  }
  if (request.seed !== undefined) {
    fields['seed'] = request.seed
  }
  if (request.frequency_penalty !== undefined) {
    fields['frequencyPenalty'] = request.frequency_penalty
  }
  if (request.presence_penalty !== undefined) {
    fields['presencePenalty'] = request.presence_penalty
  }
  return fields
}

// ---------------------------------------------------------------------------
// Codex Responses API (restricted passthrough)
// ---------------------------------------------------------------------------

/**
 * Collect the restricted set of fields the Codex Responses API accepts.
 *
 * Only tool_choice and parallel_tool_calls are supported. The SDK hardcodes
 * tool_choice: "auto" and parallel_tool_calls: true; these overrides let clients
 * control tool behavior explicitly.
 *
 * @internal Exported for unit testing only.
 */
export function collectCodexPayloadFields(
  request: ChatCompletionRequest
): Record<string, unknown> | undefined {
  const fields: Record<string, unknown> = {}
  let hasFields = false

  if (request.tool_choice !== undefined) {
    fields['tool_choice'] = request.tool_choice
    hasFields = true
  }
  if (request.parallel_tool_calls !== undefined) {
    fields['parallel_tool_calls'] = request.parallel_tool_calls
    hasFields = true
  }

  return hasFields ? fields : undefined
}

// ---------------------------------------------------------------------------
// Unified dispatch
// ---------------------------------------------------------------------------

/**
 * Collect API-specific payload fields from an OpenAI request.
 *
 * Dispatches to the appropriate translator based on the target API:
 * - OpenAI full passthrough: all standard fields (same names)
 * - Codex: restricted to tool_choice + parallel_tool_calls only
 * - Anthropic: translated field names and formats
 * - Google: nested generationConfig patching (handled separately in onPayload)
 * - Others (Bedrock): no passthrough
 *
 * For Google APIs, returns undefined (patching is done directly in onPayload
 * via patchGooglePayload because the payload structure is nested).
 *
 * @internal Exported for unit testing only.
 */
export function collectPayloadFields(
  request: ChatCompletionRequest,
  api: string
): Record<string, unknown> | undefined {
  if (OPENAI_FULL_PASSTHROUGH_APIS.has(api)) {
    return collectOpenAIPayloadFields(request)
  }
  if (CODEX_APIS.has(api)) {
    return collectCodexPayloadFields(request)
  }
  if (ANTHROPIC_APIS.has(api)) {
    return collectAnthropicPayloadFields(request)
  }
  // Google and others: no flat field collection
  // (Google uses patchGooglePayload directly in the onPayload callback)
  return undefined
}

/**
 * Whether the given API requires Google-style nested payload patching.
 */
function isGoogleApi(api: string): boolean {
  return GOOGLE_APIS.has(api)
}

/** Which payload passthrough strategy an API gets, for logging. Mirrors `collectPayloadFields`. */
function passthroughStrategy(api: string): 'openai' | 'codex' | 'anthropic' | 'google' | 'none' {
  if (OPENAI_FULL_PASSTHROUGH_APIS.has(api)) return 'openai'
  if (CODEX_APIS.has(api)) return 'codex'
  if (ANTHROPIC_APIS.has(api)) return 'anthropic'
  if (GOOGLE_APIS.has(api)) return 'google'
  return 'none'
}

/**
 * Collect tool strict flags from the original OpenAI request.
 *
 * The pi SDK's `Tool` interface has no `strict` field, so the SDK always sets
 * `strict: false` when building the upstream payload. This function extracts
 * the per-tool strict flags from the original request so they can be restored
 * via `onPayload` after the SDK builds the payload.
 *
 * Returns a map of tool index -> true for tools that requested strict mode,
 * or undefined if no tools use strict mode.
 *
 * @internal Exported for unit testing only.
 */
export function collectToolStrictFlags(
  tools: OpenAIFunctionTool[] | undefined
): ReadonlyMap<number, true> | undefined {
  if (tools === undefined || tools.length === 0) {
    return undefined
  }

  let flags: Map<number, true> | undefined

  for (let toolIndex = 0; toolIndex < tools.length; toolIndex++) {
    const tool = tools[toolIndex]
    if (tool?.function.strict === true) {
      flags ??= new Map()
      flags.set(toolIndex, true)
    }
  }

  return flags
}

/**
 * Apply strict flags to tool definitions in the upstream payload.
 *
 * The pi SDK always sets `strict: false` on tool definitions. This function
 * patches the payload's `tools` array to restore the client's requested
 * `strict: true` flags on the matching tool definitions.
 *
 * @internal Exported for unit testing only.
 */
export function applyToolStrictFlags(
  payload: Record<string, unknown>,
  strictFlags: ReadonlyMap<number, true>
): void {
  const tools = payload['tools']
  if (!Array.isArray(tools)) {
    return
  }
  for (const [toolIndex, _flag] of strictFlags) {
    const tool = tools[toolIndex] as unknown
    if (isRecord(tool)) {
      const fn = tool['function']
      if (isRecord(fn)) {
        fn['strict'] = true
      }
    }
  }
}

/**
 * Options for building pi stream options, beyond the parsed request itself.
 */
export interface CompletionOptions {
  /** Per-request upstream API key override via X-Pi-Upstream-Api-Key header. */
  readonly upstreamApiKey?: string | undefined
  /** Abort signal for cancellation. */
  readonly signal?: AbortSignal | undefined
  /** Upstream timeout in milliseconds. Creates a timeout-aware abort signal. */
  readonly upstreamTimeoutMs?: number | undefined
}

/**
 * Combine a client disconnect signal with an upstream timeout into a single signal.
 * Returns the combined signal, or undefined if neither is provided.
 */
function buildCombinedSignal(
  clientSignal: AbortSignal | undefined,
  timeoutMs: number | undefined
): AbortSignal | undefined {
  if (clientSignal === undefined && timeoutMs === undefined) {
    return undefined
  }
  if (timeoutMs === undefined) {
    return clientSignal
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (clientSignal === undefined) {
    return timeoutSignal
  }
  return AbortSignal.any([clientSignal, timeoutSignal])
}

/**
 * Build pi SimpleStreamOptions from an OpenAI request.
 */
async function buildStreamOptions(
  model: Model<Api>,
  request: ChatCompletionRequest,
  options: CompletionOptions
): Promise<SimpleStreamOptions> {
  const opts: SimpleStreamOptions = {}

  // openai-codex-responses API does not support temperature
  if (request.temperature !== undefined) {
    if (model.api === 'openai-codex-responses') {
      completeLogger.debug('Dropping temperature: {api} does not support it', { api: model.api })
    } else {
      opts.temperature = request.temperature
    }
  }

  // Normalize max_tokens / max_completion_tokens
  const maxTokens = request.max_completion_tokens ?? request.max_tokens
  if (maxTokens !== undefined) {
    opts.maxTokens = maxTokens
  }

  // Map reasoning_effort to pi ThinkingLevel
  if (request.reasoning_effort !== undefined) {
    const level = REASONING_EFFORT_MAP[request.reasoning_effort]
    if (level === undefined) {
      completeLogger.warn(
        'No pi thinking level for reasoning_effort {reasoningEffort}; ignoring it',
        {
          reasoningEffort: request.reasoning_effort
        }
      )
    } else {
      opts.reasoning = level
    }
  }

  // Combine client disconnect signal with upstream timeout
  const combinedSignal = buildCombinedSignal(options.signal, options.upstreamTimeoutMs)
  if (combinedSignal !== undefined) {
    opts.signal = combinedSignal
  }

  // A per-request upstream key (X-Pi-Upstream-Api-Key) overrides everything. Without one, leave
  // apiKey unset: the ModelRuntime resolves request auth itself for the chosen model (API keys,
  // OAuth with refresh, model-specific headers, dynamic models.json headers).
  if (options.upstreamApiKey !== undefined) {
    opts.apiKey = options.upstreamApiKey
  }

  // Inject passthrough fields and tool strict flags via onPayload
  const payloadFields = collectPayloadFields(request, model.api)
  const strictFlags = collectToolStrictFlags(request.tools)
  const needsGooglePatch = isGoogleApi(model.api)
  const payloadFieldNames = payloadFields === undefined ? [] : Object.keys(payloadFields)
  const strictToolCount = strictFlags?.size ?? 0

  completeLogger.debug('Payload passthrough for {api}: {passthrough}', {
    api: model.api,
    passthrough: passthroughStrategy(model.api),
    payloadFields: payloadFieldNames,
    strictToolCount,
    googlePatch: needsGooglePatch
  })

  if (payloadFields !== undefined || strictFlags !== undefined || needsGooglePatch) {
    opts.onPayload = (payload: unknown) => {
      if (isRecord(payload)) {
        // Flat field injection (OpenAI-compatible and Anthropic)
        if (payloadFields !== undefined) {
          for (const [fieldName, fieldValue] of Object.entries(payloadFields)) {
            payload[fieldName] = fieldValue
          }
        }
        // Google nested generationConfig patching
        const googlePatched = needsGooglePatch && patchGooglePayload(payload, request)
        // Tool strict flag patching (OpenAI-compatible only)
        if (strictFlags !== undefined) {
          applyToolStrictFlags(payload, strictFlags)
        }
        completeLogger.debug('Patched upstream payload for {api}', {
          api: model.api,
          patchedFields: payloadFieldNames,
          googlePatched,
          strictToolCount
        })
      } else {
        completeLogger.warn(
          'Upstream payload for {api} is not an object; passthrough not applied',
          {
            api: model.api,
            payloadType: typeof payload
          }
        )
      }
      return payload
    }
  }

  return opts
}

/** Why an upstream call was aborted: the client went away, the upstream timeout fired, or neither. */
function abortCause(
  clientSignal: AbortSignal | undefined,
  upstreamSignal: AbortSignal | undefined
): 'client' | 'timeout' | 'unknown' {
  if (clientSignal?.aborted === true) return 'client'
  if (upstreamSignal?.aborted === true) return 'timeout'
  return 'unknown'
}

/** One upstream call, as the logging helpers below see it. */
interface UpstreamCall {
  readonly model: Model<Api>
  readonly options: CompletionOptions
  readonly opts: SimpleStreamOptions
  readonly stream: boolean
  /** `performance.now()` when the call started. */
  readonly startedAt: number
}

/** The properties every upstream log line carries: where the call went and how long it has run. */
function callProperties(call: UpstreamCall): Record<string, unknown> {
  return {
    provider: call.model.provider,
    modelId: call.model.id,
    api: call.model.api,
    stream: call.stream,
    durationMs: Math.round(performance.now() - call.startedAt)
  }
}

/** Log the start of an upstream call: what is sent where, never what it says. */
function logUpstreamStart(
  call: UpstreamCall,
  context: Context,
  request: ChatCompletionRequest
): void {
  const { model, options, opts, stream } = call
  completeLogger.debug('Calling {provider}/{modelId} via {api}', () => ({
    provider: model.provider,
    modelId: model.id,
    api: model.api,
    stream,
    messageCount: context.messages.length,
    toolCount: context.tools?.length ?? 0,
    reasoningEffort: request.reasoning_effort,
    thinkingLevel: opts.reasoning,
    maxTokens: opts.maxTokens,
    upstreamTimeoutMs: options.upstreamTimeoutMs,
    upstreamKeyOverride: options.upstreamApiKey !== undefined
  }))
}

/** Log how an upstream call ended: stop reason, duration and usage, or why it failed. */
function logUpstreamResult(call: UpstreamCall, message: AssistantMessage): void {
  if (message.stopReason === 'error') {
    completeLogger.warn('Upstream call to {modelId} failed after {durationMs} ms: {error}', () => ({
      ...callProperties(call),
      stopReason: message.stopReason,
      rawStopReason: message.rawStopReason,
      error: message.errorMessage
    }))
    return
  }
  if (message.stopReason === 'aborted') {
    completeLogger.warn(
      'Upstream call to {modelId} aborted after {durationMs} ms ({abortCause})',
      () => ({
        ...callProperties(call),
        stopReason: message.stopReason,
        abortCause: abortCause(call.options.signal, call.opts.signal),
        error: message.errorMessage
      })
    )
    return
  }
  completeLogger.debug(
    'Upstream call to {modelId} finished in {durationMs} ms: {stopReason}',
    () => ({
      ...callProperties(call),
      stopReason: message.stopReason,
      rawStopReason: message.rawStopReason,
      responseModel: message.responseModel,
      inputTokens: message.usage.input,
      outputTokens: message.usage.output,
      cacheReadTokens: message.usage.cacheRead,
      cacheWriteTokens: message.usage.cacheWrite,
      reasoningTokens: message.usage.reasoning,
      totalTokens: message.usage.totalTokens,
      costTotal: message.usage.cost.total
    })
  )
}

/** Log an upstream call that threw instead of reporting an error message; the caller rethrows. */
function logUpstreamThrow(call: UpstreamCall, error: unknown): void {
  const aborted = call.opts.signal?.aborted === true
  completeLogger.warn('Upstream call to {modelId} threw after {durationMs} ms: {error}', () => ({
    ...callProperties(call),
    aborted,
    abortCause: aborted ? abortCause(call.options.signal, call.opts.signal) : undefined,
    error: error instanceof Error ? error.message : String(error)
  }))
}

/**
 * Non-streaming completion: returns the final AssistantMessage.
 */
export async function piComplete(
  model: Model<Api>,
  context: Context,
  request: ChatCompletionRequest,
  options: CompletionOptions
): Promise<AssistantMessage> {
  const opts = await buildStreamOptions(model, request, options)
  const call: UpstreamCall = { model, options, opts, stream: false, startedAt: performance.now() }
  logUpstreamStart(call, context, request)
  try {
    const message = await getRuntime().completeSimple(model, context, opts)
    logUpstreamResult(call, message)
    return message
  } catch (error) {
    logUpstreamThrow(call, error)
    throw error
  }
}

/**
 * Streaming completion: returns an event stream with abort capability.
 */
export async function piStream(
  model: Model<Api>,
  context: Context,
  request: ChatCompletionRequest,
  options: CompletionOptions
): Promise<AssistantMessageEventStream> {
  const opts = await buildStreamOptions(model, request, options)
  const call: UpstreamCall = { model, options, opts, stream: true, startedAt: performance.now() }
  logUpstreamStart(call, context, request)
  let eventStream: AssistantMessageEventStream
  try {
    eventStream = getRuntime().streamSimple(model, context, opts)
  } catch (error) {
    logUpstreamThrow(call, error)
    throw error
  }
  // Resolves with the final message once the stream ends with done or error; it never rejects.
  void eventStream.result().then((message) => logUpstreamResult(call, message))
  return eventStream
}

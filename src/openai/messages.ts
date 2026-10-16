/**
 * OpenAI messages -> pi Context conversion.
 *
 * Phase 0 contract:
 * - `system` messages -> accumulated system prompt
 * - `developer` messages -> merged into effective system prompt in message order
 * - `user` text -> pi UserMessage
 * - `assistant` text -> pi AssistantMessage history
 * - `tool` -> pi ToolResultMessage
 * - Reject unsupported content parts clearly
 */

import type {
  AssistantMessage,
  Context,
  ImageContent,
  JsonObject,
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage
} from '@earendil-works/pi-ai'
import { proxyLogger } from '@proxy/logging'
import type { OpenAIMessage } from '@proxy/openai/schemas'
import * as z from 'zod'

const messagesLogger = proxyLogger('openai', 'messages')

// Tool-call arguments are JSON values (Pi 1.x types them as JsonObject), not arbitrary objects.
const toolArgsSchema = z.record(z.string().trim(), z.json())

export interface ConversionSuccess {
  readonly ok: true
  readonly context: Context
}

export interface ConversionError {
  readonly ok: false
  readonly message: string
  readonly param: string
}

export type ConversionResult = ConversionSuccess | ConversionError

/**
 * Convert OpenAI messages array into a pi Context.
 *
 * System and developer messages are merged into `systemPrompt`.
 * Conversation messages are mapped into pi message types.
 */
export function convertMessages(messages: OpenAIMessage[]): ConversionResult {
  const systemParts: string[] = []
  const piMessages: Message[] = []
  const roleCounts = { system: 0, developer: 0, user: 0, assistant: 0, tool: 0 }

  const toolCallNames = collectToolCallNames(messages)

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]
    if (message === undefined) continue
    roleCounts[message.role]++

    if (message.role === 'system') {
      systemParts.push(message.content)
    } else if (message.role === 'developer') {
      systemParts.push(message.content)
    } else if (message.role === 'user') {
      const userMsg = convertUserMessage(message.content, messageIndex)
      if (!userMsg.ok) return userMsg
      piMessages.push(userMsg.message)
    } else if (message.role === 'assistant') {
      const assistantMsg = convertAssistantMessage(message.content ?? null, message.tool_calls)
      piMessages.push(assistantMsg)
    } else {
      const toolName = toolCallNames.get(message.tool_call_id)
      if (toolName === undefined) {
        messagesLogger.debug(
          'Tool message {messageIndex} answers unknown tool call {toolCallId}; sending an empty tool name',
          { messageIndex, toolCallId: message.tool_call_id }
        )
      }
      const toolMsg = convertToolMessage(message.content, message.tool_call_id, toolName ?? '')
      piMessages.push(toolMsg)
    }
  }

  const context: Context = {
    messages: piMessages
  }

  if (systemParts.length > 0) {
    context.systemPrompt = systemParts.join('\n\n')
  }

  messagesLogger.debug(
    'Converted {messageCount} messages to {piMessageCount} pi messages, merging {systemPartCount} system/developer parts',
    {
      messageCount: messages.length,
      piMessageCount: piMessages.length,
      systemPartCount: systemParts.length,
      systemPromptChars: context.systemPrompt?.length ?? 0,
      roleCounts
    }
  )

  return { ok: true, context }
}

/**
 * Build a map of tool_call_id -> function name from assistant messages.
 * The OpenAI tool message only has tool_call_id + content, but some providers
 * (Google) require the function name on tool result messages.
 */
function collectToolCallNames(messages: OpenAIMessage[]): Map<string, string> {
  const toolCallNames = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'assistant' && 'tool_calls' in message) {
      for (const tc of message.tool_calls ?? []) {
        toolCallNames.set(tc.id, tc.function.name)
      }
    }
  }
  return toolCallNames
}

// --- Internal converters ---

type UserConversionResult = { readonly ok: true; readonly message: UserMessage } | ConversionError

type UserContent = string | { type: string; text?: string; image_url?: { url: string } }[]

function convertUserMessage(content: UserContent, index: number): UserConversionResult {
  if (typeof content === 'string') {
    return {
      ok: true,
      message: {
        role: 'user',
        content,
        timestamp: Date.now()
      }
    }
  }

  // Multi-part content
  const parts: (TextContent | ImageContent)[] = []
  let imageCount = 0

  for (let partIndex = 0; partIndex < content.length; partIndex++) {
    const part = content[partIndex]
    if (part === undefined) continue

    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text ?? '' })
    } else if (part.type === 'image_url') {
      const url = part.image_url?.url ?? ''
      // Only base64 data URIs are supported (remote URLs disabled by default)
      if (url.startsWith('data:')) {
        const result = parseAndValidateDataUri(url)
        if (!result.ok) {
          messagesLogger.warn(
            'Rejected image at messages[{messageIndex}].content[{partIndex}]: {reason}',
            { messageIndex: index, partIndex, reason: result.message, uriChars: url.length }
          )
          return {
            ok: false,
            message: `${result.message} at messages[${String(index)}].content[${String(partIndex)}]`,
            param: `messages[${String(index)}].content[${String(partIndex)}].image_url.url`
          }
        }
        imageCount++
        messagesLogger.debug(
          'Image part at messages[{messageIndex}].content[{partIndex}]: {mimeType}, {base64Chars} base64 chars',
          {
            messageIndex: index,
            partIndex,
            mimeType: result.parsed.mimeType,
            base64Chars: result.parsed.data.length
          }
        )
        parts.push({
          type: 'image',
          data: result.parsed.data,
          mimeType: result.parsed.mimeType
        })
      } else {
        // Remote URLs disabled by default
        messagesLogger.warn(
          'Blocked remote image from {host} at messages[{messageIndex}].content[{partIndex}]',
          { host: imageUrlHost(url), messageIndex: index, partIndex }
        )
        return {
          ok: false,
          message: 'Remote image URLs are not supported. Use base64 data URIs instead.',
          param: `messages[${String(index)}].content[${String(partIndex)}].image_url.url`
        }
      }
    } else {
      messagesLogger.warn(
        'Rejected unsupported content part type {partType} at messages[{messageIndex}].content[{partIndex}]',
        { partType: part.type, messageIndex: index, partIndex }
      )
      return {
        ok: false,
        message: `Unsupported content part type: '${part.type}'`,
        param: `messages[${String(index)}].content[${String(partIndex)}].type`
      }
    }
  }

  messagesLogger.trace(
    'User message {messageIndex} has {partCount} content parts, {imageCount} images',
    { messageIndex: index, partCount: parts.length, imageCount }
  )

  return {
    ok: true,
    message: {
      role: 'user',
      content: parts,
      timestamp: Date.now()
    }
  }
}

interface OpenAIToolCallInput {
  readonly id: string
  readonly type: 'function'
  readonly function: { readonly name: string; readonly arguments: string }
}

function convertAssistantMessage(
  textContent: string | null,
  toolCalls: OpenAIToolCallInput[] | undefined
): AssistantMessage {
  const content: (TextContent | ToolCall)[] = []

  if (textContent !== null && textContent.length > 0) {
    content.push({ type: 'text', text: textContent })
  }

  if (toolCalls !== undefined) {
    for (const tc of toolCalls) {
      let args: JsonObject = {}
      try {
        const parsed = toolArgsSchema.safeParse(JSON.parse(tc.function.arguments))
        if (parsed.success) {
          args = parsed.data
        } else {
          messagesLogger.warn(
            'Arguments of history tool call {toolCallId} ({toolName}) are not a JSON object; sending empty arguments',
            { toolCallId: tc.id, toolName: tc.function.name }
          )
        }
      } catch {
        // Best-effort: keep empty args if parsing fails
        messagesLogger.warn(
          'Arguments of history tool call {toolCallId} ({toolName}) are not valid JSON; sending empty arguments',
          {
            toolCallId: tc.id,
            toolName: tc.function.name,
            argumentsChars: tc.function.arguments.length
          }
        )
      }
      content.push({
        type: 'toolCall',
        id: tc.id,
        name: tc.function.name,
        arguments: args
      })
    }
  }

  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'proxy',
    model: 'history',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: Date.now()
  }
}

function convertToolMessage(
  content: string,
  toolCallId: string,
  toolName: string
): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text: content }],
    isError: false,
    timestamp: Date.now()
  }
}

// --- Helpers ---

/** The host of a remote image URL, for logs: never the path or query, which may carry tokens. */
function imageUrlHost(url: string): string {
  return URL.canParse(url) ? new URL(url).host : '(unparseable URL)'
}

/**
 * Supported image MIME types for base64 data URIs.
 */
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const BYTES_PER_KILOBYTE = 1024
const BYTES_PER_MEGABYTE = BYTES_PER_KILOBYTE * BYTES_PER_KILOBYTE
const MAX_BASE64_PAYLOAD_MEGABYTES = 20
/**
 * Maximum base64 payload size (20 MB of base64 text, ~15 MB decoded).
 */
const MAX_BASE64_PAYLOAD_SIZE = MAX_BASE64_PAYLOAD_MEGABYTES * BYTES_PER_MEGABYTE

export interface ParsedDataUri {
  readonly data: string
  readonly mimeType: string
}

export interface DataUriError {
  readonly ok: false
  readonly message: string
}

export interface DataUriSuccess {
  readonly ok: true
  readonly parsed: ParsedDataUri
}

type DataUriResult = DataUriSuccess | DataUriError

function parseAndValidateDataUri(uri: string): DataUriResult {
  // data:[<mediatype>][;base64],<data>
  const match = /^data:([^;]+);base64,(.+)$/.exec(uri)
  if (match === null) {
    return { ok: false, message: 'Invalid base64 data URI format' }
  }
  const mimeType = match[1]
  const data = match[2]
  if (mimeType === undefined || data === undefined) {
    return { ok: false, message: 'Invalid base64 data URI format' }
  }

  // Validate MIME type
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    return {
      ok: false,
      message: `Unsupported image MIME type '${mimeType}'. Supported: ${[...SUPPORTED_IMAGE_MIME_TYPES].join(', ')}`
    }
  }

  // Validate payload size
  if (data.length > MAX_BASE64_PAYLOAD_SIZE) {
    return {
      ok: false,
      message: `Image payload exceeds maximum size of ${String(MAX_BASE64_PAYLOAD_SIZE)} bytes`
    }
  }

  return { ok: true, parsed: { data, mimeType } }
}

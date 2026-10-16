/**
 * Structured logging for the proxy.
 *
 * Logs JSON lines to stderr. Never logs secrets.
 */

export interface LogContext {
  readonly requestId: string
  readonly clientRequestId?: string | undefined
  readonly method: string
  readonly path: string
}

type LogLevel = 'info' | 'warn' | 'error'

/** Write one JSON log line; every line starts with the `ts`, `level`, and `event` fields. */
function writeLogLine(level: LogLevel, event: string, fields: Record<string, unknown>): void {
  // oxlint-disable-next-line naming/no-abbreviations -- "ts" is the emitted log line field
  const entry = { ts: new Date().toISOString(), level, event, ...fields }
  console.error(JSON.stringify(entry))
}

export function logRequest(context: LogContext): void {
  writeLogLine('info', 'request', {
    requestId: context.requestId,
    clientRequestId: context.clientRequestId,
    method: context.method,
    path: context.path
  })
}

/** What a chat request asked for and what it resolved to. */
export interface ChatRequestLogDetails {
  /** The model string the client sent, which may be an alias or a prefixed public id. */
  readonly requestedModel: string
  /** The canonical `provider/id` the exposure engine resolved it to. */
  readonly model: string
  readonly provider: string
  readonly stream: boolean
}

/**
 * Log the model a chat request resolved to. The `request` and `response` lines carry no model, so
 * without this a call cannot be traced to the model that served it. Logs ids only, never message
 * content or credentials.
 */
export function logChatRequest(context: LogContext, details: ChatRequestLogDetails): void {
  writeLogLine('info', 'chat_request', {
    requestId: context.requestId,
    clientRequestId: context.clientRequestId,
    method: context.method,
    path: context.path,
    requestedModel: details.requestedModel,
    model: details.model,
    provider: details.provider,
    stream: details.stream
  })
}

export function logResponse(context: LogContext, status: number, durationMs: number): void {
  writeLogLine('info', 'response', {
    requestId: context.requestId,
    status,
    durationMs: Math.round(durationMs)
  })
}

export function logError(context: LogContext, message: string, detail?: string): void {
  writeLogLine('error', 'error', {
    requestId: context.requestId,
    message,
    detail
  })
}

export function logDisconnect(context: LogContext): void {
  writeLogLine('info', 'disconnect', {
    requestId: context.requestId
  })
}

export function logUpstreamOverload(context: LogContext, status: number, code: string): void {
  writeLogLine('warn', 'upstream_overload', {
    requestId: context.requestId,
    upstreamStatus: status,
    code
  })
}

export function logStartup(host: string, port: number, modelCount: number): void {
  writeLogLine('info', 'startup', {
    host,
    port,
    modelCount
  })
}

export function logShutdown(signal: string): void {
  writeLogLine('info', 'shutdown', {
    signal
  })
}

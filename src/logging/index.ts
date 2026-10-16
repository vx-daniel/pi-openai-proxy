/**
 * Logging for the proxy and its pi extension, on LogTape (https://logtape.org).
 *
 * Library-first: every module asks for a logger with `proxyLogger(...)` and logs; nothing is written
 * until an entry point configures LogTape. The proxy's CLI calls `configureLogging()` (stderr); the
 * extension calls `configureFileLogging()` only when `PI_PROXY_EXTENSION_LOG_FILE` is set, because
 * console output would corrupt pi's terminal UI.
 *
 * CATEGORIES — every logger sits under `ROOT_CATEGORY`, so one `lowestLevel` governs them all:
 *   server             lifecycle: startup, shutdown
 *   server.http        one line per request and per response; client disconnects
 *   server.auth        proxy authentication decisions
 *   server.chat        the chat completions route: model resolution, dispatch, upstream errors
 *   server.health      failed /healthz detail checks (a passing check logs nothing above debug)
 *   config             config file, env var and CLI resolution
 *   openai.messages    message conversion          openai.tools       tool conversion
 *   openai.sse         streaming responses         openai.responses   non-streaming responses
 *   openai.exposure    model exposure and IDs      openai.validate    request validation
 *   openai.schema      JSON Schema → TypeBox
 *   pi.registry        pi's model runtime          pi.complete        upstream calls
 *   sync.zed           Zed settings sync
 *   extension.*        the pi extension (process, settings, reports, zed-sync)
 *
 * LEVELS:
 *   trace    per streamed event or chunk
 *   debug    per-request internal decisions and counts
 *   info     lifecycle, and one line per request and response
 *   warning  recoverable problems: rejected input, upstream overload, fallbacks
 *   error    failures that end a request with a 5xx, or a feature that stops working
 *   fatal    the process cannot continue
 *
 * NEVER LOG message or prompt content, tool arguments, image data, or credentials (API keys, auth
 * tokens, Authorization headers). Log ids, counts, sizes and durations instead. `REDACTED_FIELDS` is
 * a backstop for a mistake, not permission to log a secret.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { getFileSink } from '@logtape/file'
import {
  configureSync,
  getLogger,
  jsonLinesFormatter,
  type Logger,
  type LoggerConfig,
  type LogLevel,
  type Sink,
  type TextFormatter
} from '@logtape/logtape'
import { getPrettyFormatter } from '@logtape/pretty'
import { redactByField } from '@logtape/redaction'

/** The category every logger in this package sits under. */
export const ROOT_CATEGORY = 'pi-openai-proxy'

/** A logger in this package's category tree: `proxyLogger('server', 'http')`. */
export function proxyLogger(...subcategories: readonly string[]): Logger {
  return getLogger([ROOT_CATEGORY, ...subcategories])
}

/**
 * Property names whose values are replaced before any sink sees them. Exact names, not LogTape's
 * default patterns: those match `/token/i` and `/key/i`, which would also redact token usage counts
 * and cache keys this package logs on purpose.
 */
export const REDACTED_FIELDS: readonly string[] = [
  'apiKey',
  'upstreamApiKey',
  'authToken',
  'proxyAuthToken',
  'authorization',
  'accessToken',
  'refreshToken',
  'password',
  'secret'
]

/** `pretty` for a person at a terminal, `json` (JSON Lines) for anything that parses logs. */
export type LogFormat = 'pretty' | 'json'

export const LOG_FORMATS: readonly LogFormat[] = ['pretty', 'json']

export function isLogFormat(value: string): value is LogFormat {
  return value === 'pretty' || value === 'json'
}

/** Pretty when stderr is a terminal, JSON Lines when it is piped or redirected. */
export function defaultLogFormat(): LogFormat {
  return process.stderr.isTTY ? 'pretty' : 'json'
}

/**
 * The format to log in: the `--log-format` flag, then `PI_PROXY_LOG_FORMAT`, then
 * `defaultLogFormat()`. A value that names no format is skipped; the caller reports it.
 */
export function resolveLogFormat(
  flagFormat: string | undefined,
  envFormat: string | undefined,
  fallback: () => LogFormat = defaultLogFormat
): LogFormat {
  const chosen = [flagFormat, envFormat].find(
    (candidate): candidate is LogFormat => candidate !== undefined && isLogFormat(candidate)
  )
  return chosen ?? fallback()
}

function formatterFor(format: LogFormat): TextFormatter {
  // JSON keeps LogTape's UTC `@timestamp`: unambiguous for anything that parses or ships logs.
  if (format === 'json') return jsonLinesFormatter
  // A person reads local time: `timeZone: null` is the system zone (the `TZ` variable in a
  // container), with the offset shown so a line is never ambiguous. `bare` prints strings without
  // quotes: a reader wants `GET /v1/models`, not `'GET'`.
  return getPrettyFormatter({
    timestamp: 'date-time-tz',
    timeZone: null,
    categoryWidth: 32,
    value: 'bare',
    wordWrap: false
  })
}

function redacted(sink: Sink): Sink {
  return redactByField(sink, { fieldPatterns: [...REDACTED_FIELDS], action: () => '[REDACTED]' })
}

/** The package's logger plus LogTape's own meta logger, both on one sink. */
function loggerConfigs(level: LogLevel, sink: string): LoggerConfig<string, string>[] {
  return [
    { category: ROOT_CATEGORY, lowestLevel: level, sinks: [sink] },
    { category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: [sink] }
  ]
}

export interface LoggingOptions {
  readonly level: LogLevel
  readonly format: LogFormat
  /**
   * Where formatted lines go. Default: `process.stderr.write`, which Node performs synchronously for
   * a terminal or a file and asynchronously for a pipe (POSIX): a piped reader that stops reading
   * makes the queued lines pile up in this process's memory.
   */
  readonly write?: (line: string) => void
}

/**
 * Configure LogTape for the proxy process. Replaces any earlier configuration. Request handlers run
 * inside `withContext()`, which needs the async-local storage set up here.
 */
export function configureLogging(options: LoggingOptions): void {
  const formatter = formatterFor(options.format)
  const write = options.write ?? ((line: string) => process.stderr.write(line))
  configureSync({
    reset: true,
    sinks: { stderr: redacted((record) => write(formatter(record))) },
    loggers: loggerConfigs(options.level, 'stderr'),
    contextLocalStorage: new AsyncLocalStorage()
  })
}

/**
 * Configure LogTape to append JSON Lines to `path`: the pi extension's opt-in log, because it must
 * never write to the terminal pi draws on. Replaces any earlier configuration.
 */
export function configureFileLogging(path: string, level: LogLevel): void {
  configureSync({
    reset: true,
    sinks: { file: redacted(getFileSink(path, { formatter: jsonLinesFormatter })) },
    loggers: loggerConfigs(level, 'file'),
    contextLocalStorage: new AsyncLocalStorage()
  })
}

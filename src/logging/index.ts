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

/** Pretty when stderr is a terminal, JSON Lines when it is piped or redirected. */
export function defaultLogFormat(): LogFormat {
  return process.stderr.isTTY ? 'pretty' : 'json'
}

function formatterFor(format: LogFormat): TextFormatter {
  if (format === 'json') return jsonLinesFormatter
  // `bare` prints strings without quotes: a terminal reader wants `GET /v1/models`, not `'GET'`.
  return getPrettyFormatter({
    timestamp: 'time',
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
  /** Where formatted lines go. Default: stderr, written synchronously so nothing is lost on exit. */
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

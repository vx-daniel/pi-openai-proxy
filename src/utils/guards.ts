/**
 * Shared type guard utilities.
 */

/**
 * Narrow `unknown` to `Record<string, unknown>`.
 * Rejects null, undefined, and arrays.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Node's error code (`ENOENT`, `EACCES`, …) or the error's name; never its message, which can quote
 * paths, file contents or a request. For log lines.
 */
export function errorCode(error: unknown): string {
  if (isRecord(error) && typeof error['code'] === 'string') return error['code']
  return error instanceof Error ? error.name : 'unknown'
}

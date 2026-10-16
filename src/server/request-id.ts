/**
 * Per-request proxy request ID generation.
 *
 * Format: "piproxy-{random}" to be easily distinguishable from upstream IDs.
 */

import { randomBytes } from 'node:crypto'

const REQUEST_ID_BYTES = 12

export function generateRequestId(): string {
  return `piproxy-${randomBytes(REQUEST_ID_BYTES).toString('hex')}`
}

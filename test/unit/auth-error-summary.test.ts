/**
 * What `/healthz/creds?verify=true` may say about a failed credential: pi's summary and the token
 * URL, never the token endpoint's response body or the stack with the install's file paths.
 */

import { summarizeAuthError } from '@proxy/pi/registry'
import { describe, expect, test } from 'vite-plus/test'

// The shape pi 1.3 throws for a rejected Anthropic refresh, captured from a real failure.
const REFRESH_FAILURE =
  'OAuth refresh failed for anthropic: Anthropic token refresh request failed. ' +
  'url=https://platform.claude.com/v1/oauth/token; details=Error: HTTP request failed. ' +
  'status=400; url=https://platform.claude.com/v1/oauth/token; ' +
  'body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}; ' +
  'stack=Error: HTTP request failed.\n    at postJson (file:///app/node_modules/x.js:1:1)'

describe('summarizeAuthError', () => {
  // Catches the upstream body or the stack reaching an HTTP response.
  test('keeps the summary and status, drops the body, details and stack', () => {
    expect(summarizeAuthError(REFRESH_FAILURE)).toBe(
      'OAuth refresh failed for anthropic: Anthropic token refresh request failed. ' +
        'url=https://platform.claude.com/v1/oauth/token (HTTP 400)'
    )
  })

  test('keeps a message without detail fields as it is, to its first line', () => {
    expect(summarizeAuthError('no credentials for provider x\nsecond line')).toBe(
      'no credentials for provider x'
    )
  })
})

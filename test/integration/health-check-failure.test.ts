/**
 * Health detail checks that throw. This file never initializes pi's model runtime, so every lookup
 * the checks make throws ("ModelRuntime not initialized"), the way an unreadable config or a pi
 * failure would in a running proxy.
 */

import { describe, expect, test } from 'vite-plus/test'

import { testApp } from '../helpers'

describe('a health detail check that throws', () => {
  // Catches a throwing check answering as a bare 500, or its error text (which can name files or
  // quote config) reaching the response instead of the proxy log.
  test.each([
    ['/healthz/models', 'models'],
    ['/healthz/creds', 'credentials'],
    ['/healthz/creds?verify=true', 'credentials']
  ])('%s answers 503 with a pointer to the log, not the error', async (path, check) => {
    const response = await testApp().request(path)
    const text = await response.text()

    expect(response.status).toBe(503)
    expect(JSON.parse(text)).toEqual({
      status: 'unavailable',
      error: `the ${check} check failed; see the proxy log`
    })
    expect(text).not.toContain('not initialized')
  })

  // Catches the failure of a detail check taking liveness down with it.
  test('/healthz still answers 200', async () => {
    expect((await testApp().request('/healthz')).status).toBe(200)
  })
})

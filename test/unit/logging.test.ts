/**
 * The logging pipeline (src/logging): what reaches the output, in which shape, at which level.
 */

import { resetSync } from '@logtape/logtape'
import { configureLogging, proxyLogger, type LogFormat } from '@proxy/logging'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

let lines: string[] = []

function capture(level: 'debug' | 'info', format: LogFormat = 'json'): void {
  lines = []
  configureLogging({ level, format, write: (line) => lines.push(line) })
}

function records(): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}

afterEach(() => {
  resetSync()
})

describe('JSON Lines output', () => {
  // Catches a log shipper losing records: one JSON object per line, with the category path, level,
  // rendered message and the structured properties.
  test('writes one parseable line per record with logger, level, message and properties', () => {
    capture('info')
    proxyLogger('server', 'http').info('{method} {path} received', {
      method: 'GET',
      path: '/v1/models'
    })

    expect(lines).toHaveLength(1)
    expect(lines[0]?.endsWith('\n')).toBe(true)
    expect(records()[0]).toMatchObject({
      level: 'INFO',
      logger: 'pi-openai-proxy.server.http',
      // The rendered message quotes string values, so a value can never pose as message text.
      message: '"GET" "/v1/models" received',
      properties: { method: 'GET', path: '/v1/models' }
    })
  })

  // A model string or path comes from the client; encoding must keep a hostile one on one line,
  // so it cannot forge a second record.
  test('keeps a property containing a newline on a single line', () => {
    capture('info')
    proxyLogger('server', 'chat').info('Chat request for {requestedModel}', {
      requestedModel: 'evil"\n{"level":"FATAL"}'
    })

    expect(lines).toHaveLength(1)
    expect(lines[0]?.slice(0, -1)).not.toContain('\n')
    expect(records()[0]?.['properties']).toEqual({ requestedModel: 'evil"\n{"level":"FATAL"}' })
  })
})

describe('levels', () => {
  // Catches the configured level not reaching the package's loggers.
  test('drops records below the configured level and keeps the rest', () => {
    capture('info')
    const logger = proxyLogger('openai', 'messages')
    logger.debug('Converted {messageCount} messages', { messageCount: 3 })
    logger.warn('Rejected a tool')

    expect(records().map((record) => record['level'])).toEqual(['WARN'])
  })

  test('writes debug records when the level is debug', () => {
    capture('debug')
    proxyLogger('openai', 'messages').debug('Converted {messageCount} messages', {
      messageCount: 3
    })

    expect(records()).toHaveLength(1)
  })
})

describe('redaction', () => {
  // Catches a credential reaching the output through a property name the redaction list covers.
  test('replaces credential properties and leaves token counts alone', () => {
    capture('info')
    proxyLogger('server', 'auth').info('Checked credentials', {
      authToken: 'sk-notarealsecret',
      upstreamApiKey: 'notarealsecret-key',
      promptTokens: 12
    })

    expect(lines.join('')).not.toContain('notarealsecret')
    expect(records()[0]?.['properties']).toEqual({
      authToken: '[REDACTED]',
      upstreamApiKey: '[REDACTED]',
      promptTokens: 12
    })
  })
})

describe('pretty output', () => {
  // Catches the terminal format writing JSON, or losing the message, when stderr is a TTY.
  test('renders the message for a person rather than as JSON', () => {
    capture('info', 'pretty')
    proxyLogger('server').info('Listening on {port}', { port: 4141 })

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('Listening on')
    expect(lines[0]).toContain('4141')
    expect(lines[0]?.trimStart().startsWith('{')).toBe(false)
  })

  // Catches the terminal format falling back to UTC: a person reads the zone the machine (or the
  // container's `TZ`) is in, with the offset shown, and the date, for long-running containers.
  test('stamps each line with the local date, time and offset', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo')
    try {
      capture('info', 'pretty')
      proxyLogger('server').info('Listening')
    } finally {
      vi.unstubAllEnvs()
    }

    // oxlint-disable-next-line no-control-regex -- strips the formatter's ANSI color codes
    const plain = (lines[0] ?? '').replaceAll(/\u001b\[[0-9;]*m/g, '')
    expect(plain).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \+09 /)
  })
})

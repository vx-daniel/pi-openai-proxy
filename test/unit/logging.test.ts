/**
 * The logging pipeline (src/logging): what reaches the output, in which shape, at which level.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dispose, resetSync } from '@logtape/logtape'
import {
  configureFileLogging,
  configureLogging,
  type LogFormat,
  proxyLogger,
  resolveLogFormat
} from '@proxy/logging'
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
  /**
   * The property names that must never reach a log, written out here rather than read from
   * REDACTED_FIELDS: dropping one from that list has to fail this test.
   */
  const MUST_REDACT = [
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
  /** One property per name, each holding a fake secret, plus a count that must survive. */
  const credentialProperties = Object.fromEntries(
    MUST_REDACT.map((field) => [field, `notarealsecret-${field}`])
  )
  const expectedProperties = {
    ...Object.fromEntries(MUST_REDACT.map((field) => [field, '[REDACTED]'])),
    promptTokens: 12
  }

  // Catches a credential reaching stderr through any property name on the list (one dropped from
  // REDACTED_FIELDS, or the list not applied), or redaction swallowing token counts.
  test('stderr: every listed property is replaced and token counts are left alone', () => {
    capture('info')
    proxyLogger('server', 'auth').info('Checked credentials', {
      ...credentialProperties,
      promptTokens: 12
    })

    expect(lines.join('')).not.toContain('notarealsecret')
    expect(records()[0]?.['properties']).toEqual(expectedProperties)
  })

  // Catches the extension's file log (PI_PROXY_EXTENSION_LOG_FILE) skipping the redaction stderr
  // gets: it is a separate sink, configured separately.
  test('file sink: every listed property is replaced there too', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-proxy-log-file-'))
    const path = join(directory, 'extension.log')
    try {
      configureFileLogging(path, 'info')
      proxyLogger('extension', 'process').info('Spawned the proxy', {
        ...credentialProperties,
        promptTokens: 12
      })
      // Flushes the file sink.
      await dispose()

      const text = readFileSync(path, 'utf8')
      expect(text).not.toContain('notarealsecret')
      const [record] = text.trim().split('\n')
      expect(JSON.parse(record ?? '{}')).toMatchObject({ properties: expectedProperties })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
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

describe('log format choice', () => {
  const terminal = (): LogFormat => 'pretty'

  // Catches the env var beating an explicit flag, or a typo in either replacing the default with
  // nothing: the flag wins, then the env var, then the terminal check, and a bad value is skipped.
  test.each([
    { flag: 'json', env: 'pretty', expected: 'json' },
    { flag: undefined, env: 'json', expected: 'json' },
    { flag: undefined, env: undefined, expected: 'pretty' },
    { flag: undefined, env: 'fancy', expected: 'pretty' },
    { flag: 'fancy', env: 'json', expected: 'json' }
  ])('flag $flag and env $env give $expected', ({ flag, env, expected }) => {
    expect(resolveLogFormat(flag, env, terminal)).toBe(expected)
  })
})

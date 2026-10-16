/**
 * Where the proxy's log level comes from: `--log-level` over `PI_PROXY_LOG_LEVEL` over `logLevel` in
 * the config file over the `info` default, and what an invalid value at each source does.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetSync } from '@logtape/logtape'
import { loadConfig } from '@proxy/config/env'
import { configureLogging } from '@proxy/logging'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

let agentDir = ''
let lines: string[] = []

function writeConfigFile(contents: Record<string, unknown>): void {
  writeFileSync(join(agentDir, 'proxy-config.json'), JSON.stringify(contents))
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'pi-proxy-log-level-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
  vi.stubEnv('PI_PROXY_LOG_LEVEL', undefined)
  lines = []
  configureLogging({ level: 'warning', format: 'json', write: (line) => lines.push(line) })
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetSync()
  rmSync(agentDir, { recursive: true, force: true })
})

describe('log level precedence', () => {
  test('defaults to info with no file, env or flag', () => {
    expect(loadConfig().logLevel).toBe('info')
  })

  test('the config file sets it', () => {
    writeConfigFile({ logLevel: 'debug' })
    expect(loadConfig().logLevel).toBe('debug')
  })

  test('PI_PROXY_LOG_LEVEL overrides the config file', () => {
    writeConfigFile({ logLevel: 'debug' })
    vi.stubEnv('PI_PROXY_LOG_LEVEL', 'error')
    expect(loadConfig().logLevel).toBe('error')
  })

  test('--log-level overrides the env var and the config file', () => {
    writeConfigFile({ logLevel: 'debug' })
    vi.stubEnv('PI_PROXY_LOG_LEVEL', 'error')
    expect(loadConfig({ logLevel: 'trace' }).logLevel).toBe('trace')
  })
})

describe('invalid values', () => {
  // Catches a typo in the environment silently changing the level, or stopping the proxy.
  test('an invalid PI_PROXY_LOG_LEVEL falls back to the config file, with a warning', () => {
    writeConfigFile({ logLevel: 'debug' })
    vi.stubEnv('PI_PROXY_LOG_LEVEL', 'loud')

    expect(loadConfig().logLevel).toBe('debug')
    expect(lines.join('')).toContain('PI_PROXY_LOG_LEVEL')
  })

  test('an invalid logLevel in the config file falls back to info', () => {
    writeConfigFile({ logLevel: 'loud' })
    expect(loadConfig().logLevel).toBe('info')
  })
})

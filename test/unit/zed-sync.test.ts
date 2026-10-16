/**
 * Unit tests for extensions/zed-sync.ts
 *
 * Tests cover:
 * - findZedSettings: path resolution with env overrides
 * - toZedModel: ExposedModel -> Zed available_models mapping
 * - syncToZed: JSONC read/write with comment preservation
 * - readCurrentModelNames: extracting model names from parsed JSONC
 * - Dry-run mode: diff computation without writing
 * - Edge cases: missing provider block, empty models, malformed JSONC
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import type { Api, Model } from '@earendil-works/pi-ai'
import { resetSync } from '@logtape/logtape'
import { configureLogging } from '@proxy/logging'
import type { ExposedModel } from '@proxy/openai/model-exposure'
import { findZedSettings, syncToZed, toZedModel } from '@proxy/sync/zed'
import { isRecord } from '@proxy/utils/guards'
import { type ParseError, parse } from 'jsonc-parser'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 64000,
    ...overrides
  }
}

function makeExposed(overrides: Partial<ExposedModel> = {}): ExposedModel {
  return {
    publicId: 'anthropic/claude-sonnet-4-20250514',
    canonicalId: 'anthropic/claude-sonnet-4-20250514',
    model: makeModel(),
    provider: 'anthropic',
    ...overrides
  }
}

const ZED_SETTINGS_WITH_COMMENTS = `// Zed settings
// Some comments that must be preserved
{
  // Editor settings
  "buffer_font_size": 15,
  "language_models": {
    "openai_compatible": {
      "Pi Proxy": {
        "api_url": "http://127.0.0.1:4141/v1",
        "available_models": [
          {
            "name": "old-model",
            "display_name": "Old Model",
            "max_tokens": 100000,
            "max_output_tokens": 8000,
            "capabilities": {
              "tools": true,
              "images": false,
              "parallel_tool_calls": true,
              "prompt_cache_key": false,
              "chat_completions": true
            }
          }
        ]
      }
    }
  },
  // Theme
  "theme": "Gruvbox Dark"
}
`

const MINIMAL_ZED_SETTINGS = `{
  "buffer_font_size": 15,
  "theme": "Gruvbox Dark"
}
`

/** What `MINIMAL_ZED_SETTINGS` and `ZED_SETTINGS_WITH_COMMENTS` hold outside `language_models`. */
const MINIMAL_OTHER_SETTINGS = { buffer_font_size: 15, theme: 'Gruvbox Dark' }

const DEFAULT_API_URL = 'http://127.0.0.1:4141/v1'

/** The Zed entry for `makeExposed()`. */
const CLAUDE_ZED_MODEL = {
  name: 'anthropic/claude-sonnet-4-20250514',
  display_name: 'Claude Sonnet 4',
  max_tokens: 200000,
  max_output_tokens: 64000,
  capabilities: {
    tools: true,
    images: true,
    parallel_tool_calls: true,
    prompt_cache_key: false,
    chat_completions: true
  }
}

/** `language_models` holding only the "Pi Proxy" provider block. */
function piProxyModels(apiUrl: string, availableModels: readonly unknown[]): unknown {
  return {
    openai_compatible: { 'Pi Proxy': { api_url: apiUrl, available_models: availableModels } }
  }
}

/** The settings file as Zed reads it: JSONC with trailing commas. A syntax error fails the test. */
function writtenSettings(path: string): unknown {
  const errors: ParseError[] = []
  const settings: unknown = parse(readFileSync(path, 'utf-8'), errors, { allowTrailingComma: true })
  expect(errors).toEqual([])
  return settings
}

// ---------------------------------------------------------------------------
// toZedModel
// ---------------------------------------------------------------------------

describe('toZedModel', () => {
  test('maps ExposedModel fields correctly', () => {
    const exposed = makeExposed()
    const result = toZedModel(exposed)

    expect(result.name).toBe('anthropic/claude-sonnet-4-20250514')
    expect(result.display_name).toBe('Claude Sonnet 4')
    expect(result.max_tokens).toBe(200000)
    expect(result.max_output_tokens).toBe(64000)
    expect(result.capabilities.tools).toBe(true)
    expect(result.capabilities.images).toBe(true)
    expect(result.capabilities.chat_completions).toBe(true)
    expect(result.capabilities.parallel_tool_calls).toBe(true)
    expect(result.capabilities.prompt_cache_key).toBe(false)
  })

  test('sets images=false for text-only models', () => {
    const exposed = makeExposed({
      model: makeModel({ input: ['text'] })
    })
    const result = toZedModel(exposed)
    expect(result.capabilities.images).toBe(false)
  })

  test('uses publicId as name', () => {
    const exposed = makeExposed({ publicId: 'custom-prefix/my-model' })
    const result = toZedModel(exposed)
    expect(result.name).toBe('custom-prefix/my-model')
  })
})

// ---------------------------------------------------------------------------
// findZedSettings
// ---------------------------------------------------------------------------

describe('findZedSettings', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = resolve(
      tmpdir(),
      `zed-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('returns CUSTOM_DATA_DIR path when set and file exists', () => {
    const customDir = resolve(tempDir, 'custom-zed')
    mkdirSync(customDir, { recursive: true })
    writeFileSync(resolve(customDir, 'settings.json'), '{}')

    vi.stubEnv('CUSTOM_DATA_DIR', customDir)
    // Clear others to isolate
    vi.stubEnv('HOME', undefined)
    vi.stubEnv('XDG_CONFIG_HOME', undefined)

    expect(findZedSettings()).toBe(resolve(customDir, 'settings.json'))
  })

  test('falls back to HOME/.config/zed when CUSTOM_DATA_DIR is unset', () => {
    vi.stubEnv('CUSTOM_DATA_DIR', undefined)
    const zedDir = resolve(tempDir, '.config', 'zed')
    mkdirSync(zedDir, { recursive: true })
    writeFileSync(resolve(zedDir, 'settings.json'), '{}')

    vi.stubEnv('HOME', tempDir)
    vi.stubEnv('XDG_CONFIG_HOME', undefined)

    expect(findZedSettings()).toBe(resolve(zedDir, 'settings.json'))
  })

  test('falls back to XDG_CONFIG_HOME when HOME config does not exist', () => {
    vi.stubEnv('CUSTOM_DATA_DIR', undefined)
    vi.stubEnv('HOME', resolve(tempDir, 'no-such-home'))

    const xdgDir = resolve(tempDir, 'xdg-config', 'zed')
    mkdirSync(xdgDir, { recursive: true })
    writeFileSync(resolve(xdgDir, 'settings.json'), '{}')
    vi.stubEnv('XDG_CONFIG_HOME', resolve(tempDir, 'xdg-config'))

    expect(findZedSettings()).toBe(resolve(xdgDir, 'settings.json'))
  })

  test('returns undefined when no config found', () => {
    vi.stubEnv('CUSTOM_DATA_DIR', undefined)
    vi.stubEnv('HOME', resolve(tempDir, 'no-such-home'))
    vi.stubEnv('XDG_CONFIG_HOME', undefined)

    expect(findZedSettings()).toBeUndefined()
  })

  test('CUSTOM_DATA_DIR takes priority over HOME', () => {
    const customDir = resolve(tempDir, 'custom-zed')
    mkdirSync(customDir, { recursive: true })
    writeFileSync(resolve(customDir, 'settings.json'), '{}')

    const homeZedDir = resolve(tempDir, '.config', 'zed')
    mkdirSync(homeZedDir, { recursive: true })
    writeFileSync(resolve(homeZedDir, 'settings.json'), '{}')

    vi.stubEnv('CUSTOM_DATA_DIR', customDir)
    vi.stubEnv('HOME', tempDir)

    expect(findZedSettings()).toBe(resolve(customDir, 'settings.json'))
  })
})

// ---------------------------------------------------------------------------
// syncToZed
// ---------------------------------------------------------------------------

describe('syncToZed', () => {
  let tempDir: string
  let settingsPath: string

  beforeEach(() => {
    tempDir = resolve(
      tmpdir(),
      `zed-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    const zedDir = resolve(tempDir, '.config', 'zed')
    mkdirSync(zedDir, { recursive: true })
    settingsPath = resolve(zedDir, 'settings.json')

    // Point findZedSettings to our temp dir
    vi.stubEnv('CUSTOM_DATA_DIR', undefined)
    vi.stubEnv('XDG_CONFIG_HOME', undefined)
    vi.stubEnv('HOME', tempDir)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(tempDir, { recursive: true, force: true })
  })

  // Catches models missing, misordered or mis-mapped in the written file, or the old ones kept.
  test('syncs models into existing provider block', () => {
    writeFileSync(settingsPath, ZED_SETTINGS_WITH_COMMENTS)

    const models = [
      makeExposed(),
      makeExposed({
        publicId: 'openai/gpt-5.4-mini',
        canonicalId: 'openai/gpt-5.4-mini',
        provider: 'openai',
        model: makeModel({
          id: 'gpt-5.4-mini',
          name: 'GPT-5.4 Mini',
          provider: 'openai',
          input: ['text'],
          contextWindow: 128000,
          maxTokens: 32000
        })
      })
    ]

    const result = syncToZed(models, {
      providerName: 'Pi Proxy',
      apiUrl: 'http://127.0.0.1:4141/v1',
      dryRun: false
    })

    expect(result.ok).toBe(true)
    expect(result.added).toBe(2)
    expect(result.removed).toBe(1)
    expect(result.configPath).toBe(settingsPath)

    expect(writtenSettings(settingsPath)).toEqual({
      ...MINIMAL_OTHER_SETTINGS,
      language_models: piProxyModels(DEFAULT_API_URL, [
        CLAUDE_ZED_MODEL,
        {
          name: 'openai/gpt-5.4-mini',
          display_name: 'GPT-5.4 Mini',
          max_tokens: 128000,
          max_output_tokens: 32000,
          capabilities: {
            tools: true,
            images: false,
            parallel_tool_calls: true,
            prompt_cache_key: false,
            chat_completions: true
          }
        }
      ])
    })
  })

  test('preserves JSONC comments', () => {
    writeFileSync(settingsPath, ZED_SETTINGS_WITH_COMMENTS)

    const result = syncToZed([makeExposed()], {
      providerName: 'Pi Proxy',
      apiUrl: 'http://127.0.0.1:4141/v1',
      dryRun: false
    })

    expect(result.ok).toBe(true)
    const content = readFileSync(settingsPath, 'utf-8')
    expect(content).toContain('// Zed settings')
    expect(content).toContain('// Editor settings')
    expect(content).toContain('// Theme')
  })

  // Catches the provider block not created, created at the wrong path, or written without the
  // requested api_url, in settings without one.
  test('creates provider block with the requested api_url when it does not exist', () => {
    writeFileSync(settingsPath, MINIMAL_ZED_SETTINGS)

    const result = syncToZed([makeExposed()], {
      providerName: 'Pi Proxy',
      apiUrl: 'http://192.168.1.100:8080/v1',
      dryRun: false
    })

    expect(result.ok).toBe(true)
    expect(result.added).toBe(1)
    expect(result.removed).toBe(0)

    expect(writtenSettings(settingsPath)).toEqual({
      ...MINIMAL_OTHER_SETTINGS,
      language_models: piProxyModels('http://192.168.1.100:8080/v1', [CLAUDE_ZED_MODEL])
    })
  })

  test('dry-run does not write to disk', () => {
    writeFileSync(settingsPath, ZED_SETTINGS_WITH_COMMENTS)

    const result = syncToZed([makeExposed()], {
      providerName: 'Pi Proxy',
      apiUrl: 'http://127.0.0.1:4141/v1',
      dryRun: true
    })

    expect(result.ok).toBe(true)
    expect(result.summary).toContain('[dry-run]')

    // File should be unchanged
    const content = readFileSync(settingsPath, 'utf-8')
    expect(content).toBe(ZED_SETTINGS_WITH_COMMENTS)
  })

  test('reports correct diff counts', () => {
    writeFileSync(settingsPath, ZED_SETTINGS_WITH_COMMENTS)

    // old-model exists, we sync claude which is new -> 1 added, 1 removed
    const result = syncToZed([makeExposed()], {
      providerName: 'Pi Proxy',
      apiUrl: 'http://127.0.0.1:4141/v1',
      dryRun: true
    })

    expect(result.added).toBe(1)
    expect(result.removed).toBe(1)
    expect(result.unchanged).toBe(0)
  })

  test('reports unchanged when models match', () => {
    // Write settings with the exact model we will sync
    const settingsWithClaude = `{
  "language_models": {
    "openai_compatible": {
      "Pi Proxy": {
        "api_url": "http://127.0.0.1:4141/v1",
        "available_models": [
          {
            "name": "anthropic/claude-sonnet-4-20250514",
            "display_name": "Claude Sonnet 4",
            "max_tokens": 200000,
            "max_output_tokens": 64000
          }
        ]
      }
    }
  }
}
`
    writeFileSync(settingsPath, settingsWithClaude)

    const result = syncToZed([makeExposed()], {
      providerName: 'Pi Proxy',
      apiUrl: 'http://127.0.0.1:4141/v1',
      dryRun: true
    })

    expect(result.added).toBe(0)
    expect(result.removed).toBe(0)
    expect(result.unchanged).toBe(1)
  })

  // Catches an empty sync leaving the old models in place, or deleting the provider block.
  test('handles empty model list (removes all)', () => {
    writeFileSync(settingsPath, ZED_SETTINGS_WITH_COMMENTS)

    const result = syncToZed([], {
      providerName: 'Pi Proxy',
      apiUrl: 'http://127.0.0.1:4141/v1',
      dryRun: false
    })

    expect(result.ok).toBe(true)
    expect(result.removed).toBe(1)
    expect(result.added).toBe(0)

    expect(writtenSettings(settingsPath)).toEqual({
      ...MINIMAL_OTHER_SETTINGS,
      language_models: piProxyModels(DEFAULT_API_URL, [])
    })
  })

  test('returns error when settings file not found', () => {
    // Point HOME to non-existent dir
    vi.stubEnv('HOME', resolve(tempDir, 'no-such-dir'))

    const result = syncToZed([makeExposed()], {
      providerName: 'Pi Proxy',
      apiUrl: 'http://127.0.0.1:4141/v1',
      dryRun: false
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('not found')
  })

  // Catches the sync replacing the whole openai_compatible map, dropping other providers.
  test('preserves other providers in openai_compatible', () => {
    const settingsWithMultipleProviders = `{
  "language_models": {
    "openai_compatible": {
      "Other Provider": {
        "api_url": "https://other.example.com/v1",
        "available_models": [
          { "name": "other-model", "max_tokens": 4096 }
        ]
      },
      "Pi Proxy": {
        "api_url": "http://127.0.0.1:4141/v1",
        "available_models": [
          { "name": "old-model", "max_tokens": 100000 }
        ]
      }
    }
  }
}
`
    writeFileSync(settingsPath, settingsWithMultipleProviders)

    syncToZed([makeExposed()], {
      providerName: 'Pi Proxy',
      apiUrl: 'http://127.0.0.1:4141/v1',
      dryRun: false
    })

    expect(writtenSettings(settingsPath)).toEqual({
      language_models: {
        openai_compatible: {
          'Other Provider': {
            api_url: 'https://other.example.com/v1',
            available_models: [{ name: 'other-model', max_tokens: 4096 }]
          },
          'Pi Proxy': { api_url: DEFAULT_API_URL, available_models: [CLAUDE_ZED_MODEL] }
        }
      }
    })
  })

  describe('when the settings file is not valid JSONC', () => {
    // A missing comma, and a value from the user's own settings that must not reach a log.
    const MALFORMED = `{
  // my settings
  "theme": "One Dark",
  "language_models": { "openai_compatible": { "Pi Proxy": { "api_url": "http://x", "available_models": [] } } }
  "assistant": { "api_key": "notarealsecret-zed-user-value" }
}`
    let errors: unknown[] = []

    beforeEach(() => {
      errors = []
      configureLogging({
        level: 'info',
        format: 'json',
        write: (line) => {
          const record: unknown = JSON.parse(line)
          if (isRecord(record) && record['level'] === 'ERROR') errors.push(record)
        }
      })
    })

    afterEach(() => {
      resetSync()
    })

    // Catches the sync editing a file it could only partly parse: Zed cannot load it either, and
    // an edit placed from a partial parse can land anywhere in the user's settings.
    test.each([false, true])(
      'leaves the file byte-for-byte untouched and reports why (dry run: %s)',
      (dryRun) => {
        writeFileSync(settingsPath, MALFORMED)

        const result = syncToZed([makeExposed()], {
          providerName: 'Pi Proxy',
          apiUrl: 'http://127.0.0.1:4141/v1',
          dryRun
        })

        expect(readFileSync(settingsPath, 'utf-8')).toBe(MALFORMED)
        expect(result).toMatchObject({ ok: false, configPath: settingsPath })
        // The missing comma is reported where "assistant" starts: line 5, column 3.
        expect(result.error).toContain('syntax errors (CommaExpected at line 5, column 3)')
        expect(errors).toEqual([
          expect.objectContaining({
            properties: expect.objectContaining({
              configPath: settingsPath,
              firstErrorCode: 'CommaExpected',
              line: 5,
              column: 3
            }) as unknown
          })
        ])
        expect(JSON.stringify(errors)).not.toContain('notarealsecret')
      }
    )

    // Catches the check being stricter than Zed: trailing commas are valid Zed settings, and a
    // file with no value at all (new, emptied, or only comments) is empty settings, not broken.
    test.each([
      ['trailing commas', '{\n  "theme": "One Dark",\n}\n', { theme: 'One Dark' }],
      ['an empty file', '', {}],
      ['a blank file', '  \n\n', {}],
      ['only comments', '// Zed settings\n// nothing yet\n', {}]
    ])('still syncs a file with %s', (_case, text, otherSettings) => {
      writeFileSync(settingsPath, text)

      const result = syncToZed([makeExposed()], {
        providerName: 'Pi Proxy',
        apiUrl: 'http://127.0.0.1:4141/v1',
        dryRun: false
      })

      expect(result.ok).toBe(true)
      expect(writtenSettings(settingsPath)).toEqual({
        ...otherSettings,
        language_models: piProxyModels(DEFAULT_API_URL, [CLAUDE_ZED_MODEL])
      })
      expect(errors).toEqual([])
    })
  })

  describe('when the settings file cannot be read or written', () => {
    const READ_ONLY = 0o444
    let errors: unknown[] = []

    beforeEach(() => {
      errors = []
      configureLogging({
        level: 'info',
        format: 'json',
        write: (line) => {
          const record: unknown = JSON.parse(line)
          if (isRecord(record) && record['level'] === 'ERROR') errors.push(record['properties'])
        }
      })
    })

    afterEach(() => {
      resetSync()
    })

    const options = { providerName: 'Pi Proxy', apiUrl: 'http://127.0.0.1:4141/v1', dryRun: false }

    // Catches the fs error's message (which names files and can carry more than the path) being
    // logged instead of its code, the 3c3ac919 rule; and a failure going unlogged.
    test('a read failure is logged with the path and the error code only', () => {
      // A directory where the file should be: it exists, so the read is attempted, and fails.
      mkdirSync(settingsPath)

      expect(() => syncToZed([makeExposed()], options)).toThrow()
      expect(errors).toEqual([{ configPath: settingsPath, code: 'EISDIR' }])
    })

    // Root ignores file permissions, so there is no read-only file to fail on.
    test.skipIf(process.getuid?.() === 0)(
      'a write failure is logged with the path and the error code only',
      () => {
        writeFileSync(settingsPath, MINIMAL_ZED_SETTINGS)
        chmodSync(settingsPath, READ_ONLY)

        expect(() => syncToZed([makeExposed()], options)).toThrow()
        expect(errors).toEqual([{ configPath: settingsPath, code: 'EACCES' }])
      }
    )
  })
})

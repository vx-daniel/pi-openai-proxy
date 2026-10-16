/**
 * Unit tests for tool strict flag patching in pi/complete.ts.
 */

import { applyToolStrictFlags, collectToolStrictFlags } from '@proxy/pi/complete'
import { describe, expect, test } from 'vite-plus/test'

import { expectRecord, makeTool } from './payload-passthrough-helpers'

// --- collectToolStrictFlags ---

describe('collectToolStrictFlags', () => {
  test('returns undefined when tools is undefined', () => {
    expect(collectToolStrictFlags(undefined)).toBeUndefined()
  })

  test('returns undefined when tools array is empty', () => {
    expect(collectToolStrictFlags([])).toBeUndefined()
  })

  test('returns undefined when no tools have strict: true', () => {
    const tools = [makeTool('a'), makeTool('b', false), makeTool('c', null)]
    expect(collectToolStrictFlags(tools)).toBeUndefined()
  })

  test('collects strict: true flags by index', () => {
    const tools = [makeTool('a', true), makeTool('b', false), makeTool('c', true)]
    const flags = collectToolStrictFlags(tools)
    expect(flags).toBeDefined()
    expect(flags?.size).toBe(2)
    expect(flags?.get(0)).toBe(true)
    expect(flags?.has(1)).toBe(false)
    expect(flags?.get(2)).toBe(true)
  })

  test('single tool with strict: true', () => {
    const tools = [makeTool('only', true)]
    const flags = collectToolStrictFlags(tools)
    expect(flags).toBeDefined()
    expect(flags?.size).toBe(1)
    expect(flags?.get(0)).toBe(true)
  })

  test('strict: null is not treated as strict: true', () => {
    const tools = [makeTool('a', null)]
    expect(collectToolStrictFlags(tools)).toBeUndefined()
  })

  test('absent strict is not treated as strict: true', () => {
    const tools = [makeTool('a')]
    expect(collectToolStrictFlags(tools)).toBeUndefined()
  })
})

// --- applyToolStrictFlags ---

describe('applyToolStrictFlags', () => {
  test('patches strict: true on matching tool indexes', () => {
    const payload: Record<string, unknown> = {
      tools: [
        { type: 'function', function: { name: 'a', strict: false } },
        { type: 'function', function: { name: 'b', strict: false } },
        { type: 'function', function: { name: 'c', strict: false } }
      ]
    }
    const flags = new Map<number, true>([
      [0, true],
      [2, true]
    ])

    applyToolStrictFlags(payload, flags)

    expect(Array.isArray(payload['tools'])).toBe(true)
    const tools = payload['tools']
    expect(Array.isArray(tools)).toBe(true)
    if (!Array.isArray(tools)) return
    const fn0 = expectRecord(expectRecord(tools[0], 'tool[0]')['function'], 'tool[0].function')
    const fn1 = expectRecord(expectRecord(tools[1], 'tool[1]')['function'], 'tool[1].function')
    const fn2 = expectRecord(expectRecord(tools[2], 'tool[2]')['function'], 'tool[2].function')
    expect(fn0['strict']).toBe(true)
    expect(fn1['strict']).toBe(false)
    expect(fn2['strict']).toBe(true)
  })

  test('does nothing when payload has no tools array', () => {
    const payload: Record<string, unknown> = { model: 'test' }
    const flags = new Map<number, true>([[0, true]])

    expect(() => {
      applyToolStrictFlags(payload, flags)
    }).not.toThrow()
    expect(payload['tools']).toBeUndefined()
  })

  test('does nothing when tools is not an array', () => {
    const payload: Record<string, unknown> = { tools: 'not-an-array' }
    const flags = new Map<number, true>([[0, true]])

    applyToolStrictFlags(payload, flags)
    expect(payload['tools']).toBe('not-an-array')
  })

  test('handles index beyond tools array length gracefully', () => {
    const payload: Record<string, unknown> = {
      tools: [{ type: 'function', function: { name: 'a', strict: false } }]
    }
    const flags = new Map<number, true>([
      [0, true],
      [5, true] // beyond array length
    ])

    applyToolStrictFlags(payload, flags)

    expect(Array.isArray(payload['tools'])).toBe(true)
    const tools = payload['tools']
    if (!Array.isArray(tools)) return
    const fn0 = expectRecord(expectRecord(tools[0], 'tool[0]')['function'], 'tool[0].function')
    expect(fn0['strict']).toBe(true)
    // Index 5 is undefined, no crash
  })

  test('handles tool without function object gracefully', () => {
    const payload: Record<string, unknown> = {
      tools: [{ type: 'function' }] // missing function object
    }
    const flags = new Map<number, true>([[0, true]])

    expect(() => {
      applyToolStrictFlags(payload, flags)
    }).not.toThrow()
  })
})

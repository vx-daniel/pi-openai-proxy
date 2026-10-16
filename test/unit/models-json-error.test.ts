/**
 * `describeModelsJsonError` on the messages pi 1.3.0 produces, captured from real runs. The
 * JSON.parse wording differs between Node versions, so each form is pinned here directly rather
 * than through whichever one the test runner's Node gives.
 */

import { describeModelsJsonError } from '@proxy/pi/registry'
import { describe, expect, test } from 'vite-plus/test'

const FILE = '\n\nFile: /home/someone/.pi/agent/models.json'

describe('describeModelsJsonError', () => {
  // Catches the parse error's quote of the file (here, most of a key) surviving the reduction.
  test('drops the quoted text of a parse error', () => {
    const error = `Failed to parse models.json: Unexpected token 'o', ..."apiKey": notarealsec"... is not valid JSON${FILE}`

    expect(describeModelsJsonError(error)).toBe('models.json is not valid JSON')
  })

  test('keeps the line and column over the offset when both are given', () => {
    const error = `Failed to parse models.json: Expected double-quoted property name in JSON at position 54 (line 1 column 55)${FILE}`

    expect(describeModelsJsonError(error)).toBe('models.json is not valid JSON at line 1 column 55')
  })

  test('keeps the offset when it is all the parser gives', () => {
    const error = `Failed to parse models.json: Expected double-quoted property name in JSON at position 62${FILE}`

    expect(describeModelsJsonError(error)).toBe('models.json is not valid JSON at position 62')
  })

  // Catches the reduction hiding errors that quote no values, which tell the operator what to fix.
  test('passes load and schema errors through without the file path', () => {
    expect(
      describeModelsJsonError(
        `Failed to load models.json: EACCES: permission denied, open '/home/someone/.pi/agent/models.json'${FILE}`
      )
    ).toBe(
      "Failed to load models.json: EACCES: permission denied, open '/home/someone/.pi/agent/models.json'"
    )
    expect(
      describeModelsJsonError(
        `Invalid models.json schema:\n  - providers.x.apiKey: must be string${FILE}`
      )
    ).toBe('Invalid models.json schema:\n  - providers.x.apiKey: must be string')
  })
})

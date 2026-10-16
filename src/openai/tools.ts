/**
 * OpenAI function tools -> pi Tool conversion.
 *
 * Phase 2 contract:
 * - Convert OpenAI function tools to pi Tool definitions
 * - Reject unsupported JSON Schema constructs via json-schema-to-typebox
 * - Convert tool_choice to pi-compatible format
 */

import type { ConstrainedSamplingConfig, Tool } from '@earendil-works/pi-ai'
import { proxyLogger } from '@proxy/logging'
import { jsonSchemaToTypebox } from '@proxy/openai/json-schema-to-typebox'
import type { OpenAIFunctionTool } from '@proxy/openai/schemas'
import { type TSchema, Type } from 'typebox'

const toolsLogger = proxyLogger('openai', 'tools')

/**
 * pi's constrained sampling for a tool sent with `strict: true`. "prefer": strict wherever pi can
 * make it so (the model is strict-capable and the schema fits the provider's strict subset);
 * otherwise the tool is sent without strict, as before pi had this, rather than the request being
 * refused. "require" would refuse every strict tool on the many models pi does not mark
 * strict-capable, breaking clients that send `strict: true` by default (#44).
 */
const STRICT_SAMPLING: ConstrainedSamplingConfig = { type: 'json_schema', strict: 'prefer' }

export interface ToolConversionSuccess {
  readonly ok: true
  readonly tools: Tool[]
}

export interface ToolConversionError {
  readonly ok: false
  readonly message: string
  readonly param: string
}

export type ToolConversionResult = ToolConversionSuccess | ToolConversionError

/**
 * Convert an array of OpenAI function tool definitions to pi Tool definitions.
 */
export function convertTools(openaiTools: OpenAIFunctionTool[]): ToolConversionResult {
  const piTools: Tool[] = []

  for (let toolIndex = 0; toolIndex < openaiTools.length; toolIndex++) {
    const tool = openaiTools[toolIndex]
    if (tool === undefined) continue

    const fn = tool.function
    let parameters: TSchema

    if (fn.parameters === undefined) {
      // No parameters specified -- empty object
      parameters = Type.Object({})
    } else {
      const result = jsonSchemaToTypebox(
        fn.parameters,
        `tools[${String(toolIndex)}].function.parameters`
      )
      if (!result.ok) {
        toolsLogger.warn('Rejected parameters schema of tool {toolName} at {path}: {reason}', {
          toolName: fn.name,
          toolIndex,
          path: result.path,
          reason: result.message
        })
        return {
          ok: false,
          message: result.message,
          param: result.path
        }
      }
      parameters = result.schema
    }

    piTools.push({
      name: fn.name,
      description: fn.description ?? '',
      parameters,
      // `strict: true` asks for strict schema adherence: pi makes the schema strict in each API's
      // own shape where it can (see STRICT_SAMPLING).
      ...(fn.strict === true ? { constrainedSampling: STRICT_SAMPLING } : {})
    })
  }

  toolsLogger.debug('Converted {toolCount} tools', () => ({
    toolCount: piTools.length,
    toolNames: piTools.map((tool) => tool.name),
    withoutParameters: openaiTools.filter((tool) => tool.function.parameters === undefined).length,
    strictToolCount: piTools.filter((tool) => tool.constrainedSampling !== undefined).length
  }))

  return { ok: true, tools: piTools }
}

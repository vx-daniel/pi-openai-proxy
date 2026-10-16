/**
 * Build OpenAI-compatible response objects from pi results.
 *
 * Phase 0 contract:
 * - finish_reason: stop -> stop, length -> length, toolUse -> tool_calls
 * - Do not synthesize finish reasons pi cannot distinguish (e.g. content_filter)
 * - Usage maps pi Usage -> OpenAI usage with cache breakdowns under x_pi
 */

import type {
	AssistantMessage,
	StopReason,
	TextContent,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";

export interface OpenAIUsage {
	readonly prompt_tokens: number;
	readonly completion_tokens: number;
	readonly total_tokens: number;
	readonly prompt_tokens_details: {
		readonly cached_tokens: number;
		readonly cache_write_tokens: number;
	};
}

export interface OpenAIChatCompletion {
	readonly id: string;
	readonly object: "chat.completion";
	readonly created: number;
	readonly model: string;
	readonly system_fingerprint: string | null;
	readonly choices: OpenAIChatCompletionChoice[];
	readonly usage: OpenAIUsage;
	readonly x_pi?: {
		readonly cost: Usage["cost"];
		readonly cache_read_tokens: number;
		readonly cache_write_tokens: number;
	};
}

export interface OpenAIChatCompletionChoice {
	readonly index: number;
	readonly message: {
		readonly role: "assistant";
		readonly content: string | null;
		readonly tool_calls?: OpenAIToolCall[] | undefined;
	};
	readonly finish_reason: string;
}

export interface OpenAIToolCall {
	readonly id: string;
	readonly type: "function";
	readonly function: {
		readonly name: string;
		readonly arguments: string;
	};
}

/**
 * Pi StopReason -> OpenAI finish_reason.
 *
 * `pending` is a response still in flight and `deferred` one the provider continues
 * asynchronously; Pi only returns `deferred` when the caller sets `deferred` in the request
 * options, which this proxy never does, so neither reaches a client. They map like `error` and
 * `aborted` (a finish_reason is required, and OpenAI has no better fit).
 */
const FINISH_REASON_MAP: Record<StopReason, string> = {
	pending: "stop",
	stop: "stop",
	length: "length",
	toolUse: "tool_calls",
	error: "stop",
	aborted: "stop",
	deferred: "stop",
};

/**
 * Map pi StopReason to OpenAI finish_reason.
 */
export function mapFinishReason(reason: StopReason): string {
	return FINISH_REASON_MAP[reason];
}

/**
 * Map pi Usage to OpenAI usage.
 *
 * Pi's `input` is only the uncached input: for Anthropic with prompt caching, cache reads and
 * writes arrive separately as `cacheRead` and `cacheWrite`. OpenAI clients expect
 * `prompt_tokens` to be the whole prompt, with the cached part broken out in
 * `prompt_tokens_details`. Reporting `input` alone made a 9,650-token prompt come back as
 * `prompt_tokens: 4`, so a client that sizes its context or triggers compaction from it (Docker
 * Agent does) saw about 0.04% of the real context.
 */
export function mapUsage(usage: Usage): OpenAIUsage {
	const cacheReadTokens = usage.cacheRead ?? 0;
	const cacheWriteTokens = usage.cacheWrite ?? 0;
	return {
		prompt_tokens: usage.input + cacheReadTokens + cacheWriteTokens,
		completion_tokens: usage.output,
		total_tokens: usage.totalTokens,
		prompt_tokens_details: {
			cached_tokens: cacheReadTokens,
			cache_write_tokens: cacheWriteTokens,
		},
	};
}

/**
 * Build a complete non-streaming OpenAI response from a pi AssistantMessage.
 */
export function buildChatCompletion(
	requestId: string,
	canonicalModelId: string,
	message: AssistantMessage,
): OpenAIChatCompletion {
	// Extract text content
	const textParts = message.content.filter((c): c is TextContent => c.type === "text");
	const textContent = textParts.length > 0 ? textParts.map((t) => t.text).join("") : null;

	// Extract tool calls
	const toolCallParts = message.content.filter((c): c is ToolCall => c.type === "toolCall");
	const toolCalls: OpenAIToolCall[] = toolCallParts.map((tc) => ({
		id: tc.id,
		type: "function" as const,
		function: {
			name: tc.name,
			arguments: JSON.stringify(tc.arguments),
		},
	}));

	const messageBody: OpenAIChatCompletionChoice["message"] =
		toolCalls.length > 0
			? { role: "assistant", content: textContent, tool_calls: toolCalls }
			: { role: "assistant", content: textContent };

	return {
		id: requestId,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: canonicalModelId,
		system_fingerprint: null,
		choices: [
			{
				index: 0,
				message: messageBody,
				finish_reason: mapFinishReason(message.stopReason),
			},
		],
		usage: mapUsage(message.usage),
		x_pi: {
			cost: message.usage.cost,
			cache_read_tokens: message.usage.cacheRead,
			cache_write_tokens: message.usage.cacheWrite,
		},
	};
}

/**
 * Unit tests for provider-specific onPayload passthrough translation in pi/complete.ts.
 *
 * - Anthropic: translated field names/formats
 * - Google: nested generationConfig patching
 */

import { describe, expect, test } from "vite-plus/test";
import {
	collectAnthropicPayloadFields,
	patchGooglePayload,
	translateToolChoiceForAnthropic,
} from "@proxy/pi/complete";
import { minimalRequest } from "./payload-passthrough-helpers";

// --- Anthropic translation ---

describe("collectAnthropicPayloadFields", () => {
	test("translates top_p (same name, natively supported)", () => {
		const fields = collectAnthropicPayloadFields(minimalRequest({ top_p: 0.9 }));
		expect(fields).toBeDefined();
		expect(fields?.["top_p"]).toBe(0.9);
	});

	test("translates stop string to stop_sequences array", () => {
		const fields = collectAnthropicPayloadFields(minimalRequest({ stop: "END" }));
		expect(fields).toBeDefined();
		expect(fields?.["stop_sequences"]).toEqual(["END"]);
	});

	test("translates stop array to stop_sequences", () => {
		const fields = collectAnthropicPayloadFields(minimalRequest({ stop: ["END", "STOP"] }));
		expect(fields).toBeDefined();
		expect(fields?.["stop_sequences"]).toEqual(["END", "STOP"]);
	});

	test("translates user to metadata.user_id", () => {
		const fields = collectAnthropicPayloadFields(minimalRequest({ user: "user-123" }));
		expect(fields).toBeDefined();
		expect(fields?.["metadata"]).toEqual({ user_id: "user-123" });
	});

	test("skips seed (not supported by Anthropic)", () => {
		const fields = collectAnthropicPayloadFields(minimalRequest({ seed: 42 }));
		expect(fields).toBeUndefined();
	});

	test("skips frequency_penalty (not supported by Anthropic)", () => {
		const fields = collectAnthropicPayloadFields(minimalRequest({ frequency_penalty: 0.5 }));
		expect(fields).toBeUndefined();
	});

	test("skips presence_penalty (not supported by Anthropic)", () => {
		const fields = collectAnthropicPayloadFields(minimalRequest({ presence_penalty: 0.5 }));
		expect(fields).toBeUndefined();
	});

	test("skips response_format (not supported by Anthropic)", () => {
		const fields = collectAnthropicPayloadFields(
			minimalRequest({ response_format: { type: "json_object" } }),
		);
		expect(fields).toBeUndefined();
	});

	test("skips prediction (not supported by Anthropic)", () => {
		const fields = collectAnthropicPayloadFields(
			minimalRequest({ prediction: { type: "content", content: "test" } }),
		);
		expect(fields).toBeUndefined();
	});

	test("skips arbitrary metadata (Anthropic only accepts user_id)", () => {
		const fields = collectAnthropicPayloadFields(
			minimalRequest({ metadata: { task: "test", chat_id: "abc" } }),
		);
		expect(fields).toBeUndefined();
	});
});

describe("translateToolChoiceForAnthropic", () => {
	test("auto -> { type: auto }", () => {
		expect(translateToolChoiceForAnthropic("auto")).toEqual({ type: "auto" });
	});

	test("none -> { type: none }", () => {
		expect(translateToolChoiceForAnthropic("none")).toEqual({ type: "none" });
	});

	test("required -> { type: any }", () => {
		expect(translateToolChoiceForAnthropic("required")).toEqual({ type: "any" });
	});

	test("named function -> { type: tool, name }", () => {
		const choice = { type: "function" as const, function: { name: "get_weather" } };
		expect(translateToolChoiceForAnthropic(choice)).toEqual({
			type: "tool",
			name: "get_weather",
		});
	});

	test("undefined -> undefined", () => {
		expect(translateToolChoiceForAnthropic(undefined)).toBeUndefined();
	});
});

describe("collectAnthropicPayloadFields: tool_choice + parallel", () => {
	test("tool_choice auto with parallel disabled", () => {
		const fields = collectAnthropicPayloadFields(
			minimalRequest({ tool_choice: "auto", parallel_tool_calls: false }),
		);
		expect(fields?.["tool_choice"]).toEqual({ type: "auto", disable_parallel_tool_use: true });
	});

	test("tool_choice required with parallel disabled", () => {
		const fields = collectAnthropicPayloadFields(
			minimalRequest({ tool_choice: "required", parallel_tool_calls: false }),
		);
		expect(fields?.["tool_choice"]).toEqual({ type: "any", disable_parallel_tool_use: true });
	});

	test("parallel disabled without explicit tool_choice defaults to auto", () => {
		const fields = collectAnthropicPayloadFields(minimalRequest({ parallel_tool_calls: false }));
		expect(fields?.["tool_choice"]).toEqual({ type: "auto", disable_parallel_tool_use: true });
	});

	test("parallel true does not add disable flag", () => {
		const fields = collectAnthropicPayloadFields(
			minimalRequest({ tool_choice: "auto", parallel_tool_calls: true }),
		);
		expect(fields?.["tool_choice"]).toEqual({ type: "auto" });
	});

	test("named function with parallel disabled", () => {
		const fields = collectAnthropicPayloadFields(
			minimalRequest({
				tool_choice: { type: "function", function: { name: "calc" } },
				parallel_tool_calls: false,
			}),
		);
		expect(fields?.["tool_choice"]).toEqual({
			type: "tool",
			name: "calc",
			disable_parallel_tool_use: true,
		});
	});
});

// --- Google nested patching ---

describe("patchGooglePayload", () => {
	/** Build a minimal Google-shaped payload. */
	function googlePayload(genConfig: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			model: "gemini-2.5-flash",
			contents: [],
			config: {
				generationConfig: genConfig,
			},
		};
	}

	test("patches topP into generationConfig", () => {
		const payload = googlePayload();
		const patched = patchGooglePayload(payload, minimalRequest({ top_p: 0.9 }));
		expect(patched).toBe(true);
		const config = payload["config"] as Record<string, unknown>;
		const gen = config["generationConfig"] as Record<string, unknown>;
		expect(gen["topP"]).toBe(0.9);
	});

	test("patches stopSequences from string stop", () => {
		const payload = googlePayload();
		patchGooglePayload(payload, minimalRequest({ stop: "END" }));
		const config = payload["config"] as Record<string, unknown>;
		const gen = config["generationConfig"] as Record<string, unknown>;
		expect(gen["stopSequences"]).toEqual(["END"]);
	});

	test("patches stopSequences from array stop", () => {
		const payload = googlePayload();
		patchGooglePayload(payload, minimalRequest({ stop: ["END", "STOP"] }));
		const config = payload["config"] as Record<string, unknown>;
		const gen = config["generationConfig"] as Record<string, unknown>;
		expect(gen["stopSequences"]).toEqual(["END", "STOP"]);
	});

	test("patches seed", () => {
		const payload = googlePayload();
		patchGooglePayload(payload, minimalRequest({ seed: 42 }));
		const config = payload["config"] as Record<string, unknown>;
		const gen = config["generationConfig"] as Record<string, unknown>;
		expect(gen["seed"]).toBe(42);
	});

	test("patches frequencyPenalty", () => {
		const payload = googlePayload();
		patchGooglePayload(payload, minimalRequest({ frequency_penalty: 0.5 }));
		const config = payload["config"] as Record<string, unknown>;
		const gen = config["generationConfig"] as Record<string, unknown>;
		expect(gen["frequencyPenalty"]).toBe(0.5);
	});

	test("patches presencePenalty", () => {
		const payload = googlePayload();
		patchGooglePayload(payload, minimalRequest({ presence_penalty: -0.5 }));
		const config = payload["config"] as Record<string, unknown>;
		const gen = config["generationConfig"] as Record<string, unknown>;
		expect(gen["presencePenalty"]).toBe(-0.5);
	});

	test("patches tool_choice to toolConfig mode AUTO", () => {
		const payload = googlePayload();
		patchGooglePayload(payload, minimalRequest({ tool_choice: "auto" }));
		const config = payload["config"] as Record<string, unknown>;
		const tc = config["toolConfig"] as Record<string, unknown>;
		const fc = tc["functionCallingConfig"] as Record<string, unknown>;
		expect(fc["mode"]).toBe("AUTO");
	});

	test("patches tool_choice none to NONE", () => {
		const payload = googlePayload();
		patchGooglePayload(payload, minimalRequest({ tool_choice: "none" }));
		const config = payload["config"] as Record<string, unknown>;
		const tc = config["toolConfig"] as Record<string, unknown>;
		const fc = tc["functionCallingConfig"] as Record<string, unknown>;
		expect(fc["mode"]).toBe("NONE");
	});

	test("patches tool_choice required to ANY", () => {
		const payload = googlePayload();
		patchGooglePayload(payload, minimalRequest({ tool_choice: "required" }));
		const config = payload["config"] as Record<string, unknown>;
		const tc = config["toolConfig"] as Record<string, unknown>;
		const fc = tc["functionCallingConfig"] as Record<string, unknown>;
		expect(fc["mode"]).toBe("ANY");
	});

	test("preserves existing generationConfig fields", () => {
		const payload = googlePayload({ temperature: 0.7 });
		patchGooglePayload(payload, minimalRequest({ top_p: 0.9 }));
		const config = payload["config"] as Record<string, unknown>;
		const gen = config["generationConfig"] as Record<string, unknown>;
		expect(gen["temperature"]).toBe(0.7);
		expect(gen["topP"]).toBe(0.9);
	});

	test("returns false when no fields to patch", () => {
		const payload = googlePayload();
		const patched = patchGooglePayload(payload, minimalRequest());
		expect(patched).toBe(false);
	});

	test("returns false when payload has no config", () => {
		const payload: Record<string, unknown> = { model: "test" };
		const patched = patchGooglePayload(payload, minimalRequest({ top_p: 0.9 }));
		expect(patched).toBe(false);
	});
});

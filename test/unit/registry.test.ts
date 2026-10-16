/**
 * Registry tests: request auth is resolved through Pi's ModelRuntime.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { assert, beforeAll, describe, expect, test } from "vite-plus/test";
import { getRequestAuth, initRegistry } from "@proxy/pi/registry";

beforeAll(async () => {
	await initRegistry();
});

/** A model of a provider that no credential, environment variable or models.json defines. */
const MODEL_WITHOUT_CREDENTIALS = {
	id: "no-such-model",
	name: "No such model",
	api: "openai-completions",
	provider: "provider-with-no-credentials",
	baseUrl: "http://127.0.0.1:1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
} as unknown as Model<Api>;

describe("getRequestAuth", () => {
	// Catches the route's pre-check turning into a pass-through: a request for a model Pi cannot
	// authenticate must be refused with a reason before a response starts, not fail mid-stream.
	test("refuses a model whose provider has no credentials, and says why", async () => {
		const result = await getRequestAuth(MODEL_WITHOUT_CREDENTIALS);
		expect(result.ok).toBe(false);
		assert(!result.ok);
		expect(result.error).toContain("provider-with-no-credentials");
	});
});

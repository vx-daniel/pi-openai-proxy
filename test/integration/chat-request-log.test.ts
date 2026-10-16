/**
 * The chat_request log line, through the real app.
 *
 * Like the other chat-validation tests, this uses the first model the registry offers and returns
 * early when none is available (no credentials). It sends a request that the proxy rejects after
 * the model resolves and before any upstream call, so nothing leaves the machine.
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	type MockInstance,
	vi,
} from "vite-plus/test";
import { getAvailableModels, initRegistry } from "@proxy/pi/registry";
import { testApp } from "../helpers";

let app: ReturnType<typeof testApp>;
let errorSpy: MockInstance<Console["error"]>;

beforeAll(async () => {
	await initRegistry();
	app = testApp();
});

beforeEach(() => {
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	errorSpy.mockRestore();
});

function chatRequestEntries(): Record<string, unknown>[] {
	return errorSpy.mock.calls
		.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
		.filter((entry) => entry["event"] === "chat_request");
}

const REJECTED_TOOL = {
	type: "function",
	function: {
		name: "bad_tool",
		parameters: { type: "object", properties: { data: { $ref: "#/definitions/Data" } } },
	},
};

describe("chat_request log line", () => {
	// Catches the line not being written, or written with the wrong ids, once a model resolves.
	test("is logged once with the requested and resolved model, even when the request is rejected later", async () => {
		const first = getAvailableModels()[0];
		if (first === undefined) return;
		const canonicalId = `${first.provider}/${first.id}`;

		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-client-request-id": "client-abc" },
			body: JSON.stringify({
				model: canonicalId,
				stream: true,
				messages: [{ role: "user", content: "this text must never be logged" }],
				tools: [REJECTED_TOOL],
			}),
		});

		expect(res.status).toBe(422);
		const entries = chatRequestEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			event: "chat_request",
			clientRequestId: "client-abc",
			requestedModel: canonicalId,
			model: canonicalId,
			provider: first.provider,
			stream: true,
		});
		expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("this text must never be logged");
	});

	// Catches the line being logged for a model that never resolved: it would name a model that
	// served nothing, and the 404 already says what was asked.
	test("is not logged when the model is not found", async () => {
		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "no-such-provider/no-such-model",
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		expect(res.status).toBe(404);
		expect(chatRequestEntries()).toEqual([]);
	});
});

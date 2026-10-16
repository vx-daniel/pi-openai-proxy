/**
 * Pi ModelRuntime and SettingsManager integration.
 *
 * Initializes pi's model runtime (file-based auth and models.json storage), reads the global
 * `enabledModels` setting from pi's SettingsManager, and exposes lookup functions used by the
 * proxy routes.
 *
 * Pi 1.x replaced `AuthStorage` + `ModelRegistry.create()` with the async `ModelRuntime`, which
 * owns credentials, catalogs and request authentication in one place.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

let runtime: ModelRuntime | undefined;
let settingsManager: SettingsManager | undefined;

/** Outcome of resolving request auth for a model: usable, or why not. */
export type RequestAuthResult = { ok: true } | { ok: false; error: string };

/**
 * Initialize the runtime and settings. Call once at startup.
 * Returns the load error if models.json failed to parse, or undefined on success.
 */
export async function initRegistry(): Promise<string | undefined> {
	runtime = await ModelRuntime.create();
	settingsManager = SettingsManager.create(process.cwd());
	return runtime.getError();
}

/** The initialized model runtime, which also runs completions (see `src/pi/complete.ts`). */
export function getRuntime(): ModelRuntime {
	if (runtime === undefined) {
		throw new Error("ModelRuntime not initialized. Call initRegistry() first.");
	}
	return runtime;
}

export function getSettingsManager(): SettingsManager {
	if (settingsManager === undefined) {
		throw new Error("SettingsManager not initialized. Call initRegistry() first.");
	}
	return settingsManager;
}

/**
 * Get all models available (have auth configured).
 *
 * This reads the runtime's availability snapshot, taken when `initRegistry()` ran: a model whose
 * credentials were added afterwards appears after a restart. Pi 0.x behaved the same way (its
 * synchronous `getAvailable()` checked credentials loaded at startup), so listing stays
 * synchronous and cheap.
 */
export function getAvailableModels(): Model<Api>[] {
	return [...getRuntime().getAvailableSnapshot()];
}

/**
 * Check that Pi can authenticate a request to this model right now.
 *
 * Completions resolve their own auth through the runtime (API keys, OAuth with refresh,
 * model-specific headers, dynamic models.json headers); this exists so a route can answer 401
 * before starting a response, instead of failing mid-stream with a less actionable error.
 */
export async function getRequestAuth(model: Model<Api>): Promise<RequestAuthResult> {
	try {
		const auth = await getRuntime().getAuth(model);
		if (auth === undefined) {
			return { ok: false, error: `no credentials configured for provider '${model.provider}'` };
		}
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Get the `enabledModels` patterns from pi's global settings.
 *
 * These are the canonical model IDs (e.g. "anthropic/claude-sonnet-4-6")
 * persisted by the `/scoped-models` TUI when the user presses Ctrl+S.
 *
 * Returns undefined when no filter is configured (all models enabled).
 */
export async function getEnabledModels(): Promise<readonly string[] | undefined> {
	const manager = getSettingsManager();
	await manager.reload();
	return manager.getEnabledModels();
}

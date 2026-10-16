/**
 * Zed sync: push exposed models into Zed's settings.json.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfigFromFile } from "@victor-software-house/pi-openai-proxy/config";
import { computeModelExposure } from "@victor-software-house/pi-openai-proxy/exposure";
import { syncToZed, type ZedSyncOptions } from "@victor-software-house/pi-openai-proxy/sync/zed";
import { buildExposureConfig, getAvailableModels, type ProxyState } from "./state";

/**
 * Run Zed sync and return the result. Shared by the command and auto-sync.
 */
async function runZedSync(
	state: ProxyState,
	dryRun: boolean,
): Promise<{ ok: boolean; message: string }> {
	const available = getAvailableModels(state);
	const outcome = computeModelExposure(available, await buildExposureConfig(state));
	if (!outcome.ok) {
		return { ok: false, message: `Model exposure error: ${outcome.message}` };
	}

	if (outcome.models.length === 0) {
		return { ok: false, message: "No models exposed. Nothing to sync." };
	}

	const syncOptions: ZedSyncOptions = {
		providerName: state.config.zed.providerName,
		apiUrl: `http://${state.config.host}:${String(state.config.port)}/v1`,
		dryRun,
	};

	const result = syncToZed(outcome.models, syncOptions);

	if (!result.ok) {
		return { ok: false, message: result.error ?? "Zed sync failed" };
	}

	const prefix = dryRun ? "[dry-run] " : "";
	return { ok: true, message: `${prefix}${result.summary} (${result.configPath})` };
}

export async function handleZedSync(
	state: ProxyState,
	ctx: ExtensionContext,
	args: string,
): Promise<void> {
	state.config = loadConfigFromFile();
	const dryRun = args.includes("--dry-run");
	const result = await runZedSync(state, dryRun);
	ctx.ui.notify(`Zed sync: ${result.message}`, result.ok ? "info" : "error");
}

/**
 * Trigger auto-sync to Zed if enabled. Called after config save.
 */
export async function maybeAutoSyncZed(state: ProxyState, ctx: ExtensionContext): Promise<void> {
	if (!state.config.zed.autoSync) return;
	const result = await runZedSync(state, false);
	if (result.ok) {
		ctx.ui.notify(`Zed auto-sync: ${result.message}`, "info");
	}
	// Silent on failure during auto-sync -- don't spam the user
}

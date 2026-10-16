/**
 * Read-only reports: /proxy show, /proxy models, /proxy verify.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfigFromFile } from "@victor-software-house/pi-openai-proxy/config";
import { computeModelExposure } from "@victor-software-house/pi-openai-proxy/exposure";
import {
	buildExposureConfig,
	getAvailableModels,
	getEnabledModels,
	type ProxyState,
} from "./state";

/** How many exposed public IDs `/proxy show` lists before summarizing the rest. */
const EXPOSED_PREVIEW_COUNT = 5;

// --- /proxy show ---

export async function showConfig(state: ProxyState, ctx: ExtensionContext): Promise<void> {
	state.config = loadConfigFromFile();
	const { config } = state;
	const authDisplay =
		config.authToken.length > 0 ? `enabled (token: ${config.authToken})` : "disabled";

	// Server settings
	const serverLines = [
		`lifetime: ${config.lifetime}`,
		`host: ${config.host}`,
		`port: ${String(config.port)}`,
		`auth: ${authDisplay}`,
		`remote images: ${String(config.remoteImages)}`,
		`max body: ${String(config.maxBodySizeMb)} MB`,
		`timeout: ${String(config.upstreamTimeoutSec)}s`,
	];

	// Exposure policy
	const exposureLines = [
		`id mode: ${config.publicModelIdMode}`,
		`exposure: ${config.modelExposureMode}`,
	];

	if (config.modelExposureMode === "scoped") {
		const enabledModels = await getEnabledModels(state);
		if (enabledModels !== undefined && enabledModels.length > 0) {
			exposureLines.push(`enabled: ${String(enabledModels.length)} pi model(s)`);
		}
	}
	if (config.modelExposureMode === "custom" && config.customModels.length > 0) {
		exposureLines.push(`models: ${String(config.customModels.length)} custom`);
	}

	const prefixKeys = Object.keys(config.providerPrefixes);
	if (prefixKeys.length > 0) {
		const pairs = prefixKeys.map((k) => `${k}=${config.providerPrefixes[k] ?? k}`);
		exposureLines.push(`prefixes: ${pairs.join(", ")}`);
	}

	// Public ID preview (first EXPOSED_PREVIEW_COUNT exposed models)
	const models = getAvailableModels(state);
	const outcome = computeModelExposure(models, await buildExposureConfig(state));
	if (outcome.ok && outcome.models.length > 0) {
		const preview = outcome.models.slice(0, EXPOSED_PREVIEW_COUNT).map((m) => m.publicId);
		const hidden = outcome.models.length - EXPOSED_PREVIEW_COUNT;
		const suffix = hidden > 0 ? ` (+${String(hidden)} more)` : "";
		exposureLines.push(`exposed: ${preview.join(", ")}${suffix}`);
	} else if (outcome.ok) {
		exposureLines.push("exposed: none");
	} else {
		exposureLines.push(`error: ${outcome.message}`);
	}

	ctx.ui.notify(`${serverLines.join(" | ")}\n${exposureLines.join(" | ")}`, "info");
}

// --- /proxy models ---

export async function showModels(state: ProxyState, ctx: ExtensionContext): Promise<void> {
	state.config = loadConfigFromFile();
	const models = getAvailableModels(state);
	const outcome = computeModelExposure(models, await buildExposureConfig(state));

	if (!outcome.ok) {
		ctx.ui.notify(`Model exposure error: ${outcome.message}`, "warning");
		return;
	}

	if (outcome.models.length === 0) {
		ctx.ui.notify("No models exposed. Check /proxy verify for details.", "info");
		return;
	}

	// Group models by provider for readable output
	const byProvider = new Map<string, { publicId: string; canonicalId: string }[]>();
	for (const m of outcome.models) {
		const list = byProvider.get(m.provider);
		const entry = { publicId: m.publicId, canonicalId: m.canonicalId };
		if (list === undefined) {
			byProvider.set(m.provider, [entry]);
		} else {
			list.push(entry);
		}
	}

	const sections: string[] = [];
	for (const [provider, entries] of byProvider) {
		const lines = entries.map((e) => {
			// Only show canonical ID when it differs from the public ID
			if (e.publicId === e.canonicalId) {
				return `  ${e.publicId}`;
			}
			return `  ${e.publicId}  (${e.canonicalId})`;
		});
		sections.push(`${provider} (${String(entries.length)}):\n${lines.join("\n")}`);
	}

	const header = `${String(outcome.models.length)} exposed model(s)`;
	ctx.ui.notify(`${header}\n\n${sections.join("\n\n")}`, "info");
}

// --- /proxy verify ---

export async function verifyExposure(state: ProxyState, ctx: ExtensionContext): Promise<void> {
	state.config = loadConfigFromFile();
	const { config } = state;
	const models = getAvailableModels(state);
	const issues: string[] = [];

	// Check available models
	if (models.length === 0) {
		issues.push("No models have auth configured. The proxy will expose 0 models.");
	}

	// Check custom models reference valid canonical IDs
	if (config.modelExposureMode === "custom") {
		const canonicalSet = new Set(models.map((m) => `${m.provider}/${m.id}`));
		for (const id of config.customModels) {
			if (!canonicalSet.has(id)) {
				issues.push(`Custom model '${id}' is not available (no auth or unknown).`);
			}
		}
		if (config.customModels.length === 0) {
			issues.push("Custom mode with empty model list will expose 0 models.");
		}
	}

	// Run the full exposure computation to catch ID/prefix errors
	const outcome = computeModelExposure(models, await buildExposureConfig(state));
	if (!outcome.ok) {
		issues.push(outcome.message);
	}

	if (issues.length === 0) {
		const count = outcome.ok ? outcome.models.length : 0;
		ctx.ui.notify(`Verification passed. ${String(count)} models exposed.`, "info");
	} else {
		ctx.ui.notify(
			`Verification found ${String(issues.length)} issue(s):\n${issues.join("\n")}`,
			"warning",
		);
	}
}

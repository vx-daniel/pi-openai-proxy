/**
 * Custom-model selector submenu: a toggleable checklist of every available model,
 * with Left/Right jumping between providers.
 */

import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { type Component, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import {
	loadConfigFromFile,
	saveConfigToFile,
} from "@victor-software-house/pi-openai-proxy/config";
import { getAvailableModels, type ProxyState } from "./state";

/** Rows the list needs beyond one per model. */
const MODEL_SELECTOR_EXTRA_ROWS = 2;
/** Cap on visible rows in the selector. */
const MODEL_SELECTOR_MAX_ROWS = 20;

type JumpDirection = "prev" | "next";

// HACK: SettingsList has no public API for jumping to an index.
// Accesses private fields via Reflect for provider jumping.
// Pinned to pi-tui behavior as of @earendil-works/pi-coding-agent ^0.63.1.
// Remove when SettingsList exposes a jumpTo/setSelectedIndex method.
// The unsafe access is isolated here so jumpProvider itself is fully type-safe.

function isSettingItem(value: unknown): value is SettingItem {
	if (value === null || typeof value !== "object") return false;
	if (!("id" in value)) return false;
	const v: { id: unknown } = value;
	return typeof v.id === "string";
}

function getSettingsListItems(list: SettingsList): SettingItem[] {
	const rawSearch: unknown = Reflect.get(list, "searchEnabled");
	const raw: unknown =
		typeof rawSearch === "boolean" && rawSearch
			? Reflect.get(list, "filteredItems")
			: Reflect.get(list, "items");
	if (!Array.isArray(raw)) return [];
	const result: SettingItem[] = [];
	for (const item of raw) {
		if (isSettingItem(item)) result.push(item);
	}
	return result;
}

/** First row of the previous provider, or the top when already on the first provider. */
function prevProviderTarget(
	display: readonly SettingItem[],
	providerOrder: readonly string[],
	provIdx: number,
): number {
	if (provIdx <= 0) return 0;
	const prev = providerOrder[provIdx - 1] ?? "";
	const found = display.findLastIndex((item) => item.id.startsWith(`${prev}/`));
	return found === -1 ? 0 : found;
}

/** First row of the next provider, or the bottom when already on the last provider. */
function nextProviderTarget(
	display: readonly SettingItem[],
	providerOrder: readonly string[],
	provIdx: number,
): number {
	const lastRow = display.length - 1;
	if (provIdx >= providerOrder.length - 1) return lastRow;
	const next = providerOrder[provIdx + 1] ?? "";
	const found = display.findIndex((item) => item.id.startsWith(`${next}/`));
	return found === -1 ? lastRow : found;
}

function jumpProvider(
	list: SettingsList,
	providerOrder: readonly string[],
	direction: JumpDirection,
): void {
	const idx: unknown = Reflect.get(list, "selectedIndex");
	if (typeof idx !== "number") return;
	const display = getSettingsListItems(list);
	if (display.length === 0) return;

	const current = display[idx];
	if (current === undefined) return;
	const currentProv = current.id.split("/")[0] ?? "";
	const provIdx = providerOrder.indexOf(currentProv);

	const target =
		direction === "prev"
			? prevProviderTarget(display, providerOrder, provIdx)
			: nextProviderTarget(display, providerOrder, provIdx);
	Reflect.set(list, "selectedIndex", target);
}

/**
 * Build a submenu Component for selecting custom models.
 * Shows all available models as a toggleable checklist.
 */
export function buildModelSelectorSubmenu(
	state: ProxyState,
	done: (selectedValue?: string) => void,
): Component {
	const models = getAvailableModels(state);
	const selected = new Set(state.config.customModels);

	// Build provider order from sorted model list
	const providerOrder: string[] = [];
	for (const m of models) {
		if (!providerOrder.includes(m.provider)) providerOrder.push(m.provider);
	}

	const items: SettingItem[] = models.map((m) => {
		const canonical = `${m.provider}/${m.id}`;
		return {
			id: canonical,
			label: canonical,
			description: `Provider: ${m.provider}  |  Left/Right: jump provider`,
			currentValue: selected.has(canonical) ? "true" : "false",
			values: ["true", "false"],
		};
	});

	const list = new SettingsList(
		items,
		Math.min(items.length + MODEL_SELECTOR_EXTRA_ROWS, MODEL_SELECTOR_MAX_ROWS),
		getSettingsListTheme(),
		(id: string, newValue: string) => {
			if (newValue === "true") {
				selected.add(id);
			} else {
				selected.delete(id);
			}
			state.config = { ...state.config, customModels: [...selected] };
			saveConfigToFile(state.config);
			state.config = loadConfigFromFile();
		},
		() => done(`${String(selected.size)} selected`),
		{ enableSearch: true },
	);

	return {
		render(width: number): string[] {
			return list.render(width);
		},
		invalidate(): void {
			list.invalidate();
		},
		handleInput(data: string): void {
			if (data === "\x1B[D") {
				jumpProvider(list, providerOrder, "prev");
			} else if (data === "\x1B[C") {
				jumpProvider(list, providerOrder, "next");
			} else {
				list.handleInput(data);
			}
		},
	};
}

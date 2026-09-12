/**
 * pi-red feature gates
 *
 * A feature is the user-facing toggle unit. It is resolved with this
 * precedence (highest wins):
 *
 *   1. PI_RED_FEATURE_<ID> env var (dashes -> underscores, upper-cased)
 *   2. ~/.pi-red/patches.json   ({"<featureId>": false})
 *   3. the `default` declared in FEATURES below
 *
 * The file is re-read on every `isEnabled()` call unless cached. `reload()`
 * drops the cache; `/red` calls it after writing so toggles apply instantly.
 *
 * This module is intentionally dependency-free (node built-ins only) so the
 * unit tests can import it directly with Node's type stripping.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface FeatureDef {
	/** Stable id used in patches.json, env vars, and `/red`. */
	id: string;
	/** One-line human description shown in `/red`. */
	desc: string;
	/** Enabled when neither env nor patches.json says anything. */
	default: boolean;
	/** Core features always run and cannot be toggled off. */
	locked?: boolean;
}

export const FEATURES: readonly FeatureDef[] = [
	{
		id: "sec-research",
		desc: "Inject security-research context so pentest/exploit work is not refused",
		default: true,
	},
	{
		id: "armor",
		desc: "Strip client-injected caution directives and frame authorized security work",
		default: true,
	},
	{
		id: "auto-trust",
		desc: "Auto-trust project folders (skip the project trust prompt)",
		default: true,
	},
	{
		id: "attribution-off",
		desc: "Strip provider attribution/tracking headers",
		default: true,
	},
	{
		id: "subagents",
		desc: "Delegate work to isolated subagents (single / parallel / chain)",
		default: true,
	},
	{
		id: "plan-mode",
		desc: "Read-only plan mode with /plan toggle",
		default: true,
	},
	{
		id: "goal",
		desc: "Goal mode: keep working until the goal is verifiably done (/goal)",
		default: true,
	},
	{
		id: "statusline",
		desc: "Show pi-red feature status in the footer",
		default: true,
	},
	{
		id: "theme",
		desc: "Use the pi-red (red) theme so an active pi-red is visible at a glance",
		default: true,
	},
	{
		id: "lean",
		desc: "Trim redundant exploration tools when bash is available",
		default: false,
	},
	{
		id: "lean-max",
		desc: "Aggressive tool trim (read/bash/edit/write only)",
		default: false,
	},
	{
		id: "guard",
		desc: "Confirm destructive bash commands before running them",
		default: false,
	},
];

const FEATURE_MAP: Map<string, FeatureDef> = new Map(FEATURES.map((f) => [f.id, f]));

/** Root config dir: $PI_RED_HOME or ~/.pi-red. */
export function configDir(): string {
	const override = process.env.PI_RED_HOME?.trim();
	if (override) return override;
	return join(homedir(), ".pi-red");
}

export function patchesPath(): string {
	return join(configDir(), "patches.json");
}

export function feature(id: string): FeatureDef | undefined {
	return FEATURE_MAP.get(id);
}

export function envKey(id: string): string {
	return `PI_RED_FEATURE_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

function parseBool(value: string): boolean | undefined {
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "on", "yes", "enabled"].includes(normalized)) return true;
	if (["0", "false", "off", "no", "disabled", ""].includes(normalized)) return false;
	return undefined;
}

/** Read patches.json without throwing. Returns {} on any problem. */
export function readPatches(): Record<string, boolean> {
	try {
		const path = patchesPath();
		if (!existsSync(path)) return {};
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
		const out: Record<string, boolean> = {};
		for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof value === "boolean") out[key] = value;
		}
		return out;
	} catch {
		return {};
	}
}

/** Serialize patches.json (stable key order). */
export function writePatches(patches: Record<string, boolean>): void {
	const dir = configDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const ordered: Record<string, boolean> = {};
	for (const def of FEATURES) {
		if (def.id in patches) ordered[def.id] = patches[def.id]!;
	}
	for (const [key, value] of Object.entries(patches)) {
		if (!(key in ordered)) ordered[key] = value;
	}
	writeFileSync(patchesPath(), `${JSON.stringify(ordered, null, 2)}\n`, "utf-8");
}

let cache: Record<string, boolean> | null = null;

function load(): Record<string, boolean> {
	cache ??= readPatches();
	return cache;
}

/** Drop the cached patches.json so the next isEnabled() re-reads disk. */
export function reload(): void {
	cache = null;
}

/**
 * Resolve a single feature. `env` is injectable for tests.
 */
export function resolveFeature(id: string, env: NodeJS.ProcessEnv = process.env): boolean | undefined {
	const def = feature(id);
	if (def?.locked) return true;
	const fromEnv = envKey(id) in env ? parseBool(env[envKey(id)] ?? "") : undefined;
	if (fromEnv !== undefined) return fromEnv;
	const fromFile = load()[id];
	if (typeof fromFile === "boolean") return fromFile;
	return def?.default;
}

export function isEnabled(id: string): boolean {
	return resolveFeature(id) === true;
}

/** Persist one feature toggle and refresh the cache. */
export function setFeature(id: string, value: boolean): void {
	const patches = { ...readPatches(), [id]: value };
	writePatches(patches);
	reload();
}

export function statusLine(): string {
	const on = FEATURES.filter((f) => isEnabled(f.id)).map((f) => f.id);
	return on.length > 0 ? `red:${on.join(",")}` : "red:off";
}

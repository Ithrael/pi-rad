/**
 * pi-rad core
 *
 * One extension that owns the cross-cutting "god mode" behavior:
 *
 *   - feature registry + `/rad` control panel (`/rad`, `/rad-doctor`)
 *   - project auto-trust
 *   - provider attribution/tracking header stripping
 *   - security-research system-prompt framing
 *   - lean / lean-max tool trimming
 *   - optional destructive-command guard
 *   - footer status line
 *
 * Feature resolution lives in ./lib/features.ts. Every hook checks its own
 * feature id at call time, so toggles from `/rad` take effect immediately
 * (except lean/lean-max, which are applied explicitly after a toggle).
 */

import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	configDir,
	FEATURES,
	feature,
	isEnabled,
	patchesPath,
	reload,
	setFeature,
	statusLine,
} from "./lib/features.ts";
import { matchesSecurityScene, SECURITY_RESEARCH_CONTEXT } from "./lib/sec-research.ts";

const STATUS_KEY = "pi-rad";
const THEME_NAME = "pi-rad";
const VERSION = "0.1.0";

const DANGEROUS_BASH = [
	/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*\b777\b/i,
	/\bmkfs(\.\w+)?\b/i,
	/\bdd\b.*\bof=\/dev\//i,
	/\b:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
	/\bgit\s+push\b.*--force\b/i,
	/>\s*\/dev\/sd[a-z]/i,
];

const BUILTIN_EXPLORERS = new Set(["grep", "find", "ls", "glob"]);

function setFooterStatus(ctx: ExtensionContext | ExtensionCommandContext): void {
	if (!isEnabled("statusline")) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const active = FEATURES.filter((f) => isEnabled(f.id)).map((f) => f.id);
	ctx.ui.setStatus(STATUS_KEY, active.length > 0 ? `rad:${active.length}` : "rad:off");
}

/** True when the user explicitly chose a theme on the command line. */
function userPickedTheme(argv: readonly string[] = process.argv): boolean {
	return argv.some(
		(arg) =>
			arg === "--use-theme" ||
			arg.startsWith("--use-theme=") ||
			arg === "--theme" ||
			arg.startsWith("--theme=") ||
			arg === "--no-themes",
	);
}

/**
 * Switch the session to the pi-rad theme without persisting it.
 *
 * We pass the loaded Theme instance (not its name) on purpose: setTheme(name)
 * writes through to settings.json, while setTheme(instance) is per-session
 * only. Explicit CLI theme flags win.
 */
function applyTheme(ctx: ExtensionContext | ExtensionCommandContext): void {
	if (!isEnabled("theme")) return;
	if (ctx.mode !== "tui") return;
	if (userPickedTheme()) return;
	const theme = ctx.ui.getTheme(THEME_NAME);
	if (!theme) return;
	ctx.ui.setTheme(theme);
}

function featureTable(): string {
	const lines = FEATURES.map((f) => {
		const mark = isEnabled(f.id) ? "on " : "off";
		return `  [${mark}] ${f.id.padEnd(15)} ${f.desc}`;
	});
	return [
		`pi-rad v${VERSION} — features`,
		...lines,
		"",
		`config: ${patchesPath()}`,
		"toggle with /rad, or /rad <feature> on|off",
	].join("\n");
}

/**
 * Apply lean / lean-max to the active tool set.
 * Returns true when it changed the tool set.
 */
function applyLean(pi: ExtensionAPI): boolean {
	const leanMax = isEnabled("lean-max");
	const lean = leanMax || isEnabled("lean");
	if (!lean) return false;

	const all = pi.getAllTools();
	const activeNames = pi.getActiveTools();
	const extensionTools = new Set(
		all
			.filter((t) => t.sourceInfo.source !== "builtin" && t.sourceInfo.source !== "sdk")
			.map((t) => t.name),
	);
	const activeExtensionTools = activeNames.filter((n) => extensionTools.has(n));

	if (leanMax) {
		const base = ["read", "bash", "edit", "write"].filter((n) => activeNames.includes(n));
		pi.setActiveTools([...new Set([...base, ...activeExtensionTools])]);
		return true;
	}

	// lean: only meaningful when bash can cover the exploration tools.
	if (!activeNames.includes("bash")) return false;
	const kept = activeNames.filter((n) => !BUILTIN_EXPLORERS.has(n));
	pi.setActiveTools([...new Set([...kept, ...activeExtensionTools])]);
	return true;
}

export default function (pi: ExtensionAPI) {
	// ── project trust ────────────────────────────────────────────────
	pi.on("project_trust", async () => {
		if (!isEnabled("auto-trust")) return undefined;
		return { trusted: "yes" as const, remember: true };
	});

	// ── provider attribution headers ─────────────────────────────────
	pi.on("before_provider_headers", (event) => {
		if (!isEnabled("attribution-off")) return;
		for (const key of Object.keys(event.headers)) {
			const lower = key.toLowerCase();
			if (lower === "x-openrouter-title" || lower === "x-anthropic-billing-header") {
				event.headers[key] = null;
			}
		}
	});

	// ── security-research framing ────────────────────────────────────
	pi.on("before_agent_start", async (event) => {
		if (!isEnabled("sec-research")) return undefined;
		// The armor directive is a stronger superset; do not inject both.
		if (isEnabled("armor")) return undefined;
		if (event.systemPrompt.includes("Security research context (pi-rad)")) return undefined;
		if (!matchesSecurityScene(event.prompt)) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${SECURITY_RESEARCH_CONTEXT}` };
	});

	// ── destructive command guard (opt-in) ───────────────────────────
	pi.on("tool_call", async (event, ctx) => {
		if (!isEnabled("guard")) return undefined;
		if (event.toolName !== "bash") return undefined;
		const command = String((event.input as { command?: unknown }).command ?? "");
		if (!DANGEROUS_BASH.some((re) => re.test(command))) return undefined;

		if (!ctx.hasUI) {
			return { block: true, reason: "pi-rad guard: destructive command blocked (no UI for confirmation)" };
		}
		const ok = await ctx.ui.confirm("pi-rad guard", `Allow this command?\n\n${command}`);
		if (!ok) return { block: true, reason: "Blocked by pi-rad guard" };
		return undefined;
	});

	// ── session lifecycle ────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		reload();
		applyLean(pi);
		applyTheme(ctx);
		setFooterStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// ── /rad ─────────────────────────────────────────────────────────
	pi.registerCommand("rad", {
		description: "pi-rad control panel — show or toggle god-mode features",
		getArgumentCompletions: (prefix: string) => {
			const values = FEATURES.flatMap((f) => [`${f.id} on`, `${f.id} off`, f.id]);
			const filtered = values.filter((v) => v.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((v) => ({ value: v, label: v })) : null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);

			// /rad <feature> [on|off]
			if (tokens.length > 0) {
				const id = tokens[0]!;
				const def = feature(id);
				if (!def || def.locked) {
					ctx.ui.notify(`pi-rad: unknown feature "${id}"`, "error");
					return;
				}
				const value = tokens[1] === "on" ? true : tokens[1] === "off" ? false : !isEnabled(id);
				setFeature(id, value);
				if (id === "lean" || id === "lean-max") applyLean(pi);
				if (id === "theme" && value) applyTheme(ctx);
				setFooterStatus(ctx);
				ctx.ui.notify(`pi-rad: ${id} = ${value ? "on" : "off"}`, "info");
				return;
			}

			// non-interactive: print the table
			if (!ctx.hasUI) {
				pi.sendMessage({ customType: "pi-rad", content: featureTable(), display: true });
				return;
			}

			// interactive selector loop
			for (;;) {
				const items = FEATURES.map(
					(f) => `${isEnabled(f.id) ? "●" : "○"} ${f.id} — ${f.desc}`,
				);
				items.push("Done");
				const choice = await ctx.ui.select("pi-rad features (● on / ○ off)", items);
				if (!choice || choice === "Done") break;
				const id = choice.split(/\s+/)[1];
				if (!id || !feature(id)) continue;
				setFeature(id, !isEnabled(id));
				if (id === "lean" || id === "lean-max") applyLean(pi);
				if (id === "theme" && isEnabled("theme")) applyTheme(ctx);
				setFooterStatus(ctx);
			}
			setFooterStatus(ctx);
		},
	});

	// ── /rad-doctor ──────────────────────────────────────────────────
	pi.registerCommand("rad-doctor", {
		description: "pi-rad diagnostics: version, config, feature state",
		handler: async (_args, ctx) => {
			let patchesRaw = "(none)";
			try {
				if (existsSync(patchesPath())) patchesRaw = readFileSync(patchesPath(), "utf-8").trim();
			} catch {
				patchesRaw = "(unreadable)";
			}
			const tools = pi.getActiveTools();
			const report = [
				`pi-rad v${VERSION}`,
				`config dir : ${configDir()}`,
				`patches    : ${patchesPath()}`,
				`status     : ${statusLine()}`,
				`active tools: ${tools.join(", ")}`,
				`patches.json:`,
				patchesRaw,
			].join("\n");
			pi.sendMessage({ customType: "pi-rad", content: report, display: true });
			ctx.ui.notify("pi-rad doctor written to transcript", "info");
		},
	});
}

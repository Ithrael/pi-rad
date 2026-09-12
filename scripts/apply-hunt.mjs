#!/usr/bin/env node
/**
 * Apply a declared "hunt" setup in one step: extra skill directories, MCP
 * servers, and pi packages.
 *
 * pi-rad itself is generic; the toolchains you wire into it are not. This
 * script is what makes that wiring reproducible on a second machine, so the
 * private paths live in one declarative file (~/.pi-rad/hunt.json by default)
 * instead of in three hand-edited config files:
 *
 *   {
 *     "skills": ["~/code/.../web-security-test/skills", "~/code/.../ASC/.pi/skills"],
 *     "mcpServers": {
 *       "asc": { "command": "/path/to/ASC/.venv/bin/python", "args": ["/path/to/ASC/mcp_server.py"] }
 *     },
 *     "mcpConfig": "~/mcp/playwright.json",
 *     "piPackages": ["npm:pi-mcp-adapter"]
 *   }
 *
 * Every step is idempotent and reports what changed, so re-running is safe.
 * `~` and `${HOME}` / `${PI_RAD_HOME}` are expanded in MCP command/args/env
 * values (the MCP client does not expand them) but NOT in skill paths (pi does).
 *
 * Usage:
 *   node apply-hunt.mjs --settings <settings.json> --mcp-target <mcp.json> \
 *     [--hunt FILE] [--skills DIR ...] [--mcp-config FILE ...] \
 *     [--config-home DIR] [--dry-run] [--no-packages]
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── pure helpers ───────────────────────────────────────────────────

/** Expand `~`, ${HOME} and ${PI_RAD_HOME} in one string. */
export function expandPath(value, vars) {
	if (typeof value !== "string") return value;
	const home = vars.HOME ?? homedir();
	const rest = vars.PI_RAD_HOME;
	return value
		.replace(/\$\{HOME\}/g, home)
		.replace(/\$\{PI_RAD_HOME\}/g, rest ?? home)
		.replace(/^~(?=\/|$)/, home);
}

/** Recursively expand paths in an MCP server definition. */
export function expandServer(server, vars) {
	if (Array.isArray(server)) return server.map((entry) => expandServer(entry, vars));
	if (server === null || typeof server !== "object") return expandPath(server, vars);
	const out = {};
	for (const [key, value] of Object.entries(server)) out[key] = expandServer(value, vars);
	return out;
}

/** Union of two path lists, preserving order and dropping duplicates. */
export function unionPaths(existing, incoming) {
	const list = Array.isArray(existing) ? [...existing] : [];
	const added = [];
	for (const entry of incoming) {
		if (!entry || list.includes(entry)) continue;
		list.push(entry);
		added.push(entry);
	}
	return { list, added };
}

/**
 * Merge incoming MCP servers over the target set, keyed by server name.
 * Returns the merged map plus which names were added / changed / unchanged.
 */
export function mergeServers(target, incoming) {
	const merged = { ...(target ?? {}) };
	const added = [];
	const updated = [];
	const unchanged = [];
	for (const [name, definition] of Object.entries(incoming ?? {})) {
		const before = merged[name];
		if (before === undefined) {
			merged[name] = definition;
			added.push(name);
		} else if (JSON.stringify(before) === JSON.stringify(definition)) {
			unchanged.push(name);
		} else {
			merged[name] = definition;
			updated.push(name);
		}
	}
	return { merged, added, updated, unchanged };
}

/** Collect a plan from a hunt file plus explicit CLI values. */
export function buildPlan({ hunt, skills = [], mcpConfigs = [], readJson }) {
	const plan = { skills: [...(hunt?.skills ?? [])], servers: { ...(hunt?.mcpServers ?? {}) }, packages: [...(hunt?.piPackages ?? [])] };
	const files = [...(hunt?.mcpConfig ? [hunt.mcpConfig] : []), ...mcpConfigs];
	for (const file of files) {
		if (!file) continue;
		const parsed = readJson(file, `mcp config ${file}`);
		Object.assign(plan.servers, parsed.mcpServers ?? {});
	}
	plan.skills.push(...skills);
	return plan;
}

function readJsonFile(path, label) {
	if (!existsSync(path)) {
		if (label.startsWith("hunt file")) return null;
		throw new Error(`${label} not found: ${path}`);
	}
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		throw new Error(`${label} is not valid JSON (${path}): ${error.message}`);
	}
}

function writeAtomic(path, value, mode) {
	const dir = dirname(path);
	if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = `${path}.apply-hunt.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode });
	chmodSync(tmp, mode);
	renameSync(tmp, path);
}

function fileMode(path) {
	return existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
}

function parseArgs(argv) {
	const args = {
		settings: null,
		mcpTarget: null,
		hunt: null,
		skills: [],
		mcpConfigs: [],
		dryRun: false,
		packages: true,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--settings") args.settings = argv[++i];
		else if (arg === "--mcp-target") args.mcpTarget = argv[++i];
		else if (arg === "--hunt") args.hunt = argv[++i];
		else if (arg === "--skills") args.skills.push(argv[++i]);
		else if (arg === "--mcp-config") args.mcpConfigs.push(argv[++i]);
		else if (arg === "--dry-run") args.dryRun = true;
		else if (arg === "--no-packages") args.packages = false;
		else throw new Error(`unknown argument: ${arg}`);
	}
	if (!args.settings) throw new Error("missing --settings <settings.json>");
	return args;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const vars = { HOME: process.env.HOME, PI_RAD_HOME: process.env.PI_RAD_HOME };
	const changes = [];

	let hunt = null;
	if (args.hunt) {
		hunt = readJsonFile(args.hunt, "hunt file");
		if (hunt) changes.push(`hunt file: ${args.hunt}`);
	}
	const plan = buildPlan({ hunt, skills: args.skills, mcpConfigs: args.mcpConfigs, readJson: readJsonFile });

	// ── skills ───────────────────────────────────────────────────────
	if (plan.skills.length > 0) {
		let settings = {};
		if (existsSync(args.settings)) {
			settings = readJsonFile(args.settings, "settings file");
			if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
				throw new Error(`settings is not a JSON object: ${args.settings}`);
			}
		}
		const { list, added } = unionPaths(settings.skills, plan.skills);
		if (added.length > 0) {
			settings.skills = list;
			changes.push(`skills += ${added.join(", ")}`);
			if (!args.dryRun) writeAtomic(args.settings, settings, fileMode(args.settings));
		}
	}

	// ── MCP servers ──────────────────────────────────────────────────
	const names = Object.keys(plan.servers);
	if (names.length > 0) {
		if (!args.mcpTarget) throw new Error("--mcp-target is required when MCP servers are configured");
		let target = { mcpServers: {} };
		if (existsSync(args.mcpTarget)) {
			target = readJsonFile(args.mcpTarget, "MCP target");
			if (typeof target !== "object" || target === null || Array.isArray(target)) {
				throw new Error(`MCP target is not a JSON object: ${args.mcpTarget}`);
			}
		}
		const incoming = {};
		for (const [name, definition] of Object.entries(plan.servers)) incoming[name] = expandServer(definition, vars);
		const { merged, added, updated, unchanged } = mergeServers(target.mcpServers, incoming);
		if (added.length > 0) changes.push(`mcp servers added: ${added.join(", ")}`);
		if (updated.length > 0) changes.push(`mcp servers updated: ${updated.join(", ")}`);
		if (unchanged.length > 0) changes.push(`mcp servers unchanged: ${unchanged.join(", ")}`);
		if (added.length + updated.length > 0) {
			target.mcpServers = merged;
			if (!args.dryRun) writeAtomic(args.mcpTarget, target, fileMode(args.mcpTarget));
		}
	}

	// ── pi packages ──────────────────────────────────────────────────
	const missingPackages = [];
	for (const pkg of plan.packages) {
		let installed = false;
		try {
			installed = execFileSync("pi", ["list"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).includes(pkg);
		} catch {
			// pi missing or list failed: fall through and try to install.
		}
		if (installed) {
			changes.push(`pi package present: ${pkg}`);
			continue;
		}
		missingPackages.push(pkg);
		if (args.dryRun || !args.packages) continue;
		try {
			execFileSync("pi", ["install", pkg], { stdio: ["ignore", "ignore", "pipe"] });
			changes.push(`pi package installed: ${pkg}`);
		} catch (error) {
			changes.push(`pi package FAILED: ${pkg} (${String(error.message).split("\n")[0]})`);
		}
	}

	const prefix = args.dryRun ? "apply-hunt (dry-run)" : "apply-hunt";
	if (changes.length === 0) {
		process.stdout.write(`${prefix}: nothing to change\n`);
		return;
	}
	process.stdout.write(`${prefix}:\n  ${changes.join("\n  ")}\n`);
}

/**
 * True when this file is the entry point. Compares real paths: node resolves
 * symlinks for the main module (macOS /var -> /private/var, /tmp), so a plain
 * URL comparison silently skips main() under a symlinked path.
 */
export function isMainModule(argv1) {
	if (!argv1) return false;
	try {
		return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isMainModule(process.argv[1])) {
	try {
		main();
	} catch (error) {
		process.stderr.write(`apply-hunt: ${error.message}\n`);
		process.exit(1);
	}
}

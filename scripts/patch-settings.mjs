#!/usr/bin/env node
/**
 * Safely merge pi-rad preferences into a pi settings.json.
 *
 * Usage:
 *   node patch-settings.mjs <settings.json> [--set k=v ...] [--set-if-absent k=v ...]
 *        [--append k=v ...] [--dry-run]
 *
 * Keys may be dotted for one level of nesting (e.g. compaction.enabled).
 * `--append` adds values to an array without duplicating existing entries.
 * Values are parsed as JSON when possible, otherwise treated as a string.
 * The file is created when missing, otherwise preserved byte-for-byte except
 * for the keys being changed. Writes are atomic and keep the file mode.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function parseValue(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

function setPath(obj, path, value) {
	const parts = path.split(".");
	let node = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const key = parts[i];
		if (typeof node[key] !== "object" || node[key] === null || Array.isArray(node[key])) {
			node[key] = {};
		}
		node = node[key];
	}
	node[parts[parts.length - 1]] = value;
}

function getPath(obj, path) {
	const parts = path.split(".");
	let node = obj;
	for (const part of parts) {
		if (typeof node !== "object" || node === null) return undefined;
		node = node[part];
	}
	return node;
}

function fail(message) {
	process.stderr.write(`patch-settings: ${message}\n`);
	process.exit(1);
}

const args = process.argv.slice(2);
const settingsPath = args.shift();
if (!settingsPath) fail("missing <settings.json> path");

const sets = [];
const setIfAbsent = [];
const appends = [];
let dryRun = false;

for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--set") sets.push(args[++i]);
	else if (arg === "--set-if-absent") setIfAbsent.push(args[++i]);
	else if (arg === "--append") appends.push(args[++i]);
	else if (arg === "--dry-run") dryRun = true;
	else fail(`unknown argument: ${arg}`);
}

function parseAssignment(assignment, flag) {
	if (!assignment || !assignment.includes("=")) fail(`${flag} expects key=value`);
	const index = assignment.indexOf("=");
	return [assignment.slice(0, index), parseValue(assignment.slice(index + 1))];
}

let settings = {};
let existed = false;
if (existsSync(settingsPath)) {
	existed = true;
	const raw = readFileSync(settingsPath, "utf-8").trim();
	if (raw.length > 0) {
		try {
			settings = JSON.parse(raw);
		} catch (error) {
			fail(`existing settings is not valid JSON: ${error.message}`);
		}
		if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
			fail("existing settings is not a JSON object");
		}
	}
}

const changed = [];
for (const assignment of sets) {
	const [key, value] = parseAssignment(assignment, "--set");
	if (JSON.stringify(getPath(settings, key)) === JSON.stringify(value)) continue;
	setPath(settings, key, value);
	changed.push(`${key} = ${JSON.stringify(value)}`);
}
for (const assignment of setIfAbsent) {
	const [key, value] = parseAssignment(assignment, "--set-if-absent");
	if (getPath(settings, key) !== undefined) continue;
	setPath(settings, key, value);
	changed.push(`${key} = ${JSON.stringify(value)}`);
}
for (const assignment of appends) {
	const [key, value] = parseAssignment(assignment, "--append");
	const current = getPath(settings, key);
	if (current !== undefined && !Array.isArray(current)) fail(`--append ${key}: existing value is not an array`);
	const list = Array.isArray(current) ? [...current] : [];
	const values = Array.isArray(value) ? value : [value];
	const added = values.filter((candidate) => !list.some((entry) => JSON.stringify(entry) === JSON.stringify(candidate)));
	if (added.length === 0) continue;
	setPath(settings, key, [...list, ...added]);
	changed.push(`${key} += ${JSON.stringify(added)}`);
}

if (changed.length === 0) {
	process.stdout.write("patch-settings: nothing to change\n");
	process.exit(0);
}
if (dryRun) {
	process.stdout.write(`patch-settings (dry-run):\n  ${changed.join("\n  ")}\n`);
	process.exit(0);
}

const dir = dirname(settingsPath);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const mode = existed ? statSync(settingsPath).mode & 0o777 : 0o600;
const tmp = `${settingsPath}.pi-rad.${process.pid}.tmp`;
writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf-8", mode });
chmodSync(tmp, mode);
renameSync(tmp, settingsPath);
process.stdout.write(`patch-settings: updated ${settingsPath}\n  ${changed.join("\n  ")}\n`);

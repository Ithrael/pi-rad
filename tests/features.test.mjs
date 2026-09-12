import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
	FEATURES,
	feature,
	isEnabled,
	patchesPath,
	readPatches,
	reload,
	resolveFeature,
	setFeature,
	statusLine,
	writePatches,
} from "../extensions/lib/features.ts";

const ORIGINAL_HOME = process.env.PI_RED_HOME;
let sandbox;

before(() => {
	sandbox = mkdtempSync(join(tmpdir(), "pi-red-test-"));
	process.env.PI_RED_HOME = sandbox;
	reload();
});

after(() => {
	if (ORIGINAL_HOME === undefined) delete process.env.PI_RED_HOME;
	else process.env.PI_RED_HOME = ORIGINAL_HOME;
	reload();
	rmSync(sandbox, { recursive: true, force: true });
});

describe("feature registry", () => {
	it("has unique ids with descriptions", () => {
		const ids = FEATURES.map((f) => f.id);
		assert.equal(new Set(ids).size, ids.length, "feature ids must be unique");
		for (const def of FEATURES) {
			assert.ok(def.desc.length > 0, `${def.id} needs a description`);
			assert.equal(typeof def.default, "boolean", `${def.id} needs a boolean default`);
		}
	});

	it("resolves defaults when nothing is configured", () => {
		assert.equal(resolveFeature("subagents"), true);
		assert.equal(resolveFeature("goal"), true);
		assert.equal(resolveFeature("theme"), true);
		assert.equal(resolveFeature("lean"), false);
	});

	it("lets env override the file and the default", () => {
		process.env.PI_RED_FEATURE_LEAN = "1";
		try {
			assert.equal(resolveFeature("lean"), true);
		} finally {
			delete process.env.PI_RED_FEATURE_LEAN;
		}
		process.env.PI_RED_FEATURE_SUBAGENTS = "off";
		try {
			assert.equal(resolveFeature("subagents"), false);
		} finally {
			delete process.env.PI_RED_FEATURE_SUBAGENTS;
		}
	});

	it("treats unknown features as undefined", () => {
		assert.equal(feature("nope"), undefined);
		assert.equal(resolveFeature("nope"), undefined);
		assert.equal(isEnabled("nope"), false);
	});
});

describe("patches.json persistence", () => {
	it("round-trips toggles", () => {
		setFeature("lean", true);
		assert.equal(isEnabled("lean"), true);
		assert.equal(readPatches().lean, true);

		setFeature("lean", false);
		assert.equal(isEnabled("lean"), false);
		assert.equal(readPatches().lean, false);
	});

	it("writes stable, registry-ordered keys", () => {
		writePatches({ lean: true, "sec-research": false });
		const raw = JSON.parse(readFileSync(patchesPath(), "utf-8"));
		const keys = Object.keys(raw);
		assert.deepEqual(keys, FEATURES.map((f) => f.id).filter((id) => id in raw));
	});

	it("ignores malformed patches files", () => {
		writeFileSync(patchesPath(), "{ not json", "utf-8");
		reload();
		assert.deepEqual(readPatches(), {});
		assert.equal(resolveFeature("subagents"), true);
	});

	it("reports a status line", () => {
		writePatches({});
		reload();
		assert.match(statusLine(), /^red:/);
	});
});

describe("extension feature references", () => {
	it("only references known feature ids", () => {
		const dir = new URL("../extensions/", import.meta.url);
		const known = new Set(FEATURES.map((f) => f.id));
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".ts")) continue;
			const source = readFileSync(new URL(name, dir), "utf-8");
			for (const match of source.matchAll(/isEnabled\("([^"]+)"\)/g)) {
				assert.ok(known.has(match[1]), `${name} references unknown feature "${match[1]}"`);
			}
		}
	});
});

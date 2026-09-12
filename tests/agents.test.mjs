import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";

const agentsDir = new URL("../agents/", import.meta.url);

/**
 * Minimal frontmatter reader, mirroring what rad-subagent expects: a leading
 * `---` block of `key: value` lines. rad-subagent silently skips any agent
 * without a `name` and `description`, so a typo here would drop an agent with
 * no visible error.
 */
function frontmatter(text) {
	const match = text.match(/^---\n([\s\S]*?)\n---/);
	assert.ok(match, "missing frontmatter block");
	const out = {};
	for (const line of match[1].split("\n")) {
		const index = line.indexOf(":");
		if (index === -1) continue;
		out[line.slice(0, index).trim()] = line.slice(index + 1).trim();
	}
	return out;
}

const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));

describe("bundled agents", () => {
	it("ships at least three agents", () => {
		assert.ok(files.length >= 3, `found ${files.length} agents`);
	});

	it("every agent declares a non-empty name and description", () => {
		const names = new Set();
		for (const file of files) {
			const fm = frontmatter(readFileSync(new URL(file, agentsDir), "utf-8"));
			assert.ok(fm.name, `${file} is missing a name`);
			assert.ok(fm.description, `${file} is missing a description`);
			assert.ok(!names.has(fm.name), `duplicate agent name "${fm.name}"`);
			names.add(fm.name);
		}
	});

	it("declares a non-empty tools list when present", () => {
		for (const file of files) {
			const fm = frontmatter(readFileSync(new URL(file, agentsDir), "utf-8"));
			if (fm.tools !== undefined) {
				assert.ok(fm.tools.length > 0, `${file} has an empty tools list`);
			}
		}
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPlan, expandPath, expandServer, mergeServers, unionPaths } from "../scripts/apply-hunt.mjs";

describe("apply-hunt: path expansion", () => {
	it("expands ~, ${HOME} and ${PI_RAD_HOME}", () => {
		const vars = { HOME: "/home/u", PI_RAD_HOME: "/home/u/.pi-rad" };
		assert.equal(expandPath("~/code/skills", vars), "/home/u/code/skills");
		assert.equal(expandPath("${HOME}/x", vars), "/home/u/x");
		assert.equal(expandPath("${PI_RAD_HOME}/profile", vars), "/home/u/.pi-rad/profile");
		assert.equal(expandPath("/abs/path", vars), "/abs/path");
		assert.equal(expandPath("~not-home/x", vars), "~not-home/x");
		assert.equal(expandPath(undefined, vars), undefined);
	});

	it("expands nested values in a server definition but leaves keys alone", () => {
		const expanded = expandServer(
			{
				command: "npx",
				args: ["-y", "pkg", "--user-data-dir", "~/profile"],
				env: { PATH: "${HOME}/bin" },
				nested: [{ deep: "~/deep" }],
			},
			{ HOME: "/home/u" },
		);
		assert.deepEqual(expanded, {
			command: "npx",
			args: ["-y", "pkg", "--user-data-dir", "/home/u/profile"],
			env: { PATH: "/home/u/bin" },
			nested: [{ deep: "/home/u/deep" }],
		});
	});
});

describe("apply-hunt: merging", () => {
	it("unions skill paths without duplicating or reordering", () => {
		const { list, added } = unionPaths(["/a", "/b"], ["/b", "/c", ""]);
		assert.deepEqual(list, ["/a", "/b", "/c"]);
		assert.deepEqual(added, ["/c"]);
		assert.deepEqual(unionPaths(undefined, ["/a"]).added, ["/a"]);
		assert.deepEqual(unionPaths(["/a"], ["/a"]).added, []);
	});

	it("classifies MCP servers as added, updated or unchanged", () => {
		const existing = { keep: { command: "x" }, same: { command: "s" }, change: { command: "old" } };
		const incoming = { same: { command: "s" }, change: { command: "new" }, fresh: { command: "f" } };
		const { merged, added, updated, unchanged } = mergeServers(existing, incoming);
		assert.deepEqual(added, ["fresh"]);
		assert.deepEqual(updated, ["change"]);
		assert.deepEqual(unchanged, ["same"]);
		assert.equal(merged.keep.command, "x", "unrelated servers survive");
		assert.equal(merged.change.command, "new");
	});
});

describe("apply-hunt: plan", () => {
	it("combines the hunt file with CLI values, later MCP files winning", () => {
		const files = {
			"/hunt.json": {
				skills: ["/from-hunt"],
				mcpServers: { asc: { command: "python" }, shared: { command: "hunt" } },
				mcpConfig: "/extra.json",
				piPackages: ["npm:pi-mcp-adapter"],
			},
			"/extra.json": { mcpServers: { shared: { command: "extra" } } },
			"/cli.json": { mcpServers: { playwright: { command: "npx" } } },
		};
		const plan = buildPlan({
			hunt: files["/hunt.json"],
			skills: ["/from-cli"],
			mcpConfigs: ["/cli.json"],
			readJson: (path) => files[path],
		});
		assert.deepEqual(plan.skills, ["/from-hunt", "/from-cli"]);
		assert.deepEqual(Object.keys(plan.servers).sort(), ["asc", "playwright", "shared"]);
		assert.equal(plan.servers.shared.command, "extra", "the later mcpConfig file wins");
		assert.deepEqual(plan.packages, ["npm:pi-mcp-adapter"]);
	});

	it("accepts a missing hunt file", () => {
		const plan = buildPlan({ hunt: null, skills: ["/only"], mcpConfigs: [], readJson: () => ({}) });
		assert.deepEqual(plan.skills, ["/only"]);
		assert.deepEqual(plan.servers, {});
		assert.deepEqual(plan.packages, []);
	});
});

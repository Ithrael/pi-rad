import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { makeCtx, makePi } from "./support/fake-pi.mjs";

// rad-goal.ts runtime-imports typebox; stub it so the module loads under Node.
register("./support/typebox-loader.mjs", import.meta.url);

const { default: radGoal } = await import("../extensions/rad-goal.ts");

const ORIGINAL_HOME = process.env.PI_RAD_HOME;
const ORIGINAL_MAX = process.env.PI_RAD_GOAL_MAX;
let sandbox;

before(() => {
	sandbox = mkdtempSync(join(tmpdir(), "pi-rad-goal-"));
	writeFileSync(join(sandbox, "patches.json"), JSON.stringify({ goal: true }), "utf-8");
	process.env.PI_RAD_HOME = sandbox;
});

after(() => {
	if (ORIGINAL_HOME === undefined) delete process.env.PI_RAD_HOME;
	else process.env.PI_RAD_HOME = ORIGINAL_HOME;
	if (ORIGINAL_MAX === undefined) delete process.env.PI_RAD_GOAL_MAX;
	else process.env.PI_RAD_GOAL_MAX = ORIGINAL_MAX;
	rmSync(sandbox, { recursive: true, force: true });
});

describe("goal mode", () => {
	it("registers its tools and command when enabled", () => {
		const { pi, tools, commands } = makePi();
		radGoal(pi);
		assert.ok(tools.has("goal_complete"));
		assert.ok(tools.has("goal_blocked"));
		assert.ok(commands.has("goal"));
	});

	it("refreshes the footer after goal_complete", async () => {
		const { pi, handlers, tools, commands } = makePi();
		const { ctx, statuses } = makeCtx();
		radGoal(pi);

		await commands.get("goal").handler("ship the fix", ctx);
		assert.equal(statuses.get("pi-rad-goal"), "goal:active 0/20");

		await tools.get("goal_complete").execute("call-1", { summary: "done", evidence: "tests pass" });
		await handlers.get("agent_settled")({}, ctx);

		assert.equal(statuses.get("pi-rad-goal"), "goal:done 0/20");
	});

	it("refreshes the footer after goal_blocked", async () => {
		const { pi, handlers, tools, commands } = makePi();
		const { ctx, statuses } = makeCtx();
		radGoal(pi);

		await commands.get("goal").handler("ship the fix", ctx);
		await tools.get("goal_blocked").execute("call-2", { reason: "need access" });
		await handlers.get("agent_settled")({}, ctx);

		assert.equal(statuses.get("pi-rad-goal"), "goal:blocked 0/20");
	});
});

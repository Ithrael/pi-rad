import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { reload, setFeature } from "../extensions/lib/features.ts";
import { makeCtx, makePi } from "./support/fake-pi.mjs";

const { default: radPlan } = await import("../extensions/rad-plan.ts");

const ORIGINAL_HOME = process.env.PI_RAD_HOME;
let sandbox;

before(() => {
	sandbox = mkdtempSync(join(tmpdir(), "pi-rad-plan-"));
	process.env.PI_RAD_HOME = sandbox;
	reload();
});

after(() => {
	if (ORIGINAL_HOME === undefined) delete process.env.PI_RAD_HOME;
	else process.env.PI_RAD_HOME = ORIGINAL_HOME;
	reload();
	rmSync(sandbox, { recursive: true, force: true });
});

describe("plan mode", () => {
	it("restricts the tool set and blocks edit/write while active", async () => {
		setFeature("plan-mode", true);
		const { pi, handlers, commands, activeTools } = makePi();
		const { ctx } = makeCtx();
		radPlan(pi);

		await commands.get("plan").handler("", ctx);
		assert.ok(!activeTools().includes("edit"));
		assert.ok(!activeTools().includes("write"));

		const block = await handlers.get("tool_call")({ toolName: "edit" }, ctx);
		assert.equal(block?.block, true);

		const injected = await handlers.get("before_agent_start")({ systemPrompt: "base" });
		assert.ok(injected.systemPrompt.includes("Plan mode (pi-rad) is active"));
	});

	it("restores the previous tool set on toggle off", async () => {
		setFeature("plan-mode", true);
		const { pi, commands, activeTools } = makePi();
		const { ctx } = makeCtx();
		radPlan(pi);

		await commands.get("plan").handler("", ctx);
		await commands.get("plan").handler("", ctx);
		assert.deepEqual(activeTools(), ["read", "bash", "edit", "write", "grep", "find", "ls"]);
	});

	it("can leave plan mode after the feature is turned off at runtime", async () => {
		setFeature("plan-mode", true);
		const { pi, commands, activeTools } = makePi();
		const { ctx } = makeCtx();
		radPlan(pi);

		await commands.get("plan").handler("", ctx);
		assert.ok(!activeTools().includes("edit"));

		setFeature("plan-mode", false);
		await commands.get("plan").handler("", ctx);
		assert.ok(activeTools().includes("edit"));
	});
});

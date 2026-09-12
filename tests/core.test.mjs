import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { reload, setFeature } from "../extensions/lib/features.ts";
import { makeCtx, makePi } from "./support/fake-pi.mjs";

const { default: radCore } = await import("../extensions/rad-core.ts");

const ORIGINAL_HOME = process.env.PI_RAD_HOME;
let sandbox;

before(() => {
	sandbox = mkdtempSync(join(tmpdir(), "pi-rad-core-"));
	process.env.PI_RAD_HOME = sandbox;
	reload();
});

after(() => {
	if (ORIGINAL_HOME === undefined) delete process.env.PI_RAD_HOME;
	else process.env.PI_RAD_HOME = ORIGINAL_HOME;
	reload();
	rmSync(sandbox, { recursive: true, force: true });
});

describe("core: project trust", () => {
	it("returns a trust decision when auto-trust is on", async () => {
		setFeature("auto-trust", true);
		const { pi, handlers } = makePi();
		radCore(pi);
		const result = await handlers.get("project_trust")({}, makeCtx().ctx);
		assert.deepEqual(result, { trusted: "yes", remember: true });
	});

	it("leaves the decision to pi when auto-trust is off", async () => {
		setFeature("auto-trust", false);
		const { pi, handlers } = makePi();
		radCore(pi);
		assert.equal(await handlers.get("project_trust")({}, makeCtx().ctx), undefined);
		setFeature("auto-trust", true);
	});
});

describe("core: attribution headers", () => {
	it("strips tracking headers and keeps the rest", async () => {
		setFeature("attribution-off", true);
		const { pi, handlers } = makePi();
		radCore(pi);
		const headers = { "x-openrouter-title": "a", "x-anthropic-billing-header": "b", "x-keep": "c" };
		await handlers.get("before_provider_headers")({ headers });
		assert.equal(headers["x-openrouter-title"], null);
		assert.equal(headers["x-anthropic-billing-header"], null);
		assert.equal(headers["x-keep"], "c");
	});

	it("leaves headers alone when attribution-off is disabled", async () => {
		setFeature("attribution-off", false);
		const { pi, handlers } = makePi();
		radCore(pi);
		const headers = { "x-openrouter-title": "a" };
		await handlers.get("before_provider_headers")({ headers });
		assert.equal(headers["x-openrouter-title"], "a");
		setFeature("attribution-off", true);
	});
});

describe("core: security framing", () => {
	it("injects the security-research context when armor is off", async () => {
		setFeature("sec-research", true);
		setFeature("armor", false);
		const { pi, handlers } = makePi();
		radCore(pi);
		const result = await handlers.get("before_agent_start")({
			systemPrompt: "base",
			prompt: "solve this pwn CTF challenge",
		});
		assert.ok(result.systemPrompt.includes("Security research context (pi-rad)"));
	});

	it("does not inject when armor is on (armor is the stronger layer)", async () => {
		setFeature("armor", true);
		const { pi, handlers } = makePi();
		radCore(pi);
		const result = await handlers.get("before_agent_start")({
			systemPrompt: "base",
			prompt: "solve this pwn CTF challenge",
		});
		assert.equal(result, undefined);
	});

	it("does not inject for ordinary prompts", async () => {
		setFeature("armor", false);
		const { pi, handlers } = makePi();
		radCore(pi);
		const result = await handlers.get("before_agent_start")({ systemPrompt: "base", prompt: "fix the failing tests" });
		assert.equal(result, undefined);
		setFeature("armor", true);
	});
});

describe("core: lean tools", () => {
	it("trims exploration tools at session start when lean is on", async () => {
		setFeature("lean", true);
		const { pi, handlers, activeTools } = makePi(["read", "bash", "edit", "write", "grep", "find", "ls"]);
		radCore(pi);
		await handlers.get("session_start")({}, makeCtx().ctx);
		assert.deepEqual(activeTools(), ["read", "bash", "edit", "write"]);
		setFeature("lean", false);
	});

	it("keeps the tool set when lean is off", async () => {
		setFeature("lean", false);
		const { pi, handlers, activeTools } = makePi(["read", "bash", "edit", "write", "grep", "find", "ls"]);
		radCore(pi);
		await handlers.get("session_start")({}, makeCtx().ctx);
		assert.ok(activeTools().includes("grep"));
	});
});

describe("core: destructive-command guard", () => {
	it("blocks a destructive command when guard is on and there is no UI", async () => {
		setFeature("guard", true);
		const { pi, handlers } = makePi();
		radCore(pi);
		const { ctx } = makeCtx();
		ctx.hasUI = false;
		const result = await handlers.get("tool_call")({ toolName: "bash", input: { command: "rm -rf /" } }, ctx);
		assert.equal(result.block, true);
		setFeature("guard", false);
	});

	it("allows a safe command", async () => {
		setFeature("guard", true);
		const { pi, handlers } = makePi();
		radCore(pi);
		const result = await handlers.get("tool_call")({ toolName: "bash", input: { command: "ls -la" } }, makeCtx().ctx);
		assert.equal(result, undefined);
		setFeature("guard", false);
	});

	it("does nothing when guard is off", async () => {
		setFeature("guard", false);
		const { pi, handlers } = makePi();
		radCore(pi);
		const result = await handlers.get("tool_call")({ toolName: "bash", input: { command: "rm -rf /" } }, makeCtx().ctx);
		assert.equal(result, undefined);
	});
});

describe("core: /rad command", () => {
	it("toggles a feature and reports it", async () => {
		setFeature("lean", false);
		const { pi, commands } = makePi();
		const { ctx, notifications } = makeCtx();
		radCore(pi);
		await commands.get("rad").handler("lean on", ctx);
		assert.ok(notifications.some((m) => m.includes("lean = on")));
		setFeature("lean", false);
	});

	it("rejects an unknown feature", async () => {
		const { pi, commands } = makePi();
		const { ctx, notifications } = makeCtx();
		radCore(pi);
		await commands.get("rad").handler("nope on", ctx);
		assert.ok(notifications.some((m) => m.includes("unknown feature")));
	});
});

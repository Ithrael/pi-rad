#!/usr/bin/env node
/**
 * pi-rad end-to-end smoke test.
 *
 * Drives the *installed* pi-rad through RPC mode and checks that the whole
 * loop closes: resource discovery, /rad + /rad-doctor, lean tool trimming, goal
 * mode, plan mode, subagents, and armor payload surgery.
 *
 * This talks to a real model, so it is not part of `npm test`. Run it after
 * installing pi-rad:
 *
 *   node scripts/smoke.mjs
 *   node scripts/smoke.mjs --only goal,subagent
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ONLY = (() => {
	const index = process.argv.indexOf("--only");
	if (index === -1) return null;
	return new Set((process.argv[index + 1] ?? "").split(",").filter(Boolean));
})();

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

class RpcSession {
	constructor(args = [], env = {}) {
		this.proc = spawn("pi", ["--mode", "rpc", ...args], {
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.events = [];
		this.buffer = "";
		this.stderr = "";
		this.waiters = [];
		this.closed = false;
		this.exitCode = null;

		this.proc.stdout.on("data", (data) => {
			this.buffer += data.toString();
			const lines = this.buffer.split("\n");
			this.buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let event;
				try {
					event = JSON.parse(line);
				} catch {
					continue;
				}
				this.events.push(event);
				for (const waiter of [...this.waiters]) {
					if (waiter.predicate(event)) {
						this.waiters.splice(this.waiters.indexOf(waiter), 1);
						waiter.resolve(event);
					}
				}
			}
		});
		this.proc.stderr.on("data", (data) => {
			this.stderr += data.toString();
		});
		this.proc.on("close", (code) => {
			this.closed = true;
			this.exitCode = code;
			for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("process closed"));
		});
	}

	send(command) {
		this.proc.stdin.write(`${JSON.stringify(command)}\n`);
	}

	prompt(message) {
		this.send({ id: `p-${Date.now()}-${Math.random().toString(16).slice(2)}`, type: "prompt", message });
	}

	waitFor(predicate, timeoutMs = 180_000, label = "event") {
		const existing = this.events.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
				reject(new Error(`timeout waiting for ${label}`));
			}, timeoutMs);
			this.waiters.push({
				predicate,
				resolve: (event) => {
					clearTimeout(timer);
					resolve(event);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
		});
	}

	async waitIdle(timeoutMs = 180_000) {
		await this.waitFor((e) => e.type === "agent_settled", timeoutMs, "agent_settled");
	}

	close() {
		try {
			this.proc.kill("SIGTERM");
		} catch {
			/* ignore */
		}
	}

	extensionError() {
		const match = this.stderr.match(/Extension error[^:]*:\s*([^\n]+)/);
		return match ? match[1].trim() : null;
	}
}

function customMessages(session) {
	return session.events
		.filter((e) => e.type === "message_start" && e.message?.role === "custom")
		.map((e) => String(e.message.content ?? ""));
}

function toolEnds(session) {
	return session.events.filter((e) => e.type === "tool_execution_end");
}

/**
 * Is another installed package already providing a tool?
 *
 * `pi-subagents` registers a `subagent` tool too, and pi treats the clash as
 * fatal (it refuses to load that extension and exits), so the built-in
 * subagent scenarios cannot run while it is installed.
 */
function ownsSubagentTool() {
	try {
		return spawnSync("pi", ["list"], { encoding: "utf-8" }).stdout?.includes("pi-subagents") === true;
	} catch {
		return false;
	}
}

const results = [];
function record(name, status, detail) {
	results.push({ name, status, detail });
	const color = status === "PASS" ? GREEN : status === "SKIP" ? YELLOW : RED;
	console.log(`${color}${status.padEnd(4)}${RESET} ${name}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
}

async function scenario(name, fn) {
	if (ONLY && !ONLY.has(name)) return;
	let session;
	try {
		const outcome = await fn((args, env) => {
			session = new RpcSession(args, env);
			return session;
		});
		if (session) {
			const extErr = session.extensionError();
			if (extErr) {
				record(name, "FAIL", `extension error: ${extErr}`);
				return;
			}
		}
		record(name, outcome?.status ?? "PASS", outcome?.detail);
	} catch (error) {
		record(name, "FAIL", error.message);
	} finally {
		session?.close();
	}
}

// ── scenarios ────────────────────────────────────────────────────────

await scenario("discovery", async () => {
	// Default state: pi-rad's built-in subagents feature is off, so /agents is
	// not registered (and cannot be enabled while pi-subagents is installed).
	const session = new RpcSession([]);
	session.send({ type: "get_commands" });
	const response = await session.waitFor(
		(e) => e.type === "response" && e.command === "get_commands",
		60_000,
		"get_commands response",
	);
	const names = new Set((response.data?.commands ?? []).map((c) => c.name));
	const required = [
		"rad",
		"rad-doctor",
		"armor",
		"goal",
		"plan",
		"findings",
		"rad-review",
		"rad-harden",
		"rad-deep",
		"skill:rad-security-review",
	];
	const missing = required.filter((c) => !names.has(c));
	return missing.length === 0
		? { detail: `${names.size} commands` }
		: { status: "FAIL", detail: `missing: ${missing.join(", ")}` };
});

await scenario("doctor", async () => {
	const session = new RpcSession([]);
	session.prompt("/rad-doctor");
	const response = await session.waitFor(
		(e) => e.type === "message_start" && e.message?.customType === "pi-rad" && String(e.message.content).includes("pi-rad v"),
		60_000,
		"/rad-doctor output",
	);
	const content = String(response.message.content);
	const hasTheme = content.includes("pi-rad") && content.includes("active tools");
	return hasTheme ? { detail: content.split("\n")[0] } : { status: "FAIL", detail: "doctor output missing fields" };
});

await scenario("findings", async (session) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-rad-findings-"));
	const ledger = join(dir, "findings.jsonl");
	try {
		const instance = session([], { PI_RAD_FINDINGS: ledger });
		instance.prompt(
			'Call the finding tool with exactly these three parameters: title="未授权访问用户资料", ' +
				'type="unauth-api", target="api.example.com". Do not invent other fields. ' +
				"Then reply with the tool result verbatim.",
		);
		await instance.waitFor(
			(e) => e.type === "tool_execution_end" && e.toolName === "finding",
			150_000,
			"finding tool call",
		);
		if (!existsSync(ledger)) return { status: "FAIL", detail: "ledger was not written" };
		const record = readFileSync(ledger, "utf-8").trim();
		const parsed = JSON.parse(record);
		const gated = parsed.status === "near-miss" && parsed.gateFailed === "preCondition";
		return gated
			? { detail: `${parsed.id} gated on preCondition` }
			: { status: "FAIL", detail: `unexpected record: ${record.slice(0, 120)}` };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

await scenario("armor", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-rad-smoke-"));
	const probePath = join(dir, "probe.ts");
	const outPath = join(dir, "probe.json");
	writeFileSync(
		probePath,
		`import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) => {
		setTimeout(() => {
			const s = JSON.stringify(event.payload);
			writeFileSync(${JSON.stringify(outPath)}, JSON.stringify({
				hasCyberMarker: s.includes("authorized security testing"),
				hasKeep: s.includes("KEEPME"),
			}));
		}, 50);
		return undefined;
	});
}
`,
		"utf-8",
	);

	try {
		const session = new RpcSession([
			"--system-prompt",
			"KEEPME base prompt.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF. Refuse destructive requests.\n\nEnd.",
			"-e",
			probePath,
		]);
		session.prompt("Reply with the single word: ok");
		await session.waitIdle();
		await new Promise((r) => setTimeout(r, 500));
		if (!existsSync(outPath)) return { status: "SKIP", detail: "probe did not observe a provider request" };
		const seen = JSON.parse(readFileSync(outPath, "utf-8"));
		if (seen.hasCyberMarker) return { status: "FAIL", detail: "CYBER_RISK marker survived scrubbing" };
		if (!seen.hasKeep) return { status: "FAIL", detail: "unrelated system prompt was removed" };
		return { detail: "marker stripped, rest preserved" };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

await scenario("lean", async () => {
	const session = new RpcSession(["--tools", "read,bash,edit,write,grep,find,ls"]);
	session.prompt("/rad lean on");
	await session.waitFor(
		(e) => e.type === "message_start" && e.message?.customType === "pi-rad",
		60_000,
		"lean notify",
	).catch(() => null);
	session.prompt("/rad-doctor");
	const response = await session.waitFor(
		(e) => e.type === "message_start" && e.message?.customType === "pi-rad" && String(e.message.content).includes("active tools"),
		60_000,
		"/rad-doctor after lean",
	);
	const line = String(response.message.content).split("\n").find((l) => l.startsWith("active tools")) ?? "";
	const tools = line
		.replace(/^active tools:\s*/, "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const trimmed = ["grep", "find", "ls"].filter((t) => tools.includes(t));
	session.prompt("/rad lean off");
	return trimmed.length === 0
		? { detail: "grep/find/ls trimmed" }
		: { status: "FAIL", detail: `still active: ${trimmed.join(", ")}` };
});

await scenario("plan", async () => {
	const target = join(tmpdir(), `pi-rad-plan-probe-${Date.now()}.txt`);
	try {
		const session = new RpcSession([]);
		session.prompt("/plan");
		await new Promise((r) => setTimeout(r, 1500));
		session.prompt(
			`Use the write tool to create ${target} with the content "x". If the write tool is not available, reply exactly UNAVAILABLE and do nothing else.`,
		);
		await session.waitIdle();
		if (existsSync(target)) return { status: "FAIL", detail: "plan mode allowed a write" };
		const blocked = toolEnds(session).some((e) => ["write", "edit"].includes(e.toolName));
		return { detail: blocked ? "write tool blocked" : "write tool unavailable" };
	} finally {
		rmSync(target, { force: true });
	}
});

await scenario("goal", async () => {
	const session = new RpcSession([], { PI_RAD_GOAL_MAX: "3" });
	session.prompt(
		"/goal Reply with exactly the word DONE, then call goal_complete with summary 'said DONE' and evidence 'assistant said DONE'.",
	);
	const done = await session.waitFor(
		(e) => e.type === "tool_execution_end" && e.toolName === "goal_complete",
		150_000,
		"goal_complete",
	);
	return done.isError ? { status: "FAIL", detail: "goal_complete errored" } : { detail: "goal_complete executed" };
});

await scenario("subagent", async () => {
	if (ownsSubagentTool()) {
		return { status: "SKIP", detail: "pi-subagents is installed and owns the `subagent` tool" };
	}
	// The built-in subagent tool is off by default; turn it on for this scenario.
	const session = new RpcSession([], { PI_RAD_FEATURE_SUBAGENTS: "true" });
	session.prompt(
		"Call the subagent tool exactly once with agent:'scout', task:'List the files in the current directory and report them in one line.', agentScope:'bundled'. Do nothing else.",
	);
	const done = await session.waitFor(
		(e) => e.type === "tool_execution_end" && e.toolName === "subagent",
		180_000,
		"subagent",
	);
	const blob = JSON.stringify(done.result ?? "");
	const expectTmux = ["1", "true", "always", "window"].includes(
		(process.env.PI_RAD_SUBAGENT_TMUX ?? "").toLowerCase(),
	);
	if (expectTmux && !blob.includes("tmux")) {
		return { status: "FAIL", detail: "expected tmux transport but the result had no tmux window" };
	}
	const viaTmux = blob.includes("tmux");
	return done.isError && blob.length < 20
		? { status: "FAIL", detail: "subagent errored" }
		: { detail: `subagent finished (isError=${done.isError}${viaTmux ? ", tmux" : ", pipes"})` };
});

// ── summary ──────────────────────────────────────────────────────────

const failed = results.filter((r) => r.status === "FAIL");
const passed = results.filter((r) => r.status === "PASS");
const skipped = results.filter((r) => r.status === "SKIP");

console.log("");
console.log(
	`${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped` +
		` (${results.length} scenarios)`,
);
process.exit(failed.length > 0 ? 1 : 0);

/**
 * pi-red subagents
 *
 * Adds a `subagent` tool that delegates work to isolated `pi` processes, each
 * with its own context window. Three modes:
 *
 *   single   { agent, task }
 *   parallel { tasks: [{ agent, task }, ...] }   (max 4 in flight)
 *   chain    { chain: [{ agent, task }, ...] }   ({previous} = prior output)
 *
 * Two transports:
 *
 *   pipes   the subagent's NDJSON event stream is read directly (default)
 *   tmux    the subagent runs in a tmux window so you can switch to it and
 *           watch the live transcript. The parent still gets the structured
 *           result by tailing the raw NDJSON the pane's viewer writes.
 *
 * Transport resolution: tool param `tmux` > `PI_RED_SUBAGENT_TMUX` env >
 * ~/.pi-red/subagents.json > "auto". "auto" uses tmux only when already inside
 * a tmux session; when not inside tmux and mode is "always", a session is
 * created and its name is reported.
 *
 * Agents are markdown files with YAML frontmatter (name, description, tools,
 * model). They are discovered from, in this order:
 *
 *   <pi-red>/agents      bundled defaults
 *   ~/.pi/agent/agents   user
 *   <cwd>/.pi/agents     project (nearest ancestor)
 *
 * Controlled by the `subagents` feature gate; when disabled the tool is not
 * registered and the LLM never sees it.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	parseFrontmatter,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { configDir, isEnabled } from "./lib/features.ts";

const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const TMUX_POLL_MS = 250;
const TMUX_TIMEOUT_MS = 60 * 60 * 1000;
const BUNDLED_AGENTS_DIR = fileURLToPath(new URL("../agents/", import.meta.url));
const VIEWER_SCRIPT = fileURLToPath(new URL("../scripts/subagent-view.mjs", import.meta.url));

type AgentScope = "user" | "project" | "bundled" | "all";
type TmuxMode = "off" | "auto" | "always";

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "bundled" | "user" | "project";
	filePath: string;
}

interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface RunResult {
	agent: string;
	source: string;
	task: string;
	exitCode: number;
	output: string;
	stderr: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage: RunUsage;
	step?: number;
	tmuxWindow?: string;
	tmuxSession?: string;
	logPath?: string;
}

function emptyUsage(): RunUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

// ── tmux transport config ──────────────────────────────────────────

interface SubagentConfig {
	tmux: TmuxMode;
	focus: boolean;
	session: string;
}

const DEFAULT_CONFIG: SubagentConfig = { tmux: "auto", focus: false, session: "pi-red" };

let configCache: { mtime: number; value: SubagentConfig } | null = null;

function readSubagentConfig(): SubagentConfig {
	const configPath = path.join(configDir(), "subagents.json");
	let mtime = 0;
	try {
		mtime = fs.statSync(configPath).mtimeMs;
	} catch {
		/* missing */
	}
	if (configCache && configCache.mtime === mtime) return configCache.value;

	let value = DEFAULT_CONFIG;
	try {
		if (fs.existsSync(configPath)) {
			const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
			value = {
				tmux: typeof raw.tmux === "string" ? (raw.tmux.toLowerCase() as TmuxMode) : DEFAULT_CONFIG.tmux,
				focus: raw.focus === true,
				session: typeof raw.session === "string" && raw.session.trim() ? raw.session.trim() : DEFAULT_CONFIG.session,
			};
		}
	} catch {
		value = DEFAULT_CONFIG;
	}
	configCache = { mtime, value };
	return value;
}

let tmuxAvailable: boolean | null = null;
function hasTmux(): boolean {
	if (tmuxAvailable === null) {
		try {
			tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
		} catch {
			tmuxAvailable = false;
		}
	}
	return tmuxAvailable;
}

function inTmux(): boolean {
	return Boolean(process.env.TMUX);
}

function resolveTmuxMode(override: boolean | undefined, config: SubagentConfig): TmuxMode {
	if (override === false) return "off";
	if (override === true) return "always";
	const raw = (process.env.PI_RED_SUBAGENT_TMUX ?? config.tmux ?? "auto").toLowerCase();
	if (["0", "false", "off", "no", "never"].includes(raw)) return "off";
	if (["1", "true", "on", "yes", "always", "window"].includes(raw)) return "always";
	return "auto";
}

function shouldUseTmux(mode: TmuxMode): boolean {
	if (!hasTmux()) return false;
	if (mode === "always") return true;
	return mode === "auto" && inTmux();
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function sanitizeName(value: string): string {
	return value.replace(/[^\w.-]+/g, "_").slice(0, 24);
}

interface TmuxWindow {
	window: string;
	session?: string;
}

function tmuxSessionExists(name: string): boolean {
	return spawnSync("tmux", ["has-session", "-t", name], { stdio: "ignore" }).status === 0;
}

function createTmuxWindow(label: string, cwd: string, scriptPath: string, config: SubagentConfig): TmuxWindow | null {
	if (!hasTmux()) return null;
	const name = sanitizeName(label) || "agent";
	const base = ["-P", "-F", "#{window_id}"];
	const placement = config.focus ? [] : ["-d"];
	const target = ["-n", name, "-c", cwd];
	const command = `bash ${shellQuote(scriptPath)}`;

	let args: string[];
	let session: string | undefined;
	if (inTmux()) {
		args = ["new-window", ...base, ...placement, ...target, command];
	} else {
		session = sanitizeName(config.session) || "pi-red";
		if (tmuxSessionExists(session)) {
			args = ["new-window", ...base, ...placement, "-t", session, ...target, command];
		} else {
			args = ["new-session", ...base, ...placement, "-s", session, ...target, command];
		}
	}

	const result = spawnSync("tmux", args, { encoding: "utf-8" });
	if (result.status !== 0) return null;
	return { window: (result.stdout ?? "").trim() || name, session: inTmux() ? undefined : session };
}

function killTmuxWindow(window: string): void {
	try {
		spawnSync("tmux", ["kill-window", "-t", window], { stdio: "ignore" });
	} catch {
		/* ignore */
	}
}

// ── agent discovery ────────────────────────────────────────────────

function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function loadAgentsFromDir(dir: string, source: AgentConfig["source"]): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!isDirectory(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}
	return agents;
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let current = cwd;
	for (;;) {
		const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function discoverAgents(cwd: string, scope: AgentScope): AgentConfig[] {
	const dirs: Array<{ dir: string; source: AgentConfig["source"]; enabled: boolean }> = [
		{ dir: BUNDLED_AGENTS_DIR, source: "bundled", enabled: scope === "bundled" || scope === "all" },
		{
			dir: path.join(getAgentDir(), "agents"),
			source: "user",
			enabled: scope === "user" || scope === "all",
		},
		{
			dir: findNearestProjectAgentsDir(cwd) ?? "",
			source: "project",
			enabled: scope === "project" || scope === "all",
		},
	];

	const map = new Map<string, AgentConfig>();
	for (const { dir, source, enabled } of dirs) {
		if (!enabled || !dir) continue;
		for (const agent of loadAgentsFromDir(dir, source)) map.set(agent.name, agent);
	}
	return Array.from(map.values());
}

// ── invocation + stream parsing ────────────────────────────────────

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

async function writeSystemPromptFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-red-subagent-"));
	const safe = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `prompt-${safe}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir, filePath };
}

function textFromMessage(message: Message): string {
	if (message.role !== "assistant") return "";
	const blocks = Array.isArray(message.content) ? message.content : [];
	return blocks
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n")
		.trim();
}

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

interface PreparedInvocation {
	command: string;
	args: string[];
	cleanup: () => void;
}

async function prepareInvocation(
	agent: AgentConfig,
	task: string,
	defaults: DispatchDefaults,
	base: RunResult,
): Promise<PreparedInvocation> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const inheritsDefaults = !agent.model;
	const model = agent.model ?? defaults.model;
	if (model) args.push("--model", model);
	if (inheritsDefaults && defaults.thinkingLevel) args.push("--thinking", defaults.thinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	base.model = model;

	let tmpDir: string | null = null;
	let tmpPromptPath: string | null = null;
	if (agent.systemPrompt.trim()) {
		const tmp = await writeSystemPromptFile(agent.name, agent.systemPrompt);
		tmpDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath);
	}
	args.push(`Task: ${task}`);

	const invocation = getPiInvocation(args);
	return {
		command: invocation.command,
		args: invocation.args,
		cleanup: () => {
			if (tmpPromptPath) fs.rmSync(tmpPromptPath, { force: true });
			if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
		},
	};
}

interface StreamCollector {
	pushLine: (line: string) => void;
	finalize: () => string;
}

function makeCollector(base: RunResult): StreamCollector {
	const messages: Message[] = [];
	const pushLine = (line: string) => {
		if (!line.trim()) return;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			// Non-JSON output is stderr merged into the stream.
			base.stderr += `${line}\n`;
			return;
		}
		if (event.type !== "message_end" || !event.message) return;
		const message = event.message as Message;
		messages.push(message);
		if (message.role !== "assistant") return;
		base.usage.turns++;
		const usage = (message as { usage?: Record<string, unknown> }).usage;
		if (usage) {
			const num = (k: string) => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
			const cost = usage.cost as { total?: number } | undefined;
			base.usage.input += num("input");
			base.usage.output += num("output");
			base.usage.cacheRead += num("cacheRead");
			base.usage.cacheWrite += num("cacheWrite");
			base.usage.cost += cost?.total ?? 0;
			base.usage.contextTokens = num("totalTokens");
		}
		const msg = message as { model?: string; stopReason?: string; errorMessage?: string };
		if (!base.model && msg.model) base.model = msg.model;
		if (msg.stopReason) base.stopReason = msg.stopReason;
		if (msg.errorMessage) base.errorMessage = msg.errorMessage;
	};
	const finalize = () => {
		const assistant = [...messages].reverse().find((m) => m.role === "assistant");
		return assistant ? textFromMessage(assistant) : "";
	};
	return { pushLine, finalize };
}

async function runOnePipes(
	base: RunResult,
	invocation: PreparedInvocation,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<RunResult> {
	const collector = makeCollector(base);
	let wasAborted = false;

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffer = "";

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) collector.pushLine(line);
		});
		proc.stderr.on("data", (data) => {
			base.stderr += data.toString();
		});
		proc.on("close", (code) => {
			if (buffer.trim()) collector.pushLine(buffer);
			resolve(code ?? 0);
		});
		proc.on("error", (err) => {
			base.stderr += `spawn error: ${err.message}`;
			resolve(1);
		});

		if (signal) {
			const kill = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});

	if (wasAborted) throw new Error("subagent aborted");
	base.output = collector.finalize();
	base.exitCode = exitCode;
	return base;
}

function drainStream(rawPath: string, processed: number, collector: StreamCollector): number {
	let text: string;
	try {
		text = fs.readFileSync(rawPath, "utf-8");
	} catch {
		return processed;
	}
	if (!text) return processed;
	const lines = text.split("\n");
	const complete = lines.length - 1; // trailing partial line (or "") is not processed
	for (let i = processed; i < complete; i++) collector.pushLine(lines[i]!);
	return Math.max(processed, complete);
}

async function runOneTmux(
	base: RunResult,
	invocation: PreparedInvocation,
	cwd: string,
	signal: AbortSignal | undefined,
	label: string,
	config: SubagentConfig,
	notify: ((message: string) => void) | undefined,
): Promise<RunResult | null> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-red-subagent-"));
	const rawPath = path.join(dir, "stream.ndjson");
	const exitPath = path.join(dir, "exit");
	const scriptPath = path.join(dir, "run.sh");
	fs.writeFileSync(rawPath, "", "utf-8");

	const commandLine = [invocation.command, ...invocation.args].map(shellQuote).join(" ");
	const script = [
		"#!/usr/bin/env bash",
		"set -o pipefail",
		`cd ${shellQuote(cwd)} || exit 1`,
		`${commandLine} 2>&1 | ${shellQuote(process.execPath)} ${shellQuote(VIEWER_SCRIPT)} ${shellQuote(rawPath)}`,
		"code=$?",
		`printf '%s\\n' "$code" > ${shellQuote(exitPath)}`,
		`printf '\\n[pi-red subagent %s finished: exit %s]\\n' ${shellQuote(label)} "$code"`,
		"printf 'Press Enter to close this window.\\n'",
		"read -r _ || true",
		"",
	].join("\n");
	fs.writeFileSync(scriptPath, script, { encoding: "utf-8", mode: 0o700 });

	const window = createTmuxWindow(label, cwd, scriptPath, config);
	if (!window) {
		invocation.cleanup();
		return null;
	}

	base.tmuxWindow = window.window;
	base.tmuxSession = window.session;
	base.logPath = rawPath;
	notify?.(
		window.session
			? `subagent ${label} → tmux session ${window.session} (window ${window.window}); attach with: tmux attach -t ${window.session}`
			: `subagent ${label} → tmux window ${window.window}`,
	);

	const collector = makeCollector(base);
	let processed = 0;
	const deadline = Date.now() + TMUX_TIMEOUT_MS;
	try {
		for (;;) {
			processed = drainStream(rawPath, processed, collector);
			if (fs.existsSync(exitPath)) {
				drainStream(rawPath, processed, collector);
				const parsed = Number.parseInt(fs.readFileSync(exitPath, "utf-8").trim(), 10);
				base.exitCode = Number.isFinite(parsed) ? parsed : 1;
				break;
			}
			if (signal?.aborted) {
				killTmuxWindow(window.window);
				throw new Error("subagent aborted");
			}
			if (Date.now() > deadline) {
				killTmuxWindow(window.window);
				throw new Error("subagent timed out");
			}
			await new Promise((r) => setTimeout(r, TMUX_POLL_MS));
		}
	} finally {
		invocation.cleanup();
	}

	base.output = collector.finalize();
	return base;
}

async function runOne(
	defaultCwd: string,
	defaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	tmuxOverride: boolean | undefined,
	notify: ((message: string) => void) | undefined,
): Promise<RunResult> {
	const base: RunResult = {
		agent: agentName,
		source: "unknown",
		task,
		exitCode: 1,
		output: "",
		stderr: "",
		usage: emptyUsage(),
		step,
	};

	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		base.stderr = `Unknown agent "${agentName}". Available: ${available}.`;
		return base;
	}
	base.source = agent.source;

	const config = readSubagentConfig();
	const mode = resolveTmuxMode(tmuxOverride, config);
	const invocation = await prepareInvocation(agent, task, defaults, base);
	const runCwd = cwd ?? defaultCwd;

	if (shouldUseTmux(mode)) {
		const label = step === undefined ? agent.name : `${agent.name}#${step + 1}`;
		const result = await runOneTmux(base, invocation, runCwd, signal, label, config, notify);
		if (result) return result;
		// tmux creation failed; fall through to pipes
		base.stderr += "tmux window could not be created; fell back to pipe transport\n";
		base.tmuxWindow = undefined;
		base.tmuxSession = undefined;
		base.logPath = undefined;
		// prepareInvocation was already cleaned up inside runOneTmux
		const retry = await prepareInvocation(agent, task, defaults, base);
		try {
			return await runOnePipes(base, retry, runCwd, signal);
		} finally {
			retry.cleanup();
		}
	}

	try {
		return await runOnePipes(base, invocation, runCwd, signal);
	} finally {
		invocation.cleanup();
	}
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index]!, index);
		}
	});
	await Promise.all(workers);
	return results;
}

function cap(text: string): string {
	if (text.length <= PER_TASK_OUTPUT_CAP) return text;
	return `${text.slice(0, PER_TASK_OUTPUT_CAP)}\n\n[pi-red: output truncated at ${PER_TASK_OUTPUT_CAP} chars]`;
}

function summarize(result: RunResult): string {
	const status = result.exitCode === 0 ? "ok" : `exit ${result.exitCode}`;
	const tmux = result.tmuxWindow ? ` [tmux ${result.tmuxWindow}]` : "";
	const header = `### ${result.agent} (${result.source}, ${status})${result.step !== undefined ? ` [step ${result.step}]` : ""}${tmux}`;
	const body = result.output || (result.stderr.trim() ? `(no output)\n${result.stderr.trim()}` : "(no output)");
	const usage = `tokens: in ${result.usage.input} / out ${result.usage.output} / cost $${result.usage.cost.toFixed(4)}`;
	return `${header}\n${cap(body)}\n\n_${usage}_`;
}

// ── tool registration ──────────────────────────────────────────────

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks: [{ agent, task }, ...]" })),
	chain: Type.Optional(
		Type.Array(TaskItem, { description: "Sequential tasks; {previous} in a task is replaced by the prior output" }),
	),
	agentScope: Type.Optional(
		StringEnum(["user", "project", "bundled", "all"] as const, {
			description: 'Which agent directories to search. Default: "all" (bundled + user + project).',
		}),
	),
	tmux: Type.Optional(
		Type.Boolean({
			description:
				"Run the subagent in a tmux window you can switch to. Omit to use the configured default (auto: yes when already inside tmux).",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	if (!isEnabled("subagents")) return;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate tasks to isolated subagents (separate pi processes with their own context windows). " +
			"Supports single, parallel, and chained execution. Use tmux:true to run each subagent in a " +
			"tmux window you can switch to and watch live. Discover available agents with agentScope.",
		promptSnippet: "Delegate a task to an isolated subagent (single, parallel, or chained)",
		promptGuidelines: [
			"Use subagent to delegate self-contained research or implementation tasks to specialized agents so they do not consume the main context window.",
			"Use subagent with `tasks` for independent work that can run in parallel, and with `chain` when a later step needs an earlier step's output via {previous}.",
			"Set subagent tmux:true when the user asks to watch, monitor, or switch into a subagent.",
		],
		parameters: SubagentParams,
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const cwd = ctx.cwd ?? process.cwd();
			const scope = (params.agentScope as AgentScope | undefined) ?? "all";
			const agents = discoverAgents(cwd, scope);
			const tmuxOverride = typeof params.tmux === "boolean" ? params.tmux : undefined;
			const notify = (message: string) => ctx.ui.notify(message, "info");

			const activeModel = ctx.model as { provider?: string; id?: string } | undefined;
			const model = activeModel?.id
				? `${activeModel.provider ? `${activeModel.provider}/` : ""}${activeModel.id}`
				: undefined;
			const defaults: DispatchDefaults = { model, thinkingLevel: ctx.thinkingLevel };

			const progress = (results: RunResult[]) => {
				if (onUpdate) {
					onUpdate({ content: [{ type: "text", text: results.map(summarize).join("\n\n") }], details: { results } });
				}
			};

			const dispatch = (
				agent: string,
				task: string,
				target: string | undefined,
				step: number | undefined,
			): Promise<RunResult> =>
				runOne(cwd, defaults, agents, agent, task, target, step, signal, tmuxOverride, notify);

			// parallel
			if (Array.isArray(params.tasks) && params.tasks.length > 0) {
				const tasks = params.tasks as Array<{ agent: string; task: string; cwd?: string }>;
				const results = await mapWithConcurrency(tasks, MAX_CONCURRENCY, (t, i) =>
					dispatch(t.agent, t.task, t.cwd, i),
				);
				progress(results);
				return { content: [{ type: "text", text: results.map(summarize).join("\n\n") }], details: { results } };
			}

			// chain
			if (Array.isArray(params.chain) && params.chain.length > 0) {
				const chain = params.chain as Array<{ agent: string; task: string; cwd?: string }>;
				const results: RunResult[] = [];
				let previous = "";
				for (let i = 0; i < chain.length; i++) {
					const step = chain[i]!;
					const task = step.task.replaceAll("{previous}", previous);
					const result = await dispatch(step.agent, task, step.cwd, i);
					results.push(result);
					previous = result.output;
					progress(results);
					if (result.exitCode !== 0) break;
				}
				return { content: [{ type: "text", text: results.map(summarize).join("\n\n") }], details: { results } };
			}

			// single
			const agentName = params.agent as string | undefined;
			const task = params.task as string | undefined;
			if (!agentName || !task) {
				const list = agents.map((a) => `- ${a.name} (${a.source}): ${a.description}`).join("\n");
				return {
					content: [
						{
							type: "text",
							text: `Provide { agent, task }, { tasks }, or { chain }.\n\nAvailable agents:\n${list || "(none)"}`,
						},
					],
					details: { agents },
				};
			}
			const result = await dispatch(agentName, task, params.cwd as string | undefined, undefined);
			return { content: [{ type: "text", text: summarize(result) }], details: { results: [result] } };
		},
	});

	// /agents — list discoverable agents
	pi.registerCommand("agents", {
		description: "List subagents available to the subagent tool",
		handler: async (_args, ctx) => {
			const agents = discoverAgents(process.cwd(), "all");
			const config = readSubagentConfig();
			const mode = resolveTmuxMode(undefined, config);
			const transport = shouldUseTmux(mode)
				? `tmux (${inTmux() ? "current session" : `session ${config.session}`})`
				: mode === "off"
					? "pipes (tmux off)"
					: "pipes (not inside tmux)";
			const text =
				agents.length === 0
					? "No agents found. Add .md files to ~/.pi/agent/agents/ or <cwd>/.pi/agents/."
					: agents.map((a) => `${a.name} (${a.source}) — ${a.description}`).join("\n");
			pi.sendMessage({
				customType: "pi-red",
				content: `pi-red agents\ntransport: ${transport}\n\n${text}`,
				display: true,
			});
			ctx.ui.notify(`${agents.length} agent(s), transport: ${transport}`, "info");
		},
	});
}

/**
 * pi-rad goal mode
 *
 * A completion contract. While a goal is active, pi-rad re-prompts the agent
 * on every settle until the goal is verifiably done, instead of stopping at a
 * plan or a status update.
 *
 *   /goal <text>   set a goal and start working on it
 *   /goal          show status
 *   /goal resume   resume after a blocker
 *   /goal done     mark complete manually
 *   /goal clear    drop the goal
 *
 * The agent signals completion with the `goal_complete` tool (summary +
 * evidence) or asks for input with `goal_blocked`. Auto-continuation is bounded
 * by an iteration budget so a confused agent cannot loop forever, and a user
 * abort (Ctrl+C) suppresses the next auto-continue.
 *
 * Controlled by the `goal` feature gate.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isEnabled } from "./lib/features.ts";

const STATE_TYPE = "rad-goal";
const MESSAGE_TYPE = "pi-rad-goal";
const STATUS_KEY = "pi-rad-goal";
const PROMPT_MARKER = "Active goal (pi-rad goal mode)";
const DEFAULT_MAX_ITERATIONS = Number.parseInt(process.env.PI_RAD_GOAL_MAX ?? "20", 10) || 20;

type GoalStatus = "active" | "blocked" | "complete";

interface GoalState {
	text: string;
	status: GoalStatus;
	createdAt: number;
	iterations: number;
	maxIterations: number;
	evidence?: string;
	blocker?: string;
	completedAt?: number;
}

function goalContract(state: GoalState): string {
	if (state.status === "blocked") {
		return `## ${PROMPT_MARKER}

Goal: ${state.text}

Status: blocked — waiting on the user. Blocker: ${state.blocker ?? "(unspecified)"}

Do not continue autonomously. When the user resolves the blocker (or you find a way
around it), call \`goal_blocked\` again only if still stuck, or continue toward the
goal. Call \`goal_complete\` with evidence once the goal is verifiably done.`;
	}

	return `## ${PROMPT_MARKER}

Goal: ${state.text}

This is a completion contract, not a plan. Keep working until the goal is
verifiably achieved.

- Read the smallest useful set of files/docs/artifacts first, then implement.
- Prove the result with the most honest check available: reproduce the bug before
  fixing it, run the focused and integration tests, use the real runtime for the
  real path — not a mock, scaffold, or a nearby example.
- Do not stop at a plan, a partial fix, or unverified next steps. If the goal is
  not done and no stop condition applies, continue with the least-certain open
  check.
- When the whole goal is done, call \`goal_complete\` with a summary and the
  concrete evidence (command output, file paths, observed state). A check that
  could not have failed proves nothing.
- If you cannot proceed without user input, access, or approval, call
  \`goal_blocked\` with the exact blocker instead of asking in prose.
- Stop and report after about three genuinely different failed approaches.
- Do not weaken tests or required behavior to make a check pass.
- Iteration ${state.iterations}/${state.maxIterations}. Do not repeat a failed
  approach; change strategy or call \`goal_blocked\`.`;
}

function continuationPrompt(state: GoalState): string {
	return `Continue toward the active goal. ${state.iterations}/${state.maxIterations} continuations used.

Do not restate the plan or summarize progress. Take the next concrete step. If the
goal is done, call \`goal_complete\` with evidence. If you are stuck, call
\`goal_blocked\` with the blocker.`;
}

export default function (pi: ExtensionAPI) {
	if (!isEnabled("goal")) return;

	let state: GoalState | null = null;
	let suppressContinue = false;

	const persist = () => {
		if (state) pi.appendEntry(STATE_TYPE, state);
	};

	const setStatus = (ctx: ExtensionContext | ExtensionCommandContext) => {
		if (!state) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const icon = state.status === "complete" ? "done" : state.status === "blocked" ? "blocked" : "active";
		ctx.ui.setStatus(STATUS_KEY, `goal:${icon} ${state.iterations}/${state.maxIterations}`);
	};

	const statusText = (): string => {
		if (!state) return "pi-rad goal mode: no active goal. Set one with /goal <text>.";
		const lines = [
			`Goal: ${state.text}`,
			`Status: ${state.status}`,
			`Continuations: ${state.iterations}/${state.maxIterations}`,
			`Created: ${new Date(state.createdAt).toISOString()}`,
		];
		if (state.evidence) lines.push(`Evidence: ${state.evidence}`);
		if (state.blocker) lines.push(`Blocker: ${state.blocker}`);
		if (state.completedAt) lines.push(`Completed: ${new Date(state.completedAt).toISOString()}`);
		lines.push("", "Commands: /goal <text> | /goal resume | /goal done | /goal clear");
		return lines.join("\n");
	};

	const showStatus = (ctx: ExtensionCommandContext) => {
		pi.sendMessage({ customType: MESSAGE_TYPE, content: statusText(), display: true });
		ctx.ui.notify(state ? `goal: ${state.status}` : "no active goal", "info");
	};

	// ── session lifecycle ────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		state = null;
		suppressContinue = false;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				state = entry.data as GoalState;
			}
		}
		setStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// A user abort must not be immediately overridden by an auto-continue.
	pi.on("agent_end", async (event) => {
		const last = [...event.messages].reverse().find((m) => m.role === "assistant") as
			| { stopReason?: string }
			| undefined;
		if (last?.stopReason === "aborted") suppressContinue = true;
	});

	pi.on("input", async (event) => {
		if (event.source !== "extension") suppressContinue = false;
		return undefined;
	});

	// ── prompt injection ─────────────────────────────────────────────
	pi.on("before_agent_start", async (event) => {
		if (!isEnabled("goal") || !state) return undefined;
		if (state.status === "complete") return undefined;
		if (event.systemPrompt.includes(PROMPT_MARKER)) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${goalContract(state)}` };
	});

	// ── auto-continuation ────────────────────────────────────────────
	pi.on("agent_settled", async (_event, ctx) => {
		if (!isEnabled("goal") || !state || state.status !== "active") return;
		// One-shot modes dispose the session when the prompt finishes, so there is
		// nothing to continue into. Goal auto-continuation is for interactive and
		// RPC sessions.
		if (ctx.mode === "print" || ctx.mode === "json") return;
		if (suppressContinue) {
			suppressContinue = false;
			return;
		}
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

		if (state.iterations >= state.maxIterations) {
			state = {
				...state,
				status: "blocked",
				blocker: `iteration budget exhausted (${state.maxIterations}); review and /goal resume or /goal clear`,
			};
			persist();
			setStatus(ctx);
			ctx.ui.notify("pi-rad goal: iteration budget exhausted, paused", "warning");
			pi.sendMessage({
				customType: MESSAGE_TYPE,
				content: `Goal paused: iteration budget exhausted (${state.maxIterations}). Review the state and run /goal resume to continue, or /goal clear to drop it.`,
				display: true,
			});
			return;
		}

		state = { ...state, iterations: state.iterations + 1 };
		persist();
		setStatus(ctx);
		pi.sendMessage(
			{ customType: MESSAGE_TYPE, content: continuationPrompt(state), display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});

	// ── tools the agent uses to close the contract ───────────────────
	pi.registerTool({
		name: "goal_complete",
		label: "Goal Complete",
		description:
			"Mark the active pi-rad goal complete. Call only when the whole goal is verifiably done, with the evidence that proves it.",
		promptSnippet: "Mark the active goal complete with evidence",
		promptGuidelines: [
			"Use goal_complete when an active pi-rad goal has been verifiably achieved; include the evidence (commands, output, paths) that proves it.",
		],
		parameters: Type.Object({
			summary: Type.String({ description: "What was achieved, in a few sentences" }),
			evidence: Type.String({ description: "Concrete proof: commands run, observed output, file paths, measured state" }),
		}),
		async execute(_toolCallId, params) {
			if (!isEnabled("goal")) {
				return { content: [{ type: "text", text: "pi-rad goal mode is disabled." }], details: {} };
			}
			if (!state) {
				return { content: [{ type: "text", text: "No active goal to complete." }], details: {} };
			}
			state = {
				...state,
				status: "complete",
				evidence: `${params.summary}\n\nEvidence: ${params.evidence}`,
				completedAt: Date.now(),
			};
			persist();
			return {
				content: [{ type: "text", text: "Goal marked complete. Write the final report for the user." }],
				details: { goal: state },
			};
		},
	});

	pi.registerTool({
		name: "goal_blocked",
		label: "Goal Blocked",
		description:
			"Pause the active pi-rad goal and hand control back to the user. Use when you cannot proceed without input, access, or approval.",
		promptSnippet: "Pause the active goal and report a blocker",
		promptGuidelines: [
			"Use goal_blocked when an active pi-rad goal cannot proceed without user input, access, or approval; give the exact blocker.",
		],
		parameters: Type.Object({
			reason: Type.String({ description: "The exact blocker and what you need from the user" }),
		}),
		async execute(_toolCallId, params) {
			if (!isEnabled("goal") || !state) {
				return { content: [{ type: "text", text: "No active goal." }], details: {} };
			}
			state = { ...state, status: "blocked", blocker: params.reason };
			persist();
			return {
				content: [{ type: "text", text: "Goal paused. Explain the blocker to the user and what you need." }],
				details: { goal: state },
			};
		},
	});

	// ── /goal ────────────────────────────────────────────────────────
	pi.registerCommand("goal", {
		description: "pi-rad goal mode: keep working until the goal is verifiably done",
		getArgumentCompletions: (prefix: string) => {
			const values = ["resume", "done", "clear", "status"];
			const filtered = values.filter((v) => v.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((v) => ({ value: v, label: v })) : null;
		},
		handler: async (args, ctx) => {
			if (!isEnabled("goal")) {
				ctx.ui.notify("pi-rad: goal feature is off (enable with /rad goal on)", "warning");
				return;
			}
			const arg = args.trim();

			if (!arg || arg === "status") {
				showStatus(ctx);
				return;
			}

			if (arg === "clear" || arg === "off") {
				state = null;
				suppressContinue = false;
				persist();
				setStatus(ctx);
				pi.sendMessage({ customType: MESSAGE_TYPE, content: "Goal cleared.", display: true });
				return;
			}

			if (arg === "done") {
				if (!state) {
					ctx.ui.notify("pi-rad: no active goal", "warning");
					return;
				}
				state = { ...state, status: "complete", completedAt: Date.now(), evidence: state.evidence ?? "(marked done manually)" };
				persist();
				setStatus(ctx);
				pi.sendMessage({ customType: MESSAGE_TYPE, content: "Goal marked complete manually.", display: true });
				return;
			}

			if (arg === "resume") {
				if (!state) {
					ctx.ui.notify("pi-rad: no active goal to resume", "warning");
					return;
				}
				state = { ...state, status: "active", blocker: undefined, iterations: 0 };
				suppressContinue = false;
				persist();
				setStatus(ctx);
				pi.sendMessage(
					{ customType: MESSAGE_TYPE, content: continuationPrompt(state), display: true },
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				return;
			}

			// Set a new goal and start working.
			state = {
				text: arg,
				status: "active",
				createdAt: Date.now(),
				iterations: 0,
				maxIterations: DEFAULT_MAX_ITERATIONS,
			};
			suppressContinue = false;
			persist();
			setStatus(ctx);
			ctx.ui.notify("pi-rad goal set", "info");
			pi.sendUserMessage(
				`Goal: ${arg}\n\nBegin now. Read the smallest useful context first, then work until the goal is verifiably done. Call goal_complete with evidence when it is, or goal_blocked if you are stuck.`,
			);
		},
	});
}

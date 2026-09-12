/**
 * pi-rad plan mode
 *
 * A read-only planning posture. When active it:
 *   - restricts the active tools to a read-only set
 *   - injects planning instructions into the system prompt
 *   - hard-blocks `edit`/`write` tool calls as defense in depth
 *
 * Toggle with `/plan` or `ctrl+alt+p`. State is persisted per session through
 * pi.appendEntry("rad-plan", ...) and restored on resume/fork.
 *
 * Controlled by the `plan-mode` feature gate.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isEnabled } from "./lib/features.ts";

const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const BLOCKED_TOOLS = new Set(["edit", "write"]);
const STATE_TYPE = "rad-plan";

const PLAN_INSTRUCTIONS = `## Plan mode (pi-rad) is active

Your job is to deeply understand the problem and produce a concrete plan. You
are in a read-only posture: do not modify files.

Rules:
- Read files IN FULL (no offset/limit) so you have complete context.
- Explore thoroughly: search for related code, mirror existing patterns, and
  understand the architecture before proposing anything.
- You may run read-only shell commands (git status, tests for discovery,
  linters) but do not create, edit, or delete files.
- Ask clarifying questions when requirements are ambiguous. Do not assume.
- Identify risks, edge cases, and dependencies before proposing changes.

Output:
1. A numbered implementation plan. For each step: what to change, why, and the
   risk if it goes wrong.
2. The list of files that will be created or modified.
3. Tests to add or update.
4. Open questions.

Finish by asking the user whether to (a) write the plan to a markdown file,
(b) open a GitHub issue, or (c) exit plan mode and implement.`;

interface PlanState {
	active: boolean;
	toolsBefore?: string[];
}

function planToolsFor(available: string[]): string[] {
	return PLAN_TOOLS.filter((name) => available.includes(name));
}

export default function (pi: ExtensionAPI) {
	let state: PlanState = { active: false };

	const allToolNames = () => pi.getAllTools().map((t) => t.name);

	const enable = (ctx: ExtensionContext) => {
		const available = allToolNames();
		state = { active: true, toolsBefore: pi.getActiveTools() };
		pi.setActiveTools(planToolsFor(available));
		pi.appendEntry(STATE_TYPE, state);
		ctx.ui.setStatus("pi-rad-plan", "plan");
		ctx.ui.notify("pi-rad: plan mode on (read-only)", "info");
	};

	const disable = (ctx: ExtensionContext) => {
		const restore = state.toolsBefore ?? pi.getActiveTools();
		state = { active: false };
		pi.setActiveTools(restore);
		pi.appendEntry(STATE_TYPE, state);
		ctx.ui.setStatus("pi-rad-plan", undefined);
		ctx.ui.notify("pi-rad: plan mode off", "info");
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!isEnabled("plan-mode")) return;
		// Restore the most recent persisted state.
		let last: PlanState | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				last = entry.data as PlanState;
			}
		}
		if (last?.active) {
			state = last;
			const available = allToolNames();
			pi.setActiveTools(planToolsFor(available));
			ctx.ui.setStatus("pi-rad-plan", "plan");
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!isEnabled("plan-mode") || !state.active) return undefined;
		if (event.systemPrompt.includes("Plan mode (pi-rad) is active")) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_INSTRUCTIONS}` };
	});

	pi.on("tool_call", async (event) => {
		if (!isEnabled("plan-mode") || !state.active) return undefined;
		if (BLOCKED_TOOLS.has(event.toolName)) {
			return { block: true, reason: "pi-rad plan mode is read-only; exit with /plan to make changes" };
		}
		return undefined;
	});

	pi.registerCommand("plan", {
		description: "Toggle pi-rad plan mode (read-only planning)",
		handler: async (_args, ctx) => {
			// Leaving plan mode must work even when the feature was turned off at
			// runtime, otherwise the read-only tool set stays applied.
			if (state.active) {
				disable(ctx);
				return;
			}
			if (!isEnabled("plan-mode")) {
				ctx.ui.notify("pi-rad: plan-mode feature is off (enable with /rad plan-mode on)", "warning");
				return;
			}
			enable(ctx);
		},
	});

	pi.registerShortcut("ctrl+alt+p", {
		description: "Toggle pi-rad plan mode",
		handler: async (ctx) => {
			if (state.active) {
				disable(ctx);
				return;
			}
			if (!isEnabled("plan-mode")) return;
			enable(ctx);
		},
	});
}

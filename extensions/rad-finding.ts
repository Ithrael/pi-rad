/**
 * pi-rad findings ledger
 *
 * One tool, one file, one schema. `finding` records a hunt candidate into an
 * append-only ledger (`findings.jsonl` in the session cwd, or $PI_RAD_FINDINGS)
 * after running the SubmissionGate. Candidates that fail a gate land as
 * near-misses with `gateFailed` naming the gate, so the "promote later" flow
 * still works — a second call promotes the record instead of duplicating it.
 *
 * What this replaces: hand-written JSON where the same concept is spelled
 * `reason`, `blockingReason`, `why_not_vuln`, or `needs` depending on the
 * module, and where the same candidate id gets re-recorded in every target
 * directory. Detection is by fingerprint, not by memory of what was typed.
 *
 * Gated by the `findings` feature; when disabled the tool is never registered.
 * Nothing here reads or writes an existing vulns.json / near-miss.json — the
 * ledger is additive, and `ws-bounty-estimate` / `/report` can consume it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { configDir, isEnabled } from "./lib/features.ts";
import {
	appendLedger,
	classFingerprintOf,
	fingerprintOf,
	type CandidateInput,
	type LedgerRecord,
	ledgerPath,
	normalizeSeverity,
	REAL_IMPACTS,
	readLedger,
	runGates,
	SCALE_ESTIMATES,
	SEVERITIES,
	summarize,
} from "./lib/findings.ts";

const GATE_HINTS: Record<string, string> = {
	preCondition: "补 provenance：入口 interface、可控 param、exploitChain 的每一步。",
	realImpact: "拿到真实危害证据（泄露样本 / 跨户数据 / OOB 回连），或把影响量化到 10K+ 以上。",
	evidence: "把复现跑到 3/3，然后再记一次（同指纹会自动升级为漏洞）。",
	dedup: "同目标同指纹已有漏洞记录；换攻击面，或确认是独立漏洞后加 force: true。",
	platform: "命中平台拒收规则；若认为规则不适用，改 ~/.pi-rad/gate.json 或加 force: true。",
};

/** Optional refusal rules: { "rejectPatterns": ["cors", "self-xss", "system prompt"] } */
function rejectPatterns(): string[] {
	try {
		const path = join(configDir(), "gate.json");
		if (!existsSync(path)) return [];
		const raw = JSON.parse(readFileSync(path, "utf-8")) as { rejectPatterns?: unknown };
		return Array.isArray(raw.rejectPatterns)
			? raw.rejectPatterns.filter((p): p is string => typeof p === "string")
			: [];
	} catch {
		return [];
	}
}

const FindingParams = Type.Object({
	title: Type.String({ description: "One-line finding title (Chinese, as it will be submitted)" }),
	type: Type.String({ description: 'Vulnerability class, e.g. "idor", "CWE-639", "unauth-api"' }),
	target: Type.String({ description: "Host or URL the finding applies to" }),
	severity: Type.Optional(StringEnum(SEVERITIES, { description: "Platform severity scale; English labels are normalized" })),
	realImpact: Type.Optional(
		StringEnum(REAL_IMPACTS, {
			description:
				"Concrete impact. Required for a vuln: pii_leak | credentials | rce | cross_user_confirmed | confirmed_oob | tool_action",
		}),
	),
	scaleEstimate: Type.Optional(
		StringEnum(SCALE_ESTIMATES, { description: "How much data the impact covers. Required for a vuln." }),
	),
	endpoint: Type.Optional(Type.String({ description: 'Entry point, e.g. "DELETE /api/v1/orders/{id}"' })),
	payloadFingerprint: Type.Optional(Type.String({ description: "Stable description of the payload/technique, for dedupe" })),
	precondition: Type.Optional(Type.String({ description: 'What the attacker needs, e.g. "低权限账号" or "无" (required form, not a judgement)' })),
	blockingReason: Type.Optional(Type.String({ description: "For a near-miss: what is still missing (free text, shown in /findings)" })),
	evidencePath: Type.Optional(Type.String({ description: "Path to the evidence directory or file" })),
	evidenceRuns: Type.Optional(Type.Number({ description: "How many times the PoC was reproduced (needs >= 3 for a vuln)" })),
	evidenceReproducibility: Type.Optional(Type.String({ description: 'Reproduction rate, e.g. "3/3" (required for a vuln)' })),
	evidenceNote: Type.Optional(Type.String({ description: "What the evidence shows" })),
	provenanceInterface: Type.Optional(Type.String({ description: "Untrusted entry point (interface) the data crosses" })),
	provenanceParam: Type.Optional(Type.String({ description: "Parameter / field the attacker controls" })),
	provenanceChain: Type.Optional(Type.Array(Type.String(), { description: "Exploit chain, one step per entry" })),
	force: Type.Optional(Type.Boolean({ description: "Record even when it looks like a duplicate" })),
});

function toCandidate(params: Record<string, unknown>): CandidateInput {
	return {
		title: String(params.title ?? ""),
		type: String(params.type ?? ""),
		target: String(params.target ?? ""),
		severity: typeof params.severity === "string" ? params.severity : undefined,
		realImpact: typeof params.realImpact === "string" ? params.realImpact : undefined,
		scaleEstimate: typeof params.scaleEstimate === "string" ? params.scaleEstimate : undefined,
		endpoint: typeof params.endpoint === "string" ? params.endpoint : undefined,
		payloadFingerprint: typeof params.payloadFingerprint === "string" ? params.payloadFingerprint : undefined,
		precondition: typeof params.precondition === "string" ? params.precondition : undefined,
		blockingReason: typeof params.blockingReason === "string" ? params.blockingReason : undefined,
		evidencePath: typeof params.evidencePath === "string" ? params.evidencePath : undefined,
		evidence:
			params.evidenceRuns === undefined && params.evidenceReproducibility === undefined
				? undefined
				: {
						runs: typeof params.evidenceRuns === "number" ? params.evidenceRuns : undefined,
						reproducibility:
							typeof params.evidenceReproducibility === "string" ? params.evidenceReproducibility : undefined,
						note: typeof params.evidenceNote === "string" ? params.evidenceNote : undefined,
					},
		provenance:
			params.provenanceInterface === undefined && params.provenanceParam === undefined && params.provenanceChain === undefined
				? undefined
				: {
						interface: typeof params.provenanceInterface === "string" ? params.provenanceInterface : undefined,
						param: typeof params.provenanceParam === "string" ? params.provenanceParam : undefined,
						exploitChain: Array.isArray(params.provenanceChain)
							? params.provenanceChain.filter((s): s is string => typeof s === "string")
							: undefined,
					},
		force: params.force === true,
	};
}

function text(body: string, details: unknown = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: body }], details };
}

export default function (pi: ExtensionAPI) {
	if (!isEnabled("findings")) return;

	pi.registerTool({
		name: "finding",
		label: "Finding",
		description:
			"Record one SRC hunt candidate into the pi-rad findings ledger. Runs the SubmissionGate " +
			"(preCondition -> realImpact -> evidence -> dedup -> platform) and writes a vuln record only " +
			"when every gate passes; otherwise the candidate is kept as a near-miss with the failing gate " +
			"named. Deduplicates by fingerprint within the target and flags the same pattern in other " +
			"targets. Use it for every candidate instead of hand-writing JSON.",
		promptSnippet: "Record a hunt candidate (runs the SubmissionGate and dedupes)",
		promptGuidelines: [
			"Record every hunt candidate with the finding tool as soon as it is confirmed or parked — do not hand-write vulns.json or near-miss.json entries.",
			"If the finding tool reports gateFailed, fix exactly that field and call it again; the same fingerprint is promoted to a vuln instead of duplicated.",
			"Pass realImpact and scaleEstimate with concrete values; possible/theoretical/likely are rejected by the gate.",
		],
		parameters: FindingParams,
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const cwd = ctx.cwd ?? process.cwd();
			const path = ledgerPath(cwd);
			const candidate = toCandidate(params);
			if (!candidate.title.trim() || !candidate.type.trim() || !candidate.target.trim()) {
				return text("pi-rad finding: title / type / target 都是必填。");
			}

			const records = readLedger(path);
			const fingerprint = fingerprintOf(candidate);
			const classFingerprint = classFingerprintOf(candidate);
			const same = records.filter((r) => r.fingerprint === fingerprint);
			const recordedVuln = same.find((r) => r.status === "vuln");
			// Most recent near-miss wins, so a promotion points at the record it completes.
			const recordedNearMiss = same.filter((r) => r.status === "near-miss").at(-1);

			if (recordedVuln && !candidate.force) {
				return text(
					[
						`pi-rad finding: 重复（同目标同指纹已有漏洞记录）`,
						`  existing : ${recordedVuln.id} ${recordedVuln.title}`,
						`  ledger   : ${path}`,
						`  换攻击面重测，或确认是独立漏洞后加 force: true。`,
					].join("\n"),
				);
			}

			const seen = new Set(records.filter((r) => r.status === "vuln").map((r) => r.fingerprint));
			const outcome = runGates(candidate, { seen, rejectPatterns: rejectPatterns() });

			if (outcome.gateFailed === "dedup" && !candidate.force) {
				return text(
					[
						`pi-rad finding: 重复（指纹 ${fingerprint} 已作为漏洞记录过）`,
						`  existing : ${recordedVuln?.id ?? "(unknown)"}`,
						`  ledger   : ${path}`,
					].join("\n"),
				);
			}

			// A repeated near-miss for the same reason is the noise case: say so once.
			if (
				outcome.decision === "near-miss" &&
				recordedNearMiss?.gateFailed === outcome.gateFailed &&
				!candidate.force
			) {
				return text(
					[
						`pi-rad finding: 已记录过，无新增信息（gateFailed 仍是 ${outcome.gateFailed}）`,
						`  existing : ${recordedNearMiss.id} ${recordedNearMiss.title}`,
						`  ledger   : ${path}`,
					].join("\n"),
				);
			}

			const duplicateOf = records
				.filter((r) => r.classFingerprint === classFingerprint && r.fingerprint !== fingerprint)
				.map((r) => r.id);
			const record: LedgerRecord = {
				...candidate,
				id: `${outcome.decision === "vuln" ? "VULN" : "NM"}-${fingerprint}`,
				status: outcome.decision,
				severity: normalizeSeverity(candidate.severity),
				fingerprint,
				classFingerprint,
				gateFailed: outcome.gateFailed,
				gateReason: outcome.reason,
				promotes: outcome.decision === "vuln" ? recordedNearMiss?.id : undefined,
				duplicateOf: duplicateOf.length > 0 ? duplicateOf : undefined,
				createdAt: new Date().toISOString(),
			};
			appendLedger(path, record);

			const lines = [
				`pi-rad ${record.id} — ${record.status === "vuln" ? "漏洞" : "near-miss"}${
					record.gateFailed ? `（gateFailed=${record.gateFailed}）` : ""
				}`,
				`  target  : ${candidate.target}${candidate.endpoint ? ` ${candidate.endpoint}` : ""}`,
				`  type    : ${candidate.type} · severity ${record.severity}`,
			];
			if (record.gateReason) {
				lines.push(`  reason  : ${record.gateReason}`);
				lines.push(`  next    : ${GATE_HINTS[record.gateFailed ?? ""] ?? "补齐证据后再记一次"}`);
			}
			if (record.promotes) lines.push(`  promotes: ${record.promotes}（原 near-miss 已升档）`);
			if (duplicateOf.length > 0) lines.push(`  same pattern elsewhere: ${duplicateOf.join(", ")}`);
			lines.push(`  ledger  : ${path}`);
			return text(lines.join("\n"), { record });
		},
	});

	pi.registerCommand("findings", {
		description: "pi-rad findings ledger: counts, gate failures, cross-target duplicate families",
		handler: async (_args: string, ctx: ExtensionContext | ExtensionCommandContext) => {
			const cwd = ctx.cwd ?? process.cwd();
			const path = ledgerPath(cwd);
			pi.sendMessage({ customType: "pi-rad", content: summarize(readLedger(path), path), display: true });
			if (ctx.hasUI) ctx.ui.notify("pi-rad findings written to transcript", "info");
		},
	});
}

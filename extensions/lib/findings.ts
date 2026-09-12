/**
 * pi-rad findings ledger
 *
 * The canonical record for one hunt candidate: the field contract, the
 * SubmissionGate, and the dedupe fingerprints. Pure node built-ins so the unit
 * tests can import it directly with Node's type stripping.
 *
 * Why this exists (observed on real SRC workspaces):
 *
 *   - the same concept is spelled four ways across modules
 *     (reason / blockingReason / why_not_vuln / gateFailed / needs), so
 *     aggregation and counting break;
 *   - vulns.json is a bare list in one module and {vulns:[],notes} in another;
 *   - the same candidate id shows up in dozens of target directories
 *     (APK-CRED-*-CHAIN in 17 of them), mostly regex noise.
 *
 * One append-only ledger written through one tool removes all three: the
 * contract is enforced on write, the shape is fixed (one JSON object per
 * line), and duplicates are detected by fingerprint instead of by memory.
 *
 * Gate order mirrors the pipeline's SubmissionGate: preCondition ->
 * realImpact -> evidence -> dedup -> platform. A candidate that fails any gate
 * is recorded as a near-miss with `gateFailed` naming the gate, which is
 * exactly the existing convention ("candidates go to near-miss first, promote
 * after deep-dive").
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Real-impact values that justify a submission. Free text is rejected on purpose. */
export const REAL_IMPACTS = [
	"pii_leak",
	"credentials",
	"rce",
	"cross_user_confirmed",
	"confirmed_oob",
	"tool_action",
] as const;

/** How much data the impact covers. "single" cannot carry a bulk-data impact. */
export const SCALE_ESTIMATES = ["1M+", "100K+", "10K+", "single"] as const;

export const SEVERITIES = ["严重", "高", "中", "低", "信息"] as const;

export const GATES = ["preCondition", "realImpact", "evidence", "dedup", "platform"] as const;
export type GateId = (typeof GATES)[number];

/** Impacts that describe bulk data, where an unquantified scale is a refusal. */
const BULK_IMPACTS = new Set<string>(["pii_leak", "credentials"]);

const SEVERITY_ALIASES: Record<string, string> = {
	critical: "严重",
	severe: "严重",
	紧急: "严重",
	致命: "严重",
	high: "高",
	高危: "高",
	medium: "中",
	moderate: "中",
	中危: "中",
	low: "低",
	低危: "低",
	info: "信息",
	informational: "信息",
	none: "信息",
};

/** Map English or noisy severity labels onto the platform's Chinese scale. */
export function normalizeSeverity(value: string | undefined): string {
	const raw = (value ?? "").trim();
	if (!raw) return "信息";
	if ((SEVERITIES as readonly string[]).includes(raw)) return raw;
	const alias = SEVERITY_ALIASES[raw.toLowerCase()];
	if (alias) return alias;
	// "高危/严重" style combinations: the highest mentioned level wins.
	for (const level of ["严重", "高", "中", "低"]) if (raw.includes(level)) return level;
	if (/crit/i.test(raw)) return "严重";
	return "信息";
}

/** A candidate as the agent describes it. Only the first three are required. */
export interface CandidateInput {
	title: string;
	type: string;
	target: string;
	severity?: string;
	realImpact?: string;
	scaleEstimate?: string;
	endpoint?: string;
	payloadFingerprint?: string;
	precondition?: string;
	blockingReason?: string;
	evidencePath?: string;
	evidence?: { runs?: number; reproducibility?: string; note?: string };
	provenance?: { interface?: string; param?: string; exploitChain?: string[] };
	force?: boolean;
}

export interface LedgerRecord extends CandidateInput {
	id: string;
	status: "vuln" | "near-miss";
	severity: string;
	fingerprint: string;
	classFingerprint: string;
	gateFailed?: GateId;
	gateReason?: string;
	/** Set when this record promotes an earlier near-miss. */
	promotes?: string;
	/** Ids of earlier records in other targets with the same class fingerprint. */
	duplicateOf?: string[];
	createdAt: string;
}

export interface GateOutcome {
	decision: "vuln" | "near-miss";
	gateFailed?: GateId;
	reason?: string;
}

// ── fingerprints ───────────────────────────────────────────────────

/** Lower-case host of a target that may be a host, host:port, or full URL. */
export function normalizeHost(target: string): string {
	const raw = (target ?? "").trim().toLowerCase();
	const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
	const authority = withoutScheme.split(/[/?#]/)[0] ?? "";
	return authority.replace(/:\d+$/, "").replace(/^www\./, "");
}

function digest(parts: readonly string[]): string {
	return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

function classParts(candidate: CandidateInput): string[] {
	return [
		(candidate.type ?? "").trim().toLowerCase(),
		(candidate.endpoint ?? "").trim().toLowerCase().replace(/\s+/g, " "),
		(candidate.provenance?.param ?? "").trim().toLowerCase(),
		(candidate.payloadFingerprint ?? "").trim().toLowerCase(),
	];
}

/** Identity within one target: the same bug reported twice. */
export function fingerprintOf(candidate: CandidateInput): string {
	return digest([normalizeHost(candidate.target), ...classParts(candidate)]);
}

/** Identity across targets: the same pattern in several apps (bulk noise, or a family). */
export function classFingerprintOf(candidate: CandidateInput): string {
	return digest(classParts(candidate));
}

// ── gates ──────────────────────────────────────────────────────────

export function checkPreCondition(candidate: CandidateInput): string | undefined {
	const provenance = candidate.provenance;
	if (!provenance) return "缺少 provenance（interface / param / exploitChain）";
	if (!provenance.interface?.trim()) return "provenance.interface 为空：说不清从哪个入口进";
	if (!provenance.param?.trim()) return "provenance.param 为空：说不清哪个参数或字段可控";
	const chain = (provenance.exploitChain ?? []).filter((step) => step && step.trim());
	if (chain.length === 0) return "provenance.exploitChain 为空：说不清利用链";
	return undefined;
}

export function checkRealImpact(candidate: CandidateInput): string | undefined {
	if (!candidate.realImpact) return "缺少 realImpact";
	if (candidate.realImpact === "none") return "realImpact = none";
	if (!(REAL_IMPACTS as readonly string[]).includes(candidate.realImpact)) {
		return `realImpact 不在枚举内（禁用 possible/theoretical/likely）：${candidate.realImpact}`;
	}
	if (!candidate.scaleEstimate) return "缺少 scaleEstimate（1M+ / 100K+ / 10K+ / single）";
	if (!(SCALE_ESTIMATES as readonly string[]).includes(candidate.scaleEstimate)) {
		return `scaleEstimate 不在枚举内：${candidate.scaleEstimate}`;
	}
	if (BULK_IMPACTS.has(candidate.realImpact) && candidate.scaleEstimate === "single") {
		return `realImpact=${candidate.realImpact} 是批量数据但 scaleEstimate=single：无量化 = 拒`;
	}
	return undefined;
}

export function checkEvidence(candidate: CandidateInput): string | undefined {
	const evidence = candidate.evidence;
	if (!evidence) return "缺少 evidence（runs / reproducibility）";
	if (typeof evidence.runs !== "number" || !Number.isFinite(evidence.runs)) {
		return "evidence.runs 不是数字";
	}
	if (evidence.runs < 3) return `evidence.runs=${evidence.runs} < 3：跑不到 3 次不算可复现`;
	if (evidence.reproducibility !== "3/3") {
		return `reproducibility=${evidence.reproducibility ?? "(缺)"} 不是 3/3`;
	}
	return undefined;
}

/** Opt-in platform refusal rules, e.g. the "默认关闭" list in the pipeline spec. */
export function checkPlatform(candidate: CandidateInput, rejectPatterns: readonly string[] = []): string | undefined {
	if (rejectPatterns.length === 0) return undefined;
	const haystack = `${candidate.type} ${candidate.title} ${candidate.endpoint ?? ""}`.toLowerCase();
	for (const pattern of rejectPatterns) {
		try {
			if (new RegExp(pattern, "i").test(haystack)) return `命中平台拒收规则 /${pattern}/`;
		} catch {
			// A malformed pattern must never fail a finding.
		}
	}
	return undefined;
}

/**
 * Run the gate chain in order. `seen` holds the fingerprints already recorded
 * as vulns, so a near-miss can still be promoted later by a second call.
 */
export function runGates(
	candidate: CandidateInput,
	options: { seen?: ReadonlySet<string>; rejectPatterns?: readonly string[] } = {},
): GateOutcome {
	const fingerprint = fingerprintOf(candidate);
	const checks: ReadonlyArray<readonly [GateId, string | undefined]> = [
		["preCondition", checkPreCondition(candidate)],
		["realImpact", checkRealImpact(candidate)],
		["evidence", checkEvidence(candidate)],
		["dedup", options.seen?.has(fingerprint) ? `指纹 ${fingerprint} 已作为漏洞记录过` : undefined],
		["platform", checkPlatform(candidate, options.rejectPatterns)],
	];
	for (const [gate, reason] of checks) {
		if (reason) return { decision: "near-miss", gateFailed: gate, reason };
	}
	return { decision: "vuln" };
}

// ── ledger ─────────────────────────────────────────────────────────

/** $PI_RAD_FINDINGS, else <cwd>/findings.jsonl. */
export function ledgerPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_RAD_FINDINGS?.trim();
	return override || `${cwd.replace(/\/+$/, "")}/findings.jsonl`;
}

/** Read the ledger, skipping blank and malformed lines instead of throwing. */
export function readLedger(path: string): LedgerRecord[] {
	if (!existsSync(path)) return [];
	const records: LedgerRecord[] = [];
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				records.push(parsed as LedgerRecord);
			}
		} catch {
			// Malformed line: ignore, the rest of the ledger stays usable.
		}
	}
	return records;
}

/** Append one record. Creates the parent directory; never rewrites history. */
export function appendLedger(path: string, record: LedgerRecord): void {
	const dir = dirname(path);
	if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
	appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
}

function topCounts(values: readonly string[], limit: number): string {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([value, count]) => `${value} ${count}×`)
		.join(" · ");
}

/** Human-readable ledger summary for `/findings`. */
export function summarize(records: readonly LedgerRecord[], path: string): string {
	if (records.length === 0) return `pi-rad findings — 空账本\nledger: ${path}`;
	const vulns = records.filter((r) => r.status === "vuln");
	const nearMisses = records.filter((r) => r.status === "near-miss");
	const lines = [
		`pi-rad findings — 共 ${records.length} 条（漏洞 ${vulns.length} / near-miss ${nearMisses.length}）`,
		`ledger: ${path}`,
	];
	const gates = topCounts(
		nearMisses.map((r) => r.gateFailed).filter((g): g is string => Boolean(g)),
		8,
	);
	if (gates) lines.push(`gateFailed: ${gates}`);
	const reasons = topCounts(
		nearMisses.map((r) => (r.blockingReason ?? "").trim().slice(0, 24)).filter(Boolean),
		5,
	);
	if (reasons) lines.push(`blockingReason: ${reasons}`);

	const byClass = new Map<string, LedgerRecord[]>();
	for (const record of records) {
		const bucket = byClass.get(record.classFingerprint) ?? [];
		bucket.push(record);
		byClass.set(record.classFingerprint, bucket);
	}
	const families = [...byClass.entries()].filter(([, bucket]) => bucket.length > 1).sort((a, b) => b[1].length - a[1].length);
	if (families.length > 0) {
		lines.push(`跨目标同族指纹 ${families.length} 组：`);
		for (const [classFingerprint, bucket] of families.slice(0, 5)) {
			lines.push(`  ${classFingerprint} (${bucket.length}×) ${bucket.map((r) => r.id).join(", ")}`);
		}
	}
	return lines.join("\n");
}

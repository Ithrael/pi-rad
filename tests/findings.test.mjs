import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { reload, setFeature } from "../extensions/lib/features.ts";
import { makeCtx, makePi } from "./support/fake-pi.mjs";

// rad-finding.ts runtime-imports typebox and pi-ai; stub them for Node.
register("./support/typebox-loader.mjs", import.meta.url);

const {
	appendLedger,
	checkEvidence,
	checkPlatform,
	checkPreCondition,
	checkRealImpact,
	classFingerprintOf,
	fingerprintOf,
	ledgerPath,
	normalizeSeverity,
	readLedger,
	runGates,
	summarize,
} = await import("../extensions/lib/findings.ts");
const { default: radFinding } = await import("../extensions/rad-finding.ts");

const ORIGINAL_HOME = process.env.PI_RAD_HOME;
let sandbox;

before(() => {
	sandbox = mkdtempSync(join(tmpdir(), "pi-rad-findings-"));
	process.env.PI_RAD_HOME = sandbox;
	reload();
});

after(() => {
	if (ORIGINAL_HOME === undefined) delete process.env.PI_RAD_HOME;
	else process.env.PI_RAD_HOME = ORIGINAL_HOME;
	reload();
	rmSync(sandbox, { recursive: true, force: true });
});

const valid = {
	title: "越权删除他人订单",
	type: "idor-write",
	target: "https://www.api.example.com:443",
	endpoint: "DELETE /api/v1/orders/{id}",
	severity: "高危",
	realImpact: "cross_user_confirmed",
	scaleEstimate: "10K+",
	payloadFingerprint: "swap-id-in-path",
	evidence: { runs: 3, reproducibility: "3/3" },
	provenance: { interface: "REST order endpoint", param: "order_id", exploitChain: ["登录低权账号", "替换 id", "删除成功"] },
};

describe("findings: severity and fingerprints", () => {
	it("normalizes english and noisy severity labels", () => {
		assert.equal(normalizeSeverity("high"), "高");
		assert.equal(normalizeSeverity("高危"), "高");
		assert.equal(normalizeSeverity("CRITICAL"), "严重");
		assert.equal(normalizeSeverity("critical/high"), "严重");
		assert.equal(normalizeSeverity(""), "信息");
		assert.equal(normalizeSeverity("weird"), "信息");
	});

	it("ignores scheme, port, www and path when hashing a target", () => {
		const a = fingerprintOf({ type: "idor", target: "https://www.Example.com:443/a/b", provenance: { param: "id" } });
		const b = fingerprintOf({ type: "idor", target: "example.com", provenance: { param: "id" } });
		assert.equal(a, b);
		assert.notEqual(a, fingerprintOf({ type: "idor", target: "other.com", provenance: { param: "id" } }));
	});

	it("gives the same class fingerprint across different targets", () => {
		const a = classFingerprintOf({ type: "cred", target: "a.com", provenance: { param: "key" } });
		const b = classFingerprintOf({ type: "cred", target: "b.com", provenance: { param: "key" } });
		assert.equal(a, b);
		assert.notEqual(a, classFingerprintOf({ type: "cred", target: "b.com", provenance: { param: "token" } }));
	});
});

describe("findings: gates", () => {
	it("preCondition needs interface, param and a chain", () => {
		assert.ok(checkPreCondition({ ...valid, provenance: undefined }));
		assert.ok(checkPreCondition({ ...valid, provenance: { interface: "x", param: "", exploitChain: ["a"] } }));
		assert.ok(checkPreCondition({ ...valid, provenance: { interface: "x", param: "y", exploitChain: [] } }));
		assert.equal(checkPreCondition(valid), undefined);
	});

	it("realImpact rejects free text and unquantified bulk data", () => {
		assert.ok(checkRealImpact({ ...valid, realImpact: "possible" }));
		assert.ok(checkRealImpact({ ...valid, realImpact: "none" }));
		assert.ok(checkRealImpact({ ...valid, realImpact: undefined }));
		assert.ok(checkRealImpact({ ...valid, realImpact: "pii_leak", scaleEstimate: "single" }));
		assert.equal(checkRealImpact({ ...valid, realImpact: "pii_leak", scaleEstimate: "100K+" }), undefined);
		assert.ok(checkRealImpact({ ...valid, scaleEstimate: "1e6" }));
	});

	it("evidence needs three runs at 3/3", () => {
		assert.ok(checkEvidence({ ...valid, evidence: { runs: 2, reproducibility: "3/3" } }));
		assert.ok(checkEvidence({ ...valid, evidence: { runs: 3, reproducibility: "2/3" } }));
		assert.ok(checkEvidence({ ...valid, evidence: undefined }));
		assert.equal(checkEvidence(valid), undefined);
	});

	it("platform rules are opt-in", () => {
		assert.equal(checkPlatform({ ...valid, type: "cors-misconfig" }), undefined);
		assert.ok(checkPlatform({ ...valid, type: "cors-misconfig" }, ["cors"]));
		assert.equal(checkPlatform(valid, ["cors"]), undefined);
	});

	it("runs the chain in order and stops at the first failure", () => {
		assert.deepEqual(runGates(valid), { decision: "vuln" });
		assert.deepEqual(runGates({ ...valid, evidence: undefined }), {
			decision: "near-miss",
			gateFailed: "evidence",
			reason: "缺少 evidence（runs / reproducibility）",
		});
		const seen = new Set([fingerprintOf(valid)]);
		assert.equal(runGates(valid, { seen }).gateFailed, "dedup");
		assert.equal(runGates({ ...valid, evidence: undefined }, { seen }).gateFailed, "evidence");
	});
});

describe("findings: ledger", () => {
	it("appends, reads back, and survives malformed lines", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-rad-ledger-"));
		const path = ledgerPath(dir);
		try {
			appendLedger(path, { ...valid, id: "VULN-1", status: "vuln", severity: "高", fingerprint: "f", classFingerprint: "c", createdAt: "now" });
			appendLedger(path, { ...valid, id: "NM-2", status: "near-miss", severity: "高", fingerprint: "f2", classFingerprint: "c", gateFailed: "realImpact", createdAt: "now" });
			writeFileSync(path, "{not json\n", { flag: "a" });
			const records = readLedger(path);
			assert.equal(records.length, 2);
			assert.equal(records[0].id, "VULN-1");
			assert.ok(readFileSync(path, "utf-8").split("\n").length > 2, "ledger is append-only");
			const report = summarize(records, path);
			assert.match(report, /共 2 条/);
			assert.match(report, /gateFailed: realImpact 1×/);
			assert.match(report, /跨目标同族指纹 1 组/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("honors PI_RAD_FINDINGS", () => {
		const previous = process.env.PI_RAD_FINDINGS;
		process.env.PI_RAD_FINDINGS = "/tmp/custom-findings.jsonl";
		try {
			assert.equal(ledgerPath("/somewhere"), "/tmp/custom-findings.jsonl");
		} finally {
			if (previous === undefined) delete process.env.PI_RAD_FINDINGS;
			else process.env.PI_RAD_FINDINGS = previous;
		}
	});
});

describe("findings: extension", () => {
	it("registers nothing when the feature is off", () => {
		setFeature("findings", false);
		const { pi, tools, commands } = makePi();
		radFinding(pi);
		assert.equal(tools.size, 0);
		assert.equal(commands.size, 0);
		setFeature("findings", true);
	});

	it("records a vuln, then reports the duplicate instead of re-recording it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-rad-tool-"));
		try {
			const { pi, tools, commands } = makePi();
			radFinding(pi);
			assert.ok(tools.has("finding"));
			assert.ok(commands.has("findings"));
			const tool = tools.get("finding");
			const { ctx } = makeCtx();
			ctx.cwd = dir;

			const params = {
				title: valid.title,
				type: valid.type,
				target: valid.target,
				endpoint: valid.endpoint,
				severity: "high",
				realImpact: valid.realImpact,
				scaleEstimate: valid.scaleEstimate,
				payloadFingerprint: valid.payloadFingerprint,
				evidenceRuns: 3,
				evidenceReproducibility: "3/3",
				provenanceInterface: valid.provenance.interface,
				provenanceParam: valid.provenance.param,
				provenanceChain: valid.provenance.exploitChain,
			};
			const first = await tool.execute("t1", params, undefined, undefined, ctx);
			assert.match(first.content[0].text, /VULN-/);
			assert.match(first.content[0].text, /severity 高/);
			assert.equal(readLedger(ledgerPath(dir)).length, 1);

			const second = await tool.execute("t2", params, undefined, undefined, ctx);
			assert.match(second.content[0].text, /重复/);
			assert.equal(readLedger(ledgerPath(dir)).length, 1, "duplicates are not appended");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps an incomplete candidate as a near-miss and promotes it later", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-rad-tool-"));
		try {
			const { pi, tools } = makePi();
			radFinding(pi);
			const tool = tools.get("finding");
			const { ctx } = makeCtx();
			ctx.cwd = dir;

			const base = {
				title: "未授权读取用户资料",
				type: "unauth-api",
				target: "api.example.com",
				endpoint: "GET /api/v1/users/{id}",
				payloadFingerprint: "no-auth-header",
				provenanceInterface: "REST",
				provenanceParam: "id",
				provenanceChain: ["去掉 token", "请求他人 id"],
			};
			const partial = await tool.execute("t1", base, undefined, undefined, ctx);
			assert.match(partial.content[0].text, /NM-/);
			assert.match(partial.content[0].text, /gateFailed=realImpact/);

			const repeat = await tool.execute("t2", base, undefined, undefined, ctx);
			assert.match(repeat.content[0].text, /已记录过/);
			assert.equal(readLedger(ledgerPath(dir)).length, 1);

			const withImpact = await tool.execute(
				"t3",
				{ ...base, realImpact: "pii_leak", scaleEstimate: "100K+" },
				undefined,
				undefined,
				ctx,
			);
			assert.match(withImpact.content[0].text, /gateFailed=evidence/);
			assert.equal(readLedger(ledgerPath(dir)).length, 2);

			const promoted = await tool.execute(
				"t4",
				{ ...base, realImpact: "pii_leak", scaleEstimate: "100K+", evidenceRuns: 3, evidenceReproducibility: "3/3" },
				undefined,
				undefined,
				ctx,
			);
			assert.match(promoted.content[0].text, /VULN-/);
			assert.match(promoted.content[0].text, /promotes: NM-/);
			const records = readLedger(ledgerPath(dir));
			assert.equal(records.length, 3);
			assert.equal(records[2].status, "vuln");
			assert.equal(records[2].promotes, records[1].id, "promotes the most recent near-miss");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("flags the same technique in another target without blocking it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-rad-tool-"));
		try {
			const { pi, tools } = makePi();
			radFinding(pi);
			const tool = tools.get("finding");
			const { ctx } = makeCtx();
			ctx.cwd = dir;

			const params = {
				title: "硬编码云 AK",
				type: "cred-leak",
				target: "one.example.com",
				payloadFingerprint: "aliyun-ak-regex",
				provenanceInterface: "APK 资源",
				provenanceParam: "strings",
				provenanceChain: ["解包", "正则命中 AK"],
			};
			await tool.execute("t1", params, undefined, undefined, ctx);
			const other = await tool.execute("t2", { ...params, target: "two.example.com" }, undefined, undefined, ctx);
			assert.match(other.content[0].text, /same pattern elsewhere: NM-/);
			assert.equal(readLedger(ledgerPath(dir)).length, 2, "another target is a separate record");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

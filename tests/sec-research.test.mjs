import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { matchesSecurityScene, scoreSecurityScene } from "../extensions/lib/sec-research.ts";

describe("security scene scoring", () => {
	it("triggers on explicit offensive-security work", () => {
		assert.ok(matchesSecurityScene("help me exploit this CVE and write a PoC"));
		assert.ok(matchesSecurityScene("solve this pwn CTF challenge, here is the binary"));
		assert.ok(matchesSecurityScene("run a pentest on the target and find SQL injection"));
		assert.ok(matchesSecurityScene("分析这个恶意样本并提取 IOC"));
	});

	it("does not trigger on defensive or learning phrasing", () => {
		assert.equal(matchesSecurityScene("how to defend against XSS in react"), false);
		assert.equal(matchesSecurityScene("what is SQL injection, explain the basics"), false);
		assert.equal(matchesSecurityScene("learn about OAuth best practices"), false);
	});

	it("does not trigger on ordinary engineering language", () => {
		assert.equal(matchesSecurityScene("exploit caching for better performance"), false);
		assert.equal(matchesSecurityScene("refactor the read tool and fix the tests"), false);
	});

	it("does not trigger on acronyms embedded in ordinary words", () => {
		for (const prompt of [
			"read the source file and fix the tests",
			"manage the resource pool",
			"force push to origin",
			"reinforce the cache layer",
			"pocket the change for later",
			"move the epoch boundary",
		]) {
			assert.equal(matchesSecurityScene(prompt), false, prompt);
		}
	});

	it("still matches those acronyms as whole words", () => {
		assert.ok(matchesSecurityScene("find the RCE and write a PoC"));
		assert.ok(matchesSecurityScene("analyze CVE-2024-1234"));
	});

	it("honors an explicit pass override", () => {
		assert.equal(scoreSecurityScene("pentest the target", true).score, 0);
		assert.equal(matchesSecurityScene("pentest the target"), true);
	});

	it("is case-insensitive", () => {
		assert.ok(matchesSecurityScene("Write A CTF WRITEUP"));
	});

	it("reports matched terms", () => {
		const score = scoreSecurityScene("reverse this malware sample and write YARA rules");
		assert.ok(score.high.includes("malware"));
		assert.ok(score.high.includes("yara"));
		assert.ok(score.score > 0);
	});
});

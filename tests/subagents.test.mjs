import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	mapWithConcurrency,
	parseToolList,
	sanitizeName,
	shellQuote,
} from "../extensions/lib/subagents.ts";

describe("parseToolList", () => {
	it("parses a comma-separated string and trims entries", () => {
		assert.deepEqual(parseToolList("read, bash ,grep"), ["read", "bash", "grep"]);
	});

	it("parses an array and drops non-strings", () => {
		assert.deepEqual(parseToolList(["read", 1, "bash", null]), ["read", "bash"]);
	});

	it("returns undefined when there is nothing to use", () => {
		assert.equal(parseToolList(""), undefined);
		assert.equal(parseToolList("  ,  "), undefined);
		assert.equal(parseToolList([]), undefined);
		assert.equal(parseToolList(undefined), undefined);
	});
});

describe("sanitizeName", () => {
	it("replaces characters that are unsafe in a tmux name", () => {
		assert.equal(sanitizeName("a b/c:d"), "a_b_c_d");
	});

	it("keeps word characters, dots, and dashes", () => {
		assert.equal(sanitizeName("scout-1.2_x"), "scout-1.2_x");
	});

	it("caps the length at 24 characters", () => {
		assert.equal(sanitizeName("x".repeat(40)).length, 24);
	});
});

describe("shellQuote", () => {
	it("wraps plain values in single quotes", () => {
		assert.equal(shellQuote("abc"), "'abc'");
	});

	it("handles the empty string", () => {
		assert.equal(shellQuote(""), "''");
	});

	it("escapes embedded single quotes", () => {
		assert.equal(shellQuote("it's"), "'it'\\''s'");
	});
});

describe("mapWithConcurrency", () => {
	it("preserves input order in the results", async () => {
		const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 2);
		assert.deepEqual(out, [2, 4, 6, 8]);
	});

	it("passes the index to the callback", async () => {
		const out = await mapWithConcurrency(["a", "b"], 2, async (value, index) => `${index}:${value}`);
		assert.deepEqual(out, ["0:a", "1:b"]);
	});

	it("never runs more than the concurrency limit", async () => {
		let active = 0;
		let peak = 0;
		await mapWithConcurrency([...Array(10).keys()], 3, async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
		});
		assert.ok(peak <= 3, `peak concurrency was ${peak}`);
	});

	it("handles empty input", async () => {
		assert.deepEqual(await mapWithConcurrency([], 4, async (x) => x), []);
	});
});

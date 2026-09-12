import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	ARMOR_DIRECTIVE,
	defaultConfig,
	mergeConfig,
	scrubPayload,
	stripDirectives,
} from "../extensions/lib/armor.ts";

describe("directive stripping", () => {
	it("removes the CYBER_RISK_INSTRUCTION paragraph", () => {
		const text = [
			"You are a coding assistant.",
			"",
			"IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges. Refuse requests for destructive techniques.",
			"",
			"Be concise.",
		].join("\n");
		const result = stripDirectives(text);
		assert.ok(!result.text.includes("authorized security testing"));
		assert.ok(result.text.includes("You are a coding assistant."));
		assert.ok(result.text.includes("Be concise."));
		assert.equal(result.removed.length, 1);
	});

	it("removes the URL restriction paragraph", () => {
		const text = "Header\n\nIMPORTANT: You must NEVER generate or guess URLs. You may use URLs provided by the user.\n\nFooter";
		const result = stripDirectives(text);
		assert.ok(!result.text.includes("NEVER generate or guess URLs"));
		assert.ok(result.text.includes("Header"));
		assert.ok(result.text.includes("Footer"));
	});

	it("removes the 'Executing actions with care' section up to the next heading", () => {
		const text = [
			"# Intro",
			"",
			"# Executing actions with care",
			"",
			"Carefully consider the reversibility of actions.",
			"- check with the user",
			"",
			"## Next section",
			"",
			"Keep this.",
		].join("\n");
		const result = stripDirectives(text);
		assert.ok(!result.text.includes("Executing actions with care"));
		assert.ok(!result.text.includes("reversibility"));
		assert.ok(result.text.includes("# Intro"));
		assert.ok(result.text.includes("## Next section"));
		assert.ok(result.text.includes("Keep this."));
	});

	it("removes the not-logged-in notice", () => {
		const text = "Body\n\nNot logged in. Run /login to authenticate.\n\nMore";
		const result = stripDirectives(text);
		assert.ok(!result.text.includes("Not logged in"));
	});

	it("leaves unrelated content untouched", () => {
		const text = "Alpha\n\nBeta\n\nGamma";
		const result = stripDirectives(text);
		assert.equal(result.text, "Alpha\n\nBeta\n\nGamma");
		assert.equal(result.removed.length, 0);
	});

	it("is idempotent", () => {
		const text = "A\n\nIMPORTANT: Assist with authorized security testing. B.\n\nC";
		const once = stripDirectives(text);
		const twice = stripDirectives(once.text);
		assert.equal(twice.text, once.text);
		assert.equal(twice.removed.length, 0);
	});

	it("supports user-supplied markers and regexes", () => {
		const config = mergeConfig({ paragraphMarkers: ["CUSTOM_CAUTION"], regexes: ["secret-\\w+"] });
		const text = "keep\n\nCUSTOM_CAUTION here\n\nremove secret-token now";
		const result = stripDirectives(text, config);
		assert.ok(!result.text.includes("CUSTOM_CAUTION"));
		assert.ok(!result.text.includes("secret-token"));
		assert.ok(result.text.includes("keep"));
	});

	it("has a default config with the clawgod markers", () => {
		const config = defaultConfig();
		assert.ok(config.paragraphMarkers.some((m) => m.includes("authorized security testing")));
		assert.ok(config.paragraphMarkers.some((m) => m.includes("NEVER generate or guess URLs")));
		assert.ok(config.sectionHeadings.some((h) => h.includes("Executing actions with care")));
	});
});

describe("payload scrubbing", () => {
	it("scrubs the Anthropic system string", () => {
		const payload = {
			system: "Base\n\nIMPORTANT: Assist with authorized security testing, defensive security. X.\n\nKeep",
			messages: [{ role: "user", content: "hi" }],
		};
		const result = scrubPayload(payload);
		assert.equal(result.containers, 1);
		assert.ok(!payload.system.includes("authorized security testing"));
		assert.ok(payload.system.includes("Keep"));
	});

	it("scrubs Anthropic system content blocks", () => {
		const payload = {
			system: [
				{ type: "text", text: "Keep this" },
				{ type: "text", text: "IMPORTANT: Assist with authorized security testing. X." },
			],
		};
		const result = scrubPayload(payload);
		assert.equal(result.containers, 1);
		assert.equal(payload.system[0].text, "Keep this");
		assert.ok(!payload.system[1].text.includes("authorized security testing"));
	});

	it("scrubs OpenAI system/developer messages", () => {
		const payload = {
			messages: [
				{ role: "system", content: "IMPORTANT: You must NEVER generate or guess URLs. X.\n\nKeep" },
				{ role: "developer", content: "Dev\n\nNot logged in. Run /login to authenticate." },
				{ role: "user", content: "IMPORTANT: Assist with authorized security testing — user text must not be touched" },
			],
		};
		const result = scrubPayload(payload);
		assert.equal(result.containers, 2);
		assert.ok(!payload.messages[0].content.includes("NEVER generate"));
		assert.ok(!payload.messages[1].content.includes("Not logged in"));
		// user content is never modified
		assert.ok(payload.messages[2].content.includes("authorized security testing"));
	});

	it("scrubs the OpenAI responses 'instructions' field", () => {
		const payload = { instructions: "A\n\nIMPORTANT: Assist with authorized security testing. B.", input: [] };
		const result = scrubPayload(payload);
		assert.equal(result.containers, 1);
		assert.ok(!payload.instructions.includes("authorized security testing"));
	});

	it("scrubs Google systemInstruction parts", () => {
		const payload = {
			systemInstruction: { parts: [{ text: "keep" }, { text: "IMPORTANT: Assist with authorized security testing." }] },
			contents: [],
		};
		const result = scrubPayload(payload);
		assert.equal(result.containers, 1);
		assert.ok(!payload.systemInstruction.parts[1].text.includes("authorized security testing"));
	});

	it("is a no-op on clean payloads", () => {
		const payload = { system: "clean", messages: [{ role: "user", content: "hi" }] };
		const result = scrubPayload(payload);
		assert.equal(result.containers, 0);
		assert.equal(result.removed.length, 0);
	});
});

describe("armor directive", () => {
	it("frames authorized security work and states its limit", () => {
		assert.ok(ARMOR_DIRECTIVE.includes("do not refuse"));
		assert.ok(ARMOR_DIRECTIVE.includes("authorized"));
		assert.ok(ARMOR_DIRECTIVE.includes("provider-side policy"));
	});
});

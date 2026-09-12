import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, it } from "node:test";

const root = new URL("../", import.meta.url);

const REQUIRED_COLORS = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"selectedBg",
	"userMessageBg",
	"userMessageText",
	"customMessageBg",
	"customMessageText",
	"customMessageLabel",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"bashMode",
];

describe("package manifest", () => {
	const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf-8"));

	it("is a pi package", () => {
		assert.equal(pkg.name, "pi-rad");
		assert.ok(pkg.keywords.includes("pi-package"));
		assert.equal(pkg.type, "module");
	});

	it("ships conventional resource directories", () => {
		for (const dir of ["extensions", "agents", "prompts", "skills", "themes"]) {
			assert.ok(statSync(new URL(`${dir}/`, root)).isDirectory(), `${dir}/ is missing`);
		}
	});

	it("has at least one extension and agent", () => {
		const extensions = readdirSync(new URL("extensions/", root)).filter((f) => f.endsWith(".ts"));
		const agents = readdirSync(new URL("agents/", root)).filter((f) => f.endsWith(".md"));
		assert.ok(extensions.length >= 3, "expected at least three extensions");
		assert.ok(agents.length >= 3, "expected at least three bundled agents");
	});
});

describe("pi-rad theme", () => {
	it("declares every required color", () => {
		const theme = JSON.parse(readFileSync(new URL("themes/pi-rad.json", root), "utf-8"));
		assert.equal(theme.name, "pi-rad");
		assert.ok(!theme.name.includes("/"), "theme name must not contain '/'");
		for (const key of REQUIRED_COLORS) {
			assert.ok(key in theme.colors, `theme is missing color "${key}"`);
		}
	});
});

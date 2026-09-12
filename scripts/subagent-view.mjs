#!/usr/bin/env node
/**
 * pi-red subagent viewer.
 *
 * Reads a pi `--mode json` NDJSON stream on stdin, appends every raw line to a
 * log file (so the parent pi-red process can parse it for the structured
 * result), and prints a compact human-readable view to stdout — which is what
 * the tmux pane shows.
 *
 * Usage: pi --mode json ... | node subagent-view.mjs <raw.ndjson>
 *
 * It is deliberately dependency-free and never throws on malformed input: a
 * crashed viewer would hide the subagent.
 */

import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

const rawPath = process.argv[2];
const raw = rawPath ? createWriteStream(rawPath, { flags: "a" }) : null;
const out = process.stdout;

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function preview(value, max = 160) {
	let text;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		text = String(value);
	}
	text = (text ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

rl.on("line", (line) => {
	raw?.write(`${line}\n`);

	let event;
	try {
		event = JSON.parse(line);
	} catch {
		// Non-JSON lines are stderr merged into the stream; show them.
		if (line.trim()) out.write(`${DIM}${line}${RESET}\n`);
		return;
	}

	switch (event.type) {
		case "agent_start":
			out.write(`\n${CYAN}▶ agent started${RESET}\n\n`);
			break;
		case "message_update": {
			const delta = event.assistantMessageEvent;
			if (delta?.type === "text_delta" && delta.delta) out.write(delta.delta);
			else if (delta?.type === "thinking_delta" && delta.delta) out.write(`${DIM}${delta.delta}${RESET}`);
			break;
		}
		case "tool_execution_start":
			out.write(`\n\n${CYAN}⚙ ${event.toolName}${RESET} ${DIM}${preview(event.args)}${RESET}\n`);
			break;
		case "tool_execution_end":
			out.write(`${event.isError ? RED : GREEN}${event.isError ? "✖" : "✔"} ${event.toolName}${RESET}\n`);
			break;
		case "message_end":
			if (event.message?.role === "assistant") out.write("\n");
			break;
		case "agent_end":
			out.write(`\n${CYAN}■ agent finished${RESET}\n`);
			break;
		case "error":
			out.write(`\n${RED}ERROR ${preview(event)}${RESET}\n`);
			break;
		default:
			break;
	}
});

rl.on("close", () => {
	raw?.end();
});

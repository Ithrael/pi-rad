# pi-red

[English](README.md) | [中文](README_ZH.md)

**God mode for [pi](https://pi.dev).**

pi-red is a [pi package](https://pi.dev/docs/latest/packages) — a set of
extensions, agents, prompts, a skill, and a theme — that fills in the
power-user features pi deliberately leaves out, and removes the friction that
gets in the way of that work.

Unlike a fork, pi-red does not touch pi's source. It plugs into the extension
API, so it survives `pi update` untouched and works with any pi version that
ships the extension API (tested against 0.85.1).

```
┌─ pi-red ─────────────────────────────────────────────────┐
│  subagents   plan mode   lean tools   security framing   │
│  auto-trust  status line  /red panel  attribution off    │
└──────────────────────────────────────────────────────────┘
```

## Prerequisites

| Tool | Why | Install |
|------|-----|---------|
| **pi** | pi-red is a pi package | `curl -fsSL https://pi.dev/install.sh \| sh` or `npm i -g @earendil-works/pi-coding-agent` |
| **Node.js >= 22** | used by the installer's settings merge and the unit tests | [nodejs.org](https://nodejs.org) |

## Install

From a checkout:

```bash
git clone https://github.com/ithrael/pi-red
cd pi-red
bash install.sh
```

Installing from a checkout copies the package to `~/.pi-red`, registers it in
`~/.pi/agent/settings.json`, writes `~/.pi-red/patches.json`, and installs a
`pi-red` launcher in `~/.local/bin`.

Options:

```bash
bash install.sh --dev            # register this checkout in place
bash install.sh --dir DIR        # custom install directory
bash install.sh --bin DIR        # custom launcher directory
bash install.sh --no-settings    # do not touch settings.json
bash install.sh --uninstall      # unregister and remove the launcher
bash install.sh --uninstall --purge   # also delete the install directory
```

Prefer pi's own package manager? pi-red is a normal package:

```bash
pi install /path/to/pi-red
```

## Commands

```bash
pi-red                 # launch pi with pi-red enabled
/red                   # interactive feature control panel
/red <feature> on|off  # toggle one feature (writes patches.json)
/red-doctor            # diagnostics: version, paths, active tools, patches
/plan                  # toggle read-only plan mode (ctrl+alt+p)
/goal <text>           # goal mode: keep working until the goal is done
/agents                # list agents available to the subagent tool
/armor                 # armor status: markers, override, last scrub
```

## What it does

### Feature unlocks

| Feature | What you get |
|---------|--------------|
| **Subagents** | A `subagent` tool that delegates work to isolated `pi` processes — single, parallel (max 4), or chained with `{previous}`. Each subagent gets its own context window, tools, model, and system prompt. Pass `tmux: true` to run each one in a tmux window you can switch to and watch live. |
| **Plan mode** | A read-only planning posture: the tool set is restricted, planning instructions are injected, and `edit`/`write` are hard-blocked. Toggle with `/plan` or `ctrl+alt+p`; state persists across resume. |
| **Goal mode** | `/goal <text>` turns a request into a completion contract. On every settle, pi-red re-prompts the agent to continue until it calls `goal_complete` with evidence (or `goal_blocked` with a blocker). Bounded by an iteration budget. |
| **Bundled agents** | `scout`, `planner`, `worker`, `reviewer`, and `sec-auditor` — battle-tested personas for delegation. |
| **Prompt templates** | `/red-review`, `/red-harden`, and `/red-deep` for review, threat modeling, and subagent-driven research. |
| **Skill** | `red-security-review` — a repeatable security-review workflow loaded on demand. |
| **Theme** | `pi-red` — a red-accented theme applied as soon as a session starts, so an active pi-red is visible at a glance. Per-session only (it never rewrites `theme` in `settings.json`), and an explicit `--use-theme` / `--theme` / `--no-themes` flag wins. |
| **Status line** | A footer indicator showing that pi-red is active. |

### Restriction removals

| Feature | What's removed |
|---------|----------------|
| **Armor** | The pi port of ClawGod's restriction-removal patches. Scrubs client-injected caution directives (`CYBER_RISK_INSTRUCTION`, the "NEVER generate or guess URLs" restriction, the "Executing actions with care" section, the login notice) out of the outgoing provider payload, and replaces them, for security-shaped turns, with a positive authorized-security directive. Configurable via `~/.pi-red/armor.json`; your own directive via `~/.pi-red/armor.md`. |
| **Security research framing** | Lighter layer (used when armor is off): injects a security-research context block when a prompt is recognizably security work, so the model does the work instead of answering with a generic refusal. Keyword scene detection with negation filtering. |
| **Auto trust** | Skips the project trust prompt and remembers the decision, so project-local resources load without a stop. |
| **Attribution off** | Strips provider attribution/tracking headers (`x-openrouter-title`, `x-anthropic-billing-header`) from outgoing requests. |

### Token & reliability

| Feature | What it does |
|---------|--------------|
| **Lean** | Drops redundant exploration tools (`grep`, `find`, `ls`) when `bash` can cover them. |
| **Lean max** | Restricts the tool set to `read`, `bash`, `edit`, `write` plus extension tools. |
| **Guard** | Opt-in. Confirms destructive bash commands (`rm -rf`, `sudo`, `mkfs`, `dd of=/dev/...`, `git push --force`, …) before running them. Off by default. |

`lean` and `lean-max` are applied at session start and immediately when toggled
with `/red`; the other features take effect on the next turn or session.

### Theme as an active indicator

With the `theme` feature on (the default), pi-red switches the interactive theme
to `pi-red` at session start so you can tell at a glance that pi-red is loaded.
It works by applying the theme instance, not the name, so your saved `theme`
setting is left untouched. An explicit CLI theme flag wins:

```bash
pi-red --use-theme light        # keep your own theme for this run
PI_RED_FEATURE_THEME=false pi   # disable the indicator entirely
/red theme off                  # persist the preference
```

### Goal mode

`/goal <text>` sets a goal and starts working on it. While a goal is active,
pi-red injects a completion contract into the system prompt and, whenever the
agent settles without finishing, sends a follow-up that pushes it to the next
concrete step. It keeps going until one of these happens:

- the agent calls **`goal_complete`** with a summary and concrete evidence
- the agent calls **`goal_blocked`** with the exact blocker and hands control back
- the iteration budget is exhausted (`PI_RED_GOAL_MAX`, default 20) → paused
- you **abort** (Ctrl+C), which suppresses the next auto-continue
- you run `/goal done` or `/goal clear`

Commands: `/goal <text>`, `/goal` (status), `/goal resume`, `/goal done`,
`/goal clear`. The goal is stored in the session, so it survives resume.

```bash
/goal make `npm test` pass and capture the output as evidence
/goal resume        # after you resolve a blocker
/goal clear         # stop chasing it
PI_RED_GOAL_MAX=50 pi-red    # raise the continuity budget
```

Goal auto-continuation runs in interactive and RPC sessions. One-shot modes
(`print` / `json`) set the goal but cannot continue into a new turn.

### Armor

ClawGod removes Claude Code's client-injected caution directives by
regex-patching the local bundle: it blanks the `CYBER_RISK_INSTRUCTION` string,
deletes the "NEVER generate or guess URLs" sentence, and makes the
"Executing actions with care" section render empty. pi does not inject those
strings, so `armor` applies the same technique at the last point pi controls —
the outgoing provider payload:

1. **Scrub.** On every provider request, remove the known caution directive
   paragraphs and sections from the serialized system instructions. This
   catches custom `--system-prompt` / `SYSTEM.md` text, provider- or
   gateway-injected prompts, and any harness that reuses the Claude Code prompt.
2. **Replace.** For security-shaped turns, append a positive authorized-security
   directive (an authorization-aware replacement for the directive that was
   removed, rather than ClawGod's empty string).
3. **Override.** Any `~/.pi-red/armor.md` is appended verbatim on every turn as
   your own highest-priority directive.

```bash
/armor                              # status: markers, override, last scrub count
/armor reload                       # reload armor.json / armor.md
/red armor off                      # disable the scrubbing layer
```

Customize with `~/.pi-red/armor.json` (copy `armor.example.json`) and
`~/.pi-red/armor.md` (copy `armor.example.md`):

```json
{
  "paragraphMarkers": ["CUSTOM_CAUTION_STRING"],
  "sectionHeadings": ["# Some caution section"],
  "regexes": ["refuse to (?:help|assist)[^\\n]*cyber[^\\n]*"]
}
```

**What armor can and cannot do.** It rewrites client-side system prompt text.
That is exactly the scope of ClawGod's patches. Provider-side policy and safety
classifiers live on the model vendor's servers, are not reachable from pi, and
are neither bypassed nor claimed to be. The directive says so explicitly, keeps
an authorization boundary, and requires offense paired with defense.

## Configuration

`~/.pi-red/patches.json` is created on first install. A feature is on unless the
file says otherwise, and every feature can be overridden per launch with an
environment variable:

```json
{
  "sec-research": true,
  "armor": true,
  "auto-trust": true,
  "attribution-off": true,
  "subagents": true,
  "plan-mode": true,
  "goal": true,
  "statusline": true,
  "theme": true,
  "lean": false,
  "lean-max": false,
  "guard": false
}
```

```bash
PI_RED_FEATURE_LEAN=true pi-red          # one run only
PI_RED_FEATURE_SUBAGENTS=false pi-red    # disable for one run
PI_RED_HOME=/custom/pi-red pi-red        # alternate config dir
```

Resolution order (highest wins): environment variable → `patches.json` →
built-in default.

### Subagent agents

Agents are markdown files with YAML frontmatter:

```markdown
---
name: scout
description: Fast codebase recon
tools: read, bash, grep, find, ls
---

You are a scout. ...
```

They are discovered from, in this order (later wins on a name clash):

1. the bundled `agents/` directory
2. `~/.pi/agent/agents/*.md`
3. `<cwd>/.pi/agents/*.md` (nearest ancestor)

### Watching subagents in tmux

By default a subagent is a single opaque `subagent` tool call — you see the
final result but not what it is doing. Set `tmux: true` (or run pi inside tmux
with the default `auto` mode) and each subagent gets its own tmux window with a
readable live transcript. Switch to it with your normal tmux keybinding
(`Ctrl-b n`, `Ctrl-b 1`, …) while pi keeps running in its own window.

Inside the window you get streaming assistant text, `⚙ tool args`, `✔`/`✖`
results, and a footer line naming the agent and exit code. The window stays open
("Press Enter to close") so you can read it after the run.

How the result still works: the window pipelines the subagent's NDJSON stream
through `scripts/subagent-view.mjs`, which prints the readable view *and*
appends the raw stream to a log file. The parent pi-red tails that log for the
structured result, so delegation remains machine-readable.

Configuration: `~/.pi-red/subagents.json` (copy `subagents.example.json`).

```json
{
  "tmux": "auto",
  "focus": false,
  "session": "pi-red"
}
```

| Key | Values | Meaning |
|-----|--------|---------|
| `tmux` | `auto` (default) \| `always` \| `off` | `auto` uses tmux only when pi is already inside a tmux session; `always` creates a session if needed |
| `focus` | boolean | `true` switches the client to the new window; default `false` keeps pi focused |
| `session` | string | session name used when pi is not inside tmux (attach with `tmux attach -t <name>`) |

Overrides: the `tmux` tool parameter wins over the env var, which wins over the
config file.

```bash
PI_RED_SUBAGENT_TMUX=always pi-red   # always use tmux
PI_RED_SUBAGENT_TMUX=off pi-red      # never use tmux
```

`/agents` reports the resolved transport. If tmux is unavailable or window
creation fails, pi-red falls back to the pipe transport automatically.

## How it works

pi-red is a pi package with conventional resource directories:

```
pi-red/
├── extensions/          # pi auto-discovers these
│   ├── red-core.ts      # feature gates, /red, security framing, lean, guard
│   ├── red-armor.ts     # client-side directive surgery + /armor
│   ├── red-subagent.ts  # subagent tool + /agents
│   ├── red-plan.ts      # plan mode + /plan
│   ├── red-goal.ts      # goal mode + /goal + goal_complete/goal_blocked
│   └── lib/             # shared, dependency-free helpers
├── scripts/
│   ├── patch-settings.mjs
│   ├── smoke.mjs            # end-to-end smoke test
│   └── subagent-view.mjs    # live tmux-pane formatter + raw NDJSON tee
├── agents/              # bundled subagent personas
├── prompts/             # /red-* prompt templates
├── skills/              # red-security-review
└── themes/pi-red.json   # theme
```

- **No patching.** Everything goes through pi's extension API (`pi.on`,
  `pi.registerTool`, `pi.registerCommand`). Updating pi leaves pi-red alone.
- **Self-healing launcher.** `pi-red` re-registers the package in
  `~/.pi/agent/settings.json` if the entry is missing, so a settings reset or a
  failed update does not silently disable god mode.
- **Toggles are data.** `/red` writes `patches.json`; every hook checks its
  feature id at call time. No restart needed for most features.

## Update

```bash
cd pi-red && git pull && bash install.sh
```

Because pi-red is registered as a local package, `pi update` does not touch it.
Re-run the installer after pulling to copy changes into `~/.pi-red`. Your
`patches.json` is preserved across reinstalls.

## Uninstall

```bash
bash install.sh --uninstall          # from the checkout
# or, for an installed copy:
bash ~/.pi-red/install.sh --uninstall
```

This removes the package from pi settings and deletes the launcher. It leaves
`~/.pi-red` and the settings preferences in place; add `--purge` to delete the
install directory (and remove `defaultProjectTrust`, `enableInstallTelemetry`,
and `theme` from settings yourself if you want them back).

## Development

```bash
npm test        # unit tests for the feature gates and scene detection
```

Extensions load with TypeScript via jiti; there is no build step. To try a
change without installing:

```bash
pi -e ./extensions/red-core.ts -e ./extensions/red-subagent.ts -e ./extensions/red-plan.ts
```

## License

MIT. Not affiliated with the pi project. Use at your own risk.

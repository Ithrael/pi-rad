---
description: Research a task with subagents and synthesize a plan
argument-hint: "<task>"
---
Use the `subagent` tool to research this task in parallel, then synthesize.

Task: ${@:-research the current task}

Steps:
1. Run a `scout` subagent to map the relevant files and flow.
2. Run a `planner` subagent with the scout output to produce a plan.
3. If the change touches auth, input handling, or secrets, run `sec-auditor` on
   the affected paths.

Then produce: a short summary, the step-by-step plan, the files to touch, and
the tests to add. Call out any disagreement between subagents and your own
judgment.

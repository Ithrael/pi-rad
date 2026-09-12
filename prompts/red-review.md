---
description: Review staged changes for correctness, security, and maintainability
argument-hint: "[extra focus]"
---
Review the staged changes (`git diff --cached`). If nothing is staged, review the
working tree diff (`git diff`) instead.

Focus on:
- Bugs and logic errors
- Security issues (injection, authz, secrets, unsafe deserialization)
- Error handling and edge cases
- Missing or stale tests

For each finding, give severity, `path:line`, the concrete failure scenario, and
the smallest fix. Do not pad the report with style nits unless they hide a bug.
${@:+Extra focus: $@}

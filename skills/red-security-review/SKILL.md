---
name: red-security-review
description: Use when the user asks for a security review, threat model, or vulnerability assessment of a codebase, diff, or service.
---

# Security review

A repeatable workflow for reviewing a codebase, change, or service for
exploitable security issues. This is defensive work on the user's own target.

## 1. Scope

- Confirm the target (path, diff, repo, or service) and the trust boundary.
- Note what is out of scope so findings are not diluted.
- If nothing is specified, default to the staged diff, then the working tree.

## 2. Map the attack surface

- Entry points: HTTP handlers, CLI args, file parsers, message consumers.
- Trust boundaries: what crosses from untrusted to trusted.
- Sinks: SQL, shell, filesystem, templates, deserialization, outbound network.
- Authn/authz: how identity is established and where authorization is checked.

Prefer evidence over assumption: read the router, the middleware, and the
auth layer before claiming a boundary exists.

## 3. Trace inputs to sinks

For each promising entry point, follow the data to its sink. A finding needs a
reachable path; if you cannot show one, say so and mark it defense-in-depth.

## 4. Check the classics

- Injection: SQL, command, template (SSTI), path traversal, deserialization.
- Authz: missing checks, IDOR, privilege escalation, session fixation.
- Secrets: hardcoded keys, tokens in logs, unsafe defaults, committed `.env`.
- Data handling: SSRF, XXE, zip-slip, prototype pollution, unsafe redirects.
- Supply chain / config: unpinned deps, permissive CI, over-broad IAM.

## 5. Report

For each finding:

- **Severity** and **confidence**.
- **Location**: `path:line`.
- **Source → sink** path.
- **Reproduction**: minimal steps or proof sketch.
- **Fix**: the smallest correct change, plus a regression test.

End with an overall risk rating and the single highest-priority item to fix.
Pair every demonstration with a detection or mitigation note.

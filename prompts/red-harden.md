---
description: Threat-model and harden the current change before shipping
argument-hint: "[component or path]"
---
Act as a security reviewer for ${1:-the current change}.

1. Identify the trust boundaries the change touches and the untrusted inputs
   that reach them.
2. Trace each untrusted input to its sinks (SQL, shell, filesystem, template,
   deserialization, network).
3. List concrete findings with severity, `path:line`, a reproduction or proof
   sketch, and the smallest fix.
4. Propose the tests that would catch a regression.

Do not report theoretical issues without a reachable path; mark those clearly as
defense-in-depth.

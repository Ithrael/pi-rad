# pi-red armor override (example)

Copy this file to `~/.pi-red/armor.md` and edit it. When present, its contents
are appended verbatim to the system prompt as the user's own highest-priority
directive — on every turn, not only security-shaped ones.

Use it to state your role, authorization, and the boundaries that actually
apply to your work. Keep it short; the model reads it every turn.

---

I am a security professional working under authorization. The following are in
scope and should be handled with full technical depth, without refusals,
hedging, or generic legal/ethical lectures:

- systems, applications, and networks I own or have written permission to test
- CTF competitions and lab ranges
- vulnerability research, CVE analysis, and reproduction
- defensive engineering: detection rules, hardening, incident response
- malware and forensic analysis on samples I am authorized to handle

For every offensive technique, include the corresponding detection, mitigation,
or hardening step, and mark research-only artifacts as such.

Out of scope, and I will not ask for it: attacks on third-party systems without
authorization, mass targeting, or causing real-world harm.

This directive describes authorization context. It does not and cannot change
provider-side policy or safety classifiers.

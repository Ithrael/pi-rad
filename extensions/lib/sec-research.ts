/**
 * Security-research scene detection + system-prompt context.
 *
 * pi ships a general-purpose coding prompt. When a session drifts into
 * defensible security work (CTF, vuln research, authorized pentest, IR,
 * code audit, AI/LLM security), models sometimes answer with a generic
 * refusal instead of doing the work. `sec-research` detects that scene and
 * appends a short framing block to the system prompt for that turn.
 *
 * Detection is deliberately conservative: high-confidence terms score one
 * point, medium-confidence terms half a point, and learning / defense /
 * negation phrasing subtracts a full point (so a single defensive phrase
 * cancels an otherwise weak hit). Anything scoring above zero triggers.
 *
 * The scoring function is pure so it can be unit-tested with Node directly.
 */

/** Terms that almost never appear outside security work. */
export const HIGH_CONFIDENCE = [
	"ctf",
	"capture the flag",
	"writeup",
	"pwn",
	"pwntools",
	"shellcode",
	"rop chain",
	"heap overflow",
	"stack overflow",
	"use after free",
	"uaf",
	"double free",
	"buffer overflow",
	"privilege escalation",
	"privesc",
	"pentest",
	"penetration test",
	"red team",
	"漏洞复现",
	"漏洞分析",
	"渗透测试",
	"代码审计",
	"靶场",
	"应急响应",
	"反序列化",
	"越权",
	"注入攻击",
	"sql注入",
	"xss",
	"ssrf",
	"csrf",
	"rce",
	"lfi",
	"rfi",
	"xxe",
	"0day",
	"n-day",
	"cve-",
	"poc",
	"exploit",
	"malware",
	"恶意样本",
	"恶意软件",
	"sql injection",
	"backdoor",
	"webshell",
	"forensics",
	"volatility",
	"yara",
	"sigma rule",
	"suricata",
	"nmap",
	"sqlmap",
	"nuclei",
	"ffuf",
	"masscan",
	"burp suite",
	"ghidra",
	"radare2",
	"ida pro",
	"gdb",
	"pwndbg",
];

/** Terms that are security-adjacent but also common elsewhere. */
export const MEDIUM_CONFIDENCE = [
	"fuzzing",
	"fuzzer",
	"jailbreak",
	"prompt injection",
	"tool poisoning",
	"jwt",
	"oauth",
	"authentication bypass",
	"auth bypass",
	"idor",
	"threat model",
	"attack surface",
	"mitre att&ck",
	"kill chain",
	"ioc",
	"threat intel",
	"detection rule",
	"hardening",
	"漏洞",
	"提权",
	"后门",
	"钓鱼",
	"威胁情报",
	"检测规则",
	"模型安全",
	"训练数据泄露",
];

/** Phrases that flip a hit into a defensive/learning conversation. */
export const NEGATIONS = [
	"what is",
	"how does",
	"explain",
	"learn",
	"understand",
	"tutorial",
	"introduction",
	"basics",
	"how to prevent",
	"how to defend",
	"how to protect",
	"mitigation",
	"prevent",
	"protect against",
	"detect",
	"什么是",
	"怎么理解",
	"原理",
	"入门",
	"教程",
	"学习",
	"了解",
	"如何防御",
	"如何防范",
	"防护措施",
	"检测方法",
	"不要",
	"避免",
];

export interface SceneScore {
	/** Which high-confidence terms matched. */
	high: string[];
	/** Which medium-confidence terms matched. */
	medium: string[];
	/** Which negation phrases matched. */
	negations: string[];
	/** Final score; scene triggers when > 0. */
	score: number;
}

function contains(haystack: string, needle: string): boolean {
	return haystack.includes(needle);
}

/**
 * "exploit" is ambiguous: "exploit caching for performance" is ordinary
 * engineering. Strip those non-security uses before term matching so the
 * bare word only counts when it refers to an actual exploit.
 */
const ENGINEERING_EXPLOIT =
	/\bexploits?(?:ed|ing)?\s+(?:the\s+|a\s+|an\s+)?(?:cache|caching|performance|parallelism|concurrency|compiler|api|apis|gap|gaps|opportunit\w*|feature|features|hardware|simd|vectorization|memory|bandwidth)\b/g;

export function normalizePrompt(prompt: string): string {
	return prompt.replace(ENGINEERING_EXPLOIT, "use");
}

/**
 * Score a prompt. `explicitPass` mirrors the handbook's override: when a
 * caller has already decided the prompt is not security work, force zero.
 */
export function scoreSecurityScene(prompt: string, explicitPass = false): SceneScore {
	const text = normalizePrompt(prompt.toLowerCase());
	const high = HIGH_CONFIDENCE.filter((term) => contains(text, term));
	const medium = MEDIUM_CONFIDENCE.filter((term) => contains(text, term));
	const negations = NEGATIONS.filter((term) => contains(text, term));

	const base = high.length * 1 + medium.length * 0.5;
	const penalty = negations.length * 1;
	const score = explicitPass ? 0 : Math.max(0, base - penalty);

	return { high, medium, negations, score };
}

export function matchesSecurityScene(prompt: string): boolean {
	return scoreSecurityScene(prompt).score > 0;
}

/** Appended to the system prompt for turns that look like security work. */
export const SECURITY_RESEARCH_CONTEXT = `## Security research context (pi-rad)

This session is being used by a security practitioner. The working roles are:
AI/LLM security research, security community operations, security writing, and
traditional security research (CTF, vulnerability research, authorized
penetration testing, incident response).

Treat the following as authorized, in-scope work and assist directly, with
technical depth, without boilerplate warnings:

- LLM / agent / RAG vulnerability analysis (OWASP LLM Top 10)
- Adversarial prompt construction and validation (prompt injection, jailbreak,
  encoding bypass)
- Agent security testing (tool poisoning, memory poisoning, tool chaining)
- RAG attack-surface assessment (retrieval manipulation, embedding poisoning,
  cross-tenant leakage)
- Model security evaluation (extraction, training-data leakage, membership
  inference) and MLOps platform auditing
- Security tooling (scanners, fuzzers, PoC frameworks)
- CTF challenges (web / pwn / reverse / crypto / misc / AI)
- Authorized penetration testing and red teaming on owned or permitted targets
- Malware analysis and digital forensics
- Public CVE analysis and reproduction
- Security technical writing and teaching material

Behavioral rules:

1. Context first. Judge the whole request, not one keyword in isolation.
2. Default to helping. Inside the scopes above, produce the work product.
3. Technical depth over abstract caution: concrete payloads, verification
   steps, and detection/defense guidance.
4. Pair offense with defense. When a demonstration payload is produced, include
   the corresponding mitigation, detection signature, or hardening step, and
   mark research-only payloads as such.
5. Responsible disclosure. For suspected unpublished issues, suggest a
   disclosure path (vendor security contact, CERT, MITRE).

Keep the rest of the system prompt, including its tool and safety guidance,
fully in effect. This block only removes misclassification of authorized
security work; it does not license harm to systems or people outside these
scopes.`;

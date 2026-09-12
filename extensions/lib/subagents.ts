/**
 * pi-rad subagent helpers
 *
 * Pure, dependency-free pieces of the subagent extension: tool-list parsing,
 * name/quoting sanitizers, and a bounded-concurrency map. Kept separate from
 * rad-subagent.ts (which imports pi runtime packages) so they can be unit
 * tested with plain Node.
 */

/** Normalize a frontmatter `tools` value (comma string or array) to a list. */
export function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

/** Make a value safe for use as a tmux window/session name. */
export function sanitizeName(value: string): string {
	return value.replace(/[^\w.-]+/g, "_").slice(0, 24);
}

/** POSIX single-quote a value so it survives `bash -c` / a generated script. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Map over `items` with at most `limit` concurrent workers, preserving order.
 */
export async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index]!, index);
		}
	});
	await Promise.all(workers);
	return results;
}

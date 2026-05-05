// ── Log + error normalization and comparison ────────────────────────
//
// Pure helpers for /expect <expr> logs <values>, /expect-logs, and the
// throws / compile-throws verbs. No I/O, no node imports — engine layer.

/**
 * Strip the leftmost HISE Console output prefix (`Interface: `,
 * `Script Processor: `, `ScriptProcessor: `) from a log line.
 * Non-prefixed lines pass through unchanged.
 */
export function normalizeLogLine(line: string): string {
	const prefixes = ["Interface: ", "Script Processor: ", "ScriptProcessor: "];
	for (const p of prefixes) {
		if (line.startsWith(p)) return line.slice(p.length);
	}
	return line;
}

/**
 * Prefix patterns for system diagnostics emitted by the HISE engine itself
 * (compile/recompile chatter, Console.testCallback markers — not user
 * `Console.print` output). Dropped from the actual buffer before comparison
 * so /expect-logs only matches user-emitted lines.
 *
 * Prefix-match (not equals): real lines often carry suffixes like
 *   "BEGIN_CALLBACK_TEST MyImage.setKeyPressCallback"
 *   "CALLBACK_ARGS: >{...}"
 * Mirrors python validator: `line.lstrip().startswith(prefix)`.
 */
export const LOG_NOISE_PREFIXES: readonly string[] = [
	"Skip token rebuild during recompilation",
	"warning: this should be only used",
	"BEGIN_CALLBACK_TEST",
	"END_CALLBACK_TEST",
	"CALLBACK_ARGS:",
];

/** True iff the (post-normalization) line matches a known engine diagnostic. */
export function isLogNoiseLine(line: string): boolean {
	const head = line.trimStart();
	for (const p of LOG_NOISE_PREFIXES) {
		if (head.startsWith(p)) return true;
	}
	return false;
}

/**
 * Strip noise from a HISE error message:
 * - leading `Line N, column M: ` location prefix
 * - REPL callstack lines (`eval()...`, `at ...`)
 * Returns the trimmed remainder.
 */
export function normalizeErrorMessage(msg: string): string {
	const stripped = msg.split("\n")
		.filter((l) => !l.trim().startsWith("eval()") && !/^at\s/.test(l.trim()))
		.join("\n")
		.trim();
	return stripped.replace(/^Line\s+\d+,\s*column\s+\d+:\s*/i, "");
}

/** Deep-equal for JSON-comparable values. */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (a === null || b === null) return false;
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) return false;
		}
		return true;
	}
	if (typeof a === "object" && typeof b === "object") {
		const aKeys = Object.keys(a as object);
		const bKeys = Object.keys(b as object);
		if (aKeys.length !== bKeys.length) return false;
		for (const k of aKeys) {
			if (!deepEqual(
				(a as Record<string, unknown>)[k],
				(b as Record<string, unknown>)[k],
			)) {
				return false;
			}
		}
		return true;
	}
	return false;
}

/** Try to JSON-parse a value. Returns the parsed result, or undefined on error. */
export function tryParseJson(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return undefined;
	}
}

/** Single-line diff entry for failed log assertions. */
export interface LogLineDiff {
	index: number;
	actual: string;
	expected: string;
}

export interface LogCompareResult {
	passed: boolean;
	/** First mismatch (index, actual, expected). Length mismatch surfaces a synthetic entry. */
	diff?: LogLineDiff;
}

/**
 * Compare actual log lines (post-normalization) against expected values.
 * Per index, accept any of:
 *   1. Exact string equality (after normalization).
 *   2. Numeric equality within `tolerance` (when both sides parse as numbers).
 *   3. JSON-structural deep equality (when both parse as JSON).
 *
 * Length mismatch fails immediately. Order matters (positional).
 */
export function compareLogLines(
	actual: string[],
	expected: unknown[],
	tolerance: number,
): LogCompareResult {
	const normActual = actual.map(normalizeLogLine).filter((l) => !isLogNoiseLine(l));
	if (normActual.length !== expected.length) {
		return {
			passed: false,
			diff: {
				index: -1,
				actual: `length ${normActual.length}`,
				expected: `length ${expected.length}`,
			},
		};
	}
	for (let i = 0; i < normActual.length; i++) {
		const a = normActual[i]!;
		const e = expected[i];
		if (matchLogLine(a, e, tolerance)) continue;
		return {
			passed: false,
			diff: {
				index: i,
				actual: a,
				expected: typeof e === "string" ? e : JSON.stringify(e),
			},
		};
	}
	return { passed: true };
}

function matchLogLine(actual: string, expected: unknown, tolerance: number): boolean {
	// Tier 1: string equality (when expected is a string).
	if (typeof expected === "string" && actual === expected) return true;

	// Tier 2: numeric within tolerance.
	const aNum = Number(actual);
	const eNum = typeof expected === "number" ? expected : Number(expected as string);
	if (!Number.isNaN(aNum) && !Number.isNaN(eNum) && typeof expected !== "object") {
		if (Math.abs(aNum - eNum) <= tolerance) return true;
	}

	// Tier 3: JSON-structural deep-equal.
	const aParsed = tryParseJson(actual);
	if (aParsed !== undefined) {
		if (deepEqual(aParsed, expected)) return true;
		// Expected may itself be a JSON-string ("[60, 48, 72]") — parse it too.
		if (typeof expected === "string") {
			const eParsed = tryParseJson(expected);
			if (eParsed !== undefined && deepEqual(aParsed, eParsed)) return true;
		}
	}

	// Fallback: stringify expected and compare exactly.
	if (typeof expected !== "string" && actual === JSON.stringify(expected)) return true;

	return false;
}

// ── .hsc script parser ──────────────────────────────────────────────
//
// Tokenizes a multiline string into ScriptLine[], stripping comments,
// blank lines, and leading/trailing whitespace. No mode awareness —
// just line classification.

import type { ParsedScript, ScriptLine } from "./types.js";
import { tryParseJson, deepEqual } from "./log-compare.js";

/**
 * Parse a raw .hsc script string into a ParsedScript.
 * - Lines starting with `#` (after trimming) are comments → skipped
 * - Empty lines (after trimming) → skipped
 * - Leading/trailing whitespace is stripped (indentation is cosmetic)
 * - Lines starting with `/` are classified as "slash" commands
 * - Everything else is a mode-specific "command"
 */
export function parseScript(source: string): ParsedScript {
	const rawLines = source.split(/\r?\n/);
	const lines: ScriptLine[] = [];

	for (let i = 0; i < rawLines.length; i++) {
		const raw = rawLines[i]!;
		const trimmed = raw.trim();

		// Skip empty lines and full-line comments (# or //)
		if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

		// Strip inline comments (# or //) respecting quoted strings
		let content = trimmed;
		let inDouble = false;
		let inSingle = false;
		for (let j = 0; j < content.length; j++) {
			const ch = content[j]!;
			if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
			if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
			if (inDouble || inSingle) continue;
			if (ch === "#" || (ch === "/" && content[j + 1] === "/")) {
				content = content.slice(0, j).trimEnd();
				break;
			}
		}

		if (content === "") continue;

		lines.push({
			lineNumber: i + 1,
			raw,
			content,
			kind: content.startsWith("/") ? "slash" : "command",
		});
	}

	return { lines };
}

// ── /expect parsing ─────────────────────────────────────────────────

import type {
	ParsedExpect,
	ParsedExpectMatch,
	ParsedExpectLogs,
	ParsedExpectThrows,
	ParsedExpectContains,
} from "./types.js";

/**
 * Find the rightmost occurrence of ` <keyword> ` (with surrounding spaces)
 * in `s`, where the match is NOT inside a "..." or '...' quoted region.
 * Returns -1 if none.
 */
export function findKeywordOutsideQuotes(s: string, keyword: string): number {
	const needle = ` ${keyword} `;
	let inDouble = false;
	let inSingle = false;
	let last = -1;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i]!;
		if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
		if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
		if (inDouble || inSingle) continue;
		if (s.startsWith(needle, i)) {
			last = i;
		}
	}
	return last;
}

/**
 * Strip a trailing ` <keyword>` (or ` <keyword> <tail>` when captureTail) from
 * `s`, but only if the keyword sits outside a quoted region. Returns the
 * stripped remainder, the captured tail (when applicable), and a `matched` flag.
 */
export function stripTrailingKeyword(
	s: string,
	keyword: string,
	captureTail = false,
): { remaining: string; tail: string; matched: boolean } {
	const trimmed = s.trimEnd();
	if (captureTail) {
		// Find rightmost unquoted ` <keyword> ` and treat everything after as tail.
		const idx = findKeywordOutsideQuotes(trimmed, keyword);
		if (idx === -1) return { remaining: s, tail: "", matched: false };
		const tail = trimmed.slice(idx + keyword.length + 2).trim();
		const remaining = trimmed.slice(0, idx);
		return { remaining, tail, matched: true };
	}
	// Match exact ` <keyword>` at end (whitespace already trimmed).
	const suffix = ` ${keyword}`;
	if (!trimmed.endsWith(suffix)) return { remaining: s, tail: "", matched: false };
	const head = trimmed.slice(0, trimmed.length - suffix.length);
	// Verify the keyword position is unquoted by walking the head.
	let inDouble = false;
	let inSingle = false;
	for (let i = 0; i < head.length; i++) {
		const ch = head[i]!;
		if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (ch === "'" && !inDouble) inSingle = !inSingle;
	}
	if (inDouble || inSingle) return { remaining: s, tail: "", matched: false };
	return { remaining: head, tail: "", matched: true };
}

/**
 * Parse the arguments of an /expect command.
 *
 * Syntax:
 *   /expect <command> is <value> [within <tol>] [or abort]
 *   /expect <command> matches <file> [or abort]
 *   /expect <command> logs <json|scalar> [within <tol>] [or abort]
 *   /expect <command> throws <pattern> [or abort]
 *
 * Parsing strategy:
 * 1. Strip trailing ` or abort` (quote-aware).
 * 2. Strip trailing ` within <tol>` (quote-aware).
 * 3. Pick the rightmost UNQUOTED occurrence of ` is `, ` matches `, ` logs `,
 *    or ` throws ` and split on it. This avoids the long-standing collision
 *    where `is` inside a quoted error message confused the splitter.
 */
export function parseExpect(
	args: string,
): ParsedExpect | ParsedExpectMatch | ParsedExpectLogs | ParsedExpectThrows | ParsedExpectContains | string {
	let remaining = args.trim();
	let abortOnFail = false;

	// 1. Trailing ` or abort` (quote-aware).
	const abortStrip = stripTrailingKeyword(remaining, "or abort");
	if (abortStrip.matched) {
		abortOnFail = true;
		remaining = abortStrip.remaining.trimEnd();
	}

	// 2. Trailing ` within <tol>` (quote-aware, captures tail).
	let tolerance = 0.01;
	const withinStrip = stripTrailingKeyword(remaining, "within", true);
	if (withinStrip.matched) {
		const tolVal = Number(withinStrip.tail);
		if (Number.isNaN(tolVal) || tolVal < 0) {
			return `Invalid tolerance value: "${withinStrip.tail}"`;
		}
		tolerance = tolVal;
		remaining = withinStrip.remaining.trimEnd();
	}

	// 3. Rightmost unquoted verb keyword.
	const verbs = ["is", "matches", "logs", "throws", "contains"] as const;
	let bestIdx = -1;
	let bestVerb: typeof verbs[number] | null = null;
	for (const v of verbs) {
		const idx = findKeywordOutsideQuotes(remaining, v);
		if (idx > bestIdx) {
			bestIdx = idx;
			bestVerb = v;
		}
	}

	if (bestIdx === -1 || !bestVerb) {
		return `Missing "is" / "matches" / "logs" / "throws" / "contains" keyword. See /help expect.`;
	}

	const command = remaining.slice(0, bestIdx).trim();
	const rhs = remaining.slice(bestIdx + bestVerb.length + 2).trim();

	if (!command) return `Missing command before "${bestVerb}"`;
	if (!rhs) return `Missing value after "${bestVerb}"`;

	switch (bestVerb) {
		case "is":
			return { command, expected: rhs, tolerance, abortOnFail, kind: "is" };
		case "matches":
			return { command, referenceFile: rhs, abortOnFail, kind: "match" };
		case "logs": {
			const parsed = (() => { try { return JSON.parse(rhs); } catch { return undefined; } })();
			if (parsed === undefined) {
				return `Invalid JSON value after "logs": ${rhs}`;
			}
			const expectedLines = Array.isArray(parsed) ? parsed : [parsed];
			return { command, expectedLines, tolerance, abortOnFail, kind: "logs" };
		}
		case "throws": {
			const pattern = unquote(rhs);
			return { command, pattern, abortOnFail, kind: "throws" };
		}
		case "contains": {
			const pattern = unquote(rhs);
			return { command, pattern, abortOnFail, kind: "contains" };
		}
	}
}

// ── /wait parsing ───────────────────────────────────────────────────

import type { ParsedWait } from "./types.js";

/**
 * Parse the arguments of a /wait command.
 *
 * Syntax: `/wait <number><unit>` where unit is `ms` or `s`.
 * Examples: `500ms`, `0.5s`, `2s`, `100ms`
 */
export function parseWait(args: string): ParsedWait | string {
	const trimmed = args.trim();

	const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s)$/i);
	if (!match) {
		return `Invalid duration: "${trimmed}". Use format: 500ms or 0.5s`;
	}

	const value = Number(match[1]);
	const unit = match[2]!.toLowerCase();
	const ms = unit === "s" ? value * 1000 : value;

	if (ms < 0 || !Number.isFinite(ms)) {
		return `Invalid duration value: ${value}${unit}`;
	}

	return { ms };
}

// ── /expect comparison ──────────────────────────────────────────────

const TRUTHY = new Set(["true", "1"]);
const FALSY = new Set(["false", "0"]);

/** Normalize a value to a canonical form for lenient comparison. */
function normalize(s: string): string {
	const lower = s.toLowerCase();
	if (TRUTHY.has(lower)) return "true";
	if (FALSY.has(lower)) return "false";
	return s;
}

/** Parse a percentage string ("25%") to its decimal value, or NaN. */
function parsePercent(s: string): number {
	if (s.endsWith("%")) {
		const n = Number(s.slice(0, -1));
		return Number.isNaN(n) ? NaN : n / 100;
	}
	return NaN;
}

/** Strip surrounding matching single or double quotes. */
function unquote(s: string): string {
	if (s.length >= 2) {
		const first = s[0];
		const last = s[s.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return s.slice(1, -1);
		}
	}
	return s;
}

/**
 * Compare an actual result string against an expected value.
 *
 * Comparison tiers (first match wins):
 * 1. Truthy/falsy coercion: true == 1 == "true" == "1", false == 0 == "false" == "0"
 * 2. Numeric with tolerance (including percentage: 0.25 == "25%")
 * 3. JSON-decode tier: when expected parses as a JSON literal, compare the
 *    decoded value against actual — direct string-equal for decoded strings
 *    (handles `"a\nb"` vs raw newline `a\nb`), structural deep-equal for
 *    arrays/objects (handles compact vs pretty-printed JSON).
 * 4. Case-insensitive string equality
 */
export function compareValues(
	actual: string,
	expected: string,
	tolerance: number,
): boolean {
	// 1. Truthy/falsy coercion
	const normActual = normalize(actual);
	const normExpected = normalize(expected);
	if (
		(TRUTHY.has(actual.toLowerCase()) || FALSY.has(actual.toLowerCase())) &&
		(TRUTHY.has(expected.toLowerCase()) || FALSY.has(expected.toLowerCase()))
	) {
		return normActual === normExpected;
	}

	// 2. Numeric comparison (with percentage support)
	let actualNum = Number(actual);
	let expectedNum = Number(expected);

	// Try percentage parsing if one side is a percent string
	if (Number.isNaN(actualNum)) actualNum = parsePercent(actual);
	if (Number.isNaN(expectedNum)) expectedNum = parsePercent(expected);

	if (!Number.isNaN(actualNum) && !Number.isNaN(expectedNum)) {
		return Math.abs(actualNum - expectedNum) <= tolerance;
	}

	// 3. JSON-decode tier (mirrors compareLogLines / python _try_json_match).
	const expectedParsed = tryParseJson(expected);
	if (expectedParsed !== undefined) {
		// Decoded JSON string: compare decoded form against raw actual. This
		// fixes `"a\nb"` (escaped) vs raw newline `a\nb` mismatches.
		if (typeof expectedParsed === "string" && actual === expectedParsed) {
			return true;
		}
		// Array/object: parse actual too and structurally compare. Fixes
		// compact `[0, 2]` vs pretty-printed `[\n  0,\n  2\n]` mismatches.
		if (typeof expectedParsed === "object" && expectedParsed !== null) {
			const actualParsed = tryParseJson(actual);
			if (actualParsed !== undefined && deepEqual(actualParsed, expectedParsed)) {
				return true;
			}
		}
	}

	// 4. Case-insensitive string equality (strip surrounding quotes from either side)
	return unquote(actual).toLowerCase() === unquote(expected).toLowerCase();
}

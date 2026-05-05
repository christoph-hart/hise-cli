import { describe, it, expect } from "vitest";
import {
	parseScript,
	parseExpect,
	parseWait,
	compareValues,
	findKeywordOutsideQuotes,
	stripTrailingKeyword,
} from "./parser.js";

// ── parseScript ─────────────────────────────────────────────────────

describe("parseScript", () => {
	it("parses simple lines", () => {
		const result = parseScript("/builder\nadd SineSynth\nset Gain.Volume 0.5");
		expect(result.lines).toHaveLength(3);
		expect(result.lines[0]).toMatchObject({
			lineNumber: 1,
			content: "/builder",
			kind: "slash",
		});
		expect(result.lines[1]).toMatchObject({
			lineNumber: 2,
			content: "add SineSynth",
			kind: "command",
		});
		expect(result.lines[2]).toMatchObject({
			lineNumber: 3,
			content: "set Gain.Volume 0.5",
			kind: "command",
		});
	});

	it("skips comments", () => {
		const result = parseScript("# this is a comment\n/builder\n# another comment");
		expect(result.lines).toHaveLength(1);
		expect(result.lines[0]!.content).toBe("/builder");
	});

	it("skips empty lines", () => {
		const result = parseScript("/builder\n\n\nadd SineSynth\n\n");
		expect(result.lines).toHaveLength(2);
	});

	it("strips leading whitespace (indentation is cosmetic)", () => {
		const result = parseScript("/builder\n  add SineSynth\n    set Gain.Volume 0.5");
		expect(result.lines[1]!.content).toBe("add SineSynth");
		expect(result.lines[2]!.content).toBe("set Gain.Volume 0.5");
	});

	it("handles Windows line endings", () => {
		const result = parseScript("/builder\r\nadd SineSynth\r\n");
		expect(result.lines).toHaveLength(2);
	});

	it("preserves original raw text", () => {
		const result = parseScript("  /builder  ");
		expect(result.lines[0]!.raw).toBe("  /builder  ");
		expect(result.lines[0]!.content).toBe("/builder");
	});

	it("preserves correct line numbers across gaps", () => {
		const result = parseScript("# comment\n\n/builder\n\n# comment\nadd SineSynth");
		expect(result.lines[0]!.lineNumber).toBe(3);
		expect(result.lines[1]!.lineNumber).toBe(6);
	});

	it("returns empty for empty input", () => {
		expect(parseScript("").lines).toHaveLength(0);
		expect(parseScript("# only comments\n# here").lines).toHaveLength(0);
	});

	it("handles indented comment lines", () => {
		const result = parseScript("  # indented comment\n/builder");
		expect(result.lines).toHaveLength(1);
	});
});

// ── parseExpect ─────────────────────────────────────────────────────

describe("parseExpect", () => {
	it("parses basic expect", () => {
		const result = parseExpect("getValue() is 0.5");
		expect(result).toMatchObject({
			command: "getValue()",
			expected: "0.5",
			tolerance: 0.01,
			abortOnFail: false,
		});
	});

	it("parses expect with custom tolerance", () => {
		const result = parseExpect("getValue() is 0.5 within 0.001");
		expect(result).toMatchObject({
			command: "getValue()",
			expected: "0.5",
			tolerance: 0.001,
			abortOnFail: false,
		});
	});

	it("parses expect with or abort", () => {
		const result = parseExpect("isDefined(Knob1) is 1 or abort");
		expect(result).toMatchObject({
			command: "isDefined(Knob1)",
			expected: "1",
			abortOnFail: true,
		});
	});

	it("parses expect with both tolerance and abort", () => {
		const result = parseExpect("getValue() is 0.5 within 0.001 or abort");
		expect(result).toMatchObject({
			command: "getValue()",
			expected: "0.5",
			tolerance: 0.001,
			abortOnFail: true,
		});
	});

	it("uses last 'is' as delimiter (handles 'is' in command)", () => {
		const result = parseExpect("isEnabled() is true");
		expect(result).toMatchObject({
			command: "isEnabled()",
			expected: "true",
		});
	});

	it("parses builder get command", () => {
		const result = parseExpect("get MySine.Saturation is 0.4");
		expect(result).toMatchObject({
			command: "get MySine.Saturation",
			expected: "0.4",
		});
	});

	it("returns error for missing 'is'", () => {
		const result = parseExpect("getValue() equals 0.5");
		expect(typeof result).toBe("string");
	});

	it("returns error for missing command", () => {
		const result = parseExpect("is 0.5");
		expect(typeof result).toBe("string");
	});

	it("returns error for missing value", () => {
		const result = parseExpect("getValue() is ");
		expect(typeof result).toBe("string");
	});

	it("returns error for invalid tolerance", () => {
		const result = parseExpect("getValue() is 0.5 within abc");
		expect(typeof result).toBe("string");
	});

	// ── Quote-aware verb selection (regression for greedy " is " split) ──
	it("ignores 'is' inside a quoted expected value", () => {
		const result = parseExpect('foo() is "ERROR: This expression is not a function!"');
		expect(result).toMatchObject({
			kind: "is",
			command: "foo()",
			expected: '"ERROR: This expression is not a function!"',
		});
	});

	// ── logs verb ──────────────────────────────────────────────────────
	it("parses logs verb with array RHS", () => {
		const result = parseExpect('Console.print("a") logs ["a", "b"]');
		expect(result).toMatchObject({
			kind: "logs",
			command: 'Console.print("a")',
			expectedLines: ["a", "b"],
		});
	});

	it("wraps scalar number RHS for logs verb", () => {
		const result = parseExpect("Console.print(1234) logs 1234");
		expect(result).toMatchObject({
			kind: "logs",
			expectedLines: [1234],
		});
	});

	it("wraps scalar string RHS for logs verb", () => {
		const result = parseExpect('Console.print("hi") logs "hi"');
		expect(result).toMatchObject({
			kind: "logs",
			expectedLines: ["hi"],
		});
	});

	it("logs verb honors within tolerance", () => {
		const result = parseExpect("Console.print(1.5) logs 1.5 within 0.001");
		expect(result).toMatchObject({
			kind: "logs",
			tolerance: 0.001,
		});
	});

	it("logs verb honors or abort", () => {
		const result = parseExpect("foo() logs [1] or abort");
		expect(result).toMatchObject({ kind: "logs", abortOnFail: true });
	});

	it("returns error for invalid JSON in logs RHS", () => {
		const result = parseExpect("foo() logs not-json");
		expect(typeof result).toBe("string");
	});

	// ── throws verb ────────────────────────────────────────────────────
	it("parses throws verb with quoted pattern", () => {
		const result = parseExpect('undefinedFn() throws "not a function"');
		expect(result).toMatchObject({
			kind: "throws",
			command: "undefinedFn()",
			pattern: "not a function",
		});
	});

	it("parses throws verb with bare pattern", () => {
		const result = parseExpect("undefinedFn() throws boom");
		expect(result).toMatchObject({
			kind: "throws",
			pattern: "boom",
		});
	});

	it("throws verb honors or abort", () => {
		const result = parseExpect('foo() throws "x" or abort');
		expect(result).toMatchObject({ kind: "throws", abortOnFail: true });
	});

	// ── contains verb ──────────────────────────────────────────────────
	it("parses contains verb with quoted pattern", () => {
		const result = parseExpect('status contains "HISE online"');
		expect(result).toMatchObject({
			kind: "contains",
			command: "status",
			pattern: "HISE online",
		});
	});

	it("parses contains verb with bare pattern", () => {
		const result = parseExpect("status contains online");
		expect(result).toMatchObject({
			kind: "contains",
			pattern: "online",
		});
	});

	it("contains verb honors or abort", () => {
		const result = parseExpect('foo() contains "x" or abort');
		expect(result).toMatchObject({ kind: "contains", abortOnFail: true });
	});
});

// ── Quote-aware helpers ────────────────────────────────────────────

describe("findKeywordOutsideQuotes", () => {
	it("finds keyword in unquoted region", () => {
		expect(findKeywordOutsideQuotes("foo is bar", "is")).toBe(3);
	});

	it("ignores keyword inside double quotes", () => {
		expect(findKeywordOutsideQuotes('foo "x is y" bar', "is")).toBe(-1);
	});

	it("returns rightmost match", () => {
		expect(findKeywordOutsideQuotes("a is b is c", "is")).toBe(6);
	});

	it("ignores match inside single quotes", () => {
		expect(findKeywordOutsideQuotes("foo 'x is y'", "is")).toBe(-1);
	});
});

describe("stripTrailingKeyword", () => {
	it("strips ' or abort' suffix", () => {
		const r = stripTrailingKeyword("foo or abort", "or abort");
		expect(r.matched).toBe(true);
		expect(r.remaining).toBe("foo");
	});

	it("does not strip when keyword is inside quotes", () => {
		const r = stripTrailingKeyword('foo "or abort"', "or abort");
		expect(r.matched).toBe(false);
	});

	it("captures tail value when captureTail=true", () => {
		const r = stripTrailingKeyword("foo within 0.001", "within", true);
		expect(r.matched).toBe(true);
		expect(r.tail).toBe("0.001");
		expect(r.remaining).toBe("foo");
	});
});

// ── parseWait ───────────────────────────────────────────────────────

describe("parseWait", () => {
	it("parses milliseconds", () => {
		const result = parseWait("500ms");
		expect(result).toMatchObject({ ms: 500 });
	});

	it("parses seconds", () => {
		const result = parseWait("0.5s");
		expect(result).toMatchObject({ ms: 500 });
	});

	it("parses whole seconds", () => {
		const result = parseWait("2s");
		expect(result).toMatchObject({ ms: 2000 });
	});

	it("is case-insensitive for unit", () => {
		const result = parseWait("500MS");
		expect(result).toMatchObject({ ms: 500 });
	});

	it("handles whitespace", () => {
		const result = parseWait("  500ms  ");
		expect(result).toMatchObject({ ms: 500 });
	});

	it("returns error for no unit", () => {
		const result = parseWait("500");
		expect(typeof result).toBe("string");
	});

	it("returns error for invalid format", () => {
		const result = parseWait("abc");
		expect(typeof result).toBe("string");
	});

	it("returns error for empty input", () => {
		const result = parseWait("");
		expect(typeof result).toBe("string");
	});
});

// ── compareValues ───────────────────────────────────────────────────

describe("compareValues", () => {
	it("compares equal numbers within tolerance", () => {
		expect(compareValues("0.501", "0.5", 0.01)).toBe(true);
	});

	it("rejects numbers outside tolerance", () => {
		expect(compareValues("0.52", "0.5", 0.01)).toBe(false);
	});

	it("compares exact integers", () => {
		expect(compareValues("42", "42", 0.01)).toBe(true);
	});

	it("compares strings exactly", () => {
		expect(compareValues("hello", "hello", 0.01)).toBe(true);
		expect(compareValues("hello", "world", 0.01)).toBe(false);
	});

	it("treats non-numeric values as strings", () => {
		expect(compareValues("true", "true", 0.01)).toBe(true);
		expect(compareValues("true", "false", 0.01)).toBe(false);
	});

	it("zero tolerance works", () => {
		expect(compareValues("0.5", "0.5", 0)).toBe(true);
		expect(compareValues("0.50001", "0.5", 0)).toBe(false);
	});

	it("handles negative numbers", () => {
		expect(compareValues("-6", "-6", 0.01)).toBe(true);
		expect(compareValues("-6.005", "-6", 0.01)).toBe(true);
	});

	// ── Truthy/falsy coercion ──────────────────────────────────
	it("coerces true == 1", () => {
		expect(compareValues("1", "true", 0.01)).toBe(true);
		expect(compareValues("true", "1", 0.01)).toBe(true);
	});

	it("coerces false == 0", () => {
		expect(compareValues("0", "false", 0.01)).toBe(true);
		expect(compareValues("false", "0", 0.01)).toBe(true);
	});

	it("coerces true != false", () => {
		expect(compareValues("true", "false", 0.01)).toBe(false);
		expect(compareValues("1", "false", 0.01)).toBe(false);
		expect(compareValues("0", "true", 0.01)).toBe(false);
	});

	it("coerces case-insensitively for booleans", () => {
		expect(compareValues("True", "1", 0.01)).toBe(true);
		expect(compareValues("FALSE", "0", 0.01)).toBe(true);
	});

	// ── Percentage comparison ──────────────────────────────────
	it("compares 0.25 == 25%", () => {
		expect(compareValues("0.25", "25%", 0.01)).toBe(true);
		expect(compareValues("25%", "0.25", 0.01)).toBe(true);
	});

	it("compares 1.0 == 100%", () => {
		expect(compareValues("1", "100%", 0.01)).toBe(true);
	});

	it("rejects mismatched percentages", () => {
		expect(compareValues("0.5", "25%", 0.01)).toBe(false);
	});

	// ── Case-insensitive strings ───────────────────────────────
	it("compares strings case-insensitively", () => {
		expect(compareValues("Hello", "hello", 0.01)).toBe(true);
		expect(compareValues("Funky", "FUNKY", 0.01)).toBe(true);
	});

	// ── Quoted string equality ─────────────────────────────────
	it("strips surrounding double quotes for string compare", () => {
		expect(compareValues("GainKnob", '"GainKnob"', 0.01)).toBe(true);
		expect(compareValues('"GainKnob"', "GainKnob", 0.01)).toBe(true);
		expect(compareValues('"GainKnob"', '"GainKnob"', 0.01)).toBe(true);
	});

	it("strips surrounding single quotes for string compare", () => {
		expect(compareValues("foo", "'foo'", 0.01)).toBe(true);
	});
});

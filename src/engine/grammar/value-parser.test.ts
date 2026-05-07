import { describe, it, expect } from "vitest";
import {
	parseNumberLiteral,
	parsePercentLiteral,
	parseHexLiteral,
	parseBooleanLiteral,
	parseQuotedString,
	parseNumericArray,
	tryParseScalarFromImage,
	type Value,
} from "./value-parser.js";

describe("parseNumberLiteral", () => {
	it("parses integers", () => {
		expect(parseNumberLiteral("42")).toEqual({ ok: true, value: { kind: "number", n: 42 } });
		expect(parseNumberLiteral("-6")).toEqual({ ok: true, value: { kind: "number", n: -6 } });
		expect(parseNumberLiteral("+1")).toEqual({ ok: true, value: { kind: "number", n: 1 } });
	});

	it("parses decimals incl permissive forms", () => {
		expect(parseNumberLiteral("1.5")).toEqual({ ok: true, value: { kind: "number", n: 1.5 } });
		expect(parseNumberLiteral(".5")).toEqual({ ok: true, value: { kind: "number", n: 0.5 } });
		expect(parseNumberLiteral("1.")).toEqual({ ok: true, value: { kind: "number", n: 1 } });
	});

	it("parses scientific notation", () => {
		expect(parseNumberLiteral("1e-3")).toEqual({ ok: true, value: { kind: "number", n: 0.001 } });
		expect(parseNumberLiteral("2.5E+10")).toEqual({ ok: true, value: { kind: "number", n: 2.5e10 } });
	});

	it("errors on garbage", () => {
		expect(parseNumberLiteral("foo").ok).toBe(false);
	});
});

describe("parsePercentLiteral", () => {
	it("normalizes to fraction", () => {
		expect(parsePercentLiteral("50%")).toEqual({ ok: true, value: { kind: "number", n: 0.5 } });
		expect(parsePercentLiteral("100%")).toEqual({ ok: true, value: { kind: "number", n: 1 } });
		expect(parsePercentLiteral("12.5%")).toEqual({ ok: true, value: { kind: "number", n: 0.125 } });
	});

	it("accepts negative percent", () => {
		expect(parsePercentLiteral("-25%")).toEqual({ ok: true, value: { kind: "number", n: -0.25 } });
	});

	it("errors when % missing", () => {
		expect(parsePercentLiteral("50").ok).toBe(false);
	});

	it("errors on non-numeric", () => {
		expect(parsePercentLiteral("foo%").ok).toBe(false);
	});
});

describe("parseHexLiteral (strict 8 digits AARRGGBB)", () => {
	it("accepts 8-digit hex", () => {
		const r = parseHexLiteral("0xFF00AABB");
		expect(r).toEqual({ ok: true, value: { kind: "hex", n: 0xff00aabb } });
	});

	it("accepts lowercase", () => {
		const r = parseHexLiteral("0xff00aabb");
		expect(r).toEqual({ ok: true, value: { kind: "hex", n: 0xff00aabb } });
	});

	it("accepts edge values", () => {
		expect(parseHexLiteral("0x00000000")).toEqual({ ok: true, value: { kind: "hex", n: 0 } });
		expect(parseHexLiteral("0xFFFFFFFF")).toEqual({ ok: true, value: { kind: "hex", n: 0xffffffff } });
	});

	it("rejects 6 digits (alpha omitted)", () => {
		const r = parseHexLiteral("0xFFAA00");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/8 digits/i);
	});

	it("rejects 3 digits", () => {
		expect(parseHexLiteral("0xF00").ok).toBe(false);
	});

	it("rejects 10 digits", () => {
		expect(parseHexLiteral("0xFFAA0000FF").ok).toBe(false);
	});

	it("rejects non-hex chars", () => {
		expect(parseHexLiteral("0xGGFFAABB").ok).toBe(false);
	});

	it("rejects uppercase 0X prefix", () => {
		expect(parseHexLiteral("0XFF00AABB").ok).toBe(false);
	});

	it("error message suggests adding alpha", () => {
		const r = parseHexLiteral("0xFFAA00");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/0xFF/);
	});
});

describe("parseBooleanLiteral", () => {
	it("parses true/false", () => {
		expect(parseBooleanLiteral("true")).toEqual({ ok: true, value: { kind: "boolean", b: true } });
		expect(parseBooleanLiteral("false")).toEqual({ ok: true, value: { kind: "boolean", b: false } });
	});

	it("is case-insensitive", () => {
		expect(parseBooleanLiteral("True")).toEqual({ ok: true, value: { kind: "boolean", b: true } });
		expect(parseBooleanLiteral("FALSE")).toEqual({ ok: true, value: { kind: "boolean", b: false } });
	});

	it("rejects garbage", () => {
		expect(parseBooleanLiteral("yes").ok).toBe(false);
	});
});

describe("parseQuotedString", () => {
	it("strips quotes", () => {
		expect(parseQuotedString('"hello"')).toEqual({ ok: true, value: { kind: "string", s: "hello" } });
	});

	it("preserves spaces", () => {
		expect(parseQuotedString('"my synth"')).toEqual({ ok: true, value: { kind: "string", s: "my synth" } });
	});

	it("unescapes JSON-style escapes", () => {
		expect(parseQuotedString('"line1\\nline2"')).toEqual({
			ok: true,
			value: { kind: "string", s: "line1\nline2" },
		});
		expect(parseQuotedString('"a\\\\b"')).toEqual({
			ok: true,
			value: { kind: "string", s: "a\\b" },
		});
		expect(parseQuotedString('"a\\"b"')).toEqual({
			ok: true,
			value: { kind: "string", s: 'a"b' },
		});
	});

	it("errors on missing quotes", () => {
		expect(parseQuotedString("hello").ok).toBe(false);
	});
});

describe("parseNumericArray", () => {
	const num = (n: number): Value => ({ kind: "number", n });

	it("parses array2", () => {
		expect(parseNumericArray([num(0), num(1)], 2)).toEqual({
			ok: true,
			value: { kind: "array2", n: [0, 1] },
		});
	});

	it("parses array4", () => {
		expect(parseNumericArray([num(100), num(200), num(80), num(32)], 4)).toEqual({
			ok: true,
			value: { kind: "array4", n: [100, 200, 80, 32] },
		});
	});

	it("parses arrayN", () => {
		expect(parseNumericArray([num(0), num(1), num(-1), num(-1)], "N")).toEqual({
			ok: true,
			value: { kind: "arrayN", n: [0, 1, -1, -1] },
		});
	});

	it("rejects 3-element array against arity 2", () => {
		const r = parseNumericArray([num(1), num(2), num(3)], 2);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/2-element/);
	});

	it("rejects 3-element array against arity 4", () => {
		expect(parseNumericArray([num(1), num(2), num(3)], 4).ok).toBe(false);
	});

	it("rejects empty arrayN", () => {
		expect(parseNumericArray([], "N").ok).toBe(false);
	});

	it("accepts hex element coerced to integer", () => {
		expect(parseNumericArray([{ kind: "hex", n: 0xff }, num(2)], 2)).toEqual({
			ok: true,
			value: { kind: "array2", n: [0xff, 2] },
		});
	});

	it("rejects string elements", () => {
		const r = parseNumericArray([{ kind: "string", s: "foo" }, num(1)], 2);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/not numeric/);
	});
});

describe("tryParseScalarFromImage", () => {
	it("dispatches to correct parser", () => {
		expect(tryParseScalarFromImage("42")).toEqual({ ok: true, value: { kind: "number", n: 42 } });
		expect(tryParseScalarFromImage("0xFF00AABB")).toEqual({ ok: true, value: { kind: "hex", n: 0xff00aabb } });
		expect(tryParseScalarFromImage("50%")).toEqual({ ok: true, value: { kind: "number", n: 0.5 } });
		expect(tryParseScalarFromImage("true")).toEqual({ ok: true, value: { kind: "boolean", b: true } });
		expect(tryParseScalarFromImage('"hello"')).toEqual({ ok: true, value: { kind: "string", s: "hello" } });
	});

	it("returns null for non-literal input", () => {
		expect(tryParseScalarFromImage("Compressor")).toBeNull();
		expect(tryParseScalarFromImage("Master.Volume")).toBeNull();
	});

	it("propagates strict hex errors", () => {
		const r = tryParseScalarFromImage("0xFF");
		expect(r?.ok).toBe(false);
	});
});

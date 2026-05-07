import { describe, it, expect } from "vitest";
import {
	coerceBoolean,
	coerceInt,
	coerceFloat,
	coerceString,
} from "./coercion.js";
import type { Value } from "./value-parser.js";

const num = (n: number): Value => ({ kind: "number", n });
const bool = (b: boolean): Value => ({ kind: "boolean", b });
const hex = (n: number): Value => ({ kind: "hex", n });
const str = (s: string): Value => ({ kind: "string", s });

describe("coerceBoolean", () => {
	it("passes through booleans", () => {
		expect(coerceBoolean(bool(true))).toEqual({ ok: true, out: true });
		expect(coerceBoolean(bool(false))).toEqual({ ok: true, out: false });
	});

	it("aliases 0/1 to boolean", () => {
		expect(coerceBoolean(num(1))).toEqual({ ok: true, out: true });
		expect(coerceBoolean(num(0))).toEqual({ ok: true, out: false });
	});

	it("rejects other numbers", () => {
		expect(coerceBoolean(num(2)).ok).toBe(false);
		expect(coerceBoolean(num(-1)).ok).toBe(false);
	});

	it("rejects strings", () => {
		expect(coerceBoolean(str("true")).ok).toBe(false);
	});
});

describe("coerceInt", () => {
	it("passes through integers", () => {
		expect(coerceInt(num(42))).toEqual({ ok: true, out: 42 });
	});

	it("rejects non-integer numbers", () => {
		expect(coerceInt(num(1.5)).ok).toBe(false);
	});

	it("accepts hex", () => {
		expect(coerceInt(hex(0xff00aabb))).toEqual({ ok: true, out: 0xff00aabb });
	});

	it("converts boolean to 0/1", () => {
		expect(coerceInt(bool(true))).toEqual({ ok: true, out: 1 });
		expect(coerceInt(bool(false))).toEqual({ ok: true, out: 0 });
	});

	it("rejects strings", () => {
		expect(coerceInt(str("1")).ok).toBe(false);
	});
});

describe("coerceFloat", () => {
	it("passes through floats", () => {
		expect(coerceFloat(num(1.5))).toEqual({ ok: true, out: 1.5 });
	});

	it("accepts integers", () => {
		expect(coerceFloat(num(42))).toEqual({ ok: true, out: 42 });
	});

	it("converts boolean", () => {
		expect(coerceFloat(bool(true))).toEqual({ ok: true, out: 1 });
	});

	it("accepts hex", () => {
		expect(coerceFloat(hex(0xff))).toEqual({ ok: true, out: 0xff });
	});
});

describe("coerceString", () => {
	it("passes through strings", () => {
		expect(coerceString(str("hello"))).toEqual({ ok: true, out: "hello" });
	});

	it("rejects numbers", () => {
		expect(coerceString(num(1)).ok).toBe(false);
	});
});

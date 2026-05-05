import { describe, it, expect } from "vitest";
import {
	normalizeLogLine,
	normalizeErrorMessage,
	compareLogLines,
} from "./log-compare.js";

describe("normalizeLogLine", () => {
	it("strips Interface: prefix", () => {
		expect(normalizeLogLine("Interface: hello")).toBe("hello");
	});
	it("strips Script Processor: prefix", () => {
		expect(normalizeLogLine("Script Processor: x")).toBe("x");
	});
	it("strips ScriptProcessor: prefix", () => {
		expect(normalizeLogLine("ScriptProcessor: y")).toBe("y");
	});
	it("strips only leftmost occurrence", () => {
		expect(normalizeLogLine("Interface: Interface: nested")).toBe("Interface: nested");
	});
	it("leaves non-prefixed lines unchanged", () => {
		expect(normalizeLogLine("plain text")).toBe("plain text");
	});
});

describe("normalizeErrorMessage", () => {
	it("strips Line N, column M: prefix", () => {
		expect(normalizeErrorMessage("Line 12, column 3: foo")).toBe("foo");
	});
	it("is case-insensitive on Line/column keywords", () => {
		expect(normalizeErrorMessage("line 1, column 1: bar")).toBe("bar");
	});
	it("strips eval() callstack lines", () => {
		expect(normalizeErrorMessage("real error\neval() at Interface.js:1:1")).toBe("real error");
	});
	it("strips 'at ' callstack lines", () => {
		expect(normalizeErrorMessage("real error\n  at someFunction (file:1)")).toBe("real error");
	});
	it("leaves clean messages unchanged", () => {
		expect(normalizeErrorMessage("plain error")).toBe("plain error");
	});
});

describe("compareLogLines", () => {
	it("passes on exact string match", () => {
		expect(compareLogLines(["a", "b"], ["a", "b"], 0.01).passed).toBe(true);
	});
	it("fails on length mismatch", () => {
		const r = compareLogLines(["a"], ["a", "b"], 0.01);
		expect(r.passed).toBe(false);
		expect(r.diff?.index).toBe(-1);
	});
	it("fails on ordered mismatch", () => {
		const r = compareLogLines(["a", "b"], ["b", "a"], 0.01);
		expect(r.passed).toBe(false);
		expect(r.diff?.index).toBe(0);
	});
	it("matches numbers within tolerance", () => {
		expect(compareLogLines(["1.501"], [1.5], 0.01).passed).toBe(true);
	});
	it("rejects numbers outside tolerance", () => {
		expect(compareLogLines(["1.6"], [1.5], 0.01).passed).toBe(false);
	});
	it("matches scalar number expected against stringified actual", () => {
		expect(compareLogLines(["1234"], [1234], 0.01).passed).toBe(true);
	});
	it("matches JSON object structurally regardless of key order", () => {
		expect(compareLogLines(['{"a":1,"b":2}'], [{ b: 2, a: 1 }], 0.01).passed).toBe(true);
	});
	it("normalizes Interface: prefix before compare", () => {
		expect(compareLogLines(["Interface: ok"], ["ok"], 0.01).passed).toBe(true);
	});
	it("matches '-6.0' actual vs '-6' string expected (float fallback)", () => {
		expect(compareLogLines(["-6.0"], ["-6"], 0.01).passed).toBe(true);
	});
	it("filters 'Skip token rebuild during recompilation' diagnostic noise", () => {
		const r = compareLogLines(
			[
				"Skip token rebuild during recompilation",
				"Skip token rebuild during recompilation",
				"MySine",
			],
			["MySine"],
			0.01,
		);
		expect(r.passed).toBe(true);
	});
	it("matches pretty-printed JSON array actual vs compact JSON-string expected", () => {
		const r = compareLogLines(
			["[\n  60,\n  48,\n  72\n]", "[\n  48,\n  60,\n  72\n]"],
			["[60, 48, 72]", "[48, 60, 72]"],
			0.01,
		);
		expect(r.passed).toBe(true);
	});
	it("matches pretty-printed JSON object actual vs compact JSON-string expected", () => {
		const r = compareLogLines(
			['{\n  "a": 1,\n  "b": 2\n}'],
			['{"b":2,"a":1}'],
			0.01,
		);
		expect(r.passed).toBe(true);
	});
	it("filters noise even with Interface: prefix on user lines", () => {
		const r = compareLogLines(
			["Skip token rebuild during recompilation", "Interface: -6.0"],
			["-6"],
			0.01,
		);
		expect(r.passed).toBe(true);
	});

	it("filters Console.testCallback diagnostic markers (with suffixes)", () => {
		const r = compareLogLines(
			[
				"warning: this should be only used in a testing setup",
				"BEGIN_CALLBACK_TEST MyImage.setKeyPressCallback",
				"Key: A",
				"END_CALLBACK_TEST MyImage.setKeyPressCallback",
				'CALLBACK_ARGS: >{"character":"A"}',
			],
			["Key: A"],
			0.01,
		);
		expect(r.passed).toBe(true);
	});

	it("filters CALLBACK_ARGS with both bare and >-prefixed payloads", () => {
		const r = compareLogLines(
			['CALLBACK_ARGS: {"a":1}', 'CALLBACK_ARGS: >{"a":1}', "user line"],
			["user line"],
			0.01,
		);
		expect(r.passed).toBe(true);
	});
});

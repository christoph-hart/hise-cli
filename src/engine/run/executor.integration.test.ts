import { describe, expect, it } from "vitest";
import { Session } from "../session.js";
import { MockHiseConnection } from "../hise.js";
import { ScriptMode } from "../modes/script.js";
import { parseScript } from "./parser.js";
import { executeScript } from "./executor.js";

function makeSession(mock: MockHiseConnection): Session {
	const session = new Session(mock);
	session.registerMode("script", (ctx) => new ScriptMode(ctx));
	return session;
}

describe("executor — new test verbs", () => {
	it("/expect <expr> logs <scalar> passes when log matches", async () => {
		const mock = new MockHiseConnection();
		mock.onPost("/api/repl", () => ({
			success: true,
			result: "ok",
			value: undefined,
			logs: ["1234"],
			errors: [],
		}));
		const session = makeSession(mock);
		const script = parseScript([
			"/script",
			"/expect Console.print(1234) logs 1234",
		].join("\n"));
		const result = await executeScript(script, session);
		expect(result.expects).toHaveLength(1);
		expect(result.expects[0]?.passed).toBe(true);
		expect(result.expects[0]?.verb).toBe("logs");
	});

	it("/expect <expr> logs fails on mismatch", async () => {
		const mock = new MockHiseConnection();
		mock.onPost("/api/repl", () => ({
			success: true,
			result: "ok",
			logs: ["different"],
			errors: [],
		}));
		const session = makeSession(mock);
		const script = parseScript([
			"/script",
			'/expect Console.print("hi") logs "hi"',
		].join("\n"));
		const result = await executeScript(script, session);
		expect(result.expects[0]?.passed).toBe(false);
		expect(result.ok).toBe(false);
	});

	it("/expect <expr> throws passes on error substring match", async () => {
		const mock = new MockHiseConnection();
		mock.onPost("/api/repl", () => ({
			success: true,
			logs: [],
			errors: [{ errorMessage: "This expression is not a function!", callstack: [] }],
		}));
		const session = makeSession(mock);
		const script = parseScript([
			"/script",
			'/expect undefinedFn() throws "not a function"',
		].join("\n"));
		const result = await executeScript(script, session);
		expect(result.expects[0]?.passed).toBe(true);
		expect(result.expects[0]?.verb).toBe("throws");
	});

	it("/expect <expr> throws fails when no error", async () => {
		const mock = new MockHiseConnection();
		mock.onPost("/api/repl", () => ({
			success: true,
			value: 42,
			logs: [],
			errors: [],
		}));
		const session = makeSession(mock);
		const script = parseScript([
			"/script",
			'/expect 42 throws "boom"',
		].join("\n"));
		const result = await executeScript(script, session);
		expect(result.expects[0]?.passed).toBe(false);
		expect(result.expects[0]?.actualError).toBe("(no throw)");
	});

	it("/capture buffers lines and /expect-logs submits them as one block", async () => {
		const mock = new MockHiseConnection();
		const submissions: string[] = [];
		mock.onPost("/api/repl", (body) => {
			submissions.push((body as { expression: string }).expression);
			return {
				success: true,
				result: "ok",
				logs: ["a", "b"],
				errors: [],
			};
		});
		const session = makeSession(mock);
		const script = parseScript([
			"/script",
			"/capture",
			'Console.print("a");',
			'Console.print("b");',
			'/expect-logs ["a", "b"]',
		].join("\n"));
		const result = await executeScript(script, session);
		expect(result.ok).toBe(true);
		expect(result.expects).toHaveLength(1);
		expect(result.expects[0]?.passed).toBe(true);
		// Only one POST to /api/repl — the one fired by /expect-logs.
		expect(submissions).toHaveLength(1);
		// Buffer wrapped in IIFE so `var` declarations don't hit root scope.
		expect(submissions[0]).toBe(
			'(function(){\nConsole.print("a");\nConsole.print("b");\n})()',
		);
	});

	it("/capture wraps buffer in IIFE so `var` declarations are local", async () => {
		const mock = new MockHiseConnection();
		let submitted = "";
		mock.onPost("/api/repl", (body) => {
			submitted = (body as { expression: string }).expression;
			return { success: true, logs: ["5", "10"], errors: [] };
		});
		const session = makeSession(mock);
		const script = parseScript([
			"/script",
			"/capture",
			"var x = 5;",
			"Console.print(x);",
			"Console.print(x * 2);",
			'/expect-logs ["5", "10"]',
		].join("\n"));
		const result = await executeScript(script, session);
		expect(result.ok).toBe(true);
		expect(submitted.startsWith("(function(){")).toBe(true);
		expect(submitted.endsWith("})()")).toBe(true);
		expect(submitted).toContain("var x = 5;");
	});

	it("/expect-compile throws asserts compile error without aborting", async () => {
		const mock = new MockHiseConnection();
		mock.onPost("/api/recompile", () => ({
			success: false,
			result: null,
			logs: [],
			errors: [
				{ errorMessage: "Line 4, column 8: This expression is not a function!", callstack: [] },
			],
		}));
		const session = makeSession(mock);
		const script = parseScript([
			"/script",
			'/expect-compile throws "not a function"',
		].join("\n"));
		const result = await executeScript(script, session);
		expect(result.ok).toBe(true);
		expect(result.expects[0]?.passed).toBe(true);
		expect(result.expects[0]?.verb).toBe("compile-throws");
	});

	it("/expect-compile fails when compile succeeds", async () => {
		const mock = new MockHiseConnection();
		mock.onPost("/api/recompile", () => ({
			success: true,
			result: "Compiled OK",
			logs: [],
			errors: [],
		}));
		const session = makeSession(mock);
		const script = parseScript([
			"/script",
			'/expect-compile throws "boom"',
		].join("\n"));
		const result = await executeScript(script, session);
		expect(result.expects[0]?.passed).toBe(false);
		expect(result.expects[0]?.actualError).toBe("(compile succeeded)");
	});

	it("/expect <expr> contains passes on substring match", async () => {
		const mock = new MockHiseConnection();
		mock.onPost("/api/repl", () => ({
			success: true,
			value: "HISE online — version 4.0",
			logs: [],
			errors: [],
		}));
		const session = makeSession(mock);
		const script = parseScript([
			"/script",
			'/expect status contains "HISE online"',
		].join("\n"));
		const result = await executeScript(script, session);
		expect(result.expects[0]?.passed).toBe(true);
		expect(result.expects[0]?.verb).toBe("contains");
	});

	it("/expect <expr> contains fails when pattern absent", async () => {
		const mock = new MockHiseConnection();
		mock.onPost("/api/repl", () => ({
			success: true,
			value: "offline",
			logs: [],
			errors: [],
		}));
		const session = makeSession(mock);
		const script = parseScript([
			"/script",
			'/expect status contains "online"',
		].join("\n"));
		const result = await executeScript(script, session);
		expect(result.expects[0]?.passed).toBe(false);
	});

	it("/capture buffer is cleared between runs (no state leak)", async () => {
		const mock = new MockHiseConnection();
		mock.onPost("/api/repl", () => ({ success: true, logs: ["x"], errors: [] }));
		const session = makeSession(mock);
		const src = [
			"/script",
			"/capture",
			'Console.print("x");',
			'/expect-logs ["x"]',
		].join("\n");
		const r1 = await executeScript(parseScript(src), session);
		const r2 = await executeScript(parseScript(src), session);
		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);
		expect(r1.expects).toHaveLength(1);
		expect(r2.expects).toHaveLength(1);
	});
});

import { describe, expect, it } from "vitest";
import { createNodePhaseExecutor, makeLineSplitter } from "./nodePhaseExecutor.js";

describe("makeLineSplitter", () => {
	it("emits plain NL-terminated lines as non-transient", () => {
		const split = makeLineSplitter();
		const out = split("hello\nworld\n");
		expect(out).toEqual([
			{ line: "hello", transient: false },
			{ line: "world", transient: false },
		]);
	});

	it("treats \\r\\n as a single non-transient boundary", () => {
		const split = makeLineSplitter();
		const out = split("hello\r\nworld\r\n");
		expect(out).toEqual([
			{ line: "hello", transient: false },
			{ line: "world", transient: false },
		]);
	});

	it("marks bare \\r-terminated frames as transient", () => {
		const split = makeLineSplitter();
		const out = split("frame1\rframe2\rfinal\n");
		expect(out).toEqual([
			{ line: "frame1", transient: true },
			{ line: "frame2", transient: true },
			{ line: "final", transient: false },
		]);
	});

	it("emits spinner sequence from winget as transient frames", () => {
		const split = makeLineSplitter();
		// winget prints a spinner char followed by \r several times/sec.
		const out = split("/\r-\r\\\r|\r");
		expect(out.map((o) => o.transient)).toEqual([true, true, true, true]);
		expect(out.map((o) => o.line)).toEqual(["/", "-", "\\", "|"]);
	});

	it("treats non-SGR CSI sequences (erase/cursor) as transient boundary", () => {
		const split = makeLineSplitter();
		// Line content, then CSI K (erase in line) — the flush should be transient.
		const out = split("progress 50%\x1b[Kprogress 60%\n");
		expect(out).toEqual([
			{ line: "progress 50%", transient: true },
			{ line: "progress 60%", transient: false },
		]);
	});

	it("preserves SGR colour codes inline", () => {
		const split = makeLineSplitter();
		const out = split("\x1b[31mred\x1b[0m\n");
		expect(out).toEqual([
			{ line: "\x1b[31mred\x1b[0m", transient: false },
		]);
	});

	it("buffers incomplete escape across chunks", () => {
		const split = makeLineSplitter();
		const a = split("abc\x1b");
		expect(a).toEqual([]);
		const b = split("[31mred\n");
		expect(b).toEqual([
			{ line: "abc\x1b[31mred", transient: false },
		]);
	});
});

describe("createNodePhaseExecutor", () => {
	it("rejects interactive commands when terminal input is disabled", async () => {
		const executor = createNodePhaseExecutor({ allowInteractive: false });
		const result = await executor.spawn("unused", [], { interactive: true });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("unavailable");
	});
});

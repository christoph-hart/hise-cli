import { describe, it, expect } from "vitest";
import { optimizeScript } from "./optimizer.js";
import { parseScript } from "./parser.js";

describe("optimizeScript", () => {
	it("merges consecutive same-verb builder commands into comma-chained line", () => {
		const script = parseScript(
			"/builder\nset Lead.Volume -6\nset Lead.Pan 0",
		);
		const optimized = optimizeScript(script);
		// /builder stays as-is, two set commands merged into one
		expect(optimized.lines).toHaveLength(2);
		expect(optimized.lines[0]!.content).toBe("/builder");
		expect(optimized.lines[1]!.content).toBe(
			"set Lead.Volume -6, Lead.Pan 0",
		);
	});

	it("does not merge mixed builder verbs", () => {
		const script = parseScript(
			"/builder\nadd SineSynth as \"Lead\"\nset Lead.Volume -6",
		);
		const optimized = optimizeScript(script);
		expect(optimized.lines.map((line) => line.content)).toEqual([
			"/builder",
			"add SineSynth as \"Lead\"",
			"set Lead.Volume -6",
		]);
	});

	it("uses initial mode for stdin-style batches", () => {
		const script = parseScript("set Lead.Volume -6\nset Lead.Pan 0");
		const optimized = optimizeScript(script, { initialMode: "builder" });
		expect(optimized.lines).toHaveLength(1);
		expect(optimized.lines[0]!.content).toBe("set Lead.Volume -6, Lead.Pan 0");
	});

	it("does not merge across mode switches", () => {
		const script = parseScript(
			"/builder\nadd SineSynth\n/script\nEngine.getSampleRate()",
		);
		const optimized = optimizeScript(script);
		expect(optimized.lines).toHaveLength(4);
	});

	it("does not merge across /expect", () => {
		const script = parseScript(
			"/builder\nadd SineSynth\n/expect get Master.Volume is -6\nadd SimpleGain",
		);
		const optimized = optimizeScript(script);
		// add SineSynth stays alone, /expect breaks batch, add SimpleGain alone
		expect(optimized.lines).toHaveLength(4);
	});

	it("does not merge across /wait", () => {
		const script = parseScript(
			"/builder\nadd SineSynth\n/wait 500ms\nadd SimpleGain",
		);
		const optimized = optimizeScript(script);
		expect(optimized.lines).toHaveLength(4);
	});

	it("breaks batch on cd command", () => {
		const script = parseScript(
			"/builder\nadd SineSynth\ncd SineSynth\nadd SimpleGain",
		);
		const optimized = optimizeScript(script);
		// add SineSynth alone, cd alone, add SimpleGain alone
		expect(optimized.lines).toHaveLength(4);
	});

	it("breaks batch on ls/pwd/reset", () => {
		const script = parseScript("/builder\nadd SineSynth\nls\nadd SimpleGain");
		const optimized = optimizeScript(script);
		expect(optimized.lines).toHaveLength(4);
	});

	it("preserves line number from first line in batch", () => {
		const script = parseScript(
			"# header\n/builder\nadd SineSynth\nadd SimpleGain",
		);
		const optimized = optimizeScript(script);
		const merged = optimized.lines[1]!;
		expect(merged.lineNumber).toBe(3); // line of "add SineSynth"
	});

	it("does not merge non-builder mode commands", () => {
		const script = parseScript(
			"/script\nEngine.getSampleRate()\nConsole.print(1)",
		);
		const optimized = optimizeScript(script);
		expect(optimized.lines).toHaveLength(3);
	});

	it("handles single builder command without merging", () => {
		const script = parseScript("/builder\nadd SineSynth");
		const optimized = optimizeScript(script);
		expect(optimized.lines).toHaveLength(2);
		expect(optimized.lines[1]!.content).toBe("add SineSynth");
	});

	it("handles empty script", () => {
		const script = parseScript("");
		const optimized = optimizeScript(script);
		expect(optimized.lines).toHaveLength(0);
	});

	it("resets mode tracking on /exit", () => {
		const script = parseScript(
			"/builder\nadd SineSynth\n/exit\nadd Something",
		);
		const optimized = optimizeScript(script);
		// After /exit we're back to root, "add Something" is not batchable
		expect(optimized.lines).toHaveLength(4);
	});
});

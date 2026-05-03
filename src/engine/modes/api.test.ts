import { describe, expect, it } from "vitest";
import { ApiMode } from "./api.js";
import type { ScriptingApi } from "../data.js";
import type { SessionContext } from "./mode.js";

function fixture(): ScriptingApi {
	return {
		version: "1.0",
		generated: "test",
		enrichedClasses: ["Console"],
		classes: {
			Console: {
				description: "Debug utility for HISEScript.",
				category: "namespace",
				obtainedVia: "global",
				llmRef: "Console (namespace)\n\nFull narrative for LLM.",
				commonMistakes: [
					{ wrong: "Console.prins(x)", right: "Console.print(x)", explanation: "Typo." },
				],
				methods: [
					{
						name: "print",
						returnType: "undefined",
						description: "Prints a value to the console.",
						parameters: [
							{ name: "x", type: "NotUndefined", description: "Value to print." },
						],
						examples: [
							{ title: "Basic", code: 'Console.print("hi");' },
						],
						callScope: "safe",
						crossReferences: ["Console.clear"],
						pitfalls: ["No output in exported plugins."],
						llmRef: "Console::print(NotUndefined x) -> undefined\n\nThread safety: SAFE",
					},
					{
						name: "clear",
						returnType: "undefined",
						description: "Clears the console.",
						parameters: [],
						examples: [],
					},
				],
			},
			Engine: {
				description: "Engine namespace.",
				category: "namespace",
				methods: [
					{
						name: "getSampleRate",
						returnType: "double",
						description: "Returns the sample rate.",
						parameters: [],
						examples: [],
					},
				],
			},
			AudioFile: {
				description: "Audio file slot.",
				category: "object",
				methods: [
					{
						// Unenriched: omits parameters and examples arrays entirely.
						name: "loadBuffer",
						returnType: "void",
						description: "Loads a buffer into the slot.",
					} as unknown as ScriptingApi["classes"]["AudioFile"]["methods"][0],
				],
			},
		},
	};
}

const session: SessionContext = {
	connection: null,
	popMode: () => ({ type: "text", content: "exit" }),
};

describe("ApiMode", () => {
	it("has identity", () => {
		const mode = new ApiMode(fixture());
		expect(mode.id).toBe("api");
		expect(mode.name).toBe("API");
		expect(mode.accent).toBe("#7dcfff");
		expect(mode.prompt).toBe("[api] > ");
	});

	it("renders index for empty input", async () => {
		const result = await new ApiMode(fixture()).parse("", session);
		expect(result.type).toBe("markdown");
		if (result.type !== "markdown") return;
		expect(result.content).toContain("HiseScript API");
		expect(result.content).toContain("Console");
		expect(result.content).toContain("Engine");
	});

	it("renders class view for class name", async () => {
		const result = await new ApiMode(fixture()).parse("Console", session);
		expect(result.type).toBe("markdown");
		if (result.type !== "markdown") return;
		expect(result.content).toContain("# Console");
		expect(result.content).toContain("Debug utility");
		expect(result.content).toContain("`print(x)`");
		expect(result.content).toContain("`clear()`");
		expect(result.content).not.toContain("```hisescript");
	});

	it("renders method view with examples and parameters", async () => {
		const result = await new ApiMode(fixture()).parse("Console.print()", session);
		expect(result.type).toBe("markdown");
		if (result.type !== "markdown") return;
		expect(result.content).toContain("# Console.print");
		expect(result.content).toContain("Console.print(x: NotUndefined) → undefined");
		expect(result.content).toContain("*safe*");
		expect(result.content).toContain("Prints a value");
		expect(result.content).toContain("**x** (`NotUndefined`) — Value to print.");
		expect(result.content).toContain("```hisescript");
		expect(result.content).toContain('Console.print("hi")');
		expect(result.content).toContain("## Pitfalls");
		expect(result.content).toContain("## See also");
		expect(result.content).toContain("`Console.clear`");
	});

	it("accepts method without trailing parens", async () => {
		const result = await new ApiMode(fixture()).parse("Console.print", session);
		expect(result.type).toBe("markdown");
		if (result.type !== "markdown") return;
		expect(result.content).toContain("# Console.print");
	});

	it("returns error with hint for unknown class", async () => {
		const result = await new ApiMode(fixture()).parse("consol", session);
		expect(result.type).toBe("error");
		if (result.type !== "error") return;
		expect(result.message).toContain("Unknown class");
		expect(result.detail).toContain("Console");
	});

	it("returns error listing methods for unknown method", async () => {
		const result = await new ApiMode(fixture()).parse("Console.bogus", session);
		expect(result.type).toBe("error");
		if (result.type !== "error") return;
		expect(result.message).toContain("Unknown method");
		expect(result.detail).toContain("clear");
		expect(result.detail).toContain("print");
	});

	it("reports unavailable when api missing", async () => {
		const result = await new ApiMode().parse("Console", session);
		expect(result.type).toBe("error");
		if (result.type !== "error") return;
		expect(result.message).toContain("unavailable");
	});

	it("completes class names by prefix", () => {
		const mode = new ApiMode(fixture());
		const result = mode.complete("Cons", 4);
		expect(result.items.map((i) => i.label)).toContain("Console");
		expect(result.items.map((i) => i.label)).not.toContain("Engine");
	});

	it("completes all classes for empty input", () => {
		const mode = new ApiMode(fixture());
		const result = mode.complete("", 0);
		const labels = result.items.map((i) => i.label);
		expect(labels).toContain("Console");
		expect(labels).toContain("Engine");
	});

	it("completes methods after dot", () => {
		const mode = new ApiMode(fixture());
		const result = mode.complete("Console.", 8);
		const labels = result.items.map((i) => i.label);
		expect(labels).toEqual(expect.arrayContaining(["clear()", "print(x)"]));
	});

	it("filters method completion by prefix", () => {
		const mode = new ApiMode(fixture());
		const result = mode.complete("Console.pr", 10);
		expect(result.items.map((i) => i.label)).toEqual(["print(x)"]);
	});

	it("renders unenriched method without crashing", async () => {
		const result = await new ApiMode(fixture()).parse("AudioFile.loadBuffer", session);
		expect(result.type).toBe("markdown");
		if (result.type !== "markdown") return;
		expect(result.content).toContain("# AudioFile.loadBuffer");
		expect(result.content).toContain("AudioFile.loadBuffer() → void");
		expect(result.content).toContain("Loads a buffer");
		expect(result.content).not.toContain("## Parameters");
		expect(result.content).not.toContain("## Examples");
	});

	it("forLlm renders class llmRef instead of description", async () => {
		const result = await new ApiMode(fixture(), { forLlm: true }).parse("Console", session);
		expect(result.type).toBe("markdown");
		if (result.type !== "markdown") return;
		expect(result.content).toContain("Full narrative for LLM");
		expect(result.content).not.toContain("> Debug utility for HISEScript.");
		expect(result.content).toContain("## Common mistakes");
		expect(result.content).toContain("Console.prins(x)");
	});

	it("forLlm renders method llmRef instead of description", async () => {
		const result = await new ApiMode(fixture(), { forLlm: true }).parse("Console.print", session);
		expect(result.type).toBe("markdown");
		if (result.type !== "markdown") return;
		expect(result.content).toContain("Thread safety: SAFE");
		expect(result.content).not.toContain("Prints a value to the console.");
	});

	it("TUI default keeps description, hides commonMistakes", async () => {
		const result = await new ApiMode(fixture()).parse("Console", session);
		expect(result.type).toBe("markdown");
		if (result.type !== "markdown") return;
		expect(result.content).toContain("> Debug utility for HISEScript.");
		expect(result.content).not.toContain("Full narrative for LLM");
		expect(result.content).not.toContain("## Common mistakes");
	});
});

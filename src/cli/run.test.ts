import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { executeCliCommand } from "./run.js";
import { createSession } from "../session-bootstrap.js";
import { MockHiseConnection } from "../engine/hise.js";
import type { DataLoader, ModuleList } from "../engine/data.js";
import { listCliCommands } from "./commands.js";

const ORIGINAL_STDIN = process.stdin;

function getCliCommands() {
	return listCliCommands(createSession({ connection: null }).session.allCommands());
}

afterEach(() => {
	vi.restoreAllMocks();
	Object.defineProperty(process, "stdin", { value: ORIGINAL_STDIN, configurable: true });
});

function mockObserverFetch() {
	return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
}

function createModuleList(): ModuleList {
	return {
		version: "test",
		categories: { modulation: "Modulation" },
		modules: [
			{
				id: "LFO",
				prettyName: "LFO",
				description: "Low-frequency oscillator",
				type: "Modulator",
				subtype: "TimeVariantModulator",
				category: ["modulation"],
				builderPath: "b.Modulators.LFO",
				hasChildren: false,
				hasFX: false,
				metadataType: "core",
				parameters: [],
				modulation: [],
				interfaces: [],
			},
		],
	};
}

function createDataLoader(moduleList = createModuleList()): DataLoader {
	return {
		async loadModuleList() {
			return moduleList;
		},
		async loadScriptingApi() {
			return { version: "test", generated: "now", enrichedClasses: [], classes: {} };
		},
		async loadScriptnodeList() {
			return {};
		},
		async loadWizardDefinitions(): Promise<import("../engine/wizard/types.js").WizardDefinition[]> {
			return [];
		},
		async loadComponentProperties() {
			return {};
		},
		async loadPreprocessorDefinitions() {
			return { preprocessors: {} };
		},
	};
}

function createDataLoaderWithWizard(): DataLoader {
	const base = createDataLoader();
	return {
		...base,
		async loadWizardDefinitions() {
			return [
				{
					id: "test_wizard",
					header: "Test Wizard",
					tabs: [
						{
							label: "Settings",
							fields: [
								{ id: "name", type: "text" as const, label: "Name", required: true },
								{ id: "format", type: "choice" as const, label: "Format", required: false, items: ["WAV", "AIFF"], defaultValue: "WAV" },
							],
						},
					],
					tasks: [{ id: "run", function: "runTest", type: "http" as const }],
					postActions: [],
					globalDefaults: {},
				},
			];
		},
	};
}

describe("executeCliCommand", () => {
	it("returns compact semantic JSON for script values", async () => {
		mockObserverFetch();
		const connection = new MockHiseConnection()
			.setProbeResult(true)
			.onPost("/api/repl", () => ({
				success: true,
				result: "ok",
				value: 234,
				logs: [],
				errors: [],
			}));

		const result = await executeCliCommand(
			["node", "hise-cli", "-script", "Console.print(234)"],
			getCliCommands(),
			createDataLoader(),
			connection,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload.ok).toBe(true);
			expect(result.payload).toEqual({ ok: true, value: 234 });
		}
	});

	it("serializes root slash commands through the same path", async () => {
		mockObserverFetch();
		const result = await executeCliCommand(
			["node", "hise-cli", "-modes"],
			getCliCommands(),
			createDataLoader(),
			new MockHiseConnection().setProbeResult(true),
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload.ok).toBe(true);
			expect(result.payload).toMatchObject({
				ok: true,
				result: {
					type: "table",
				},
			});
		}
	});

	it("uses the shared mock runtime for --mock one-shot execution", async () => {
		mockObserverFetch();
		const result = await executeCliCommand(
			["node", "hise-cli", "--mock", "-script", "Engine.getSampleRate()"],
			getCliCommands(),
			createDataLoader(),
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toEqual({ ok: true, value: 48000 });
		}
	});

	it("executes builder one-shot commands through the shared session path", async () => {
		mockObserverFetch();
		const conn = new MockHiseConnection().setProbeResult(true);
		// Register builder mock handlers so execution can proceed
		conn.onGet("/api/builder/tree", () => ({
			success: true,
			result: {
				id: "SynthChain", processorId: "Master Chain", prettyName: "Container",
				type: "SoundGenerator", subtype: "SoundGenerator", category: ["container"],
				hasChildren: true, hasFX: false, modulation: [], bypassed: false,
				colour: "#414141", children: [], midi: [], fx: [],
			},
			logs: [],
			errors: [],
		}));
		conn.onPost("/api/builder/apply", () => ({
			success: true,
			result: { scope: "root", groupName: "root", diff: [{ domain: "builder", action: "+", target: "LFO" }] },
			logs: ["Add LFO"],
			errors: [],
		}));
		const result = await executeCliCommand(
			["node", "hise-cli", "-builder", 'add LFO as "LFO"'],
			getCliCommands(),
			createDataLoader(),
			conn,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toMatchObject({
				ok: true,
				result: {
					type: "text",
					content: expect.stringContaining("Add LFO"),
				},
			});
			if ("result" in result.payload) {
				expect(result.payload.result).not.toHaveProperty("accent");
			}
		}
	});

	it("executes builder one-shot command from stdin", async () => {
		mockObserverFetch();
		const stdin = new PassThrough();
		Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
		stdin.end('add LFO as "LFO"');

		const conn = new MockHiseConnection().setProbeResult(true);
		conn.onGet("/api/builder/tree", () => ({
			success: true,
			result: {
				id: "SynthChain", processorId: "Master Chain", prettyName: "Container",
				type: "SoundGenerator", subtype: "SoundGenerator", category: ["container"],
				hasChildren: true, hasFX: false, modulation: [], bypassed: false,
				colour: "#414141", children: [], midi: [], fx: [],
			},
			logs: [],
			errors: [],
		}));
		conn.onPost("/api/builder/apply", () => ({
			success: true,
			result: { scope: "root", groupName: "root", diff: [{ domain: "builder", action: "+", target: "LFO" }] },
			logs: ["Add LFO"],
			errors: [],
		}));

		const result = await executeCliCommand(
			["node", "hise-cli", "-builder", "--stdin"],
			getCliCommands(),
			createDataLoader(),
			conn,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toMatchObject({
				ok: true,
				result: {
					type: "text",
					content: expect.stringContaining("Add LFO"),
				},
			});
		}
	});

	it("executes multiline builder stdin through the script runner", async () => {
		mockObserverFetch();
		const stdin = new PassThrough();
		Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
		stdin.end('add LFO as "LFO"\nadd LFO as "LFO2"');

		const conn = new MockHiseConnection().setProbeResult(true);
		conn.onGet("/api/builder/tree", () => ({
			success: true,
			result: {
				id: "SynthChain", processorId: "Master Chain", prettyName: "Container",
				type: "SoundGenerator", subtype: "SoundGenerator", category: ["container"],
				hasChildren: true, hasFX: false, modulation: [], bypassed: false,
				colour: "#414141", children: [], midi: [], fx: [],
			},
			logs: [],
			errors: [],
		}));
		conn.onPost("/api/builder/apply", () => ({
			success: true,
			result: { scope: "root", groupName: "root", diff: [
				{ domain: "builder", action: "+", target: "LFO" },
				{ domain: "builder", action: "+", target: "LFO2" },
			] },
			logs: ["Add LFO", "Add LFO2"],
			errors: [],
		}));

		const result = await executeCliCommand(
			["node", "hise-cli", "-builder", "--stdin", "--agent"],
			getCliCommands(),
			createDataLoader(),
			conn,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toMatchObject({
				ok: true,
				value: {
					linesExecuted: 1,
					summary: expect.stringContaining("1 commands"),
				},
			});
		}
		const applyCalls = conn.calls.filter((call) => call.endpoint === "/api/builder/apply");
		expect(applyCalls).toHaveLength(1);
	});

	it("returns structured builder tree output for agent calls", async () => {
		mockObserverFetch();
		const conn = new MockHiseConnection().setProbeResult(true);
		conn.onGet("/api/builder/tree", () => ({
			success: true,
			result: {
				id: "SynthChain", processorId: "Master Chain", prettyName: "Container",
				type: "SoundGenerator", subtype: "SoundGenerator", category: ["container"],
				hasChildren: true, hasFX: false, modulation: [], bypassed: false,
				colour: "#414141", children: [], midi: [], fx: [],
			},
			logs: [],
			errors: [],
		}));

		const result = await executeCliCommand(
			["node", "hise-cli", "-builder", "show", "tree", "--agent"],
			getCliCommands(),
			createDataLoader(),
			conn,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toEqual({ ok: true, value: { id: "Master Chain", type: "SynthChain" } });
		}
	});

	it("returns structured UI tree output for agent calls", async () => {
		mockObserverFetch();
		const conn = new MockHiseConnection().setProbeResult(true);
		conn.onGet("/api/ui/tree", () => ({
			success: true,
			result: {
				id: "Content",
				type: "Root",
				childComponents: [{ id: "Button1", type: "ScriptButton", childComponents: [] }],
			},
			logs: [],
			errors: [],
		}));

		const result = await executeCliCommand(
			["node", "hise-cli", "-ui", "show", "tree", "--agent"],
			getCliCommands(),
			createDataLoader(),
			conn,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toEqual({ ok: true, value: { id: "Content", type: "Root", childComponents: [{ id: "Button1", type: "ScriptButton" }] } });
		}
	});

	it("includes UI set value callback logs in agent output", async () => {
		mockObserverFetch();
		const conn = new MockHiseConnection().setProbeResult(true);
		conn.onPost("/api/set_component_value", () => ({
			success: true,
			result: "OK",
			logs: ["Button1: 1.0"],
			errors: [],
		}));
		conn.onGet("/api/ui/tree", () => ({
			success: true,
			result: { id: "Content", type: "Root", childComponents: [{ id: "Button1", type: "ScriptButton", childComponents: [] }] },
			logs: [],
			errors: [],
		}));

		const result = await executeCliCommand(
			["node", "hise-cli", "-ui", "set", "Button1.value", "1", "--agent"],
			getCliCommands(),
			createDataLoader(),
			conn,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toEqual({
				ok: true,
				result: { type: "text", content: "OK" },
				logs: ["Button1: 1.0"],
			});
		}
	});

	it("returns structured DSP tree output for separated multi-word target agent calls", async () => {
		mockObserverFetch();
		const conn = new MockHiseConnection().setProbeResult(true);
		conn.onGet("/api/dsp/tree", () => ({
			success: true,
			result: {
				nodeId: "root",
				factoryPath: "container.chain",
				bypassed: false,
				parameters: [],
				children: [{ nodeId: "gain1", factoryPath: "core.gain", bypassed: false, parameters: [], children: [] }],
			},
			logs: [],
			errors: [],
		}));

		const result = await executeCliCommand(
			["node", "hise-cli", "-dsp", "--target", "Script FX1", "show", "tree", "--agent"],
			getCliCommands(),
			createDataLoader(),
			conn,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toEqual({ ok: true, value: { nodeId: "root", factoryPath: "container.chain", bypassed: false, children: [{ nodeId: "gain1", factoryPath: "core.gain", bypassed: false }] } });
		}
		expect(conn.calls.some((call) => call.endpoint.includes("moduleId=Script%20FX1"))).toBe(true);
	});

	it("returns null DSP tree output for agent calls without a selected network", async () => {
		mockObserverFetch();
		const conn = new MockHiseConnection().setProbeResult(true);

		const result = await executeCliCommand(
			["node", "hise-cli", "-dsp", "show", "tree", "--agent"],
			getCliCommands(),
			createDataLoader(),
			conn,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toEqual({ ok: true, value: null });
		}
	});

	it("returns script logs without undefined value noise", async () => {
		mockObserverFetch();
		const connection = new MockHiseConnection()
			.setProbeResult(true)
			.onPost("/api/repl", () => ({
				success: true,
				result: "ok",
				value: "undefined",
				logs: ["2134"],
				errors: [],
			}));

		const result = await executeCliCommand(
			["node", "hise-cli", "-script", "Console.print(2134)"],
			getCliCommands(),
			createDataLoader(),
			connection,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toEqual({ ok: true, logs: ["2134"] });
		}
	});

	it("executes which queries without HISE", async () => {
		mockObserverFetch();
		const result = await executeCliCommand(
			["node", "hise-cli", "which", "edit onInit from file", "--agent", "--limit", "1"],
			getCliCommands(),
			createDataLoader(),
			new MockHiseConnection().setProbeResult(false),
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload.ok).toBe(true);
			expect((result.payload as { value: Array<{ id: string }> }).value[0]?.id).toBe("script.set.callback.file");
		}
	});

	it("executes mcp tool calls without HISE", async () => {
		const calls: Array<{ name?: string; args?: unknown }> = [];
		const result = await executeCliCommand(
			["node", "hise-cli", "mcp", "search_hise", "--query", "sampler", "--limit", "2", "--agent"],
			getCliCommands(),
			createDataLoader(),
			{
				connectionOverride: new MockHiseConnection().setProbeResult(false),
				mcpClient: {
					async call() { return {}; },
					async callTool(request) {
						calls.push({ name: request.name, args: request.arguments });
						return { content: [{ type: "text", text: "ok" }] };
					},
				},
			},
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toEqual({ ok: true, value: { content: [{ type: "text", text: "ok" }] } });
		}
		expect(calls).toEqual([{ name: "search_hise", args: { query: "sampler", limit: 2 } }]);
	});

	it("executes raw mcp methods with select", async () => {
		const result = await executeCliCommand(
			["node", "hise-cli", "mcp", "resources/read", "--uri", "hise://style-guides/hisescript-style", "--select", "value.contents[0].text"],
			getCliCommands(),
			createDataLoader(),
			{
				connectionOverride: new MockHiseConnection().setProbeResult(false),
				mcpClient: {
					async call(request) {
						expect(request).toEqual({ method: "resources/read", params: { uri: "hise://style-guides/hisescript-style" } });
						return { contents: [{ text: "# HiseScript" }] };
					},
					async callTool() { return {}; },
				},
			},
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toEqual({ ok: true, value: "# HiseScript" });
		}
	});

	it("executes mcp mode one-shots without HISE bootstrap", async () => {
		const result = await executeCliCommand(
			["node", "hise-cli", "-mcp", "explore_hise", "sampler", "--agent", "--select", "result.type"],
			getCliCommands(),
			createDataLoader(),
			{
				connectionOverride: new MockHiseConnection().setProbeResult(false),
				mcpClient: {
					async call() { return {}; },
					async callTool(request) {
						expect(request).toEqual({ name: "explore_hise", arguments: { query: "sampler" } });
						return { content: [{ type: "text", text: "# Sampler" }] };
					},
				},
			},
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toEqual({ ok: true, value: "markdown" });
		}
	});

	it("executes agent-context manifest queries without HISE", async () => {
		const result = await executeCliCommand(
			["node", "hise-cli", "agent-context", "--agent"],
			getCliCommands(),
			createDataLoader(),
			new MockHiseConnection().setProbeResult(false),
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload.ok).toBe(true);
			expect((result.payload as { value: { modes: Array<{ id: string }>; capabilities: Array<{ id: string; examples?: unknown }> } }).value.modes.some((mode) => mode.id === "script")).toBe(true);
			expect((result.payload as { value: { capabilities: Array<{ id: string; examples?: unknown }> } }).value.capabilities.find((capability) => capability.id === "script.compile")?.examples).toBeUndefined();
		}
	});

	it("executes scoped agent-context mode queries with select", async () => {
		const result = await executeCliCommand(
			["node", "hise-cli", "agent-context", "script", "--select", "value.id"],
			getCliCommands(),
			createDataLoader(),
			new MockHiseConnection().setProbeResult(false),
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toEqual({ ok: true, value: "script" });
		}
	});

	it("executes scoped agent-context capability queries with select", async () => {
		const result = await executeCliCommand(
			["node", "hise-cli", "agent-context", "--capability", "script.compile", "--select", "value.command.display"],
			getCliCommands(),
			createDataLoader(),
			new MockHiseConnection().setProbeResult(false),
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toEqual({ ok: true, value: "hise-cli script compile --module-id Interface --agent" });
		}
	});

	it("returns coded errors for unknown scoped agent-context queries", async () => {
		const result = await executeCliCommand(
			["node", "hise-cli", "agent-context", "nonesuch", "--agent"],
			getCliCommands(),
			createDataLoader(),
			new MockHiseConnection().setProbeResult(false),
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toEqual({
				ok: false,
				code: "usage_error",
				error: "Unknown agent-context mode: nonesuch",
			});
		}
	});

	it("flattens evaluation-failed script envelopes into a compact error payload", async () => {
		mockObserverFetch();
		const connection = new MockHiseConnection()
			.setProbeResult(true)
			.onPost("/api/repl", () => ({
				success: false,
				result: "Error at REPL Evaluation",
				value: "undefined",
				logs: [],
				errors: [{ errorMessage: "Component with name x wasn't found.", callstack: [] }],
			}));

		const result = await executeCliCommand(
			["node", "hise-cli", "-script", 'Content.getComponent("x")'],
			getCliCommands(),
			createDataLoader(),
			connection,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toEqual({
				ok: false,
				code: "hise_api_error",
				error: "Component with name x wasn't found.",
			});
		}
	});

	it("emits observer start and end events around command execution", async () => {
		const fetchSpy = mockObserverFetch();
		const connection = new MockHiseConnection()
			.setProbeResult(true)
			.onPost("/api/repl", () => ({
				success: true,
				result: "ok",
				value: 48000,
				logs: [],
				errors: [],
			}));

		await executeCliCommand(
			["node", "hise-cli", "-script", "Engine.getSampleRate()"],
			getCliCommands(),
			createDataLoader(),
			connection,
		);

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const startPayload = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
		const endPayload = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body));

		expect(startPayload).toMatchObject({
			type: "command.start",
			source: "llm",
			command: "/script Engine.getSampleRate()",
			mode: "script",
		});
		expect(endPayload).toMatchObject({
			type: "command.end",
			source: "llm",
			ok: true,
			result: {
				type: "markdown",
			},
		});
	});

	it("runs callback compiler scripts through set_script", async () => {
		mockObserverFetch();
		const connection = new MockHiseConnection()
			.setProbeResult(true)
			.onPost("/api/set_script", () => ({
				success: true,
				result: "Compiled OK",
				updatedCallbacks: ["onInit", "onNoteOn"],
				logs: ["init from cli"],
				errors: [],
			}));

		const result = await executeCliCommand(
			[
				"node",
				"hise-cli",
				"--run",
				"--inline",
				"/script\n/callback onInit\nContent.makeFrontInterface(600, 600);\n/callback onNoteOn\nConsole.print(Message.getNoteNumber());\n/compile",
				"--verbose",
			],
			getCliCommands(),
			createDataLoader(),
			connection,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload.ok).toBe(true);
			if ("logs" in result.payload && Array.isArray(result.payload.logs)) {
				expect(result.payload.logs.some((line) => line.startsWith("Entered script mode."))).toBe(false);
				expect(result.payload.logs).toContain("Compiled OK for Interface (onInit, onNoteOn).");
				expect(result.payload.logs).toContain("init from cli");
				expect(result.payload.logs.some((line) => line.startsWith("Collecting raw body for "))).toBe(false);
			} else {
				expect.fail("Expected CLI run payload to include logs");
			}
			expect(result.payload).toMatchObject({
				value: {
					ok: true,
					linesExecuted: 6,
				},
			});
		}
		expect(connection.calls.find((call) => call.endpoint === "/api/set_script")?.body).toEqual({
			moduleId: "Interface",
			compile: true,
			callbacks: {
				onInit: "Content.makeFrontInterface(600, 600);",
				onNoteOn: "function onNoteOn()\n{\n\tConsole.print(Message.getNoteNumber());\n}",
			},
		});
	});

	it("runs direct script repl from stdin", async () => {
		mockObserverFetch();
		const stdin = new PassThrough();
		Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
		stdin.end("Engine.getSampleRate()");

		const connection = new MockHiseConnection()
			.setProbeResult(true)
			.onPost("/api/repl", () => ({
				success: true,
				value: 48000,
				logs: [],
				errors: [],
			}));

		const result = await executeCliCommand(
			["node", "hise-cli", "script", "repl", "--stdin"],
			getCliCommands(),
			createDataLoader(),
			connection,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") expect(result.payload).toEqual({ ok: true, value: { value: 48000 } });
		expect(connection.calls.find((call) => call.endpoint === "/api/repl")?.body).toEqual({
			moduleId: "Interface",
			expression: "Engine.getSampleRate()",
		});
	});

	it("runs direct script get", async () => {
		mockObserverFetch();
		const connection = new MockHiseConnection()
			.setProbeResult(true)
			.onGet("/api/get_script?moduleId=Interface&callback=onInit", () => ({
				success: true,
				moduleId: "Interface",
				callbacks: { onInit: "Console.print(1);" },
				logs: [],
				errors: [],
			}));

		const result = await executeCliCommand(
			["node", "hise-cli", "script", "get", "--callback", "onInit"],
			getCliCommands(),
			createDataLoader(),
			connection,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toEqual({ ok: true, value: { moduleId: "Interface", callbacks: { onInit: "Console.print(1);" } } });
		}
	});

	it("runs direct script set from stdin", async () => {
		mockObserverFetch();
		const stdin = new PassThrough();
		Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
		stdin.end("Console.print(123);\n");

		const connection = new MockHiseConnection()
			.setProbeResult(true)
			.onPost("/api/set_script", () => ({
				success: true,
				result: "Compiled OK",
				updatedCallbacks: ["onInit"],
				logs: ["123"],
				errors: [],
			}));

		const result = await executeCliCommand(
			["node", "hise-cli", "script", "set", "--callback", "onInit", "--stdin"],
			getCliCommands(),
			createDataLoader(),
			connection,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toEqual({
				ok: true,
				value: { result: "Compiled OK", updatedCallbacks: ["onInit"] },
				logs: ["123"],
			});
		}
		expect(connection.calls.find((call) => call.endpoint === "/api/set_script")?.body).toEqual({
			moduleId: "Interface",
			callbacks: { onInit: "Console.print(123);" },
			compile: true,
		});
	});

	it("runs direct script compile", async () => {
		mockObserverFetch();
		const connection = new MockHiseConnection()
			.setProbeResult(true)
			.onPost("/api/recompile", () => ({
				success: true,
				result: "Recompiled OK",
				logs: [],
				errors: [],
			}));

		const result = await executeCliCommand(
			["node", "hise-cli", "script", "compile", "--module-id", "Interface"],
			getCliCommands(),
			createDataLoader(),
			connection,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") expect(result.payload).toEqual({ ok: true, value: { result: "Recompiled OK" } });
		expect(connection.calls.find((call) => call.endpoint === "/api/recompile")?.body).toEqual({ moduleId: "Interface" });
	});

	it("script diagnose returns validation_error for diagnostic errors", async () => {
		mockObserverFetch();
		const connection = new MockHiseConnection()
			.setProbeResult(true)
			.onPost("/api/diagnose_script", () => ({
				success: true,
				apiVersion: "0.6.1",
				moduleId: "Interface",
				filePath: "Scripts/UI.js",
				diagnostics: [{ line: 2, column: 4, severity: "error", source: "api-validation", message: "Function not found" }],
				logs: [],
				errors: [],
			}));

		const result = await executeCliCommand(
			["node", "hise-cli", "script", "diagnose", "--module-id", "Interface", "--file-path", "Scripts/UI.js", "--agent"],
			getCliCommands(),
			createDataLoader(),
			connection,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toEqual({
				ok: false,
				code: "validation_error",
				error: "Script diagnostics found errors",
				value: {
					apiVersion: "0.6.1",
					moduleId: "Interface",
					filePath: "Scripts/UI.js",
					diagnostics: [{ line: 2, column: 4, severity: "error", source: "api-validation", message: "Function not found" }],
				},
			});
		}
		expect(connection.calls.find((call) => call.endpoint === "/api/diagnose_script")?.body).toEqual({ moduleId: "Interface", filePath: "Scripts/UI.js", async: false });
	});

	it("script show tree passes filters to script tree endpoint", async () => {
		mockObserverFetch();
		const connection = new MockHiseConnection()
			.setProbeResult(true)
			.onGet("/api/script/tree", () => ({
				success: true,
				moduleId: "Interface",
				format: "flat",
				compact: true,
				totalMatches: 1,
				returned: 1,
				truncated: false,
				tree: [{ id: "Knob1", type: "const var", expression: "Components.Knob1", dataType: "ScriptSlider", children: [] }],
				logs: [],
				errors: [],
			}));

		const result = await executeCliCommand(
			["node", "hise-cli", "script", "show", "tree", "Knob", "--symbols-only", "--format", "flat", "--limit", "20", "--agent"],
			getCliCommands(),
			createDataLoader(),
			connection,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") expect(result.payload).toMatchObject({ ok: true, value: { moduleId: "Interface", compact: true } });
		expect(connection.calls.find((call) => call.endpoint.startsWith("/api/script/tree"))?.endpoint).toBe("/api/script/tree?moduleId=Interface&search=Knob&format=flat&compact=true&limit=20");
	});

	it("script show symbol enriches API methods", async () => {
		mockObserverFetch();
		const connection = new MockHiseConnection()
			.setProbeResult(true)
			.onGet("/api/script/tree", () => ({
				success: true,
				moduleId: "Interface",
				namespace: "Components.Knob1",
				format: "tree",
				compact: false,
				totalMatches: 1,
				returned: 1,
				truncated: false,
				tree: [{ id: "Knob1", type: "const var", expression: "Components.Knob1", dataType: "ScriptSlider", value: "0.0", children: [] }],
				logs: [],
				errors: [],
			}));
		const dataLoader = createDataLoader();
		dataLoader.loadScriptingApi = async () => ({
			version: "test",
			generated: "now",
			enrichedClasses: [],
			classes: { ScriptSlider: { description: "Slider component", category: "component", methods: [{ name: "set", returnType: "undefined", description: "Set property", parameters: [] }] } },
		});

		const result = await executeCliCommand(
			["node", "hise-cli", "script", "show", "Components.Knob1", "--agent"],
			getCliCommands(),
			dataLoader,
			connection,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") expect(result.payload).toMatchObject({ ok: true, value: { api: { class: "ScriptSlider", methods: ["ScriptSlider.set"] } } });
	});

	it("classifies direct HISE API envelope failures", async () => {
		mockObserverFetch();
		const connection = new MockHiseConnection()
			.setProbeResult(true)
			.onPost("/api/recompile", () => ({
				success: false,
				result: "Compile failed",
				logs: [],
				errors: [],
			}));

		const result = await executeCliCommand(
			["node", "hise-cli", "script", "compile", "--agent"],
			getCliCommands(),
			createDataLoader(),
			connection,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toEqual({ ok: false, code: "hise_api_error", error: "Compile failed" });
		}
	});

	it("classifies direct transport failures", async () => {
		mockObserverFetch();
		const connection = new MockHiseConnection()
			.setProbeResult(true)
			.onPost("/api/recompile", () => ({ error: true, message: "POST /api/recompile: TypeError: fetch failed" }));

		const result = await executeCliCommand(
			["node", "hise-cli", "script", "compile", "--agent"],
			getCliCommands(),
			createDataLoader(),
			connection,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload).toMatchObject({ ok: false, code: "hise_unavailable" });
		}
	});
});

describe("-wizard mode flag", () => {
	it("lists wizards via -wizard list", async () => {
		mockObserverFetch();
		const result = await executeCliCommand(
			["node", "hise-cli", "-wizard", "list"],
			getCliCommands(),
			createDataLoaderWithWizard(),
			new MockHiseConnection().setProbeResult(true),
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload.ok).toBe(true);
			expect(result.payload).toMatchObject({
				ok: true,
				result: { type: "table" },
			});
		}
	});

	it("returns merged defaults via -wizard get <id>", async () => {
		mockObserverFetch();
		const result = await executeCliCommand(
			["node", "hise-cli", "-wizard", "get", "test_wizard"],
			getCliCommands(),
			createDataLoaderWithWizard(),
			new MockHiseConnection().setProbeResult(true),
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload.ok).toBe(true);
			if ("result" in result.payload) {
				expect(result.payload.result.type).toBe("table");
				const table = result.payload.result as { headers: string[]; rows: string[][] };
				expect(table.headers).toEqual(["Field", "Type", "Default", "Required"]);
				expect(table.rows.find((r) => r[0] === "format")?.[2]).toBe("WAV");
			}
		}
	});

	it("executes wizard via -wizard run <id> with K=V", async () => {
		mockObserverFetch();
		const conn = new MockHiseConnection().setProbeResult(true);
		conn.onPost("/api/wizard/execute", () => ({
			success: true,
			result: "Test Wizard completed successfully.",
			logs: [],
			errors: [],
		}));

		const result = await executeCliCommand(
			["node", "hise-cli", "-wizard", "run", "test_wizard", "with", "name=MyProject,", "format=WAV"],
			getCliCommands(),
			createDataLoaderWithWizard(),
			conn,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload.ok).toBe(true);
			if ("result" in result.payload) {
				expect(result.payload.result.type).toBe("markdown");
			}
		}
	});

	it("returns error for unknown wizard with run", async () => {
		mockObserverFetch();
		const result = await executeCliCommand(
			["node", "hise-cli", "-wizard", "run", "nonexistent"],
			getCliCommands(),
			createDataLoaderWithWizard(),
			new MockHiseConnection().setProbeResult(true),
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload.ok).toBe(false);
		}
	});
});

describe("--run path resolution", () => {
	it("aborts when path is bare-relative and HISE is not running", async () => {
		mockObserverFetch();
		// No /api/status handler → fetchProjectInfo leaves projectFolder null.
		const conn = new MockHiseConnection().setProbeResult(false);

		const result = await executeCliCommand(
			["node", "hise-cli", "--run", "script.hsc"],
			getCliCommands(),
			createDataLoader(),
			conn,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload.ok).toBe(false);
			expect(result.payload).toMatchObject({
				ok: false,
				code: "hise_unavailable",
				error: expect.stringContaining("HISE is not running"),
			});
		}
	});

	it("attempts CWD-relative read for explicit ./ path even with HISE closed", async () => {
		mockObserverFetch();
		const conn = new MockHiseConnection().setProbeResult(false);

		const result = await executeCliCommand(
			["node", "hise-cli", "--run", "./does-not-exist.hsc"],
			getCliCommands(),
			createDataLoader(),
			conn,
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload.ok).toBe(false);
			// Reaches readFile and reports a load error — not the abort message.
			expect(result.payload).toMatchObject({
				ok: false,
				code: "execution_error",
				error: expect.stringContaining("Failed to load script"),
			});
			if ("error" in result.payload) {
				expect(result.payload.error).not.toContain("HISE is not running");
			}
		}
	});

	it("does not abort when --mock supplies a project folder", async () => {
		mockObserverFetch();
		// No connectionOverride → createDefaultMockRuntime() sets projectFolder to /mock/project.
		const result = await executeCliCommand(
			["node", "hise-cli", "--run", "missing.hsc", "--mock"],
			getCliCommands(),
			createDataLoader(),
		);

		expect(result.kind).toBe("json");
		if (result.kind === "json") {
			expect(result.payload.ok).toBe(false);
			if ("error" in result.payload) {
				expect(result.payload.code).toBe("execution_error");
				expect(result.payload.error).not.toContain("HISE is not running");
				expect(result.payload.error).toContain("Failed to load script");
			}
		}
	});
});

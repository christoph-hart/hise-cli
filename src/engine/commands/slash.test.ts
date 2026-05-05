import { describe, expect, it } from "vitest";
import { CommandRegistry, type CommandSession } from "./registry.js";
import { registerBuiltinCommands, parseWithClause } from "./slash.js";
import type { CommandResult } from "../result.js";
import { textResult } from "../result.js";
import { MockHiseConnection } from "../hise.js";
import { ScriptMode } from "../modes/script.js";

function createMockSession(): CommandSession & { modes: string[]; quitRequested: boolean } {
	const modes: string[] = [];
	let quitRequested = false;
	let connection: MockHiseConnection | null = null;
	const modeCache = new Map<string, import("../modes/mode.js").Mode>();
	const compilerState = new Map<string, { activeCallback: string | null; callbacks: Map<string, string[]> }>();
	
	return {
		modes,
		projectName: null as string | null,
		projectFolder: null as string | null,
		cwd: null as string | null,
		get connection() {
			return connection;
		},
		set connection(value: MockHiseConnection | null) {
			connection = value;
		},
		get quitRequested() { return quitRequested; },
		get modeStackDepth() {
			return modes.length;
		},
		get currentModeId() {
			return modes.length > 0 ? modes[modes.length - 1] : "root";
		},
		allCommands() {
			return [];
		},
		pushMode(modeId: string) {
			modes.push(modeId);
			return null;
		},
		popMode(silent?: boolean) {
			if (modes.length === 0) {
				return textResult("Already at root.");
			}
			modes.pop();
			if (silent) {
				return { type: "empty" };
			}
			return textResult("Exited mode.");
		},
		requestQuit() {
			quitRequested = true;
		},
		getOrCreateMode(modeId: string) {
			let mode = modeCache.get(modeId);
			if (!mode) {
				// Create a stub mode
				mode = {
					id: modeId as import("../modes/mode.js").ModeId,
					name: modeId,
					accent: "#ffffff",
					prompt: "> ",
					async parse() {
						return textResult(`Parsed in ${modeId}`);
					},
					setContext(_path: string) {
						// Stub
					},
				};
				modeCache.set(modeId, mode);
			}
			return mode;
		},
		async executeOneShot(modeId: string, input: string) {
			const mode = this.getOrCreateMode(modeId);
			modes.push(modeId);
			const result = await mode.parse(input, this as any);
			modes.pop();
			return result;
		},
		resolvePath(fp: string) { return fp; },
		resolveScriptPath(fp: string) { return fp; },
		clearScriptCompilerState(processorId: string) {
			compilerState.set(processorId, { activeCallback: null, callbacks: new Map() });
		},
		clearAllScriptCompilerState() {
			compilerState.clear();
		},
		setActiveScriptCallback(processorId: string, callbackId: string) {
			let state = compilerState.get(processorId);
			if (!state) {
				state = { activeCallback: null, callbacks: new Map() };
				compilerState.set(processorId, state);
			}
			state.activeCallback = callbackId;
			state.callbacks.set(callbackId, []);
		},
		appendScriptCallbackLine(processorId: string, line: string) {
			const state = compilerState.get(processorId);
			if (!state?.activeCallback) return false;
			const lines = state.callbacks.get(state.activeCallback) ?? [];
			lines.push(line);
			state.callbacks.set(state.activeCallback, lines);
			return true;
		},
		getActiveScriptCallback(processorId: string) {
			return compilerState.get(processorId)?.activeCallback ?? null;
		},
		getCollectedScriptCallbacks(processorId: string) {
			const state = compilerState.get(processorId);
			if (!state) return {};
			return Object.fromEntries(
				[...state.callbacks.entries()].map(([callbackId, lines]) => [callbackId, lines.join("\n")]),
			);
		},
		wizardRegistry: null,
		handlerRegistry: null,
	};
}

function createRegistry(): CommandRegistry {
	const registry = new CommandRegistry();
	registerBuiltinCommands(registry);
	return registry;
}

describe("built-in slash commands", () => {
	it("registers all expected commands", () => {
		const registry = createRegistry();
		const names = registry.names();

		expect(names).toContain("exit");
		expect(names).toContain("help");
		expect(names).toContain("modes");
		expect(names).toContain("builder");
		expect(names).toContain("script");
		expect(names).toContain("dsp");
		expect(names).toContain("sampler");
		expect(names).toContain("inspect");
		expect(names).toContain("project");
		expect(names).toContain("export");
		expect(names).toContain("compile");
	});

	it("/help returns markdown", async () => {
		const registry = createRegistry();
		const session = createMockSession();
		const result = await registry.dispatch("/help", session);
		expect(result.type).toBe("markdown");
		if (result.type === "markdown") {
			expect(result.content.length).toBeGreaterThan(0);
		}
	});

	it("/modes returns table", async () => {
		const registry = createRegistry();
		const session = createMockSession();
		const result = await registry.dispatch("/modes", session);
		expect(result.type).toBe("table");
		if (result.type === "table") {
			expect(result.headers).toContain("Mode");
			expect(result.rows.length).toBeGreaterThan(0);
		}
	});

	it("/exit pops mode", async () => {
		const registry = createRegistry();
		const session = createMockSession();
		session.modes.push("builder");

		const result = await registry.dispatch("/exit", session);
		expect(result.type).toBe("text");
		expect(session.modes).toHaveLength(0);
	});

	it("/exit at root returns message", async () => {
		const registry = createRegistry();
		const session = createMockSession();
		const result = await registry.dispatch("/exit", session);
		expect(result.type).toBe("text");
		if (result.type === "text") {
			expect(result.content).toContain("root");
		}
	});

	it("/builder pushes builder mode", async () => {
		const registry = createRegistry();
		const session = createMockSession();
		const result = await registry.dispatch("/builder", session);
		expect(result.type).toBe("text");
		expect(session.modes).toContain("builder");
	});

	it("/script pushes script mode", async () => {
		const registry = createRegistry();
		const session = createMockSession();
		const result = await registry.dispatch("/script", session);
		expect(session.modes).toContain("script");
	});

	it("/script.MyProcessor enters script mode with context", async () => {
		const registry = createRegistry();
		const session = createMockSession();
		session.getOrCreateMode = (modeId: string) => {
			let mode = (session as any).__modeCache?.get(modeId);
			if (!mode) {
				mode = modeId === "script"
					? new ScriptMode()
					: {
						id: modeId as import("../modes/mode.js").ModeId,
						name: modeId,
						accent: "#ffffff",
						prompt: "> ",
						async parse() {
							return textResult(`Parsed in ${modeId}`);
						},
					};
				(session as any).__modeCache ??= new Map();
				(session as any).__modeCache.set(modeId, mode);
			}
			return mode;
		};
		await registry.dispatch("/script.MyProcessor", session);
		expect(session.modes).toContain("script");
		expect((session.getOrCreateMode("script") as ScriptMode).processorId).toBe("MyProcessor");
	});

	it("/callback activates callback collection in script mode", async () => {
		const registry = createRegistry();
		const session = createMockSession();
		(session as any).connection = new MockHiseConnection();
		session.modes.push("script");
		session.getOrCreateMode = () => new ScriptMode();

		const result = await registry.dispatch("/callback onInit", session);

		expect(result.type).toBe("text");
		expect(session.getActiveScriptCallback!("Interface")).toBe("onInit");
	});

	it("/compile sends collected callbacks via set_script in script mode", async () => {
		const registry = createRegistry();
		const session = createMockSession();
		const connection = new MockHiseConnection()
			.onPost("/api/set_script", () => ({
				success: true,
				result: "Compiled OK",
				updatedCallbacks: ["onInit", "onNoteOn"],
				logs: [],
				errors: [],
			}));
		(session as any).connection = connection;
		session.modes.push("script");
		const scriptMode = new ScriptMode();
		session.getOrCreateMode = () => scriptMode;
		session.setActiveScriptCallback!("Interface", "onInit");
		session.appendScriptCallbackLine!("Interface", "Content.makeFrontInterface(600, 600);");
		session.setActiveScriptCallback!("Interface", "onNoteOn");
		session.appendScriptCallbackLine!("Interface", "Console.print(Message.getNoteNumber());");

		const result = await registry.dispatch("/compile", session);

		expect(result.type).toBe("text");
		expect(connection.calls[0]).toMatchObject({ method: "POST", endpoint: "/api/set_script" });
		expect(connection.calls[0]?.body).toEqual({
			moduleId: "Interface",
			compile: true,
			callbacks: {
				onInit: "Content.makeFrontInterface(600, 600);",
				onNoteOn: "function onNoteOn()\n{\n\tConsole.print(Message.getNoteNumber());\n}",
			},
		});
		expect(session.getCollectedScriptCallbacks!("Interface")).toEqual({});
	});

	it("/inspect pushes inspect mode", async () => {
		const registry = createRegistry();
		const session = createMockSession();
		await registry.dispatch("/inspect", session);
		expect(session.modes).toContain("inspect");
	});

	it("/project pushes project mode", async () => {
		const registry = createRegistry();
		const session = createMockSession();
		await registry.dispatch("/project", session);
		expect(session.modes).toContain("project");
	});

	it("/quit sets quitRequested regardless of mode stack", async () => {
		const registry = createRegistry();
		const session = createMockSession();
		session.modes.push("builder");
		session.modes.push("script");

		const result = await registry.dispatch("/quit", session);
		expect(result.type).toBe("text");
		if (result.type === "text") {
			expect(result.content).toContain("Goodbye");
		}
		// Mode stack is untouched — quit doesn't pop modes
		expect(session.modes).toHaveLength(2);
		expect(session.quitRequested).toBe(true);
	});

	it("/quit at root also sets quitRequested", async () => {
		const registry = createRegistry();
		const session = createMockSession();

		await registry.dispatch("/quit", session);
		expect(session.quitRequested).toBe(true);
	});

});

// ── Phase 3.5.3: One-shot execution + context entry ─────────────────

describe("mode handler one-shot execution", () => {
	it("/builder.SineGenerator enters builder with context", async () => {
		const registry = createRegistry();
		const session = createMockSession();
		
		await registry.dispatch("/builder.SineGenerator", session);
		expect(session.modes).toContain("builder");
		// Context verification would need builder mode inspection (deferred to integration)
	});

	it("/builder add SimpleGain executes one-shot and stays in root", async () => {
		const registry = createRegistry();
		const session = createMockSession();
		
		const result = await registry.dispatch("/builder add SimpleGain", session);
		// Should execute the command
		expect(result.type).not.toBe("error");
		// Should remain in root mode (not enter builder)
		expect(session.modes).toHaveLength(0);
	});

	it("/builder.SineGenerator.pitch add LFO one-shot with context", async () => {
		const registry = createRegistry();
		const session = createMockSession();
		
		await registry.dispatch("/builder.SineGenerator.pitch add LFO", session);
		// Should execute and return to root
		expect(session.modes).toHaveLength(0);
	});

	it("one-shot execution preserves mode state in cache", async () => {
		const registry = createRegistry();
		const session = createMockSession();
		
		// First one-shot
		await registry.dispatch("/builder add SimpleGain", session);
		expect(session.modes).toHaveLength(0);
		
		// Second one-shot should reuse cached instance
		await registry.dispatch("/builder add Synthesiser", session);
		expect(session.modes).toHaveLength(0);
	});

	it("/builder without args enters mode (existing behavior)", async () => {
		const registry = createRegistry();
		const session = createMockSession();

		await registry.dispatch("/builder", session);
		expect(session.modes).toContain("builder");
	});

	describe("/resume", () => {
		it("errors when no wizard is paused", async () => {
			const registry = createRegistry();
			const session = createMockSession();
			const result = await registry.dispatch("/resume", session);
			expect(result.type).toBe("error");
			if (result.type === "error") {
				expect(result.message).toContain("No paused wizard");
			}
		});

		it("resumes from nextTaskIndex and clears pending on success", async () => {
			const { WizardRegistry } = await import("../wizard/registry.js");
			const { WizardHandlerRegistry } = await import("../wizard/handler-registry.js");

			const calls: string[] = [];
			const handlerRegistry = new WizardHandlerRegistry();
			handlerRegistry.registerTask("one", async () => {
				calls.push("one");
				return { success: true, message: "ok" };
			});
			handlerRegistry.registerTask("two", async () => {
				calls.push("two");
				return { success: true, message: "ok" };
			});

			const wizardRegistry = WizardRegistry.fromDefinitions([{
				id: "demo",
				header: "Demo",
				tabs: [],
				tasks: [
					{ id: "t1", function: "one", type: "internal" },
					{ id: "t2", function: "two", type: "internal" },
				],
				postActions: [],
				globalDefaults: {},
			}]);

			const registry = createRegistry();
			const session = createMockSession() as unknown as CommandSession & { pendingWizard: unknown };
			(session as any).wizardRegistry = wizardRegistry;
			(session as any).handlerRegistry = handlerRegistry;
			(session as any).pendingWizard = {
				wizardId: "demo",
				answers: {},
				nextTaskIndex: 1,
				failedTaskLabel: "two",
			};
			(session as any).setPendingWizard = (p: unknown) => { (session as any).pendingWizard = p; };
			(session as any).clearPendingWizard = () => { (session as any).pendingWizard = null; };
			// onWizardProgress set → simulates CLI surface (inline exec path).
			(session as any).onWizardProgress = () => {};

			const result = await registry.dispatch("/resume", session);
			expect(result.type).toBe("markdown");
			expect(calls).toEqual(["two"]);
			expect((session as any).pendingWizard).toBeNull();
		});

		it("re-stashes pending on repeated failure", async () => {
			const { WizardRegistry } = await import("../wizard/registry.js");
			const { WizardHandlerRegistry } = await import("../wizard/handler-registry.js");

			const handlerRegistry = new WizardHandlerRegistry();
			handlerRegistry.registerTask("boom", async () => ({ success: false, message: "still broken" }));

			const wizardRegistry = WizardRegistry.fromDefinitions([{
				id: "demo",
				header: "Demo",
				tabs: [],
				tasks: [
					{ id: "t1", function: "boom", type: "internal" },
					{ id: "t2", function: "boom", type: "internal" },
				],
				postActions: [],
				globalDefaults: {},
			}]);

			const registry = createRegistry();
			const session = createMockSession() as unknown as CommandSession;
			(session as any).wizardRegistry = wizardRegistry;
			(session as any).handlerRegistry = handlerRegistry;
			(session as any).pendingWizard = {
				wizardId: "demo",
				answers: {},
				nextTaskIndex: 1,
				failedTaskLabel: "t2",
			};
			(session as any).setPendingWizard = (p: unknown) => { (session as any).pendingWizard = p; };
			(session as any).clearPendingWizard = () => { (session as any).pendingWizard = null; };
			(session as any).onWizardProgress = () => {};

			const result = await registry.dispatch("/resume", session);
			expect(result.type).toBe("error");
			expect((session as any).pendingWizard).not.toBeNull();
			expect((session as any).pendingWizard.nextTaskIndex).toBe(1);
		});

		it("errors and clears when the pending wizard id is unregistered", async () => {
			const { WizardRegistry } = await import("../wizard/registry.js");
			const wizardRegistry = new WizardRegistry();

			const registry = createRegistry();
			const session = createMockSession() as unknown as CommandSession;
			(session as any).wizardRegistry = wizardRegistry;
			(session as any).pendingWizard = {
				wizardId: "ghost",
				answers: {},
				nextTaskIndex: 0,
				failedTaskLabel: "t1",
			};
			(session as any).clearPendingWizard = () => { (session as any).pendingWizard = null; };

			const result = await registry.dispatch("/resume", session);
			expect(result.type).toBe("error");
			expect((session as any).pendingWizard).toBeNull();
		});
	});
});

describe("parseWithClause", () => {
	it("parses single Key=Value", () => {
		const r = parseWithClause("Format=VST3");
		expect("error" in r).toBe(false);
		if (!("error" in r)) {
			expect(r.prefill).toEqual({ Format: "VST3" });
		}
	});

	it("parses multiple comma-separated pairs", () => {
		const r = parseWithClause("Format=VST3, ExportType=Plugin");
		expect("error" in r).toBe(false);
		if (!("error" in r)) {
			expect(r.prefill).toEqual({ Format: "VST3", ExportType: "Plugin" });
		}
	});

	it("strips double-quoted values with embedded spaces", () => {
		const r = parseWithClause('Path="/some path/with spaces"');
		expect("error" in r).toBe(false);
		if (!("error" in r)) {
			expect(r.prefill).toEqual({ Path: "/some path/with spaces" });
		}
	});

	it("preserves commas inside quoted values", () => {
		const r = parseWithClause('Tags="a,b,c", Mode=Release');
		expect("error" in r).toBe(false);
		if (!("error" in r)) {
			expect(r.prefill).toEqual({ Tags: "a,b,c", Mode: "Release" });
		}
	});

	it("errors on token without =", () => {
		const r = parseWithClause("badtoken");
		expect("error" in r).toBe(true);
		if ("error" in r) expect(r.error).toContain("Malformed override");
	});

	it("errors on empty key", () => {
		const r = parseWithClause("=value");
		expect("error" in r).toBe(true);
	});

	it("errors on unterminated quote", () => {
		const r = parseWithClause('Path="oops');
		expect("error" in r).toBe(true);
		if ("error" in r) expect(r.error).toContain("Unterminated");
	});
});

describe("/wizard subcommands", () => {
	async function buildSession(opts: { withInit?: boolean; failingTask?: boolean } = {}) {
		const { WizardRegistry } = await import("../wizard/registry.js");
		const { WizardHandlerRegistry } = await import("../wizard/handler-registry.js");

		const taskCalls: Array<{ name: string; answers: Record<string, unknown> }> = [];
		const handlerRegistry = new WizardHandlerRegistry();
		handlerRegistry.registerTask("ok", async (answers) => {
			taskCalls.push({ name: "ok", answers: { ...answers } });
			return { success: true, message: "done" };
		});
		if (opts.failingTask) {
			handlerRegistry.registerTask("boom", async () => ({ success: false, message: "oops" }));
		}
		if (opts.withInit) {
			handlerRegistry.registerInit("seed", async () => ({ Format: "VST3" }));
		}

		const def: any = {
			id: "demo",
			header: "Demo",
			tabs: [{
				id: "main",
				label: "Main",
				fields: [
					{ id: "Format", type: "text", label: "Format", required: false, defaultValue: "VST2" },
					{ id: "ExportType", type: "text", label: "Export", required: false, defaultValue: "Plugin" },
				],
			}],
			tasks: [{ id: "t1", function: opts.failingTask ? "boom" : "ok", type: "internal" }],
			postActions: [],
			globalDefaults: {},
		};
		if (opts.withInit) {
			def.init = { type: "internal", function: "seed" };
		}

		const wizardRegistry = WizardRegistry.fromDefinitions([def]);

		const session = createMockSession() as unknown as CommandSession;
		(session as any).wizardRegistry = wizardRegistry;
		(session as any).handlerRegistry = handlerRegistry;
		(session as any).setPendingWizard = (p: unknown) => { (session as any).pendingWizard = p; };
		(session as any).clearPendingWizard = () => { (session as any).pendingWizard = null; };
		(session as any).setActiveWizard = (header: string, abort: AbortController) => {
			(session as any).activeWizard = header;
			(session as any).activeWizardAbort = abort;
		};
		(session as any).clearActiveWizard = () => {
			(session as any).activeWizard = null;
			(session as any).activeWizardAbort = null;
		};
		return { session, taskCalls };
	}

	it("/wizard list returns table of registered wizards", async () => {
		const registry = createRegistry();
		const { session } = await buildSession();
		const result = await registry.dispatch("/wizard list", session);
		expect(result.type).toBe("table");
		if (result.type === "table") {
			expect(result.rows.some((r: string[]) => r[0] === "demo")).toBe(true);
		}
	});

	it("/wizard get returns merged defaults table", async () => {
		const registry = createRegistry();
		const { session } = await buildSession();
		const result = await registry.dispatch("/wizard get demo", session);
		expect(result.type).toBe("table");
		if (result.type === "table") {
			expect(result.headers).toEqual(["Field", "Type", "Default", "Required"]);
			const formatRow = result.rows.find((r: string[]) => r[0] === "Format");
			expect(formatRow?.[2]).toBe("VST2");
		}
	});

	it("/wizard get applies init defaults on top of field defaults", async () => {
		const registry = createRegistry();
		const { session } = await buildSession({ withInit: true });
		const result = await registry.dispatch("/wizard get demo", session);
		expect(result.type).toBe("table");
		if (result.type === "table") {
			const formatRow = result.rows.find((r: string[]) => r[0] === "Format");
			expect(formatRow?.[2]).toBe("VST3");
		}
	});

	it("/wizard run executes with default values", async () => {
		const registry = createRegistry();
		const { session, taskCalls } = await buildSession();
		const result = await registry.dispatch("/wizard run demo", session);
		expect(result.type).toBe("markdown");
		expect(taskCalls).toHaveLength(1);
		expect(taskCalls[0]!.answers.Format).toBe("VST2");
	});

	it("/wizard run with K=V applies override", async () => {
		const registry = createRegistry();
		const { session, taskCalls } = await buildSession();
		const result = await registry.dispatch("/wizard run demo with Format=VST3", session);
		expect(result.type).toBe("markdown");
		expect(taskCalls[0]!.answers.Format).toBe("VST3");
		expect(taskCalls[0]!.answers.ExportType).toBe("Plugin");
	});

	it("/wizard run with multiple overrides", async () => {
		const registry = createRegistry();
		const { session, taskCalls } = await buildSession();
		const result = await registry.dispatch(
			"/wizard run demo with Format=VST3, ExportType=Effect",
			session,
		);
		expect(result.type).toBe("markdown");
		expect(taskCalls[0]!.answers.Format).toBe("VST3");
		expect(taskCalls[0]!.answers.ExportType).toBe("Effect");
	});

	it("/wizard run with quoted value containing spaces", async () => {
		const registry = createRegistry();
		const { session, taskCalls } = await buildSession();
		const result = await registry.dispatch(
			'/wizard run demo with Format="some name", ExportType=Plugin',
			session,
		);
		expect(result.type).toBe("markdown");
		expect(taskCalls[0]!.answers.Format).toBe("some name");
	});

	it("/wizard run unknown_id returns unknown-wizard error", async () => {
		const registry = createRegistry();
		const { session } = await buildSession();
		const result = await registry.dispatch("/wizard run unknown_id", session);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.message).toContain("Unknown wizard");
	});

	it("/wizard run with malformed override returns error", async () => {
		const registry = createRegistry();
		const { session } = await buildSession();
		const result = await registry.dispatch("/wizard run demo with badtoken", session);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.message).toContain("Malformed override");
	});

	it("/wizard run on failing task stashes pendingWizard", async () => {
		const registry = createRegistry();
		const { session } = await buildSession({ failingTask: true });
		const result = await registry.dispatch("/wizard run demo", session);
		expect(result.type).toBe("error");
		expect((session as any).pendingWizard?.wizardId).toBe("demo");
	});

	it("/wizard get without id returns usage error", async () => {
		const registry = createRegistry();
		const { session } = await buildSession();
		const result = await registry.dispatch("/wizard get", session);
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.message).toContain("Usage");
	});

	it("/wizard run sets and clears session.activeWizard around execution", async () => {
		const registry = createRegistry();
		const { session } = await buildSession();
		// Spy via a slow-ish task that yields control while we observe the flag.
		let observedDuringRun: string | null | undefined = "<unset>";
		(session as any).handlerRegistry.registerTask("slow", async () => {
			observedDuringRun = (session as any).activeWizard;
			return { success: true, message: "done" };
		});
		// Swap the demo wizard's task for the slow handler.
		const def = (session as any).wizardRegistry.get("demo");
		def.tasks = [{ id: "t1", function: "slow", type: "internal" }];

		expect((session as any).activeWizard ?? null).toBeNull();
		await registry.dispatch("/wizard run demo", session);
		expect(observedDuringRun).toBe("Demo");
		expect((session as any).activeWizard ?? null).toBeNull();
	});
});

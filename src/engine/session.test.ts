import { describe, expect, it } from "vitest";
import { Session } from "./session.js";
import { MockHiseConnection } from "./hise.js";
import type { CommandResult } from "./result.js";
import type { CompletionResult, Mode, ModeId, SessionContext } from "./modes/mode.js";
import { CompletionEngine } from "./completion/engine.js";

// ── Test helpers ────────────────────────────────────────────────────

function createStubMode(id: string, response?: CommandResult): Mode {
	return {
		id: id as Mode["id"],
		name: id.charAt(0).toUpperCase() + id.slice(1),
		accent: "#ffffff",
		prompt: `[${id}] > `,
		async parse(_input: string, _session: SessionContext) {
			return response ?? { type: "text", content: `${id}: ${_input}` };
		},
	};
}

function createSession(): Session {
	const session = new Session(null);
	// Register a few stub modes for testing
	session.registerMode("script", (ctx) =>
		createStubMode(ctx ? `script:${ctx}` : "script"),
	);
	session.registerMode("builder", () => createStubMode("builder"));
	session.registerMode("inspect", () => createStubMode("inspect"));
	return session;
}

// ── Session basics ──────────────────────────────────────────────────

describe("Session", () => {
	it("starts in root mode", () => {
		const session = createSession();
		expect(session.currentMode().id).toBe("root");
		expect(session.modeStackDepth).toBe(0);
	});

	it("accepts a null connection", () => {
		const session = new Session(null);
		expect(session.connection).toBeNull();
	});

	it("accepts a HiseConnection", () => {
		const mock = new MockHiseConnection();
		const session = new Session(mock);
		expect(session.connection).toBe(mock);
	});
});

// ── Mode stack ──────────────────────────────────────────────────────

describe("Session mode stack", () => {
	it("pushes a registered mode", () => {
		const session = createSession();
		const result = session.pushMode("builder");
		expect(result).toBeNull(); // success
		expect(session.currentMode().id).toBe("builder");
		expect(session.modeStackDepth).toBe(1);
	});

	it("pushes mode with context", () => {
		const session = createSession();
		session.pushMode("script:Interface");
		expect(session.currentMode().id).toBe("script:Interface");
	});

	it("returns error for unregistered mode", () => {
		const session = createSession();
		const result = session.pushMode("nonexistent");
		expect(result).not.toBeNull();
		expect(result!.type).toBe("error");
	});

	it("pops back to previous mode", () => {
		const session = createSession();
		session.pushMode("builder");
		expect(session.currentMode().id).toBe("builder");

		const result = session.popMode();
		expect(result.type).toBe("text");
		expect(session.currentMode().id).toBe("root");
	});

	it("pops at root signals quit", () => {
		const session = createSession();
		expect(session.shouldQuit).toBe(false);

		session.popMode();
		expect(session.shouldQuit).toBe(true);
	});

	it("supports nested mode stack", () => {
		const session = createSession();
		session.pushMode("builder");
		session.pushMode("inspect");
		expect(session.modeStackDepth).toBe(2);
		expect(session.currentMode().id).toBe("inspect");

		session.popMode();
		expect(session.currentMode().id).toBe("builder");

		session.popMode();
		expect(session.currentMode().id).toBe("root");
	});
});

// ── Input dispatch ──────────────────────────────────────────────────

describe("Session input dispatch", () => {
	it("dispatches slash commands to registry", async () => {
		const session = createSession();
		const result = await session.handleInput("/help");
		expect(result.type).toBe("markdown");
	});

	it("dispatches plain input to current mode", async () => {
		const session = createSession();
		session.pushMode("script");
		const result = await session.handleInput("Engine.getSampleRate()");
		expect(result.type).toBe("text");
		if (result.type === "text") {
			expect(result.content).toContain("Engine.getSampleRate()");
		}
	});

	it("root mode rejects plain input", async () => {
		const session = createSession();
		const result = await session.handleInput("something");
		expect(result.type).toBe("error");
	});

	it("empty input returns empty result", async () => {
		const session = createSession();
		const result = await session.handleInput("");
		expect(result.type).toBe("empty");
	});

	it("whitespace-only input returns empty result", async () => {
		const session = createSession();
		const result = await session.handleInput("   ");
		expect(result.type).toBe("empty");
	});

	it("/builder switches to builder mode", async () => {
		const session = createSession();
		await session.handleInput("/builder");
		expect(session.currentMode().id).toBe("builder");
	});

	it("/script.Interface switches to script mode with context", async () => {
		const session = createSession();
		await session.handleInput("/script.Interface");
		expect(session.currentMode().id).toBe("script");
		// Context would be verified via mode.contextLabel (not mode.id)
	});

	it("/exit pops mode", async () => {
		const session = createSession();
		await session.handleInput("/builder");
		expect(session.currentMode().id).toBe("builder");

		await session.handleInput("/exit");
		expect(session.currentMode().id).toBe("root");
	});

	it("/modes returns table", async () => {
		const session = createSession();
		const result = await session.handleInput("/modes");
		expect(result.type).toBe("table");
	});
});

// ── History tracking ────────────────────────────────────────────────

describe("Session history", () => {
	it("records input in history", async () => {
		const session = createSession();
		session.pushMode("script");
		await session.handleInput("first");
		await session.handleInput("second");
		expect(session.history).toEqual(["first", "second"]);
	});

	it("deduplicates consecutive identical inputs", async () => {
		const session = createSession();
		session.pushMode("script");
		await session.handleInput("same");
		await session.handleInput("same");
		await session.handleInput("different");
		await session.handleInput("same");
		expect(session.history).toEqual(["same", "different", "same"]);
	});

	it("does not record empty input", async () => {
		const session = createSession();
		await session.handleInput("");
		await session.handleInput("   ");
		expect(session.history).toHaveLength(0);
	});

	it("records slash commands in history", async () => {
		const session = createSession();
		await session.handleInput("/help");
		expect(session.history).toContain("/help");
	});
});

// ── Session completion ──────────────────────────────────────────────

describe("Session completion", () => {
	it("completes slash commands at root", () => {
		const engine = new CompletionEngine();
		const session = new Session(null, engine);
		const result = session.complete("/he", 3);
		expect(result.items.some((i) => i.label === "/help")).toBe(true);
	});

	it("returns all slash commands for /", () => {
		const engine = new CompletionEngine();
		const session = new Session(null, engine);
		const result = session.complete("/", 1);
		expect(result.items.length).toBe(20);
		expect(result.items.some((item) => item.label === "/callback")).toBe(true);
	});

	it("returns empty for plain input in root mode (no mode complete)", () => {
		const engine = new CompletionEngine();
		const session = new Session(null, engine);
		const result = session.complete("something", 9);
		expect(result.items).toHaveLength(0);
	});

	it("delegates to mode complete() for non-slash input", () => {
		const engine = new CompletionEngine();
		const session = new Session(null, engine);

		// Register a mode with completion
		session.registerMode("test", () => ({
			id: "root" as const,
			name: "Test",
			accent: "",
			prompt: "> ",
			async parse() { return { type: "empty" as const }; },
			complete(input: string, _cursor: number): CompletionResult {
				return {
					items: [{ label: "testItem", detail: "from test mode" }],
					from: 0,
					to: input.length,
				};
			},
		}));

		session.pushMode("test");
		const result = session.complete("te", 2);
		expect(result.items).toHaveLength(1);
		expect(result.items[0].label).toBe("testItem");
	});

	it("returns empty without completion engine for slash commands", () => {
		const session = new Session(null);
		const result = session.complete("/he", 3);
		expect(result.items).toHaveLength(0);
	});
});

// ── Phase 3.5.1: Mode instance cache ────────────────────────────────

describe("Session mode instance cache", () => {
	it("caches mode instances on first push", () => {
		const session = createSession();
		session.pushMode("builder");
		const firstInstance = session.currentMode();
		
		session.popMode(); // back to root
		session.pushMode("builder");
		const secondInstance = session.currentMode();
		
		// Should reuse the same instance
		expect(secondInstance).toBe(firstInstance);
	});

	it("getOrCreateMode returns cached instance", () => {
		const session = createSession();
		const first = session.getOrCreateMode("builder" as ModeId);
		const second = session.getOrCreateMode("builder" as ModeId);
		expect(second).toBe(first);
	});

	it("getOrCreateMode creates new instance on cache miss", () => {
		const session = createSession();
		const mode = session.getOrCreateMode("builder" as ModeId);
		expect(mode).toBeDefined();
		expect(mode.id).toBe("builder");
	});

	it("popMode with silent flag returns empty result", () => {
		const session = createSession();
		session.pushMode("builder");
		const result = session.popMode(true);
		expect(result.type).toBe("empty");
	});

	it("popMode without silent flag returns text result", () => {
		const session = createSession();
		session.pushMode("builder");
		const result = session.popMode(false);
		expect(result.type).toBe("text");
	});

	it("calls onExit when a mode is popped", () => {
		const session = new Session(null);
		let exited = 0;
		session.registerMode("script", () => ({
			id: "script",
			name: "Script",
			accent: "#fff",
			prompt: "> ",
			async parse() { return { type: "empty" }; },
			onExit() {
				exited++;
			},
		}));

		session.pushMode("script");
		session.popMode();

		expect(exited).toBe(1);
	});

	it("tracks transient script compiler buffers by processor", () => {
		const session = createSession();
		session.setActiveScriptCallback("Interface", "onInit");
		session.appendScriptCallbackLine("Interface", "Content.makeFrontInterface(600, 600);");

		expect(session.getActiveScriptCallback("Interface")).toBe("onInit");
		expect(session.getCollectedScriptCallbacks("Interface")).toEqual({
			onInit: "Content.makeFrontInterface(600, 600);",
		});

		session.clearScriptCompilerState("Interface");
		expect(session.getCollectedScriptCallbacks("Interface")).toEqual({});
	});

	it("mode state persists across push/pop cycles", async () => {
		const session = new Session(null);
		const engine = new CompletionEngine();
		
		// Register builder with state tracking
		let stateValue = 0;
		session.registerMode("stateful", () => {
			const mode: Mode = {
				id: "builder",
				name: "Stateful",
				accent: "#ffffff",
				prompt: "> ",
				async parse() { 
					stateValue++;
					return { type: "text", content: `state=${stateValue}` };
				},
			};
			return mode;
		});
		
		// Enter mode, trigger state change
		session.pushMode("stateful");
		await session.handleInput("test1");
		expect(stateValue).toBe(1);
		
		// Exit and re-enter - should reuse cached instance with same state
		session.popMode();
		session.pushMode("stateful");
		await session.handleInput("test2");
		expect(stateValue).toBe(2); // State persisted
	});
});

// ── Phase 3.5.2: Argument completion from root ──────────────────────

describe("Session argument completion from root", () => {
	it("delegates /builder add to builder mode completion", () => {
		const engine = new CompletionEngine();
		const session = new Session(null, engine);
		
		// Register builder mode with completion
		session.registerMode("builder", () => ({
			id: "builder",
			name: "Builder",
			accent: "#fd971f",
			prompt: "> ",
			async parse() { return { type: "empty" }; },
			complete(input: string, _cursor: number): CompletionResult {
				// Builder should complete module types after "add "
				if (input.trim().startsWith("add")) {
					return {
						items: [{ label: "SimpleGain" }, { label: "Synthesiser" }],
						from: 4,
						to: input.length,
					};
				}
				return { items: [], from: 0, to: input.length };
			},
		}));
		
		const result = session.complete("/builder add ", 14);
		expect(result.items.length).toBeGreaterThan(0);
		expect(result.items.some(i => i.label === "SimpleGain")).toBe(true);
	});

	it("translates cursor offset for mode completion", () => {
		const engine = new CompletionEngine();
		const session = new Session(null, engine);
		
		let receivedCursor = -1;
		session.registerMode("test", () => ({
			id: "builder",
			name: "Test",
			accent: "",
			prompt: "> ",
			async parse() { return { type: "empty" }; },
			complete(input: string, cursor: number): CompletionResult {
				receivedCursor = cursor;
				return { items: [], from: 0, to: input.length };
			},
		}));
		
		// "/test abc" with cursor at position 9 (end of "abc")
		// Should delegate "abc" with cursor 3 to mode
		session.complete("/test abc", 9);
		expect(receivedCursor).toBe(3);
	});

	it("shifts completion result positions back to absolute", () => {
		const engine = new CompletionEngine();
		const session = new Session(null, engine);
		
		session.registerMode("test", () => ({
			id: "builder",
			name: "Test",
			accent: "",
			prompt: "> ",
			async parse() { return { type: "empty" }; },
			complete(input: string, _cursor: number): CompletionResult {
				// Mode returns relative positions
				return { items: [{ label: "item" }], from: 2, to: 5 };
			},
		}));
		
		// "/test hello" - mode gets "hello", returns from=2, to=5
		// Should be shifted to from=8, to=11 (6 chars for "/test ")
		const result = session.complete("/test hello", 11);
		expect(result.from).toBe(8);
		expect(result.to).toBe(11);
	});

	it("returns empty for unknown mode in argument completion", () => {
		const engine = new CompletionEngine();
		const session = new Session(null, engine);
		
		const result = session.complete("/nonexistent args", 17);
		expect(result.items).toHaveLength(0);
	});

	it("delegates /callback argument completion to script mode", () => {
		const engine = new CompletionEngine();
		const session = new Session(null, engine);
		session.registerMode("script", () => ({
			id: "script",
			name: "Script",
			accent: "",
			prompt: "> ",
			async parse() { return { type: "empty" }; },
			complete(input: string): CompletionResult {
				if (input === "/callback onN") {
					return { items: [{ label: "onNoteOn" }], from: 10, to: 13, label: "Callbacks" };
				}
				return { items: [], from: 0, to: input.length };
			},
		}));
		session.pushMode("script");

		const result = session.complete("/callback onN", 13);

		expect(result.items).toEqual([{ label: "onNoteOn" }]);
		expect(result.from).toBe(10);
		expect(result.to).toBe(13);
	});
});

// ── resolvePath ──────────────────────────────────────────────────────

describe("Session.resolvePath", () => {
	it("passes POSIX absolute paths through", () => {
		const session = createSession();
		session.projectFolder = "/proj";
		expect(session.resolvePath("/tmp/foo.hsc")).toBe("/tmp/foo.hsc");
	});

	it("passes Windows absolute paths through (forward + back slash)", () => {
		const session = createSession();
		session.projectFolder = "C:/proj";
		expect(session.resolvePath("D:/tmp/foo.hsc")).toBe("D:/tmp/foo.hsc");
		expect(session.resolvePath("D:\\tmp\\foo.hsc")).toBe("D:\\tmp\\foo.hsc");
	});

	it("returns ./ paths unchanged so the I/O layer resolves against CWD", () => {
		const session = createSession();
		session.projectFolder = "/proj";
		expect(session.resolvePath("./foo.hsc")).toBe("./foo.hsc");
	});

	it("returns ../ paths unchanged", () => {
		const session = createSession();
		session.projectFolder = "/proj";
		expect(session.resolvePath("../sibling/foo.hsc")).toBe("../sibling/foo.hsc");
	});

	it("recognises Windows-style explicit-relative .\\ and ..\\", () => {
		const session = createSession();
		session.projectFolder = "C:/proj";
		expect(session.resolvePath(".\\foo.hsc")).toBe(".\\foo.hsc");
		expect(session.resolvePath("..\\sibling\\foo.hsc")).toBe("..\\sibling\\foo.hsc");
	});

	it("joins bare-relative paths with projectFolder when set", () => {
		const session = createSession();
		session.projectFolder = "/proj";
		expect(session.resolvePath("Scripts/foo.hsc")).toBe("/proj/Scripts/foo.hsc");
	});

	it("returns bare-relative paths unchanged when projectFolder is null", () => {
		const session = createSession();
		expect(session.projectFolder).toBeNull();
		expect(session.resolvePath("Scripts/foo.hsc")).toBe("Scripts/foo.hsc");
	});
});

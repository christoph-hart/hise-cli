import { describe, expect, it } from "vitest";
import { UndoMode } from "./undo.js";
import type { SessionContext } from "./mode.js";
import { CompletionEngine } from "../completion/engine.js";
import { createDefaultMockRuntime } from "../../mock/runtime.js";

// ── Test helpers ────────────────────────────────────────────────────

function createUndoWithMock() {
	const runtime = createDefaultMockRuntime();
	const engine = new CompletionEngine();
	const mode = new UndoMode(engine);
	const session: SessionContext = {
		connection: runtime.connection,
		popMode: () => ({ type: "text", content: "popped" }),
	};
	return { mode, session, connection: runtime.connection };
}

function createUndoNoConnection() {
	const engine = new CompletionEngine();
	const mode = new UndoMode(engine);
	const session: SessionContext = {
		connection: null,
		popMode: () => ({ type: "text", content: "popped" }),
	};
	return { mode, session };
}

// ── Basic operations ────────────────────────────────────────────────

describe("UndoMode basics", () => {
	it("has correct id and accent", () => {
		const mode = new UndoMode();
		expect(mode.id).toBe("undo");
		expect(mode.accent).toBe("#66d9ef");
	});

	it("requires a connection", async () => {
		const { mode, session } = createUndoNoConnection();
		const result = await mode.parse("back", session);
		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.message).toContain("connection");
		}
	});

	it("rejects unknown commands", async () => {
		const { mode, session } = createUndoWithMock();
		const result = await mode.parse("foobar", session);
		expect(result.type).toBe("error");
	});

	it("rejects plan-group commands for CLI / LLM sessions", async () => {
		const { mode, session } = createUndoWithMock();
		const cliSession: SessionContext = { ...session, forLlm: true };

		for (const command of ["plan \"Test\"", "apply", "discard", "diff"]) {
			const result = await mode.parse(command, cliSession);
			expect(result.type).toBe("error");
			if (result.type === "error") {
				expect(result.message).toContain("interactive TUI");
			}
		}
	});
});

// ── Back / Forward / Clear ──────────────────────────────────────────

describe("UndoMode back/forward/clear", () => {
	it("back with nothing to undo returns error", async () => {
		const { mode, session } = createUndoWithMock();
		const result = await mode.parse("back", session);
		expect(result.type).toBe("error");
	});

	it("forward with nothing to redo returns error", async () => {
		const { mode, session } = createUndoWithMock();
		const result = await mode.parse("forward", session);
		expect(result.type).toBe("error");
	});

	it("clear succeeds on empty history", async () => {
		const { mode, session } = createUndoWithMock();
		const result = await mode.parse("clear", session);
		expect(result.type).toBe("text");
		expect(result.type === "text" && result.content).toContain("cleared");
	});

	it("history returns text when empty", async () => {
		const { mode, session } = createUndoWithMock();
		const result = await mode.parse("history", session);
		expect(result.type).toBe("text");
	});

	it("diff returns text when empty", async () => {
		const { mode, session } = createUndoWithMock();
		const result = await mode.parse("diff", session);
		expect(result.type).toBe("text");
		expect(result.type === "text" && result.content).toContain("No changes");
	});
});

// ── Plan lifecycle ──────────────────────────────────────────────────

describe("UndoMode plan lifecycle", () => {
	it("starts a plan group", async () => {
		const { mode, session } = createUndoWithMock();
		const result = await mode.parse('plan "Test Plan"', session);
		expect(result.type).toBe("text");
		expect(result.type === "text" && result.content).toContain("Test Plan");
		expect(mode.prompt).toContain("plan:Test Plan");
	});

	it("rejects plan when already in plan", async () => {
		const { mode, session } = createUndoWithMock();
		await mode.parse('plan "First"', session);
		const result = await mode.parse('plan "Second"', session);
		expect(result.type).toBe("error");
	});

	it("apply commits and exits plan", async () => {
		const { mode, session } = createUndoWithMock();
		await mode.parse('plan "Test"', session);
		const result = await mode.parse("apply", session);
		expect(result.type).toBe("text");
		expect(result.type === "text" && result.content).toContain("Applied");
		expect(mode.prompt).toBe("[undo] > ");
	});

	it("discard exits plan", async () => {
		const { mode, session } = createUndoWithMock();
		await mode.parse('plan "Test"', session);
		const result = await mode.parse("discard", session);
		expect(result.type).toBe("text");
		expect(result.type === "text" && result.content).toContain("Discarded");
		expect(mode.prompt).toBe("[undo] > ");
	});

	it("apply rejects when not in plan", async () => {
		const { mode, session } = createUndoWithMock();
		const result = await mode.parse("apply", session);
		expect(result.type).toBe("error");
	});

	it("discard rejects when not in plan", async () => {
		const { mode, session } = createUndoWithMock();
		const result = await mode.parse("discard", session);
		expect(result.type).toBe("error");
	});

	it("plan with unquoted name works", async () => {
		const { mode, session } = createUndoWithMock();
		const result = await mode.parse("plan MyPlan", session);
		expect(result.type).toBe("text");
		expect(mode.prompt).toContain("plan:MyPlan");
	});

	it("plan with no name defaults to 'Plan'", async () => {
		const { mode, session } = createUndoWithMock();
		const result = await mode.parse("plan", session);
		expect(result.type).toBe("text");
		expect(mode.prompt).toContain("plan:Plan");
	});
});

// ── Tree sidebar ────────────────────────────────────────────────────

describe("UndoMode tree sidebar", () => {
	it("getTree returns root node", () => {
		const mode = new UndoMode();
		const tree = mode.getTree();
		expect(tree).not.toBeNull();
		expect(tree!.label).toBe("Undo History");
	});

	it("getSelectedPath returns empty when no history", () => {
		const mode = new UndoMode();
		expect(mode.getSelectedPath()).toEqual([]);
	});
});

// ── Completion ──────────────────────────────────────────────────────

describe("UndoMode completion", () => {
	it("completes keywords", () => {
		const mode = new UndoMode(new CompletionEngine());
		const result = mode.complete("ba", 2);
		expect(result.items.some((i) => i.label === "back")).toBe(true);
	});

	it("includes plan when not in plan", () => {
		const mode = new UndoMode(new CompletionEngine());
		const result = mode.complete("", 0);
		expect(result.items.some((i) => i.label === "plan")).toBe(true);
		expect(result.items.some((i) => i.label === "apply")).toBe(false);
	});

	it("includes apply/discard when in plan", async () => {
		const { mode, session } = createUndoWithMock();
		await mode.parse('plan "Test"', session);
		const result = mode.complete("", 0);
		expect(result.items.some((i) => i.label === "apply")).toBe(true);
		expect(result.items.some((i) => i.label === "discard")).toBe(true);
	});

	it("returns empty without completion engine", () => {
		const mode = new UndoMode();
		const result = mode.complete("ba", 2);
		expect(result.items).toHaveLength(0);
	});
});

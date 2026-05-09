import { describe, expect, it } from "vitest";
import {
	parseSingleUiCommand,
	parseUiInput,
	type UiAddCommand,
	type UiAddChainCommand,
	type UiCdCommand,
	type UiCommand,
	type UiGetCommand,
	type UiRemoveCommand,
	type UiRenameCommand,
	type UiSetCommand,
	type UiShowCommand,
} from "./ui-parser.js";

function parseOk<T extends UiCommand = UiCommand>(input: string): T {
	const r = parseSingleUiCommand(input);
	if ("error" in r) throw new Error(r.error);
	return r.command as T;
}

function parseErr(input: string): string {
	const r = parseSingleUiCommand(input);
	if (!("error" in r)) throw new Error(`expected error, got ${JSON.stringify(r.command)}`);
	return r.error;
}

// ── add ─────────────────────────────────────────────────────────────

describe("ui parser — add", () => {
	it("parses single add with alias", () => {
		const cmd = parseOk<UiAddCommand>('add ScriptButton as "Play"');
		expect(cmd.type).toBe("add");
		expect(cmd.componentType).toBe("ScriptButton");
		expect(cmd.alias).toBe("Play");
		expect(cmd.parent).toBeUndefined();
	});

	it("parses single add with `to` parent", () => {
		const cmd = parseOk<UiAddCommand>('add ScriptButton as "Inner" to Container');
		expect(cmd.parent!.kind).toBe("bare");
	});

	it("parses chained add → addChain", () => {
		const cmd = parseOk<UiAddChainCommand>('add ScriptButton as "A", ScriptSlider as "B"');
		expect(cmd.type).toBe("addChain");
		expect(cmd.clauses).toHaveLength(2);
	});

	it("rejects `to` clause inside chained add", () => {
		expect(parseErr('add ScriptButton as "A", ScriptButton as "B" to Container'))
			.toMatch(/forbidden in chained/);
	});

	it("requires alias to be quoted", () => {
		expect(parseErr("add ScriptButton as Play")).toMatch(/Parse error/);
	});

	it("rejects old `at <x> <y> <w> <h>` clause", () => {
		expect(parseErr('add ScriptButton as "Play" at 10 20 100 30')).toMatch(/Parse error/);
	});
});

// ── remove ─────────────────────────────────────────────────────────

describe("ui parser — remove", () => {
	it("parses single target", () => {
		const cmd = parseOk<UiRemoveCommand>("remove Play");
		expect(cmd.targets).toHaveLength(1);
	});

	it("parses chained targets", () => {
		const cmd = parseOk<UiRemoveCommand>("remove A, B, C");
		expect(cmd.targets).toHaveLength(3);
	});
});

// ── rename ─────────────────────────────────────────────────────────

describe("ui parser — rename", () => {
	it("requires `as` (not `to`)", () => {
		const cmd = parseOk<UiRenameCommand>('rename Play as "PlayButton"');
		expect(cmd.name).toBe("PlayButton");
	});

	it("rejects old `to` form", () => {
		expect(parseErr('rename Play to "PlayBtn"')).toMatch(/Parse error/);
	});

	it("requires quoted name", () => {
		expect(parseErr("rename Play as PlayButton")).toMatch(/Parse error/);
	});
});

// ── set ─────────────────────────────────────────────────────────────

describe("ui parser — set", () => {
	it("parses scalar property write", () => {
		const cmd = parseOk<UiSetCommand>("set Play.x 120");
		expect(cmd.clauses).toHaveLength(1);
		expect(cmd.clauses[0]!.value.kind).toBe("number");
	});

	it("parses array4 bounds", () => {
		const cmd = parseOk<UiSetCommand>("set Play.bounds [100, 200, 80, 32]");
		expect(cmd.clauses[0]!.value.kind).toBe("arrayN");
	});

	it("parses array2 position", () => {
		const cmd = parseOk<UiSetCommand>("set Play.position [10, 20]");
		expect(cmd.clauses[0]!.value.kind).toBe("arrayN");
	});

	it("parses string text value", () => {
		const cmd = parseOk<UiSetCommand>('set Play.text "Hello"');
		expect(cmd.clauses[0]!.value.kind).toBe("string");
	});

	it("parses boolean visible value", () => {
		const cmd = parseOk<UiSetCommand>("set Play.visible true");
		expect(cmd.clauses[0]!.value.kind).toBe("boolean");
	});

	it("parses set X.parent <path>", () => {
		const cmd = parseOk<UiSetCommand>("set Play.parent Container");
		expect(cmd.clauses[0]!.value.kind).toBe("path");
	});

	it("parses chained set clauses", () => {
		const cmd = parseOk<UiSetCommand>("set Play.x 120, Play.y 220");
		expect(cmd.clauses).toHaveLength(2);
	});

	it("rejects single-segment path", () => {
		expect(parseErr("set Play 1")).toMatch(/at least 2 segments/);
	});
});

// ── get ─────────────────────────────────────────────────────────────

describe("ui parser — get", () => {
	it("requires dotted path", () => {
		const cmd = parseOk<UiGetCommand>("get Play.x");
		expect(cmd.paths).toHaveLength(1);
	});

	it("rejects single-segment path", () => {
		expect(parseErr("get Play")).toMatch(/at least 2 segments/);
	});

	it("supports comma chaining", () => {
		const cmd = parseOk<UiGetCommand>("get Play.x, Play.y");
		expect(cmd.paths).toHaveLength(2);
	});
});

// ── show ──────────────────────────────────────────────────────────

describe("ui parser — show", () => {
	it("takes a single path target", () => {
		const cmd = parseOk<UiShowCommand>("show Play");
		expect(cmd.kind).toBe("target");
		if (cmd.kind === "target") expect(cmd.target.kind).toBe("bare");
	});

	it("parses `show tree`", () => {
		const cmd = parseOk<UiShowCommand>("show tree");
		expect(cmd.kind).toBe("tree");
	});

	it("parses `show tree <filter>`", () => {
		const cmd = parseOk<UiShowCommand>("show tree button");
		if (cmd.kind === "tree") expect(cmd.filter).toBe("button");
		else throw new Error("expected tree kind");
	});

	it("rejects `list` verb (folded into show)", () => {
		expect(parseErr("list tree")).toMatch(/Parse error/);
	});
});

// ── navigation ─────────────────────────────────────────────────────

describe("ui parser — navigation", () => {
	it("parses cd <path>", () => {
		const cmd = parseOk<UiCdCommand>("cd Container");
		expect(cmd.target.kind).toBe("bare");
	});

	it("parses cd ..", () => {
		const cmd = parseOk<UiCdCommand>("cd ..");
		expect(cmd.target.kind).toBe("parent");
	});

	it("parses ls/pwd/reset", () => {
		expect(parseOk("ls").type).toBe("ls");
		expect(parseOk("pwd").type).toBe("pwd");
		expect(parseOk("reset").type).toBe("reset");
	});
});

// ── removed verbs ──────────────────────────────────────────────────

describe("ui parser — removed verbs error clearly", () => {
	it("rejects `move`", () => {
		expect(parseErr("move Play to Container")).toMatch(/Parse error/);
	});
});

// ── parseUiInput chaining ─────────────────────────────────────────

describe("ui parser — parseUiInput chaining", () => {
	it("splits chained set into per-clause commands", () => {
		const r = parseUiInput("set Play.x 120, Play.y 220");
		if ("error" in r) throw new Error(r.error);
		expect(r.commands).toHaveLength(2);
	});

	it("splits chained remove into per-target commands", () => {
		const r = parseUiInput("remove A, B, C");
		if ("error" in r) throw new Error(r.error);
		expect(r.commands).toHaveLength(3);
	});

	it("keeps chained add as addChain", () => {
		const r = parseUiInput('add ScriptButton as "A", ScriptButton as "B"');
		if ("error" in r) throw new Error(r.error);
		expect(r.commands).toHaveLength(1);
		expect(r.commands[0]!.type).toBe("addChain");
	});
});

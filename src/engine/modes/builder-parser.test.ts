import { describe, expect, it } from "vitest";
import {
	parseSingleCommand,
	parseBuilderInput,
	type AddCommand,
	type AddChainCommand,
	type RemoveCommand,
	type RenameCommand,
	type CloneCommand,
	type SetCommand,
	type GetCommand,
	type ShowCommand,
	type CdCommand,
} from "./builder-parser.js";

function parseOk<T = unknown>(input: string): T {
	const r = parseSingleCommand(input);
	if ("error" in r) throw new Error(r.error);
	return r.command as unknown as T;
}

function parseErr(input: string): string {
	const r = parseSingleCommand(input);
	if (!("error" in r)) throw new Error(`expected error, got ${JSON.stringify(r.command)}`);
	return r.error;
}

// ── add ────────────────────────────────────────────────────────────

describe("builder parser — add", () => {
	it("parses single add with alias (no parent)", () => {
		const cmd = parseOk<AddCommand>('add SineSynth as "Lead"');
		expect(cmd.type).toBe("add");
		expect(cmd.moduleType).toBe("SineSynth");
		expect(cmd.alias).toBe("Lead");
		expect(cmd.parent).toBeUndefined();
	});

	it("parses single add with `to` parent", () => {
		const cmd = parseOk<AddCommand>('add SineSynth as "Lead" to Master');
		expect(cmd.parent).toBeDefined();
		expect(cmd.parent!.kind).toBe("bare");
	});

	it("parses single add with dotted `to` path", () => {
		const cmd = parseOk<AddCommand>('add Filter as "LP" to Master.GainModulation');
		expect(cmd.parent!.kind).toBe("dotted");
	});

	it("parses chained add (cwd-only) into addChain command", () => {
		const cmd = parseOk<AddChainCommand>('add SineSynth as "A", Filter as "B"');
		expect(cmd.type).toBe("addChain");
		expect(cmd.clauses).toHaveLength(2);
		expect(cmd.clauses[0]!.alias).toBe("A");
		expect(cmd.clauses[1]!.alias).toBe("B");
	});

	it("rejects `to` clause inside chained add", () => {
		expect(parseErr('add Synth as "A", Synth as "B" to Master')).toMatch(/forbidden in chained/);
	});

	it("requires `as`", () => {
		expect(parseErr("add SineSynth Lead")).toMatch(/Parse error/);
	});

	it("requires alias to be quoted", () => {
		expect(parseErr("add SineSynth as Lead")).toMatch(/Parse error/);
	});

	it("accepts multi-word pretty name (bare)", () => {
		const cmd = parseOk<AddCommand>('add Sine Wave Generator as "Sine"');
		expect(cmd.moduleType).toBe("Sine Wave Generator");
		expect(cmd.alias).toBe("Sine");
	});

	it("accepts multi-word pretty name (quoted)", () => {
		const cmd = parseOk<AddCommand>('add "Sine Wave Generator" as "Sine"');
		expect(cmd.moduleType).toBe("Sine Wave Generator");
	});

	it("multi-word + to parent", () => {
		const cmd = parseOk<AddCommand>('add Sine Wave Generator as "Lead" to Master');
		expect(cmd.moduleType).toBe("Sine Wave Generator");
		expect(cmd.parent!.kind).toBe("bare");
	});
});

// ── remove ─────────────────────────────────────────────────────────

describe("builder parser — remove", () => {
	it("parses single target", () => {
		const cmd = parseOk<RemoveCommand>("remove Lead");
		expect(cmd.type).toBe("remove");
		expect(cmd.targets).toHaveLength(1);
	});

	it("parses chained targets", () => {
		const cmd = parseOk<RemoveCommand>("remove A, B, C");
		expect(cmd.targets).toHaveLength(3);
	});

	it("parses dotted-path target", () => {
		const cmd = parseOk<RemoveCommand>("remove Master.Lead");
		expect(cmd.targets[0]!.kind).toBe("dotted");
	});

	it("does not exist as old `move`", () => {
		expect(parseErr("move Lead to Master")).toMatch(/Parse error/);
	});
});

// ── rename ─────────────────────────────────────────────────────────

describe("builder parser — rename", () => {
	it("requires `as` (not `to`)", () => {
		const cmd = parseOk<RenameCommand>('rename Lead as "MainSynth"');
		expect(cmd.type).toBe("rename");
		expect(cmd.name).toBe("MainSynth");
	});

	it("rejects `to` form", () => {
		expect(parseErr('rename Lead to "MainSynth"')).toMatch(/Parse error/);
	});

	it("requires quoted name", () => {
		expect(parseErr("rename Lead as MainSynth")).toMatch(/Parse error/);
	});
});

// ── clone ──────────────────────────────────────────────────────────

describe("builder parser — clone", () => {
	it("requires plain integer count", () => {
		const cmd = parseOk<CloneCommand>("clone Lead 3");
		expect(cmd.type).toBe("clone");
		expect(cmd.count).toBe(3);
	});

	it("rejects xN form", () => {
		expect(parseErr("clone Lead x3")).toMatch(/Parse error/);
	});

	it("rejects missing count", () => {
		expect(parseErr("clone Lead")).toMatch(/Parse error/);
	});

	it("rejects negative count", () => {
		expect(parseErr("clone Lead -2")).toMatch(/positive integer/);
	});
});

// ── set ────────────────────────────────────────────────────────────

describe("builder parser — set", () => {
	it("parses simple numeric set", () => {
		const cmd = parseOk<SetCommand>("set Lead.Volume -6");
		expect(cmd.type).toBe("set");
		expect(cmd.clauses).toHaveLength(1);
		const v = cmd.clauses[0]!.value;
		expect(v.kind).toBe("number");
		if (v.kind === "number") expect(v.n).toBe(-6);
	});

	it("parses boolean set", () => {
		const cmd = parseOk<SetCommand>("set Lead.bypassed true");
		const v = cmd.clauses[0]!.value;
		expect(v.kind).toBe("boolean");
	});

	it("parses percent set", () => {
		const cmd = parseOk<SetCommand>("set Lead.Volume 50%");
		const v = cmd.clauses[0]!.value;
		expect(v.kind).toBe("number");
		if (v.kind === "number") expect(v.n).toBeCloseTo(0.5);
	});

	it("parses hex literal", () => {
		const cmd = parseOk<SetCommand>("set core.NodeColour 0xFF8800AA");
		const v = cmd.clauses[0]!.value;
		expect(v.kind).toBe("hex");
	});

	it("parses array2", () => {
		const cmd = parseOk<SetCommand>("set X.position [10, 20]");
		const v = cmd.clauses[0]!.value;
		expect(v.kind).toBe("arrayN");
	});

	it("parses arrayN routing", () => {
		const cmd = parseOk<SetCommand>("set Synth1.routing [0, 1, -1, -1]");
		const v = cmd.clauses[0]!.value;
		expect(v.kind).toBe("arrayN");
	});

	it("parses string preset value", () => {
		const cmd = parseOk<SetCommand>('set Synth1.routing "stereo"');
		const v = cmd.clauses[0]!.value;
		expect(v.kind).toBe("string");
		if (v.kind === "string") expect(v.s).toBe("stereo");
	});

	it("parses path value (set X.parent Y)", () => {
		const cmd = parseOk<SetCommand>("set Lead.parent Compressor");
		const v = cmd.clauses[0]!.value;
		expect(v.kind).toBe("path");
	});

	it("parses comma-chained clauses", () => {
		const cmd = parseOk<SetCommand>("set Master.Volume -6, Master.Pan 0");
		expect(cmd.clauses).toHaveLength(2);
	});

	it("rejects single-segment path", () => {
		expect(parseErr("set Lead 1")).toMatch(/at least 2 segments/);
	});

	it("rejects strict `to` keyword in set value position", () => {
		// Old grammar permitted `set X.foo to <value>`; new grammar parses
		// `to` as a path identifier (which is valid). Make sure no parse error.
		expect(() => parseOk("set Lead.Volume to -6")).toThrow();
	});

	it("does not accept old 6-digit hex", () => {
		// HexLiteral requires exactly 8 digits, so `0xFFAA00` fails to lex
		// as one token and the parser surfaces a leftover-input error.
		expect(parseErr("set core.NodeColour 0xFFAA00")).toMatch(/Parse error/);
	});
});

// ── get ────────────────────────────────────────────────────────────

describe("builder parser — get", () => {
	it("requires dotted path", () => {
		const cmd = parseOk<GetCommand>("get Lead.Volume");
		expect(cmd.type).toBe("get");
		expect(cmd.paths).toHaveLength(1);
	});

	it("rejects single-segment path", () => {
		expect(parseErr("get Lead")).toMatch(/at least 2 segments/);
	});

	it("supports comma chaining", () => {
		const cmd = parseOk<GetCommand>("get Lead.Volume, Lead.Pan");
		expect(cmd.paths).toHaveLength(2);
	});
});

// ── show ───────────────────────────────────────────────────────────

describe("builder parser — show", () => {
	it("takes a bare path target", () => {
		const cmd = parseOk<ShowCommand>("show Lead");
		expect(cmd.type).toBe("show");
		expect(cmd.kind).toBe("target");
		if (cmd.kind === "target") expect(cmd.target.kind).toBe("bare");
	});

	it("takes a dotted path target (parameter detail)", () => {
		const cmd = parseOk<ShowCommand>("show Master.Lead");
		expect(cmd.kind).toBe("target");
		if (cmd.kind === "target") expect(cmd.target.kind).toBe("dotted");
	});

	it("parses `show tree`", () => {
		const cmd = parseOk<ShowCommand>("show tree");
		expect(cmd.kind).toBe("tree");
	});

	it("rejects static docs through `show`", () => {
		expect(parseErr("show types")).toMatch(/Parse error/);
		expect(parseErr("show type AHDSR")).toMatch(/Parse error|Redundant input/);
	});

	it("rejects `list` verb (folded into show)", () => {
		expect(parseErr("list types")).toMatch(/Parse error/);
		expect(parseErr("list tree")).toMatch(/Parse error/);
	});
});

// ── navigation ─────────────────────────────────────────────────────

describe("builder parser — navigation", () => {
	it("parses cd <path>", () => {
		const cmd = parseOk<CdCommand>("cd Lead");
		expect(cmd.type).toBe("cd");
		expect(cmd.target.kind).toBe("bare");
	});

	it("parses cd ..", () => {
		const cmd = parseOk<CdCommand>("cd ..");
		expect(cmd.target.kind).toBe("parent");
	});

	it("parses cd dotted path", () => {
		const cmd = parseOk<CdCommand>("cd Master.Lead");
		expect(cmd.target.kind).toBe("dotted");
	});

	it("parses ls", () => {
		const cmd = parseOk("ls") as { type: string };
		expect(cmd.type).toBe("ls");
	});

	it("parses pwd", () => {
		const cmd = parseOk("pwd") as { type: string };
		expect(cmd.type).toBe("pwd");
	});

	it("parses reset", () => {
		const cmd = parseOk("reset") as { type: string };
		expect(cmd.type).toBe("reset");
	});
});

// ── removed verbs (negative tests) ─────────────────────────────────

describe("builder parser — removed verbs error clearly", () => {
	for (const verb of ["move", "load", "bypass", "enable"]) {
		it(`rejects \`${verb}\``, () => {
			expect(parseErr(`${verb} Lead to Master`)).toMatch(/Parse error/);
		});
	}
});

// ── Comma chaining via parseBuilderInput ──────────────────────────

describe("builder parser — parseBuilderInput chaining", () => {
	it("splits chained set into per-clause commands", () => {
		const r = parseBuilderInput("set Master.Volume -6, Master.Pan 0");
		if ("error" in r) throw new Error(r.error);
		expect(r.commands).toHaveLength(2);
		expect(r.commands[0]!.type).toBe("set");
		expect(r.commands[1]!.type).toBe("set");
	});

	it("splits chained remove into per-target commands", () => {
		const r = parseBuilderInput("remove A, B, C");
		if ("error" in r) throw new Error(r.error);
		expect(r.commands).toHaveLength(3);
	});

	it("keeps single chained add as addChain (not split)", () => {
		const r = parseBuilderInput('add Synth as "A", Synth as "B"');
		if ("error" in r) throw new Error(r.error);
		expect(r.commands).toHaveLength(1);
		expect(r.commands[0]!.type).toBe("addChain");
	});
});

// ── Comments / whitespace ─────────────────────────────────────────

describe("builder parser — comments", () => {
	it("ignores `#` comments", () => {
		const cmd = parseOk<SetCommand>("set Lead.Volume -6 # turn down");
		expect(cmd.type).toBe("set");
	});

	it("ignores `//` comments", () => {
		const cmd = parseOk<SetCommand>("set Lead.Volume -6 // turn down");
		expect(cmd.type).toBe("set");
	});
});

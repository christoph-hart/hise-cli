import { describe, expect, it } from "vitest";
import {
	parseSingleDspCommand,
	parseDspInput,
	type AddCommand,
	type AddChainCommand,
	type CdCommand,
	type ConnectCommand,
	type CreateParameterCommand,
	type DisconnectCommand,
	type DspCommand,
	type GetCommand,
	type RemoveCommand,
	type RenameCommand,
	type ScreenshotCommand,
	type SetCommand,
	type ShowCommand,
	type TraceCommand,
} from "./dsp-parser.js";

function parseOk<T extends DspCommand = DspCommand>(input: string): T {
	const r = parseSingleDspCommand(input);
	if ("error" in r) throw new Error(r.error);
	return r.command as T;
}

function parseErr(input: string): string {
	const r = parseSingleDspCommand(input);
	if (!("error" in r)) throw new Error(`expected error, got ${JSON.stringify(r.command)}`);
	return r.error;
}

// ── add ────────────────────────────────────────────────────────────

describe("dsp parser — add", () => {
	it("parses single add factory.node as alias", () => {
		const cmd = parseOk<AddCommand>('add core.gain as "g1"');
		expect(cmd.type).toBe("add");
		expect(cmd.factory).toBe("core");
		expect(cmd.node).toBe("gain");
		expect(cmd.alias).toBe("g1");
	});

	it("parses factory nodes that share command keyword names", () => {
		const cmd = parseOk<AddCommand>('add math.add as "InputLevel"');
		expect(cmd.factory).toBe("math");
		expect(cmd.node).toBe("add");
		expect(cmd.alias).toBe("InputLevel");
	});

	it("parses add with `to` parent", () => {
		const cmd = parseOk<AddCommand>('add core.gain as "g1" to Container');
		expect(cmd.parent!.kind).toBe("bare");
	});

	it("parses chained add into addChain", () => {
		const cmd = parseOk<AddChainCommand>('add core.gain as "g1", core.osc as "o1"');
		expect(cmd.type).toBe("addChain");
		expect(cmd.clauses).toHaveLength(2);
	});

	it("rejects `to` clause inside chained add", () => {
		expect(parseErr('add core.gain as "g1", core.osc as "o1" to Container'))
			.toMatch(/forbidden in chained/);
	});

	it("requires alias to be quoted", () => {
		expect(parseErr("add core.gain as g1")).toMatch(/Parse error/);
	});

	it("rejects old `at <index>` clause", () => {
		expect(parseErr('add core.gain as "g1" at 2')).toMatch(/Parse error/);
	});
});

// ── remove / rename ────────────────────────────────────────────────

describe("dsp parser — remove / rename", () => {
	it("parses single remove", () => {
		const cmd = parseOk<RemoveCommand>("remove g1");
		expect(cmd.targets).toHaveLength(1);
	});

	it("parses chained remove", () => {
		const cmd = parseOk<RemoveCommand>("remove a, b, c");
		expect(cmd.targets).toHaveLength(3);
	});

	it("parses rename with `as`", () => {
		const cmd = parseOk<RenameCommand>('rename g1 as "Gain1"');
		expect(cmd.name).toBe("Gain1");
	});

	it("rejects old `to` form for rename", () => {
		expect(parseErr('rename g1 to "Gain1"')).toMatch(/Parse error/);
	});
});

// ── set ────────────────────────────────────────────────────────────

describe("dsp parser — set", () => {
	it("parses scalar value", () => {
		const cmd = parseOk<SetCommand>("set g1.Gain 0.5");
		expect(cmd.clauses).toHaveLength(1);
		expect(cmd.clauses[0]!.value.kind).toBe("number");
	});

	it("parses sub-field range write", () => {
		const cmd = parseOk<SetCommand>("set g1.Gain.range [0, 2]");
		expect(cmd.clauses[0]!.value.kind).toBe("arrayN");
	});

	it("parses set X.p.stepSize N", () => {
		const cmd = parseOk<SetCommand>("set g1.Gain.stepSize 0.01");
		const v = cmd.clauses[0]!.value;
		expect(v.kind).toBe("number");
	});

	it("parses set X.bypassed true", () => {
		const cmd = parseOk<SetCommand>("set g1.bypassed true");
		expect(cmd.clauses[0]!.value.kind).toBe("boolean");
	});

	it("parses chained set", () => {
		const cmd = parseOk<SetCommand>("set g1.Gain 0.5, g1.bypassed true");
		expect(cmd.clauses).toHaveLength(2);
	});

	it("parses hex value", () => {
		const cmd = parseOk<SetCommand>("set g1.NodeColour 0xFF8800AA");
		expect(cmd.clauses[0]!.value.kind).toBe("hex");
	});

	it("parses direct node appearance attributes", () => {
		const comment = parseOk<SetCommand>('set MicPairSelector.Comment "**Mic pair selector** - Routes one stereo pair into the FX chain."');
		const folded = parseOk<SetCommand>("set CabGlueComp.Folded true");

		expect(comment.clauses[0]!.value.kind).toBe("string");
		expect(folded.clauses[0]!.value.kind).toBe("boolean");
	});

	it("rejects `to` keyword in set value (no longer optional)", () => {
		// Old grammar accepted `set X.p to V`. New grammar treats `to` as
		// a path identifier in value position.
		expect(() => parseOk("set g1.Gain to 0.5")).toThrow();
	});

	it("rejects 1-segment path", () => {
		expect(parseErr("set g1 1")).toMatch(/at least 2 segments/);
	});
});

// ── get ────────────────────────────────────────────────────────────

describe("dsp parser — get", () => {
	it("parses single dotted path", () => {
		const cmd = parseOk<GetCommand>("get g1.Gain");
		expect(cmd.paths).toHaveLength(1);
	});

	it("parses chained get", () => {
		const cmd = parseOk<GetCommand>("get g1.Gain, g1.bypassed");
		expect(cmd.paths).toHaveLength(2);
	});

	it("rejects old `get source of X.p` form", () => {
		expect(parseErr("get source of g1.Gain")).toMatch(/at least 2 segments|Parse error/);
	});

	it("parses get X.p.source as 3-seg path tail", () => {
		const cmd = parseOk<GetCommand>("get g1.Gain.source");
		expect(cmd.paths[0]!.kind).toBe("dotted");
	});
});

// ── connect / disconnect ──────────────────────────────────────────

describe("dsp parser — connect", () => {
	it("parses simple connect", () => {
		const cmd = parseOk<ConnectCommand>("connect lfo to g1.Gain");
		expect(cmd.clauses).toHaveLength(1);
		expect(cmd.clauses[0]!.matched).toBe(false);
	});

	it("parses connect with matched flag", () => {
		const cmd = parseOk<ConnectCommand>("connect lfo to g1.Gain matched");
		expect(cmd.clauses[0]!.matched).toBe(true);
	});

	it("parses connect with numeric source output (xfader1.0)", () => {
		const cmd = parseOk<ConnectCommand>("connect xfader1.0 to gain1.Gain");
		expect(cmd.clauses[0]!.source.kind).toBe("dotted");
	});

	it("parses chained connect", () => {
		const cmd = parseOk<ConnectCommand>("connect lfo to g1.Gain, lfo to g2.Pan");
		expect(cmd.clauses).toHaveLength(2);
	});

	it("rejects non-`matched` trailing identifier", () => {
		expect(parseErr("connect lfo to g1.Gain weird")).toMatch(/expected "matched"/);
	});
});

describe("dsp parser — disconnect", () => {
	it("requires dotted path (target-only)", () => {
		const cmd = parseOk<DisconnectCommand>("disconnect g1.Gain");
		expect(cmd.targets).toHaveLength(1);
	});

	it("rejects 1-segment path", () => {
		expect(parseErr("disconnect g1")).toMatch(/at least 2 segments/);
	});

	it("rejects old `from`-form", () => {
		expect(parseErr("disconnect lfo from g1.Gain")).toMatch(/Parse error/);
	});

	it("parses chained disconnect", () => {
		const cmd = parseOk<DisconnectCommand>("disconnect g1.Gain, g2.Pan");
		expect(cmd.targets).toHaveLength(2);
	});
});

// ── create_parameter ──────────────────────────────────────────────

describe("dsp parser — create_parameter", () => {
	it("parses range as Array2", () => {
		const cmd = parseOk<CreateParameterCommand>("create_parameter root.Cutoff [20, 20000]");
		expect(cmd.range).toEqual([20, 20000]);
		expect(cmd.paramName).toBe("Cutoff");
	});

	it("parses optional clauses with HISE long-form keys", () => {
		const cmd = parseOk<CreateParameterCommand>(
			"create_parameter root.Cutoff [20, 20000] default 1000 stepSize 0.1 skewFactor 0.3",
		);
		expect(cmd.defaultValue).toBe(1000);
		expect(cmd.stepSize).toBeCloseTo(0.1);
		expect(cmd.skewFactor).toBeCloseTo(0.3);
	});

	it("parses middlePosition", () => {
		const cmd = parseOk<CreateParameterCommand>(
			"create_parameter root.Cutoff [20, 20000] middlePosition 1000",
		);
		expect(cmd.middlePosition).toBe(1000);
	});

	it("rejects unknown clause keyword", () => {
		expect(parseErr("create_parameter root.Cutoff [20, 20000] foo 1")).toMatch(/unknown clause/);
	});

	it("rejects 3-element range", () => {
		expect(parseErr("create_parameter root.Cutoff [20, 1000, 20000]")).toMatch(/range must be 2 elements/);
	});
});

// ── screenshot ────────────────────────────────────────────────────

describe("dsp parser — screenshot", () => {
	it("parses scale + file", () => {
		const cmd = parseOk<ScreenshotCommand>('screenshot scale 1.0 file "out.png"');
		expect(cmd.scale).toBe(1.0);
		expect(cmd.file).toBe("out.png");
	});

	it("parses scale as percent", () => {
		const cmd = parseOk<ScreenshotCommand>('screenshot scale 50% file "out.png"');
		expect(cmd.scale).toBeCloseTo(0.5);
	});

	it("requires file clause", () => {
		expect(parseErr("screenshot scale 1.0")).toMatch(/Parse error/);
	});

	it("requires scale clause", () => {
		expect(parseErr('screenshot file "out.png"')).toMatch(/Parse error/);
	});
});

// ── show ──────────────────────────────────────────────────────────

describe("dsp parser — show", () => {
	it("takes a bare path target", () => {
		const cmd = parseOk<ShowCommand>("show g1");
		expect(cmd.kind).toBe("target");
		if (cmd.kind === "target") expect(cmd.target.kind).toBe("bare");
	});

	it("takes a dotted path target (parameter detail)", () => {
		const cmd = parseOk<ShowCommand>("show g1.Gain");
		expect(cmd.kind).toBe("target");
		if (cmd.kind === "target") expect(cmd.target.kind).toBe("dotted");
	});

	it("parses show tree", () => {
		expect(parseOk<ShowCommand>("show tree").kind).toBe("tree");
	});

	it("parses show networks", () => {
		expect(parseOk<ShowCommand>("show networks").kind).toBe("networks");
	});

	it("parses show modules", () => {
		expect(parseOk<ShowCommand>("show modules").kind).toBe("modules");
	});

	it("parses show connections", () => {
		expect(parseOk<ShowCommand>("show connections").kind).toBe("connections");
	});

	it("parses show <noun> <filter>", () => {
		const cmd = parseOk<ShowCommand>("show networks foo");
		if (cmd.kind === "networks") expect(cmd.filter).toBe("foo");
		else throw new Error("expected networks kind");
	});

	it("rejects static docs through `show`", () => {
		expect(parseErr("show types")).toMatch(/Parse error/);
		expect(parseErr("show type filters.svf")).toMatch(/Parse error|Redundant input/);
	});

	it("rejects `list` verb (folded into show)", () => {
		expect(parseErr("list networks")).toMatch(/Parse error/);
		expect(parseErr("list tree")).toMatch(/Parse error/);
	});
});

// ── trace ──────────────────────────────────────────────────────────

describe("dsp parser — trace", () => {
	it("parses recursive signal trace", () => {
		const cmd = parseOk<TraceCommand>("trace root inject dirac gain 0.25 before \"gain\" probe after \"delay\" probe recursive compact");
		expect(cmd.type).toBe("trace");
		expect(cmd.signalType).toBe("dirac");
		expect(cmd.gain).toBe(0.25);
		expect(cmd.injectBefore).toBe("gain");
		expect(cmd.probeAfter).toBe("delay");
		expect(cmd.recursive).toBe(true);
		expect(cmd.compact).toBe(true);
	});

	it("parses parameter inject and explicit probes", () => {
		const cmd = parseOk<TraceCommand>("trace root inject param Root.Value 0.5 probe param add.Value probe param mul.Value no_specs no_signal");
		expect(cmd.injectParams).toHaveLength(1);
		expect(cmd.probeParams).toHaveLength(2);
		expect(cmd.noSpecs).toBe(true);
		expect(cmd.noSignal).toBe(true);
	});

	it("parses changed parameter discovery", () => {
		const cmd = parseOk<TraceCommand>("trace inject param Root.Value 0.5 probe changed_parameters");
		expect(cmd.container).toBeUndefined();
		expect(cmd.changedParameters).toBe(true);
	});

	it("rejects unquoted boundary ids", () => {
		expect(parseErr("trace root inject dirac before gain")).toMatch(/quoted node id/);
		expect(parseErr("trace root probe after delay")).toMatch(/quoted node id/);
	});

	it("rejects changed parameters mixed with explicit parameter probes", () => {
		expect(parseErr("trace root probe changed_parameters probe param add.Value")).toMatch(/mutually exclusive/);
	});

	it("rejects comma chaining for trace", () => {
		expect(parseErr("trace root inject dirac, trace root inject dc")).toMatch(/Parse error|Redundant input/);
	});
});

// ── navigation ─────────────────────────────────────────────────────

describe("dsp parser — navigation", () => {
	it("parses cd <path>", () => {
		const cmd = parseOk<CdCommand>("cd Container");
		expect(cmd.target.kind).toBe("bare");
	});

	it("parses cd ..", () => {
		const cmd = parseOk<CdCommand>("cd ..");
		expect(cmd.target.kind).toBe("parent");
	});

	it("parses ls / pwd / reset / save", () => {
		expect(parseOk("ls").type).toBe("ls");
		expect(parseOk("pwd").type).toBe("pwd");
		expect(parseOk("reset").type).toBe("reset");
		expect(parseOk("save").type).toBe("save");
	});
});

// ── removed verbs ─────────────────────────────────────────────────

describe("dsp parser — removed verbs error clearly", () => {
	for (const v of ["use ScriptFX1", "init MyDSP", "load MyDSP", "create MyDSP", "bypass g1", "enable g1", "move g1 to Container"]) {
		it(`rejects \`${v}\``, () => {
			expect(parseErr(v)).toMatch(/Parse error/);
		});
	}
});

// ── parseDspInput chaining ────────────────────────────────────────

describe("dsp parser — parseDspInput chaining", () => {
	it("splits chained set", () => {
		const r = parseDspInput("set g1.Gain 0.5, g1.bypassed true");
		if ("error" in r) throw new Error(r.error);
		expect(r.commands).toHaveLength(2);
	});

	it("splits chained connect", () => {
		const r = parseDspInput("connect lfo to g1.Gain, lfo to g2.Pan");
		if ("error" in r) throw new Error(r.error);
		expect(r.commands).toHaveLength(2);
	});

	it("keeps chained add as addChain", () => {
		const r = parseDspInput('add core.gain as "g1", core.osc as "o1"');
		if ("error" in r) throw new Error(r.error);
		expect(r.commands).toHaveLength(1);
		expect(r.commands[0]!.type).toBe("addChain");
	});
});

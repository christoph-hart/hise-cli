import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import {
	BuilderMode,
	parseBuilderInput,
	parseSingleCommand,
	validateAddCommand,
	validateSetCommand,
	collectModuleIds,
	resolveChainIndex,
} from "./builder.js";
import type { TreeNode } from "../result.js";
import type {
	AddCommand,
	CloneCommand,
	RemoveCommand,
	MoveCommand,
	RenameCommand,
	SetCommand,
	LoadCommand,
	BypassCommand,
	EnableCommand,
	ShowCommand,
	BuilderCommand,
} from "./builder.js";
import type { ModuleList } from "../data.js";
import type { SessionContext } from "./mode.js";
import { CompletionEngine, buildDatasets } from "../completion/engine.js";

// ── Load module list for validation tests ───────────────────────────

let moduleList: ModuleList;

beforeAll(() => {
	const dataDir = path.resolve(import.meta.dirname, "../../../data");
	const raw = fs.readFileSync(
		path.join(dataDir, "moduleList.json"),
		"utf8",
	);
	moduleList = JSON.parse(raw) as ModuleList;
});

const nullSession: SessionContext = {
	connection: null,
	popMode: () => ({ type: "text", content: "Exited Builder mode." }),
};

/** Helper: parse single command and assert success. */
function parseOk(input: string): BuilderCommand {
	const result = parseSingleCommand(input);
	if ("error" in result) throw new Error(result.error);
	return result.command;
}

/** Helper: parse with comma chaining and assert success. */
function parseChainOk(input: string): BuilderCommand[] {
	const result = parseBuilderInput(input);
	if ("error" in result) throw new Error(result.error);
	return result.commands;
}

// ── Parser tests — add ──────────────────────────────────────────────

describe("builder parser — add commands", () => {
	it("parses simple add", () => {
		const cmd = parseOk("add AHDSR") as AddCommand;
		expect(cmd.type).toBe("add");
		expect(cmd.moduleType).toBe("AHDSR");
	});

	it("parses add with alias", () => {
		const cmd = parseOk('add StreamingSampler as "MySampler"') as AddCommand;
		expect(cmd.moduleType).toBe("StreamingSampler");
		expect(cmd.alias).toBe("MySampler");
	});

	it("parses add with target and chain", () => {
		const cmd = parseOk("add AHDSR to Sampler1.gain") as AddCommand;
		expect(cmd.moduleType).toBe("AHDSR");
		expect(cmd.parent).toBe("Sampler1");
		expect(cmd.chain).toBe("gain");
	});

	it("parses add with target only (no chain)", () => {
		const cmd = parseOk("add SineSynth to MasterChain") as AddCommand;
		expect(cmd.moduleType).toBe("SineSynth");
		expect(cmd.parent).toBe("MasterChain");
		expect(cmd.chain).toBeUndefined();
	});

	it("parses add with quoted target", () => {
		const cmd = parseOk('add AHDSR to "Master Chain".gain') as AddCommand;
		expect(cmd.parent).toBe("Master Chain");
		expect(cmd.chain).toBe("gain");
	});

	it("parses add with multi-word target", () => {
		const cmd = parseOk("add SimpleReverb to Master Chain") as AddCommand;
		expect(cmd.parent).toBe("Master Chain");
		expect(cmd.chain).toBeUndefined();
	});

	it("parses add with multi-word target and chain", () => {
		const cmd = parseOk("add LFO to Master Chain.gain") as AddCommand;
		expect(cmd.parent).toBe("Master Chain");
		expect(cmd.chain).toBe("gain");
	});

	it("parses add with alias and multi-word target", () => {
		const cmd = parseOk('add AHDSR as "MyEnv" to Master Chain.gain') as AddCommand;
		expect(cmd.moduleType).toBe("AHDSR");
		expect(cmd.alias).toBe("MyEnv");
		expect(cmd.parent).toBe("Master Chain");
		expect(cmd.chain).toBe("gain");
	});

	it("parses add with `to` before `as` ordering", () => {
		const cmd = parseOk('add Velocity to MySynth.gain as "WatchTable"') as AddCommand;
		expect(cmd.moduleType).toBe("Velocity");
		expect(cmd.alias).toBe("WatchTable");
		expect(cmd.parent).toBe("MySynth");
		expect(cmd.chain).toBe("gain");
	});

	it("parses add with `to` before `as` and multi-word parent", () => {
		const cmd = parseOk('add AHDSR to Master Chain.gain as "MyEnv"') as AddCommand;
		expect(cmd.moduleType).toBe("AHDSR");
		expect(cmd.alias).toBe("MyEnv");
		expect(cmd.parent).toBe("Master Chain");
		expect(cmd.chain).toBe("gain");
	});

	it("rejects malformed add (no type)", () => {
		const result = parseSingleCommand("add");
		expect("error" in result).toBe(true);
	});
});

// ── Parser tests — clone ────────────────────────────────────────────

describe("builder parser — clone commands", () => {
	it("parses simple clone", () => {
		const cmd = parseOk("clone SineSynth1") as CloneCommand;
		expect(cmd.type).toBe("clone");
		expect(cmd.source).toBe("SineSynth1");
		expect(cmd.count).toBe(1);
	});

	it("parses clone with count", () => {
		const cmd = parseOk("clone SineSynth1 x4") as CloneCommand;
		expect(cmd.source).toBe("SineSynth1");
		expect(cmd.count).toBe(4);
	});

	it("parses clone with quoted source", () => {
		const cmd = parseOk('clone "Sampler 1" x3') as CloneCommand;
		expect(cmd.source).toBe("Sampler 1");
		expect(cmd.count).toBe(3);
	});

	it("parses clone with multi-word source", () => {
		const cmd = parseOk("clone Sampler Layer x2") as CloneCommand;
		// "Sampler" and "Layer" are both identifiers, consumed by targetRef
		// But x2 is XCount — so targetRef gets "Sampler Layer"
		expect(cmd.source).toBe("Sampler Layer");
		expect(cmd.count).toBe(2);
	});
});

// ── Parser tests — remove ───────────────────────────────────────────

describe("builder parser — remove commands", () => {
	it("parses remove", () => {
		const cmd = parseOk("remove SineSynth1") as RemoveCommand;
		expect(cmd.type).toBe("remove");
		expect(cmd.target).toBe("SineSynth1");
	});

	it("parses remove with multi-word target", () => {
		const cmd = parseOk("remove Master Chain") as RemoveCommand;
		expect(cmd.target).toBe("Master Chain");
	});

	it("parses remove with quoted target", () => {
		const cmd = parseOk('remove "Pad Osc 1"') as RemoveCommand;
		expect(cmd.target).toBe("Pad Osc 1");
	});
});

// ── Parser tests — move ─────────────────────────────────────────────

describe("builder parser — move commands", () => {
	it("parses move with chain", () => {
		const cmd = parseOk("move LFO1 to SineSynth1.gain") as MoveCommand;
		expect(cmd.type).toBe("move");
		expect(cmd.target).toBe("LFO1");
		expect(cmd.parent).toBe("SineSynth1");
		expect(cmd.chain).toBe("gain");
	});

	it("parses move without chain", () => {
		const cmd = parseOk("move SineSynth1 to MasterChain") as MoveCommand;
		expect(cmd.target).toBe("SineSynth1");
		expect(cmd.parent).toBe("MasterChain");
		expect(cmd.chain).toBeUndefined();
	});

	it("parses move with multi-word identifiers", () => {
		// "move Master Chain to Synth Layer" — but "to" is a keyword!
		// targetRef for source eats "Master Chain", then To, then targetRef for parent eats "Synth Layer"
		const cmd = parseOk("move Master Chain to Synth Layer") as MoveCommand;
		expect(cmd.target).toBe("Master Chain");
		expect(cmd.parent).toBe("Synth Layer");
	});
});

// ── Parser tests — rename ───────────────────────────────────────────

describe("builder parser — rename commands", () => {
	it("parses rename", () => {
		const cmd = parseOk('rename SineSynth1 to "My Sine"') as RenameCommand;
		expect(cmd.type).toBe("rename");
		expect(cmd.target).toBe("SineSynth1");
		expect(cmd.name).toBe("My Sine");
	});

	it("parses rename with multi-word target", () => {
		const cmd = parseOk('rename Master Chain to "Main Chain"') as RenameCommand;
		expect(cmd.target).toBe("Master Chain");
		expect(cmd.name).toBe("Main Chain");
	});

	it("parses rename with bare identifier name", () => {
		const cmd = parseOk("rename SineSynth1 to MySine") as RenameCommand;
		expect(cmd.target).toBe("SineSynth1");
		expect(cmd.name).toBe("MySine");
	});

	it("parses rename with multi-word bare name", () => {
		const cmd = parseOk("rename SineSynth1 to My Sine") as RenameCommand;
		expect(cmd.target).toBe("SineSynth1");
		expect(cmd.name).toBe("My Sine");
	});
});

// ── Parser tests — set ──────────────────────────────────────────────

describe("builder parser — set commands", () => {
	it("parses set with number value", () => {
		const cmd = parseOk("set AHDSR.Attack 100") as SetCommand;
		expect(cmd.type).toBe("set");
		expect(cmd.target).toBe("AHDSR");
		expect(cmd.param).toBe("Attack");
		expect(cmd.value).toBe(100);
	});

	it("parses set with 'to' keyword", () => {
		const cmd = parseOk("set AHDSR.Attack to 200") as SetCommand;
		expect(cmd.param).toBe("Attack");
		expect(cmd.value).toBe(200);
	});

	it("parses set with decimal value", () => {
		const cmd = parseOk("set AHDSR.DecayCurve 0.5") as SetCommand;
		expect(cmd.value).toBe(0.5);
	});

	it("parses set with string value", () => {
		const cmd = parseOk('set Sampler1.PreloadSize "8192"') as SetCommand;
		expect(cmd.value).toBe("8192");
	});

	it("parses set with identifier value", () => {
		const cmd = parseOk("set Sampler1.Mode Disk") as SetCommand;
		expect(cmd.value).toBe("Disk");
	});

	it("parses set with multi-word target", () => {
		const cmd = parseOk("set Master Chain.Volume to 0.5") as SetCommand;
		expect(cmd.target).toBe("Master Chain");
		expect(cmd.param).toBe("Volume");
		expect(cmd.value).toBe(0.5);
	});

	it("parses set with quoted target", () => {
		const cmd = parseOk('set "Pad Osc 1".Detune to 0.25') as SetCommand;
		expect(cmd.target).toBe("Pad Osc 1");
		expect(cmd.param).toBe("Detune");
	});

	it("parses set with three-word target containing number", () => {
		const cmd = parseOk('set "Pad Osc 1".Volume to 0.5') as SetCommand;
		expect(cmd.target).toBe("Pad Osc 1");
		expect(cmd.param).toBe("Volume");
	});
});

// ── Parser tests — load ─────────────────────────────────────────────

describe("builder parser — load commands", () => {
	it("parses load into", () => {
		const cmd = parseOk('load "MyReverb" into ScriptFX1') as LoadCommand;
		expect(cmd.type).toBe("load");
		expect(cmd.source).toBe("MyReverb");
		expect(cmd.target).toBe("ScriptFX1");
	});

	it("parses load into multi-word target with number", () => {
		const cmd = parseOk('load "MyNetwork" into "Script FX 1"') as LoadCommand;
		expect(cmd.source).toBe("MyNetwork");
		expect(cmd.target).toBe("Script FX 1");
	});

	it("parses load with bare identifier source", () => {
		const cmd = parseOk("load MyReverb into ScriptFX1") as LoadCommand;
		expect(cmd.source).toBe("MyReverb");
		expect(cmd.target).toBe("ScriptFX1");
	});
});

// ── Parser tests — bypass/enable ────────────────────────────────────

describe("builder parser — bypass/enable commands", () => {
	it("parses bypass", () => {
		const cmd = parseOk("bypass SineSynth1") as BypassCommand;
		expect(cmd.type).toBe("bypass");
		expect(cmd.target).toBe("SineSynth1");
	});

	it("parses enable", () => {
		const cmd = parseOk("enable SineSynth1") as EnableCommand;
		expect(cmd.type).toBe("enable");
		expect(cmd.target).toBe("SineSynth1");
	});

	it("parses bypass with multi-word target", () => {
		const cmd = parseOk("bypass Master Chain") as BypassCommand;
		expect(cmd.target).toBe("Master Chain");
	});
});

// ── Parser tests — show ─────────────────────────────────────────────

describe("builder parser — show commands", () => {
	it("parses show tree", () => {
		const cmd = parseOk("show tree") as ShowCommand;
		expect(cmd.type).toBe("show");
		expect(cmd.what).toBe("tree");
	});

	it("parses show types", () => {
		const cmd = parseOk("show types") as ShowCommand;
		expect(cmd.what).toBe("types");
	});

	it("parses show types with filter", () => {
		const cmd = parseOk("show types synth") as ShowCommand;
		expect(cmd.what).toBe("types");
		expect(cmd.filter).toBe("synth");
	});

	it("parses show target", () => {
		const cmd = parseOk("show SineSynth1") as ShowCommand;
		expect(cmd.what).toBe("target");
		expect(cmd.target).toBe("SineSynth1");
	});

	it("parses show target with multi-word", () => {
		const cmd = parseOk("show Master Chain") as ShowCommand;
		expect(cmd.what).toBe("target");
		expect(cmd.target).toBe("Master Chain");
	});

	it("is case insensitive", () => {
		const cmd = parseOk("SHOW TREE") as ShowCommand;
		expect(cmd.what).toBe("tree");
	});
});

// ── Parser tests — error cases ──────────────────────────────────────

describe("builder parser — error cases", () => {
	it("rejects empty input", () => {
		const result = parseBuilderInput("");
		expect("error" in result).toBe(true);
	});

	it("rejects unknown verb", () => {
		const result = parseSingleCommand("delete AHDSR");
		expect("error" in result).toBe(true);
	});
});

// ── Comma chaining tests ────────────────────────────────────────────

describe("builder parser — comma chaining", () => {
	it("chains multiple explicit commands", () => {
		const cmds = parseChainOk("add SineSynth, add LFO to SineSynth1");
		expect(cmds).toHaveLength(2);
		expect(cmds[0].type).toBe("add");
		expect(cmds[1].type).toBe("add");
		expect((cmds[1] as AddCommand).parent).toBe("SineSynth1");
	});

	it("inherits verb from previous command", () => {
		const cmds = parseChainOk('add SineSynth, SineSynth2 as "Second"');
		expect(cmds).toHaveLength(2);
		expect(cmds[0].type).toBe("add");
		expect(cmds[1].type).toBe("add");
		expect((cmds[1] as AddCommand).alias).toBe("Second");
	});

	it("switches verb mid-chain", () => {
		const cmds = parseChainOk('add SineSynth as "Funky", set Funky.Volume to 0.5');
		expect(cmds).toHaveLength(2);
		expect(cmds[0].type).toBe("add");
		expect(cmds[1].type).toBe("set");
		expect((cmds[1] as SetCommand).target).toBe("Funky");
	});

	it("inherits set target (no dot = same target)", () => {
		const cmds = parseChainOk("set Master Chain.Volume to 0.5, Pan to 10");
		expect(cmds).toHaveLength(2);
		expect((cmds[0] as SetCommand).target).toBe("Master Chain");
		expect((cmds[0] as SetCommand).param).toBe("Volume");
		expect((cmds[1] as SetCommand).target).toBe("Master Chain");
		expect((cmds[1] as SetCommand).param).toBe("Pan");
		expect((cmds[1] as SetCommand).value).toBe(10);
	});

	it("set with dot overrides inherited target", () => {
		const cmds = parseChainOk("set Master Chain.Volume to 0.5, LFO.FadeIn to 100");
		expect(cmds).toHaveLength(2);
		expect((cmds[0] as SetCommand).target).toBe("Master Chain");
		expect((cmds[1] as SetCommand).target).toBe("LFO");
		expect((cmds[1] as SetCommand).param).toBe("FadeIn");
	});

	it("handles quoted strings in comma segments", () => {
		const cmds = parseChainOk('add SineSynth as "My Sine", remove "Old Sine"');
		expect(cmds).toHaveLength(2);
		expect((cmds[0] as AddCommand).alias).toBe("My Sine");
		expect((cmds[1] as RemoveCommand).target).toBe("Old Sine");
	});

	it("errors on segment without verb and no prior verb", () => {
		const result = parseBuilderInput("SineSynth");
		expect("error" in result).toBe(true);
	});

	it("errors on set target inheritance without prior target", () => {
		// First segment has no verb, no prior context
		const result = parseBuilderInput("Volume to 0.5");
		expect("error" in result).toBe(true);
	});
});

// ── Validation tests ────────────────────────────────────────────────

describe("validateAddCommand", () => {
	it("accepts valid module type", () => {
		const result = validateAddCommand(
			{ type: "add", moduleType: "AHDSR" },
			moduleList,
		);
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	it("accepts all 79 module types", () => {
		for (const mod of moduleList.modules) {
			const result = validateAddCommand(
				{ type: "add", moduleType: mod.id },
				moduleList,
			);
			expect(result.valid).toBe(true);
		}
	});

	it("accepts spaceless CamelCase form of pretty name (HiseScript identifier style)", () => {
		const result = validateAddCommand(
			{ type: "add", moduleType: "ParametriqEQ" },
			moduleList,
		);
		expect(result.valid).toBe(true);
	});

	it("accepts spaceless form for multi-word pretty names", () => {
		const result = validateAddCommand(
			{ type: "add", moduleType: "AHDSREnvelope" },
			moduleList,
		);
		expect(result.valid).toBe(true);
	});

	it("rejects unknown module type", () => {
		const result = validateAddCommand(
			{ type: "add", moduleType: "FakeModule" },
			moduleList,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("Unknown module type");
	});

	it("suggests closest match for typo", () => {
		const result = validateAddCommand(
			{ type: "add", moduleType: "AHDRS" },
			moduleList,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("Did you mean");
		expect(result.errors[0]).toContain("AHDSR Envelope");
	});

	it("suggests for common misspellings", () => {
		const cases = [
			{ input: "StreamingSamplr", expected: "Sampler" },
			{ input: "SimplGain", expected: "Simple Gain" },
			{ input: "LFOx", expected: "LFO Modulator" },
		];

		for (const { input, expected } of cases) {
			const result = validateAddCommand(
				{ type: "add", moduleType: input },
				moduleList,
			);
			expect(result.valid).toBe(false);
			expect(result.suggestions).toContain(expected);
		}
	});
});

describe("validateAddCommand — chain constraints", () => {
	it("rejects effect in midi chain", () => {
		const result = validateAddCommand(
			{ type: "add", moduleType: "SimpleGain", chain: "midi" },
			moduleList,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("not a MidiProcessor");
	});

	it("rejects modulator in fx chain", () => {
		const result = validateAddCommand(
			{ type: "add", moduleType: "AHDSR", chain: "fx" },
			moduleList,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("not an Effect");
	});

	it("rejects effect in children chain", () => {
		const result = validateAddCommand(
			{ type: "add", moduleType: "SimpleReverb", chain: "children" },
			moduleList,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("not a SoundGenerator");
	});

	it("rejects sound generator in gain chain", () => {
		const result = validateAddCommand(
			{ type: "add", moduleType: "SineSynth", chain: "gain" },
			moduleList,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("not a Modulator");
	});

	it("accepts modulator in gain chain", () => {
		const result = validateAddCommand(
			{ type: "add", moduleType: "AHDSR", chain: "gain" },
			moduleList,
		);
		expect(result.valid).toBe(true);
	});

	it("accepts effect in fx chain", () => {
		const result = validateAddCommand(
			{ type: "add", moduleType: "SimpleReverb", chain: "fx" },
			moduleList,
		);
		expect(result.valid).toBe(true);
	});

	it("accepts midi processor in midi chain", () => {
		const result = validateAddCommand(
			{ type: "add", moduleType: "ReleaseTrigger", chain: "midi" },
			moduleList,
		);
		expect(result.valid).toBe(true);
	});

	it("accepts sound generator in children chain", () => {
		const result = validateAddCommand(
			{ type: "add", moduleType: "SineSynth", chain: "children" },
			moduleList,
		);
		expect(result.valid).toBe(true);
	});

	it("rejects excluded effect via fx_constrainer", () => {
		const result = validateAddCommand(
			{ type: "add", moduleType: "HardcodedPolyphonicFX", parent: "SynthChain", chain: "fx" },
			moduleList,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("cannot be added");
	});

	it("accepts matching effect via fx_constrainer", () => {
		const result = validateAddCommand(
			{ type: "add", moduleType: "SimpleReverb", parent: "SynthChain", chain: "fx" },
			moduleList,
		);
		expect(result.valid).toBe(true);
	});

	it("validates modulation chain constrainer on parent", () => {
		const result = validateAddCommand(
			{ type: "add", moduleType: "Velocity", parent: "AHDSR", chain: "gain" },
			moduleList,
		);
		expect(result.valid).toBe(true);
	});

	it("rejects wrong modulator subtype for constrainer", () => {
		const result = validateAddCommand(
			{ type: "add", moduleType: "AHDSR", parent: "SynthChain", chain: "gain" },
			moduleList,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("cannot be added");
	});
});

describe("validateSetCommand", () => {
	it("accepts valid parameter and value", () => {
		const result = validateSetCommand(
			{ type: "set", target: "AHDSR", param: "Attack", value: 100 },
			moduleList,
		);
		expect(result.valid).toBe(true);
	});

	it("rejects unknown parameter", () => {
		const result = validateSetCommand(
			{ type: "set", target: "AHDSR", param: "FakeParam", value: 100 },
			moduleList,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("Unknown parameter");
	});

	it("suggests closest parameter for typo", () => {
		const result = validateSetCommand(
			{ type: "set", target: "AHDSR", param: "Attck", value: 100 },
			moduleList,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("Did you mean");
		expect(result.errors[0]).toContain("Attack");
	});

	it("rejects value out of range", () => {
		const result = validateSetCommand(
			{ type: "set", target: "AHDSR", param: "Attack", value: 50000 },
			moduleList,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("out of range");
		expect(result.errors[0]).toContain("0");
		expect(result.errors[0]).toContain("20000");
	});

	it("accepts value at range boundary", () => {
		const result = validateSetCommand(
			{ type: "set", target: "AHDSR", param: "Attack", value: 0 },
			moduleList,
		);
		expect(result.valid).toBe(true);

		const result2 = validateSetCommand(
			{ type: "set", target: "AHDSR", param: "Attack", value: 20000 },
			moduleList,
		);
		expect(result2.valid).toBe(true);
	});

	it("skips validation for unknown target module", () => {
		const result = validateSetCommand(
			{ type: "set", target: "UnknownModule", param: "Whatever", value: 42 },
			moduleList,
		);
		expect(result.valid).toBe(true);
	});

	it("accepts string values without range check", () => {
		const result = validateSetCommand(
			{ type: "set", target: "AHDSR", param: "Attack", value: "fast" },
			moduleList,
		);
		expect(result.valid).toBe(true);
	});
});

// ── BuilderMode integration ─────────────────────────────────────────

describe("BuilderMode", () => {
	it("has correct identity", () => {
		const mode = new BuilderMode();
		expect(mode.id).toBe("builder");
		expect(mode.name).toBe("Builder");
		expect(mode.accent).toBe("#fd971f");
	});

	it("parses and validates add commands", async () => {
		const mode = new BuilderMode(moduleList);
		const result = await mode.parse("add AHDSR", nullSession);
		expect(result.type).toBe("text");
		if (result.type === "text") {
			expect(result.content).toContain("add AHDSR");
		}
	});

	it("returns error for invalid module type", async () => {
		const mode = new BuilderMode(moduleList);
		const result = await mode.parse("add FakeModule", nullSession);
		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.message).toContain("Unknown module type");
		}
	});

	it("returns suggestion for typo", async () => {
		const mode = new BuilderMode(moduleList);
		const result = await mode.parse("add AHDRS", nullSession);
		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.message).toContain("Did you mean");
		}
	});

	it("show types returns table of all modules", async () => {
		const mode = new BuilderMode(moduleList);
		const result = await mode.parse("show types", nullSession);
		expect(result.type).toBe("table");
		if (result.type === "table") {
			expect(result.rows).toHaveLength(79);
		}
	});

	it("validates set parameter range", async () => {
		const mode = new BuilderMode(moduleList);
		const result = await mode.parse("set AHDSR.Attack 50000", nullSession);
		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.message).toContain("out of range");
		}
	});

	it("accepts valid set command", async () => {
		const mode = new BuilderMode(moduleList);
		const result = await mode.parse("set AHDSR.Attack 100", nullSession);
		expect(result.type).toBe("text");
	});

	it("works without module data (skips validation)", async () => {
		const mode = new BuilderMode();
		const result = await mode.parse("add AHDSR", nullSession);
		expect(result.type).toBe("text");
		if (result.type === "text") {
			expect(result.content).toContain("no HISE connection");
		}
	});

	it("returns parse error for invalid syntax", async () => {
		const mode = new BuilderMode(moduleList);
		const result = await mode.parse("add", nullSession);
		expect(result.type).toBe("error");
	});

	it("handles new command types", async () => {
		const mode = new BuilderMode(moduleList);

		const clone = await mode.parse("clone SineSynth1 x3", nullSession);
		expect(clone.type).toBe("text");

		const remove = await mode.parse("remove SineSynth1", nullSession);
		expect(remove.type).toBe("text");

		const rename = await mode.parse('rename SineSynth1 to "My Sine"', nullSession);
		expect(rename.type).toBe("text");

		const bypass = await mode.parse("bypass SineSynth1", nullSession);
		expect(bypass.type).toBe("text");

		const enable = await mode.parse("enable SineSynth1", nullSession);
		expect(enable.type).toBe("text");

		const load = await mode.parse('load "MyReverb" into ScriptFX1', nullSession);
		expect(load.type).toBe("text");

		const move = await mode.parse("move SineSynth1 to MasterChain", nullSession);
		expect(move.type).toBe("text");
	});

	it("handles comma chaining in parse", async () => {
		const mode = new BuilderMode(moduleList);
		const result = await mode.parse("add SineSynth, add LFO", nullSession);
		// Returns last command's result
		expect(result.type).toBe("text");
	});

	it("prevents removing the root container", async () => {
		const tree = { label: "Master Chain", id: "Master Chain", children: [] };
		const mode = new BuilderMode(moduleList, undefined, undefined, tree);
		const result = await mode.parse("remove \"Master Chain\"", nullSession);
		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.message).toContain("Cannot remove the root container");
		}
	});

	it("prevents removing root container with any project name", async () => {
		const tree = { label: "My Project", id: "My Project", children: [] };
		const mode = new BuilderMode(moduleList, undefined, undefined, tree);
		const result = await mode.parse('remove "My Project"', nullSession);
		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.message).toContain("Cannot remove the root container");
		}
	});
});

// ── BuilderMode completion ──────────────────────────────────────────

describe("BuilderMode completion", () => {
	function createBuilderWithEngine(): BuilderMode {
		const engine = new CompletionEngine();
		engine.setDatasets(buildDatasets(moduleList, null, null));
		return new BuilderMode(moduleList, engine);
	}

	it("returns empty without engine", () => {
		const mode = new BuilderMode(moduleList);
		const result = mode.complete!("a", 1);
		expect(result.items).toHaveLength(0);
	});

	it("completes keywords for empty input", () => {
		const mode = createBuilderWithEngine();
		const result = mode.complete!("", 0);
		// 11 builder keywords + cd, ls, pwd = 14
		expect(result.items).toHaveLength(14);
		const labels = result.items.map((i) => i.label);
		expect(labels).toContain("add");
		expect(labels).toContain("clone");
		expect(labels).toContain("remove");
		expect(labels).toContain("set");
		expect(labels).toContain("show");
		expect(labels).toContain("bypass");
		expect(labels).toContain("enable");
	});

	it("completes keyword prefix", () => {
		const mode = createBuilderWithEngine();
		const result = mode.complete!("a", 1);
		// Fuzzy filter: "a" matches add, bypass, enable, load, rename, etc.
		expect(result.items.length).toBeGreaterThan(0);
		expect(result.items[0].label).toBe("add");
	});

	it("completes module types after 'add '", () => {
		const mode = createBuilderWithEngine();
		const result = mode.complete!("add AH", 6);
		expect(result.items.some((i) => i.detail === "AHDSR")).toBe(true);
	});

	it("completes show subcommands after 'show '", () => {
		const mode = createBuilderWithEngine();
		const result = mode.complete!("show ", 5);
		expect(result.items).toHaveLength(2);
		const labels = result.items.map((i) => i.label);
		expect(labels).toContain("tree");
		expect(labels).toContain("types");
	});

	it("completes show subcommand prefix", () => {
		const mode = createBuilderWithEngine();
		const result = mode.complete!("show tr", 7);
		expect(result.items).toHaveLength(1);
		expect(result.items[0].label).toBe("tree");
	});
});

// ── collectModuleIds tests ──────────────────────────────────────────

describe("collectModuleIds", () => {
	it("returns empty for null tree", () => {
		expect(collectModuleIds(null)).toEqual([]);
	});

	it("collects module nodes from a tree", () => {
		const tree: import("../../engine/result.js").TreeNode = {
			label: "Master", id: "Master", type: "SynthChain", nodeKind: "module",
			children: [
				{ label: "Gain Modulation", id: "Gain Modulation", nodeKind: "chain", children: [
					{ label: "LFO1", id: "LFO1", type: "LFO", nodeKind: "module" },
				]},
				{ label: "Osc 1", id: "Osc 1", type: "SineSynth", nodeKind: "module" },
			],
		};
		const ids = collectModuleIds(tree);
		expect(ids).toHaveLength(3);
		expect(ids.map(m => m.id)).toEqual(["Master", "LFO1", "Osc 1"]);
		expect(ids.map(m => m.type)).toEqual(["SynthChain", "LFO", "SineSynth"]);
	});

	it("skips chain nodes", () => {
		const tree: import("../../engine/result.js").TreeNode = {
			label: "Master", id: "Master", type: "SynthChain", nodeKind: "module",
			children: [
				{ label: "FX Chain", id: "FX Chain", nodeKind: "chain" },
			],
		};
		const ids = collectModuleIds(tree);
		expect(ids).toHaveLength(1); // only Master
	});
});

// ── Instance ID completion tests ────────────────────────────────────

describe("BuilderMode instance completion", () => {
	// Create a builder with a mock tree for instance completion
	function createBuilderWithTree(): BuilderMode {
		const engine = new CompletionEngine();
		engine.setDatasets(buildDatasets(moduleList, null, null));
		const tree: import("../../engine/result.js").TreeNode = {
			label: "Master Chain", id: "Master Chain", type: "SynthChain", nodeKind: "module",
			children: [
				{ label: "Gain Modulation", id: "Gain Modulation", nodeKind: "chain",
					chainConstrainer: "TimeVariantModulator", children: [
					{ label: "GainLFO", id: "GainLFO", type: "LFO", nodeKind: "module" },
				]},
				{ label: "FX Chain", id: "FX Chain", nodeKind: "chain", children: [
					{ label: "Reverb", id: "Reverb", type: "SimpleReverb", nodeKind: "module" },
				]},
				{ label: "Osc 1", id: "Osc 1", type: "SineSynth", nodeKind: "module", children: [
					{ label: "Gain Modulation", id: "Gain Modulation", nodeKind: "chain", children: [
						{ label: "Envelope", id: "Envelope", type: "AHDSR", nodeKind: "module" },
					]},
				]},
			],
		};
		const mode = new BuilderMode(moduleList, engine, undefined, tree);
		return mode;
	}

	it("completes module IDs after 'remove '", () => {
		const mode = createBuilderWithTree();
		const result = mode.complete!("remove ", 7);
		expect(result.items.length).toBeGreaterThan(0);
		const labels = result.items.map(i => i.label);
		expect(labels).toContain("Master Chain");
		expect(labels).toContain("Osc 1");
		expect(labels).toContain("Reverb");
		expect(labels).toContain("Envelope");
	});

	it("filters module IDs by prefix after 'remove '", () => {
		const mode = createBuilderWithTree();
		const result = mode.complete!("remove Rev", 10);
		expect(result.items.length).toBeGreaterThan(0);
		expect(result.items[0].label).toBe("Reverb");
	});

	it("completes module IDs after 'bypass '", () => {
		const mode = createBuilderWithTree();
		const result = mode.complete!("bypass ", 7);
		expect(result.items.length).toBeGreaterThan(0);
		expect(result.items.map(i => i.label)).toContain("Reverb");
	});

	it("completes module IDs after 'clone '", () => {
		const mode = createBuilderWithTree();
		const result = mode.complete!("clone ", 6);
		expect(result.items.length).toBeGreaterThan(0);
		expect(result.items.map(i => i.label)).toContain("Osc 1");
	});

	it("auto-quotes IDs with spaces in insertText", () => {
		const mode = createBuilderWithTree();
		const result = mode.complete!("remove ", 7);
		const masterItem = result.items.find(i => i.label === "Master Chain");
		expect(masterItem).toBeDefined();
		expect(masterItem!.insertText).toBe('"Master Chain"');

		const reverbItem = result.items.find(i => i.label === "Reverb");
		expect(reverbItem).toBeDefined();
		expect(reverbItem!.insertText).toBe("Reverb"); // no quotes needed
	});

	it("completes module IDs after 'add SineSynth to '", () => {
		const mode = createBuilderWithTree();
		const result = mode.complete!("add SineSynth to ", 17);
		expect(result.items.length).toBeGreaterThan(0);
		expect(result.items.map(i => i.label)).toContain("Master Chain");
	});

	it("completes module IDs after 'set '", () => {
		const mode = createBuilderWithTree();
		const result = mode.complete!("set ", 4);
		expect(result.items.length).toBeGreaterThan(0);
		expect(result.items.map(i => i.label)).toContain("Envelope");
		expect(result.items.map(i => i.label)).toContain("Osc 1");
	});

	it("completes parameters after 'set <instance>.' using instance-to-type resolution", () => {
		const mode = createBuilderWithTree();
		// "Envelope" is an AHDSR instance - should complete AHDSR params
		const result = mode.complete!("set Envelope.", 13);
		expect(result.items.length).toBeGreaterThan(0);
		const labels = result.items.map(i => i.label);
		expect(labels).toContain("Attack");
		expect(labels).toContain("Release");
		expect(result.label).toContain("Envelope");
	});

	it("completes parameters after 'set <multi-word-instance>.' with type resolution", () => {
		const mode = createBuilderWithTree();
		// "Osc 1" is a SineSynth - should complete SineSynth params
		const result = mode.complete!("set Osc 1.", 10);
		// Note: "Osc" then "1" - "1" is a NumberLiteral, but the lexer should handle this
		// The tokens would be: Set, Identifier(Osc), NumberLiteral(1), Dot
		// targetTokens = [Osc, 1] -> "Osc 1"
		expect(result.items.length).toBeGreaterThan(0);
	});

	it("includes show subcommands AND module IDs after 'show '", () => {
		const mode = createBuilderWithTree();
		const result = mode.complete!("show ", 5);
		const labels = result.items.map(i => i.label);
		// Show subcommands
		expect(labels).toContain("tree");
		expect(labels).toContain("types");
		// Module IDs
		expect(labels).toContain("Reverb");
	});

	it("returns no items without a tree", () => {
		const engine = new CompletionEngine();
		engine.setDatasets(buildDatasets(moduleList, null, null));
		const mode = new BuilderMode(moduleList, engine);
		// No tree set - instance completion returns empty
		const result = mode.complete!("remove ", 7);
		expect(result.items).toHaveLength(0);
	});
});

// ── resolveChainIndex — modulation chain lookup ─────────────────────

describe("resolveChainIndex", () => {
	const synthChainNode: TreeNode = { type: "SynthChain", label: "Master Chain", nodeKind: "module" };
	const waveSynthNode: TreeNode = { type: "WaveSynth", label: "Waveform Generator", nodeKind: "module" };
	const envelopeNode: TreeNode = { type: "SimpleEnvelope", label: "DefaultEnvelope", nodeKind: "module" };
	const gmcNode: TreeNode = { type: "GlobalModulatorContainer", label: "GMC", nodeKind: "module" };

	it("resolves cross-cutting names without a parent", () => {
		expect(resolveChainIndex("children", undefined, null, moduleList)).toBe(-1);
		expect(resolveChainIndex("midi", undefined, null, moduleList)).toBe(0);
		expect(resolveChainIndex("fx", undefined, null, moduleList)).toBe(3);
	});

	it("resolves standard modulation chains from parent definition", () => {
		expect(resolveChainIndex("gain", undefined, synthChainNode, moduleList)).toBe(1);
		expect(resolveChainIndex("pitch", undefined, synthChainNode, moduleList)).toBe(2);
		expect(resolveChainIndex("Gain Modulation", undefined, synthChainNode, moduleList)).toBe(1);
	});

	it("resolves non-standard modulation chains by name", () => {
		// WaveSynth: Mix=4, Osc2 Pitch=5 (non-sequential, after FX=3)
		expect(resolveChainIndex("Mix", undefined, waveSynthNode, moduleList)).toBe(4);
		expect(resolveChainIndex("mix modulation", undefined, waveSynthNode, moduleList)).toBe(4);
		expect(resolveChainIndex("Osc2 Pitch", undefined, waveSynthNode, moduleList)).toBe(5);
		expect(resolveChainIndex("osc2pitchmodulation", undefined, waveSynthNode, moduleList)).toBe(5);
	});

	it("resolves modulation chains by modulationMode (GlobalModulatorContainer)", () => {
		// GMC's chain id "Global Modulators" doesn't contain "gain", but
		// modulationMode="gain" must still resolve. Same for pitch chain.
		expect(resolveChainIndex("gain", undefined, gmcNode, moduleList)).toBe(1);
		expect(resolveChainIndex("pitch", undefined, gmcNode, moduleList)).toBe(2);
	});

	it("resolves internal modulator chains (Modulator parent)", () => {
		// SimpleEnvelope: AttackTimeModulation=0
		expect(resolveChainIndex("AttackTime", undefined, envelopeNode, moduleList)).toBe(0);
		expect(resolveChainIndex("AttackTimeModulation", undefined, envelopeNode, moduleList)).toBe(0);
	});

	it("falls back to numeric chain index", () => {
		expect(resolveChainIndex("4", undefined, waveSynthNode, moduleList)).toBe(4);
	});

	it("returns -1 for unknown chain name", () => {
		expect(resolveChainIndex("nonexistent", undefined, waveSynthNode, moduleList)).toBe(-1);
	});
});

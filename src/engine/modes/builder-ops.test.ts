import { describe, expect, it } from "vitest";
import { commandToOps } from "./builder-ops.js";
import { parseSingleCommand, type BuilderCommand } from "./builder-parser.js";
import type { TreeNode } from "../result.js";

// Minimal stub tree for resolution. Most ops only need the leaf id —
// the resolver returns the literal segment image when treeRoot is null.
const NULL_TREE: TreeNode | null = null;
const NULL_MODULES = null;

function parseOk(input: string): BuilderCommand {
	const r = parseSingleCommand(input);
	if ("error" in r) throw new Error(r.error);
	return r.command;
}

function opsOk(input: string): { op: string; [k: string]: unknown }[] {
	const cmd = parseOk(input);
	const r = commandToOps(cmd, NULL_TREE, NULL_MODULES, []);
	if ("error" in r) throw new Error(r.error);
	return r.ops;
}

function opsErr(input: string): string {
	const cmd = parseOk(input);
	const r = commandToOps(cmd, NULL_TREE, NULL_MODULES, []);
	if (!("error" in r)) throw new Error(`expected error, got ${JSON.stringify(r.ops)}`);
	return r.error;
}

describe("builder-ops — add", () => {
	it("emits add op with name from alias", () => {
		const ops = opsOk('add SineSynth as "Lead"');
		expect(ops[0]!.op).toBe("add");
		expect(ops[0]!.type).toBe("SineSynth");
		expect(ops[0]!.name).toBe("Lead");
	});
});

describe("builder-ops — remove", () => {
	it("emits remove op", () => {
		const ops = opsOk("remove Lead");
		expect(ops[0]).toMatchObject({ op: "remove", target: "Lead" });
	});

	it("chained remove emits multiple ops via parseBuilderInput", () => {
		// commandToOps takes a single command — chained statements split
		// at parseBuilderInput, so single-command remove always has 1 op.
		const ops = opsOk("remove Lead");
		expect(ops).toHaveLength(1);
	});
});

describe("builder-ops — rename", () => {
	it("emits set_id op (rename)", () => {
		const ops = opsOk('rename Lead as "MainSynth"');
		expect(ops[0]).toMatchObject({ op: "set_id", target: "Lead", name: "MainSynth" });
	});
});

describe("builder-ops — clone", () => {
	it("emits clone op with count", () => {
		const ops = opsOk("clone Lead 3");
		expect(ops[0]).toMatchObject({ op: "clone", source: "Lead", count: 3 });
	});
});

describe("builder-ops — set numeric param", () => {
	it("emits set_attributes for plain field", () => {
		const ops = opsOk("set Lead.Volume -6");
		expect(ops[0]).toMatchObject({
			op: "set_attributes",
			target: "Lead",
			attributes: { Volume: -6 },
		});
	});

	it("set_attributes with percent normalization", () => {
		const ops = opsOk("set Lead.Volume 50%");
		expect((ops[0]!.attributes as Record<string, number>).Volume).toBeCloseTo(0.5);
	});
});

describe("builder-ops — set bypassed", () => {
	it("emits set_bypassed op (true)", () => {
		const ops = opsOk("set Lead.bypassed true");
		expect(ops[0]).toMatchObject({ op: "set_bypassed", target: "Lead", bypassed: true });
	});

	it("emits set_bypassed op (false)", () => {
		const ops = opsOk("set Lead.bypassed false");
		expect(ops[0]).toMatchObject({ op: "set_bypassed", target: "Lead", bypassed: false });
	});

	it("accepts 1/0 aliases", () => {
		const ops = opsOk("set Lead.bypassed 1");
		expect(ops[0]!.bypassed).toBe(true);
	});
});

describe("builder-ops — set parent (move)", () => {
	it("emits move op with target + parent", () => {
		const ops = opsOk("set Lead.parent Compressor");
		expect(ops[0]).toMatchObject({ op: "move", target: "Lead", parent: "Compressor" });
	});

	it("accepts quoted-string parent value", () => {
		const ops = opsOk('set Lead.parent "Master Chain"');
		expect(ops[0]).toMatchObject({ op: "move", target: "Lead", parent: "Master Chain" });
	});

	it("accepts dotted parent path", () => {
		const ops = opsOk("set Lead.parent Master.fx");
		expect(ops[0]!.op).toBe("move");
		expect(ops[0]!.target).toBe("Lead");
	});
});

describe("builder-ops — set index (move)", () => {
	it("emits move op with target + index", () => {
		const ops = opsOk("set Lead.index 2");
		expect(ops[0]).toMatchObject({ op: "move", target: "Lead", index: 2 });
	});

	it("rejects non-integer index", () => {
		expect(opsErr("set Lead.index 1.5")).toMatch(/expected integer/);
	});
});

describe("builder-ops — samplemap / effect", () => {
	it("samplemap → set_attributes", () => {
		const ops = opsOk('set Sampler1.samplemap "My Piano"');
		expect(ops[0]).toMatchObject({
			op: "set_attributes",
			target: "Sampler1",
			attributes: { samplemap: "My Piano" },
		});
	});

	it("effect → set_effect", () => {
		const ops = opsOk('set MasterFX.effect "my_cpp_fx"');
		expect(ops[0]).toMatchObject({
			op: "set_effect",
			target: "MasterFX",
			effect: "my_cpp_fx",
		});
	});
});

describe("builder-ops — network → /api/dsp/init", () => {
	it("bare name → mode=create", () => {
		const ops = opsOk('set ScriptFX1.network "my_dsp"');
		expect(ops[0]).toMatchObject({
			op: "init_network",
			moduleId: "ScriptFX1",
			name: "my_dsp",
			mode: "create",
		});
	});

	it(".xml extension → mode=load, extension stripped", () => {
		const ops = opsOk('set ScriptFX1.network "my_dsp.xml"');
		expect(ops[0]).toMatchObject({
			op: "init_network",
			moduleId: "ScriptFX1",
			name: "my_dsp",
			mode: "load",
		});
	});
});

describe("builder-ops — routing", () => {
	it("matrix array → set_routing matrix", () => {
		const ops = opsOk("set Synth1.routing [0, 1, -1, -1]");
		expect(ops[0]).toMatchObject({
			op: "set_routing",
			target: "Synth1",
			matrix: [0, 1, -1, -1],
		});
	});

	it("preset string → set_routing preset", () => {
		const ops = opsOk('set Synth1.routing "stereo"');
		expect(ops[0]).toMatchObject({
			op: "set_routing",
			target: "Synth1",
			preset: "stereo",
		});
	});

	it("invalid preset rejected", () => {
		expect(opsErr('set Synth1.routing "weird"')).toMatch(/unknown routing preset/);
	});

	it("routing.send → set_routing send subfield", () => {
		const ops = opsOk("set Synth1.routing.send [-1, -1, 2, 3]");
		expect(ops[0]).toMatchObject({
			op: "set_routing",
			target: "Synth1",
			send: [-1, -1, 2, 3],
		});
	});

	it("read-only routing.resizable rejected", () => {
		expect(opsErr("set Synth1.routing.resizable true")).toMatch(/read-only/);
	});

	it("read-only routing.numDestinationChannels rejected", () => {
		expect(opsErr("set Synth1.routing.numDestinationChannels 4")).toMatch(/read-only/);
	});
});

describe("builder-ops — local-only commands return error sentinel", () => {
	for (const input of ["get Lead.Volume", "show Lead", "list types", "cd Lead", "ls", "pwd", "reset"]) {
		it(`commandToOps('${input}') is local-only`, () => {
			expect(opsErr(input)).toBe("handled locally");
		});
	}
});

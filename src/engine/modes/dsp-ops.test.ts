import { describe, expect, it } from "vitest";
import { commandToDspOps } from "./dsp-ops.js";
import { parseSingleDspCommand, type DspCommand } from "./dsp-parser.js";
import type { RawDspNode } from "../../mock/contracts/dsp.js";

const NULL_RAW: RawDspNode | null = null;

function parseOk(input: string): DspCommand {
	const r = parseSingleDspCommand(input);
	if ("error" in r) throw new Error(r.error);
	return r.command;
}

function opsOk(
	input: string,
	raw: RawDspNode | null = NULL_RAW,
	cwd: string[] = [],
): { op: string; [k: string]: unknown }[] {
	const cmd = parseOk(input);
	const r = commandToDspOps(cmd, raw, null, cwd);
	if ("error" in r) throw new Error(r.error);
	return r.ops;
}

function opsErr(
	input: string,
	raw: RawDspNode | null = NULL_RAW,
	cwd: string[] = [],
): string {
	const cmd = parseOk(input);
	const r = commandToDspOps(cmd, raw, null, cwd);
	if (!("error" in r)) throw new Error(`expected error, got ${JSON.stringify(r.ops)}`);
	return r.error;
}

// Minimal raw fixture with one parent + child for parent/index lookups.
const TREE_FIXTURE: RawDspNode = {
	nodeId: "MyDSP",
	factoryPath: "container.chain",
	bypassed: false,
	parameters: [],
	properties: [],
	connections: [],
	children: [
		{
			nodeId: "Container",
			factoryPath: "container.chain",
			bypassed: false,
			parameters: [],
			properties: [],
			connections: [],
			children: [
				{
					nodeId: "g1",
					factoryPath: "core.gain",
					bypassed: false,
					parameters: [],
					properties: [],
					connections: [],
					children: [],
				},
			],
		},
	],
};

describe("dsp-ops — add", () => {
	it("emits add op with factoryPath, parent, nodeId", () => {
		const ops = opsOk('add core.gain as "g1"', TREE_FIXTURE);
		expect(ops[0]).toMatchObject({
			op: "add",
			factoryPath: "core.gain",
			parent: "MyDSP",
			nodeId: "g1",
		});
	});

	it("uses cwd as parent when no `to`", () => {
		const ops = opsOk('add core.gain as "g1"', TREE_FIXTURE, ["Container"]);
		expect(ops[0]!.parent).toBe("Container");
	});
});

describe("dsp-ops — remove / rename", () => {
	it("remove emits remove op", () => {
		const ops = opsOk("remove g1");
		expect(ops[0]).toMatchObject({ op: "remove", nodeId: "g1" });
	});

	it("rename emits set_id op", () => {
		const ops = opsOk('rename g1 as "Gain1"');
		expect(ops[0]).toMatchObject({ op: "set_id", nodeId: "g1", newId: "Gain1" });
	});
});

describe("dsp-ops — set parameter value", () => {
	it("emits set with value", () => {
		const ops = opsOk("set g1.Gain 0.5");
		expect(ops[0]).toMatchObject({ op: "set", nodeId: "g1", parameterId: "Gain", value: 0.5 });
	});

	it("emits set with hex value", () => {
		const ops = opsOk("set g1.NodeColour 0xFF8800AA");
		expect(ops[0]!.value).toBe(0xFF8800AA);
	});

	it("emits set with boolean", () => {
		const ops = opsOk("set g1.SomeFlag true");
		expect(ops[0]!.value).toBe(true);
	});
});

describe("dsp-ops — set_complex_data", () => {
	it("emits an external data assignment with the default slot", () => {
		const ops = opsOk("set_complex_data Env.Table index 3");
		expect(ops[0]).toMatchObject({
			op: "set_complex_data",
			nodeId: "Env",
			dataType: "Table",
			slotIndex: 0,
			dataIndex: 3,
		});
	});

	it("emits an explicit slot and preserves embedded index", () => {
		const ops = opsOk("set_complex_data Env.SliderPack.2 index -1");
		expect(ops[0]).toMatchObject({ dataType: "SliderPack", slotIndex: 2, dataIndex: -1 });
	});

	it("rejects unsupported types and invalid indexes", () => {
		expect(opsErr("set_complex_data Env.Unknown index 1")).toMatch(/unsupported data type/);
		expect(opsErr("set_complex_data Env.Table.-1 index 1")).toMatch(/slot/);
		expect(opsErr("set_complex_data Env.Table index -2")).toMatch(/index/);
	});
});

describe("dsp-ops — set bypassed", () => {
	it("emits bypass op", () => {
		const ops = opsOk("set g1.bypassed true");
		expect(ops[0]).toMatchObject({ op: "bypass", nodeId: "g1", bypassed: true });
	});

	it("accepts numeric 1/0", () => {
		const ops = opsOk("set g1.bypassed 0");
		expect(ops[0]!.bypassed).toBe(false);
	});
});

describe("dsp-ops — set X.parent → move", () => {
	it("emits move op with new parent", () => {
		const ops = opsOk("set g1.parent NewContainer");
		expect(ops[0]).toMatchObject({ op: "move", nodeId: "g1", parent: "NewContainer" });
	});
});

describe("dsp-ops — set X.index → move w/ current parent", () => {
	it("looks up current parent and emits move w/ index", () => {
		const ops = opsOk("set g1.index 2", TREE_FIXTURE);
		expect(ops[0]).toMatchObject({ op: "move", nodeId: "g1", parent: "Container", index: 2 });
	});

	it("errors when tree unavailable", () => {
		expect(opsErr("set g1.index 2", null)).toMatch(/cannot determine current parent/);
	});
});

describe("dsp-ops — set X.p.range / sub-fields", () => {
	it("set X.p.range [a,b] emits set with min+max", () => {
		const ops = opsOk("set g1.Gain.range [0, 2]");
		expect(ops[0]).toMatchObject({
			op: "set", nodeId: "g1", parameterId: "Gain", min: 0, max: 2,
		});
	});

	it("set X.p.stepSize emits stepSize sub-field", () => {
		const ops = opsOk("set g1.Gain.stepSize 0.01");
		expect(ops[0]).toMatchObject({
			op: "set", nodeId: "g1", parameterId: "Gain", stepSize: 0.01,
		});
	});

	it("set X.p.middlePosition emits middlePosition sub-field", () => {
		const ops = opsOk("set g1.Gain.middlePosition 0.5");
		expect(ops[0]!.middlePosition).toBe(0.5);
	});

	it("set X.p.skewFactor emits skewFactor sub-field", () => {
		const ops = opsOk("set g1.Gain.skewFactor 0.3");
		expect(ops[0]!.skewFactor).toBe(0.3);
	});

	it("rejects 3-segment range with wrong arity", () => {
		expect(opsErr("set g1.Gain.range [0, 1, 2]")).toMatch(/expects \[min, max\]/);
	});

	it("rejects readonly source sub-field", () => {
		expect(opsErr("set g1.Gain.source x")).toMatch(/read-only/);
	});

	it("rejects unknown sub-field", () => {
		expect(opsErr("set g1.Gain.nope 1")).toMatch(/unknown sub-field/);
	});
});

describe("dsp-ops — connect / disconnect", () => {
	it("connect Lfo to g.Gain emits connect op", () => {
		const ops = opsOk("connect Lfo to g.Gain");
		expect(ops[0]).toMatchObject({ op: "connect", source: "Lfo", target: "g", parameter: "Gain" });
	});

	it("connect with sourceOutput and matched", () => {
		const ops = opsOk("connect xfader1.0 to g.Gain matched");
		expect(ops[0]).toMatchObject({
			op: "connect",
			source: "xfader1",
			sourceOutput: 0,
			target: "g",
			parameter: "Gain",
			matchRange: true,
		});
	});

	it("connect target without parameter (HISE auto-routes)", () => {
		const ops = opsOk("connect Lfo to g");
		expect(ops[0]).toMatchObject({ op: "connect", source: "Lfo", target: "g" });
		expect(ops[0]!.parameter).toBeUndefined();
	});

	it("disconnect target-only", () => {
		const ops = opsOk("disconnect g.Gain");
		expect(ops[0]).toMatchObject({ op: "disconnect", target: "g", parameter: "Gain" });
	});
});

describe("dsp-ops — create_parameter", () => {
	it("emits create_parameter with min/max", () => {
		const ops = opsOk("create_parameter root.Cutoff [20, 20000]");
		expect(ops[0]).toMatchObject({
			op: "create_parameter",
			nodeId: "root",
			parameterId: "Cutoff",
			min: 20,
			max: 20000,
		});
	});

	it("includes optional clauses", () => {
		const ops = opsOk("create_parameter root.Cutoff [20, 20000] default 1000 stepSize 0.1");
		expect(ops[0]!.defaultValue).toBe(1000);
		expect(ops[0]!.stepSize).toBe(0.1);
	});
});

describe("dsp-ops — reset / local-only commands", () => {
	it("reset emits clear op", () => {
		const ops = opsOk("reset");
		expect(ops[0]).toMatchObject({ op: "clear" });
	});

	for (const input of ["ls", "pwd", "save", "show g1", "show tree", "cd Container", "get g1.Gain", 'screenshot scale 1.0 file "out.png"']) {
		it(`commandToDspOps('${input}') is local-only`, () => {
			const ops = opsOk(input);
			expect(ops).toEqual([]);
		});
	}
});

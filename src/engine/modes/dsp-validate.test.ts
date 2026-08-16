import { describe, expect, it } from "vitest";
import type { RawDspNode } from "../../mock/contracts/dsp.js";
import type { ScriptnodeList } from "../data.js";
import { parseSingleDspCommand, type SetCommand } from "./dsp-parser.js";
import { validateSetCommand } from "./dsp-validate.js";

const scriptnodeFixture: ScriptnodeList = {
	"container.split": {
		id: "split",
		description: "",
		type: "monophonic",
		subtype: "",
		category: [],
		hasChildren: true,
		hasFX: false,
		constrainer: "*",
		metadataType: "static",
		hasMidi: false,
		properties: {},
		parameters: [],
		modulation: [],
		interfaces: [],
	},
};

const expandedDryWetTree: RawDspNode = {
	nodeId: "dry_wet_set_repro",
	factoryPath: "container.chain",
	bypassed: false,
	parameters: [],
	properties: [],
	connections: [],
	children: [
		{
			nodeId: "D",
			factoryPath: "container.split",
			bypassed: false,
			parameters: [{ parameterId: "DryWet", value: 0, min: 0, max: 1 }],
			properties: [],
			connections: [],
			children: [],
		},
	],
};

function parseSet(input: string): SetCommand {
	const parsed = parseSingleDspCommand(input);
	if ("error" in parsed) throw new Error(parsed.error);
	if (parsed.command.type !== "set") throw new Error(`expected set command, got ${parsed.command.type}`);
	return parsed.command;
}

describe("dsp validation — set", () => {
	it("accepts live parameters exposed by expanded template nodes", () => {
		const result = validateSetCommand(parseSet("set D.DryWet 0.35"), scriptnodeFixture, expandedDryWetTree);

		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("range-checks live parameters exposed by expanded template nodes", () => {
		const result = validateSetCommand(parseSet("set D.DryWet 2"), scriptnodeFixture, expandedDryWetTree);

		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("Value 2 out of range for D.DryWet (0-1).");
	});

	it("still rejects unknown parameters on expanded template nodes", () => {
		const result = validateSetCommand(parseSet("set D.Nope 0.35"), scriptnodeFixture, expandedDryWetTree);

		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain('Unknown parameter "Nope" on container.split.');
	});

	it("accepts ExternalModulation string sub-field writes", () => {
		const result = validateSetCommand(parseSet("set D.DryWet.ExternalModulation Combined"), scriptnodeFixture, expandedDryWetTree);

		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("rejects non-string ExternalModulation writes", () => {
		const result = validateSetCommand(parseSet("set D.DryWet.ExternalModulation [0, 1]"), scriptnodeFixture, expandedDryWetTree);

		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("expects a string value");
	});
});

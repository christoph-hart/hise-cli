import { describe, expect, it } from "vitest";
import { cleanDspParameterForLlm, normalizeDspTreeResponse } from "./dsp.js";

describe("normalizeDspTreeResponse", () => {
	it("preserves complex-data assignments", () => {
		const { raw } = normalizeDspTreeResponse({
			nodeId: "network",
			factoryPath: "container.chain",
			bypassed: false,
			parameters: [],
			complexData: [{ dataType: "Table", slotIndex: "0", dataIndex: "3" }],
			children: [],
		});
		expect(raw.complexData).toEqual([{ dataType: "Table", slotIndex: 0, dataIndex: 3 }]);
	});

	it("accepts numeric string parameter values from live HISE", () => {
		const { raw } = normalizeDspTreeResponse({
			nodeId: "network",
			factoryPath: "container.chain",
			bypassed: false,
			parameters: [],
			children: [{
				nodeId: "Filter1",
				factoryPath: "filters.svf",
				bypassed: false,
				parameters: [{ parameterId: "Frequency", value: "3500", min: "20.0", max: "20000.0" }],
				children: [],
			}],
		});
		expect(raw.children[0]!.parameters[0]!.value).toBe(3500);
		expect(raw.children[0]!.parameters[0]!.min).toBe(20);
		expect(raw.children[0]!.parameters[0]!.max).toBe(20000);
	});
});

describe("cleanDspParameterForLlm", () => {
	it("emits id, range, defaultValue, value", () => {
		const raw = {
			parameterId: "Gain",
			value: 0.5,
			min: 0,
			max: 1,
			stepSize: 0,
			defaultValue: 1,
		};
		const cleaned = cleanDspParameterForLlm(raw) as Record<string, unknown>;
		expect(cleaned).toEqual({
			id: "Gain",
			range: { min: 0, max: 1 },
			defaultValue: 1,
			value: 0.5,
		});
	});

	it("preserves middlePosition + stepSize when meaningful", () => {
		const raw = {
			parameterId: "Cutoff",
			value: 1000,
			min: 20,
			max: 20000,
			stepSize: 1,
			middlePosition: 1000,
			defaultValue: 1000,
		};
		const cleaned = cleanDspParameterForLlm(raw) as Record<string, unknown>;
		const range = cleaned.range as Record<string, number>;
		expect(range.stepSize).toBe(1);
		expect(range.middlePosition).toBe(1000);
	});

	it("preserves ExternalModulation", () => {
		const cleaned = cleanDspParameterForLlm({
			parameterId: "ModDepth",
			value: 0.5,
			externalModulation: "Combined",
		}) as Record<string, unknown>;

		expect(cleaned.externalModulation).toBe("Combined");
	});

	it("returns null for non-object inputs", () => {
		expect(cleanDspParameterForLlm(null)).toBeNull();
		expect(cleanDspParameterForLlm(123)).toBeNull();
	});
});

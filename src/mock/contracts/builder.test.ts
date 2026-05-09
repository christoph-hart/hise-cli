import { describe, expect, it } from "vitest";
import { cleanBuilderShowForLlm, cleanBuilderParameterForLlm } from "./builder.js";

describe("cleanBuilderShowForLlm", () => {
	it("strips parameter metadata to id-only list", () => {
		const raw = {
			id: "SineSynth",
			processorId: "Noice",
			prettyName: "Sine Wave Generator",
			bypassed: false,
			parameters: [
				{ id: "Gain", value: 0.25, valueAsString: "25%", range: { min: 0, max: 1 }, defaultValue: 0.25 },
				{ id: "Balance", value: 0, range: { min: -1, max: 1 }, defaultValue: 0 },
			],
			modulation: [],
			fx: [],
			midi: [],
		};
		const cleaned = cleanBuilderShowForLlm(raw) as Record<string, unknown>;
		expect(cleaned.id).toBe("Noice");
		expect(cleaned.type).toBe("SineSynth");
		expect(cleaned.prettyName).toBe("Sine Wave Generator");
		expect(cleaned.bypassed).toBe(false);
		expect(cleaned.parameters).toEqual(["Gain", "Balance"]);
		expect(cleaned.modulation).toBeUndefined();
		expect(cleaned.fx).toBeUndefined();
		expect(cleaned.midi).toBeUndefined();
	});

	it("recurses into modulation chains and keeps child param IDs", () => {
		const raw = {
			id: "SineSynth",
			processorId: "Noice",
			parameters: [{ id: "Gain" }],
			modulation: [
				{
					id: "Gain Modulation",
					modulationMode: "gain",
					constrainer: "*",
					children: [
						{
							id: "SimpleEnvelope",
							processorId: "DefaultEnvelope",
							parameters: [{ id: "Attack" }, { id: "Release" }],
							modulation: [
								{
									id: "AttackTimeModulation",
									modulationMode: "gain",
									constrainer: "VoiceStartModulator",
									children: [],
								},
							],
						},
					],
				},
				{ id: "Pitch Modulation", modulationMode: "pitch", children: [] },
			],
		};
		const cleaned = cleanBuilderShowForLlm(raw) as Record<string, unknown>;
		expect(cleaned.parameters).toEqual(["Gain"]);
		const mod = cleaned.modulation as Array<Record<string, unknown>>;
		expect(mod).toHaveLength(2);
		expect(mod[0]!.id).toBe("Gain Modulation");
		expect(mod[0]!.mode).toBe("gain");
		// "*" constrainer drops out — only meaningful constrainers stay.
		expect(mod[0]!.constrainer).toBeUndefined();
		const env = (mod[0]!.children as Array<Record<string, unknown>>)[0]!;
		expect(env.id).toBe("DefaultEnvelope");
		expect(env.type).toBe("SimpleEnvelope");
		expect(env.parameters).toEqual(["Attack", "Release"]);
		// Recursive mod chain on the envelope is preserved as a stub
		// (no children, so no further recursion).
		expect((env.modulation as Array<Record<string, unknown>>)[0]!.constrainer).toBe("VoiceStartModulator");
	});

	it("keeps routing matrix when present", () => {
		const raw = {
			id: "SineSynth",
			processorId: "Lead",
			parameters: [{ id: "Gain" }],
			routing: { matrix: [0, 1], send: [-1, -1], resizable: false, routable: true, numDestinationChannels: 2 },
		};
		const cleaned = cleanBuilderShowForLlm(raw) as Record<string, unknown>;
		expect(cleaned.routing).toEqual({ matrix: [0, 1] });
	});

	it("returns null for non-object inputs", () => {
		expect(cleanBuilderShowForLlm(null)).toBeNull();
		expect(cleanBuilderShowForLlm(42)).toBeNull();
	});
});

describe("cleanBuilderParameterForLlm", () => {
	it("emits id, range, defaultValue, value, valueAsString", () => {
		const raw = {
			parameterIndex: 0,
			id: "Gain",
			disabled: false,
			range: { min: 0, max: 1, stepSize: 0 },
			defaultValue: 0.25,
			chainIndex: 1,
			value: 0.25,
			valueNormalized: 0.25,
			valueAsString: "25%",
		};
		const cleaned = cleanBuilderParameterForLlm(raw) as Record<string, unknown>;
		expect(cleaned).toEqual({
			id: "Gain",
			range: { min: 0, max: 1 },
			defaultValue: 0.25,
			value: 0.25,
			valueAsString: "25%",
		});
	});

	it("preserves stepSize / middlePosition / skewFactor when meaningful", () => {
		const raw = {
			id: "Attack",
			range: { min: 0, max: 20000, stepSize: 0, middlePosition: 1000, skewFactor: 0.3 },
			defaultValue: 5,
			value: 5,
			valueAsString: "5ms",
		};
		const cleaned = cleanBuilderParameterForLlm(raw) as Record<string, unknown>;
		const range = cleaned.range as Record<string, number>;
		expect(range.middlePosition).toBe(1000);
		expect(range.skewFactor).toBeCloseTo(0.3);
		// stepSize=0 dropped (default no-step).
		expect(range.stepSize).toBeUndefined();
	});

	it("preserves items[] for enum params", () => {
		const raw = {
			id: "Mode",
			range: { min: 0, max: 1, stepSize: 1 },
			defaultValue: 0,
			items: ["Off", "On"],
			value: 0,
			valueAsString: "Off",
		};
		const cleaned = cleanBuilderParameterForLlm(raw) as Record<string, unknown>;
		expect(cleaned.items).toEqual(["Off", "On"]);
	});

	it("returns null for non-object inputs", () => {
		expect(cleanBuilderParameterForLlm(null)).toBeNull();
		expect(cleanBuilderParameterForLlm("string")).toBeNull();
	});
});

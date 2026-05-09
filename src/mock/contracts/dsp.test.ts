import { describe, expect, it } from "vitest";
import { cleanDspParameterForLlm } from "./dsp.js";

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

	it("returns null for non-object inputs", () => {
		expect(cleanDspParameterForLlm(null)).toBeNull();
		expect(cleanDspParameterForLlm(123)).toBeNull();
	});
});

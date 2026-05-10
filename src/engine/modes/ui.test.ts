import { describe, expect, it } from "vitest";
import { MockHiseConnection } from "../hise.js";
import type { SessionContext } from "./mode.js";
import { UiMode } from "./ui.js";
import { MOCK_COMPONENT_TREE } from "../../mock/componentTree.js";

function makeSession(builderTree: object): { mock: MockHiseConnection; session: SessionContext } {
	const mock = new MockHiseConnection();
	mock.onGet("/api/undo/diff", () => ({ success: true, logs: [], errors: [], groupName: "root" }));
	mock.onGet("/api/ui/tree", () => ({ success: true, logs: [], errors: [], result: MOCK_COMPONENT_TREE }));
	mock.onGet("/api/builder/tree", () => ({ success: true, logs: [], errors: [], result: builderTree }));
	mock.onPost("/api/ui/apply", () => ({ success: true, logs: ["OK"], errors: [] }));
	return {
		mock,
		session: {
			connection: mock,
			popMode: () => ({ type: "text", content: "Exited UI mode." }),
		},
	};
}

function builderTree(): object {
	return {
		processorId: "Master Chain",
		parameters: [],
		modulation: [],
		children: [{
			processorId: "MainFilter",
			parameters: [
				{
					id: "Gain",
					type: "Slider",
					range: { min: 0, max: 1, stepSize: 0 },
					defaultValue: 0.25,
					mode: "NormalizedPercentage",
					unit: "%",
				},
				{
					id: "Frequency",
					type: "Slider",
					range: { min: 20, max: 20000, stepSize: 0, middlePosition: 1000 },
					defaultValue: 1000,
					mode: "Frequency",
					unit: "Hz",
				},
				{
					id: "Resonance",
					type: "Slider",
					range: { min: 0.3, max: 8, stepSize: 0 },
					defaultValue: 1,
					mode: "Linear",
					unit: "",
				},
				{
					id: "DecibelGain",
					type: "Slider",
					range: { min: -100, max: 36, stepSize: 0.1 },
					defaultValue: 0,
					mode: "Decibel",
					unit: "dB",
				},
				{
					id: "UnsupportedStep",
					type: "Slider",
					range: { min: 0, max: 1, stepSize: 0.25 },
					defaultValue: 0,
					mode: "Linear",
					unit: "",
				},
				{
					id: "FilterType",
					type: "ComboBox",
					range: { min: 1, max: 3, stepSize: 1 },
					defaultValue: 1,
					items: ["Lowpass", "Highpass", "Bandpass"],
				},
				{
					id: "Enabled",
					type: "Button",
					range: { min: 0, max: 1, stepSize: 1 },
					defaultValue: 1,
					items: ["Off", "On"],
				},
			],
			modulation: [],
			children: [],
		}],
	};
}

function lastApplyOps(mock: MockHiseConnection): Array<{ op: string; target: string; properties: Record<string, unknown> }> {
	const call = [...mock.calls].reverse().find((entry) => entry.method === "POST" && entry.endpoint === "/api/ui/apply");
	if (!call) throw new Error("missing /api/ui/apply call");
	return (call.body as { operations: Array<{ op: string; target: string; properties: Record<string, unknown> }> }).operations;
}

describe("UiMode connect", () => {
	for (const [parameterId, expected] of [
		["Gain", { min: 0, max: 1, defaultValue: 0.25, mode: "NormalizedPercentage", suffix: "%" }],
		["Frequency", { min: 20, max: 20000, defaultValue: 1000, mode: "Frequency", suffix: "Hz", middlePosition: 1000 }],
		["Resonance", { min: 0.3, max: 8, defaultValue: 1, mode: "Linear" }],
		["DecibelGain", { min: -100, max: 36, defaultValue: 0, mode: "Decibel", stepSize: "0.1", suffix: "dB" }],
	] as const) {
		it(`connects matched slider metadata for ${parameterId}`, async () => {
			const { mock, session } = makeSession(builderTree());
			const mode = new UiMode();

			const result = await mode.parse(`connect FilterCutoff to MainFilter.${parameterId} matched`, session);

			expect(result.type).toBe("text");
			const props = lastApplyOps(mock)[0]!.properties;
			expect(props).toMatchObject({
				processorId: "MainFilter",
				parameterId,
				...expected,
			});
		});
	}

	it("connects matched slider metadata", async () => {
		const { mock, session } = makeSession(builderTree());
		const mode = new UiMode();

		const result = await mode.parse("connect FilterCutoff to MainFilter.Frequency matched", session);

		expect(result.type).toBe("text");
		const props = lastApplyOps(mock)[0]!.properties;
			expect(props).toMatchObject({
				processorId: "MainFilter",
				parameterId: "Frequency",
				min: 20,
				max: 20000,
				defaultValue: 1000,
				mode: "Frequency",
				stepSize: "0.0",
				middlePosition: 1000,
				suffix: "Hz",
			});
	});

	it("skips unsupported slider stepSize values", async () => {
		const { mock, session } = makeSession(builderTree());
		const mode = new UiMode();

		const result = await mode.parse("connect FilterCutoff to MainFilter.UnsupportedStep matched", session);

		expect(result.type).toBe("text");
		if (result.type === "text") expect(result.content).toContain("unsupported slider stepSize: 0.25");
		const props = lastApplyOps(mock)[0]!.properties;
		expect(props).toMatchObject({
			processorId: "MainFilter",
			parameterId: "UnsupportedStep",
			min: 0,
			max: 1,
			defaultValue: 0,
			mode: "Linear",
		});
		expect(props.stepSize).toBeUndefined();
	});

	it("connects matched combobox items", async () => {
		const { mock, session } = makeSession(builderTree());
		const mode = new UiMode();

		await mode.parse("connect FilterType to MainFilter.FilterType matched", session);

		const props = lastApplyOps(mock)[0]!.properties;
		expect(props).toMatchObject({
			processorId: "MainFilter",
			parameterId: "FilterType",
			items: "Lowpass\nHighpass\nBandpass",
			defaultValue: 1,
		});
	});

	it("connects matched button text and defaultValue", async () => {
		const { mock, session } = makeSession(builderTree());
		const mode = new UiMode();

		await mode.parse("connect HQMode to MainFilter.Enabled matched", session);

		const props = lastApplyOps(mock)[0]!.properties;
		expect(props).toMatchObject({
			processorId: "MainFilter",
			parameterId: "Enabled",
			text: "Enabled",
			defaultValue: 1,
		});
	});

	it("rejects component and parameter type mismatches", async () => {
		const { session } = makeSession(builderTree());
		const mode = new UiMode();

		const result = await mode.parse("connect FilterType to MainFilter.Frequency matched", session);

		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.message).toMatch(/expected ComboBox/);
	});

	it("rejects missing parameters", async () => {
		const { session } = makeSession(builderTree());
		const mode = new UiMode();

		const result = await mode.parse("connect FilterCutoff to MainFilter.Nope matched", session);

		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.message).toBe('Parameter "Nope" not found on "MainFilter"');
	});
});

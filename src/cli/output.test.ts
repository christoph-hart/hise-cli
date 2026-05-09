import { describe, expect, it } from "vitest";
import { processCliOutputPayload } from "./output.js";

describe("processCliOutputPayload", () => {
	it("compacts empty log and error arrays", () => {
		const result = processCliOutputPayload(
			{ ok: true, value: { success: true, logs: [], errors: [], nested: { logs: [], keep: 1 } } },
			{ json: true, agent: false, compact: true },
		);

		expect(result).toEqual({ ok: true, value: { success: true, nested: { keep: 1 } } });
	});

	it("selects a nested value while preserving the ok envelope", () => {
		const result = processCliOutputPayload(
			{ ok: true, value: { project: { name: "Demo" } } },
			{ json: true, agent: false, compact: false, select: "value.project.name" },
		);

		expect(result).toEqual({ ok: true, value: "Demo" });
	});

	it("selects array indexes", () => {
		const result = processCliOutputPayload(
			{ ok: true, value: { items: [{ id: "first" }] } },
			{ json: true, agent: false, compact: false, select: "value.items[0].id" },
		);

		expect(result).toEqual({ ok: true, value: "first" });
	});

	it("returns an error for missing select paths", () => {
		const result = processCliOutputPayload(
			{ ok: true, value: { connected: true } },
			{ json: true, agent: false, compact: false, select: "value.project.name" },
		);

		expect(result).toEqual({ ok: false, error: "Selection path not found: value.project.name" });
	});
});

import { describe, expect, it } from "vitest";
import { processCliOutputPayload } from "./output.js";
import { cliError, exitCodeForPayload } from "./errors.js";

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

		expect(result).toEqual({ ok: false, code: "select_not_found", error: "Selection path not found: value.project.name" });
	});

	it("adds an execution_error fallback for uncoded agent errors", () => {
		const result = processCliOutputPayload(
			{ ok: false, error: "Something failed" },
			{ json: true, agent: true, compact: true },
		);

		expect(result).toEqual({ ok: false, code: "execution_error", error: "Something failed" });
	});

	it("maps typed error payloads to process exit codes", () => {
		expect(exitCodeForPayload({ ok: true, value: "ok" })).toBe(0);
		expect(exitCodeForPayload(cliError("execution_error", "failed"))).toBe(1);
		expect(exitCodeForPayload(cliError("usage_error", "bad args"))).toBe(2);
		expect(exitCodeForPayload(cliError("select_not_found", "missing"))).toBe(2);
		expect(exitCodeForPayload(cliError("hise_unavailable", "offline"))).toBe(3);
		expect(exitCodeForPayload(cliError("hise_api_error", "api failed"))).toBe(4);
		expect(exitCodeForPayload(cliError("validation_error", "invalid"))).toBe(5);
		expect(exitCodeForPayload(cliError("expectation_failed", "expected"))).toBe(6);
	});
});

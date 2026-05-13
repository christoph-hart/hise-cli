import { describe, expect, it } from "vitest";
import { createSession } from "../../session-bootstrap.js";
import { parseScript } from "./parser.js";
import { validateScript } from "./validator.js";

function makeSession() {
	return createSession({ connection: null, enableLlm: false }).session;
}

describe("validateScript", () => {
	it("accepts explicit DSP module selection via cd", () => {
		const script = parseScript("/dsp\ncd cab_mic_selector\nshow tree");
		const result = validateScript(script, makeSession());

		expect(result).toEqual({ ok: true, errors: [] });
	});

	it("rejects /dsp <module> context syntax", () => {
		const script = parseScript("/dsp cab_mic_selector\nshow tree");
		const result = validateScript(script, makeSession());

		expect(result.ok).toBe(false);
		expect(result.errors[0]?.message).toContain("Use /dsp, then cd <module>");
	});

	it("rejects /dsp.<module> context syntax", () => {
		const script = parseScript("/dsp.cab_mic_selector\nshow tree");
		const result = validateScript(script, makeSession());

		expect(result.ok).toBe(false);
		expect(result.errors[0]?.message).toContain("Use /dsp, then cd <module>");
	});

	it("keeps /dsp save as one-shot command", () => {
		const script = parseScript("/dsp save\nshow tree");
		const result = validateScript(script, makeSession());

		expect(result.ok).toBe(false);
		expect(result.errors[0]?.message).toContain('Command "show tree" requires a mode');
	});
});

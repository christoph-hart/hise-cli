import { describe, expect, it } from "vitest";
import { executeWhich } from "./which.js";

describe("executeWhich", () => {
	it("finds callback edits from file", () => {
		const result = executeWhich("edit onInit from file", 1);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value[0]?.id).toBe("script.set.callback.file");
			expect(result.value[0]?.command.display).toBe("hise-cli script set --module-id Interface --callback onInit --file ./onInit.js --agent");
		}
	});

	it("finds REPL stdin evaluation", () => {
		const result = executeWhich("evaluate expression from stdin", 1);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value[0]?.id).toBe("script.repl.stdin");
		}
	});

	it("honors result limit", () => {
		const result = executeWhich("script callback", 2);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toHaveLength(2);
		}
	});

	it("returns a usage error for no confident match", () => {
		const result = executeWhich("flurb blarg nonsense", 3);

		expect(result).toEqual({
			ok: false,
			code: "usage_error",
			error: "No matching hise-cli command found for: flurb blarg nonsense",
		});
	});

	it("finds builder network provisioning", () => {
		const result = executeWhich("create dsp network on script fx", 1);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value[0]?.id).toBe("builder.set.network");
		}
	});

	it("finds builder routing matrix commands", () => {
		const result = executeWhich("routing matrix", 1);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value[0]?.id).toBe("builder.set.routing");
		}
	});

	it("finds DSP node parent moves", () => {
		const result = executeWhich("move parent", 1);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value[0]?.id).toBe("dsp.move.parent");
		}
	});
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const grammar = readFileSync("docs/CLI_GRAMMAR.md", "utf8");

describe("CLI grammar docs", () => {
	it("documents executable DSP parameter metadata names", () => {
		expect(grammar).toContain("`stepSize`");
		expect(grammar).toContain("`middlePosition`");
		expect(grammar).toContain("`skewFactor`");
		expect(grammar).toContain("`ExternalModulation`");
		expect(grammar).not.toMatch(/\b(?:step|mid|skew)\b/);
	});

	it("documents direct DSP node attributes used by HSC scripts", () => {
		expect(grammar).toContain("`NodeColour`");
		expect(grammar).toContain("`Comment`");
		expect(grammar).toContain("`Folded`");
		expect(grammar).toContain("`IsVertical`");
		expect(grammar).toContain("`ShowParameters`");
	});
});

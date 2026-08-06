import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { translateHscToCli } from "./to-cli.js";

describe("translateHscToCli", () => {
	it("translates dsp host selection and cwd-only add parents", () => {
		const source = [
			"#!/usr/bin/env hise-cli run",
			"# graph",
			"/dsp",
			"cd CabMicSelector",
			"add container.multi as \"PairSplit\"",
			"cd PairSplit",
			"add container.chain as \"SelectedPair\"",
			"set SelectedPair.Folded true",
		].join("\n");

		const result = translateHscToCli(source);

		expect(result.lines).toEqual([
			"#!/usr/bin/env bash",
			"# graph",
			"# hsc-context: /dsp",
			"# hsc-context: cd CabMicSelector",
			"hise-cli dsp add --module CabMicSelector --type container.multi --id PairSplit",
			"# hsc-context: cd PairSplit",
			"hise-cli dsp add --module CabMicSelector --type container.chain --id SelectedPair --parent PairSplit",
			"hise-cli dsp set --module CabMicSelector --node SelectedPair --param Folded --value true",
		]);
	});

	it("fans out chained commands into clean direct CLI invocations", () => {
		const source = [
			"/builder",
			"set A.bypassed true, B.bypassed true",
			"/exit",
		].join("\n");

		const result = translateHscToCli(source);

		expect(result.lines).toEqual([
			"# hsc-context: /builder",
			"hise-cli builder set --module A --bypassed true",
			"hise-cli builder set --module B --bypassed true",
			"# hsc-context: /exit",
		]);
	});

	it("serializes DSP complex data assignments", () => {
		const source = [
			"/dsp",
			"cd ScriptFX1",
			"set_complex_data Env.Table index 3, Lfo.SliderPack.1 index -1",
		].join("\n");

		const result = translateHscToCli(source);

		expect(result.lines).toEqual([
			"# hsc-context: /dsp",
			"# hsc-context: cd ScriptFX1",
			"hise-cli dsp set-complex-data --module ScriptFX1 --node Env --type Table --index 3",
			"hise-cli dsp set-complex-data --module ScriptFX1 --node Lfo --type SliderPack --slot 1 --index -1",
		]);
	});

	it("translates selector fixture without parse errors", () => {
		const source = readFileSync(new URL("../../../hsc_examples/selector.hsc", import.meta.url), "utf-8");
		const result = translateHscToCli(source);
		const text = result.lines.join("\n");

		expect(text).toContain("hise-cli builder add --type ScriptFX --id CabMicSelector");
		expect(text).toContain("hise-cli builder set --module CabMicSelector --network cab_mic_selector");
		expect(text).toContain('hise-cli builder set --module "Master Chain" --routing 0,1,0,1');
		expect(text).toContain("# hsc-context: /dsp");
		expect(text).toContain("# hsc-context: cd CabMicSelector");
		expect(text).toContain("hise-cli dsp add --module CabMicSelector --type routing.selector --id MicPairSelector");
		expect(text).toContain("hise-cli dsp add --module CabMicSelector --type container.chain --id SelectedPair --parent PairSplit");
		expect(text).toContain("hise-cli dsp create_parameter --module CabMicSelector --container cab_mic_selector --id MicPosition --range 0,2 --default 2 --stepSize 2");
		expect(text).toContain("hise-cli dsp connect --module CabMicSelector --source cab_mic_selector --source-param MicPosition --target MicPairSelector --param ChannelIndex --matched");
		expect(text).not.toContain("# hsc-error:");
	});
});

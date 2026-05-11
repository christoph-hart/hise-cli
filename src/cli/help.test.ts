import { describe, expect, it } from "vitest";
import { createSession } from "../session-bootstrap.js";
import { listCliCommands } from "./commands.js";
import { renderCliHelp } from "./help.js";

function getCliCommands() {
	return listCliCommands(createSession({ connection: null }).session.allCommands());
}

describe("renderCliHelp", () => {
	it("documents direct builder UI DSP command namespaces in global help", () => {
		const help = renderCliHelp(getCliCommands());

		expect(help).toContain("hise-cli builder <command> [flags]");
		expect(help).toContain("hise-cli ui <command> [flags]");
		expect(help).toContain("hise-cli dsp <command> [flags]");
		expect(help).not.toContain('hise-cli -<mode> "<command>"');
	});

	it("renders DSP help from generated agent commands", () => {
		const help = renderCliHelp(getCliCommands(), "dsp");

		expect(help).toContain("COMMON COMMANDS");
		expect(help).toContain('hise-cli dsp tree --module "Script FX1" --agent');
		expect(help).toContain('hise-cli dsp connect --module "Script FX1" --source LFO1 --target F1 --param Frequency --matched --agent');
		expect(help).not.toContain('hise-cli -dsp "<command>"');
	});

	it("renders builder and UI help from generated agent commands", () => {
		const builder = renderCliHelp(getCliCommands(), "builder");
		const ui = renderCliHelp(getCliCommands(), "ui");

		expect(builder).toContain("QUICK START");
		expect(builder).toContain("COMMON COMMANDS");
		expect(builder).toContain("CONCEPTS");
		expect(builder).toContain("Chain targeting");
		expect(builder).toContain("TYPES");
		expect(builder).toContain("chainTypes.children: Main signal path");
		expect(builder).toContain("builder add --type <type> --id <id>");
		expect(builder).toContain("hise-cli builder add --type SimpleGain --id Drive --agent");
		expect(builder).not.toContain('hise-cli -builder "<command>"');
		expect(ui).toContain("QUICK START");
		expect(ui).toContain("COMMON COMMANDS");
		expect(ui).toContain("CONCEPTS");
		expect(ui).toContain("TYPES");
		expect(ui).toContain("defaultModule: Interface");
		expect(ui).toContain("ui connect (--source <component> | --component <component>)");
		expect(ui).toContain("connectSourceFlags: --source, --component");
		expect(ui).toContain("hise-cli ui connect --source Cutoff --target MainFilter --param Frequency --matched --agent");
		expect(ui).not.toContain('hise-cli -ui "<command>"');
	});

	it("renders compact DSP concepts and types from generated agent context", () => {
		const help = renderCliHelp(getCliCommands(), "dsp");

		expect(help).toContain("QUICK START");
		expect(help).toContain("CONCEPTS");
		expect(help).toContain("Connection model");
		expect(help).toContain("TYPES");
		expect(help).toContain("sourceQualifiers: --source-param, --source-output");
		expect(help).toContain("dsp connect --module <module> --source <source> --target <node> --param <param> [--matched]");
	});

	it("documents agent error codes and exit mapping", () => {
		const help = renderCliHelp(getCliCommands());

		expect(help).toContain('{ "ok": false, "code": "hise_api_error", "error": "..." }');
		expect(help).toContain("4 HISE API error");
		expect(help).toContain("6 expectation failure");
	});

	it("renders script help from generated agent commands", () => {
		const help = renderCliHelp(getCliCommands(), "script");

		expect(help).toContain("COMMON COMMANDS");
		expect(help).toContain("hise-cli script repl --module-id Interface --stdin --agent");
		expect(help).toContain("hise-cli script compile --module-id Interface --agent");
		expect(help).not.toContain("CALLBACK JSON SHAPE");
	});
});

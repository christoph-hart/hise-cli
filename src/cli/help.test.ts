import { describe, expect, it } from "vitest";
import { createSession } from "../session-bootstrap.js";
import { listCliCommands } from "./commands.js";
import { renderCliHelp } from "./help.js";

function getCliCommands() {
	return listCliCommands(createSession({ connection: null }).session.allCommands());
}

describe("renderCliHelp", () => {
	it("recommends separated target syntax in global help", () => {
		const help = renderCliHelp(getCliCommands());

		expect(help).toContain("--target <path>");
		expect(help).not.toContain("--target:<path>");
	});

	it("recommends separated multi-word DSP targets", () => {
		const help = renderCliHelp(getCliCommands(), "dsp");

		expect(help).toContain('hise-cli -dsp --target "Script FX1" "show networks"');
		expect(help).not.toContain('--target:"Script FX1"');
	});

	it("documents agent error codes and exit mapping", () => {
		const help = renderCliHelp(getCliCommands());

		expect(help).toContain('{ "ok": false, "code": "hise_api_error", "error": "..." }');
		expect(help).toContain("4 HISE API error");
		expect(help).toContain("6 expectation failure");
	});

	it("renders script help from generated agent capabilities", () => {
		const help = renderCliHelp(getCliCommands(), "script");

		expect(help).toContain("COMMON COMMANDS");
		expect(help).toContain("hise-cli script repl --module-id Interface --stdin --agent");
		expect(help).toContain("hise-cli script compile --module-id Interface --agent");
		expect(help).not.toContain("CALLBACK JSON SHAPE");
	});
});

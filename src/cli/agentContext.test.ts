import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args.js";
import { buildAgentContext, renderAgentModeHelp } from "./agentContext.js";
import { GENERATED_AGENT_CONTEXT } from "./generated-agent-context.js";
import type { AgentCapability } from "./agentContextTypes.js";
import { createSession } from "../session-bootstrap.js";
import { listCliCommands } from "./commands.js";

function getCliCommands() {
	return listCliCommands(createSession({ connection: null }).session.allCommands());
}

describe("generated agent context", () => {
	it("has unique capability ids", () => {
		const ids = GENERATED_AGENT_CONTEXT.modes.flatMap((mode) => mode.capabilities.map((capability) => capability.id));
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("contains script capabilities from the YAML source", () => {
		const script = GENERATED_AGENT_CONTEXT.modes.find((mode) => mode.id === "script");
		expect(script?.capabilities.map((capability) => capability.id)).toEqual(expect.arrayContaining([
			"script.repl.stdin",
			"script.get.callback",
			"script.set.callback.file",
			"script.compile",
		]));
	});

	it("parses concrete capability and example argv recipes", () => {
		const commands = getCliCommands();
		for (const mode of GENERATED_AGENT_CONTEXT.modes) {
			for (const capability of mode.capabilities) {
				const entry = capability as AgentCapability;
				assertParses(entry.command.argv, commands, entry.id);
				for (const example of entry.examples ?? []) {
					assertParses(example.argv, commands, `${capability.id} example ${example.title}`);
				}
			}
		}
	});

	it("agent recipes use --agent and separated target syntax", () => {
		for (const mode of GENERATED_AGENT_CONTEXT.modes) {
			for (const capability of mode.capabilities) {
				expect(capability.command.argv, capability.id).toContain("--agent");
				expect(capability.command.argv.some((arg) => arg.startsWith("--target:")), capability.id).toBe(false);
			}
		}
	});

	it("builds structured agent-context JSON", () => {
		const context = buildAgentContext() as { modes: Array<{ id: string }>; errorExitCodes: Record<string, number> };

		expect(context.modes.some((mode) => mode.id === "script")).toBe(true);
		expect(context.errorExitCodes.hise_api_error).toBe(4);
		expect(context.errorExitCodes.expectation_failed).toBe(6);
	});

	it("renders script help from generated capabilities", () => {
		const help = renderAgentModeHelp("script");

		expect(help).toContain("COMMON COMMANDS");
		expect(help).toContain("hise-cli script set --module-id Interface --callback onInit --file ./onInit.js --agent");
		expect(help).toContain("Prefer stdin or file inputs for script bodies.");
		expect(help).not.toContain("CALLBACK JSON SHAPE");
	});
});

function assertParses(argv: readonly string[], commands: ReturnType<typeof getCliCommands>, label: string): void {
	if (argv.some((arg) => arg.startsWith("<") && arg.endsWith(">"))) return;
	const result = parseCliArgs(["node", ...argv], commands);
	expect(result.kind, label).not.toBe("error");
}

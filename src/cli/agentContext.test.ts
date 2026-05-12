import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args.js";
import { buildAgentCommandIndex, buildAgentContext, renderAgentModeHelp } from "./agentContext.js";
import { GENERATED_AGENT_CONTEXT } from "./generated-agent-context.js";
import type { AgentCommand } from "./agentContextTypes.js";
import { createSession } from "../session-bootstrap.js";
import { listCliCommands } from "./commands.js";

function getCliCommands() {
	return listCliCommands(createSession({ connection: null }).session.allCommands());
}

describe("generated agent context", () => {
	it("has unique command ids", () => {
		const ids = GENERATED_AGENT_CONTEXT.modes.flatMap((mode) => mode.commands.map((command) => command.id));
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("contains script commands from the YAML source", () => {
		const script = GENERATED_AGENT_CONTEXT.modes.find((mode) => mode.id === "script");
		expect(script?.commands.map((command) => command.id)).toEqual(expect.arrayContaining([
			"script.repl.stdin",
			"script.get.callback",
			"script.set.callback.file",
			"script.compile",
		]));
	});

	it("contains mcp commands from the YAML source", () => {
		const mcp = GENERATED_AGENT_CONTEXT.modes.find((mode) => mode.id === "mcp");
		expect(mcp?.commands.map((command) => command.id)).toEqual(expect.arrayContaining([
			"mcp.tool.fields",
			"mcp.search.docs",
			"mcp.query.api",
		]));
	});

	it("contains rich builder v2 commands and concepts", () => {
		const builder = GENERATED_AGENT_CONTEXT.modes.find((mode) => mode.id === "builder");
		expect(builder?.commands.map((command) => command.id)).toEqual(expect.arrayContaining([
			"builder.show.tree",
			"builder.add.module",
			"builder.set.network",
			"builder.set.routing",
		]));
		expect(builder?.concepts.some((concept) => concept.id === "property-dispatch")).toBe(true);
		expect(JSON.stringify(builder)).toContain("DefaultEnvelope*");
		expect(JSON.stringify(builder)).toContain("Bare names create a new network");
	});

	it("parses concrete command and example argv recipes", () => {
		const commands = getCliCommands();
		for (const mode of GENERATED_AGENT_CONTEXT.modes) {
			for (const command of mode.commands) {
				const entry = command as AgentCommand;
				assertParses(entry.command.argv, commands, entry.id);
				for (const example of entry.examples ?? []) {
					assertParses(example.argv, commands, `${command.id} example ${example.title}`);
				}
			}
			for (const example of mode.quickStart) {
				assertParses(example.argv, commands, `${mode.id} quickStart ${example.title}`);
			}
		}
	});

	it("agent recipes use --agent and separated target syntax", () => {
		for (const mode of GENERATED_AGENT_CONTEXT.modes) {
			for (const command of mode.commands) {
				expect(command.command.argv, command.id).toContain("--agent");
				expect(command.command.argv.some((arg) => arg.startsWith("--target:")), command.id).toBe(false);
			}
		}
	});

	it("builds compact agent-context manifest JSON", () => {
		const result = buildAgentContext();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const context = result.value as {
			modes: Array<{ id: string; commandCount: number }>;
			commands?: unknown;
			lookup: Record<string, string>;
		};

		expect(context.modes.some((mode) => mode.id === "script")).toBe(true);
		expect(context.modes.find((mode) => mode.id === "script")?.commandCount).toBeGreaterThan(0);
		expect(context.commands).toBeUndefined();
		expect(context.lookup.intent).toContain("--select value[0]");
	});

	it("builds compact mode context for a scoped mode query", () => {
		const result = buildAgentContext({ type: "mode", modeId: "ui", full: false });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const mode = result.value as {
			id: string;
			commands: Array<{ id: string; syntax: string; purpose: string; examples?: unknown; command?: unknown; tags?: unknown; aliases?: unknown; help?: unknown }>;
			concepts: Array<{ id: string; title: string; body: string[] }>;
			notes: string[];
			antiPatterns: Array<{ avoid: string; prefer: string }>;
			lookup: Record<string, string>;
		};
		expect(mode.id).toBe("ui");
		const setCommand = mode.commands.find((command) => command.id === "ui.set.properties");
		expect(setCommand?.purpose).toBe("Update one or more ScriptComponent properties.");
		expect(setCommand?.examples).toBeUndefined();
		expect(setCommand?.command).toBeUndefined();
		expect(setCommand?.tags).toBeUndefined();
		expect(setCommand?.aliases).toBeUndefined();
		expect(setCommand?.help).toBeUndefined();
		expect(mode.notes.some((note) => note.includes("do not script these as onInit layout code"))).toBe(true);
		expect(mode.antiPatterns.some((item) => item.avoid.includes("static controls from HiseScript onInit"))).toBe(true);
		const layout = mode.concepts.find((concept) => concept.id === "layout-strategy");
		expect(layout?.body.length).toBeLessThanOrEqual(2);
		expect(layout?.body.join(" ")).toContain("Dynamic UI logic means callbacks and runtime updates");
		expect(mode.lookup.full).toContain("--full");
	});

	it("builds full mode context when requested", () => {
		const result = buildAgentContext({ type: "mode", modeId: "script", full: true });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const mode = result.value as { id: string; commands: AgentCommand[]; notes: string[] };
		expect(mode.id).toBe("script");
		expect(mode.commands.some((command) => command.id === "script.compile")).toBe(true);
		expect(mode.notes.length).toBeGreaterThan(0);
	});

	it("builds full command context for a scoped command query", () => {
		const result = buildAgentContext({ type: "command", id: "script.compile" });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const command = result.value as AgentCommand;
		expect(command.id).toBe("script.compile");
		expect(command.command.display).toContain("script compile");
		expect(command.examples?.length).toBeGreaterThan(0);
	});

	it("builds a flat command index", () => {
		const index = buildAgentCommandIndex() as Array<{ id: string; mode: string; title: string; examples?: unknown; command?: unknown; tags?: unknown }>;

		expect(index).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "script.compile", mode: "script" }),
		]));
		expect(index.find((command) => command.id === "script.compile")?.examples).toBeUndefined();
		expect(index.find((command) => command.id === "script.compile")?.command).toBeUndefined();
		expect(index.find((command) => command.id === "script.compile")?.tags).toBeUndefined();
	});

	it("returns usage errors for unknown scoped agent-context queries", () => {
		expect(buildAgentContext({ type: "mode", modeId: "nonesuch", full: false })).toEqual({
			ok: false,
			code: "usage_error",
			error: "Unknown agent-context mode: nonesuch",
		});
		expect(buildAgentContext({ type: "command", id: "script.nope" })).toEqual({
			ok: false,
			code: "usage_error",
			error: "Unknown agent-context command: script.nope",
		});
	});

	it("renders script help from generated commands", () => {
		const help = renderAgentModeHelp("script");

		expect(help).toContain("COMMON COMMANDS");
		expect(help).toContain("hise-cli script set --module-id Interface --callback onInit --file ./onInit.js --agent");
		expect(help).toContain("Prefer stdin or file inputs for script bodies; never pass multi-line HiseScript or callback bodies through argv.");
		expect(help).not.toContain("CALLBACK JSON SHAPE");
	});
});

function assertParses(argv: readonly string[], commands: ReturnType<typeof getCliCommands>, label: string): void {
	if (argv.some((arg) => arg.startsWith("<") && arg.endsWith(">"))) return;
	const result = parseCliArgs(["node", ...argv], commands);
	expect(result.kind, label).not.toBe("error");
}

import { GENERATED_AGENT_CONTEXT } from "./generated-agent-context.js";
import { CLI_ERROR_EXIT_CODES, cliError, type CliErrorPayload } from "./errors.js";
import type { AgentContextQuery } from "./args.js";
import type { AgentCommand, AgentContextMode } from "./agentContextTypes.js";

export function buildAgentContext(query: AgentContextQuery = { type: "manifest" }): { ok: true; value: object } | CliErrorPayload {
	if (query.type === "manifest") return { ok: true, value: buildAgentContextManifest() };
	if (query.type === "command-index") return { ok: true, value: buildAgentCommandIndex() };
	if (query.type === "mode") {
		const mode = getAgentContextMode(query.modeId);
		if (!mode) return cliError("usage_error", `Unknown agent-context mode: ${query.modeId}`);
		return { ok: true, value: mode };
	}
	const command = getAgentCommand(query.id);
	if (!command) return cliError("usage_error", `Unknown agent-context command: ${query.id}`);
	return { ok: true, value: command };
}

export function buildAgentContextManifest(): object {
	return {
		schemaVersion: GENERATED_AGENT_CONTEXT.schemaVersion,
		common: GENERATED_AGENT_CONTEXT.common,
		cli: cliInfo(),
		globalFlags: globalFlags(),
		inputPatterns: inputPatterns(),
		errorExitCodes: CLI_ERROR_EXIT_CODES,
		modes: GENERATED_AGENT_CONTEXT.modes.map((mode) => ({
			id: mode.id,
			title: mode.title,
			summary: mode.summary,
			commandCount: mode.commands.length,
		})),
		commands: buildAgentCommandIndex(),
		lookup: {
			mode: "hise-cli agent-context <mode>",
			command: "hise-cli agent-context --command <id>",
			commandIndex: "hise-cli agent-context --list-commands",
			intent: "hise-cli which \"<intent>\"",
		},
	};
}

export function buildAgentCommandIndex(): object[] {
	return GENERATED_AGENT_CONTEXT.modes.flatMap((mode) => mode.commands.map((command) => ({
		id: command.id,
		mode: mode.id,
		title: command.title,
		purpose: command.purpose,
		command: command.command,
		tags: command.tags,
	}))).sort((a, b) => a.id.localeCompare(b.id));
}

export function getAgentContextMode(modeId: string): AgentContextMode | undefined {
	return GENERATED_AGENT_CONTEXT.modes.find((mode) => mode.id === modeId);
}

export function getAgentCommand(id: string): AgentCommand | undefined {
	for (const mode of GENERATED_AGENT_CONTEXT.modes) {
		const command = mode.commands.find((entry) => entry.id === id);
		if (command) return command;
	}
	return undefined;
}

export function renderAgentModeHelp(modeId: string): string | null {
	const mode = getAgentContextMode(modeId);
	if (!mode) return null;
	const visible = [...mode.commands]
		.filter((command) => command.help.visibility !== "hidden")
		.sort((a, b) => a.help.order - b.help.order || a.id.localeCompare(b.id));

	const lines: string[] = [];
	lines.push(`hise-cli ${modeId} - ${mode.title}`);
	lines.push("");
	lines.push(mode.summary);
	lines.push("");
	lines.push("COMMON COMMANDS");
	for (const command of visible) {
		lines.push(`  ${command.command.display}`);
		lines.push(`    ${command.purpose}`);
	}
	const examples = visible.flatMap((command) => renderExamples(command)).slice(0, 8);
	if (examples.length > 0) {
		lines.push("");
		lines.push("EXAMPLES");
		for (const example of examples) lines.push(`  ${example}`);
	}
	if (mode.notes.length > 0) {
		lines.push("");
		lines.push("NOTES");
		for (const note of mode.notes) lines.push(`  - ${note}`);
	}
	if (mode.antiPatterns.length > 0) {
		lines.push("");
		lines.push("AVOID");
		for (const item of mode.antiPatterns) {
			lines.push(`  - Avoid: ${item.avoid}`);
			lines.push(`    Prefer: ${item.prefer}`);
		}
	}
	return lines.join("\n");
}

function renderExamples(command: AgentCommand): string[] {
	return (command.examples ?? []).map((example) => {
		if (example.stdin?.includes("\n")) return `${example.display} < onInit.js`;
		if (example.stdin) return `echo ${quoteShell(example.stdin)} | ${example.display}`;
		return example.display;
	});
}

function quoteShell(value: string): string {
	if (!value.includes("\n") && !value.includes("'")) return `'${value}'`;
	return "'<stdin>'";
}

function cliInfo(): object {
	return {
		name: "hise-cli",
		description: "Modal REPL and CLI for controlling HISE via REST.",
		hiseBaseUrl: "http://127.0.0.1:1900",
	};
}

function globalFlags(): object[] {
	return [
		{ flag: "--agent", description: "Implies --json --compact and guarantees coded errors." },
		{ flag: "--json", description: "Emit structured JSON output." },
		{ flag: "--compact", description: "Remove empty wrapper noise from the final output payload only." },
		{ flag: "--select <path>", description: "Extract a payload field while preserving { ok, value }. Implies JSON output." },
		{ flag: "--target <path>", description: "Preferred context flag for one-shot mode commands." },
		{ flag: "--stdin", description: "Preferred for non-trivial builder/ui/dsp mutations. Multiple non-empty lines execute serially as a same-mode command batch." },
	];
}

function inputPatterns(): object[] {
	return [
		{ pattern: "stdin", description: "Default for non-trivial builder/ui/dsp mutations and shell-sensitive content. Newline batches run serially in the selected mode only." },
		{ pattern: "file", description: "Preferred for multi-line callback edits." },
		{ pattern: "argv", description: "Use only for trivial read-only mode commands, e.g. hise-cli -builder show tree --agent." },
	];
}

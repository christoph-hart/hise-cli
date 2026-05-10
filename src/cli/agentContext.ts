import { GENERATED_AGENT_CONTEXT } from "./generated-agent-context.js";
import { CLI_ERROR_EXIT_CODES, cliError, type CliErrorPayload } from "./errors.js";
import type { AgentContextQuery } from "./args.js";
import type { AgentCapability, AgentContextMode } from "./agentContextTypes.js";

export function buildAgentContext(query: AgentContextQuery = { type: "manifest" }): { ok: true; value: object } | CliErrorPayload {
	if (query.type === "manifest") return { ok: true, value: buildAgentContextManifest() };
	if (query.type === "capability-index") return { ok: true, value: buildAgentCapabilityIndex() };
	if (query.type === "mode") {
		const mode = getAgentContextMode(query.modeId);
		if (!mode) return cliError("usage_error", `Unknown agent-context mode: ${query.modeId}`);
		return { ok: true, value: mode };
	}
	const capability = getAgentCapability(query.id);
	if (!capability) return cliError("usage_error", `Unknown agent-context capability: ${query.id}`);
	return { ok: true, value: capability };
}

export function buildAgentContextManifest(): object {
	return {
		schemaVersion: GENERATED_AGENT_CONTEXT.schemaVersion,
		cli: cliInfo(),
		globalFlags: globalFlags(),
		inputPatterns: inputPatterns(),
		errorExitCodes: CLI_ERROR_EXIT_CODES,
		modes: GENERATED_AGENT_CONTEXT.modes.map((mode) => ({
			id: mode.id,
			title: mode.title,
			summary: mode.summary,
			capabilityCount: mode.capabilities.length,
		})),
		capabilities: buildAgentCapabilityIndex(),
		lookup: {
			mode: "hise-cli agent-context <mode>",
			capability: "hise-cli agent-context --capability <id>",
			capabilityIndex: "hise-cli agent-context --list-capabilities",
			intent: "hise-cli which \"<intent>\"",
		},
	};
}

export function buildAgentCapabilityIndex(): object[] {
	return GENERATED_AGENT_CONTEXT.modes.flatMap((mode) => mode.capabilities.map((capability) => ({
		id: capability.id,
		mode: mode.id,
		title: capability.title,
		purpose: capability.purpose,
		command: capability.command,
		tags: capability.tags,
	}))).sort((a, b) => a.id.localeCompare(b.id));
}

export function getAgentContextMode(modeId: string): AgentContextMode | undefined {
	return GENERATED_AGENT_CONTEXT.modes.find((mode) => mode.id === modeId);
}

export function getAgentCapability(id: string): AgentCapability | undefined {
	for (const mode of GENERATED_AGENT_CONTEXT.modes) {
		const capability = mode.capabilities.find((entry) => entry.id === id);
		if (capability) return capability;
	}
	return undefined;
}

export function renderAgentModeHelp(modeId: string): string | null {
	const mode = getAgentContextMode(modeId);
	if (!mode) return null;
	const visible = [...mode.capabilities]
		.filter((capability) => capability.help.visibility !== "hidden")
		.sort((a, b) => a.help.order - b.help.order || a.id.localeCompare(b.id));

	const lines: string[] = [];
	lines.push(`hise-cli ${modeId} - ${mode.title}`);
	lines.push("");
	lines.push(mode.summary);
	lines.push("");
	lines.push("COMMON COMMANDS");
	for (const capability of visible) {
		lines.push(`  ${capability.command.display}`);
		lines.push(`    ${capability.purpose}`);
	}
	const examples = visible.flatMap((capability) => renderExamples(capability)).slice(0, 8);
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

function renderExamples(capability: AgentCapability): string[] {
	return (capability.examples ?? []).map((example) => {
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
		{ flag: "--stdin", description: "Read stdin input. For builder/ui/dsp, multiple non-empty lines execute as a command batch." },
	];
}

function inputPatterns(): object[] {
	return [
		{ pattern: "stdin", description: "Preferred for mode commands with quoting. Builder/ui/dsp support newline command batches." },
		{ pattern: "file", description: "Preferred for multi-line callback edits." },
		{ pattern: "argv", description: "Use argv tokens for short mode commands, e.g. hise-cli -builder show tree --agent." },
	];
}

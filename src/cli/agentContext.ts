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
	lines.push("SUMMARY");
	lines.push(mode.summary);
	if (mode.quickStart.length > 0) {
		lines.push("");
		lines.push("QUICK START");
		for (const recipe of mode.quickStart.slice(0, 6)) {
			lines.push(`  ${recipe.display}${recipe.stdin ? " < stdin" : ""}`);
			lines.push(`    ${recipe.title}`);
		}
	}
	lines.push("");
	lines.push("COMMON COMMANDS");
	for (const command of visible) {
		lines.push(`  ${command.syntax}`);
		lines.push(`  ${command.command.display}`);
		lines.push(`    ${command.purpose}`);
	}
	if (mode.concepts.length > 0) {
		lines.push("");
		lines.push("CONCEPTS");
		for (const concept of mode.concepts.slice(0, 8)) {
			lines.push(`  ${concept.title}`);
			for (const body of concept.body.slice(0, 3)) lines.push(`    - ${body}`);
			if (concept.body.length > 3) lines.push("    - ...");
		}
	}
	const typeLines = renderCompactTypes(mode.types);
	if (typeLines.length > 0) {
		lines.push("");
		lines.push("TYPES");
		for (const line of typeLines) lines.push(`  ${line}`);
	}
	const quickStartDisplays = new Set(mode.quickStart.map((recipe) => recipe.display));
	const examples = visible
		.flatMap((command) => renderExamples(command))
		.filter((example) => !quickStartDisplays.has(example.replace(/ < stdin$/, "")))
		.slice(0, 8);
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

function renderCompactTypes(types: Record<string, unknown>): string[] {
	return Object.entries(types).flatMap(([key, value]) => renderTypeValue(key, value)).slice(0, 16);
}

function renderTypeValue(key: string, value: unknown): string[] {
	if (Array.isArray(value)) return [`${key}: ${formatArray(value)}`];
	if (value && typeof value === "object") {
		return Object.entries(value as Record<string, unknown>).flatMap(([childKey, childValue]) => {
			const qualifiedKey = `${key}.${childKey}`;
			if (Array.isArray(childValue)) return [`${qualifiedKey}: ${formatArray(childValue)}`];
			if (childValue && typeof childValue === "object") return [`${qualifiedKey}: ${formatInlineRecord(childValue as Record<string, unknown>)}`];
			return [`${qualifiedKey}: ${String(childValue)}`];
		});
	}
	if (value === undefined || value === null) return [];
	return [`${key}: ${String(value)}`];
}

function formatArray(value: unknown[]): string {
	const items = value.map((item) => String(item));
	return items.length > 8 ? `${items.slice(0, 8).join(", ")}, ...` : items.join(", ");
}

function formatInlineRecord(value: Record<string, unknown>): string {
	const entries = Object.entries(value).map(([key, item]) => `${key}=${String(item)}`);
	return entries.length > 6 ? `${entries.slice(0, 6).join(", ")}, ...` : entries.join(", ");
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
		{ flag: "--dry-run", description: "Validate builder/ui/dsp mutations inside a discarded HISE undo plan." },
	];
}

function inputPatterns(): object[] {
	return [
		{ pattern: "flag", description: "Default for builder/ui/dsp direct shell commands and short scalar values." },
		{ pattern: "stdin", description: "Use only for commands that explicitly accept stdin payloads." },
		{ pattern: "file", description: "Preferred for multi-line callback edits." },
		{ pattern: "json-file", description: "Preferred for nested or structured payloads that would be hard to quote in argv." },
	];
}

import { GENERATED_AGENT_CONTEXT } from "./generated-agent-context.js";
import type { AgentCapability } from "./agentContextTypes.js";
import { cliError, type CliErrorPayload } from "./errors.js";

export interface WhichMatch {
	id: string;
	title: string;
	purpose: string;
	command: { argv: string[]; display: string };
	score: number;
	reason: string;
	tags: string[];
	aliases: string[];
}

const SYNONYMS: Record<string, string[]> = {
	edit: ["set", "update", "replace"],
	update: ["set", "edit", "replace"],
	read: ["get", "show"],
	show: ["get", "read"],
	callback: ["oninit", "oncontrol", "script"],
	callbacks: ["callback", "script"],
	compile: ["recompile"],
	recompile: ["compile"],
	file: ["path"],
	stdin: ["pipe", "input"],
	expression: ["repl", "evaluate"],
	evaluate: ["repl", "expression"],
};

export function executeWhich(query: string, limit: number): { ok: true; value: WhichMatch[] } | CliErrorPayload {
	const capabilities = GENERATED_AGENT_CONTEXT.modes.flatMap((mode) => mode.capabilities) as AgentCapability[];
	if (!query) {
		return { ok: true, value: capabilities.slice(0, limit).map((capability) => toMatch(capability, 0, "listed capability")) };
	}

	const queryTokens = expandTokens(tokenize(query));
	const matches = capabilities
		.map((capability) => scoreCapability(capability, queryTokens))
		.filter((match) => match.score >= 3)
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
		.slice(0, limit);

	if (matches.length === 0) {
		return cliError("usage_error", `No matching hise-cli capability found for: ${query}`);
	}

	return { ok: true, value: matches };
}

function scoreCapability(capability: AgentCapability, queryTokens: Set<string>): WhichMatch {
	let score = 0;
	const reasons: string[] = [];
	const fields: Array<[string, number, string[]]> = [
		["title", 5, tokenize(capability.title)],
		["aliases", 6, capability.aliases.flatMap(tokenize)],
		["tags", 4, capability.tags.flatMap(tokenize)],
		["purpose", 2, tokenize(capability.purpose)],
		["command", 1, capability.command.argv.flatMap(tokenize)],
	];

	for (const [name, weight, tokens] of fields) {
		const hits = [...new Set(tokens.filter((token) => queryTokens.has(token)))];
		if (hits.length > 0) {
			score += hits.length * weight;
			reasons.push(`${name}: ${hits.slice(0, 4).join(", ")}`);
		}
	}

	return toMatch(capability, score, reasons.join("; ") || "no direct match");
}

function toMatch(capability: AgentCapability, score: number, reason: string): WhichMatch {
	return {
		id: capability.id,
		title: capability.title,
		purpose: capability.purpose,
		command: capability.command,
		score,
		reason,
		tags: capability.tags,
		aliases: capability.aliases,
	};
}

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

function expandTokens(tokens: string[]): Set<string> {
	const out = new Set(tokens);
	for (const token of tokens) {
		for (const synonym of SYNONYMS[token] ?? []) out.add(synonym);
	}
	return out;
}

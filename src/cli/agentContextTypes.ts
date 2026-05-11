export interface AgentContextData {
	schemaVersion: 2;
	common: AgentContextCommon;
	modes: AgentContextMode[];
}

export interface AgentContextCommon {
	syntax: Array<{ form: string; purpose: string }>;
	grammar: Record<string, unknown>;
	inputPatterns: Array<{ pattern: string; purpose: string }>;
	output: Array<{ flag: string; purpose: string }>;
}

export interface AgentContextMode {
	id: string;
	title: string;
	summary: string;
	invocation: AgentContextRecipe[];
	notes: string[];
	antiPatterns: Array<{ avoid: string; prefer: string }>;
	quickStart: AgentContextRecipe[];
	concepts: AgentContextConcept[];
	commands: AgentCommand[];
	types: Record<string, unknown>;
}

export interface AgentContextConcept {
	id: string;
	title: string;
	body: string[];
}

export interface AgentCommand {
	id: string;
	title: string;
	purpose: string;
	syntax: string;
	command: AgentContextCommand;
	examples?: AgentContextRecipe[];
	tags: string[];
	aliases: string[];
	contexts: string[];
	agentRelevance: string;
	danger: boolean;
	notes?: string[];
	help: {
		visibility: string;
		order: number;
	};
}

export interface AgentContextCommand {
	argv: string[];
	display: string;
}

export interface AgentContextRecipe extends AgentContextCommand {
	title: string;
	stdin?: string;
}

export interface AgentContextData {
	schemaVersion: 1;
	modes: AgentContextMode[];
}

export interface AgentContextMode {
	id: string;
	title: string;
	summary: string;
	invocation: AgentContextRecipe[];
	notes: string[];
	antiPatterns: Array<{ avoid: string; prefer: string }>;
	capabilities: AgentCapability[];
}

export interface AgentCapability {
	id: string;
	title: string;
	purpose: string;
	command: AgentContextCommand;
	examples?: AgentContextRecipe[];
	tags: string[];
	aliases: string[];
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

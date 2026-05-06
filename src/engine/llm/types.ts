export type LlmMode = "builder" | "ui" | "dsp";

export interface CompleteRequest {
	system: string;
	user: string;
	maxTokens?: number;
	signal?: AbortSignal;
	/** Optional JSON schema. When provided, the provider must constrain the
	 *  output to match. Used for structured-output / grammar-equivalent paths. */
	format?: Record<string, unknown>;
}

export interface LlmProvider {
	readonly name: string;
	readonly model: string;
	complete(req: CompleteRequest): Promise<string>;
}

export interface IntentRequest {
	mode: LlmMode;
	nl: string;
	treeJson: unknown;
	helpText: string;
	signal?: AbortSignal;
	maxTokens?: number;
}

export interface IntentResult {
	command: string;
	raw: string;
	durationMs: number;
}

export interface IntentError {
	error: string;
	raw?: string;
}

export type IntentOutcome =
	| { ok: true; result: IntentResult }
	| { ok: false; error: string; raw?: string };

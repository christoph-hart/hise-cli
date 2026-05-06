import type { LlmProvider } from "./types.js";
import { createOllamaProvider, type OllamaConfig } from "./ollama.js";

export type ProviderConfig =
	| ({ kind: "ollama" } & OllamaConfig)
	| { kind: string; [key: string]: unknown };

export type ProviderFactory = (config: ProviderConfig) => LlmProvider;

const REGISTRY = new Map<string, ProviderFactory>();

export function registerProvider(kind: string, factory: ProviderFactory): void {
	REGISTRY.set(kind, factory);
}

export function createProvider(config: ProviderConfig): LlmProvider {
	const factory = REGISTRY.get(config.kind);
	if (!factory) {
		throw new Error(`Unknown LLM provider kind: "${config.kind}". Registered: ${[...REGISTRY.keys()].join(", ") || "(none)"}`);
	}
	return factory(config);
}

export function listProviders(): string[] {
	return [...REGISTRY.keys()];
}

// ── Builtin registrations ───────────────────────────────────────────

registerProvider("ollama", (config) => {
	const c = config as { kind: "ollama" } & OllamaConfig;
	return createOllamaProvider(c);
});

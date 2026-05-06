import { renderCliHelp } from "../cli/help.js";
import {
	createProvider,
	probeOllamaDaemon,
	runIntent,
	runStructuredIntent,
	treeNodeToLlmJson,
	type IntentOutcome,
	type LlmMode,
	type LlmProvider,
} from "../engine/llm/index.js";
import type { TreeNode } from "../engine/result.js";
import type { ModuleList } from "../engine/data.js";
import type { ComponentPropertyMap } from "../engine/modes/ui-parser.js";

const DEFAULT_OLLAMA_MODEL = "qwen3.5:9b";
const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434";

let cachedProvider: LlmProvider | null = null;

function getProvider(): LlmProvider {
	if (cachedProvider) return cachedProvider;
	cachedProvider = createProvider({
		kind: "ollama",
		endpoint: DEFAULT_OLLAMA_ENDPOINT,
		model: DEFAULT_OLLAMA_MODEL,
		think: false,
	});
	return cachedProvider;
}

export interface AiPredictionInput {
	mode: LlmMode;
	tree: TreeNode | null;
	nl: string;
	signal?: AbortSignal;
	moduleList?: ModuleList;
	componentProperties?: ComponentPropertyMap;
	/** When true (default for builder + ui), use schema-constrained structured
	 *  output. Falls back to free-form for dsp until its schema lands. */
	structured?: boolean;
}

export async function runAiPrediction(input: AiPredictionInput): Promise<IntentOutcome> {
	const helpText = renderCliHelp([], input.mode);
	const useStructured = input.structured ?? (input.mode === "builder" || input.mode === "ui");
	if (useStructured) {
		return runStructuredIntent(getProvider(), {
			mode: input.mode,
			nl: input.nl,
			tree: input.tree,
			helpText,
			moduleList: input.moduleList,
			componentProperties: input.componentProperties,
			signal: input.signal,
		});
	}
	const treeJson = treeNodeToLlmJson(input.tree);
	return runIntent(getProvider(), {
		mode: input.mode,
		nl: input.nl,
		treeJson,
		helpText,
		signal: input.signal,
	});
}

export async function checkOllamaAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
	const probe = await probeOllamaDaemon(DEFAULT_OLLAMA_ENDPOINT);
	if (!probe.ok) {
		return { ok: false, reason: probe.reason ?? "ollama daemon not reachable on " + DEFAULT_OLLAMA_ENDPOINT };
	}
	if (!probe.models.includes(DEFAULT_OLLAMA_MODEL)) {
		return {
			ok: false,
			reason: `model "${DEFAULT_OLLAMA_MODEL}" not pulled. Run: ollama pull ${DEFAULT_OLLAMA_MODEL}`,
		};
	}
	return { ok: true };
}

export function getProviderLabel(): string {
	return `ollama/${DEFAULT_OLLAMA_MODEL}`;
}

export function isAiCapableMode(modeId: string): modeId is LlmMode {
	return modeId === "builder" || modeId === "ui" || modeId === "dsp";
}

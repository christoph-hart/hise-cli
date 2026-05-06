import type { IntentOutcome, IntentRequest, LlmProvider, LlmMode } from "./types.js";
import { buildSystemPrompt, buildUserPrompt, extractCommand } from "./prompt.js";
import { buildSchema } from "./schema.js";
import { serializeStructuredResponse, type StructuredResponse } from "./serialize.js";
import { treeNodeToLlmJson } from "./tree-export.js";
import type { TreeNode } from "../result.js";
import type { ModuleList } from "../data.js";
import type { ComponentPropertyMap } from "../modes/ui-parser.js";

export async function runIntent(provider: LlmProvider, req: IntentRequest): Promise<IntentOutcome> {
	const system = buildSystemPrompt({
		mode: req.mode,
		helpText: req.helpText,
		treeJson: req.treeJson,
	});
	const user = buildUserPrompt(req.nl);
	const start = Date.now();
	let raw: string;
	try {
		raw = await provider.complete({
			system,
			user,
			maxTokens: req.maxTokens ?? 200,
			signal: req.signal,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg };
	}
	const command = extractCommand(raw);
	if (!command) {
		return { ok: false, error: "model returned empty command", raw };
	}
	if (command.toLowerCase().startsWith("error")) {
		return { ok: false, error: command, raw };
	}
	return {
		ok: true,
		result: {
			command,
			raw,
			durationMs: Date.now() - start,
		},
	};
}

export interface StructuredIntentRequest {
	mode: LlmMode;
	nl: string;
	tree: TreeNode | null;
	helpText: string;
	moduleList?: ModuleList;
	componentProperties?: ComponentPropertyMap;
	signal?: AbortSignal;
	maxTokens?: number;
}

/** Schema-constrained intent pipeline. Builds a JSON schema from the live tree
 *  + module list, asks the provider to emit JSON matching it, and serialises
 *  the structured response back into a CLI command string.
 *  Eliminates whole classes of model errors (path prefixes, hallucinated IDs,
 *  invented chain names, array indexing) at decode time. */
export async function runStructuredIntent(
	provider: LlmProvider,
	req: StructuredIntentRequest,
): Promise<IntentOutcome> {
	const schema = buildSchema({
		mode: req.mode,
		tree: req.tree,
		moduleList: req.moduleList,
		componentProperties: req.componentProperties,
	});
	const treeJson = treeNodeToLlmJson(req.tree, {
		moduleList: req.moduleList,
		componentProperties: req.componentProperties,
	});
	const system = buildStructuredSystemPrompt(req.mode, req.helpText, treeJson);
	const user = `Request: ${req.nl}`;
	const start = Date.now();
	let raw: string;
	try {
		raw = await provider.complete({
			system,
			user,
			maxTokens: req.maxTokens ?? 400,
			signal: req.signal,
			format: schema,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg };
	}
	let parsed: StructuredResponse | null = null;
	try {
		parsed = JSON.parse(raw) as StructuredResponse;
	} catch {
		// Schema-as-object may be silently ignored by older Ollama versions
		// (< 0.5). Retry once with format: "json" (any-JSON mode), which
		// every Ollama since 0.1 supports. The prompt already describes the
		// shape, so the model should still produce valid JSON.
		try {
			const fallback = await provider.complete({
				system,
				user,
				maxTokens: req.maxTokens ?? 400,
				signal: req.signal,
				format: "json" as unknown as Record<string, unknown>,
			});
			parsed = JSON.parse(fallback) as StructuredResponse;
			raw = fallback;
		} catch {
			return { ok: false, error: "model returned non-JSON output (schema mode + json fallback both failed)", raw };
		}
	}
	if (!parsed) {
		return { ok: false, error: "structured parse produced null", raw };
	}
	if (!parsed.commands || parsed.commands.length === 0) {
		return { ok: false, error: "structured response has no commands", raw };
	}
	let command: string;
	try {
		command = serializeStructuredResponse(req.mode, parsed);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: `serialize failed: ${msg}`, raw };
	}
	return {
		ok: true,
		result: {
			command,
			raw,
			durationMs: Date.now() - start,
		},
	};
}

function buildStructuredSystemPrompt(mode: LlmMode, helpText: string, treeJson: unknown): string {
	return [
		`You translate a user request into a structured command for hise-cli ${mode} mode.`,
		"",
		"OUTPUT FORMAT — strict JSON, single object with `commands` array. Each command MUST include a `kind` field; the other fields depend on the kind:",
		"",
		"  add:    {\"kind\":\"add\",\"moduleType\":\"<TypeId>\",\"alias\":\"<optional name>\",\"parent\":\"<id>\",\"chain\":\"fx|gain|pitch|midi|children\"}",
		"  remove: {\"kind\":\"remove\",\"target\":\"<id>\"}",
		"  set:    {\"kind\":\"set\",\"target\":\"<id>\",\"param\":\"<paramName>\",\"value\":<number|string|boolean>}",
		"  clone:  {\"kind\":\"clone\",\"target\":\"<id>\",\"count\":<int>}",
		"  rename: {\"kind\":\"rename\",\"target\":\"<id>\",\"name\":\"<newName>\"}",
		"  bypass/enable: {\"kind\":\"bypass|enable\",\"target\":\"<id>\"}",
		"  show:   {\"kind\":\"show\",\"what\":\"tree|types|target\",\"target\":\"<id?>\",\"filter\":\"<str?>\"}",
		"  load:   {\"kind\":\"load\",\"source\":\"<path>\",\"target\":\"<id>\"}",
		"  cd:     {\"kind\":\"cd\",\"path\":\"<id>\"}",
		"  pwd / ls / reset: {\"kind\":\"pwd|ls|reset\"}",
		"",
		"NEVER emit `{\"command\":\"...\"}` — that is wrong shape. ALWAYS use `{\"kind\":...}` with the appropriate fields.",
		"",
		"EXAMPLES",
		"\"add a reverb to master\" → {\"commands\":[{\"kind\":\"add\",\"moduleType\":\"SimpleReverb\",\"parent\":\"Master Chain\",\"chain\":\"fx\"}]}",
		"\"set master volume to -6\" → {\"commands\":[{\"kind\":\"set\",\"target\":\"Master Chain\",\"param\":\"Volume\",\"value\":-6}]}",
		"\"transpose Sine1 one octave up\" → {\"commands\":[{\"kind\":\"set\",\"target\":\"Sine1\",\"param\":\"OctaveTranspose\",\"value\":1}]}",
		"",
		"RULES",
		"- Use ONLY ids that appear in the tree below.",
		"- For `set`, the `param` field MUST be one of the values in that module's `params` list (shown in the tree). Never invent.",
		"- Never qualify ids with parent paths (write `Sine1`, not `Master Chain.Sine1`).",
		"- Multi-step requests fill multiple entries in the `commands` array.",
		"- Reserve refusal for impossible requests; otherwise emit the closest valid command.",
		"",
		`MODE HELP (${mode})`,
		helpText,
		"",
		"CURRENT TREE (JSON, with each module's available `params` listed)",
		"```json",
		JSON.stringify(treeJson, null, 2),
		"```",
	].join("\n");
}

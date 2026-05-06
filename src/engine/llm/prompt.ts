import type { LlmMode } from "./types.js";

export interface SystemPromptInput {
	mode: LlmMode;
	helpText: string;
	treeJson: unknown;
	treeSchemaHint?: string;
}

const TREE_SCHEMA_HINTS: Record<LlmMode, string> = {
	builder:
		"Each node has an `id` (module instance name), `type` (module type), `nodeKind` (module|chain), and optional `children`. Modulator chains (gain/pitch/etc.) appear as nodeKind=chain children of their parent module.",
	ui: "Each node has an `id` (component name), `type` (component type, e.g. ScriptButton), and optional `children` (nested components inside ScriptPanel containers).",
	dsp: "Tree describes the loaded DspNetwork: `network` name, `host` script processor, `root` chain with nested nodes (each with `id`, factory `type` like core.oscillator, and `params`), separate `controlNodes` (modulators), and `connections` (modulation edges from src to target.param).",
};

export function buildSystemPrompt(input: SystemPromptInput): string {
	const { mode, helpText, treeJson } = input;
	const schemaHint = input.treeSchemaHint ?? TREE_SCHEMA_HINTS[mode];
	const sections: string[] = [
		`You translate a user request into exactly ONE ${mode} mode command body for the hise-cli tool.`,
		"",
		"OUTPUT RULES",
		`- Output ONLY the command body. NEVER include \`hise-cli\`, \`-${mode}\`, or surrounding quotes.`,
		"- No prose, no code fences, no explanation. Just the bare command.",
		"- Use IDs from the TREE below EXACTLY as written (case- and space-sensitive — `Master Chain` is one ID with a space, NOT two words).",
		"- Use module/component/factory names from the help text (case-sensitive).",
		"- ONLY include values the user explicitly stated. NEVER invent names, aliases, positions, sizes, parents, or chains. If a name/position is optional and the user did not mention one, OMIT it.",
		"- Module IDs are unique across the whole tree. Reference them by ID alone — do NOT prefix with parent path (e.g. write `LFO1`, not `Lead.LFO1`).",
		"- For comma-chained commands, separate with ', '.",
		"- Prefer target inheritance for repeated `set` on same target: `set X.A to 1, B to 2`.",
		"- Reserve ERROR output for genuinely impossible or contradictory requests, NOT for cases where the user simply omitted optional details.",
		"",
		"COMMAND VOCABULARY HINTS",
		"- \"where am I\" / \"current path\" / \"current location\" → `pwd`",
		"- \"list\" / \"list children\" / \"what's here\" → `ls` (no need to `cd` first; `ls` lists current location)",
		"- \"show tree\" / \"display the whole tree\" / \"full hierarchy\" → `show tree`",
		"- \"show <thing>\" / \"inspect <thing>\" / \"what's inside <thing>\" → `show <thing>`",
		"- For `set <id>.<param>`: <id> is the bare module ID. NEVER write `set <parent>.<id>.<param>` — even if you know the parent.",
		"",
		`MODE HELP (${mode})`,
		helpText,
		"",
		"CURRENT TREE (JSON)",
		schemaHint,
		"```json",
		JSON.stringify(treeJson, null, 2),
		"```",
	];
	return sections.join("\n");
}

export function buildUserPrompt(nl: string): string {
	return `Request: ${nl}\nCommand:`;
}

const VERB_PATTERN = /^(add|remove|clone|move|rename|set|get|load|show|bypass|enable|connect|disconnect|create_parameter|create|init|save|use|cd|ls|pwd|reset|screenshot|error)\b/i;

/** Strip thinking blocks, code fences, shell-invocation wrappers, and prose to extract the bare command. */
export function extractCommand(raw: string): string {
	const stripped = raw
		.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
		.replace(/<\|.*?\|>/g, "")
		.replace(/```[a-z]*\n?/gi, "")
		.replace(/```/g, "")
		.replace(/^Command:\s*/gim, "")
		.trim();
	if (!stripped) return "";
	const lines = stripped.split("\n").map((l) => l.trim()).filter(Boolean);
	if (lines.length === 0) return "";
	const verbLine = lines.find((l) => VERB_PATTERN.test(unwrapShellInvocation(l)));
	const chosen = verbLine ?? lines[lines.length - 1];
	return unwrapShellInvocation(chosen);
}

function unwrapShellInvocation(line: string): string {
	let s = line.trim();
	s = s.replace(/^hise-cli\s+-(?:builder|ui|dsp)\s+/i, "");
	s = s.replace(/^--target:(?:"[^"]*"|'[^']*'|[^\s]+)\s+/i, "");
	s = s.trim();
	if (s.startsWith("\"") && s.endsWith("\"")) return s.slice(1, -1);
	if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
	return s;
}

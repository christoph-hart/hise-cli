import type { McpClient, McpJsonValue } from "../mcp/types.js";
import { errorResult, jsonResult, markdownResult, type CommandResult } from "../result.js";
import type { TokenSpan } from "../highlight/tokens.js";
import type { CompletionItem, CompletionResult, Mode, SessionContext } from "./mode.js";
import { MODE_ACCENTS } from "./mode.js";

const COMMON_TOOLS = [
	"search_hise",
	"explore_hise",
	"query_scripting_api",
	"query_ui_property",
	"query_module_parameter",
	"search_examples",
	"get_example",
	"get_tutorial",
	"get_doc_content",
	"get_resource",
	"server_status",
	"list_ui_components",
	"list_scripting_namespaces",
	"list_module_types",
	"tools/list",
	"resources/list",
	"resources/read",
	"prompts/list",
	"prompts/get",
];

const QUERY_ARG_TOOLS = new Set(["explore_hise", "search_hise", "search_examples"]);
const ID_ARG_TOOLS = new Set(["get_example", "get_tutorial", "get_resource"]);

export class McpMode implements Mode {
	readonly id = "mcp" as const;
	readonly name = "MCP";
	readonly accent = MODE_ACCENTS.mcp;
	readonly prompt = "[mcp] > ";
	private readonly client: McpClient | null;
	private completions: CompletionItem[] = COMMON_TOOLS.map((label) => ({ label, insertText: label }));

	constructor(client: McpClient | null) {
		this.client = client;
	}

	async onEnter(_session: SessionContext): Promise<void> {
		// Keep mode entry side-effect free. Dynamic MCP discovery is available via
		// tools/list and resources/list, but background HTTP calls can keep TUI
		// shutdown alive after /quit.
	}

	async parse(input: string, _session: SessionContext): Promise<CommandResult> {
		if (!this.client) return errorResult("MCP client is not available in this frontend.");
		const parsed = parseMcpModeInput(input);
		if (!parsed) return markdownResult(MCP_MODE_HELP);
		try {
			const result = parsed.kind === "tool"
				? await this.client.callTool({ name: parsed.target, arguments: parsed.args })
				: await this.client.call({ method: parsed.target, params: parsed.args });
			return renderMcpResult(result);
		} catch (err) {
			return errorResult("MCP request failed", err instanceof Error ? err.message : String(err));
		}
	}

	complete(input: string, cursor: number): CompletionResult {
		const beforeCursor = input.slice(0, cursor);
		if (/\s/.test(beforeCursor)) return { items: [], from: cursor, to: cursor };
		const trimmed = input.trimStart();
		const leading = input.length - trimmed.length;
		const prefix = trimmed.slice(0, cursor - leading).toLowerCase();
		const items = this.completions
			.filter((item) => item.label.toLowerCase().startsWith(prefix))
			.sort((a, b) => a.label.localeCompare(b.label));
		return { items, from: leading, to: cursor, label: "MCP tools" };
	}

	tokenizeInput(value: string): TokenSpan[] {
		if (!value) return [];
		const match = value.match(/^(\s*)(\S+)([\s\S]*)$/);
		if (!match) return [{ text: value, token: "plain" }];
		const spans: TokenSpan[] = [];
		if (match[1]) spans.push({ text: match[1], token: "plain" });
		spans.push({ text: match[2]!, token: "mcp", bold: true });
		if (match[3]) spans.push({ text: match[3]!, token: "plain" });
		return spans;
	}
}

export function parseMcpModeInput(input: string): { kind: "tool" | "method"; target: string; args: McpJsonValue } | null {
	const trimmed = input.trim();
	if (!trimmed || trimmed === "help") return null;
	const [target, ...restParts] = trimmed.split(/\s+/);
	const rest = trimmed.slice(target!.length).trim();
	return { kind: target!.includes("/") ? "method" : "tool", target: target!, args: parseMcpModeArgs(target!, rest) };
}

function parseMcpModeArgs(target: string, rest: string): McpJsonValue {
	if (!rest) return {};
	if (rest.startsWith("{") || rest.startsWith("[")) return JSON.parse(rest) as McpJsonValue;
	if (target === "resources/read") return { uri: rest };
	if (QUERY_ARG_TOOLS.has(target)) return { query: rest };
	if (target === "query_scripting_api") return { apiCall: rest };
	if (target === "query_ui_property") return { componentProperty: rest };
	if (target === "query_module_parameter") return { moduleParameter: rest };
	if (target === "get_doc_content") return rest.startsWith("/") ? { url: rest } : { id: rest };
	if (ID_ARG_TOOLS.has(target)) return { id: rest };
	throw new Error(`Pass JSON arguments for ${target}, e.g. ${target} {"query":"${escapeJson(rest)}"}`);
}

function renderMcpResult(result: McpJsonValue): CommandResult {
	const text = extractTextBlocks(result);
	if (text.length > 0) return markdownResult(text.join("\n\n---\n\n"));
	return jsonResult(result, JSON.stringify(result, null, 2));
}

function extractTextBlocks(value: McpJsonValue): string[] {
	const record = toRecord(value);
	const out: string[] = [];
	for (const item of asRecords(record.content)) {
		if (item.type === "text" && typeof item.text === "string") out.push(item.text);
	}
	for (const item of asRecords(record.contents)) {
		if (typeof item.text === "string") out.push(item.text);
	}
	return out;
}

function toRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecords(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function escapeJson(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

const MCP_MODE_HELP = `# MCP Mode

Type an MCP tool or method as the first token. Everything after the first space is passed as arguments.

Examples:

\`\`\`text
explore_hise sampler
search_hise Content.addKnob
query_scripting_api ScriptSlider.setControlCallback
resources/read hise://style-guides/hisescript-style
explore_hise {"query":"sampler","source":"docs"}
\`\`\``;

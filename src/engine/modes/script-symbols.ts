import type { ScriptingApi, ApiClass } from "../data.js";
import type { HiseConnection, HiseResponse } from "../hise.js";
import { isEnvelopeResponse, isErrorResponse } from "../hise.js";
import type { CommandResult, TreeNode } from "../result.js";
import { errorResult, jsonResult, preformattedResult } from "../result.js";
import { renderTreeBox } from "./builder-ops.js";

export interface ScriptSymbolNode {
	id: string;
	type: string;
	expression?: string;
	dataType?: string;
	value?: string;
	location?: { file: string; charNumber: number; available: boolean };
	children?: ScriptSymbolNode[];
}

export interface ScriptTreeResponse {
	moduleId: string;
	namespace?: string;
	format?: "tree" | "flat";
	compact?: boolean;
	totalMatches?: number;
	returned?: number;
	truncated?: boolean;
	tree?: ScriptSymbolNode[];
	apiVersion?: string;
}

export interface ScriptShowFilters {
	namespace?: string;
	search?: string;
	type?: string;
	dataType?: string;
	format?: "tree" | "flat";
	symbolsOnly: boolean;
	maxDepth?: number;
	limit?: number;
}

export type ScriptShowCommand =
	| { kind: "tree"; filters: ScriptShowFilters }
	| { kind: "symbol"; expression: string };

export function defaultScriptShowFilters(): ScriptShowFilters {
	return { symbolsOnly: false };
}

export function parseScriptShowTokens(tokens: string[]): ScriptShowCommand | { error: string } {
	if (tokens[0] !== "show") return { error: "script show command must start with show" };
	const target = tokens[1];
	if (!target) return { error: "script show requires tree or an expression" };
	if (target !== "tree") return { kind: "symbol", expression: target };

	const filters = defaultScriptShowFilters();
	let positionalSearch: string | undefined;
	for (let i = 2; i < tokens.length; i++) {
		const arg = tokens[i]!;
		if (arg === "--symbols-only") {
			filters.symbolsOnly = true;
			continue;
		}
		if (arg === "--namespace" || arg === "--search" || arg === "--type" || arg === "--data-type" || arg === "--format" || arg === "--max-depth" || arg === "--limit") {
			const value = tokens[i + 1];
			if (!value || value.startsWith("--")) return { error: `${arg} requires a value` };
			const err = assignFilter(filters, arg, value);
			if (err) return { error: err };
			i++;
			continue;
		}
		if (arg.startsWith("--")) return { error: `Unexpected argument for script show tree: ${arg}` };
		positionalSearch = positionalSearch ? `${positionalSearch} ${arg}` : arg;
	}
	if (positionalSearch && filters.search) return { error: "script show tree accepts either a positional search or --search, not both" };
	if (positionalSearch) filters.search = positionalSearch;
	return { kind: "tree", filters };
}

function assignFilter(filters: ScriptShowFilters, flag: string, value: string): string | null {
	if (flag === "--namespace") filters.namespace = value;
	else if (flag === "--search") filters.search = value;
	else if (flag === "--type") filters.type = value;
	else if (flag === "--data-type") filters.dataType = value;
	else if (flag === "--format") {
		if (value !== "tree" && value !== "flat") return "--format must be tree or flat";
		filters.format = value;
	} else if (flag === "--max-depth") {
		const n = Number(value);
		if (!Number.isInteger(n) || n < 0) return "--max-depth must be a non-negative integer";
		filters.maxDepth = n;
	} else if (flag === "--limit") {
		const n = Number(value);
		if (!Number.isInteger(n) || n < 1) return "--limit must be a positive integer";
		filters.limit = n;
	}
	return null;
}

export async function executeScriptShow(
	connection: HiseConnection,
	moduleId: string,
	command: ScriptShowCommand,
	options: { forLlm?: boolean; api?: ScriptingApi | null; updateTree?: (tree: TreeNode | null) => void } = {},
): Promise<CommandResult> {
	if (command.kind === "symbol") {
		const response = await fetchScriptTree(connection, moduleId, { ...defaultScriptShowFilters(), search: command.expression, format: "flat", limit: 1 });
		if ("error" in response) return errorResult(response.error);
		const enriched = enrichTreeResponse(response.value, options.api ?? null);
		return jsonResult(enriched);
	}

	const response = await fetchScriptTree(connection, moduleId, command.filters);
	if ("error" in response) return errorResult(response.error);
	const tree = scriptTreeToTreeNode(moduleId, response.value.tree ?? []);
	options.updateTree?.(tree);
	if (options.forLlm) return jsonResult(response.value);
	return preformattedResult(renderTreeBox(tree), undefined, true);
}

export async function fetchScriptTree(
	connection: HiseConnection,
	moduleId: string,
	filters: ScriptShowFilters,
): Promise<{ value: ScriptTreeResponse } | { error: string }> {
	const params = new URLSearchParams({ moduleId });
	if (filters.namespace) params.set("namespace", filters.namespace);
	if (filters.search) params.set("search", filters.search);
	if (filters.type) params.set("type", filters.type);
	if (filters.dataType) params.set("dataType", filters.dataType);
	if (filters.format) params.set("format", filters.format);
	if (filters.symbolsOnly) params.set("compact", "true");
	if (filters.maxDepth !== undefined) params.set("maxDepth", String(filters.maxDepth));
	if (filters.limit !== undefined) params.set("limit", String(filters.limit));
	const response = await connection.get(`/api/script/tree?${params.toString()}`);
	return serializeScriptTreeResponse(response);
}

export function serializeScriptTreeResponse(response: HiseResponse): { value: ScriptTreeResponse } | { error: string } {
	if (isErrorResponse(response)) return { error: response.message };
	if (!isEnvelopeResponse(response)) return { error: "Unexpected response from HISE" };
	if (!response.success || response.errors.length > 0) {
		return { error: response.errors.map((e) => e.errorMessage).join("\n") || String(response.result ?? "script tree request failed") };
	}
	const { success: _success, logs: _logs, errors: _errors, ...value } = response;
	return { value: value as ScriptTreeResponse };
}

export function scriptTreeToTreeNode(moduleId: string, nodes: ScriptSymbolNode[]): TreeNode {
	return {
		label: moduleId,
		id: moduleId,
		type: "ScriptSymbols",
		children: nodes.map(symbolToTreeNode),
	};
}

function symbolToTreeNode(node: ScriptSymbolNode): TreeNode {
	return {
		label: node.id,
		id: node.expression ?? node.id,
		type: node.dataType ? `${node.type} · ${node.dataType}` : node.type,
		children: (node.children ?? []).map(symbolToTreeNode),
	};
}

function enrichTreeResponse(response: ScriptTreeResponse, api: ScriptingApi | null): ScriptTreeResponse & { api?: Record<string, unknown> } {
	const first = findFirstSymbol(response.tree ?? []);
	if (!first?.dataType || !api) return response;
	const cls = findApiClass(api, first.dataType);
	if (!cls) return response;
	const className = first.dataType;
	return {
		...response,
		api: {
			class: className,
			category: cls.category,
			description: cls.description,
			methods: cls.methods.map((method) => `${className}.${method.name}`),
		},
	};
}

function findFirstSymbol(nodes: ScriptSymbolNode[]): ScriptSymbolNode | null {
	for (const node of nodes) {
		if (node.dataType && node.dataType !== "Namespace") return node;
		const child = findFirstSymbol(node.children ?? []);
		if (child) return child;
	}
	return null;
}

function findApiClass(api: ScriptingApi, name: string): ApiClass | null {
	return api.classes[name] ?? api.classes[Object.keys(api.classes).find((key) => key.toLowerCase() === name.toLowerCase()) ?? ""] ?? null;
}

export function splitScriptShowInput(input: string): string[] {
	const out: string[] = [];
	const re = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(input))) out.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(["'])/g, "$1"));
	return out;
}

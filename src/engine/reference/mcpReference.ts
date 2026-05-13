import type { CommandResult } from "../result.js";
import { errorResult, jsonResult, markdownResult } from "../result.js";
import type { McpClient, McpJsonValue } from "../mcp/types.js";

export async function callMcpReference(
	client: McpClient | null | undefined,
	name: string,
	args: McpJsonValue = {},
): Promise<CommandResult> {
	if (!client) return errorResult("MCP docs unavailable", "MCP client is not available in this frontend.");
	try {
		return renderMcpReferenceResult(await client.callTool({ name, arguments: args }));
	} catch (err) {
		return errorResult("MCP docs unavailable", err instanceof Error ? err.message : String(err));
	}
}

export async function listMcpReference(
	client: McpClient | null | undefined,
	name: string,
	filter?: string,
	args: McpJsonValue = {},
): Promise<CommandResult> {
	if (!client) return errorResult("MCP docs unavailable", "MCP client is not available in this frontend.");
	try {
		const result = await client.callTool({ name, arguments: args });
		return renderMcpReferenceResult(filterMcpListResult(result, filter));
	} catch (err) {
		return errorResult("MCP docs unavailable", err instanceof Error ? err.message : String(err));
	}
}

export function renderMcpReferenceResult(result: McpJsonValue): CommandResult {
	const text = extractTextBlocks(result);
	if (text.length > 0) return markdownResult(text.join("\n\n---\n\n"));
	return jsonResult(result, JSON.stringify(result, null, 2));
}

export function extractTextBlocks(value: McpJsonValue): string[] {
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

function filterMcpListResult(result: McpJsonValue, filter?: string): McpJsonValue {
	if (!filter) return result;
	const needle = filter.toLowerCase();
	if (Array.isArray(result)) return result.filter((item) => JSON.stringify(item).toLowerCase().includes(needle)) as McpJsonValue;
	const record = toRecord(result);
	const content = asRecords(record.content);
	if (content.length > 0) {
		return {
			...record,
			content: content.map((item) => {
				if (item.type !== "text" || typeof item.text !== "string") return item;
				const lines = item.text.split("\n").filter((line) => line.toLowerCase().includes(needle));
				return { ...item, text: lines.length > 0 ? lines.join("\n") : `(no matches for "${filter}")` };
			}),
		} as McpJsonValue;
	}
	const contents = asRecords(record.contents);
	if (contents.length > 0) {
		return {
			...record,
			contents: contents.filter((item) => JSON.stringify(item).toLowerCase().includes(needle)),
		} as McpJsonValue;
	}
	const filteredEntries = Object.entries(record).filter(([, value]) => JSON.stringify(value).toLowerCase().includes(needle));
	return Object.fromEntries(filteredEntries) as McpJsonValue;
}

function toRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecords(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

import type { McpCliCommand } from "./args.js";
import { cliError, type CliErrorPayload } from "./errors.js";
import type { McpCallRequest, McpJsonValue, McpToolRequest } from "../engine/mcp/types.js";

export interface PreparedMcpCommand {
	request: McpCallRequest | McpToolRequest;
	kind: "method" | "tool";
	url?: string;
	timeoutMs?: number;
}

export async function prepareMcpCommand(
	command: McpCliCommand,
	readSource: (source: Extract<McpCliCommand["argsSource"], { type: "file" | "stdin" }>) => Promise<string>,
): Promise<PreparedMcpCommand | CliErrorPayload> {
	const args = await resolveMcpArgs(command.argsSource, readSource);
	if (!args.ok) return args;
	if (command.mode === "method") {
		return {
			kind: "method",
			request: { method: command.target, params: args.value },
			url: command.url,
			timeoutMs: command.timeoutMs,
		};
	}
	if (!isObject(args.value)) return cliError("usage_error", "MCP tool arguments must be a JSON object");
	return {
		kind: "tool",
		request: { name: command.target, arguments: args.value },
		url: command.url,
		timeoutMs: command.timeoutMs,
	};
}

export function fieldsToMcpArgs(fields: Array<{ key: string; value: string | true }>): Record<string, McpJsonValue> {
	const out: Record<string, McpJsonValue> = {};
	for (const field of fields) {
		const key = kebabToCamel(field.key);
		const value = field.value === true ? true : parseFieldValue(field.value);
		const existing = out[key];
		if (existing === undefined) {
			out[key] = value;
		} else if (Array.isArray(existing)) {
			existing.push(value);
		} else {
			out[key] = [existing, value];
		}
	}
	return out;
}

async function resolveMcpArgs(
	source: McpCliCommand["argsSource"],
	readSource: (source: Extract<McpCliCommand["argsSource"], { type: "file" | "stdin" }>) => Promise<string>,
): Promise<{ ok: true; value: McpJsonValue } | CliErrorPayload> {
	try {
		if (source.type === "none") return { ok: true, value: {} };
		if (source.type === "fields") return { ok: true, value: fieldsToMcpArgs(source.fields) };
		const raw = source.type === "inline" ? source.json : await readSource(source);
		return { ok: true, value: parseJsonValue(raw) };
	} catch (err) {
		return cliError("usage_error", err instanceof Error ? err.message : String(err));
	}
}

function parseJsonValue(raw: string): McpJsonValue {
	try {
		return JSON.parse(raw) as McpJsonValue;
	} catch (err) {
		throw new Error(`Invalid MCP JSON arguments: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function parseFieldValue(raw: string): McpJsonValue {
	const trimmed = raw.trim();
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (trimmed === "null") return null;
	if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
	if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
		return parseJsonValue(trimmed);
	}
	return raw;
}

function kebabToCamel(value: string): string {
	return value.replace(/-([a-z0-9])/g, (_match, ch: string) => ch.toUpperCase());
}

function isObject(value: McpJsonValue): value is Record<string, McpJsonValue> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

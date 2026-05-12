import type { CliErrorPayload } from "../cli/errors.js";
import { cliError } from "../cli/errors.js";
import type { McpCallOptions, McpCallRequest, McpClient, McpJsonValue, McpToolRequest } from "../engine/mcp/types.js";

export const DEFAULT_HISE_DOCS_API_URL = "http://localhost:4406";

interface RestMcpClientOptions {
	defaultUrl?: string;
	fetchImpl?: typeof fetch;
}

export class McpRestError extends Error {
	readonly payload: CliErrorPayload;

	constructor(payload: CliErrorPayload) {
		super(payload.error);
		this.payload = payload;
	}
}

export class RestMcpClient implements McpClient {
	private readonly defaultUrl: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: RestMcpClientOptions = {}) {
		this.defaultUrl = normalizeBaseUrl(options.defaultUrl ?? DEFAULT_HISE_DOCS_API_URL);
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async callTool(request: McpToolRequest, options: McpCallOptions = {}): Promise<McpJsonValue> {
		const baseUrl = normalizeBaseUrl(options.url ?? this.defaultUrl);
		const timeoutMs = options.timeoutMs ?? 60000;
		return this.fetchJson(`${baseUrl}/api/tools/${encodeURIComponent(request.name)}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify(request.arguments ?? {}),
		}, timeoutMs);
	}

	async call(request: McpCallRequest, options: McpCallOptions = {}): Promise<McpJsonValue> {
		if (request.method === "tools/list") {
			const baseUrl = normalizeBaseUrl(options.url ?? this.defaultUrl);
			return this.fetchJson(`${baseUrl}/api/tools`, { method: "GET", headers: { Accept: "application/json" } }, options.timeoutMs ?? 60000);
		}
		throw new McpRestError(cliError("usage_error", `MCP method ${request.method} is not supported by the HISE REST docs API`));
	}

	private async fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<McpJsonValue> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
			const text = await response.text();
			const value = text ? parseJson(text) : null;
			if (!response.ok) {
				throw new McpRestError(withValue(cliError("execution_error", `HISE docs API HTTP ${response.status}: ${extractErrorText(value)}`), value));
			}
			if (isToolError(value)) {
				throw new McpRestError(withValue(cliError("execution_error", `HISE docs tool failed: ${extractToolText(value)}`), value));
			}
			return value;
		} catch (err) {
			if (err instanceof McpRestError) throw err;
			throw new McpRestError(cliError("execution_error", `HISE docs API request failed: ${err instanceof Error ? err.message : String(err)}`));
		} finally {
			clearTimeout(timer);
		}
	}
}

export function mcpErrorPayload(err: unknown): CliErrorPayload {
	if (err instanceof McpRestError) return err.payload;
	return cliError("execution_error", err instanceof Error ? err.message : String(err));
}

function normalizeBaseUrl(url: string): string {
	const trimmed = url.replace(/\/+$/, "");
	if (trimmed.endsWith("/mcp")) return trimmed.slice(0, -"/mcp".length);
	if (trimmed.endsWith("/api/tools")) return trimmed.slice(0, -"/api/tools".length);
	if (trimmed.endsWith("/api")) return trimmed.slice(0, -"/api".length);
	return trimmed;
}

function withValue(payload: CliErrorPayload, value: McpJsonValue): CliErrorPayload {
	return { ...payload, value };
}

function parseJson(text: string): McpJsonValue {
	try {
		return JSON.parse(text) as McpJsonValue;
	} catch (err) {
		throw new Error(`Invalid JSON response: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function isToolError(value: McpJsonValue): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return value.ok === false || value.isError === true;
}

function extractErrorText(value: McpJsonValue): string {
	if (value && typeof value === "object" && !Array.isArray(value) && typeof value.error === "string") return value.error;
	return JSON.stringify(value);
}

function extractToolText(value: McpJsonValue): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
	const content = Array.isArray(value.content) ? value.content : [];
	const text = content
		.map((item) => item && typeof item === "object" && !Array.isArray(item) && typeof item.text === "string" ? item.text : null)
		.filter((item): item is string => Boolean(item))
		.join("\n");
	return text || JSON.stringify(value);
}

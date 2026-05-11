import type { CliErrorPayload } from "../cli/errors.js";
import { cliError } from "../cli/errors.js";
import type { McpCallOptions, McpCallRequest, McpClient, McpJsonValue, McpToolRequest } from "../engine/mcp/types.js";

export const DEFAULT_HISE_MCP_URL = "https://mcp.hise.dev/mcp";
const MCP_PROTOCOL_VERSION = "2024-11-05";

interface McpHttpClientOptions {
	defaultUrl?: string;
	clientVersion?: string;
	fetchImpl?: typeof fetch;
}

interface JsonRpcSuccess {
	jsonrpc: "2.0";
	id?: unknown;
	result: McpJsonValue;
}

interface JsonRpcFailure {
	jsonrpc: "2.0";
	id?: unknown;
	error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export class McpProtocolError extends Error {
	readonly payload: CliErrorPayload;

	constructor(payload: CliErrorPayload) {
		super(payload.error);
		this.payload = payload;
	}
}

export class HttpMcpClient implements McpClient {
	private readonly defaultUrl: string;
	private readonly clientVersion: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: McpHttpClientOptions = {}) {
		this.defaultUrl = options.defaultUrl ?? DEFAULT_HISE_MCP_URL;
		this.clientVersion = options.clientVersion ?? "dev";
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async callTool(request: McpToolRequest, options: McpCallOptions = {}): Promise<McpJsonValue> {
		return this.call({
			method: "tools/call",
			params: {
				name: request.name,
				arguments: request.arguments ?? {},
			},
		}, options);
	}

	async call(request: McpCallRequest, options: McpCallOptions = {}): Promise<McpJsonValue> {
		const url = options.url ?? this.defaultUrl;
		const timeoutMs = options.timeoutMs ?? 60000;
		try {
			await this.checkReady(url, timeoutMs);
			const session = await this.initialize(url, timeoutMs);
			await this.sendInitialized(url, session, timeoutMs);
			return await this.postJsonRpc(url, session, {
				jsonrpc: "2.0",
				id: 2,
				method: request.method,
				params: request.params ?? {},
			}, timeoutMs);
		} catch (err) {
			if (err instanceof McpProtocolError) throw err;
			throw new McpProtocolError(cliError("execution_error", `MCP request failed: ${err instanceof Error ? err.message : String(err)}`));
		}
	}

	private async checkReady(url: string, timeoutMs: number): Promise<void> {
		const readyUrl = siblingReadyUrl(url);
		if (!readyUrl) return;
		try {
			const response = await this.fetchWithTimeout(readyUrl, { method: "GET" }, timeoutMs);
			if (response.status === 404) return;
			if (!response.ok) throw new Error(`GET ${readyUrl} returned ${response.status}`);
			const text = await response.text();
			if (text.trim()) {
				const body = JSON.parse(text) as { status?: unknown };
				if (body.status && body.status !== "ready") throw new Error(`MCP server is not ready: ${String(body.status)}`);
			}
		} catch (err) {
			if (err instanceof SyntaxError) return;
			throw err;
		}
	}

	private async initialize(url: string, timeoutMs: number): Promise<string> {
		const body = {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "hise-cli", version: this.clientVersion },
			},
		};
		const response = await this.fetchWithTimeout(url, postOptions(body), timeoutMs);
		const sessionId = response.headers.get("mcp-session-id");
		if (!sessionId) {
			throw new McpProtocolError(cliError("execution_error", "MCP initialize response did not include mcp-session-id"));
		}
		await parseJsonRpcResponse(response);
		return sessionId;
	}

	private async sendInitialized(url: string, sessionId: string, timeoutMs: number): Promise<void> {
		const body = { jsonrpc: "2.0", method: "notifications/initialized", params: {} };
		const response = await this.fetchWithTimeout(url, postOptions(body, sessionId), timeoutMs);
		if (response.status === 202 || response.status === 204) return;
		if (!response.ok) throw new Error(`notifications/initialized returned ${response.status}`);
	}

	private async postJsonRpc(url: string, sessionId: string, body: object, timeoutMs: number): Promise<McpJsonValue> {
		const response = await this.fetchWithTimeout(url, postOptions(body, sessionId), timeoutMs);
		return parseJsonRpcResponse(response);
	}

	private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await this.fetchImpl(url, { ...init, signal: controller.signal });
		} finally {
			clearTimeout(timer);
		}
	}
}

export function mcpErrorPayload(err: unknown): CliErrorPayload {
	if (err instanceof McpProtocolError) return err.payload;
	return cliError("execution_error", err instanceof Error ? err.message : String(err));
}

function postOptions(body: object, sessionId?: string): RequestInit {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};
	if (sessionId) headers["mcp-session-id"] = sessionId;
	return { method: "POST", headers, body: JSON.stringify(body) };
}

async function parseJsonRpcResponse(response: Response): Promise<McpJsonValue> {
	if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
	const text = await response.text();
	const parsed = parseMcpResponseText(text);
	if ("error" in parsed) {
		throw new McpProtocolError({
			ok: false,
			code: "execution_error",
			error: `MCP error ${parsed.error.code}: ${parsed.error.message}`,
			value: parsed,
		});
	}
	return parsed.result;
}

export function parseMcpResponseText(text: string): JsonRpcResponse {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("MCP response was empty");
	const dataLines = trimmed.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice("data:".length).trim());
	const jsonText = dataLines.length > 0 ? dataLines.join("\n") : trimmed;
	const parsed = JSON.parse(jsonText) as JsonRpcResponse;
	if (!parsed || typeof parsed !== "object" || parsed.jsonrpc !== "2.0") throw new Error("Invalid MCP JSON-RPC response");
	return parsed;
}

function siblingReadyUrl(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (!/^https?:$/.test(parsed.protocol)) return null;
		if (!parsed.pathname.endsWith("/mcp")) return null;
		parsed.pathname = parsed.pathname.slice(0, -"/mcp".length) + "/ready";
		parsed.search = "";
		return parsed.toString();
	} catch {
		return null;
	}
}

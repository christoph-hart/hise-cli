import { describe, expect, it, vi } from "vitest";
import { HttpMcpClient, parseMcpResponseText } from "./httpClient.js";

describe("HttpMcpClient", () => {
	it("initializes, sends initialized notification, and calls tools", async () => {
		const calls: Array<{ url: string; body?: unknown; headers?: HeadersInit }> = [];
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers });
			if (String(url).endsWith("/ready")) return new Response('{"status":"ready"}', { status: 200, headers: { "Content-Type": "application/json" } });
			const body = init?.body ? JSON.parse(String(init.body)) as { method?: string } : {};
			if (body.method === "initialize") {
				return new Response('event: message\ndata: {"result":{"protocolVersion":"2024-11-05"},"jsonrpc":"2.0","id":1}\n', {
					status: 200,
					headers: { "Content-Type": "text/event-stream", "mcp-session-id": "abc" },
				});
			}
			if (body.method === "notifications/initialized") return new Response("", { status: 202 });
			return new Response('event: message\ndata: {"result":{"content":[{"type":"text","text":"ok"}]},"jsonrpc":"2.0","id":2}\n', { status: 200, headers: { "Content-Type": "text/event-stream" } });
		}) as unknown as typeof fetch;

		const client = new HttpMcpClient({ defaultUrl: "http://localhost:4406/mcp", fetchImpl });
		const result = await client.callTool({ name: "search_hise", arguments: { query: "sampler" } });

		expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(calls.map((call) => call.body && (call.body as { method?: string }).method)).toEqual([
			undefined,
			"initialize",
			"notifications/initialized",
			"tools/call",
		]);
		expect((calls[3]!.body as { params: unknown })).toEqual({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "search_hise", arguments: { query: "sampler" } },
		});
	});

	it("parses SSE JSON-RPC responses", () => {
		expect(parseMcpResponseText('event: message\ndata: {"result":{"ok":true},"jsonrpc":"2.0","id":2}\n')).toEqual({
			jsonrpc: "2.0",
			id: 2,
			result: { ok: true },
		});
	});
});

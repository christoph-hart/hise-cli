import { describe, expect, it, vi } from "vitest";
import { RestMcpClient } from "./restClient.js";

describe("RestMcpClient", () => {
	it("posts tool calls to the REST tool endpoint", async () => {
		const calls: Array<{ url: string; body?: unknown; method?: string }> = [];
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			return new Response(JSON.stringify({ tool: "query_module_parameter", ok: true, isError: false, content: [{ type: "text", text: "ok" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const client = new RestMcpClient({ defaultUrl: "http://localhost:4406", fetchImpl });
		const result = await client.callTool({ name: "query_module_parameter", arguments: { moduleParameter: "WaveSynth.Gain" } });

		expect(result).toEqual({ tool: "query_module_parameter", ok: true, isError: false, content: [{ type: "text", text: "ok" }] });
		expect(calls).toEqual([{ url: "http://localhost:4406/api/tools/query_module_parameter", method: "POST", body: { moduleParameter: "WaveSynth.Gain" } }]);
	});

	it("normalizes legacy MCP endpoint URLs", async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ count: 0, tools: [] }), { status: 200 })) as unknown as typeof fetch;
		const client = new RestMcpClient({ defaultUrl: "http://localhost:4406/mcp", fetchImpl });

		await client.call({ method: "tools/list", params: {} });

		expect(fetchImpl).toHaveBeenCalledWith("http://localhost:4406/api/tools", expect.objectContaining({ method: "GET" }));
	});

	it("rejects unsupported raw MCP methods", async () => {
		const client = new RestMcpClient({ defaultUrl: "http://localhost:4406", fetchImpl: vi.fn() as unknown as typeof fetch });

		await expect(client.call({ method: "resources/read", params: { uri: "hise://style-guides/hisescript-style" } }))
			.rejects.toThrow("resources/read is not supported");
	});

	it("turns tool error results into execution errors", async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
			tool: "query_module_parameter",
			ok: false,
			isError: true,
			content: [{ type: "text", text: "Unknown module" }],
		}), { status: 400 })) as unknown as typeof fetch;
		const client = new RestMcpClient({ defaultUrl: "http://localhost:4406", fetchImpl });

		await expect(client.callTool({ name: "query_module_parameter", arguments: { moduleParameter: "Nope.Gain" } }))
			.rejects.toThrow("HISE docs API HTTP 400");
	});
});

import { describe, expect, it } from "vitest";
import { fieldsToMcpArgs, prepareMcpCommand } from "./mcp.js";

describe("mcp cli helpers", () => {
	it("converts field flags to MCP args", () => {
		expect(fieldsToMcpArgs([
			{ key: "api-call", value: "ScriptSlider.setControlCallback" },
			{ key: "examples", value: "false" },
			{ key: "limit", value: "3" },
			{ key: "methods", value: "fillRect" },
			{ key: "methods", value: "print" },
		])).toEqual({
			apiCall: "ScriptSlider.setControlCallback",
			examples: false,
			limit: 3,
			methods: ["fillRect", "print"],
		});
	});

	it("prepares tool calls", async () => {
		const prepared = await prepareMcpCommand({
			target: "search_hise",
			mode: "tool",
			argsSource: { type: "fields", fields: [{ key: "query", value: "sampler" }] },
		}, async () => "{}");

		expect(prepared).toEqual({
			kind: "tool",
			request: { name: "search_hise", arguments: { query: "sampler" } },
		});
	});

	it("prepares raw method calls", async () => {
		const prepared = await prepareMcpCommand({
			target: "resources/read",
			mode: "method",
			argsSource: { type: "inline", json: '{"uri":"hise://style-guides/hisescript-style"}' },
		}, async () => "{}");

		expect(prepared).toEqual({
			kind: "method",
			request: { method: "resources/read", params: { uri: "hise://style-guides/hisescript-style" } },
		});
	});
});

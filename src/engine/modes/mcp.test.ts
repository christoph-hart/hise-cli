import { describe, expect, it } from "vitest";
import { McpMode, parseMcpModeInput } from "./mcp.js";
import type { McpClient } from "../mcp/types.js";

describe("McpMode", () => {
	it("parses convenience query tools", () => {
		expect(parseMcpModeInput("explore_hise arpeggiator tempo sync")).toEqual({
			kind: "tool",
			target: "explore_hise",
			args: { query: "arpeggiator tempo sync" },
		});
	});

	it("parses resource read convenience syntax", () => {
		expect(parseMcpModeInput("resources/read hise://style-guides/hisescript-style")).toEqual({
			kind: "method",
			target: "resources/read",
			args: { uri: "hise://style-guides/hisescript-style" },
		});
	});

	it("only completes the first token", () => {
		const mode = new McpMode(null);

		expect(mode.complete("expl", 4).items.some((item) => item.label === "explore_hise")).toBe(true);
		expect(mode.complete("explore_hise sam", 16).items).toEqual([]);
	});

	it("only highlights the first token", () => {
		const mode = new McpMode(null);

		expect(mode.tokenizeInput("explore_hise sampler")).toEqual([
			{ text: "explore_hise", token: "mcp", bold: true },
			{ text: " sampler", token: "plain" },
		]);
	});

	it("renders text content as markdown", async () => {
		const client: McpClient = {
			async call() { return {}; },
			async callTool() { return { content: [{ type: "text", text: "# Result" }] }; },
		};
		const mode = new McpMode(client);

		const result = await mode.parse("explore_hise sampler", {} as any);

		expect(result).toEqual({ type: "markdown", content: "# Result" });
	});

	it("does not call MCP while entering the mode", async () => {
		let calls = 0;
		const client: McpClient = {
			async call() { calls++; return {}; },
			async callTool() { return {}; },
		};
		const mode = new McpMode(client);

		await mode.onEnter?.({} as any);

		expect(calls).toBe(0);
	});
});

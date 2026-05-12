import { describe, expect, it, vi } from "vitest";
import { HiseMode, type HiseLauncher } from "./hise.js";
import { MockHiseConnection } from "../hise.js";
import type { SessionContext } from "./mode.js";

// ── Helpers ────────────────────────────────────────────────────────

function mockLauncher(behavior: "ok" | "enoent" = "ok"): HiseLauncher {
	return {
		spawnDetached: behavior === "ok"
			? vi.fn(async () => {})
			: vi.fn(async () => { throw new Error("ENOENT"); }),
	};
}

function mockSession(mock: MockHiseConnection, opts?: { projectFolder?: string | null }): SessionContext {
	return {
		connection: mock,
		projectName: null,
		projectFolder: opts?.projectFolder ?? null,
		popMode: () => ({ type: "text", content: "Exited HISE mode." }),
	};
}

const STATUS_RESPONSE = {
	success: true as const,
	project: { name: "TestProject", projectFolder: "D:/Projects/Test", scriptsFolder: "D:/Projects/Test/Scripts" },
	server: { version: "1.0.0", compileTimeout: 10 },
	scriptProcessors: [],
	logs: [] as string[],
	errors: [] as Array<{ errorMessage: string; callstack: string[] }>,
};

// ── Identity ───────────────────────────────────────────────────────

describe("HiseMode identity", () => {
	it("has correct id, name, accent, prompt", () => {
		const mode = new HiseMode(null);
		expect(mode.id).toBe("hise");
		expect(mode.name).toBe("HISE");
		expect(mode.accent).toBe("#90FFB1");
		expect(mode.prompt).toBe("hise");
	});
});

// ── Help ───────────────────────────────────────────────────────────

describe("HiseMode help", () => {
	it("shows help for empty input", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		const result = await mode.parse("", mockSession(mock));
		expect(result.type).toBe("markdown");
		if (result.type === "markdown") {
			expect(result.content).toContain("launch");
			expect(result.content).toContain("shutdown");
			expect(result.content).toContain("screenshot");
			expect(result.content).toContain("profile");
		}
	});

	it("returns error for unknown command", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		const result = await mode.parse("frobnicate", mockSession(mock));
		expect(result.type).toBe("error");
	});
});

// ── Launch ─────────────────────────────────────────────────────────

describe("HiseMode launch", () => {
	it("is a noop when HISE is already running", async () => {
		const launcher = mockLauncher("ok");
		const mode = new HiseMode(launcher);
		const mock = new MockHiseConnection();
		mock.setProbeResult(true); // already connected

		const result = await mode.parse("launch", mockSession(mock));
		expect(result.type).toBe("text");
		if (result.type === "text") {
			expect(result.content).toContain("already running");
		}
		expect(launcher.spawnDetached).not.toHaveBeenCalled();
	});

	it("succeeds when probe returns true after spawn", async () => {
		vi.useFakeTimers();
		const launcher = mockLauncher("ok");
		const mode = new HiseMode(launcher);
		const mock = new MockHiseConnection();
		let probeCount = 0;
		mock.setProbeResult(false);
		// Simulate HISE coming online after 2 probes
		const origProbe = mock.probe.bind(mock);
		mock.probe = async () => {
			probeCount++;
			if (probeCount >= 2) mock.setProbeResult(true);
			return origProbe();
		};
		mock.onGet("/api/status", () => STATUS_RESPONSE);

		const session = mockSession(mock);
		const promise = mode.parse("launch", session);
		for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(500);
		const result = await promise;
		vi.useRealTimers();

		expect(result.type).toBe("text");
		if (result.type === "text") {
			expect(result.content).toContain("TestProject");
		}
		expect(session.projectName).toBe("TestProject");
		expect(session.projectFolder).toBe("D:/Projects/Test");
		expect(launcher.spawnDetached).toHaveBeenCalledWith("HISE", ["start_server"]);
	});

	it("accepts case-insensitive debug flag", async () => {
		vi.useFakeTimers();
		const launcher = mockLauncher("ok");
		const mode = new HiseMode(launcher);
		const mock = new MockHiseConnection();
		let calls = 0;
		mock.setProbeResult(false);
		const origProbe = mock.probe.bind(mock);
		mock.probe = async () => { calls++; if (calls > 1) mock.setProbeResult(true); return origProbe(); };
		mock.onGet("/api/status", () => STATUS_RESPONSE);

		const promise = mode.parse("launch Debug", mockSession(mock));
		for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(500);
		await promise;
		vi.useRealTimers();

		expect(launcher.spawnDetached).toHaveBeenCalledWith("HISE Debug", ["start_server"]);
	});

	it("accepts lowercase debug", async () => {
		vi.useFakeTimers();
		const launcher = mockLauncher("ok");
		const mode = new HiseMode(launcher);
		const mock = new MockHiseConnection();
		let calls = 0;
		mock.setProbeResult(false);
		const origProbe = mock.probe.bind(mock);
		mock.probe = async () => { calls++; if (calls > 1) mock.setProbeResult(true); return origProbe(); };
		mock.onGet("/api/status", () => STATUS_RESPONSE);

		const promise = mode.parse("launch debug", mockSession(mock));
		for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(500);
		await promise;
		vi.useRealTimers();

		expect(launcher.spawnDetached).toHaveBeenCalledWith("HISE Debug", ["start_server"]);
	});

	it("returns error when binary not found", async () => {
		const launcher = mockLauncher("enoent");
		const mode = new HiseMode(launcher);
		const mock = new MockHiseConnection();
		mock.setProbeResult(false);
		const result = await mode.parse("launch", mockSession(mock));

		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.message).toContain("not found on PATH");
		}
	});

	it("returns error when launcher is null", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		const result = await mode.parse("launch", mockSession(mock));

		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.message).toContain("not available");
		}
	});

	it("returns timeout error when probe never succeeds", async () => {
		const launcher = mockLauncher("ok");
		const mode = new HiseMode(launcher);
		const mock = new MockHiseConnection();
		mock.setProbeResult(false);

		// Speed up the test by mocking setTimeout
		vi.useFakeTimers();
		const promise = mode.parse("launch", mockSession(mock));
		// Advance past all 20 polling intervals (500ms each)
		for (let i = 0; i < 20; i++) {
			await vi.advanceTimersByTimeAsync(500);
		}
		const result = await promise;
		vi.useRealTimers();

		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.message).toContain("did not respond within 10 seconds");
		}
	});
});

// ── Shutdown ───────────────────────────────────────────────────────

describe("HiseMode shutdown", () => {
	it("sends POST to /api/shutdown", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onPost("/api/shutdown", () => ({
			success: true as const,
			result: "Shutdown initiated",
			logs: [],
			errors: [],
		}));

		const result = await mode.parse("shutdown", mockSession(mock));
		expect(result.type).toBe("text");
		if (result.type === "text") {
			expect(result.content).toContain("shut down");
		}
		expect(mock.calls.some((c) => c.method === "POST" && c.endpoint === "/api/shutdown")).toBe(true);
	});

	it("treats connection drop as success", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onPost("/api/shutdown", () => ({
			error: true as const,
			message: "POST /api/shutdown: fetch failed",
		}));

		const result = await mode.parse("shutdown", mockSession(mock));
		expect(result.type).toBe("text");
		if (result.type === "text") {
			expect(result.content).toContain("shut down");
		}
	});

	it("returns error without connection", async () => {
		const mode = new HiseMode(null);
		const session: SessionContext = {
			connection: null,
			projectName: null,
			projectFolder: null,
			popMode: () => ({ type: "text", content: "" }),
		};
		const result = await mode.parse("shutdown", session);
		expect(result.type).toBe("error");
	});
});

// ── Screenshot ─────────────────────────────────────────────────────

describe("HiseMode screenshot", () => {
	function screenshotSession(mock: MockHiseConnection): SessionContext {
		return mockSession(mock, { projectFolder: "D:/Projects/Test" });
	}

	it("defaults to screenshot.png in project root", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onGet("/api/testing/screenshot", () => ({
			success: true as const,
			width: 600, height: 400, scale: 1.0, filePath: "D:/Projects/Test/screenshot.png",
			logs: [],
			errors: [],
		}));

		const result = await mode.parse("screenshot", screenshotSession(mock));
		expect(result.type).toBe("text");
		if (result.type === "text") {
			expect(result.content).toContain("screenshot.png");
			expect(result.content).toContain("600x400");
		}
		// Check query params include outputPath
		const call = mock.calls.find((c) => c.endpoint.includes("/api/testing/screenshot"));
		expect(call?.endpoint).toContain("outputPath=");
		expect(call?.endpoint).toContain("moduleId=Interface");
		expect(call?.endpoint).toContain("screenshot.png");
	});

	it("parses 'of' clause", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onGet("/api/testing/screenshot", () => ({
			success: true as const,
			width: 128, height: 48,
			logs: [],
			errors: [],
		}));

		const result = await mode.parse("screenshot of Knob1", screenshotSession(mock));
		expect(result.type).toBe("text");
		if (result.type === "text") {
			expect(result.content).toContain("of Knob1");
		}
		const call = mock.calls.find((c) => c.endpoint.includes("/api/testing/screenshot"));
		expect(call?.endpoint).toContain("id=Knob1");
	});

	it("parses 'at 50%' as scale 0.5", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onGet("/api/testing/screenshot", () => ({
			success: true as const,
			width: 300, height: 200, scale: 0.5,
			logs: [],
			errors: [],
		}));

		await mode.parse("screenshot at 50%", screenshotSession(mock));
		const call = mock.calls.find((c) => c.endpoint.includes("/api/testing/screenshot"));
		expect(call?.endpoint).toContain("scale=0.5");
	});

	it("parses 'at 0.5' as scale 0.5", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onGet("/api/testing/screenshot", () => ({
			success: true as const,
			width: 300, height: 200,
			logs: [],
			errors: [],
		}));

		await mode.parse("screenshot at 0.5", screenshotSession(mock));
		const call = mock.calls.find((c) => c.endpoint.includes("/api/testing/screenshot"));
		expect(call?.endpoint).toContain("scale=0.5");
	});

	it("parses 'to' clause with relative path", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onGet("/api/testing/screenshot", () => ({
			success: true as const,
			width: 600, height: 400,
			logs: [],
			errors: [],
		}));

		await mode.parse("screenshot to images/test.png", screenshotSession(mock));
		const call = mock.calls.find((c) => c.endpoint.includes("/api/testing/screenshot"));
		expect(call?.endpoint).toContain("D%3A%2FProjects%2FTest%2Fimages%2Ftest.png");
	});

	it("parses all clauses in any order", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onGet("/api/testing/screenshot", () => ({
			success: true as const,
			width: 128, height: 48,
			logs: [],
			errors: [],
		}));

		await mode.parse("screenshot to output.png of Panel at 50%", screenshotSession(mock));
		const call = mock.calls.find((c) => c.endpoint.includes("/api/testing/screenshot"));
		expect(call?.endpoint).toContain("id=Panel");
		expect(call?.endpoint).toContain("scale=0.5");
		expect(call?.endpoint).toContain("output.png");
	});

	it("returns error without project folder", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		const result = await mode.parse("screenshot", mockSession(mock));
		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.message).toContain("project folder");
		}
	});
});

// ── Profile ────────────────────────────────────────────────────────

describe("HiseMode profile", () => {
	it("records and fetches with defaults", async () => {
		vi.useFakeTimers();
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onPost("/api/testing/profile", () => ({
			success: true as const,
			result: {
				results: [
					{ name: "processBlock", count: 50, median: 0.12, peak: 0.45, min: 0.08, total: 6.0 },
				],
			},
			logs: [],
			errors: [],
		}));

		const promise = mode.parse("profile", mockSession(mock, { projectFolder: "D:/Test" }));
		await vi.advanceTimersByTimeAsync(1200); // durationMs + 200
		const result = await promise;
		vi.useRealTimers();

		expect(result.type).toBe("markdown");
		if (result.type === "markdown") {
			expect(result.content).toContain("processBlock");
			expect(result.content).toContain("1000ms");
		}
		// Should have made 2 POST calls
		const profileCalls = mock.calls.filter((c) => c.endpoint === "/api/testing/profile");
		expect(profileCalls.length).toBe(2);
		expect((profileCalls[0].body as Record<string, unknown>).mode).toBe("record");
		expect((profileCalls[1].body as Record<string, unknown>).mode).toBe("get");
	});

	it("normalizes thread name 'audio' to 'Audio Thread'", async () => {
		vi.useFakeTimers();
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onPost("/api/testing/profile", () => ({
			success: true as const,
			result: { results: [] },
			logs: [],
			errors: [],
		}));

		const promise = mode.parse("profile thread audio", mockSession(mock, { projectFolder: "D:/Test" }));
		await vi.advanceTimersByTimeAsync(1200);
		await promise;
		vi.useRealTimers();

		const recordCall = mock.calls.find(
			(c) => c.endpoint === "/api/testing/profile" && (c.body as Record<string, unknown>).mode === "record",
		);
		expect((recordCall?.body as Record<string, unknown>).threadFilter).toEqual(["Audio Thread"]);
	});

	it("normalizes 'script' to 'Scripting Thread'", async () => {
		vi.useFakeTimers();
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onPost("/api/testing/profile", () => ({
			success: true as const,
			result: { results: [] },
			logs: [],
			errors: [],
		}));

		const promise = mode.parse("profile thread script", mockSession(mock, { projectFolder: "D:/Test" }));
		await vi.advanceTimersByTimeAsync(1200);
		await promise;
		vi.useRealTimers();

		const recordCall = mock.calls.find(
			(c) => c.endpoint === "/api/testing/profile" && (c.body as Record<string, unknown>).mode === "record",
		);
		expect((recordCall?.body as Record<string, unknown>).threadFilter).toEqual(["Scripting Thread"]);
	});

	it("parses 'for <N>ms'", async () => {
		vi.useFakeTimers();
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onPost("/api/testing/profile", () => ({
			success: true as const,
			result: { results: [] },
			logs: [],
			errors: [],
		}));

		const promise = mode.parse("profile for 2000ms", mockSession(mock, { projectFolder: "D:/Test" }));
		await vi.advanceTimersByTimeAsync(2200);
		await promise;
		vi.useRealTimers();

		const recordCall = mock.calls.find(
			(c) => c.endpoint === "/api/testing/profile" && (c.body as Record<string, unknown>).mode === "record",
		);
		expect((recordCall?.body as Record<string, unknown>).durationMs).toBe(2000);
	});

	it("rejects invalid thread name", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		const result = await mode.parse("profile thread banana", mockSession(mock, { projectFolder: "D:/Test" }));
		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.message).toContain("Unknown thread");
		}
	});

	it("rejects out-of-range duration", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		const result = await mode.parse("profile for 50ms", mockSession(mock, { projectFolder: "D:/Test" }));
		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.message).toContain("between 100ms and 5000ms");
		}
	});
});

// ── Status (snippet browser cache) ─────────────────────────────────

describe("HiseMode status", () => {
	it("caches activeIsSnippetBrowser on session and annotates status text", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onGet("/api/status", () => ({
			...STATUS_RESPONSE,
			activeIsSnippetBrowser: true,
		}));

		const session = mockSession(mock);
		const result = await mode.parse("status", session);

		expect(session.playgroundActive).toBe(true);
		expect(result.type).toBe("text");
		if (result.type === "text") {
			expect(result.content).toContain("snippet browser active");
		}
	});

	it("clears playgroundActive when activeIsSnippetBrowser is false", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onGet("/api/status", () => ({
			...STATUS_RESPONSE,
			activeIsSnippetBrowser: false,
		}));

		const session = mockSession(mock);
		session.playgroundActive = true;
		const result = await mode.parse("status", session);

		expect(session.playgroundActive).toBe(false);
		if (result.type === "text") {
			expect(result.content).not.toContain("snippet browser active");
		}
	});
});

// ── Playground ─────────────────────────────────────────────────────

describe("HiseMode playground", () => {
	function playgroundResponse(active: "main" | "snippet", exists = true) {
		return {
			success: true as const,
			exists,
			active,
			logs: [] as string[],
			errors: [] as Array<{ errorMessage: string; callstack: string[] }>,
		};
	}

	it("open POSTs action 'launch' and sets playgroundActive=true", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onPost("/api/snippet_browser", () => playgroundResponse("snippet"));

		const session = mockSession(mock);
		const result = await mode.parse("playground open", session);

		const call = mock.calls.find((c) => c.endpoint === "/api/snippet_browser");
		expect(call).toBeDefined();
		expect(call?.body).toEqual({ action: "launch" });
		expect(session.playgroundActive).toBe(true);
		expect(result.type).toBe("text");
		if (result.type === "text") {
			expect(result.content).toContain("Snippet browser opened");
		}
	});

	it("close POSTs action 'shutdown' and sets playgroundActive=false", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onPost("/api/snippet_browser", () => playgroundResponse("main", false));

		const session = mockSession(mock);
		session.playgroundActive = true;
		const result = await mode.parse("playground close", session);

		const call = mock.calls.find((c) => c.endpoint === "/api/snippet_browser");
		expect(call?.body).toEqual({ action: "shutdown" });
		expect(session.playgroundActive).toBe(false);
		if (result.type === "text") {
			expect(result.content).toContain("Snippet browser closed");
		}
	});

	it("enable POSTs action 'enable'", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onPost("/api/snippet_browser", () => playgroundResponse("snippet"));

		const result = await mode.parse("playground enable", mockSession(mock));
		const call = mock.calls.find((c) => c.endpoint === "/api/snippet_browser");
		expect(call?.body).toEqual({ action: "enable" });
		if (result.type === "text") {
			expect(result.content).toContain("Snippet browser active");
		}
	});

	it("disable POSTs action 'disable'", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onPost("/api/snippet_browser", () => playgroundResponse("main"));

		const result = await mode.parse("playground disable", mockSession(mock));
		const call = mock.calls.find((c) => c.endpoint === "/api/snippet_browser");
		expect(call?.body).toEqual({ action: "disable" });
		if (result.type === "text") {
			expect(result.content).toContain("Main project active");
		}
	});

	it("surfaces error envelope (e.g. 409 no snippet exists)", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();
		mock.onPost("/api/snippet_browser", () => ({
			success: false as const,
			logs: [],
			errors: [{ errorMessage: "No snippet browser instance.", callstack: [] }],
		}));

		const result = await mode.parse("playground enable", mockSession(mock));
		expect(result.type).toBe("error");
		if (result.type === "error") {
			expect(result.message).toContain("No snippet browser instance.");
		}
	});

	it("returns error without connection", async () => {
		const mode = new HiseMode(null);
		const session: SessionContext = {
			connection: null,
			projectName: null,
			projectFolder: null,
			popMode: () => ({ type: "text", content: "" }),
		};
		const result = await mode.parse("playground open", session);
		expect(result.type).toBe("error");
	});

	it("returns usage error for missing or unknown subcommand", async () => {
		const mode = new HiseMode(null);
		const mock = new MockHiseConnection();

		const empty = await mode.parse("playground", mockSession(mock));
		expect(empty.type).toBe("error");
		if (empty.type === "error") {
			expect(empty.message).toContain("Usage:");
		}

		const bad = await mode.parse("playground foo", mockSession(mock));
		expect(bad.type).toBe("error");
		if (bad.type === "error") {
			expect(bad.message).toContain("Usage:");
		}
	});
});

// ── Completion ─────────────────────────────────────────────────────

describe("HiseMode completion", () => {
	it("completes subcommand names", () => {
		const mode = new HiseMode(null);
		const result = mode.complete!("la", 2);
		expect(result.items.some((i) => i.label === "launch")).toBe(true);
	});

	it("completes all commands for empty input", () => {
		const mode = new HiseMode(null);
		const result = mode.complete!("", 0);
		const labels = result.items.map((i) => i.label);
		expect(labels).toContain("launch");
		expect(labels).toContain("shutdown");
		expect(labels).toContain("screenshot");
		expect(labels).toContain("profile");
	});

	it("completes debug for launch", () => {
		const mode = new HiseMode(null);
		const result = mode.complete!("launch d", 8);
		expect(result.items.some((i) => i.label === "debug")).toBe(true);
	});

	it("completes thread names for profile", () => {
		const mode = new HiseMode(null);
		const result = mode.complete!("profile thread a", 16);
		expect(result.items.some((i) => i.label === "audio")).toBe(true);
	});

	it("completes keywords for screenshot", () => {
		const mode = new HiseMode(null);
		const result = mode.complete!("screenshot o", 12);
		expect(result.items.some((i) => i.label === "of")).toBe(true);
	});

	it("completes playground actions", () => {
		const mode = new HiseMode(null);
		const result = mode.complete!("playground ", 11);
		const labels = result.items.map((i) => i.label);
		expect(labels).toEqual(["open", "close", "enable", "disable"]);
	});

	it("filters playground actions by prefix", () => {
		const mode = new HiseMode(null);
		const result = mode.complete!("playground e", 12);
		const labels = result.items.map((i) => i.label);
		expect(labels).toEqual(["enable"]);
	});
});

import { describe, expect, it } from "vitest";
import { MockPhaseExecutor } from "../../engine/wizard/mock-phase-executor.js";
import { MockHiseConnection } from "../../engine/hise.js";
import type { HiseLauncher } from "../../engine/modes/hise.js";
import type { WizardProgress } from "../../engine/wizard/types.js";
import {
	createUpdateCheckoutHandler,
	createUpdateCleanBuildsHandler,
	createUpdateCompileHandler,
	createUpdateLaunchHandler,
	createUpdateShutdownHandler,
	createUpdateVerifyHandler,
} from "./update-tasks.js";

function noopProgress(_p: WizardProgress): void {}

function stubLauncher(spy?: (cmd: string, args: string[]) => void): HiseLauncher {
	return {
		async spawnDetached(cmd: string, args: string[]): Promise<void> {
			spy?.(cmd, args);
		},
	};
}

describe("updateShutdown", () => {
	it("skips when shutdownHise is off", async () => {
		const executor = new MockPhaseExecutor();
		const connection = new MockHiseConnection();
		const handler = createUpdateShutdownHandler({ executor, connection, launcher: stubLauncher() });
		const result = await handler({ shutdownHise: "0" }, noopProgress);
		expect(result.success).toBe(true);
		expect(connection.calls.length).toBe(0);
	});

	it("posts /api/shutdown and returns success once probe reports offline", async () => {
		const executor = new MockPhaseExecutor();
		const connection = new MockHiseConnection();
		connection.onPost("/api/shutdown", () => ({
			success: true, result: "bye", logs: [], errors: [],
		}));
		connection.setProbeResult(false);
		const handler = createUpdateShutdownHandler({ executor, connection, launcher: stubLauncher() });
		const result = await handler({ shutdownHise: "1" }, noopProgress);
		expect(result.success).toBe(true);
		expect(connection.calls.some((c) => c.method === "POST" && c.endpoint === "/api/shutdown")).toBe(true);
	});
});

describe("updateCheckout", () => {
	it("fails when installPath is empty", async () => {
		const executor = new MockPhaseExecutor();
		const connection = new MockHiseConnection();
		const handler = createUpdateCheckoutHandler({ executor, connection, launcher: stubLauncher() });
		const result = await handler({ installPath: "", targetCommit: "abc" }, noopProgress);
		expect(result.success).toBe(false);
		expect(result.message).toContain("Install path");
	});

	it("fails when no target commit is available", async () => {
		const executor = new MockPhaseExecutor();
		const connection = new MockHiseConnection();
		const handler = createUpdateCheckoutHandler({ executor, connection, launcher: stubLauncher() });
		const result = await handler({ installPath: "/HISE" }, noopProgress);
		expect(result.success).toBe(false);
		expect(result.message).toContain("target commit");
	});

	it("discards local mods, fetches, checks out, and updates submodules in order (cleanBuilds=1)", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("git", { exitCode: 0, stdout: "", stderr: "" });
		const connection = new MockHiseConnection();
		const handler = createUpdateCheckoutHandler({ executor, connection, launcher: stubLauncher() });
		const result = await handler(
			{ installPath: "/HISE", targetCommit: "98a75d8", cleanBuilds: "1" },
			noopProgress,
		);
		expect(result.success).toBe(true);
		const gitCalls = executor.calls.filter((c) => c.command === "git");
		// Sequence: reset working tree, fetch, checkout <sha>, submodule update, JUCE checkout juce6.
		expect(gitCalls[0]?.args).toEqual(
			expect.arrayContaining(["-c", "color.ui=never", "-C", "/HISE", "checkout", "--", "."]),
		);
		expect(gitCalls[1]?.args).toContain("fetch");
		expect(gitCalls[2]?.args).toContain("checkout");
		expect(gitCalls[2]?.args).toContain("98a75d8");
		expect(gitCalls[3]?.args).toContain("submodule");
		// Every git call should carry the no-color flags.
		for (const call of gitCalls) {
			expect(call.args.slice(0, 2)).toEqual(["-c", "color.ui=never"]);
			expect(call.env?.NO_COLOR).toBe("1");
		}
	});

	it("skips the `git checkout -- .` step when cleanBuilds is off", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("git", { exitCode: 0, stdout: "", stderr: "" });
		const connection = new MockHiseConnection();
		const handler = createUpdateCheckoutHandler({ executor, connection, launcher: stubLauncher() });
		const result = await handler(
			{ installPath: "/HISE", targetCommit: "98a75d8", cleanBuilds: "0" },
			noopProgress,
		);
		expect(result.success).toBe(true);
		const gitCalls = executor.calls.filter((c) => c.command === "git");
		// First call must be `fetch` (no prior `checkout -- .`).
		expect(gitCalls[0]?.args).toContain("fetch");
		const hadReset = gitCalls.some((c) => c.args.includes("--") && c.args.includes("."));
		expect(hadReset).toBe(false);
	});

	it("falls back to latestSha when targetCommit is empty", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("git", { exitCode: 0, stdout: "", stderr: "" });
		const connection = new MockHiseConnection();
		const handler = createUpdateCheckoutHandler({ executor, connection, launcher: stubLauncher() });
		const result = await handler(
			{ installPath: "/HISE", targetCommit: "", latestSha: "bbbbbbb", cleanBuilds: "1" },
			noopProgress,
		);
		expect(result.success).toBe(true);
		const checkoutCall = executor.calls.find(
			(c) => c.command === "git" && c.args.includes("checkout") && c.args.includes("bbbbbbb"),
		);
		expect(checkoutCall).toBeDefined();
	});

	it("strips ANSI escape sequences from streamed git output", async () => {
		const executor = new MockPhaseExecutor();
		// Simulate git emitting a color-coded status line — the progress
		// callback should see the plain text only.
		executor.onSpawn("git", { exitCode: 0, stdout: "", stderr: "" });
		// eslint-disable-next-line no-control-regex
		const noisy = "\x1b[31mM\x1b[0m\t\x1b[44mAppConfig.h\x1b[0m";
		const received: string[] = [];
		// Inject the noisy line through the MockPhaseExecutor's onLog hook by
		// overriding spawn once. MockPhaseExecutor doesn't invoke onLog by
		// default, so we patch its spawn to do so before delegating.
		const originalSpawn = executor.spawn.bind(executor);
		executor.spawn = async (cmd, args, opts) => {
			opts.onLog?.(noisy, false);
			return originalSpawn(cmd, args, opts);
		};
		const connection = new MockHiseConnection();
		const handler = createUpdateCheckoutHandler({ executor, connection, launcher: stubLauncher() });
		await handler(
			{ installPath: "/HISE", targetCommit: "98a75d8", cleanBuilds: "1" },
			(p) => { if (p.message) received.push(p.message); },
		);
		const leaked = received.filter((m) => /\x1b\[/.test(m));
		expect(leaked).toEqual([]);
		expect(received.some((m) => m.includes("M\tAppConfig.h"))).toBe(true);
	});
});

describe("updateCleanBuilds", () => {
	it("skips when cleanBuilds is off", async () => {
		const executor = new MockPhaseExecutor();
		const connection = new MockHiseConnection();
		const handler = createUpdateCleanBuildsHandler({ executor, connection, launcher: stubLauncher() });
		const result = await handler(
			{ cleanBuilds: "0", installPath: "/HISE", platform: "macOS" },
			noopProgress,
		);
		expect(result.success).toBe(true);
		expect(executor.calls.length).toBe(0);
	});

	it("wipes projects/standalone/Builds on POSIX", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("rm", { exitCode: 0, stdout: "", stderr: "" });
		const connection = new MockHiseConnection();
		const handler = createUpdateCleanBuildsHandler({ executor, connection, launcher: stubLauncher() });
		const result = await handler(
			{ cleanBuilds: "1", installPath: "/HISE", platform: "macOS" },
			noopProgress,
		);
		expect(result.success).toBe(true);
		const rmCall = executor.calls.find((c) => c.command === "rm");
		expect(rmCall?.args).toEqual(["-rf", "/HISE/projects/standalone/Builds"]);
	});

	it("uses PowerShell Remove-Item on Windows", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("powershell", { exitCode: 0, stdout: "", stderr: "" });
		const connection = new MockHiseConnection();
		const handler = createUpdateCleanBuildsHandler({ executor, connection, launcher: stubLauncher() });
		const result = await handler(
			{ cleanBuilds: "1", installPath: "C:\\HISE", platform: "Windows" },
			noopProgress,
		);
		expect(result.success).toBe(true);
		const psCall = executor.calls.find((c) => c.command === "powershell");
		const script = psCall?.args[psCall.args.length - 1] ?? "";
		expect(script).toContain("Remove-Item");
		expect(script).toContain("C:\\HISE\\projects\\standalone\\Builds");
	});

	it("fails when installPath is empty", async () => {
		const executor = new MockPhaseExecutor();
		const connection = new MockHiseConnection();
		const handler = createUpdateCleanBuildsHandler({ executor, connection, launcher: stubLauncher() });
		const result = await handler({ cleanBuilds: "1", installPath: "" }, noopProgress);
		expect(result.success).toBe(false);
	});
});

describe("updateCompile", () => {
	it("skips when compileHise is off", async () => {
		const executor = new MockPhaseExecutor();
		const connection = new MockHiseConnection();
		const handler = createUpdateCompileHandler({ executor, connection, launcher: stubLauncher() });
		const result = await handler({ compileHise: "0", installPath: "/HISE" }, noopProgress);
		expect(result.success).toBe(true);
		expect(executor.calls.length).toBe(0);
	});
});

describe("updateLaunch", () => {
	it("skips when launchHise is off", async () => {
		const executor = new MockPhaseExecutor();
		const connection = new MockHiseConnection();
		const launcher = stubLauncher();
		const handler = createUpdateLaunchHandler({ executor, connection, launcher });
		const result = await handler({ launchHise: "0" }, noopProgress);
		expect(result.success).toBe(true);
	});

	it("spawns HISE and polls until probe succeeds", async () => {
		const executor = new MockPhaseExecutor();
		const connection = new MockHiseConnection();
		connection.setProbeResult(true);
		const spawned: string[] = [];
		const launcher = stubLauncher((cmd) => spawned.push(cmd));
		const handler = createUpdateLaunchHandler({ executor, connection, launcher });
		const result = await handler({ launchHise: "1" }, noopProgress);
		expect(result.success).toBe(true);
		expect(spawned).toContain("HISE");
	});
});

describe("updateVerify", () => {
	it("skips when launch was off", async () => {
		const executor = new MockPhaseExecutor();
		const connection = new MockHiseConnection();
		const handler = createUpdateVerifyHandler({ executor, connection, launcher: stubLauncher() });
		const result = await handler({ launchHise: "0" }, noopProgress);
		expect(result.success).toBe(true);
	});

	it("succeeds when buildCommit starts with the expected SHA prefix", async () => {
		const executor = new MockPhaseExecutor();
		const connection = new MockHiseConnection();
		connection.onGet("/api/status", () => ({
			success: true,
			server: {
				version: "4.1.0",
				compileTimeout: "20.0",
				buildCommit: "98a75d8ee4ff0db43e3de4b3aca3f4e53d16785c",
			},
			project: { name: "P", projectFolder: "/p", scriptsFolder: "/p/Scripts" },
			scriptProcessors: [],
			logs: [],
			errors: [],
		}));
		const handler = createUpdateVerifyHandler({ executor, connection, launcher: stubLauncher() });
		const result = await handler(
			{ launchHise: "1", targetCommit: "98a75d8" },
			noopProgress,
		);
		expect(result.success).toBe(true);
	});

	it("fails on SHA mismatch", async () => {
		const executor = new MockPhaseExecutor();
		const connection = new MockHiseConnection();
		connection.onGet("/api/status", () => ({
			success: true,
			server: { version: "4.1.0", buildCommit: "ffffffffffffffffffffffffffffffffffffffff" },
			project: { name: "P", projectFolder: "/p", scriptsFolder: "/p/Scripts" },
			scriptProcessors: [],
			logs: [],
			errors: [],
		}));
		const handler = createUpdateVerifyHandler({ executor, connection, launcher: stubLauncher() });
		const result = await handler(
			{ launchHise: "1", targetCommit: "aaaaaaa" },
			noopProgress,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("mismatch");
	});

	it("fails when status response lacks buildCommit", async () => {
		const executor = new MockPhaseExecutor();
		const connection = new MockHiseConnection();
		connection.onGet("/api/status", () => ({
			success: true,
			server: { version: "4.1.0" },
			project: { name: "P", projectFolder: "/p", scriptsFolder: "/p/Scripts" },
			scriptProcessors: [],
			logs: [],
			errors: [],
		}));
		const handler = createUpdateVerifyHandler({ executor, connection, launcher: stubLauncher() });
		const result = await handler(
			{ launchHise: "1", targetCommit: "abc" },
			noopProgress,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("buildCommit");
	});
});

import { describe, expect, it, vi } from "vitest";
import { MockPhaseExecutor } from "../../engine/wizard/mock-phase-executor.js";
import { MockHiseConnection } from "../../engine/hise.js";
import { WizardInitAbortError } from "../../engine/wizard/executor.js";
import {
	createUpdateDetectHandler,
	fetchDevelopHead,
	fetchLatestCiSha,
	parseHisePath,
	parseVsVersion,
} from "./update-detect.js";

/** Build a fetch mock that dispatches on URL — GitHub Actions runs vs commits.
 *  `ciResponse` seeds /actions/workflows/... /runs; `headResponse` seeds
 *  /commits/develop. `null` for either means "pretend offline (throws)". */
function mockGithubFetch(ciResponse: unknown, headResponse: unknown | null): typeof globalThis.fetch {
	const impl = vi.fn(async (url: string | URL) => {
		const s = typeof url === "string" ? url : url.toString();
		if (s.includes("/actions/workflows/")) {
			if (ciResponse === null) throw new Error("offline");
			return { ok: true, json: async () => ciResponse } as Response;
		}
		if (s.includes("/commits/")) {
			if (headResponse === null) throw new Error("offline");
			return { ok: true, json: async () => headResponse } as Response;
		}
		throw new Error(`unexpected url: ${s}`);
	});
	return impl as unknown as typeof globalThis.fetch;
}

describe("parseVsVersion", () => {
	it("extracts 2022 / 2026 from a real compilerSettings.xml", () => {
		expect(parseVsVersion('<VisualStudioVersion value="Visual Studio 2022"/>')).toBe("2022");
		expect(parseVsVersion('<VisualStudioVersion value="Visual Studio 2026"/>')).toBe("2026");
	});
	it("returns null when the element is missing or unrecognised", () => {
		expect(parseVsVersion("<CompilerSettings></CompilerSettings>")).toBeNull();
		expect(parseVsVersion('<VisualStudioVersion value="Visual Studio 2017"/>')).toBeNull();
	});
});

describe("parseHisePath", () => {
	it("extracts HisePath from a real compilerSettings.xml", () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CompilerSettings>
  <HisePath value="/Users/me/HISE"/>
  <UseIPP value="0"/>
</CompilerSettings>`;
		expect(parseHisePath(xml)).toBe("/Users/me/HISE");
	});

	it("returns null when the element is missing", () => {
		expect(parseHisePath("<CompilerSettings></CompilerSettings>")).toBeNull();
	});

	it("returns null when the value is empty", () => {
		expect(parseHisePath('<HisePath value=""/>')).toBeNull();
	});
});

describe("fetchLatestCiSha", () => {
	it("returns head_sha from the first workflow run", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				workflow_runs: [
					{
						head_sha: "98a75d8ee4ff0db43e3de4b3aca3f4e53d16785c",
						display_title: "commit title",
						created_at: "2026-04-23T11:35:06Z",
						html_url: "https://github.com/x/y/actions/runs/1",
					},
				],
			}),
		});
		const result = await fetchLatestCiSha(fetchImpl as unknown as typeof globalThis.fetch);
		expect(result?.sha).toBe("98a75d8ee4ff0db43e3de4b3aca3f4e53d16785c");
		expect(result?.title).toBe("commit title");
		expect(result?.runUrl).toContain("actions/runs/1");
	});

	it("returns null on HTTP error", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
		const result = await fetchLatestCiSha(fetchImpl as unknown as typeof globalThis.fetch);
		expect(result).toBeNull();
	});

	it("returns null when fetch throws (rate-limited / offline)", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("network"));
		const result = await fetchLatestCiSha(fetchImpl as unknown as typeof globalThis.fetch);
		expect(result).toBeNull();
	});

	it("returns null when workflow_runs is empty", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ workflow_runs: [] }),
		});
		const result = await fetchLatestCiSha(fetchImpl as unknown as typeof globalThis.fetch);
		expect(result).toBeNull();
	});
});

describe("fetchDevelopHead", () => {
	it("returns sha from commits/develop", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ sha: "b4d1eec61bdbf23250e3f44e3db5f3198ae6b032" }),
		});
		const result = await fetchDevelopHead(fetchImpl as unknown as typeof globalThis.fetch);
		expect(result).toBe("b4d1eec61bdbf23250e3f44e3db5f3198ae6b032");
	});

	it("returns null on HTTP error", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
		const result = await fetchDevelopHead(fetchImpl as unknown as typeof globalThis.fetch);
		expect(result).toBeNull();
	});

	it("returns null when fetch throws", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
		const result = await fetchDevelopHead(fetchImpl as unknown as typeof globalThis.fetch);
		expect(result).toBeNull();
	});
});

describe("createUpdateDetectHandler", () => {
	// Shared stubs for the environment probes. `readTextFile` is dispatched
	// by suffix because the handler reads two different files
	// (compilerSettings.xml + currentGitHash.txt).
	function stubEnvironment(
		executor: MockPhaseExecutor,
		hisePath = "/Users/test/HISE",
		gitHash: string | null = "abcdef1234567890",
	): (path: string) => Promise<string | null> {
		executor.onSpawn("sysctl", { exitCode: 0, stdout: "8\n", stderr: "" });
		executor.onSpawn("nproc", { exitCode: 0, stdout: "8\n", stderr: "" });
		executor.onSpawn("wmic", { exitCode: 0, stdout: "NumberOfCores=8\n", stderr: "" });
		executor.onSpawn("faust", { exitCode: 1, stdout: "", stderr: "" });
		executor.onSpawn("test", { exitCode: 1, stdout: "", stderr: "" });
		executor.onSpawn("cmd", { exitCode: 0, stdout: "", stderr: "" });
		return async (path: string) => {
			if (path.endsWith("compilerSettings.xml")) {
				return `<HisePath value="${hisePath}"/>`;
			}
			if (path.endsWith("currentGitHash.txt")) {
				return gitHash ? `${gitHash}\n` : null;
			}
			return null;
		};
	}

	it("flags updateAvailable=0 when current and latest SHAs match; latestCommitPassedCi=1 when HEAD equals green", async () => {
		const executor = new MockPhaseExecutor();
		const readTextFile = stubEnvironment(executor);
		const SAME_SHA = "98a75d8ee4ff0db43e3de4b3aca3f4e53d16785c";
		const connection = new MockHiseConnection();
		connection.onGet("/api/status", () => ({
			success: true,
			server: { version: "4.1.0", compileTimeout: "20.0", buildCommit: SAME_SHA },
			project: { name: "Proj", projectFolder: "/proj", scriptsFolder: "/proj/Scripts" },
			scriptProcessors: [],
			logs: [],
			errors: [],
		}));

		const fetchImpl = mockGithubFetch(
			{ workflow_runs: [{ head_sha: SAME_SHA, display_title: "nothing new", created_at: "", html_url: "" }] },
			{ sha: SAME_SHA },
		);
		const handler = createUpdateDetectHandler({ executor, connection, fetchImpl, readTextFile });
		const defaults = await handler("update") as Record<string, string>;

		expect(defaults.installPath).toBe("/Users/test/HISE");
		expect(defaults.currentSha).toBe(SAME_SHA);
		expect(defaults.latestSha).toBe(SAME_SHA);
		expect(defaults.updateAvailable).toBe("0");
		expect(defaults.latestCommitPassedCi).toBe("1");
		expect(defaults.hiseRunning).toBe("1");
		expect(defaults.shutdownHise).toBe("1");
		expect(defaults.launchHise).toBe("1");
	});

	it("flags updateAvailable=1 and targetCommit=green when current differs", async () => {
		const executor = new MockPhaseExecutor();
		const readTextFile = stubEnvironment(executor);
		const CUR = "aaaa11111111111111111111111111111111aaaa";
		const LATEST = "bbbb22222222222222222222222222222222bbbb";
		const connection = new MockHiseConnection();
		connection.onGet("/api/status", () => ({
			success: true,
			server: { version: "4.1.0", compileTimeout: "20.0", buildCommit: CUR },
			project: { name: "Proj", projectFolder: "/proj", scriptsFolder: "/proj/Scripts" },
			scriptProcessors: [],
			logs: [],
			errors: [],
		}));
		const fetchImpl = mockGithubFetch(
			{ workflow_runs: [{ head_sha: LATEST, display_title: "new commit", created_at: "", html_url: "" }] },
			{ sha: LATEST },
		);
		const handler = createUpdateDetectHandler({ executor, connection, fetchImpl, readTextFile });
		const defaults = await handler("update") as Record<string, string>;

		expect(defaults.updateAvailable).toBe("1");
		expect(defaults.targetCommit).toBe(LATEST);
		expect(defaults.latestCommitTitle).toBe("new commit");
		expect(defaults.latestCommitPassedCi).toBe("1");
	});

	it("falls back to currentGitHash.txt when /api/status lacks buildCommit", async () => {
		const FILE_SHA = "ccccccccccccccccccccccccccccccccccccdddd";
		const executor = new MockPhaseExecutor();
		const readTextFile = stubEnvironment(executor, "/Users/test/HISE", FILE_SHA);
		const GREEN = "bbbb22222222222222222222222222222222bbbb";
		const connection = new MockHiseConnection();
		// Old HISE: /api/status responds but does not carry server.buildCommit.
		connection.onGet("/api/status", () => ({
			success: true,
			server: { version: "4.0.0" },
			project: { name: "Proj", projectFolder: "/proj", scriptsFolder: "/proj/Scripts" },
			scriptProcessors: [],
			logs: [],
			errors: [],
		}));
		const fetchImpl = mockGithubFetch(
			{ workflow_runs: [{ head_sha: GREEN, display_title: "x", created_at: "", html_url: "" }] },
			{ sha: GREEN },
		);
		const handler = createUpdateDetectHandler({ executor, connection, fetchImpl, readTextFile });
		const defaults = await handler("update") as Record<string, string>;

		expect(defaults.currentSha).toBe(FILE_SHA);
		expect(defaults.updateAvailable).toBe("1");
	});

	it("falls back to currentGitHash.txt when HISE is not running", async () => {
		const FILE_SHA = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
		const executor = new MockPhaseExecutor();
		const readTextFile = stubEnvironment(executor, "/Users/test/HISE", FILE_SHA);
		const GREEN = "bbbb22222222222222222222222222222222bbbb";
		const connection = new MockHiseConnection();
		connection.onGet("/api/status", () => ({ error: true, message: "offline" }));
		const fetchImpl = mockGithubFetch(
			{ workflow_runs: [{ head_sha: GREEN, display_title: "x", created_at: "", html_url: "" }] },
			{ sha: GREEN },
		);
		const handler = createUpdateDetectHandler({ executor, connection, fetchImpl, readTextFile });
		const defaults = await handler("update") as Record<string, string>;

		expect(defaults.hiseRunning).toBe("0");
		expect(defaults.currentSha).toBe(FILE_SHA);
		expect(defaults.updateAvailable).toBe("1");
	});

	it("flags latestCommitPassedCi=0 when develop HEAD is ahead of the latest green run", async () => {
		const executor = new MockPhaseExecutor();
		const readTextFile = stubEnvironment(executor);
		const GREEN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const connection = new MockHiseConnection();
		connection.onGet("/api/status", () => ({
			success: true,
			server: { version: "4.1.0", buildCommit: GREEN },
			project: { name: "Proj", projectFolder: "/proj", scriptsFolder: "/proj/Scripts" },
			scriptProcessors: [],
			logs: [],
			errors: [],
		}));
		const fetchImpl = mockGithubFetch(
			{ workflow_runs: [{ head_sha: GREEN, display_title: "last green", created_at: "", html_url: "" }] },
			{ sha: HEAD },
		);
		const handler = createUpdateDetectHandler({ executor, connection, fetchImpl, readTextFile });
		const defaults = await handler("update") as Record<string, string>;

		expect(defaults.latestCommitPassedCi).toBe("0");
		// Wizard still targets the green SHA for checkout, not HEAD.
		expect(defaults.targetCommit).toBe(GREEN);
	});

	it("aborts with a 'run /setup' message when compilerSettings.xml is missing", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("cmd", { exitCode: 1, stdout: "", stderr: "" });
		const connection = new MockHiseConnection();
		connection.onGet("/api/status", () => ({ error: true, message: "offline" }));
		const fetchImpl = mockGithubFetch(null, null);
		const readTextFile = async () => null;
		const handler = createUpdateDetectHandler({ executor, connection, fetchImpl, readTextFile });

		await expect(handler("update")).rejects.toThrow(WizardInitAbortError);
		await expect(handler("update")).rejects.toThrow(/Run \/setup/);
	});

	it("aborts when HISE is offline AND currentGitHash.txt is missing", async () => {
		const executor = new MockPhaseExecutor();
		const readTextFile = stubEnvironment(executor, "/Users/test/HISE", null);
		const connection = new MockHiseConnection();
		connection.onGet("/api/status", () => ({ error: true, message: "offline" }));
		const fetchImpl = mockGithubFetch(null, null);
		const handler = createUpdateDetectHandler({ executor, connection, fetchImpl, readTextFile });

		await expect(handler("update")).rejects.toThrow(WizardInitAbortError);
		await expect(handler("update")).rejects.toThrow(/currentGitHash\.txt/);
	});
});

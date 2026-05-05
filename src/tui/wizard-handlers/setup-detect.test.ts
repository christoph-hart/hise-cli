import { describe, expect, it } from "vitest";
import { createSetupDetectHandler } from "./setup-detect.js";
import { MockPhaseExecutor } from "../../engine/wizard/mock-phase-executor.js";

describe("setupDetectEnvironment", () => {
	// macOS detection gates on xcode-select -p to avoid popping the CLT
	// install dialog via the /usr/bin/{git,clang} stubs.
	function stubMacDevDir(executor: MockPhaseExecutor): void {
		executor.onSpawn("xcode-select", {
			exitCode: 0,
			stdout: "/Library/Developer/CommandLineTools\n",
			stderr: "",
		});
		executor.onSpawn("test", { exitCode: 0, stdout: "", stderr: "" });
	}

	it("detects platform and architecture", async () => {
		const executor = new MockPhaseExecutor();
		stubMacDevDir(executor);
		executor.onSpawn("git", { exitCode: 0, stdout: "git version 2.43.0", stderr: "" });
		executor.onSpawn("clang", {
			exitCode: 0,
			stdout: "Apple clang version 15.0.0\n",
			stderr: "",
		});
		executor.onSpawn("faust", { exitCode: 1, stdout: "", stderr: "not found" });

		const handler = createSetupDetectHandler(executor);
		const defaults = await handler("setup") as Record<string, string>;

		expect(defaults.platform).toBeDefined();
		expect(defaults.architecture).toBeDefined();
		expect(defaults.installPath).toBeDefined();
		expect(defaults.parallelJobs).toBeDefined();
		expect(parseInt(defaults.parallelJobs!, 10)).toBeGreaterThanOrEqual(1);
	});

	it("detects git presence", async () => {
		const executor = new MockPhaseExecutor();
		stubMacDevDir(executor);
		executor.onSpawn("git", { exitCode: 0, stdout: "git version 2.43.0", stderr: "" });

		const handler = createSetupDetectHandler(executor);
		const defaults = await handler("setup") as Record<string, string>;
		expect(defaults.hasGit).toBe("1");
	});

	it("detects git absence", async () => {
		const executor = new MockPhaseExecutor();
		// macOS: xcode-select -p returns non-zero → no dev dir → skip git
		// probe, so the /usr/bin/git stub never pops the CLT install dialog.
		executor.onSpawn("xcode-select", { exitCode: 1, stdout: "", stderr: "no dir" });
		// Windows / Linux: git probe runs unconditionally; stub it as missing.
		// (Windows fallback then probes `cmd /c if exist ...` — default empty
		// stdout doesn't include "found", so that branch correctly returns false.)
		executor.onSpawn("git", { exitCode: 1, stdout: "", stderr: "not found" });

		const handler = createSetupDetectHandler(executor);
		const defaults = await handler("setup") as Record<string, string>;
		expect(defaults.hasGit).toBe("0");
	});
});

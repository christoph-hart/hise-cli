import { describe, expect, it } from "vitest";
import {
	createSetupGitInstallHandler,
	createSetupPlatformCheckHandler,
	createSetupCloneRepoHandler,
	createSetupBuildDepsHandler,
	createSetupFaustInstallHandler,
	createSetupFftwInstallHandler,
	createSetupCompilerInstallHandler,
	createSetupCompileHandler,
	createSetupExtractSdksHandler,
	createSetupVerifyHandler,
	filterMsbuildLine,
	adaptJucerToVsVersion,
	normaliseVsVersion,
} from "./setup-tasks.js";
import { MockPhaseExecutor } from "../../engine/wizard/mock-phase-executor.js";
import type { WizardProgress } from "../../engine/wizard/types.js";

function noop(_p: WizardProgress): void {}

describe("setupPlatformCheck", () => {
	it("accepts Linux x64", async () => {
		const handler = createSetupPlatformCheckHandler();
		const result = await handler({ platform: "Linux", architecture: "x64" }, noop);
		expect(result.success).toBe(true);
	});

	it("rejects Linux ARM64 before setup mutates the system", async () => {
		const handler = createSetupPlatformCheckHandler();
		const result = await handler({ platform: "Linux", architecture: "arm64" }, noop);
		expect(result.success).toBe(false);
		expect(result.message).toContain("x64 only");
		expect(result.message).toContain("ARM64");
	});
});

describe("setupGitInstall", () => {
	// macOS probes `git` only after xcode-select -p confirms a dev dir
	// (otherwise the stub pops the CLT install dialog). Tests must stub both.
	function stubMacDevDir(executor: MockPhaseExecutor): void {
		executor.onSpawn("xcode-select", {
			exitCode: 0,
			stdout: "/Library/Developer/CommandLineTools\n",
			stderr: "",
		});
	}

	it("detects git at runtime and skips install", async () => {
		const executor = new MockPhaseExecutor();
		stubMacDevDir(executor);
		executor.onSpawn("git", { exitCode: 0, stdout: "git version 2.43.0", stderr: "" });
		const handler = createSetupGitInstallHandler(executor);
		const result = await handler({ platform: "macOS" }, noop);
		expect(result.success).toBe(true);
		expect(result.message).toContain("detected");
		const gitCall = executor.calls.find((c) => c.command === "git");
		expect(gitCall).toBeDefined();
	});

	it("re-probes on resume so stale hasGit=0 doesn't block a successful install", async () => {
		const executor = new MockPhaseExecutor();
		stubMacDevDir(executor);
		executor.onSpawn("git", { exitCode: 0, stdout: "git version 2.43.0", stderr: "" });
		const handler = createSetupGitInstallHandler(executor);
		// hasGit=0 is the stale init-time snapshot; runtime probe still wins.
		const result = await handler({ hasGit: "0", platform: "macOS" }, noop);
		expect(result.success).toBe(true);
	});

	it("skips git probe on macOS when no developer dir is active", async () => {
		const executor = new MockPhaseExecutor();
		// xcode-select -p fails → no dev dir. We must NOT invoke `git`
		// (would pop the CLT dialog). Handler should bail with CLT hint.
		executor.onSpawn("xcode-select", { exitCode: 1, stdout: "", stderr: "no dir" });
		const handler = createSetupGitInstallHandler(executor);
		const result = await handler({ hasGit: "0", platform: "macOS" }, noop);
		expect(result.success).toBe(false);
		expect(result.message).toContain("Command Line Tools");
		const gitCall = executor.calls.find((c) => c.command === "git");
		expect(gitCall).toBeUndefined();
	});

	it("attempts apt-get on Linux when git missing", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("git", { exitCode: 127, stdout: "", stderr: "not found" });
		executor.onSpawn("sudo", { exitCode: 0, stdout: "", stderr: "" });
		const handler = createSetupGitInstallHandler(executor);
		const result = await handler({ hasGit: "0", platform: "Linux" }, noop);
		expect(result.success).toBe(true);
		const sudo = executor.calls.find((c) => c.command === "sudo");
		expect(sudo).toBeDefined();
	});
});

describe("setupCloneRepo", () => {
	it("clones fresh when directory does not exist", async () => {
		const executor = new MockPhaseExecutor();
		// git -C fails (no repo), clone succeeds, rest succeeds
		executor.onSpawn("git", { exitCode: 0, stdout: "", stderr: "" });
		const handler = createSetupCloneRepoHandler(executor);
		const result = await handler({ installPath: "/tmp/hise" }, noop);
		expect(result.success).toBe(true);
		expect(executor.calls.length).toBeGreaterThan(0);
	});
});

describe("setupBuildDeps", () => {
	it("skips on non-Linux platforms", async () => {
		const executor = new MockPhaseExecutor();
		const handler = createSetupBuildDepsHandler(executor);
		const result = await handler({ platform: "macOS" }, noop);
		expect(result.success).toBe(true);
		expect(result.message).toContain("not needed");
		expect(executor.calls).toHaveLength(0);
	});

	it("installs packages on Linux", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("sudo", { exitCode: 0, stdout: "", stderr: "" });
		const handler = createSetupBuildDepsHandler(executor);
		const result = await handler({ platform: "Linux" }, noop);
		expect(result.success).toBe(true);
	});

	it("uses the WebKit 4.1 development package when 4.0 is unavailable", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("apt-cache", { exitCode: 1, stdout: "", stderr: "missing" });
		executor.onSpawn("sudo", { exitCode: 0, stdout: "", stderr: "" });
		const handler = createSetupBuildDepsHandler(executor);
		const result = await handler({ platform: "Linux" }, noop);
		expect(result.success).toBe(true);
		const install = executor.calls.find((call) => call.command === "sudo" && call.args.includes("install"));
		expect(install?.args).toContain("libwebkit2gtk-4.1-dev");
		expect(install?.args).toContain("unzip");
	});
});

describe("setupFaustInstall", () => {
	it("skips when faust not requested", async () => {
		const executor = new MockPhaseExecutor();
		const handler = createSetupFaustInstallHandler(executor);
		const result = await handler({ includeFaust: "0" }, noop);
		expect(result.success).toBe(true);
		expect(result.message).toContain("skipped");
	});

	it("re-probes and skips when faust already present", async () => {
		const executor = new MockPhaseExecutor();
		// Mock faust --version success so the runtime probe short-circuits.
		executor.onSpawn("faust", { exitCode: 0, stdout: "Faust 2.81.2", stderr: "" });
		const handler = createSetupFaustInstallHandler(executor);
		// hasFaust=0 is a stale init snapshot; runtime probe should override.
		const result = await handler({ includeFaust: "1", hasFaust: "0", platform: "macOS" }, noop);
		expect(result.success).toBe(true);
		expect(result.message).toContain("detected");
	});

	it("installs on Linux via apt-get", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawnSequence("faust", [
			{ exitCode: 127, stdout: "", stderr: "not found" },
			{ exitCode: 0, stdout: "FAUST Version 2.81.2", stderr: "" },
		]);
		executor.onSpawnSequence("test", [
			{ exitCode: 1, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "", stderr: "" },
		]);
		executor.onSpawn("/sbin/ldconfig", { exitCode: 0, stdout: "libfaust.so (libc6,x86-64)", stderr: "" });
		executor.onSpawn("sudo", { exitCode: 0, stdout: "", stderr: "" });
		const handler = createSetupFaustInstallHandler(executor);
		const result = await handler({ includeFaust: "1", hasFaust: "0", platform: "Linux" }, noop);
		expect(result.success).toBe(true);
		const install = executor.calls.find((call) => call.command === "sudo" && call.args.includes("install"));
		expect(install?.args).toContain("faust");
		expect(install?.args).not.toContain("libfaust-dev");
	});

	it("downloads and runs the NSIS installer via Start-Process -Verb RunAs (UAC self-elevation)", async () => {
		const executor = new MockPhaseExecutor();
		const handler = createSetupFaustInstallHandler(executor);
		const result = await handler({ includeFaust: "1", hasFaust: "0", platform: "Windows" }, noop);
		expect(result.success).toBe(true);

		const curl = executor.calls.find((c) => c.command === "curl");
		expect(curl).toBeDefined();
		const url = curl!.args[curl!.args.length - 1]!;
		expect(url).toContain("https://github.com/grame-cncm/faust/releases/download/");
		expect(url.endsWith("-win64.exe")).toBe(true);

		// Installer launched via powershell Start-Process -Verb RunAs, NOT
		// directly. Self-elevation lets hise-cli stay non-elevated.
		const psCall = executor.calls.find(
			(c) => c.command === "powershell" && c.args.some((a) => a.includes("Start-Process")),
		);
		expect(psCall).toBeDefined();
		const psCmd = psCall!.args.find((a) => a.includes("Start-Process"))!;
		expect(psCmd).toContain("-Verb RunAs");
		expect(psCmd).toContain("faust-installer.exe");
		expect(psCmd).toContain("/S");
		expect(psCmd).toContain("/D=C:\\Program Files\\Faust");
	});

	it("installs on macOS via DMG mount and ditto copy", async () => {
		const executor = new MockPhaseExecutor();
		// Faust runtime probe fails (not yet installed).
		executor.onSpawn("faust", { exitCode: 127, stdout: "", stderr: "" });
		executor.onSpawn("test", { exitCode: 1, stdout: "", stderr: "" });
		executor.onSpawn("curl", { exitCode: 0, stdout: "", stderr: "" });
		executor.onSpawn("hdiutil", {
			exitCode: 0,
			stdout: "/dev/disk4\tGUID_partition_scheme\n/dev/disk4s1\tApple_HFS\t/Volumes/Faust-2.81.2\n",
			stderr: "",
		});
		// `bash` covers the layout check AND the ditto copy — both succeed.
		executor.onSpawn("bash", { exitCode: 0, stdout: "", stderr: "" });

		const handler = createSetupFaustInstallHandler(executor);
		const result = await handler({
			includeFaust: "1",
			hasFaust: "0",
			platform: "macOS",
			architecture: "arm64",
			installPath: "/Users/me/HISE",
		}, noop);
		expect(result.success).toBe(true);
		expect(result.message).toContain("/Users/me/HISE/tools/faust");

		const curl = executor.calls.find((c) => c.command === "curl");
		expect(curl!.args).toContain("https://github.com/grame-cncm/faust/releases/download/2.81.2/Faust-2.81.2-arm64.dmg");

		const attach = executor.calls.find((c) => c.command === "hdiutil" && c.args.includes("attach"));
		expect(attach).toBeDefined();

		const ditto = executor.calls.find((c) => c.command === "bash" && (c.args[1] ?? "").includes("ditto"));
		expect(ditto).toBeDefined();
		expect(ditto!.args[1]).toContain("/Users/me/HISE/tools/faust/lib");
		expect(ditto!.args[1]).toContain("hise-faust-mnt/Faust-2.81.2/lib");

		const detach = executor.calls.find((c) => c.command === "hdiutil" && c.args.includes("detach"));
		expect(detach).toBeDefined();
	});

	it("fails cleanly and unmounts when DMG layout is unexpected on macOS", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("faust", { exitCode: 127, stdout: "", stderr: "" });
		executor.onSpawn("test", { exitCode: 1, stdout: "", stderr: "" });
		executor.onSpawn("curl", { exitCode: 0, stdout: "", stderr: "" });
		executor.onSpawn("hdiutil", {
			exitCode: 0,
			stdout: "/dev/disk4s1\tApple_HFS\t/Volumes/Faust-2.81.2\n",
			stderr: "",
		});
		// Layout check (bash test -d chain) fails.
		executor.onSpawn("bash", { exitCode: 1, stdout: "", stderr: "" });

		const handler = createSetupFaustInstallHandler(executor);
		const result = await handler({
			includeFaust: "1",
			hasFaust: "0",
			platform: "macOS",
			architecture: "arm64",
			installPath: "/Users/me/HISE",
		}, noop);
		expect(result.success).toBe(false);
		expect(result.message).toContain("doesn't contain the expected");

		// Still detached even on layout failure.
		const detach = executor.calls.find((c) => c.command === "hdiutil" && c.args.includes("detach"));
		expect(detach).toBeDefined();
	});
});

describe("setupFftwInstall", () => {
	it("skips outside Linux", async () => {
		const executor = new MockPhaseExecutor();
		const handler = createSetupFftwInstallHandler(executor);
		const result = await handler({ platform: "macOS", includeFftw: "1" }, noop);
		expect(result.success).toBe(true);
		expect(executor.calls).toHaveLength(0);
	});

	it("installs and verifies fftw3f on Linux", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawnSequence("pkg-config", [
			{ exitCode: 1, stdout: "", stderr: "missing" },
			{ exitCode: 0, stdout: "", stderr: "" },
		]);
		executor.onSpawn("sudo", { exitCode: 0, stdout: "", stderr: "" });
		const handler = createSetupFftwInstallHandler(executor);
		const result = await handler({ platform: "Linux", includeFftw: "1" }, noop);
		expect(result.success).toBe(true);
		const install = executor.calls.find((call) => call.command === "sudo" && call.args.includes("install"));
		expect(install?.args).toContain("libfftw3-dev");
	});

	it("fails when fftw3f is still unavailable after installation", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("pkg-config", { exitCode: 1, stdout: "", stderr: "missing" });
		executor.onSpawn("sudo", { exitCode: 0, stdout: "", stderr: "" });
		const handler = createSetupFftwInstallHandler(executor);
		const result = await handler({ platform: "Linux", includeFftw: "1" }, noop);
		expect(result.success).toBe(false);
		expect(result.message).toContain("fftw3f");
	});
});

describe("Linux setup completion", () => {
	it("extracts the SDK ZIP with unzip", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("test", { exitCode: 1, stdout: "", stderr: "" });
		executor.onSpawn("unzip", { exitCode: 0, stdout: "", stderr: "" });
		const handler = createSetupExtractSdksHandler(executor);
		const result = await handler({ platform: "Linux", installPath: "/HISE" }, noop);
		expect(result.success).toBe(true);
		const unzip = executor.calls.find((call) => call.command === "unzip");
		expect(unzip?.args).toEqual(["-o", "sdk.zip"]);
	});

	it("persists /usr as the Linux Faust prefix", async () => {
		const executor = new MockPhaseExecutor();
		const handler = createSetupVerifyHandler(executor);
		const result = await handler({
			platform: "Linux",
			installPath: "/HISE",
			includeFaust: "1",
		}, noop);
		expect(result.success).toBe(true);
		const settings = executor.calls.find((call) => call.args[0] === "set_hise_settings");
		expect(settings?.args).toContain("-faustpath:/usr");
	});
});

describe("setupCompilerInstall", () => {
	it("skips on Linux (handled by buildDeps)", async () => {
		const executor = new MockPhaseExecutor();
		const handler = createSetupCompilerInstallHandler(executor);
		const result = await handler({ platform: "Linux" }, noop);
		expect(result.success).toBe(true);
		expect(executor.calls).toHaveLength(0);
	});

	describe("macOS", () => {
		it("passes when xcode-select -p points at a dev dir with clang", async () => {
			const executor = new MockPhaseExecutor();
			executor.onSpawn("xcode-select", {
				exitCode: 0,
				stdout: "/Library/Developer/CommandLineTools\n",
				stderr: "",
			});
			executor.onSpawn("test", { exitCode: 0, stdout: "", stderr: "" });
			const handler = createSetupCompilerInstallHandler(executor);
			const result = await handler({ platform: "macOS" }, noop);
			expect(result.success).toBe(true);
			expect(result.message).toContain("Command Line Tools detected");
			// Installer should not have been triggered.
			const triggered = executor.calls.find(
				(c) => c.command === "xcode-select" && c.args.includes("--install"),
			);
			expect(triggered).toBeUndefined();
		});

		it("launches CLT installer when developer dir is missing", async () => {
			const executor = new MockPhaseExecutor();
			// First xcode-select -p call fails (no dev dir); second call with
			// --install returns 0. MockPhaseExecutor keys by command name, so
			// the same stub covers both invocations — return non-zero. Then
			// override for the --install call via a custom spawn.
			const baseSpawn = executor.spawn.bind(executor);
			executor.spawn = async (cmd, args, opts) => {
				if (cmd === "xcode-select" && args.includes("--install")) {
					executor.calls.push({ command: cmd, args, env: opts.env });
					return { exitCode: 0, stdout: "", stderr: "" };
				}
				if (cmd === "xcode-select") {
					executor.calls.push({ command: cmd, args, env: opts.env });
					return { exitCode: 1, stdout: "", stderr: "no dir" };
				}
				return baseSpawn(cmd, args, opts);
			};
			const handler = createSetupCompilerInstallHandler(executor);
			const result = await handler({ platform: "macOS" }, noop);
			expect(result.success).toBe(false);
			const triggered = executor.calls.find(
				(c) => c.command === "xcode-select" && c.args.includes("--install"),
			);
			expect(triggered).toBeDefined();
			expect(result.message).toContain("system dialog");
			expect(result.message).toContain("/resume");
		});

		it("still fails cleanly if xcode-select --install reports an unexpected non-zero", async () => {
			const executor = new MockPhaseExecutor();
			const baseSpawn = executor.spawn.bind(executor);
			executor.spawn = async (cmd, args, opts) => {
				if (cmd === "xcode-select" && args.includes("--install")) {
					executor.calls.push({ command: cmd, args, env: opts.env });
					return { exitCode: 2, stdout: "", stderr: "some unexpected error" };
				}
				if (cmd === "xcode-select") {
					executor.calls.push({ command: cmd, args, env: opts.env });
					return { exitCode: 1, stdout: "", stderr: "no dir" };
				}
				return baseSpawn(cmd, args, opts);
			};
			const handler = createSetupCompilerInstallHandler(executor);
			const result = await handler({ platform: "macOS" }, noop);
			expect(result.success).toBe(false);
			expect(result.message).toContain("some unexpected error");
		});
	});

	describe("Windows", () => {
		it("re-probes vswhere and skips when VS is present", async () => {
			const executor = new MockPhaseExecutor();
			executor.onSpawn(
				"C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe",
				{ exitCode: 0, stdout: "Visual Studio Build Tools 2022\n", stderr: "" },
			);
			const handler = createSetupCompilerInstallHandler(executor);
			// hasVs=0 is a stale init snapshot; the vswhere probe wins.
			const result = await handler({ platform: "Windows", hasVs: "0" }, noop);
			expect(result.success).toBe(true);
			expect(result.message).toContain("detected");
		});

		it("downloads bootstrapper and runs install via Start-Process -Verb RunAs", async () => {
			const executor = new MockPhaseExecutor();
			const handler = createSetupCompilerInstallHandler(executor);
			const result = await handler({ platform: "Windows", hasVs: "0" }, noop);
			expect(result.success).toBe(true);

			const curl = executor.calls.find((c) => c.command === "curl");
			expect(curl).toBeDefined();
			expect(curl!.args).toContain("https://aka.ms/vs/stable/vs_BuildTools.exe");

			// Installer launched via powershell Start-Process -Verb RunAs;
			// hise-cli itself stays non-elevated.
			const psCall = executor.calls.find(
				(c) => c.command === "powershell" && c.args.some((a) => a.includes("Start-Process")),
			);
			expect(psCall).toBeDefined();
			const psCmd = psCall!.args.find((a) => a.includes("Start-Process"))!;
			expect(psCmd).toContain("-Verb RunAs");
			expect(psCmd).toContain("vs_BuildTools.exe");
			expect(psCmd).toContain("--passive");
			expect(psCmd).toContain("--wait");
			expect(psCmd).toContain("--norestart");
			expect(psCmd).toContain("Microsoft.VisualStudio.Workload.VCTools");
			expect(psCmd).toContain("Microsoft.VisualStudio.Component.VC.Tools.x86.x64");
			expect(psCmd).toContain("Microsoft.VisualStudio.Component.Windows11SDK.26100");
			expect(psCmd).toContain("en-US");
		});

		it("treats installer exit code 3010 (reboot-pending) as success", async () => {
			const executor = new MockPhaseExecutor();
			// runElevatedInstaller calls powershell with the Start-Process
			// command — propagate 3010 from PowerShell's exit.
			const baseSpawn = executor.spawn.bind(executor);
			executor.spawn = async (command, args, options) => {
				if (command === "powershell" && args.some((a) => a.includes("vs_BuildTools.exe"))) {
					executor.calls.push({ command, args, env: options.env });
					return { exitCode: 3010, stdout: "", stderr: "" };
				}
				return baseSpawn(command, args, options);
			};
			const handler = createSetupCompilerInstallHandler(executor);
			const result = await handler({ platform: "Windows", hasVs: "0" }, noop);
			expect(result.success).toBe(true);
		});
	});
});

describe("setupCompile (Linux)", () => {
	it("rejects ARM64 before invoking the x86-64 Projucer", async () => {
		const executor = new MockPhaseExecutor();
		const handler = createSetupCompileHandler(executor);
		const result = await handler({
			platform: "Linux",
			architecture: "arm64",
			installPath: "/HISE",
		}, noop);
		expect(result.success).toBe(false);
		expect(result.message).toContain("ARM64");
		expect(executor.calls).toHaveLength(0);
	});

	it("uses the lowercase Projucer path when that is the executable layout", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawnSequence("test", [
			{ exitCode: 1, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "", stderr: "" },
		]);
		const handler = createSetupCompileHandler(executor);
		const result = await handler({
			platform: "Linux",
			installPath: "/HISE",
			parallelJobs: "2",
		}, noop);
		expect(result.success).toBe(true);
		expect(executor.calls.some((call) => call.command === "/HISE/JUCE/projucer/Projucer")).toBe(true);
	});

	it("fails clearly when Projucer is missing", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("test", { exitCode: 1, stdout: "", stderr: "" });
		const handler = createSetupCompileHandler(executor);
		const result = await handler({ platform: "Linux", installPath: "/HISE" }, noop);
		expect(result.success).toBe(false);
		expect(result.message).toContain("Projucer not found");
	});
});

describe("setupCompile (Windows)", () => {
	it("passes VSLANG=1033 to MSBuild so output is English", async () => {
		const executor = new MockPhaseExecutor();
		// vswhere -find returns the MSBuild.exe path directly; no
		// installationPath concat in resolveMsbuildPath any more.
		executor.onSpawn("C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe", {
			exitCode: 0,
			stdout: "C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe\n",
			stderr: "",
		});
		const handler = createSetupCompileHandler(executor);
		await handler({ platform: "Windows", installPath: "C:\\HISE", includeFaust: "0" }, noop);

		const msbuildCall = executor.calls.find((c) => c.command.endsWith("MSBuild.exe"));
		expect(msbuildCall).toBeDefined();
		expect(msbuildCall?.env?.VSLANG).toBe("1033");
		expect(msbuildCall?.env?.VSLANGCODE).toBe("en-US");
	});
});

describe("adaptJucerToVsVersion", () => {
	const vs2026 = `<JUCERPROJECT>
  <EXPORTFORMATS>
    <VS2026 targetFolder="Builds/VisualStudio2026" smallIcon="abc"
            extraDefs="HISE_USE_VS2022=0&#10;PERFETTO=0">
      <CONFIGURATIONS>
        <CONFIGURATION name="Release"/>
      </CONFIGURATIONS>
    </VS2026>
  </EXPORTFORMATS>
</JUCERPROJECT>`;

	it("rewrites VS2026 → VS2022 and flips HISE_USE_VS2022 to 1", () => {
		const out = adaptJucerToVsVersion(vs2026, "2022");
		expect(out).not.toBeNull();
		expect(out).toContain("<VS2022 targetFolder=\"Builds/VisualStudio2022\"");
		expect(out).toContain("</VS2022>");
		expect(out).toContain("HISE_USE_VS2022=1");
		expect(out).not.toContain("VS2026");
		expect(out).not.toContain("VisualStudio2026");
	});

	it("returns null when already targeting the requested VS version", () => {
		const out = adaptJucerToVsVersion(vs2026, "2026");
		expect(out).toBeNull();
	});

	it("is idempotent — second pass after a 2022 rewrite is a no-op", () => {
		const first = adaptJucerToVsVersion(vs2026, "2022");
		expect(first).not.toBeNull();
		const second = adaptJucerToVsVersion(first!, "2022");
		expect(second).toBeNull();
	});
});

describe("normaliseVsVersion", () => {
	it("returns 2026 by default for missing / unknown values", () => {
		expect(normaliseVsVersion(undefined)).toBe("2026");
		expect(normaliseVsVersion("")).toBe("2026");
		expect(normaliseVsVersion("garbage")).toBe("2026");
	});
	it("returns 2022 only for an exact match", () => {
		expect(normaliseVsVersion("2022")).toBe("2022");
	});
});

describe("filterMsbuildLine", () => {
	const installPath = "C:\\HISE";

	it("reformats warning diagnostic with path stripping", () => {
		const input =
			"C:\\HISE\\hi_backend\\backend\\ai_tools\\RestHelpers.cpp(3316,7): " +
			"warning C4189: \"p\": Lokale Variable ist initialisiert aber nicht referenziert " +
			"[C:\\HISE\\projects\\standalone\\Builds\\VisualStudio2026\\HISE Standalone_App.vcxproj]";
		const out = filterMsbuildLine(input, installPath);
		expect(out).toBe(
			"⚠ warning C4189: \"p\": Lokale Variable ist initialisiert aber nicht referenziert\n" +
			"   hi_backend/backend/ai_tools/RestHelpers.cpp (3316,7)",
		);
	});

	it("reformats error diagnostic with ✗ marker", () => {
		const input =
			"C:\\HISE\\foo\\bar.cpp(42,3): error C2065: 'x': undeclared identifier [C:\\HISE\\proj.vcxproj]";
		const out = filterMsbuildLine(input, installPath);
		expect(out).toBe("✗ error C2065: 'x': undeclared identifier\n   foo/bar.cpp (42,3)");
	});

	it("keeps absolute path when file lies outside installPath", () => {
		const input =
			"D:\\External\\thing.cpp(1,1): warning C4100: unused [D:\\External\\proj.vcxproj]";
		const out = filterMsbuildLine(input, installPath);
		expect(out).toBe("⚠ warning C4100: unused\n   D:/External/thing.cpp (1,1)");
	});

	it("handles diagnostics with only line number (no column)", () => {
		const input =
			"C:\\HISE\\a\\b.cpp(10): warning C4189: msg [C:\\HISE\\proj.vcxproj]";
		const out = filterMsbuildLine(input, installPath);
		expect(out).toBe("⚠ warning C4189: msg\n   a/b.cpp (10)");
	});

	it("drops German 'Quelldatei wird kompiliert' follow-ups", () => {
		const input = "  (Quelldatei „../../JuceLibraryCode/include_hi_backend.cpp“ wird kompiliert)";
		expect(filterMsbuildLine(input, installPath)).toBeNull();
	});

	it("drops English 'Compiling source file' follow-ups", () => {
		const input = "  (Compiling source file ../../JuceLibraryCode/foo.cpp)";
		expect(filterMsbuildLine(input, installPath)).toBeNull();
	});

	it("passes through unrelated lines unchanged", () => {
		expect(filterMsbuildLine("Build succeeded.", installPath)).toBe("Build succeeded.");
		expect(filterMsbuildLine("    0 Warning(s)", installPath)).toBe("    0 Warning(s)");
	});

	it("works without installPath (keeps absolute paths)", () => {
		const input =
			"C:\\HISE\\foo.cpp(1,1): warning C4189: msg [C:\\HISE\\proj.vcxproj]";
		const out = filterMsbuildLine(input);
		expect(out).toBe("⚠ warning C4189: msg\n   C:/HISE/foo.cpp (1,1)");
	});
});

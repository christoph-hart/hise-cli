// ── Setup wizard init handler — environment detection ────────────────
//
// Detects platform, architecture, git, compiler, and Faust availability.
// Returns default values to pre-fill the setup wizard form.

import type { InternalInitHandler } from "../../engine/wizard/handler-registry.js";
import type { PhaseExecutor } from "../../engine/wizard/phase-executor.js";
import { detectVsVersion } from "./setup-tasks.js";

const DEFAULT_INSTALL_PATHS_MACOS = ["~/HISE", "/Users/Shared/HISE", "~/Documents/HISE", "~/Desktop/HISE"];
const DEFAULT_INSTALL_PATHS_WINDOWS = ["C:\\HISE", "~/HISE", "D:\\HISE", "~/Documents/HISE", "~/Desktop/HISE"];
const DEFAULT_INSTALL_PATHS_LINUX = ["~/HISE", "/opt/HISE", "~/Documents/HISE"];

function expandHome(p: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	return p.replace(/^~/, home);
}

export function createSetupDetectHandler(executor: PhaseExecutor): InternalInitHandler {
	return async (_wizardId) => {
		const defaults: Record<string, string> = {};

		// Platform
		const platform =
			process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
		defaults.platform = platform;

		// Architecture
		defaults.architecture = process.arch === "arm64" ? "arm64" : "x64";

		// Git detection — try PATH first, then known install locations
		// (Windows installer updates PATH only for new shells, so fresh
		// installs won't resolve via `git` on an already-running process).
		defaults.hasGit = await detectGit(executor, platform) ? "1" : "0";

		// Compiler detection
		defaults.compilerVersion = await detectCompiler(executor, platform);
		defaults.hasVs =
			platform === "Windows" && defaults.compilerVersion !== "Not detected" ? "1" : "0";

		// Visual Studio major year (Windows only). Defaults to "2026" — the
		// year aka.ms/vs/stable installs when compilerInstall has to fetch
		// VS Build Tools — so first-time setups on a clean VM end up with
		// VS2026 paths. The adaptVsVersion task re-probes after install and
		// mutates answers.vsVersion if the post-install year differs.
		if (platform === "Windows") {
			defaults.vsVersion = (await detectVsVersion(executor)) ?? "2026";
		} else {
			defaults.vsVersion = "2026";
		}

		// Intel IPP detection (Windows only)
		defaults.hasIpp = await detectIpp(executor, platform) ? "1" : "0";

		// Default install path (first existing HISE install or ~/HISE)
		const candidates =
			platform === "macOS"
				? DEFAULT_INSTALL_PATHS_MACOS
				: platform === "Windows"
					? DEFAULT_INSTALL_PATHS_WINDOWS
					: DEFAULT_INSTALL_PATHS_LINUX;

		defaults.installPath = expandHome(candidates[0]!);

		// Faust detection — check PATH and the HISE-local install at
		// <installPath>/tools/faust/lib/libfaust.<dylib|so|dll>.
		defaults.hasFaust = await detectFaust(executor, platform, defaults.installPath) ? "1" : "0";

		// Parallel jobs — cores × RAM-aware cap. 2 GB per clang job matches
		// HISE's peak RSS; prevents OOM thrash on RAM-constrained VMs.
		defaults.parallelJobs = String(await detectParallelJobs(executor, platform));

		return defaults;
	};
}

export async function detectParallelJobs(executor: PhaseExecutor, platform: string): Promise<number> {
	const { cores, ramBytes } = await detectCoresAndRam(executor, platform);
	const ramGb = ramBytes / (1024 ** 3);
	const memoryCap = Math.max(1, Math.floor(ramGb / 2));
	return Math.max(1, Math.min(cores, memoryCap));
}

async function detectCoresAndRam(
	executor: PhaseExecutor,
	platform: string,
): Promise<{ cores: number; ramBytes: number }> {
	if (platform === "macOS") {
		const coresR = await executor.spawn("sysctl", ["-n", "hw.physicalcpu"], {});
		const memR = await executor.spawn("sysctl", ["-n", "hw.memsize"], {});
		const cores = parseInt(coresR.stdout.trim(), 10) || 1;
		const ramBytes = parseInt(memR.stdout.trim(), 10) || 0;
		return { cores, ramBytes };
	}
	if (platform === "Linux") {
		const coresR = await executor.spawn("nproc", [], {});
		const memR = await executor.spawn("cat", ["/proc/meminfo"], {});
		const cores = parseInt(coresR.stdout.trim(), 10) || 1;
		const match = /MemTotal:\s+(\d+)\s+kB/.exec(memR.stdout);
		const ramBytes = match ? parseInt(match[1]!, 10) * 1024 : 0;
		return { cores, ramBytes };
	}
	// Windows — wmic output is "Key=Value" per line in /value mode.
	const coresR = await executor.spawn("wmic", ["cpu", "get", "NumberOfCores", "/value"], {});
	const memR = await executor.spawn("wmic", ["ComputerSystem", "get", "TotalPhysicalMemory", "/value"], {});
	const coresMatch = /NumberOfCores=(\d+)/.exec(coresR.stdout);
	const memMatch = /TotalPhysicalMemory=(\d+)/.exec(memR.stdout);
	const cores = coresMatch ? parseInt(coresMatch[1]!, 10) : 1;
	const ramBytes = memMatch ? parseInt(memMatch[1]!, 10) : 0;
	return { cores, ramBytes };
}

async function detectCompiler(
	executor: PhaseExecutor,
	platform: string,
): Promise<string> {
	if (platform === "macOS") {
		// The `/usr/bin/clang` stub pops the CLT install dialog when no
		// developer dir is set. Check `xcode-select -p` first — it never
		// triggers the dialog. Only invoke clang when the dir exists.
		if (!(await hasMacDeveloperDir(executor))) return "Not detected";
		const clang = await executor.spawn("clang", ["--version"], {});
		if (clang.exitCode === 0) {
			return (clang.stdout.split("\n")[0] ?? "").trim();
		}
	} else if (platform === "Linux") {
		const gcc = await executor.spawn("gcc", ["--version"], {});
		if (gcc.exitCode === 0) {
			return (gcc.stdout.split("\n")[0] ?? "").trim();
		}
	} else {
		// Windows — try vswhere. Use -products * to include Build Tools
		// (default product list excludes them) and require the MSVC C++
		// compiler component so "MSBuild-only" installs don't false-positive.
		const vswhere = await executor.spawn(
			"C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe",
			[
				"-latest",
				"-products", "*",
				"-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
				"-property", "displayName",
			],
			{},
		);
		if (vswhere.exitCode === 0 && vswhere.stdout.trim()) {
			return vswhere.stdout.trim();
		}
	}
	return "Not detected";
}

/** True when macOS `xcode-select -p` resolves — i.e. the `/usr/bin/*`
 *  developer-tool stubs (git, clang, etc.) will forward to a real binary
 *  instead of popping the "Install Command Line Developer Tools" dialog. */
async function hasMacDeveloperDir(executor: PhaseExecutor): Promise<boolean> {
	const sel = await executor.spawn("xcode-select", ["-p"], {});
	if (sel.exitCode !== 0) return false;
	const dir = sel.stdout.trim();
	if (!dir) return false;
	const clang = await executor.spawn("test", ["-x", `${dir}/usr/bin/clang`], {});
	return clang.exitCode === 0;
}

async function detectGit(executor: PhaseExecutor, platform: string): Promise<boolean> {
	if (platform === "macOS") {
		// Don't invoke `git` directly on macOS — the /usr/bin/git stub pops
		// the CLT install dialog when no developer dir is set. Gate on the
		// dev-dir probe first; if present, the stub resolves safely.
		if (!(await hasMacDeveloperDir(executor))) return false;
	}
	const onPath = await executor.spawn("git", ["--version"], {});
	if (onPath.exitCode === 0) return true;
	if (platform !== "Windows") return false;
	// Windows fallback: check known install locations (winget/Git for Windows).
	// If found, inject the dir into process.env.PATH so subsequent spawns
	// (clone, submodule update) can resolve plain `git` — the terminal that
	// started the wizard inherited its PATH before git was installed, so a
	// fresh hise-cli launch from that same terminal won't see the system
	// PATH update winget wrote to the registry.
	const candidates = [
		"C:\\Program Files\\Git\\cmd",
		"C:\\Program Files (x86)\\Git\\cmd",
	];
	for (const dir of candidates) {
		const exe = `${dir}\\git.exe`;
		const check = await executor.spawn("cmd", ["/c", `if exist "${exe}" echo found`], {});
		if (check.stdout.includes("found")) {
			const existing = process.env.PATH ?? "";
			if (!existing.toLowerCase().includes(dir.toLowerCase())) {
				process.env.PATH = `${dir};${existing}`;
			}
			return true;
		}
	}
	return false;
}

async function detectIpp(executor: PhaseExecutor, platform: string): Promise<boolean> {
	if (platform !== "Windows") return false;
	const result = await executor.spawn(
		"cmd",
		["/c", "if exist \"C:\\Program Files (x86)\\Intel\\oneAPI\\ipp\\latest\" echo found"],
		{},
	);
	return result.stdout.includes("found");
}

export async function detectFaust(
	executor: PhaseExecutor,
	platform: string,
	installPath: string,
): Promise<boolean> {
	if (platform === "Windows") {
		// Global install
		const global = await executor.spawn("cmd", ["/c", "if exist \"C:\\Program Files\\Faust\\lib\\faust.dll\" echo found"], {});
		if (global.stdout.includes("found")) return true;
		// HISE-local install at <installPath>\tools\faust\lib\libfaust.dll
		const local = `${installPath}\\tools\\faust\\lib\\libfaust.dll`;
		const localCheck = await executor.spawn("cmd", ["/c", `if exist "${local}" echo found`], {});
		return localCheck.stdout.includes("found");
	}

	// macOS / Linux — check PATH first
	const onPath = await executor.spawn("faust", ["--version"], {});
	if (onPath.exitCode === 0) return true;

	// Fall back to HISE-local install at <installPath>/tools/faust/lib/libfaust.<ext>
	const ext = platform === "macOS" ? "dylib" : "so";
	const local = `${installPath}/tools/faust/lib/libfaust.${ext}`;
	const localCheck = await executor.spawn("test", ["-f", local], {});
	return localCheck.exitCode === 0;
}

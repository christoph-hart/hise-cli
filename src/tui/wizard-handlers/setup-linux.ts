import type { PhaseExecutor, SpawnResult } from "../../engine/wizard/phase-executor.js";

const MIN_FAUST_VERSION = [2, 54, 0] as const;

export async function hasApt(executor: PhaseExecutor): Promise<boolean> {
	const result = await executor.spawn("apt-get", ["--version"], {});
	return result.exitCode === 0;
}

export async function runApt(
	executor: PhaseExecutor,
	args: string[],
	onLog?: (line: string, transient?: boolean) => void,
): Promise<SpawnResult> {
	if (!(await hasApt(executor))) {
		return {
			exitCode: 1,
			stdout: "",
			stderr: "Linux setup requires a Debian/Ubuntu system with apt-get.",
		};
	}

	const uid = await executor.spawn("id", ["-u"], {});
	const asRoot = uid.exitCode === 0 && uid.stdout.trim() === "0";
	if (asRoot) return executor.spawn("apt-get", args, { onLog });

	let authorized = await executor.spawn("sudo", ["-n", "true"], {});
	if (authorized.exitCode !== 0) {
		if (!executor.supportsInteractive) {
			return {
				exitCode: 1,
				stdout: "",
				stderr: "Administrator access is required. Run `sudo -v` in the server terminal, then `/resume`.",
			};
		}
		onLog?.("Administrator access is required. Enter your sudo password in the terminal.");
		authorized = await executor.spawn("sudo", ["-v"], { interactive: true });
		if (authorized.exitCode !== 0) {
			return {
				exitCode: authorized.exitCode,
				stdout: authorized.stdout,
				stderr: "Administrator authorization failed. Run `sudo -v`, then `/resume`.",
			};
		}
	}

	return executor.spawn("sudo", ["-n", "apt-get", ...args], { onLog });
}

export async function installAptPackages(
	executor: PhaseExecutor,
	packages: string[],
	onLog?: (line: string, transient?: boolean) => void,
): Promise<SpawnResult> {
	const update = await runApt(executor, ["update"], onLog);
	if (update.exitCode !== 0) return update;
	return runApt(executor, ["install", "-y", ...packages], onLog);
}

function hasMinimumFaustVersion(output: string): boolean {
	const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
	if (!match) return false;
	const version = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
	for (let i = 0; i < MIN_FAUST_VERSION.length; i++) {
		if (version[i]! > MIN_FAUST_VERSION[i]!) return true;
		if (version[i]! < MIN_FAUST_VERSION[i]!) return false;
	}
	return true;
}

export async function detectFaust(
	executor: PhaseExecutor,
	platform: string,
	installPath: string,
): Promise<boolean> {
	if (platform === "Windows") {
		const global = await executor.spawn("cmd", ["/c", "if exist \"C:\\Program Files\\Faust\\lib\\faust.dll\" echo found"], {});
		if (global.stdout.includes("found")) return true;
		const local = `${installPath}\\tools\\faust\\lib\\libfaust.dll`;
		const localCheck = await executor.spawn("cmd", ["/c", `if exist "${local}" echo found`], {});
		return localCheck.stdout.includes("found");
	}

	const onPath = await executor.spawn("faust", ["--version"], {});
	if (onPath.exitCode === 0 && hasMinimumFaustVersion(`${onPath.stdout}\n${onPath.stderr}`)) {
		if (platform === "macOS") return true;
		const headers = await executor.spawn("test", ["-d", "/usr/include/faust"], {});
		const architectures = await executor.spawn("test", ["-d", "/usr/share/faust"], {});
		const libraries = await executor.spawn("/sbin/ldconfig", ["-p"], {});
		if (
			headers.exitCode === 0
			&& architectures.exitCode === 0
			&& libraries.exitCode === 0
			&& /libfaust\.so(?:\s|\.)/.test(libraries.stdout)
		) return true;
	}

	const ext = platform === "macOS" ? "dylib" : "so";
	const local = `${installPath}/tools/faust/lib/libfaust.${ext}`;
	const localCheck = await executor.spawn("test", ["-f", local], {});
	return localCheck.exitCode === 0;
}

export async function detectFftw(executor: PhaseExecutor, platform: string): Promise<boolean> {
	if (platform !== "Linux") return false;
	const result = await executor.spawn("pkg-config", ["--exists", "fftw3f"], {});
	return result.exitCode === 0;
}

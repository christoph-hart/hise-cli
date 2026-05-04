// ── Node.js HiseLauncher — detached process spawning ────────────────

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, posix, win32 } from "node:path";
import type { HiseLauncher } from "../engine/modes/hise.js";

export function createNodeHiseLauncher(): HiseLauncher {
	return {
		async spawnDetached(command: string, args: string[]): Promise<void> {
			const fallback = await resolveFallbackWhenNotOnPath(command);
			if (fallback) {
				await spawnDetached(fallback, args);
				return;
			}

			try {
				await spawnDetached(command, args);
			} catch (error) {
				if (!isNotFoundError(error)) throw error;

				const retryFallback = await resolveHiseBinaryFromCompilerSettings(command, process.platform);
				if (!retryFallback) throw error;
				await spawnDetached(retryFallback, args);
			}
		},
	};
}

async function resolveFallbackWhenNotOnPath(command: string): Promise<string | null> {
	if (command !== "HISE" && command !== "HISE Debug") return null;
	if (await isCommandOnPath(command)) return null;
	return resolveHiseBinaryFromCompilerSettings(command, process.platform);
}

async function isCommandOnPath(command: string): Promise<boolean> {
	if (command.includes("/") || command.includes("\\")) return isAccessible(command);

	const path = process.env.PATH ?? "";
	const extensions = process.platform === "win32"
		? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
		: [""];

	for (const dir of path.split(delimiter)) {
		if (!dir) continue;
		for (const ext of extensions) {
			if (await isAccessible(join(dir, `${command}${ext}`))) return true;
		}
	}

	return false;
}

function spawnDetached(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		try {
			// On Windows with shell: true, quote the command if it contains spaces
			const isWin = process.platform === "win32";
			const cmd = isWin && command.includes(" ") ? `"${command}"` : command;
			const proc = spawn(cmd, args, {
				detached: true,
				stdio: "ignore",
				shell: isWin,
			});
			proc.unref();

			let settled = false;
			proc.on("error", (err) => {
				if (!settled) {
					settled = true;
					reject(err);
				}
			});
			// If no error within 200ms, the process started successfully
			setTimeout(() => {
				if (!settled) {
					settled = true;
					resolve();
				}
			}, 200);
		} catch (err) {
			reject(err);
		}
	});
}

function isNotFoundError(error: unknown): boolean {
	const err = error as { code?: string; message?: string };
	return err.code === "ENOENT" || /ENOENT|not found/i.test(err.message ?? "");
}

export async function resolveHiseBinaryFromCompilerSettings(
	command: string,
	platform: NodeJS.Platform,
): Promise<string | null> {
	if (command !== "HISE" && command !== "HISE Debug") return null;

	const xml = await readCompilerSettings(platform);
	if (!xml) return null;

	const hisePath = parseHisePath(xml);
	if (!hisePath) return null;

	for (const candidate of hiseBinaryCandidates(hisePath, command, platform)) {
		if (await isAccessible(candidate)) return candidate;
	}

	return null;
}

async function readCompilerSettings(platform: NodeJS.Platform): Promise<string | null> {
	try {
		return await readFile(compilerSettingsPath(platform), "utf8");
	} catch {
		return null;
	}
}

export function compilerSettingsPath(platform: NodeJS.Platform): string {
	if (platform === "darwin") {
		return join(homedir(), "Library", "Application Support", "HISE", "compilerSettings.xml");
	}
	if (platform === "linux") {
		return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "HISE", "compilerSettings.xml");
	}
	const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
	return join(appData, "HISE", "compilerSettings.xml");
}

export function parseHisePath(xml: string): string | null {
	const match = /<HisePath\s+value="([^"]*)"\s*\/?>/.exec(xml);
	if (!match || !match[1]) return null;
	const value = match[1].trim();
	return value.length > 0 ? value : null;
}

export function hiseBinaryCandidates(
	installPath: string,
	command: string,
	platform: NodeJS.Platform,
): string[] {
	const isDebug = command === "HISE Debug";
	// Projucer's HISE Standalone.jucer marks Minimal / Debug / DebugWithFaust
	// with isDebug — all three emit a "HISE Debug" binary. Probe in the order
	// users typically pick (DebugWithFaust > Debug > Minimal) so a freshly
	// built variant wins over an older sibling.
	const configs = isDebug
		? ["DebugWithFaust", "Debug", "Minimal"]
		: ["ReleaseWithFaust", "Release"];
	if (platform === "darwin") {
		const xcodeConfigs = isDebug ? ["Debug", "Minimal"] : ["Release", "ReleaseWithFaust", "CI", "Minimal"];
		const appName = isDebug ? "HISE Debug.app" : "HISE.app";
		const binaryName = isDebug ? "HISE Debug" : "HISE";
		return [
			...configs.map((config) => macOSAppBinaryPath(installPath, "MacOSXMakefile", config, appName, binaryName)),
			...xcodeConfigs.map((config) => macOSAppBinaryPath(installPath, "MacOSX", config, appName, binaryName)),
		];
	}
	if (platform === "linux") {
		return [posix.join(
			installPath,
			"projects",
			"standalone",
			"Builds",
			"LinuxMakefile",
			"build",
			"HISE Standalone",
		)];
	}
	const exeName = isDebug ? "HISE Debug.exe" : "HISE.exe";
	const vsVersions = ["2022", "2026"];
	return vsVersions.flatMap((vsVersion) => configs.map((config) => win32.join(
		installPath,
		"projects",
		"standalone",
		"Builds",
		`VisualStudio${vsVersion}`,
		"x64",
		config,
		"App",
		exeName,
	)));
}

function macOSAppBinaryPath(
	installPath: string,
	buildFolder: string,
	config: string,
	appName: string,
	binaryName: string,
): string {
	return posix.join(
		installPath,
		"projects",
		"standalone",
		"Builds",
		buildFolder,
		"build",
		config,
		appName,
		"Contents",
		"MacOS",
		binaryName,
	);
}

async function isAccessible(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

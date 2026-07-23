// ── JUCE project compile — shared across setup test + compile wizard ──
//
// Extracts the per-platform compile flow so the setup wizard's demo
// project test and the stand-alone compile wizard can share one
// implementation. Each platform has one primitive:
//
//   • Windows → Projucer resave → vswhere-resolved MSBuild on the .sln
//   • macOS   → make CONFIG=… -jN in Builds/MacOSXMakefile (CLT-only,
//               no xcodebuild). Assumes HISE's --prepare emits the
//               MACOSX_MAKE exporter.
//   • Linux   → run the generated batchCompileLinux.sh through bash.
//
// The HISE-generated `batchCompile.bat` on Windows still hardcodes the
// old VS 2026 Community MSBuild path, so we deliberately do NOT run it.
// Instead the caller supplies the .sln path (resolvable from the build
// output directory) and we drive MSBuild directly.

import type { PhaseExecutor } from "../../engine/wizard/phase-executor.js";
import { detectVsVersion, filterMsbuildLine, resolveMsbuildPath, stripPinnedToolsetVersions, type VsVersion } from "./setup-tasks.js";

/** Progress callback: a log line plus the transient flag from spawn. */
export type CompileEmit = (message: string, transient?: boolean) => void;

export interface WindowsCompileSpec {
	/** .jucer file to pass through Projucer --resave before building. */
	readonly jucerFile: string;
	/** Path to Projucer.exe (lives inside the HISE install). */
	readonly projucerPath: string;
	/** .sln to build with MSBuild. */
	readonly slnFile: string;
	/** MSBuild /p:Configuration value (e.g. "Release", "Release with Faust"). */
	readonly configuration: string;
	/** MSBuild /p:Platform value (e.g. "x64", "Win32", "ARM64"). Default "x64". */
	readonly msbuildPlatform?: string;
	/** Visual Studio major year — picks the Builds/VisualStudio<vsVersion> dir
	 *  that the toolset-pin stripper walks before MSBuild runs. Defaults to
	 *  "2022". */
	readonly vsVersion?: VsVersion;
	/**
	 * Root of the HISE install — used only to strip the path prefix on
	 * MSBuild diagnostic lines so they render compactly. Optional.
	 */
	readonly hiseInstallPath?: string;
	/** Extra env vars merged into the MSBuild spawn. */
	readonly extraEnv?: Record<string, string>;
}

export interface MacCompileSpec {
	/** Root of the HISE-generated project's Binaries/ folder. */
	readonly binaryFolder: string;
	/** Makefile CONFIG value (e.g. "Release", "Release with Faust"). */
	readonly configuration: string;
	/** .jucer file to pass through Projucer --resave before building.
	 *  Skips the resave step when omitted (e.g. freshly-generated .jucer). */
	readonly jucerFile?: string;
	/** Path to the Projucer binary (inside the HISE install). Required when
	 *  `jucerFile` is provided. */
	readonly projucerPath?: string;
	/** RAM-aware parallel job count. Defaults to 1 when omitted. */
	readonly parallelJobs?: number;
	/** Architecture override. "arm64"/"x86_64" force a single slice;
	 *  "universal" forces a fat x86_64+arm64 binary regardless of the
	 *  Makefile's default. Omit to inherit the Makefile's default. */
	readonly architecture?: "arm64" | "x86_64" | "universal";
}

export interface LinuxCompileSpec {
	/** batchCompileLinux.sh script path, emitted by HISE --prepare. */
	readonly buildScript: string;
	/** Working directory for the build script. */
	readonly buildDirectory: string;
}

export interface CompileOutcome {
	readonly success: boolean;
	readonly exitCode: number;
	readonly stderr: string;
}

/** Compile a JUCE-generated Windows solution. */
export async function runWindowsJuceCompile(
	executor: PhaseExecutor,
	spec: WindowsCompileSpec,
	emit: CompileEmit,
): Promise<CompileOutcome> {
	const resave = await executor.spawn(spec.projucerPath, ["--resave", spec.jucerFile], {
		onLog: (line, transient) => emit(line, transient),
	});
	if (resave.exitCode !== 0) {
		return { success: false, exitCode: resave.exitCode, stderr: `Projucer resave failed: ${resave.stderr}` };
	}

	const msbuild = await resolveMsbuildPath(executor);
	if (!msbuild) {
		return {
			success: false,
			exitCode: 1,
			stderr: "Could not locate a Visual Studio installation with MSBuild.",
		};
	}

	// Projucer's VS2022 exporter pins MSVC toolset 14.36.32532 in the
	// .vcxproj. Newer VS2022 installs (14.43+) don't ship that exact
	// subversion → MSB8070. Strip the pin so MSBuild picks the latest
	// installed toolset.
	const vsVersion = spec.vsVersion ?? "2026";
	const slnDir = spec.slnFile.replace(/\\[^\\]+\.sln$/i, "");
	await stripPinnedToolsetVersions(executor, slnDir);

	const env: Record<string, string> = {
		PreferredToolArchitecture: "x64",
		// MSBuild loads version-specific .targets keyed off this env var.
		// Mirror the user's installed VS major version so VS2022 MSBuild
		// doesn't try to load the VS2026 (18.0) targets.
		VisualStudioVersion: vsVersion === "2026" ? "18.0" : "17.0",
		// VSLANG=1033 (en-US LCID) forces MSBuild / cl.exe to emit English
		// diagnostics regardless of the OS UI locale so filterMsbuildLine
		// only has to parse one language.
		VSLANG: "1033",
		VSLANGCODE: "en-US",
		...spec.extraEnv,
	};

	const result = await executor.spawn(msbuild, [
		spec.slnFile,
		`/p:Configuration=${spec.configuration}`,
		`/p:Platform=${spec.msbuildPlatform ?? "x64"}`,
		"/verbosity:minimal",
	], {
		env,
		onLog: (line, transient) => {
			const filtered = filterMsbuildLine(line, spec.hiseInstallPath);
			if (filtered !== null) emit(filtered, transient);
		},
	});

	return { success: result.exitCode === 0, exitCode: result.exitCode, stderr: result.stderr };
}

export interface JuceCompileSpec {
	/** Project Binaries folder — root of the JUCE build output. */
	readonly binaryFolder: string;
	/** HISE install path — used to resolve Projucer binary on Windows. */
	readonly hisePath: string;
	/** .jucer file path — passed to Projucer --resave. */
	readonly jucerFile: string;
	/** Project name — baked into the Windows .sln filename. */
	readonly projectName: string;
	/** Build configuration name. Default "Release". On macOS / Windows the
	 *  human-readable form (e.g. "Release with Faust") maps straight onto
	 *  the Makefile CONFIG or MSBuild /p:Configuration value. */
	readonly configuration?: string;
	/** MSBuild /p:Platform value. Default "x64". */
	readonly msbuildPlatform?: string;
	/** RAM-aware parallel job count for Makefile builds (macOS/Linux). */
	readonly parallelJobs?: number;
	/** Architecture override for macOS. "arm64"/"x86_64" force a single
	 *  slice; "universal" forces a fat x86_64+arm64 binary. Omit to
	 *  inherit the Makefile's default. */
	readonly macArchitecture?: "arm64" | "x86_64" | "universal";
	/** Visual Studio major year — picks the Projucer exporter folder
	 *  on Windows. Defaults to "2026" (the year aka.ms/vs/stable installs). */
	readonly vsVersion?: VsVersion;
}

/**
 * Dispatches a JUCE-generated project build to the platform-specific compile
 * primitive. Callers supply the four fields HISE's wizard prepare step returns
 * (binaryFolder, hisePath, jucerFile, projectName); everything else is derived.
 */
export async function runJuceCompile(
	executor: PhaseExecutor,
	spec: JuceCompileSpec,
	emit: CompileEmit,
): Promise<CompileOutcome> {
	if (process.platform === "win32") {
		const vsVersion = spec.vsVersion ?? await detectVsVersion(executor) ?? "2026";
		const slnFile = `${spec.binaryFolder}\\Builds\\VisualStudio${vsVersion}\\${spec.projectName}.sln`;
		const projucerPath = `${spec.hisePath}\\JUCE\\Projucer\\Projucer.exe`;
		return runWindowsJuceCompile(executor, {
			jucerFile: spec.jucerFile,
			projucerPath,
			slnFile,
			configuration: spec.configuration ?? "Release",
			msbuildPlatform: spec.msbuildPlatform ?? "x64",
			vsVersion,
			hiseInstallPath: spec.hisePath,
		}, emit);
	}

	if (process.platform === "darwin") {
		return runMacJuceCompile(executor, {
			binaryFolder: spec.binaryFolder,
			configuration: spec.configuration ?? "Release",
			jucerFile: spec.jucerFile,
			projucerPath: `${spec.hisePath}/JUCE/Projucer/Projucer.app/Contents/MacOS/Projucer`,
			parallelJobs: spec.parallelJobs,
			architecture: spec.macArchitecture,
		}, emit);
	}

	return runLinuxJuceCompile(executor, {
		buildScript: `${spec.binaryFolder}/batchCompileLinux.sh`,
		buildDirectory: spec.binaryFolder,
	}, emit);
}

/** Compile a JUCE-generated macOS project via its Makefile exporter. */
export async function runMacJuceCompile(
	executor: PhaseExecutor,
	spec: MacCompileSpec,
	emit: CompileEmit,
): Promise<CompileOutcome> {
	const makefileDir = `${spec.binaryFolder}/Builds/MacOSXMakefile`;

	// Resave the .jucer through Projucer first. HISE's --prepare writes
	// the .jucer with <MACOSX_MAKE>, but the Makefile itself is only
	// emitted when Projucer resaves. Without this step, the Makefile
	// directory may not exist (ENOENT on cwd) or be stale.
	if (spec.jucerFile && spec.projucerPath) {
		const resave = await executor.spawn(spec.projucerPath, ["--resave", spec.jucerFile], {
			onLog: (line, transient) => emit(line, transient),
		});
		if (resave.exitCode !== 0) {
			return {
				success: false,
				exitCode: resave.exitCode,
				stderr: `Projucer resave failed: ${resave.stderr}`,
			};
		}
	}

	// After resave the Makefile should exist; otherwise the .jucer is
	// missing the <MACOSX_MAKE> exporter. Surface a clear error instead
	// of the cryptic `posix_spawn 'make'` ENOENT from a missing cwd.
	const check = await executor.spawn("test", ["-f", `${makefileDir}/Makefile`], {});
	if (check.exitCode !== 0) {
		return {
			success: false,
			exitCode: check.exitCode,
			stderr:
				`macOS Makefile not found at ${makefileDir}/Makefile. ` +
				`The project's .jucer needs the <MACOSX_MAKE> exporter — ` +
				`update your HISE install so project-export templates include it, ` +
				`then re-export and /resume.`,
		};
	}

	const jobs = Math.max(1, spec.parallelJobs ?? 1);
	const args = [`CONFIG=${spec.configuration}`, `-j${jobs}`];
	if (spec.architecture === "universal") {
		args.push("TARGET_ARCH=-arch x86_64 -arch arm64");
	} else if (spec.architecture) {
		args.push(`TARGET_ARCH=-arch ${spec.architecture}`);
	}
	const result = await executor.spawn("make", args, {
		cwd: makefileDir,
		env: {
			// JUCE_JOBS_CAPPED=1 suppresses the Makefile's auto -j so
			// our explicit -jN (RAM-aware) wins.
			JUCE_JOBS_CAPPED: "1",
			// Projucer's Makefile exporter uses `-rpath $(SRCROOT)/...`
			// for the Faust dylib path. SRCROOT is Xcode-only; without
			// this the linker bakes an absolute rpath starting with `/`
			// and the built binary crashes at launch.
			SRCROOT: makefileDir,
			// Strip the source-snippet + caret rendering from clang
			// diagnostics — keeps warning/error messages one line
			// each instead of 10+ lines of code context.
			CFLAGS: "-fno-caret-diagnostics",
			CXXFLAGS: "-fno-caret-diagnostics",
		},
		onLog: (line, transient) => emit(line, transient),
	});
	return { success: result.exitCode === 0, exitCode: result.exitCode, stderr: result.stderr };
}

/** Compile a JUCE-generated Linux project via its batchCompileLinux.sh script. */
export async function runLinuxJuceCompile(
	executor: PhaseExecutor,
	spec: LinuxCompileSpec,
	emit: CompileEmit,
): Promise<CompileOutcome> {
	const scriptCheck = await executor.spawn("test", ["-f", spec.buildScript], {});
	if (scriptCheck.exitCode !== 0) {
		return {
			success: false,
			exitCode: scriptCheck.exitCode,
			stderr: `Build script not found: ${spec.buildScript}`,
		};
	}
	const result = await executor.spawn("bash", [spec.buildScript], {
		cwd: spec.buildDirectory,
		onLog: (line, transient) => emit(line, transient),
	});
	return { success: result.exitCode === 0, exitCode: result.exitCode, stderr: result.stderr };
}

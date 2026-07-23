// ── Setup wizard task handlers — 8 phases of HISE installation ───────
//
// Each factory takes a PhaseExecutor and returns an InternalTaskHandler.
// Platform-specific commands derived from docs/LEGACY_SETUP_SCRIPTS.md.

import type { InternalTaskHandler } from "../../engine/wizard/handler-registry.js";
import type { PhaseExecutor } from "../../engine/wizard/phase-executor.js";
import type { WizardExecResult } from "../../engine/wizard/types.js";
import { isOn } from "../../engine/wizard/types.js";
import { runJuceCompile } from "./project-compile.js";
import { detectFaust, detectFftw, installAptPackages, runApt } from "./setup-linux.js";

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a spawn wrapper that injects signal into every call. */
function withSignal(
	executor: PhaseExecutor,
	signal?: AbortSignal,
): PhaseExecutor {
	if (!signal) return executor;
	return {
		supportsInteractive: executor.supportsInteractive,
		spawn: (cmd, args, opts) => executor.spawn(cmd, args, { ...opts, signal }),
	};
}

const LINUX_ARM_UNSUPPORTED =
	"Linux /setup currently supports x64 only. Linux ARM64 is not supported because " +
	"HISE ships an x86-64 Projucer and the full ARM64 toolchain is not validated.";

export function createSetupPlatformCheckHandler(): InternalTaskHandler {
	return async (answers, onProgress) => {
		if (answers.platform === "Linux" && answers.architecture !== "x64") {
			return fail(LINUX_ARM_UNSUPPORTED);
		}
		onProgress({ phase: "platform-check", percent: 100, message: "Platform supported." });
		return ok("✓ Platform supported.");
	};
}

function ok(message: string, logs?: string[]): WizardExecResult {
	return { success: true, message, logs };
}

function fail(message: string, logs?: string[]): WizardExecResult {
	return { success: false, message, logs };
}

/** Escape a string for a single-quoted PowerShell literal. */
function psQuote(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

/** Run a Windows installer that requires Administrator. PowerShell's
 *  Start-Process -Verb RunAs triggers UAC, so hise-cli can launch
 *  non-elevated and only the third-party installer needs elevation.
 *  Exit code is propagated back via -PassThru + exit. */
async function runElevatedInstaller(
	executor: PhaseExecutor,
	installer: string,
	args: string[],
	onLog: (line: string, transient?: boolean) => void,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const psArgList = args.map(psQuote).join(",");
	const psCmd = `$p = Start-Process -FilePath ${psQuote(installer)} -ArgumentList @(${psArgList}) -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
	return executor.spawn("powershell", [
		"-NoProfile",
		"-ExecutionPolicy", "Bypass",
		"-Command", psCmd,
	], { onLog });
}

/** True when macOS `xcode-select -p` resolves — invoking developer-tool
 *  stubs (git, clang) is safe and won't pop the CLT install dialog. */
async function hasDevDir(executor: PhaseExecutor): Promise<boolean> {
	const sel = await executor.spawn("xcode-select", ["-p"], {});
	return sel.exitCode === 0 && sel.stdout.trim().length > 0;
}

/** Detect noise lines from curl / winget that would otherwise flood the log
 *  4x/sec during multi-minute downloads. Keeps anything with real text,
 *  drops progress bars, spinner chars, and pure size/percentage tickers. */
function isProgressNoise(line: string): boolean {
	const t = line.trim();
	if (t === "") return true;
	// winget spinner: single /|\- char
	if (/^[/|\\\-]$/.test(t)) return true;
	// Progress bar: block shading + digits + percent + vertical bars only
	if (/^[█▒░▓│─\s\d%.]+$/.test(t)) return true;
	// curl's progress table rows: only digits, dashes, colons, slashes, %, k/M/G/B
	if (/^[\s\d:.\-%/kMGBbtoalD]+$/.test(t) && !/[a-z]{3,}/i.test(t)) return true;
	// Pure size readouts like "2.00 MB / 2.83 MB"
	if (/^[\s\d.]+(MB|KB|GB|B)\s*\/\s*[\d.]+\s*(MB|KB|GB|B)\s*$/i.test(t)) return true;
	return false;
}

// ── 1. Git install ───────────────────────────────────────────────────

export function createSetupGitInstallHandler(_executor: PhaseExecutor): InternalTaskHandler {
	return async (answers, onProgress, signal) => {
		const executor = withSignal(_executor, signal);
		const platform = answers.platform ?? "Linux";

		// Re-probe git — answers.hasGit is a snapshot from wizard init and
		// can be stale after /resume (e.g. Command Line Tools just landed
		// and now provide git, or winget installed git in a previous run).
		// On macOS, skip the probe when no developer dir is set — the
		// /usr/bin/git stub would pop the CLT install dialog.
		const canProbeGit = platform !== "macOS" || await hasDevDir(executor);
		if (canProbeGit) {
			const probe = await executor.spawn("git", ["--version"], {});
			if (probe.exitCode === 0) {
				onProgress({ phase: "git-install", percent: 100, message: "Git detected, skipping install." });
				return ok("✓ Git detected.");
			}
		}

		onProgress({ phase: "git-install", percent: 0, message: "Installing git..." });

		if (platform === "macOS") {
			// CLT provides git. If we get here, compilerInstall should have
			// already installed CLT. Hint the user at the resume flow.
			return fail("Git not found. Install Command Line Tools (xcode-select --install) then /resume.");
		}

		if (platform === "Linux") {
			const result = await installAptPackages(executor, ["git"], (line, transient) =>
				onProgress({ phase: "git-install", message: line, transient }));
			if (result.exitCode !== 0) return fail(`Git installation failed: ${result.stderr}`);
			return ok("✓ Git installed.");
		}

		// Windows — winget or direct download
		const winget = await executor.spawn("winget", ["install", "Git.Git", "--accept-package-agreements", "--accept-source-agreements"], {
			onLog: (line, transient) => onProgress({ phase: "git-install", message: line, transient }),
		});
		if (winget.exitCode === 0) {
			// winget updates the system PATH registry, but the current Node
			// process keeps its launch-time PATH. Prepend the default install
			// location so later phases (clone, submodule init) can find git.
			const gitDirs = ["C:\\Program Files\\Git\\cmd", "C:\\Program Files (x86)\\Git\\cmd"];
			const existing = process.env.PATH ?? "";
			const missing = gitDirs.filter((d) => !existing.toLowerCase().includes(d.toLowerCase()));
			if (missing.length > 0) process.env.PATH = `${missing.join(";")};${existing}`;
			return ok("✓ Git installed via winget.");
		}
		return fail("Git installation failed. Please install Git manually from https://git-scm.com");
	};
}

// ── 2. Clone repo ────────────────────────────────────────────────────

export function createSetupCloneRepoHandler(_executor: PhaseExecutor): InternalTaskHandler {
	return async (answers, onProgress, signal) => {
		const executor = withSignal(_executor, signal);
		const installPath = answers.installPath!;
		const targetCommit = answers.targetCommit?.trim() || "";

		onProgress({ phase: "clone-repo", percent: 0, message: "Cloning HISE repository..." });

		// Clone or fetch
		const gitCheck = await executor.spawn("git", ["-C", installPath, "status"], {});
		if (gitCheck.exitCode !== 0) {
			// Fresh clone
			const clone = await executor.spawn("git", ["clone", "https://github.com/christophhart/HISE.git", installPath], {
				onLog: (line, transient) => onProgress({ phase: "clone-repo", message: line, transient }),
			});
			if (clone.exitCode !== 0) return fail(`Git clone failed: ${clone.stderr}`);
		} else {
			// Existing repo — fetch
			onProgress({ phase: "clone-repo", message: "Repository exists, fetching updates..." });
			await executor.spawn("git", ["-C", installPath, "fetch", "origin"], {
				onLog: (line, transient) => onProgress({ phase: "clone-repo", message: line, transient }),
			});
		}

		// Checkout
		if (targetCommit) {
			const checkout = await executor.spawn("git", ["-C", installPath, "checkout", targetCommit], {});
			if (checkout.exitCode !== 0) return fail(`Checkout of ${targetCommit} failed: ${checkout.stderr}`);
		} else {
			await executor.spawn("git", ["-C", installPath, "checkout", "develop"], {});
			await executor.spawn("git", ["-C", installPath, "pull", "origin", "develop"], {
				onLog: (line, transient) => onProgress({ phase: "clone-repo", message: line, transient }),
			});
		}

		onProgress({ phase: "clone-repo", percent: 80, message: "Initialising submodules..." });

		// Submodules
		await executor.spawn("git", ["-C", installPath, "submodule", "update", "--init"], {
			onLog: (line, transient) => onProgress({ phase: "clone-repo", message: line, transient }),
		});

		// JUCE checkout
		const juceDir = `${installPath}/JUCE`;
		await executor.spawn("git", ["-C", juceDir, "checkout", "juce6"], {});

		onProgress({ phase: "clone-repo", percent: 100 });
		return ok("✓ Repository cloned and configured.");
	};
}

// ── 3. Build deps (Linux only) ───────────────────────────────────────

export function createSetupBuildDepsHandler(_executor: PhaseExecutor): InternalTaskHandler {
	return async (answers, onProgress, signal) => {
		const executor = withSignal(_executor, signal);
		if (answers.platform !== "Linux") {
			onProgress({ phase: "build-deps", percent: 100, message: "Skipping (not Linux)." });
			return ok("✓ Build dependencies not needed on this platform.");
		}

		onProgress({ phase: "build-deps", percent: 0, message: "Installing build dependencies..." });

		const onLog = (line: string, transient?: boolean) =>
			onProgress({ phase: "build-deps", message: line, transient });
		const update = await runApt(executor, ["update"], onLog);
		if (update.exitCode !== 0) return fail(`Dependency index update failed: ${update.stderr || update.stdout}`);

		const webkit40 = await executor.spawn("apt-cache", ["show", "libwebkit2gtk-4.0-dev"], {});
		const webkitPackage = webkit40.exitCode === 0
			? "libwebkit2gtk-4.0-dev"
			: "libwebkit2gtk-4.1-dev";
		const packages = [
			"build-essential", "make", "llvm", "clang",
			"libfreetype6-dev", "libx11-dev", "libxinerama-dev",
			"libxrandr-dev", "libxcursor-dev", "mesa-common-dev",
			"libasound2-dev", "freeglut3-dev", "libxcomposite-dev",
			"libcurl4-gnutls-dev", "libgtk-3-dev", "libjack-jackd2-dev",
			webkitPackage, "libpthread-stubs0-dev", "ladspa-sdk", "unzip",
		];

		const result = await runApt(executor, ["install", "-y", ...packages], onLog);

		if (result.exitCode !== 0) return fail(`Dependency installation failed: ${result.stderr}`);
		return ok("✓ Build dependencies installed.");
	};
}

// ── 4. Faust install ─────────────────────────────────────────────────

/** Pinned Faust release — bump when GRAME publishes a newer one. */
const FAUST_VERSION = "2.81.2";

export function createSetupFaustInstallHandler(_executor: PhaseExecutor): InternalTaskHandler {
	return async (answers, onProgress, signal) => {
		const executor = withSignal(_executor, signal);
		if (!isOn(answers.includeFaust)) {
			onProgress({ phase: "faust-install", percent: 100, message: "Faust not requested, skipping." });
			return ok("✓ Faust installation skipped.");
		}

		const platform = answers.platform ?? "Linux";
		const installPath = answers.installPath ?? "";

		// Re-probe faust so a stale hasFaust=0 (from init) doesn't trigger
		// a redundant install when the user manually installed between runs.
		if (await detectFaust(executor, platform, installPath)) {
			onProgress({ phase: "faust-install", percent: 100, message: "Faust detected, skipping install." });
			return ok("✓ Faust detected.");
		}

		onProgress({ phase: "faust-install", percent: 0, message: "Installing Faust..." });

		if (platform === "Linux") {
			const result = await installAptPackages(executor, ["faust"], (line, transient) =>
				onProgress({ phase: "faust-install", message: line, transient }));
			if (result.exitCode !== 0) {
				return fail(`Faust installation failed: ${result.stderr || result.stdout}`);
			}
			if (!(await detectFaust(executor, platform, installPath))) {
				return fail(
					"Faust was installed but is not usable by HISE. Version 2.54+ with headers, " +
					"architecture files, and libfaust.so is required.",
				);
			}
			return ok("✓ Faust installed.");
		}

		if (platform === "Windows") {
			const tmpDir = process.env.TEMP ?? "C:\\Windows\\Temp";
			const installer = `${tmpDir}\\faust-installer.exe`;
			const url = `https://github.com/grame-cncm/faust/releases/download/${FAUST_VERSION}/Faust-${FAUST_VERSION}-win64.exe`;

			onProgress({ phase: "faust-install", percent: 0, message: `Downloading Faust ${FAUST_VERSION}...` });
			const dl = await executor.spawn("curl", ["-L", "-o", installer, url], {
				onLog: (line, transient) => {
					if (!isProgressNoise(line)) onProgress({ phase: "faust-install", message: line, transient });
				},
			});
			if (dl.exitCode !== 0) return fail(`Faust download failed: ${dl.stderr}`);

			onProgress({ phase: "faust-install", percent: 50, message: "Installing Faust (approve the UAC prompt)..." });
			// NSIS installer needs admin (writes to Program Files); self-elevate
			// via Start-Process -Verb RunAs so hise-cli stays non-elevated.
			// /S = silent, /D=<path> = install dir.
			const inst = await runElevatedInstaller(
				executor,
				installer,
				["/S", "/D=C:\\Program Files\\Faust"],
				(line, transient) => onProgress({ phase: "faust-install", message: line, transient }),
			);
			if (inst.exitCode !== 0) return fail(`Faust install failed: ${inst.stderr}`);

			// Inject bin dir into this Node process's PATH so any downstream
			// phase that calls `faust` resolves it without a terminal restart.
			const faustBin = "C:\\Program Files\\Faust\\bin";
			const existing = process.env.PATH ?? "";
			if (!existing.toLowerCase().includes(faustBin.toLowerCase())) {
				process.env.PATH = `${existing.replace(/;$/, "")};${faustBin}`;
			}
			onProgress({ phase: "faust-install", percent: 100 });
			return ok("✓ Faust installed.");
		}

		// macOS — download the architecture-specific DMG, mount it, copy
		// bin/lib/include/share into tools/faust/, unmount. Preserves the
		// existing fakelib/ stub. See HISE/tools/faust/Readme.md.
		const arch = answers.architecture === "x64" ? "x64" : "arm64";
		const tmpDir = process.env.TMPDIR ?? "/tmp";
		const dmgPath = `${tmpDir}/Faust-${FAUST_VERSION}-${arch}.dmg`;
		const url = `https://github.com/grame-cncm/faust/releases/download/${FAUST_VERSION}/Faust-${FAUST_VERSION}-${arch}.dmg`;

		onProgress({ phase: "faust-install", percent: 0, message: `Downloading Faust ${FAUST_VERSION} (${arch})...` });
		const dl = await executor.spawn("curl", ["-L", "-o", dmgPath, url], {
			onLog: (line, transient) => {
				if (!isProgressNoise(line)) onProgress({ phase: "faust-install", message: line, transient });
			},
		});
		if (dl.exitCode !== 0) return fail(`Faust download failed: ${dl.stderr}`);

		onProgress({ phase: "faust-install", percent: 50, message: "Mounting Faust DMG..." });
		// Force a known mount point (/tmp/hise-faust-mnt). Avoids parsing
		// hdiutil's tab-delimited stdout, which `-quiet` would suppress.
		const mountPoint = `${tmpDir}/hise-faust-mnt`;
		// Pre-cleanup any stale mount from a prior failed run.
		await executor.spawn("hdiutil", ["detach", "-force", mountPoint], {});
		const mount = await executor.spawn("hdiutil", [
			"attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmgPath,
		], {});
		if (mount.exitCode !== 0) return fail(`DMG mount failed: ${mount.stderr || mount.stdout}`);

		// DMG layout: /Volumes/Faust-<VERSION>/Faust-<VERSION>/{bin,lib,include,share}
		// (versioned subfolder alongside INSTALL.html / README.html at root).
		// Defensive check — if GRAME ever flattens or switches to a .pkg,
		// fail loudly rather than silently leaving tools/faust incomplete.
		const srcRoot = `${mountPoint}/Faust-${FAUST_VERSION}`;
		const check = await executor.spawn("bash", ["-c",
			`test -d "${srcRoot}/bin" && test -d "${srcRoot}/lib" && test -d "${srcRoot}/include" && test -d "${srcRoot}/share"`,
		], {});
		if (check.exitCode !== 0) {
			await executor.spawn("hdiutil", ["detach", "-force", mountPoint], {});
			return fail(
				`Faust DMG doesn't contain the expected Faust-${FAUST_VERSION}/bin,lib,include,share layout. ` +
				"The release format may have changed; install manually from https://faust.grame.fr/downloads/.",
			);
		}

		onProgress({ phase: "faust-install", percent: 75, message: `Copying into ${installPath}/tools/faust/...` });
		const destDir = `${installPath}/tools/faust`;
		// `ditto` mirrors src → dst (overwrites cleanly, preserves xattrs);
		// cp -R would nest dirs when the target already exists.
		const copy = await executor.spawn("bash", ["-c",
			`mkdir -p "${destDir}" && ` +
			`ditto "${srcRoot}/bin" "${destDir}/bin" && ` +
			`ditto "${srcRoot}/lib" "${destDir}/lib" && ` +
			`ditto "${srcRoot}/include" "${destDir}/include" && ` +
			`ditto "${srcRoot}/share" "${destDir}/share"`,
		], {
			onLog: (line, transient) => onProgress({ phase: "faust-install", message: line, transient }),
		});

		// Always detach, regardless of copy outcome.
		await executor.spawn("hdiutil", ["detach", "-force", mountPoint], {});

		if (copy.exitCode !== 0) return fail(`Faust copy failed: ${copy.stderr}`);

		onProgress({ phase: "faust-install", percent: 100 });
		return ok(
			`✓ Faust installed at ${destDir}. ` +
			`If the build complains about unsigned Faust libs on first run, allow them via ` +
			`System Settings → Privacy & Security.`,
		);
	};
}

export function createSetupFftwInstallHandler(_executor: PhaseExecutor): InternalTaskHandler {
	return async (answers, onProgress, signal) => {
		const executor = withSignal(_executor, signal);
		const platform = answers.platform ?? "Linux";
		if (platform !== "Linux" || !isOn(answers.includeFftw)) {
			onProgress({ phase: "fftw-install", percent: 100, message: "FFTW not requested, skipping." });
			return ok("✓ FFTW installation skipped.");
		}

		if (await detectFftw(executor, platform)) {
			onProgress({ phase: "fftw-install", percent: 100, message: "FFTW detected, skipping install." });
			return ok("✓ FFTW detected.");
		}

		onProgress({ phase: "fftw-install", percent: 0, message: "Installing FFTW..." });
		const result = await installAptPackages(executor, ["libfftw3-dev"], (line, transient) =>
			onProgress({ phase: "fftw-install", message: line, transient }));
		if (result.exitCode !== 0) {
			return fail(`FFTW installation failed: ${result.stderr || result.stdout}`);
		}
		if (!(await detectFftw(executor, platform))) {
			return fail("FFTW was installed but pkg-config cannot resolve the required fftw3f library.");
		}

		onProgress({ phase: "fftw-install", percent: 100 });
		return ok("✓ FFTW installed.");
	};
}

// ── 4b. Adapt the .jucer file to the installed VS version ───────────
//
// HISE's upstream .jucer ships only a <VS2026> exporter targeting
// Builds/VisualStudio2026. When the user has VS2022 installed we rewrite
// the exporter to <VS2022 targetFolder="Builds/VisualStudio2022" …> and
// flip HISE_USE_VS2022=0 → 1 in extraDefs (HISE C++ has compile-time
// branches keyed off this define). Idempotent — re-running on /resume is
// a no-op once the file is already VS2022.

/** Mutate a .jucer file's VS exporter element + targetFolder + the
 *  HISE_USE_VS2022 define so Projucer emits a solution for `target`.
 *  Returns the new content, or null when no change is needed. */
export function adaptJucerToVsVersion(content: string, target: VsVersion): string | null {
	const otherTag = target === "2022" ? "VS2026" : "VS2022";
	const otherFolder = target === "2022" ? "VisualStudio2026" : "VisualStudio2022";
	const targetTag = `VS${target}`;
	const targetFolder = `VisualStudio${target}`;
	if (!content.includes(`<${otherTag} `) && !content.includes(`Builds/${otherFolder}`)) {
		return null;
	}
	let next = content;
	next = next.replace(new RegExp(`<${otherTag}\\b`, "g"), `<${targetTag}`);
	next = next.replace(new RegExp(`</${otherTag}>`, "g"), `</${targetTag}>`);
	next = next.replace(new RegExp(`Builds/${otherFolder}`, "g"), `Builds/${targetFolder}`);
	const useVs2022 = target === "2022" ? "1" : "0";
	next = next.replace(/HISE_USE_VS2022=[01]/g, `HISE_USE_VS2022=${useVs2022}`);
	return next === content ? null : next;
}

export function createSetupAdaptVsVersionHandler(_executor: PhaseExecutor): InternalTaskHandler {
	return async (answers, onProgress, signal) => {
		const executor = withSignal(_executor, signal);
		const platform = answers.platform ?? "Linux";
		if (platform !== "Windows") {
			onProgress({ phase: "adapt-vs", percent: 100, message: "Skipping (not Windows)." });
			return ok("✓ VS exporter adaptation not needed.");
		}

		// Re-probe — compilerInstall may have just installed a different VS
		// major year than the init snapshot saw (aka.ms/vs/stable currently
		// ships VS2026 BuildTools, but a clean VM had no VS at init time).
		// Mutate answers so downstream tasks (setupCompile, verify) see the
		// post-install version.
		const probed = await detectVsVersion(executor);
		if (!probed) {
			return fail(
				"No Visual Studio installation found via vswhere after compilerInstall. " +
				"Cannot adapt the Projucer file without knowing the installed VS major year. " +
				"Verify the VS Build Tools install completed (re-run /setup or install manually).",
			);
		}
		if (probed !== answers.vsVersion) {
			onProgress({
				phase: "adapt-vs",
				message: `Detected VS ${probed} (init had ${answers.vsVersion ?? "none"}); updating answers.`,
			});
			answers.vsVersion = probed;
		}

		const installPath = answers.installPath!;
		const vsVersion = normaliseVsVersion(answers.vsVersion);
		const jucerPath = `${installPath}\\projects\\standalone\\HISE Standalone.jucer`;

		onProgress({ phase: "adapt-vs", percent: 0, message: `Adapting Projucer file for VS ${vsVersion}...` });

		const read = await executor.spawn("powershell", [
			"-NoProfile",
			"-ExecutionPolicy", "Bypass",
			"-Command",
			`Get-Content -Raw -LiteralPath '${jucerPath.replace(/'/g, "''")}'`,
		], {});
		if (read.exitCode !== 0) return fail(`Could not read .jucer file: ${read.stderr || read.stdout}`);

		const next = adaptJucerToVsVersion(read.stdout, vsVersion);
		if (next === null) {
			onProgress({ phase: "adapt-vs", percent: 100, message: `Already targeting VS ${vsVersion}.` });
			return ok(`✓ .jucer already targets VS ${vsVersion}.`);
		}

		// Pass the new content through a base64-encoded env var so we don't
		// have to quote-escape the multi-kB XML body into a PowerShell
		// command line. WriteAllBytes writes the decoded UTF-8 bytes
		// verbatim — no extra encoding conversion in PowerShell.
		const write = await executor.spawn("powershell", [
			"-NoProfile",
			"-ExecutionPolicy", "Bypass",
			"-Command",
			`[IO.File]::WriteAllBytes('${jucerPath.replace(/'/g, "''")}', [Convert]::FromBase64String($env:HISE_JUCER_B64))`,
		], { env: { HISE_JUCER_B64: Buffer.from(next, "utf8").toString("base64") } });
		if (write.exitCode !== 0) return fail(`Could not write .jucer file: ${write.stderr || write.stdout}`);

		onProgress({ phase: "adapt-vs", percent: 100 });
		return ok(`✓ .jucer rewritten for VS ${vsVersion}.`);
	};
}

// ── 5. Extract SDKs ─────────────────────────────────────────────────

export function createSetupExtractSdksHandler(_executor: PhaseExecutor): InternalTaskHandler {
	return async (answers, onProgress, signal) => {
		const executor = withSignal(_executor, signal);
		const installPath = answers.installPath!;
		const platform = answers.platform ?? "Linux";
		const sep = platform === "Windows" ? "\\" : "/";
		const sdkDir = `${installPath}${sep}tools${sep}SDK`;
		const marker = `${sdkDir}${sep}ASIOSDK2.3`;

		onProgress({ phase: "extract-sdks", percent: 0, message: "Extracting SDK files..." });

		const exists = platform === "Windows"
			? (await executor.spawn("cmd", ["/c", `if exist "${marker}" echo found`], {})).stdout.includes("found")
			: (await executor.spawn("test", ["-d", marker], {})).exitCode === 0;
		if (exists) {
			onProgress({ phase: "extract-sdks", percent: 100, message: "SDKs already extracted." });
			return ok("✓ SDKs already extracted.");
		}

		// Windows: PowerShell Expand-Archive avoids the GNU-tar-shadows-bsdtar
		// case (Git for Windows / MSYS put a GNU tar earlier on PATH, which
		// fails with "This does not look like a tar archive" on .zip input).
		// macOS bsdtar handles zip transparently; Linux gets unzip from the
		// build-dependencies task.
		const result = platform === "Windows"
			? await executor.spawn("powershell", [
				"-NoProfile",
				"-ExecutionPolicy", "Bypass",
				"-Command",
				`Expand-Archive -Path "${sdkDir}\\sdk.zip" -DestinationPath "${sdkDir}" -Force`,
			], {
				onLog: (line, transient) => onProgress({ phase: "extract-sdks", message: line, transient }),
			})
			: platform === "Linux"
				? await executor.spawn("unzip", ["-o", "sdk.zip"], { cwd: sdkDir })
				: await executor.spawn("tar", ["-xf", "sdk.zip"], { cwd: sdkDir });
		if (result.exitCode !== 0) return fail(`SDK extraction failed: ${result.stderr || result.stdout}`);

		onProgress({ phase: "extract-sdks", percent: 100 });
		return ok("✓ SDKs extracted.");
	};
}

// ── MSBuild / cl.exe output filter ───────────────────────────────────
//
// Collapses the verbose MSBuild diagnostic format:
//   <abs_path>(line,col): warning C1234: "message" [<project.vcxproj>]
// into a compact two-line form:
//   ⚠ warning C1234: "message"
//      <rel_path> (line,col)
// Errors get a ✗ prefix. installPath (when provided) is stripped from
// the absolute path so the rendered location is relative to the HISE
// repo root. Localised compiler chatter lines like "(Quelldatei ... wird
// kompiliert)" and the English "(Compiling source file ...)" are dropped.
// Every other line is returned unchanged so build summary / progress
// messages still render (dimmed via the default path in app.tsx).

const MSBUILD_DIAG_RE = /^(.+?)\((\d+)(?:,(\d+))?\):\s+(warning|error)\s+([A-Z]+\d+):\s+(.+?)(?:\s*\[[^\]]+\])?\s*$/;

export function filterMsbuildLine(line: string, installPath?: string): string | null {
	// Drop localised "source file being compiled" follow-ups (German + English).
	if (/^\s*\(Quelldatei\s/.test(line)) return null;
	if (/^\s*\(Compiling source file/i.test(line)) return null;

	const m = line.match(MSBUILD_DIAG_RE);
	if (!m) return line;

	const absPath = m[1]!;
	const ln = m[2]!;
	const col = m[3] ?? "";
	const severity = m[4]!;
	const code = m[5]!;
	const msg = m[6]!;

	let rel = absPath;
	if (installPath) {
		const prefix = installPath.toLowerCase().replace(/[\\\/]+$/, "");
		if (absPath.toLowerCase().startsWith(prefix)) {
			rel = absPath.slice(prefix.length).replace(/^[\\\/]+/, "");
		}
	}
	rel = rel.replace(/\\/g, "/");

	const marker = severity === "error" ? "✗" : "⚠";
	const loc = col ? `${rel} (${ln},${col})` : `${rel} (${ln})`;
	return `${marker} ${severity} ${code}: ${msg}\n   ${loc}`;
}

// ── 5b. Compiler toolkit install (platform-dispatching) ──────────────
//
// Windows: downloads the `vs_BuildTools.exe` bootstrapper and runs an
// unattended install with the minimum component set HISE needs (MSVC
// v14x x64/x86, Windows 11 SDK, en-US language pack for English
// diagnostics).
// macOS:   probes `clang --version` (CLT-provided). If missing, spawns
// `xcode-select --install` which pops a system install dialog, then
// fails the phase with a `/resume` hint — the existing pause/resume
// infra handles the wait rather than polling here.
// Linux:   no-op. Toolchain is installed by the buildDeps task.

const VS_BUILD_TOOLS_URL = "https://aka.ms/vs/stable/vs_BuildTools.exe";

export function createSetupCompilerInstallHandler(_executor: PhaseExecutor): InternalTaskHandler {
	return async (answers, onProgress, signal) => {
		const executor = withSignal(_executor, signal);
		const platform = answers.platform ?? "Linux";

		if (platform === "macOS") {
			onProgress({ phase: "compiler-install", percent: 0, message: "Checking Command Line Tools..." });

			// Gate probe — xcode-select -p doesn't pop the CLT install
			// dialog. Only invoke `clang` once we know the dev dir is set.
			const sel = await executor.spawn("xcode-select", ["-p"], {});
			const devDir = sel.exitCode === 0 ? sel.stdout.trim() : "";
			if (devDir) {
				const clangCheck = await executor.spawn("test", ["-x", `${devDir}/usr/bin/clang`], {});
				if (clangCheck.exitCode === 0) {
					onProgress({ phase: "compiler-install", percent: 100 });
					return ok("✓ Command Line Tools detected.");
				}
			}

			onProgress({ phase: "compiler-install", message: "Launching Command Line Tools installer..." });
			const trigger = await executor.spawn("xcode-select", ["--install"], {});
			// Exit codes: 0 = dialog shown, 1 = already installed/triggered.
			// Either way the user needs to drive the install to completion.

			// Bring the CLT installer window to the front — it opens behind
			// the terminal by default. Fire-and-forget; ignore failures.
			await executor.spawn("osascript", [
				"-e",
				'tell application "System Events" to set frontmost of every process whose name contains "Install Command Line Developer Tools" to true',
			], {});

			const lines = [
				"Command Line Tools installer launched. A system dialog should appear now.",
				"",
				"  1. Click 'Install' in the dialog.",
				"  2. Wait for the download to complete (~5–10 min).",
				"  3. Type /resume to continue the wizard.",
			];
			if (trigger.exitCode !== 0 && !trigger.stderr.includes("already installed")) {
				lines.push("", `(xcode-select exit ${trigger.exitCode}: ${trigger.stderr.trim() || "no detail"})`);
			}
			return fail(lines.join("\n"));
		}

		if (platform === "Linux") {
			onProgress({ phase: "compiler-install", percent: 100, message: "Skipping (handled by buildDeps)." });
			return ok("✓ Compiler toolkit installed by buildDeps phase.");
		}

		// Windows — re-probe via vswhere (answers.hasVs is the stale init
		// snapshot; would be wrong on /resume after a manual VS install).
		const vsProbe = await executor.spawn(
			"C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe",
			[
				"-latest",
				"-products", "*",
				"-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
				"-property", "displayName",
			],
			{},
		);
		if (vsProbe.exitCode === 0 && vsProbe.stdout.trim()) {
			onProgress({ phase: "compiler-install", percent: 100, message: "Visual Studio detected, skipping install." });
			return ok("✓ Visual Studio detected.");
		}

		const tmpDir = process.env.TEMP ?? "C:\\Windows\\Temp";
		const installer = `${tmpDir}\\vs_BuildTools.exe`;

		onProgress({ phase: "compiler-install", percent: 0, message: "Downloading VS Build Tools bootstrapper..." });
		const download = await executor.spawn("curl", ["-L", "-o", installer, VS_BUILD_TOOLS_URL], {
			onLog: (line, transient) => {
				if (!isProgressNoise(line)) onProgress({ phase: "compiler-install", message: line, transient });
			},
		});
		if (download.exitCode !== 0) return fail(`VS Build Tools download failed: ${download.stderr}`);

		onProgress({ phase: "compiler-install", percent: 40, message: "Installing VS Build Tools (approve the UAC prompt; install can take 5–10 minutes)..." });
		// vs_BuildTools.exe needs admin; self-elevate via Start-Process -Verb
		// RunAs so hise-cli stays non-elevated.
		const install = await runElevatedInstaller(
			executor,
			installer,
			[
				"--passive", "--wait", "--norestart", "--nocache",
				"--add", "Microsoft.VisualStudio.Workload.VCTools",
				"--add", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
				"--add", "Microsoft.VisualStudio.Component.Windows11SDK.26100",
				"--addProductLang", "en-US",
			],
			(line, transient) => onProgress({ phase: "compiler-install", message: line, transient }),
		);
		// 3010 = installed OK, reboot requested (suppressed via --norestart).
		if (install.exitCode !== 0 && install.exitCode !== 3010) {
			return fail(`VS Build Tools install failed (exit ${install.exitCode}): ${install.stderr || install.stdout}`);
		}
		onProgress({ phase: "compiler-install", percent: 100 });
		return ok("✓ Visual Studio Build Tools installed.");
	};
}

// ── 5c. Intel IPP install (Windows only) ─────────────────────────────

const IPP_INSTALLER_URL =
	"https://registrationcenter-download.intel.com/akdlm/IRC_NAS/9c651894-4548-491c-b69f-49e84b530c1d/intel-ipp-2022.3.1.10_offline.exe";

export function createSetupIppInstallHandler(_executor: PhaseExecutor): InternalTaskHandler {
	return async (answers, onProgress, signal) => {
		const executor = withSignal(_executor, signal);
		const platform = answers.platform ?? "Linux";

		if (platform !== "Windows" || !isOn(answers.includeIpp)) {
			onProgress({ phase: "ipp-install", percent: 100, message: "Skipping Intel IPP." });
			return ok("✓ Intel IPP installation skipped.");
		}

		// Re-probe; a stale answers.hasIpp=0 (from init) would otherwise
		// redo an ~800 MB install that was completed between runs.
		const ippProbe = await executor.spawn(
			"cmd",
			["/c", "if exist \"C:\\Program Files (x86)\\Intel\\oneAPI\\ipp\\latest\" echo found"],
			{},
		);
		if (ippProbe.stdout.includes("found")) {
			onProgress({ phase: "ipp-install", percent: 100, message: "Intel IPP detected, skipping install." });
			return ok("✓ Intel IPP detected.");
		}

		onProgress({ phase: "ipp-install", percent: 0, message: "Downloading Intel IPP (~800 MB)..." });

		const tmpDir = process.env.TEMP ?? process.env.TMP ?? "C:\\Windows\\Temp";
		const installer = `${tmpDir}\\intel-ipp-installer.exe`;
		const download = await executor.spawn(
			"curl",
			["-L", "-o", installer, IPP_INSTALLER_URL],
			{ onLog: (line, transient) => {
				if (!isProgressNoise(line)) onProgress({ phase: "ipp-install", message: line, transient });
			} },
		);
		if (download.exitCode !== 0) return fail(`Intel IPP download failed: ${download.stderr}`);

		onProgress({ phase: "ipp-install", percent: 50, message: "Installing Intel IPP (approve the UAC prompt)..." });

		const install = await runElevatedInstaller(
			executor,
			installer,
			["-s", "-a", "--silent", "--eula", "accept"],
			(line, transient) => onProgress({ phase: "ipp-install", message: line, transient }),
		);
		if (install.exitCode !== 0) return fail(`Intel IPP installation failed: ${install.stderr || install.stdout}`);

		onProgress({ phase: "ipp-install", percent: 100 });
		return ok("✓ Intel IPP installed.");
	};
}

// ── 6. Compile ───────────────────────────────────────────────────────

/** Spec passed to compileHise — shared between setup and update wizards. */
export interface CompileHiseSpec {
	readonly installPath: string;
	readonly platform: string;
	readonly architecture?: string;
	readonly includeFaust: boolean;
	readonly parallelJobs: number;
	/** Visual Studio major year — picks the Projucer exporter folder
	 *  (Builds/VisualStudio2022 vs VisualStudio2026). Required on Windows;
	 *  ignored on macOS / Linux. Defaults to "2022" — matches what
	 *  aka.ms/vs/stable/vs_BuildTools.exe installs today. */
	readonly vsVersion?: VsVersion;
	/** Phase tag used in progress events. Defaults to "compile". */
	readonly phase?: string;
	/** Clean build outputs before compiling. Used by the update wizard to
	 *  avoid make's "nothing to be done for all" after a checkout: Projucer
	 *  may regenerate the Makefile with a slightly renamed CONFIG (e.g. the
	 *  intermediate dir switches case), orphaning the `.d` dependency files
	 *  so make fails to detect source changes. */
	readonly clean?: boolean;
	/** Explicit build configuration. Overrides the includeFaust-derived
	 *  default of Release/ReleaseWithFaust. Accepts any CONFIG value the
	 *  Projucer-generated Makefile / .sln knows about (Minimal, Debug,
	 *  DebugWithFaust, Release, ReleaseWithFaust). */
	readonly buildConfiguration?: string;
}

/** Known build configurations exposed by HISE's Projucer project. */
export type BuildConfiguration = "Minimal" | "Debug" | "DebugWithFaust" | "Release" | "ReleaseWithFaust";

const BUILD_CONFIGURATIONS: readonly BuildConfiguration[] = [
	"Minimal", "Debug", "DebugWithFaust", "Release", "ReleaseWithFaust",
];

/** Coerce a free-form answers value to a known BuildConfiguration. Falls
 *  back to includeFaust-derived Release/ReleaseWithFaust when the input is
 *  empty or unrecognised, matching the wizard's pre-config-field behaviour. */
export function normaliseBuildConfiguration(
	raw: string | undefined,
	includeFaust: boolean,
): BuildConfiguration {
	if (raw && (BUILD_CONFIGURATIONS as readonly string[]).includes(raw)) {
		return raw as BuildConfiguration;
	}
	return includeFaust ? "ReleaseWithFaust" : "Release";
}

/** True when the configuration produces a "HISE Debug" binary rather than
 *  the standard "HISE". Minimal counts as a debug build — Projucer's
 *  HISE Standalone.jucer marks Minimal/Debug/DebugWithFaust with the
 *  `isDebug` flag, all three emit `HISE Debug.exe` / `HISE Debug.app`. */
export function isDebugBuildConfiguration(config: string): boolean {
	return config === "Debug" || config === "DebugWithFaust" || config === "Minimal";
}

/**
 * Compile HISE from its standalone JUCE project — Projucer resave followed by
 * per-platform make / MSBuild. Returns a WizardExecResult so it can be used as
 * a task body directly. Shared by `setup` (first-time build) and `update`
 * (rebuild after pulling a new SHA).
 */
export async function compileHise(
	executor: PhaseExecutor,
	spec: CompileHiseSpec,
	onProgress: (p: import("../../engine/wizard/types.js").WizardProgress) => void,
): Promise<WizardExecResult> {
	const { installPath, platform, architecture, includeFaust, parallelJobs } = spec;
	if (platform === "Linux" && architecture === "arm64") return fail(LINUX_ARM_UNSUPPORTED);
	const phase = spec.phase ?? "compile";

	// Build config: explicit spec value if supplied, otherwise the legacy
	// includeFaust-derived Release/ReleaseWithFaust default. Same string
	// drives both the POSIX Makefile CONFIG= variable and Windows MSBuild
	// /p:Configuration — Projucer generates matching target names for all
	// of Minimal / Debug / DebugWithFaust / Release / ReleaseWithFaust.
	const buildConfig = normaliseBuildConfiguration(spec.buildConfiguration, includeFaust);

	onProgress({ phase, percent: 0, message: "Running Projucer resave..." });

	// Projucer resave
	let jucerFile: string;
	let projucerPath: string;
	if (platform === "macOS") {
		jucerFile = `${installPath}/projects/standalone/HISE Standalone.jucer`;
		projucerPath = `${installPath}/JUCE/Projucer/Projucer.app/Contents/MacOS/Projucer`;
	} else if (platform === "Linux") {
		jucerFile = `${installPath}/projects/standalone/HISE Standalone.jucer`;
		const candidates = [
			`${installPath}/JUCE/Projucer/Projucer`,
			`${installPath}/JUCE/projucer/Projucer`,
		];
		projucerPath = "";
		for (const candidate of candidates) {
			const check = await executor.spawn("test", ["-x", candidate], {});
			if (check.exitCode === 0) {
				projucerPath = candidate;
				break;
			}
		}
		if (!projucerPath) {
			return fail(`Projucer not found. Checked: ${candidates.join(", ")}`);
		}
	} else {
		jucerFile = `${installPath}\\projects\\standalone\\HISE Standalone.jucer`;
		projucerPath = `${installPath}\\JUCE\\Projucer\\Projucer.exe`;
	}

	const resave = await executor.spawn(projucerPath, ["--resave", jucerFile], {
		onLog: (line, transient) => onProgress({ phase, message: line, transient }),
	});
	if (resave.exitCode !== 0) return fail(`Projucer resave failed: ${resave.stderr}`);

	// Optional clean before build. Required by the update wizard because
	// Projucer regenerates the Makefile with a slightly different CONFIG
	// dir capitalization (e.g. ReleasewithFaust → ReleaseWithFaust), which
	// orphans the stale .d files and leaves make thinking nothing changed.
	if (spec.clean) {
		onProgress({ phase, percent: 5, message: "Cleaning previous build..." });
		if (platform === "macOS") {
			const makeDir = `${installPath}/projects/standalone/Builds/MacOSXMakefile`;
			await executor.spawn("make", [`CONFIG=${buildConfig}`, "clean"], {
				cwd: makeDir,
				onLog: (line, transient) => onProgress({ phase, message: line, transient }),
			});
		} else if (platform === "Linux") {
			const makeDir = `${installPath}/projects/standalone/Builds/LinuxMakefile`;
			await executor.spawn("make", [`CONFIG=${buildConfig}`, "clean"], {
				cwd: makeDir,
				onLog: (line, transient) => onProgress({ phase, message: line, transient }),
			});
		}
		// Windows MSBuild clean is folded into the build step via /t:Rebuild
		// below — no separate clean pass needed.
	}

	onProgress({ phase, percent: 10, message: `Compiling (${buildConfig})...` });

	// Platform-specific build
	const jobs = Math.max(1, parallelJobs);
	if (platform === "macOS") {
		const makeDir = `${installPath}/projects/standalone/Builds/MacOSXMakefile`;
		// Build a single-slice binary matching the detected architecture
		// (halves compile time vs the Makefile's default x86_64+arm64
		// universal binary). Override via the Architecture field.
		const archFlag = architecture === "x64" ? "x86_64" : "arm64";
		const result = await executor.spawn("make", [
			`CONFIG=${buildConfig}`,
			`-j${jobs}`,
			`TARGET_ARCH=-arch ${archFlag}`,
		], {
			cwd: makeDir,
			env: {
				// JUCE_JOBS_CAPPED=1 suppresses the Makefile's auto -j so
				// our explicit -jN (RAM-aware) wins.
				JUCE_JOBS_CAPPED: "1",
				// SRCROOT is an Xcode-only variable but Projucer's
				// Makefile exporter bakes `-rpath $(SRCROOT)/../../../../tools/faust/lib`
				// into the link. Without this, the linker writes an
				// absolute rpath starting with `/` and HISE crashes at
				// launch with "Library not loaded: libfaust.2.dylib".
				SRCROOT: makeDir,
				// Strip the source-snippet + caret rendering from clang
				// diagnostics — keeps warning/error messages one line
				// each instead of 10+ lines of code context.
				CFLAGS: "-fno-caret-diagnostics",
				CXXFLAGS: "-fno-caret-diagnostics",
			},
			onLog: (line, transient) => onProgress({ phase, message: line, transient }),
		});
		if (result.exitCode !== 0) return fail(`Compilation failed: ${result.stderr}`);
	} else if (platform === "Linux") {
		const makeDir = `${installPath}/projects/standalone/Builds/LinuxMakefile`;
		const result = await executor.spawn("make", [`CONFIG=${buildConfig}`, "AR=gcc-ar", `-j${jobs}`], {
			cwd: makeDir,
			onLog: (line, transient) => onProgress({ phase, message: line, transient }),
		});
		if (result.exitCode !== 0) return fail(`Compilation failed: ${result.stderr}`);
	} else {
		const msbuild = await resolveMsbuildPath(executor);
		if (!msbuild) {
			return fail("Could not locate a Visual Studio installation with MSBuild. Re-run the setup wizard.");
		}
		const vsVersion = spec.vsVersion ?? "2026";
		const buildsRoot = `${installPath}\\projects\\standalone\\Builds\\VisualStudio${vsVersion}`;
		const sln = `${buildsRoot}\\HISE Standalone.sln`;
		const config = buildConfig;

		// Projucer's VS2022 exporter pins MSVC toolset 14.36.32532 in the
		// .vcxproj. Newer VS2022 installs (14.43+) don't ship that exact
		// subversion → MSB8070. Strip the pin so MSBuild picks the latest
		// installed toolset.
		await stripPinnedToolsetVersions(executor, buildsRoot);

		const msbuildArgs = [
			sln,
			`/p:Configuration=${config}`,
			"/p:Platform=x64",
			"/verbosity:minimal",
		];
		// /t:Rebuild forces clean + build, handling the same stale-dep-file
		// case as `make clean` on POSIX platforms.
		if (spec.clean) msbuildArgs.push("/t:Rebuild");
		const result = await executor.spawn(msbuild, msbuildArgs, {
			// VSLANG=1033 (en-US LCID) forces MSBuild / cl.exe / link.exe
			// to emit English diagnostics regardless of the OS UI locale,
			// so filterMsbuildLine's regex only needs to parse one language.
			env: {
				PreferredToolArchitecture: "x64",
				VSLANG: "1033",
				VSLANGCODE: "en-US",
			},
			onLog: (line, transient) => {
				const filtered = filterMsbuildLine(line, installPath);
				if (filtered !== null) onProgress({ phase, message: filtered, transient });
			},
		});
		if (result.exitCode !== 0) return fail(`Compilation failed: ${result.stderr}`);
	}

	onProgress({ phase, percent: 100, message: "Compilation complete." });
	return ok("✓ HISE compiled successfully.");
}

export function createSetupCompileHandler(_executor: PhaseExecutor): InternalTaskHandler {
	return async (answers, onProgress, signal) => {
		const executor = withSignal(_executor, signal);
		return compileHise(executor, {
			installPath: answers.installPath!,
			platform: answers.platform ?? "Linux",
			architecture: answers.architecture,
			includeFaust: isOn(answers.includeFaust),
			parallelJobs: Math.max(1, parseInt(answers.parallelJobs ?? "1", 10) || 1),
			vsVersion: normaliseVsVersion(answers.vsVersion),
		}, onProgress);
	};
}

/** Coerce a free-form answers value to a known VsVersion, defaulting to
 *  "2026" (the year aka.ms/vs/stable currently installs). Centralises the
 *  fallback so every consumer agrees on the same default. */
export function normaliseVsVersion(raw: string | undefined): VsVersion {
	return raw === "2022" ? "2022" : "2026";
}

// ── 7. Add to PATH ───────────────────────────────────────────────────

/** Directory that contains the HISE binary for a given install + config.
 *  Shared by setupAddPath (setup wizard) and the update wizard's realign
 *  step, which needs to prepend the new build's dir if the existing PATH
 *  still points at a stale config (e.g. Release vs ReleaseWithFaust).
 *  `vsVersion` selects the Projucer exporter dir on Windows (2022 vs 2026);
 *  ignored elsewhere. */
export function hiseBinDir(
	installPath: string,
	platform: string,
	includeFaust: boolean,
	vsVersion: VsVersion = "2022",
): string {
	if (platform === "Windows") {
		const config = includeFaust ? "ReleaseWithFaust" : "Release";
		return `${installPath}\\projects\\standalone\\Builds\\VisualStudio${vsVersion}\\x64\\${config}\\App`;
	}
	if (platform === "macOS") {
		const cfg = includeFaust ? "ReleaseWithFaust" : "Release";
		return `${installPath}/projects/standalone/Builds/MacOSXMakefile/build/${cfg}`;
	}
	return `${installPath}/projects/standalone/Builds/LinuxMakefile/build`;
}

/** Absolute path of the built HISE binary. On macOS the .app bundle holds
 *  the real binary; we target it directly so verify/test invocations bypass
 *  LaunchServices and get a real exit code + stdout. */
export function hiseBinaryPath(
	installPath: string,
	platform: string,
	includeFaust: boolean,
	vsVersion: VsVersion = "2022",
): string {
	const binDir = hiseBinDir(installPath, platform, includeFaust, vsVersion);
	if (platform === "Windows") return `${binDir}\\HISE.exe`;
	if (platform === "macOS") return `${binDir}/HISE.app/Contents/MacOS/HISE`;
	return `${binDir}/HISE Standalone`;
}

/** Strip pinned MSVC toolset versions from every .vcxproj under `buildsDir`.
 *  Projucer's VS2022 exporter bakes a specific subversion (e.g. 14.36.32532)
 *  into the .vcxproj. Users on a newer VS2022 install (with 14.43+) hit
 *  MSB8070 because that exact toolset isn't on disk. Removing the pin makes
 *  MSBuild fall back to the default (latest installed) toolset.
 *  No-op on non-Windows (the helper only runs in the Windows branch). */
export async function stripPinnedToolsetVersions(
	executor: PhaseExecutor,
	buildsDir: string,
): Promise<void> {
	const escaped = buildsDir.replace(/'/g, "''");
	await executor.spawn("powershell", [
		"-NoProfile",
		"-ExecutionPolicy", "Bypass",
		"-Command",
		`if (Test-Path -LiteralPath '${escaped}') { ` +
		`Get-ChildItem -Path '${escaped}' -Filter *.vcxproj -Recurse -ErrorAction SilentlyContinue | ForEach-Object { ` +
		`$c = [IO.File]::ReadAllText($_.FullName); ` +
		`$n = $c -replace '<VCToolsVersion>[^<]*</VCToolsVersion>', '' -replace '<PlatformToolsetVersion>[^<]*</PlatformToolsetVersion>', ''; ` +
		`if ($n -ne $c) { [IO.File]::WriteAllText($_.FullName, $n, (New-Object Text.UTF8Encoding $false)) } ` +
		`} }`,
	], {});
}

/** Resolve the MSBuild.exe path via vswhere so BuildTools / Community /
 *  Pro / Enterprise installs all work. Returns null if not found.
 *  Uses vswhere's `-find` mode (the Microsoft-recommended idiom) — the
 *  earlier `-requires Microsoft.Component.MSBuild` approach failed on some
 *  VS2022 installs that don't expose that exact component ID. */
export async function resolveMsbuildPath(executor: PhaseExecutor): Promise<string | null> {
	const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
	const vs = await executor.spawn(vswhere, [
		"-latest",
		"-products", "*",
		"-find", "MSBuild\\**\\Bin\\MSBuild.exe",
	], {});
	if (vs.exitCode !== 0) return null;
	const first = vs.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)[0];
	return first ?? null;
}

/** Detected Visual Studio major year, used to pick the matching Projucer
 *  exporter folder ("Builds/VisualStudio2022" vs "VisualStudio2026") and
 *  the value written to compilerSettings.xml's <VisualStudioVersion>. */
export type VsVersion = "2022" | "2026";

/** Detect the installed Visual Studio major-year via vswhere. Returns null
 *  when no VS install is found (compilerInstall will then install VS Build
 *  Tools, after which a re-probe in the adaptVsVersion task fills it in). */
export async function detectVsVersion(executor: PhaseExecutor): Promise<VsVersion | null> {
	const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
	// catalog_productLineVersion returns the year string ("2022", "2026").
	// Older vswhere builds may not expose it — fall back to installationVersion
	// (17.x → 2022, 18.x → 2026).
	const yearProbe = await executor.spawn(vswhere, [
		"-latest",
		"-products", "*",
		"-property", "catalog_productLineVersion",
	], {});
	const year = yearProbe.stdout.trim();
	if (year === "2022" || year === "2026") return year;
	const verProbe = await executor.spawn(vswhere, [
		"-latest",
		"-products", "*",
		"-property", "installationVersion",
	], {});
	const major = parseInt(verProbe.stdout.trim().split(".")[0] ?? "", 10);
	if (major === 17) return "2022";
	if (major === 18) return "2026";
	return null;
}

// ── 8. Verify ────────────────────────────────────────────────────────

export function createSetupVerifyHandler(_executor: PhaseExecutor): InternalTaskHandler {
	return async (answers, onProgress, signal) => {
		const executor = withSignal(_executor, signal);
		const installPath = answers.installPath!;
		const platform = answers.platform ?? "Linux";
		const includeFaust = isOn(answers.includeFaust);
		const includeIpp = isOn(answers.includeIpp);
		const vsVersion = normaliseVsVersion(answers.vsVersion);

		onProgress({ phase: "verify", percent: 0, message: "Verifying HISE binary..." });

		// Invoke the freshly built binary by absolute path. compilerSettings.xml
		// hasn't been written yet, so the launcher's PATH-fallback can't help —
		// we own the path through hiseBinaryPath. After set_hise_settings runs,
		// the launcher's compilerSettings lookup takes over for all later flows.
		const binary = hiseBinaryPath(installPath, platform, includeFaust, vsVersion);
		const flags = await executor.spawn(binary, ["get_build_flags"], {
			onLog: (line, transient) => onProgress({ phase: "verify", message: line, transient }),
		});
		if (flags.exitCode !== 0) {
			return fail(`HISE not found at expected path: ${binary}`);
		}
		const logs = flags.stdout.trim() ? [flags.stdout.trim()] : undefined;

		// Persist HISE compiler settings via HISE's own CLI — it writes
		// compilerSettings.xml canonically through JUCE's ValueTree::createXml
		// (see hise-source/projects/standalone/Source/Main.cpp:1316). Plugin
		// export depends on this file existing with HisePath set; before this
		// step the user had to launch HISE once and configure it manually.
		onProgress({ phase: "verify", percent: 50, message: "Writing HISE compiler settings..." });
		const settingsArgs = ["set_hise_settings", `-hisepath:${installPath}`];
		if (platform === "Windows") settingsArgs.push(`-vs:${vsVersion}`);
		if (includeIpp) settingsArgs.push("-ipp:1");
		if (includeFaust) {
			const faustPath = faustInstallPath(platform, installPath);
			if (faustPath) settingsArgs.push(`-faustpath:${faustPath}`);
		}
		const settings = await executor.spawn(binary, settingsArgs, {
			onLog: (line, transient) => onProgress({ phase: "verify", message: line, transient }),
		});
		if (settings.exitCode !== 0) {
			return fail(
				`HISE set_hise_settings failed: ${settings.stderr || settings.stdout}. ` +
				`compilerSettings.xml could not be written — plugin exports won't work until this is resolved.`,
			);
		}

		onProgress({ phase: "verify", percent: 100, message: "HISE verified successfully." });
		return ok("✓ HISE binary verified.", logs);
	};
}

/** Resolve the directory where Faust is installed for a given platform. */
function faustInstallPath(platform: string, installPath: string): string | null {
	if (platform === "Windows") return "C:\\Program Files\\Faust";
	if (platform === "macOS") return `${installPath}/tools/faust`;
	if (platform === "Linux") return "/usr";
	return null;
}

// ── 9. Test export ───────────────────────────────────────────────────

export function createSetupTestHandler(_executor: PhaseExecutor): InternalTaskHandler {
	return async (answers, onProgress, signal) => {
		const executor = withSignal(_executor, signal);
		const installPath = answers.installPath!;
		const platform = answers.platform ?? "Linux";
		const arch = answers.architecture ?? "x64";
		const includeFaust = isOn(answers.includeFaust);
		const vsVersion = normaliseVsVersion(answers.vsVersion);
		const hise = hiseBinaryPath(installPath, platform, includeFaust, vsVersion);
		const demoProject = `${installPath}/extras/demo_project`;

		onProgress({ phase: "test", percent: 0, message: "Setting project folder..." });

		const setFolder = await executor.spawn(hise, [
			"set_project_folder", `-p:${demoProject}`,
		], {
			onLog: (line, transient) => onProgress({ phase: "test", message: line, transient }),
		});
		if (setFolder.exitCode !== 0) return fail(`set_project_folder failed: ${setFolder.stderr}`);

		onProgress({ phase: "test", percent: 20, message: "Exporting demo project..." });

		const exportCi = await executor.spawn(hise, [
			"export_ci", "XmlPresetBackups/Demo.xml",
			"-t:standalone", `-a:${arch}`, "-nolto",
		], {
			cwd: demoProject,
			onLog: (line, transient) => onProgress({ phase: "test", message: line, transient }),
		});
		if (exportCi.exitCode !== 0) return fail(`export_ci failed: ${exportCi.stderr}`);

		onProgress({ phase: "test", percent: 50, message: "Compiling demo project..." });

		const emit = (message: string, transient?: boolean) =>
			onProgress({ phase: "test", message, transient });

		const binaryFolder = platform === "Windows"
			? `${demoProject}\\Binaries`
			: `${demoProject}/Binaries`;
		const jucerFile = platform === "Windows"
			? `${demoProject}\\Binaries\\AutogeneratedProject.jucer`
			: `${demoProject}/Binaries/AutogeneratedProject.jucer`;

		const parallelJobs = Math.max(1, parseInt(answers.parallelJobs ?? "1", 10) || 1);
		const macArchitecture = answers.architecture === "x64" ? "x86_64" : "arm64";
		const compile = await runJuceCompile(executor, {
			binaryFolder,
			hisePath: installPath,
			jucerFile,
			projectName: "Demo Project",
			configuration: "Release",
			parallelJobs,
			macArchitecture,
			vsVersion,
		}, emit);

		if (!compile.success) return fail(`Demo project compilation failed: ${compile.stderr}`);

		onProgress({ phase: "test", percent: 100 });
		return ok("✓ Demo project exported and compiled successfully.");
	};
}

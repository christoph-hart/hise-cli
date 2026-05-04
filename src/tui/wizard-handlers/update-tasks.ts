// ── Update wizard task handlers ──────────────────────────────────────
//
// Five sequential phases: shutdown (optional) → checkout → compile (optional)
// → launch (optional) → verify. Each optional task short-circuits to success
// when its toggle is off, so a user untoggling "Compile HISE" still advances
// the wizard cleanly without skipping a task index.

import type { HiseConnection } from "../../engine/hise.js";
import { isEnvelopeResponse } from "../../engine/hise.js";
import type { HiseLauncher } from "../../engine/modes/hise.js";
import type { InternalTaskHandler } from "../../engine/wizard/handler-registry.js";
import type { PhaseExecutor } from "../../engine/wizard/phase-executor.js";
import type { WizardExecResult } from "../../engine/wizard/types.js";
import { isOn } from "../../engine/wizard/types.js";
import { extractStatusPayload } from "../../engine/modes/inspect.js";
import { compileHise, isDebugBuildConfiguration, normaliseBuildConfiguration, normaliseVsVersion } from "./setup-tasks.js";

export interface UpdateHandlerDeps {
	readonly executor: PhaseExecutor;
	readonly connection: HiseConnection;
	readonly launcher: HiseLauncher;
}

function ok(message: string, logs?: string[]): WizardExecResult {
	return { success: true, message, logs };
}

function fail(message: string, logs?: string[]): WizardExecResult {
	return { success: false, message, logs };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function withSignal(executor: PhaseExecutor, signal?: AbortSignal): PhaseExecutor {
	if (!signal) return executor;
	return {
		spawn: (cmd, args, opts) => executor.spawn(cmd, args, { ...opts, signal }),
	};
}

/** Strip CSI escape sequences from a string. Belt-and-braces defence
 *  alongside `-c color.ui=never`: some git builds (or GIT_* env overrides
 *  the user has set) still emit ANSI, and an unclosed bg sequence in a
 *  progress line leaks color across rows in the output viewport. */
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(s: string): string {
	return s.replace(ANSI_CSI_RE, "");
}

/** Wrap a git invocation so it (a) never emits color, (b) runs non-interactive,
 *  and (c) has ANSI stripped from any stray output before it reaches the
 *  progress stream. */
async function gitSpawn(
	executor: PhaseExecutor,
	cwd: string,
	args: string[],
	onProgress: (message: string, transient?: boolean) => void,
): Promise<ReturnType<PhaseExecutor["spawn"]>> {
	return executor.spawn("git", ["-c", "color.ui=never", "-C", cwd, ...args], {
		env: {
			GIT_TERMINAL_PROMPT: "0",
			// Some git builds still force color on `tput`-capable terminals.
			// NO_COLOR is the universal kill-switch.
			NO_COLOR: "1",
		},
		onLog: (line, transient) => onProgress(stripAnsi(line), transient),
	});
}

// ── 1. Shutdown ──────────────────────────────────────────────────────

export function createUpdateShutdownHandler(deps: UpdateHandlerDeps): InternalTaskHandler {
	return async (answers, onProgress) => {
		if (!isOn(answers.shutdownHise)) {
			onProgress({ phase: "shutdown", percent: 100, message: "Skipped (HISE not running)." });
			return ok("HISE shutdown skipped.");
		}

		onProgress({ phase: "shutdown", percent: 0, message: "Requesting HISE shutdown..." });

		try {
			await deps.connection.post("/api/shutdown", {});
		} catch {
			// Connection dropped mid-shutdown is expected — fall through to probe loop.
		}

		// Poll probe() until HISE is unreachable (500ms × 20 = 10s budget).
		for (let i = 0; i < 20; i++) {
			await delay(500);
			const alive = await deps.connection.probe();
			if (!alive) {
				onProgress({ phase: "shutdown", percent: 100, message: "HISE shut down." });
				return ok("✓ HISE shut down.");
			}
		}
		return fail("HISE did not shut down within 10 seconds.");
	};
}

// ── 2. Checkout ──────────────────────────────────────────────────────

export function createUpdateCheckoutHandler(deps: UpdateHandlerDeps): InternalTaskHandler {
	return async (answers, onProgress, signal) => {
		if (!isOn(answers.pullUpdate)) {
			onProgress({ phase: "checkout", percent: 100, message: "Skipped (pullUpdate off)." });
			return ok("Checkout skipped — recompiling current working tree.");
		}

		const executor = withSignal(deps.executor, signal);
		const installPath = answers.installPath;
		if (!installPath) return fail("Install path is empty — cannot check out.");

		const target = (answers.targetCommit?.trim() || answers.latestSha?.trim() || "").trim();
		if (!target) {
			return fail("No target commit supplied (set targetCommit or retry when GitHub is reachable).");
		}

		const emit = (message: string, transient?: boolean): void => {
			onProgress({ phase: "checkout", message, transient });
		};

		// Gated by the `cleanBuilds` toggle: discard working-tree modifications
		// before switching SHAs. Projucer's --resave from earlier runs edits
		// JuceLibraryCode/*.cpp and can retouch *.jucer; carrying those into
		// the new tree pollutes the checkout and confuses make's dependency
		// tracking. Users who keep local edits should leave cleanBuilds off.
		if (isOn(answers.cleanBuilds)) {
			onProgress({ phase: "checkout", percent: 0, message: "Discarding working-tree edits..." });
			const reset = await gitSpawn(executor, installPath, ["checkout", "--", "."], emit);
			if (reset.exitCode !== 0) return fail(`git checkout -- . failed: ${stripAnsi(reset.stderr)}`);
		}

		onProgress({ phase: "checkout", percent: 15, message: "Fetching origin..." });
		const fetch = await gitSpawn(executor, installPath, ["fetch", "origin"], emit);
		if (fetch.exitCode !== 0) return fail(`git fetch failed: ${stripAnsi(fetch.stderr)}`);

		onProgress({ phase: "checkout", percent: 40, message: `Checking out ${target.slice(0, 7)}...` });
		const checkout = await gitSpawn(executor, installPath, ["checkout", target], emit);
		if (checkout.exitCode !== 0) return fail(`git checkout ${target} failed: ${stripAnsi(checkout.stderr)}`);

		onProgress({ phase: "checkout", percent: 70, message: "Updating submodules..." });
		const submodule = await gitSpawn(executor, installPath, ["submodule", "update", "--init"], emit);
		if (submodule.exitCode !== 0) return fail(`git submodule update failed: ${stripAnsi(submodule.stderr)}`);

		// JUCE submodule is pinned to the `juce6` branch in HISE.
		const juceDir = `${installPath}/JUCE`;
		await gitSpawn(executor, juceDir, ["checkout", "juce6"], emit);

		onProgress({ phase: "checkout", percent: 100 });
		return ok(`✓ Checked out ${target.slice(0, 7)}.`);
	};
}

// ── 2b. Clean Builds folder ──────────────────────────────────────────
//
// Wipes `<installPath>/projects/standalone/Builds` so the next compile is a
// fresh-from-scratch build. Fixes two classes of incremental-build bugs:
// (1) Projucer regenerating the Makefile with a different CONFIG dir case
//     (ReleasewithFaust → ReleaseWithFaust) orphaning .d files and letting
//     make report "nothing to be done for all".
// (2) Stale intermediate objects surviving across SHAs with header changes
//     Projucer didn't propagate.
// Skipped when the `cleanBuilds` toggle is off (user opted into incremental).

export function createUpdateCleanBuildsHandler(deps: UpdateHandlerDeps): InternalTaskHandler {
	return async (answers, onProgress, signal) => {
		if (!isOn(answers.cleanBuilds)) {
			onProgress({ phase: "clean-builds", percent: 100, message: "Skipped." });
			return ok("Clean Builds skipped.");
		}

		const executor = withSignal(deps.executor, signal);
		const installPath = answers.installPath;
		if (!installPath) return fail("Install path is empty — cannot locate Builds folder.");
		const platform = answers.platform ?? "Linux";

		const buildsDir = platform === "Windows"
			? `${installPath}\\projects\\standalone\\Builds`
			: `${installPath}/projects/standalone/Builds`;

		onProgress({ phase: "clean-builds", percent: 0, message: `Wiping ${buildsDir}...` });

		// Platform wipe. Non-fatal if the folder already doesn't exist —
		// `rm -rf` is happy with missing paths, and PowerShell's -ErrorAction
		// SilentlyContinue keeps Remove-Item quiet in that case.
		const result = platform === "Windows"
			? await executor.spawn("powershell", [
				"-NoProfile",
				"-ExecutionPolicy", "Bypass",
				"-Command",
				`Remove-Item -LiteralPath '${buildsDir.replace(/'/g, "''")}' -Recurse -Force -ErrorAction SilentlyContinue`,
			], {})
			: await executor.spawn("rm", ["-rf", buildsDir], {});

		if (result.exitCode !== 0) return fail(`Failed to wipe ${buildsDir}: ${result.stderr}`);
		onProgress({ phase: "clean-builds", percent: 100 });
		return ok(`✓ Wiped ${buildsDir}.`);
	};
}

// ── 3. Compile ───────────────────────────────────────────────────────

export function createUpdateCompileHandler(deps: UpdateHandlerDeps): InternalTaskHandler {
	return async (answers, onProgress, signal) => {
		if (!isOn(answers.compileHise)) {
			onProgress({ phase: "compile", percent: 100, message: "Skipped." });
			return ok("Compile skipped.");
		}
		const executor = withSignal(deps.executor, signal);
		const buildConfiguration = normaliseBuildConfiguration(
			answers.buildConfiguration,
			isOn(answers.includeFaust),
		);
		return compileHise(executor, {
			installPath: answers.installPath!,
			platform: answers.platform ?? "Linux",
			architecture: answers.architecture,
			includeFaust: isOn(answers.includeFaust),
			parallelJobs: Math.max(1, parseInt(answers.parallelJobs ?? "1", 10) || 1),
			vsVersion: normaliseVsVersion(answers.vsVersion),
			buildConfiguration,
			// No `clean: true` here — when the cleanBuilds toggle is on the
			// previous task wiped the entire Builds folder; when it's off the
			// user explicitly asked for an incremental build, and running
			// `make clean` would defeat that choice.
		}, onProgress);
	};
}

// ── 4. Launch ────────────────────────────────────────────────────────

export function createUpdateLaunchHandler(deps: UpdateHandlerDeps): InternalTaskHandler {
	return async (answers, onProgress) => {
		if (!isOn(answers.launchHise)) {
			onProgress({ phase: "launch", percent: 100, message: "Skipped." });
			return ok("Launch skipped.");
		}

		// Debug / DebugWithFaust produce a "HISE Debug" binary (separate
		// .app bundle on macOS, separate exe under x64\Debug\App on Windows).
		// Pick the matching launcher name so we don't accidentally launch a
		// stale Release build sitting alongside it.
		const buildConfiguration = normaliseBuildConfiguration(
			answers.buildConfiguration,
			isOn(answers.includeFaust),
		);
		const launchCommand = isDebugBuildConfiguration(buildConfiguration) ? "HISE Debug" : "HISE";

		onProgress({ phase: "launch", percent: 0, message: `Launching ${launchCommand}...` });
		try {
			await deps.launcher.spawnDetached(launchCommand, ["start_server"]);
		} catch (err) {
			return fail(`Failed to launch HISE: ${err instanceof Error ? err.message : String(err)}`);
		}

		// Poll /api/status until HISE responds (10s total, 500ms interval).
		for (let i = 0; i < 20; i++) {
			await delay(500);
			if (await deps.connection.probe()) {
				onProgress({ phase: "launch", percent: 100, message: "HISE online." });
				return ok("✓ HISE launched.");
			}
		}
		return fail("HISE launched but did not respond within 10 seconds.");
	};
}

// ── 5. Verify ────────────────────────────────────────────────────────

export function createUpdateVerifyHandler(deps: UpdateHandlerDeps): InternalTaskHandler {
	return async (answers, onProgress) => {
		// Verify only makes sense when we actually relaunched HISE.
		if (!isOn(answers.launchHise)) {
			onProgress({ phase: "verify", percent: 100, message: "Skipped (launch was off)." });
			return ok("Verify skipped.");
		}

		// When the user opted out of pulling we just rebuilt the working tree
		// in place, so the expected SHA is whatever was checked out before
		// the run (currentSha from update-detect), not the target.
		const expected = isOn(answers.pullUpdate)
			? (answers.targetCommit?.trim() || answers.latestSha?.trim() || "").trim()
			: (answers.currentSha?.trim() || "").trim();
		if (!expected) {
			return fail("No commit to verify against.");
		}

		onProgress({ phase: "verify", percent: 50, message: "Querying /api/status..." });
		const response = await deps.connection.get("/api/status");
		if (!isEnvelopeResponse(response) || !response.success) {
			return fail("Could not read /api/status after launch.");
		}

		let actual: string | undefined;
		try {
			const payload = extractStatusPayload(response as unknown as Record<string, unknown>);
			actual = payload.server.buildCommit;
		} catch (err) {
			return fail(`Failed to parse status payload: ${err instanceof Error ? err.message : String(err)}`);
		}

		if (!actual) {
			return fail("HISE status response missing server.buildCommit — build may pre-date the field.");
		}

		// Accept exact match or prefix match either direction (short vs full SHA).
		if (actual === expected || actual.startsWith(expected) || expected.startsWith(actual)) {
			onProgress({ phase: "verify", percent: 100 });
			return ok(`✓ Running ${actual.slice(0, 7)}.`);
		}

		return fail(`Build SHA mismatch: expected ${expected.slice(0, 7)}, got ${actual.slice(0, 7)}.`);
	};
}

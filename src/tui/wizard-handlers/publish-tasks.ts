// ── Publish wizard task handlers ────────────────────────────────────
//
// Pipeline that turns staged binaries into a signed, optionally
// notarized installer. Each task early-returns ok("(skipped)") when its
// toggle is off or the platform doesn't apply, so the YAML stays
// linear.
//
// AAX wraptool signing (publishEnsureAaxKeyfile / publishSignAax) is
// still stubbed pending PR5. Until then AAX bundles in the payload get
// codesigned (on macOS) and bundled into the installer, but PACE wrap
// is skipped — the resulting AAX won't load in ProTools without the
// follow-up wraptool step.

import { mkdir, rm, copyFile, cp, stat } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { isAbsolutePath, isExplicitRelative } from "../../engine/session.js";
import type { InternalTaskHandler } from "../../engine/wizard/handler-registry.js";
import type { PhaseExecutor } from "../../engine/wizard/phase-executor.js";
import type {
	WizardAnswers,
	WizardExecResult,
} from "../../engine/wizard/types.js";
import { isOn } from "../../engine/wizard/types.js";
import {
	parsePayloadList,
	type PayloadTarget,
} from "../../engine/modes/publish-parse.js";
import {
	detectNotaryProfile,
	NOTARIZE_SETUP_INSTRUCTIONS,
} from "./publish-detect.js";

// ── Helpers ──────────────────────────────────────────────────────────

function ok(message: string, logs?: string[]): WizardExecResult {
	return { success: true, message, logs };
}

function fail(message: string, logs?: string[]): WizardExecResult {
	return { success: false, message, logs };
}

function skipped(reason: string): WizardExecResult {
	return ok(`(skipped — ${reason})`);
}

function detectPlatform(): "macOS" | "Windows" | "Linux" {
	if (process.platform === "win32") return "Windows";
	if (process.platform === "darwin") return "macOS";
	return "Linux";
}

function getProjectFolder(answers: WizardAnswers): string | null {
	const folder = answers.projectFolder;
	return folder && folder.length > 0 ? folder : null;
}

function getPayloadTargets(answers: WizardAnswers): PayloadTarget[] {
	const raw = answers.payload ?? "";
	const parsed = parsePayloadList(raw);
	return parsed.ok ? parsed.targets : [];
}

function sourcePathFor(
	answers: WizardAnswers,
	target: PayloadTarget,
): string | null {
	switch (target) {
		case "VST3":
			return answers.vst3Path ?? null;
		case "AU":
			return answers.auPath ?? null;
		case "AAX":
			return answers.aaxPath ?? null;
		case "Standalone":
			return answers.standalonePath ?? null;
	}
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

// ── Task: publishAssertReady ─────────────────────────────────────────

export function createAssertReadyHandler(): InternalTaskHandler {
	return async (answers, _onProgress, _signal, _context) => {
		const projectFolder = getProjectFolder(answers);
		if (!projectFolder) {
			return fail(
				"No project folder available. The init handler should have populated this — re-run the wizard.",
			);
		}
		if (!(answers.version && answers.version.length > 0)) {
			return fail("Project version missing — check project_info.xml.");
		}
		const targets = getPayloadTargets(answers);
		if (targets.length === 0) {
			return fail(
				`Payload list is empty or invalid. Got "${answers.payload ?? ""}". ` +
					`Allowed: VST3, AU, AAX, Standalone.`,
			);
		}

		const missing: string[] = [];
		for (const target of targets) {
			const src = sourcePathFor(answers, target);
			if (!src || !(await pathExists(src))) {
				missing.push(target);
			}
		}
		if (missing.length > 0) {
			return fail(
				`Selected targets are missing on disk: ${missing.join(", ")}. ` +
					`Run \`/project export project --default\` to produce them.`,
			);
		}

		const stagingDir = join(projectFolder, "dist", "payload");
		const outputDir = join(projectFolder, "dist");

		// Forward staging context for downstream tasks via the data return.
		return {
			success: true,
			message: `Validated payload (${targets.join(", ")}) at version ${answers.version}.`,
			data: {
				stagingDir,
				outputDir,
				payloadCsv: targets.join(","),
			},
		};
	};
}

// ── Task: publishStagePayload ────────────────────────────────────────

export function createStagePayloadHandler(): InternalTaskHandler {
	return async (answers, onProgress, _signal, context) => {
		const stagingDir = context?.stagingDir;
		const outputDir = context?.outputDir;
		if (!stagingDir || !outputDir) {
			return fail("Missing stagingDir/outputDir in context — assertReady must run first.");
		}
		const targets = getPayloadTargets(answers);
		if (targets.length === 0) {
			return fail("Empty payload list at staging step.");
		}

		await rm(stagingDir, { recursive: true, force: true });
		await mkdir(stagingDir, { recursive: true });
		await mkdir(outputDir, { recursive: true });

		const stagedData: Record<string, string> = {};
		const logs: string[] = [];

		for (const target of targets) {
			const src = sourcePathFor(answers, target);
			if (!src) {
				return fail(`Source path for ${target} disappeared between assert and stage.`);
			}
			const destName = basename(src);
			const dest = join(stagingDir, destName);
			onProgress({ phase: "stage", message: `Staging ${target}: ${destName}` });
			try {
				const srcStat = await stat(src);
				if (srcStat.isDirectory()) {
					await cp(src, dest, { recursive: true });
				} else {
					await copyFile(src, dest);
				}
				logs.push(`✓ ${target}: ${destName}`);
				switch (target) {
					case "VST3":
						stagedData.stagedVst3 = dest;
						break;
					case "AU":
						stagedData.stagedAu = dest;
						break;
					case "AAX":
						stagedData.stagedAax = dest;
						break;
					case "Standalone":
						stagedData.stagedStandalone = dest;
						break;
				}
			} catch (err) {
				return fail(`Failed to stage ${target} (${src}): ${String(err)}`, logs);
			}
		}

		return {
			success: true,
			message: `Staged ${targets.length} target(s) into ${stagingDir}.`,
			logs,
			data: stagedData,
		};
	};
}

// ── Task: publishSignBinaries ────────────────────────────────────────

// DigiCert root timestamp service — the de-facto safe pick for
// Authenticode timestamping. Hardcoded for v1; revisit if a customer
// needs configurability.
const WIN_TIMESTAMP_URL = "http://timestamp.digicert.com";

interface StagedBinary {
	readonly target: PayloadTarget;
	readonly path: string;
}

function stagedBinariesIn(
	context: Record<string, string> | undefined,
	targets: PayloadTarget[],
): StagedBinary[] {
	if (!context) return [];
	const list: StagedBinary[] = [];
	for (const target of targets) {
		const path =
			target === "VST3" ? context.stagedVst3
			: target === "AU" ? context.stagedAu
			: target === "AAX" ? context.stagedAax
			: target === "Standalone" ? context.stagedStandalone
			: undefined;
		if (path) list.push({ target, path });
	}
	return list;
}

export function createSignBinariesHandler(executor: PhaseExecutor): InternalTaskHandler {
	return async (answers, onProgress, signal, context) => {
		if (!isOn(answers.codesign)) return skipped("codesign disabled");
		const platform = detectPlatform();
		const targets = getPayloadTargets(answers);
		const staged = stagedBinariesIn(context, targets);
		if (staged.length === 0) {
			return fail("No staged binaries to sign — stagePayload must run first.");
		}
		const exec = withSignal(executor, signal);

		if (platform === "macOS") {
			const identity = (answers.signingIdentity ?? "").trim();
			if (!identity) {
				return fail(
					"macOS code-signing requires `signingIdentity` (Developer ID Application).",
				);
			}
			for (const { target, path } of staged) {
				onProgress({ phase: "codesign", message: `Signing ${target}: ${basename(path)}` });
				const result = await exec.spawn(
					"codesign",
					[
						"--force",
						"--timestamp",
						"--options", "runtime",
						"--deep",
						"--sign", identity,
						path,
					],
					{ onLog: (line) => onProgress({ phase: "codesign", message: line }) },
				);
				if (result.exitCode !== 0) {
					return fail(
						`codesign failed for ${target} (exit ${result.exitCode}).`,
						result.stderr ? [result.stderr] : undefined,
					);
				}
			}
			return ok(`Signed ${staged.length} bundle(s) with ${identity}.`);
		}

		if (platform === "Windows") {
			const thumbprint = (answers.codesignThumbprint ?? "").trim();
			if (!thumbprint) {
				return fail(
					"Windows code-signing requires `codesignThumbprint` (Authenticode cert).",
				);
			}
			let signedCount = 0;
			for (const { target, path } of staged) {
				if (target === "AAX") continue; // AAX uses wraptool/PACE, not signtool.
				onProgress({ phase: "signtool", message: `Signing ${target}: ${basename(path)}` });
				const result = await exec.spawn(
					"signtool",
					[
						"sign",
						"/fd", "SHA256",
						"/tr", WIN_TIMESTAMP_URL,
						"/td", "SHA256",
						"/sha1", thumbprint,
						path,
					],
					{ onLog: (line) => onProgress({ phase: "signtool", message: line }) },
				);
				if (result.exitCode !== 0) {
					return fail(
						`signtool failed for ${target} (exit ${result.exitCode}).`,
						result.stderr ? [result.stderr] : undefined,
					);
				}
				signedCount++;
			}
			return ok(`Signed ${signedCount} binary file(s) with cert ${thumbprint}.`);
		}

		return skipped("unsupported platform");
	};
}

// ── Task: publishEnsureAaxKeyfile (PR4) ──────────────────────────────

export function createEnsureAaxKeyfileHandler(_executor: PhaseExecutor): InternalTaskHandler {
	return async (answers) => {
		const targets = getPayloadTargets(answers);
		if (!targets.includes("AAX")) return skipped("AAX not in payload");
		// Self-signed PFX generation lands in PR4.
		return skipped("AAX keyfile auto-gen lands in PR4");
	};
}

// ── Task: publishSignAax (PR4) ───────────────────────────────────────

export function createSignAaxHandler(_executor: PhaseExecutor): InternalTaskHandler {
	return async (answers) => {
		const targets = getPayloadTargets(answers);
		if (!targets.includes("AAX")) return skipped("AAX not in payload");
		// wraptool sign + verify lands in PR4.
		return skipped("AAX wraptool sign lands in PR4");
	};
}

// ── Task: publishBuildInstaller ──────────────────────────────────────

export interface BuildInstallerDeps {
	readonly executor: PhaseExecutor;
	/** Path to the shipped Inno Setup template. Bound at registration time. */
	readonly issTemplatePath: string;
}

export function createBuildInstallerHandler(
	deps: BuildInstallerDeps,
): InternalTaskHandler {
	return async (answers, onProgress, signal, context) => {
		const platform = detectPlatform();
		const stagingDir = context?.stagingDir;
		const outputDir = context?.outputDir;
		if (!stagingDir || !outputDir) {
			return fail("Missing stagingDir/outputDir in context.");
		}

		const targets = getPayloadTargets(answers);
		const version = answers.version ?? "0.0.0";
		const projectName = answers.projectName ?? "Plugin";
		const eula = await resolveEulaPath(answers, context);

		if (platform === "Windows") {
			return runIscc({
				executor: withSignal(deps.executor, signal),
				issTemplatePath: deps.issTemplatePath,
				stagingDir,
				outputDir,
				targets,
				version,
				projectName,
				eulaPath: eula,
				stagedAaxName: context?.stagedAax ? basename(context.stagedAax) : null,
				stagedStandaloneName: context?.stagedStandalone
					? basename(context.stagedStandalone)
					: null,
				stagedVst3Name: context?.stagedVst3 ? basename(context.stagedVst3) : null,
				onLog: (line) => onProgress({ phase: "iscc", message: line }),
			});
		}

		if (platform === "macOS") {
			const bundleId =
				(answers.bundleIdentifier ?? "").trim() ||
				`com.unknown.${projectName.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
			return runPkgbuild({
				executor: withSignal(deps.executor, signal),
				outputDir,
				targets,
				version,
				projectName,
				bundleIdentifier: bundleId,
				installerIdentity: isOn(answers.codesign)
					? (answers.installerIdentity ?? "").trim() || null
					: null,
				stagedVst3: context?.stagedVst3 ?? null,
				stagedAu: context?.stagedAu ?? null,
				stagedAax: context?.stagedAax ?? null,
				stagedStandalone: context?.stagedStandalone ?? null,
				onLog: (line) => onProgress({ phase: "pkgbuild", message: line }),
			});
		}

		return skipped("unsupported platform");
	};
}

// ── macOS pkgbuild ───────────────────────────────────────────────────

// Where each format installs on macOS. Used to lay out the pkgbuild
// install-root so a single `--install-location /` invocation handles
// every format in the payload.
const MAC_INSTALL_PATHS: Record<PayloadTarget, string> = {
	VST3: "/Library/Audio/Plug-Ins/VST3",
	AU: "/Library/Audio/Plug-Ins/Components",
	AAX: "/Library/Application Support/Avid/Audio/Plug-Ins",
	Standalone: "/Applications",
};

interface PkgbuildOptions {
	readonly executor: PhaseExecutor;
	readonly outputDir: string;
	readonly targets: PayloadTarget[];
	readonly version: string;
	readonly projectName: string;
	readonly bundleIdentifier: string;
	readonly installerIdentity: string | null;
	readonly stagedVst3: string | null;
	readonly stagedAu: string | null;
	readonly stagedAax: string | null;
	readonly stagedStandalone: string | null;
	readonly onLog: (line: string) => void;
}

async function runPkgbuild(opts: PkgbuildOptions): Promise<WizardExecResult> {
	// Build a synthetic install root that mirrors the absolute paths each
	// format installs to. Then `pkgbuild --install-location /` copies
	// every staged bundle to its proper destination in a single pkg.
	const installRoot = join(opts.outputDir, "install-root");
	await rm(installRoot, { recursive: true, force: true });
	await mkdir(installRoot, { recursive: true });

	const placements: Array<[PayloadTarget, string | null]> = [
		["VST3", opts.stagedVst3],
		["AU", opts.stagedAu],
		["AAX", opts.stagedAax],
		["Standalone", opts.stagedStandalone],
	];
	let copied = 0;
	for (const [target, src] of placements) {
		if (!opts.targets.includes(target) || !src) continue;
		// Strip the leading "/" so join keeps the path inside installRoot.
		const subdir = MAC_INSTALL_PATHS[target].replace(/^\/+/, "");
		const destDir = join(installRoot, subdir);
		await mkdir(destDir, { recursive: true });
		const dest = join(destDir, basename(src));
		const srcStat = await stat(src);
		if (srcStat.isDirectory()) {
			await cp(src, dest, { recursive: true });
		} else {
			await copyFile(src, dest);
		}
		copied++;
	}
	if (copied === 0) {
		return fail("pkgbuild: no staged binaries to package.");
	}

	const installerName = `${opts.projectName}-${opts.version}.pkg`;
	const installerPath = join(opts.outputDir, installerName);

	const args: string[] = [
		"--root", installRoot,
		"--identifier", `${opts.bundleIdentifier}.installer`,
		"--version", opts.version,
		"--install-location", "/",
	];
	if (opts.installerIdentity) {
		args.push("--sign", opts.installerIdentity);
	}
	args.push(installerPath);

	opts.onLog(`Running pkgbuild ${args.join(" ")}`);
	const result = await opts.executor.spawn("pkgbuild", args, {
		onLog: (line) => opts.onLog(line),
	});
	if (result.exitCode !== 0) {
		return fail(
			`pkgbuild exited ${result.exitCode}.`,
			result.stderr ? [result.stderr] : undefined,
		);
	}
	return {
		success: true,
		message: opts.installerIdentity
			? `Built & signed installer: ${installerPath}`
			: `Built installer (unsigned): ${installerPath}`,
		data: { installerPath },
	};
}

async function resolveEulaPath(
	answers: WizardAnswers,
	context: Record<string, string> | undefined,
): Promise<string | null> {
	const raw = answers.eula?.trim() ?? "";
	if (raw.length === 0) return null;
	const projectFolder = answers.projectFolder ?? context?.projectFolder ?? null;
	let path: string;
	if (isAbsolutePath(raw)) {
		path = raw;
	} else if (isExplicitRelative(raw)) {
		path = resolve(raw);
	} else if (projectFolder) {
		path = join(projectFolder, raw);
	} else {
		path = raw;
	}
	return (await pathExists(path)) ? path : null;
}

interface IsccOptions {
	readonly executor: PhaseExecutor;
	readonly issTemplatePath: string;
	readonly stagingDir: string;
	readonly outputDir: string;
	readonly targets: PayloadTarget[];
	readonly version: string;
	readonly projectName: string;
	readonly eulaPath: string | null;
	readonly stagedAaxName: string | null;
	readonly stagedStandaloneName: string | null;
	readonly stagedVst3Name: string | null;
	readonly onLog: (line: string) => void;
}

// iscc parses /D values up to the next whitespace — quote values that
// contain spaces so the whole value reaches the preprocessor. Empty
// values stay unquoted (`/DName=`) so #ifdef-guarded sections still
// detect "no value provided".
function isccDefine(name: string, value: string): string {
	if (value.length === 0) return `/D${name}=`;
	if (/\s/.test(value)) return `/D${name}="${value}"`;
	return `/D${name}=${value}`;
}

async function runIscc(opts: IsccOptions): Promise<WizardExecResult> {
	// Resolve the source path each target points to inside stagingDir.
	const vst3Source = opts.targets.includes("VST3") && opts.stagedVst3Name
		? join(opts.stagingDir, opts.stagedVst3Name)
		: "";
	const aaxSource = opts.targets.includes("AAX") && opts.stagedAaxName
		? join(opts.stagingDir, opts.stagedAaxName)
		: "";
	const standaloneSource =
		opts.targets.includes("Standalone") && opts.stagedStandaloneName
			? join(opts.stagingDir, opts.stagedStandaloneName)
			: "";

	const args = [
		isccDefine("AppName", opts.projectName),
		isccDefine("AppVersion", opts.version),
		isccDefine("OutputDir", opts.outputDir),
		isccDefine("Vst3Source", vst3Source),
		isccDefine("AaxSource", aaxSource),
		isccDefine("StandaloneSource", standaloneSource),
	];
	if (opts.eulaPath) args.push(isccDefine("EulaSource", opts.eulaPath));
	args.push(opts.issTemplatePath);

	opts.onLog(`Running iscc with: ${args.join(" ")}`);

	const result = await opts.executor.spawn("iscc", args, {
		onLog: (line) => opts.onLog(line),
	});

	if (result.exitCode !== 0) {
		return fail(
			`Inno Setup compiler exited ${result.exitCode}.`,
			result.stderr ? [result.stderr] : undefined,
		);
	}

	// Inno emits the output filename in stdout — look for it for the success
	// message. Fall back to the generic name pattern.
	const installerName = `${opts.projectName}-${opts.version}-setup.exe`;
	const installerPath = join(opts.outputDir, installerName);
	return {
		success: true,
		message: `Built installer: ${installerPath}`,
		data: { installerPath },
	};
}

// ── Task: publishSignInstaller ───────────────────────────────────────

export function createSignInstallerHandler(executor: PhaseExecutor): InternalTaskHandler {
	return async (answers, onProgress, signal, context) => {
		if (!isOn(answers.codesign)) return skipped("codesign disabled");
		const installerPath = context?.installerPath;
		if (!installerPath) {
			return fail("Missing installerPath in context — buildInstaller must run first.");
		}
		const platform = detectPlatform();
		const exec = withSignal(executor, signal);

		if (platform === "macOS") {
			// pkgbuild --sign already signed the .pkg inline. No separate
			// productsign step needed when buildInstaller had the Installer
			// identity available.
			return skipped("installer signed inline by pkgbuild --sign");
		}

		if (platform === "Windows") {
			const thumbprint = (answers.codesignThumbprint ?? "").trim();
			if (!thumbprint) {
				return fail(
					"Windows code-signing requires `codesignThumbprint` (Authenticode cert).",
				);
			}
			onProgress({ phase: "signtool", message: `Signing installer: ${basename(installerPath)}` });
			const result = await exec.spawn(
				"signtool",
				[
					"sign",
					"/fd", "SHA256",
					"/tr", WIN_TIMESTAMP_URL,
					"/td", "SHA256",
					"/sha1", thumbprint,
					installerPath,
				],
				{ onLog: (line) => onProgress({ phase: "signtool", message: line }) },
			);
			if (result.exitCode !== 0) {
				return fail(
					`signtool failed on installer (exit ${result.exitCode}).`,
					result.stderr ? [result.stderr] : undefined,
				);
			}
			return ok(`Signed installer with cert ${thumbprint}.`);
		}

		return skipped("unsupported platform");
	};
}

// ── Task: publishNotarize ────────────────────────────────────────────

export function createNotarizeHandler(executor: PhaseExecutor): InternalTaskHandler {
	return async (answers, onProgress, signal, context) => {
		if (!isOn(answers.notarize)) return skipped("notarize disabled");
		if (process.platform !== "darwin") return skipped("not macOS");
		const installerPath = context?.installerPath;
		if (!installerPath) {
			return fail("Missing installerPath in context — buildInstaller must run first.");
		}
		const profile = (answers.notarizeProfile ?? "notarize").trim() || "notarize";
		const exec = withSignal(executor, signal);

		// Re-probe at task time. The form gates the notarize toggle on the
		// init-time `hasNotaryProfile` flag, but `--answers` JSON in CLI
		// single-shot mode can bypass the gate, and the keychain state may
		// have changed since init ran.
		const probe = await detectNotaryProfile(executor, profile);
		if (probe === "network-error") {
			return fail(
				"Cannot notarize — could not reach Apple's notary service. " +
					"Check your internet connection and retry.",
			);
		}
		if (probe === "missing") {
			return fail(
				`Cannot notarize — the "${profile}" keychain profile is not ` +
					"registered (or its stored credentials are invalid).\n\n" +
					NOTARIZE_SETUP_INSTRUCTIONS,
			);
		}

		onProgress({
			phase: "notarize",
			message: `Submitting ${basename(installerPath)} to Apple notarization (this may take several minutes)…`,
		});
		const submit = await exec.spawn(
			"xcrun",
			[
				"notarytool", "submit", installerPath,
				"--keychain-profile", profile,
				"--wait",
			],
			{ onLog: (line) => onProgress({ phase: "notarize", message: line }) },
		);
		if (submit.exitCode !== 0) {
			return fail(
				`notarytool submit failed (exit ${submit.exitCode}). The submission ` +
					"log above usually contains the rejected component — most often " +
					"an unsigned bundle or a bundle without the hardened runtime.",
				submit.stderr ? [submit.stderr] : undefined,
			);
		}

		onProgress({ phase: "staple", message: "Stapling notarization ticket…" });
		const staple = await exec.spawn(
			"xcrun",
			["stapler", "staple", installerPath],
			{ onLog: (line) => onProgress({ phase: "staple", message: line }) },
		);
		if (staple.exitCode !== 0) {
			return fail(
				`stapler staple failed (exit ${staple.exitCode}).`,
				staple.stderr ? [staple.stderr] : undefined,
			);
		}
		return ok(`Notarized & stapled ${basename(installerPath)}.`);
	};
}

// ── Signal wrapping helper (mirrors compile-tasks pattern) ───────────

function withSignal(
	executor: PhaseExecutor,
	signal?: AbortSignal,
): PhaseExecutor {
	if (!signal) return executor;
	return {
		spawn: (cmd, args, opts) => executor.spawn(cmd, args, { ...opts, signal }),
	};
}


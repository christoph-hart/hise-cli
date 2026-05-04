// ── Update wizard init handler — detect current build + latest CI SHA ──
//
// Reads HisePath from HISE's own compilerSettings.xml (so the user doesn't
// re-enter it), queries /api/status for the currently-running build commit,
// and asks GitHub Actions for the latest successful ci_mac.yml run on the
// `develop` branch. Also fetches the HEAD of develop so the wizard can flag
// whether the newest commit has actually passed CI.

import { readFile } from "node:fs/promises";
import type { HiseConnection } from "../../engine/hise.js";
import { isEnvelopeResponse } from "../../engine/hise.js";
import type { InternalInitHandler } from "../../engine/wizard/handler-registry.js";
import type { PhaseExecutor } from "../../engine/wizard/phase-executor.js";
import { extractStatusPayload } from "../../engine/modes/inspect.js";
import { WizardInitAbortError } from "../../engine/wizard/executor.js";
import { detectFaust, detectParallelJobs } from "./setup-detect.js";

// Repo + workflow used for the CI-green SHA check. The repo currently has no
// `ci_build.yml` — the actual workflow file is ci_mac.yml, displayed as "CI
// Build". Verified against the live GitHub API at plan time.
const HISE_REPO = "christophhart/HISE";
const CI_WORKFLOW_FILE = "ci_mac.yml";
const CI_BRANCH = "develop";

export interface UpdateDetectDeps {
	readonly executor: PhaseExecutor;
	readonly connection: HiseConnection;
	/** Injectable GitHub fetcher for tests. Defaults to globalThis.fetch. */
	readonly fetchImpl?: typeof globalThis.fetch;
	/** Injectable text-file reader for tests. Defaults to fs.readFile.
	 *  Returns null when the file is missing/unreadable. */
	readonly readTextFile?: (path: string) => Promise<string | null>;
}

async function defaultReadTextFile(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf-8");
	} catch {
		return null;
	}
}

export function createUpdateDetectHandler(deps: UpdateDetectDeps): InternalInitHandler {
	const readTextFile = deps.readTextFile ?? defaultReadTextFile;
	return async (_wizardId) => {
		const defaults: Record<string, string> = {};

		const platform =
			process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
		defaults.platform = platform;
		defaults.architecture = process.arch === "arm64" ? "arm64" : "x64";

		// HISE install path — read from <appData>/HISE/compilerSettings.xml.
		// Without it we can't locate currentGitHash.txt below, and the user
		// almost certainly hasn't run /setup yet.
		const settingsXml = await readTextFile(compilerSettingsPath(platform));
		const installPath = settingsXml ? parseHisePath(settingsXml) : null;
		if (!installPath) {
			throw new WizardInitAbortError(
				"HISE install path not found (compilerSettings.xml missing HisePath). " +
				"Run /setup first.",
			);
		}
		defaults.installPath = installPath;

		// VS version — for the Windows MSBuild path. Falls back to "2022"
		// (the year aka.ms/vs/stable installs) when compilerSettings.xml
		// has no VisualStudioVersion element.
		defaults.vsVersion = (settingsXml && parseVsVersion(settingsXml)) ?? "2022";

		// Running build SHA + reachability. When HISE is running we trust
		// /api/status; when it's offline we fall back to the currentGitHash.txt
		// file that the build writes next to the repo root. If neither source
		// is available, the user hasn't completed /setup — abort.
		const status = await probeRunningBuild(deps.connection);
		defaults.hiseRunning = status.running ? "1" : "0";
		let currentSha = status.buildCommit ?? "";
		if (!currentSha) {
			const fromFile = await readCurrentGitHash(readTextFile, installPath, platform);
			if (fromFile) {
				currentSha = fromFile;
			} else {
				throw new WizardInitAbortError(
					`Cannot determine current HISE build SHA: HISE is not running and ` +
					`${installPath}/currentGitHash.txt was not found. Run /setup first.`,
				);
			}
		}
		defaults.currentSha = currentSha;

		// Default toggles derived from current state.
		defaults.shutdownHise = status.running ? "1" : "0";
		defaults.compileHise = "1";
		defaults.launchHise = status.running ? "1" : "0";

		// Parallel jobs + Faust — mirror /setup so the rebuild respects the
		// same caps and picks up the existing Faust install if present.
		defaults.parallelJobs = String(await detectParallelJobs(deps.executor, platform));
		defaults.includeFaust = installPath
			? (await detectFaust(deps.executor, platform, installPath) ? "1" : "0")
			: "0";

		// Default build configuration mirrors the originally-built variant.
		// User can override on the Actions tab (Minimal / Debug /
		// DebugWithFaust / Release / ReleaseWithFaust).
		defaults.buildConfiguration = defaults.includeFaust === "1" ? "ReleaseWithFaust" : "Release";

		// Latest CI-green develop SHA + develop HEAD. The green SHA drives
		// the checkout target; the HEAD comparison tells the user whether
		// develop's newest commit has passed CI yet (vs still running /
		// failed), surfaced as the `latestCommitPassedCi` toggle.
		const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
		const [ci, developHead] = await Promise.all([
			fetchLatestCiSha(fetchImpl),
			fetchDevelopHead(fetchImpl),
		]);
		// latestSha is kept in globalDefaults (not rendered as a field) so
		// updateCheckout can fall back to it if the user clears targetCommit.
		defaults.latestSha = ci?.sha ?? "";
		// Commit subject of the target (green) commit — shown in Status tab
		// so the user knows what they're pulling before submitting.
		defaults.latestCommitTitle = ci?.title ?? "";

		defaults.latestCommitPassedCi =
			ci && developHead && ci.sha === developHead ? "1" : "0";

		// Update available when (a) we have a green SHA at all AND (b) the
		// running build is not already on it. An empty currentSha means HISE
		// pre-dates the buildCommit field → treat as "update available".
		if (!defaults.latestSha) {
			defaults.updateAvailable = "0";
		} else if (defaults.currentSha && defaults.currentSha === defaults.latestSha) {
			defaults.updateAvailable = "0";
		} else {
			defaults.updateAvailable = "1";
		}

		// Default target is the latest CI-green SHA. The wizard form lets the
		// user override this if GitHub rate-limited us or they want a specific
		// commit.
		defaults.targetCommit = defaults.latestSha;

		return defaults;
	};
}

// ── compilerSettings.xml parsing ──────────────────────────────────────

/** HISE stores compilerSettings.xml under the platform's app-data folder.
 *  Mirrors HiseSettings::Data::getFileForSetting in the C++ source. */
function compilerSettingsPath(platform: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	if (platform === "macOS") {
		return `${home}/Library/Application Support/HISE/compilerSettings.xml`;
	}
	if (platform === "Linux") {
		// JUCE's File::getSpecialLocation(userApplicationDataDirectory) maps
		// to ~/.config on Linux.
		const xdg = process.env.XDG_CONFIG_HOME ?? `${home}/.config`;
		return `${xdg}/HISE/compilerSettings.xml`;
	}
	const appData = process.env.APPDATA ?? `${home}\\AppData\\Roaming`;
	return `${appData}\\HISE\\compilerSettings.xml`;
}

/** Extract `<HisePath value="..."/>` from a compilerSettings.xml blob.
 *  The file is flat — one element per setting — so a regex is sufficient. */
export function parseHisePath(xml: string): string | null {
	const match = /<HisePath\s+value="([^"]*)"\s*\/?>/.exec(xml);
	if (!match || !match[1]) return null;
	const value = match[1].trim();
	return value.length > 0 ? value : null;
}

/** Extract the major year from `<VisualStudioVersion value="Visual Studio 20XX"/>`. */
export function parseVsVersion(xml: string): "2022" | "2026" | null {
	const match = /<VisualStudioVersion\s+value="Visual Studio (\d{4})"\s*\/?>/.exec(xml);
	if (!match) return null;
	if (match[1] === "2022" || match[1] === "2026") return match[1];
	return null;
}

/** Read `<installPath>/currentGitHash.txt` — a plain SHA that the HISE build
 *  writes at repo root (visible in the hise-source tree listing). Used as a
 *  fallback when /api/status is unreachable because HISE isn't running. */
export async function readCurrentGitHash(
	readTextFile: (path: string) => Promise<string | null>,
	installPath: string,
	platform: string,
): Promise<string | null> {
	const sep = platform === "Windows" ? "\\" : "/";
	const text = await readTextFile(`${installPath}${sep}currentGitHash.txt`);
	if (text === null) return null;
	const sha = text.trim();
	// Accept anything that looks like a SHA — 7 to 40 hex chars. Guards
	// against accidentally returning an empty file's trim() == "".
	return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

// ── /api/status probing ──────────────────────────────────────────────

interface RunningBuild {
	readonly running: boolean;
	readonly buildCommit?: string;
}

async function probeRunningBuild(connection: HiseConnection): Promise<RunningBuild> {
	try {
		const response = await connection.get("/api/status");
		if (!isEnvelopeResponse(response) || !response.success) return { running: false };
		const payload = extractStatusPayload(response as unknown as Record<string, unknown>);
		return { running: true, buildCommit: payload.server.buildCommit };
	} catch {
		return { running: false };
	}
}

// ── GitHub Actions CI query ──────────────────────────────────────────

interface CiRun {
	readonly sha: string;
	readonly title: string;
	readonly date: string;
	readonly runUrl: string;
}

export async function fetchLatestCiSha(
	fetchImpl: typeof globalThis.fetch,
): Promise<CiRun | null> {
	const url = `https://api.github.com/repos/${HISE_REPO}/actions/workflows/${CI_WORKFLOW_FILE}/runs?branch=${CI_BRANCH}&status=success&per_page=1`;
	try {
		const response = await fetchImpl(url, {
			headers: {
				// GitHub requires a User-Agent; omitting it yields 403.
				"User-Agent": "hise-cli",
				"Accept": "application/vnd.github+json",
			},
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) return null;
		const body = await response.json() as {
			workflow_runs?: Array<{
				head_sha?: unknown;
				display_title?: unknown;
				created_at?: unknown;
				html_url?: unknown;
			}>;
		};
		const run = body.workflow_runs?.[0];
		if (!run || typeof run.head_sha !== "string") return null;
		return {
			sha: run.head_sha,
			title: typeof run.display_title === "string" ? run.display_title : "",
			date: typeof run.created_at === "string" ? run.created_at : "",
			runUrl: typeof run.html_url === "string" ? run.html_url : "",
		};
	} catch {
		return null;
	}
}

/** HEAD SHA of the `develop` branch. Used only to compute whether the most
 *  recent commit has a passing CI run (by comparing against the green SHA). */
export async function fetchDevelopHead(
	fetchImpl: typeof globalThis.fetch,
): Promise<string | null> {
	const url = `https://api.github.com/repos/${HISE_REPO}/commits/${CI_BRANCH}`;
	try {
		const response = await fetchImpl(url, {
			headers: {
				"User-Agent": "hise-cli",
				"Accept": "application/vnd.github+json",
			},
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) return null;
		const body = await response.json() as { sha?: unknown };
		return typeof body.sha === "string" ? body.sha : null;
	} catch {
		return null;
	}
}


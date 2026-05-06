import { randomUUID } from "node:crypto";
import type { DataLoader } from "../engine/data.js";
import { HttpHiseConnection, type HiseConnection } from "../engine/hise.js";
import type { CommandEntry } from "../engine/commands/registry.js";
import { parseCliArgs } from "./args.js";
import { ObserverClient } from "./observer.js";
import { CapturingHiseConnection } from "./capture.js";
import { serializeCliOutput, type CliOutputPayload } from "./output.js";
import { createSession, loadSessionDatasets } from "../session-bootstrap.js";
import { createDefaultMockRuntime } from "../mock/runtime.js";
import type { WizardHandlerRegistry } from "../engine/wizard/handler-registry.js";
import { createNodePhaseExecutor } from "../tui/nodePhaseExecutor.js";
import { registerUpdateHandlers } from "../tui/wizard-handlers/index.js";
import { isAbsolutePath, isExplicitRelative } from "../engine/session.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { watch } from "node:fs";

/** Fetch project info from HISE so resolvePath uses the project folder. */
async function fetchProjectInfo(
	session: import("../engine/session.js").Session,
	connection: import("../engine/hise.js").HiseConnection,
): Promise<void> {
	try {
		const resp = await connection.get("/api/status");
		const data = resp as unknown as Record<string, unknown>;
		if (data.success && data.project && typeof data.project === "object") {
			const proj = data.project as Record<string, unknown>;
			if (typeof proj.name === "string") session.projectName = proj.name;
			if (typeof proj.projectFolder === "string") session.projectFolder = proj.projectFolder;
		}
	} catch { /* no connection — caller decides how to handle */ }
}

/** A bare-relative path needs a project folder to resolve. */
function needsProjectFolder(path: string): boolean {
	return !isAbsolutePath(path) && !isExplicitRelative(path);
}

import { wireScriptFileOps, wireExtendedFileOps } from "../node-io.js";
import { createNodeAssetEnvironment } from "../tui/nodeAssetIo.js";
import { registerAssetsWizardHandlers } from "../tui/wizard-handlers/index.js";
import { readFile as fsReadFile } from "node:fs/promises";
import { compilerSettingsPath, parseHisePath } from "../tui/nodeHiseLauncher.js";
import { extractStatusPayload } from "../engine/modes/inspect.js";
import { isErrorResponse, isSuccessResponse } from "../engine/hise.js";

export interface CliCommandOptions {
	connectionOverride?: HiseConnection;
	handlerRegistry?: WizardHandlerRegistry;
	launcher?: import("../engine/modes/hise.js").HiseLauncher;
}

export async function executeCliCommand(
	argv: string[],
	commands: CommandEntry[],
	dataLoader: DataLoader,
	connectionOrOptions?: HiseConnection | CliCommandOptions,
): Promise<{ kind: "tui"; args: string[] } | { kind: "help"; scope?: string } | { kind: "error"; message: string } | { kind: "diagnose"; filePath: string } | { kind: "update"; check: boolean } | { kind: "json"; payload: CliOutputPayload }> {
	// Backward compat: accept either a connection directly or an options object
	const opts: CliCommandOptions = connectionOrOptions && "probe" in connectionOrOptions
		? { connectionOverride: connectionOrOptions }
		: (connectionOrOptions as CliCommandOptions) ?? {};

	const parsed = parseCliArgs(argv, commands);
	if (parsed.kind === "run") {
		return executeRunCommand(parsed, dataLoader, opts);
	}
	if (parsed.kind === "version") {
		return { kind: "json", payload: { ok: true, value: { version: cliVersion() } } };
	}
	if (parsed.kind === "status") {
		return { kind: "json", payload: { ok: true, value: await collectStatus(opts) } };
	}
	if (parsed.kind !== "execute") return parsed;

	const mockRuntime: ReturnType<typeof createDefaultMockRuntime> | null = !opts.connectionOverride && parsed.useMock ? createDefaultMockRuntime() : null;
	const connection = new CapturingHiseConnection(
		opts.connectionOverride ?? mockRuntime?.connection ?? new HttpHiseConnection(),
	);
	if (opts.handlerRegistry && opts.launcher) {
		registerUpdateHandlers(opts.handlerRegistry, {
			executor: createNodePhaseExecutor(),
			connection,
			launcher: opts.launcher,
		});
	}
	const assetEnvironment = createNodeAssetEnvironment({ hise: connection });
	if (opts.handlerRegistry) {
		registerAssetsWizardHandlers(opts.handlerRegistry, assetEnvironment);
	}
	let datasets: import("../session-bootstrap.js").SessionDatasets = {};
	const { session, completionEngine } = createSession({
		connection,
		getModuleList: () => datasets.moduleList,
		getScriptnodeList: () => datasets.scriptnodeList,
		getComponentProperties: () => datasets.componentProperties,
		getScriptingApi: () => datasets.scriptingApi,
		forLlm: true,
		handlerRegistry: opts.handlerRegistry,
		launcher: opts.launcher,
		assetEnvironment,
	});
	// Wire up script file I/O for /run, /parse, and /edit commands
	session.loadScriptFile = async (filePath: string) => {
		const { readFile } = await import("node:fs/promises");
		const { resolve } = await import("node:path");
		const resolved = resolve(filePath);
		return readFile(resolved, "utf-8");
	};
	wireScriptFileOps(session);
	wireExtendedFileOps(session);
	// Stream wizard progress / logs to stderr so stdout stays clean for JSON.
	session.onWizardProgress = (progress) => {
		if (progress.message && !progress.message.startsWith("__heading__")) {
			process.stderr.write(`${progress.message}\n`);
		}
	};
	await fetchProjectInfo(session, connection);
	await session.refreshScriptFileCache();

	datasets = await loadSessionDatasets(dataLoader, completionEngine, session);
	for (const mode of session.modeStack) {
		if (datasets.moduleList && "setModuleList" in mode && typeof mode.setModuleList === "function") {
			mode.setModuleList(datasets.moduleList);
		}
	}

	const observer = new ObserverClient();
	const commandId = randomUUID();
	await observer.emit({
		id: commandId,
		type: "command.start",
		source: "llm",
		command: parsed.canonicalCommand,
		mode: parsed.mode,
		timestamp: Date.now(),
	});

	try {
		const result = await session.handleInput(parsed.canonicalCommand);
		const payload = serializeCliOutput(parsed.mode, result, connection.getLastReplResponse());

		await observer.emit({
			id: commandId,
			type: "command.end",
			source: "llm",
			ok: result.type !== "error",
			result,
			timestamp: Date.now(),
		});

		return { kind: "json", payload };
	} finally {
		connection.destroy();
	}
}

// ── --run command execution ─────────────────────────────────────────

async function executeRunCommand(
	parsed: Extract<import("./args.js").CliParseResult, { kind: "run" }>,
	dataLoader: DataLoader,
	opts: CliCommandOptions,
): Promise<{ kind: "json"; payload: CliOutputPayload }> {
	// Watch mode: enter long-running loop (never returns via normal path)
	if (parsed.watch && parsed.source.type === "file") {
		await runWatchMode(parsed, dataLoader, opts);
		// runWatchMode only returns on error
		return { kind: "json", payload: { ok: true, value: "Watch ended." } };
	}

	// Create session with connection (before reading source, so path resolution works)
	const mockRuntime = !opts.connectionOverride && parsed.useMock ? createDefaultMockRuntime() : null;
	const connection = new CapturingHiseConnection(
		opts.connectionOverride ?? mockRuntime?.connection ?? new HttpHiseConnection(),
	);
	const assetEnvironment = createNodeAssetEnvironment({ hise: connection });
	if (opts.handlerRegistry) {
		registerAssetsWizardHandlers(opts.handlerRegistry, assetEnvironment);
	}
	let datasets: import("../session-bootstrap.js").SessionDatasets = {};
	const { session, completionEngine } = createSession({
		connection,
		getModuleList: () => datasets.moduleList,
		getScriptnodeList: () => datasets.scriptnodeList,
		getComponentProperties: () => datasets.componentProperties,
		getScriptingApi: () => datasets.scriptingApi,
		forLlm: true,
		handlerRegistry: opts.handlerRegistry,
		launcher: opts.launcher,
		assetEnvironment,
	});
	session.loadScriptFile = async (fp: string) => readFile(resolve(fp), "utf-8");
	wireScriptFileOps(session);
	wireExtendedFileOps(session);
	// Stream wizard progress / logs to stderr so stdout stays clean for JSON.
	session.onWizardProgress = (progress) => {
		if (progress.message && !progress.message.startsWith("__heading__")) {
			process.stderr.write(`${progress.message}\n`);
		}
	};
	await fetchProjectInfo(session, connection);
	await session.refreshScriptFileCache();
	datasets = await loadSessionDatasets(dataLoader, completionEngine, session);

	// Bare-relative paths require a project folder. Abort with an explicit
	// error rather than silently falling back to CWD.
	if (parsed.source.type === "file" && needsProjectFolder(parsed.source.path) && !session.projectFolder) {
		return {
			kind: "json",
			payload: {
				ok: false,
				error: `Cannot resolve "${parsed.source.path}": HISE is not running and no project is open. ` +
					`Open a project in HISE, prefix the path with "./" for CWD-relative, or pass an absolute path.`,
			},
		};
	}

	// Read the script source (after project info, so file paths resolve to project folder)
	let source: string;
	try {
		if (parsed.source.type === "file") {
			source = await readFile(resolve(session.resolvePath(parsed.source.path)), "utf-8");
		} else {
			source = await readRunSource(parsed.source);
		}
	} catch (err) {
		return {
			kind: "json",
			payload: { ok: false, error: `Failed to load script: ${err instanceof Error ? err.message : String(err)}` },
		};
	}

	try {
		// Parse
		const { parseScript } = await import("../engine/run/parser.js");
		const script = parseScript(source);

		if (script.lines.length === 0) {
			return { kind: "json", payload: { ok: true, value: "Script is empty (no executable lines)." } };
		}

		// Validate
		const { validateScript } = await import("../engine/run/validator.js");
		const validation = validateScript(script, session);

		if (parsed.dryRun) {
			// Phase 1 failed — return static errors immediately
			if (!validation.ok) {
				return { kind: "json", payload: { ok: true, value: { lines: script.lines.length, errors: validation.errors } } };
			}
			// Phase 2: live dry-run (undo-group-wrapped execution against HISE)
			const { dryRunScript } = await import("../engine/run/executor.js");
			const liveResult = await dryRunScript(script, session);
			return { kind: "json", payload: { ok: true, value: { lines: script.lines.length, errors: liveResult.errors } } };
		}

		if (!validation.ok) {
			const { formatValidationReport } = await import("../engine/run/validator.js");
			return {
				kind: "json",
				payload: { ok: false, error: formatValidationReport(validation) },
			};
		}

		// Execute
		const { executeScript } = await import("../engine/run/executor.js");
		const { runReportResult } = await import("../engine/result.js");
		const { serializeCliOutput } = await import("./output.js");
		const result = await executeScript(script, session);
		return { kind: "json", payload: serializeCliOutput("run", runReportResult(source, result, parsed.verbosity)) };
	} finally {
		connection.destroy();
	}
}

// ── Watch mode ──────────────────────────────────────────────────────

async function runWatchMode(
	parsed: Extract<import("./args.js").CliParseResult, { kind: "run" }>,
	dataLoader: DataLoader,
	opts: CliCommandOptions,
): Promise<void> {
	if (parsed.source.type !== "file") return;

	// Create persistent session
	const mockRuntime = !opts.connectionOverride && parsed.useMock ? createDefaultMockRuntime() : null;
	const connection = new CapturingHiseConnection(
		opts.connectionOverride ?? mockRuntime?.connection ?? new HttpHiseConnection(),
	);
	const assetEnvironment = createNodeAssetEnvironment({ hise: connection });
	if (opts.handlerRegistry) {
		registerAssetsWizardHandlers(opts.handlerRegistry, assetEnvironment);
	}
	let datasets: import("../session-bootstrap.js").SessionDatasets = {};
	const { session, completionEngine } = createSession({
		connection,
		getModuleList: () => datasets.moduleList,
		getScriptnodeList: () => datasets.scriptnodeList,
		getComponentProperties: () => datasets.componentProperties,
		getScriptingApi: () => datasets.scriptingApi,
		forLlm: true,
		handlerRegistry: opts.handlerRegistry,
		launcher: opts.launcher,
		assetEnvironment,
	});
	session.loadScriptFile = async (fp: string) => readFile(resolve(fp), "utf-8");
	wireScriptFileOps(session);
	wireExtendedFileOps(session);
	// Stream wizard progress / logs to stderr so stdout stays clean for JSON.
	session.onWizardProgress = (progress) => {
		if (progress.message && !progress.message.startsWith("__heading__")) {
			process.stderr.write(`${progress.message}\n`);
		}
	};
	await fetchProjectInfo(session, connection);
	await session.refreshScriptFileCache();
	datasets = await loadSessionDatasets(dataLoader, completionEngine, session);

	// Resolve watched file path *after* project info — same rule as one-shot --run.
	if (needsProjectFolder(parsed.source.path) && !session.projectFolder) {
		console.error(`Cannot resolve "${parsed.source.path}": HISE is not running and no project is open. ` +
			`Open a project in HISE, prefix the path with "./" for CWD-relative, or pass an absolute path.`);
		return;
	}
	const filePath = resolve(session.resolvePath(parsed.source.path));

	const timestamp = () => {
		const d = new Date();
		return `[${d.toLocaleTimeString("en-GB", { hour12: false })}]`;
	};

	const runOnce = async () => {
		let source: string;
		try {
			source = await readFile(filePath, "utf-8");
		} catch (err) {
			console.error(`${timestamp()} Failed to read ${parsed.source.type === "file" ? parsed.source.path : filePath}: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}

		const { parseScript } = await import("../engine/run/parser.js");
		const script = parseScript(source);

		if (script.lines.length === 0) {
			console.log(`${timestamp()} Script is empty`);
			return;
		}

		const { validateScript, formatValidationReport } = await import("../engine/run/validator.js");
		const validation = validateScript(script, session);

		if (!validation.ok) {
			console.error(`${timestamp()} \u2717 ${formatValidationReport(validation)}`);
			return;
		}

		if (parsed.dryRun) {
			console.log(`${timestamp()} \u2713 ${script.lines.length} lines validated`);
			return;
		}

		const { executeScript, formatRunReport } = await import("../engine/run/executor.js");
		const result = await executeScript(script, session);
		const report = formatRunReport(result, parsed.verbosity);

		if (result.ok) {
			console.log(`${timestamp()} \u2713 ${report}`);
		} else {
			console.error(`${timestamp()} \u2717 ${report}`);
		}
	};

	console.log(`${timestamp()} Watching ${parsed.source.path}... (Ctrl+C to stop)`);
	await runOnce();

	// Debounce: ignore rapid successive changes
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	watch(filePath, () => {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			console.log("");
			void runOnce();
		}, 200);
	});

	// Keep process alive
	await new Promise<void>(() => {});
}

type RunSource = Extract<import("./args.js").CliParseResult, { kind: "run" }>["source"];

async function readRunSource(source: RunSource): Promise<string> {
	switch (source.type) {
		case "file":
			return readFile(resolve(source.path), "utf-8");
		case "inline":
			return source.content;
		case "stdin":
			return readStdin();
	}
}

function cliVersion(): string {
	return typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
}

interface StatusReport {
	cliVersion: string;
	hisePath: string | null;
	connected: boolean;
	hiseVersion: string | null;
	buildCommit: string | null;
	project: { name: string; projectFolder: string } | null;
}

async function collectStatus(opts: CliCommandOptions): Promise<StatusReport> {
	const report: StatusReport = {
		cliVersion: cliVersion(),
		hisePath: await detectHisePath(),
		connected: false,
		hiseVersion: null,
		buildCommit: null,
		project: null,
	};

	const connection = opts.connectionOverride ?? new HttpHiseConnection();
	try {
		report.connected = await connection.probe();
		if (!report.connected) return report;

		const response = await connection.get("/api/status");
		if (isErrorResponse(response) || !isSuccessResponse(response)) return report;

		try {
			const data = extractStatusPayload(response as unknown as Record<string, unknown>);
			report.hiseVersion = data.server.version;
			report.buildCommit = data.server.buildCommit ?? null;
			report.project = { name: data.project.name, projectFolder: data.project.projectFolder };
		} catch {
			// status payload missing/malformed — leave nulls
		}
	} finally {
		if (!opts.connectionOverride) connection.destroy();
	}

	return report;
}

async function detectHisePath(): Promise<string | null> {
	try {
		const xml = await fsReadFile(compilerSettingsPath(process.platform), "utf8");
		return parseHisePath(xml);
	} catch {
		return null;
	}
}

function readStdin(): Promise<string> {
	return new Promise((res, reject) => {
		const chunks: Buffer[] = [];
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
		process.stdin.on("end", () => res(Buffer.concat(chunks).toString("utf-8")));
		process.stdin.on("error", reject);
	});
}

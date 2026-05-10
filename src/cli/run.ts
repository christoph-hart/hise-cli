import { randomUUID } from "node:crypto";
import type { DataLoader } from "../engine/data.js";
import { HttpHiseConnection, type HiseConnection } from "../engine/hise.js";
import type { CommandEntry } from "../engine/commands/registry.js";
import { parseCliArgs } from "./args.js";
import type { ScriptApiCommand } from "./args.js";
import { ObserverClient } from "./observer.js";
import { CapturingHiseConnection } from "./capture.js";
import { processCliOutputPayload, serializeCliOutput, type CliOutputPayload } from "./output.js";
import { classifyTransportError, cliError } from "./errors.js";
import { buildAgentContext } from "./agentContext.js";
import { executeWhich } from "./which.js";
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
import { isEnvelopeResponse, isErrorResponse, isSuccessResponse } from "../engine/hise.js";
import { executeScriptShow } from "../engine/modes/script-symbols.js";

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
): Promise<{ kind: "tui"; args: string[] } | { kind: "help"; scope?: string } | { kind: "error"; message: string } | { kind: "diagnose"; filePath: string } | { kind: "update"; check: boolean } | { kind: "json"; payload: CliOutputPayload; output: import("./args.js").CliOutputOptions }> {
	// Backward compat: accept either a connection directly or an options object
	const opts: CliCommandOptions = connectionOrOptions && "probe" in connectionOrOptions
		? { connectionOverride: connectionOrOptions }
		: (connectionOrOptions as CliCommandOptions) ?? {};

	const parsed = parseCliArgs(argv, commands);
	if (parsed.kind === "run") {
		return executeRunCommand(parsed, dataLoader, opts);
	}
	if (parsed.kind === "script-api") {
		return executeScriptApiCommand(parsed.command, parsed.useMock, parsed.output, opts, dataLoader);
	}
	if (parsed.kind === "version") {
		return finalizeJsonPayload({ ok: true, value: { version: cliVersion() } }, parsed.output);
	}
	if (parsed.kind === "status") {
		return finalizeJsonPayload({ ok: true, value: await collectStatus(opts) }, parsed.output);
	}
	if (parsed.kind === "agent-context") {
		return finalizeJsonPayload(buildAgentContext(parsed.query), parsed.output);
	}
	if (parsed.kind === "which") {
		return finalizeJsonPayload(executeWhich(parsed.query, parsed.limit), parsed.output);
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

	const canonicalCommand = parsed.stdin
		? `${parsed.canonicalCommand} ${(await readStdin()).trim()}`.trim()
		: parsed.canonicalCommand;

	const observer = new ObserverClient();
	const commandId = randomUUID();
	await observer.emit({
		id: commandId,
		type: "command.start",
		source: "llm",
		command: canonicalCommand,
		mode: parsed.mode,
		timestamp: Date.now(),
	});

	try {
		const result = await session.handleInput(canonicalCommand);
		const payload = serializeCliOutput(parsed.mode, result, connection.getLastReplResponse());

		await observer.emit({
			id: commandId,
			type: "command.end",
			source: "llm",
			ok: result.type !== "error",
			result,
			timestamp: Date.now(),
		});

		return finalizeJsonPayload(payload, parsed.output);
	} finally {
		connection.destroy();
	}
}

// ── --run command execution ─────────────────────────────────────────

async function executeRunCommand(
	parsed: Extract<import("./args.js").CliParseResult, { kind: "run" }>,
	dataLoader: DataLoader,
	opts: CliCommandOptions,
): Promise<{ kind: "json"; payload: CliOutputPayload; output: import("./args.js").CliOutputOptions }> {
	// Watch mode: enter long-running loop (never returns via normal path)
	if (parsed.watch && parsed.source.type === "file") {
		await runWatchMode(parsed, dataLoader, opts);
		// runWatchMode only returns on error
		return finalizeJsonPayload({ ok: true, value: "Watch ended." }, parsed.output);
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
		return finalizeJsonPayload({
			ok: false,
			code: "hise_unavailable",
			error: `Cannot resolve "${parsed.source.path}": HISE is not running and no project is open. ` +
				`Open a project in HISE, prefix the path with "./" for CWD-relative, or pass an absolute path.`,
		}, parsed.output);
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
		return finalizeJsonPayload(cliError("execution_error", `Failed to load script: ${err instanceof Error ? err.message : String(err)}`), parsed.output);
	}

	try {
		// Parse
		const { parseScript } = await import("../engine/run/parser.js");
		const script = parseScript(source);

		if (script.lines.length === 0) {
			return finalizeJsonPayload({ ok: true, value: "Script is empty (no executable lines)." }, parsed.output);
		}

		// Validate
		const { validateScript } = await import("../engine/run/validator.js");
		const validation = validateScript(script, session);

		if (parsed.dryRun) {
			// Phase 1 failed — return static errors immediately
			if (!validation.ok) {
				return finalizeJsonPayload({ ok: true, value: { lines: script.lines.length, errors: validation.errors } }, parsed.output);
			}
			// Phase 2: live dry-run (undo-group-wrapped execution against HISE)
			const { dryRunScript } = await import("../engine/run/executor.js");
			const liveResult = await dryRunScript(script, session);
			return finalizeJsonPayload({ ok: true, value: { lines: script.lines.length, errors: liveResult.errors } }, parsed.output);
		}

		if (!validation.ok) {
			const { formatValidationReport } = await import("../engine/run/validator.js");
			return finalizeJsonPayload(cliError("validation_error", formatValidationReport(validation)), parsed.output);
		}

		// Execute
		const { executeScript } = await import("../engine/run/executor.js");
		const { runReportResult } = await import("../engine/result.js");
		const { serializeCliOutput } = await import("./output.js");
		const result = await executeScript(script, session);
		return finalizeJsonPayload(serializeCliOutput("run", runReportResult(source, result, parsed.verbosity)), parsed.output);
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

function finalizeJsonPayload(
	payload: CliOutputPayload,
	output: import("./args.js").CliOutputOptions,
): { kind: "json"; payload: CliOutputPayload; output: import("./args.js").CliOutputOptions } {
	return { kind: "json", payload: processCliOutputPayload(payload, output), output };
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
		const chunks: string[] = [];
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk: string) => chunks.push(chunk));
		process.stdin.on("end", () => res(chunks.join("")));
		process.stdin.on("error", reject);
	});
}

async function executeScriptApiCommand(
	command: ScriptApiCommand,
	useMock: boolean,
	output: import("./args.js").CliOutputOptions,
	opts: CliCommandOptions,
	dataLoader: DataLoader,
): Promise<{ kind: "json"; payload: CliOutputPayload; output: import("./args.js").CliOutputOptions }> {
	const mockRuntime = !opts.connectionOverride && useMock ? createDefaultMockRuntime() : null;
	const connection = opts.connectionOverride ?? mockRuntime?.connection ?? new HttpHiseConnection();
	try {
		if (command.action === "repl") {
			const expression = (await readStdin()).trim();
			if (!expression) return finalizeJsonPayload(cliError("usage_error", "script repl stdin is empty"), output);
			const response = await connection.post("/api/repl", { moduleId: command.moduleId, expression });
			return finalizeJsonPayload(serializeHiseEnvelope(response), output);
		}

		if (command.action === "get") {
			const params = new URLSearchParams({ moduleId: command.moduleId });
			if (command.callback) params.set("callback", command.callback);
			const response = await connection.get(`/api/get_script?${params.toString()}`);
			return finalizeJsonPayload(serializeHiseEnvelope(response), output);
		}

		if (command.action === "compile") {
			const response = await connection.post("/api/recompile", { moduleId: command.moduleId });
			return finalizeJsonPayload(serializeHiseEnvelope(response), output);
		}

		if (command.action === "diagnose") {
			const body: Record<string, unknown> = { moduleId: command.moduleId, async: command.async };
			if (command.filePath) body.filePath = command.filePath;
			const response = await connection.post("/api/diagnose_script", body);
			return finalizeJsonPayload(serializeDiagnoseEnvelope(response), output);
		}

		if (command.action === "show") {
			const api = await dataLoader.loadScriptingApi().catch(() => null);
			const showCommand = command.target === "tree"
				? { kind: "tree" as const, filters: command.filters }
				: { kind: "symbol" as const, expression: command.target };
			const result = await executeScriptShow(connection, command.moduleId, showCommand, { forLlm: true, api });
			return finalizeJsonPayload(serializeCliOutput("script", result), output);
		}

		const callbacks = await readScriptCallbacks(command);
		if ("error" in callbacks) return finalizeJsonPayload(cliError("execution_error", callbacks.error), output);
		const response = await connection.post("/api/set_script", {
			moduleId: command.moduleId,
			callbacks: callbacks.callbacks,
			compile: command.compile,
		});
		return finalizeJsonPayload(serializeHiseEnvelope(response), output);
	} finally {
		if (!opts.connectionOverride) connection.destroy();
	}
}

async function readScriptCallbacks(
	command: Extract<ScriptApiCommand, { action: "set" }>,
): Promise<{ callbacks: Record<string, string> } | { error: string }> {
	if (command.source.type === "callbacks-json") {
		try {
			const raw = await readFile(resolve(command.source.path), "utf-8");
			const parsed = JSON.parse(raw) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { error: "--callbacks-json must contain an object mapping callback names to script strings" };
			}
			const callbacks: Record<string, string> = {};
			for (const [key, value] of Object.entries(parsed)) {
				if (typeof value !== "string") return { error: `Callback "${key}" must be a string` };
				callbacks[key] = value;
			}
			return { callbacks };
		} catch (err) {
			return { error: `Failed to read callbacks JSON: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	const callback = command.callback!;
	try {
		const content = command.source.type === "stdin"
			? await readStdin()
			: await readFile(resolve(command.source.path), "utf-8");
		return { callbacks: { [callback]: content.trimEnd() } };
	} catch (err) {
		return { error: `Failed to read script source: ${err instanceof Error ? err.message : String(err)}` };
	}
}

function serializeDiagnoseEnvelope(response: import("../engine/hise.js").HiseResponse): CliOutputPayload {
	if (isErrorResponse(response)) return cliError(classifyTransportError(response.message), response.message);
	if (!isEnvelopeResponse(response)) return cliError("hise_api_error", "Unexpected response from HISE");
	if (!response.success || response.errors.length > 0) {
		const error = response.errors.length > 0
			? response.errors.map((e) => e.callstack.length > 0 ? `${e.errorMessage}\n${e.callstack.join("\n")}` : e.errorMessage).join("\n")
			: String(response.result ?? "diagnose_script failed");
		return cliError("hise_api_error", error);
	}

	const { success: _success, logs, errors: _errors, ...value } = response as typeof response & { diagnostics?: Array<{ severity?: string }> };
	const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics : [];
	const hasErrors = diagnostics.some((diagnostic) => diagnostic && typeof diagnostic === "object" && "severity" in diagnostic && diagnostic.severity === "error");
	if (hasErrors) {
		return {
			ok: false,
			code: "validation_error",
			error: "Script diagnostics found errors",
			value,
			...(logs.length > 0 ? { logs } : {}),
		};
	}

	const payload: { ok: true; value: Record<string, unknown>; logs?: string[] } = { ok: true, value };
	if (logs.length > 0) payload.logs = logs;
	return payload as CliOutputPayload;
}

function serializeHiseEnvelope(response: import("../engine/hise.js").HiseResponse): CliOutputPayload {
	if (isErrorResponse(response)) return cliError(classifyTransportError(response.message), response.message);
	if (!isEnvelopeResponse(response)) return cliError("hise_api_error", "Unexpected response from HISE");
	if (!response.success || response.errors.length > 0) {
		const error = response.errors.length > 0
			? response.errors.map((e) => e.callstack.length > 0 ? `${e.errorMessage}\n${e.callstack.join("\n")}` : e.errorMessage).join("\n")
			: String(response.result ?? "HISE request failed");
		return cliError("hise_api_error", error);
	}

	const { success: _success, logs, errors: _errors, ...value } = response;
	const payload: { ok: true; value: Record<string, unknown>; logs?: string[] } = { ok: true, value };
	if (logs.length > 0) payload.logs = logs;
	return payload as CliOutputPayload;
}

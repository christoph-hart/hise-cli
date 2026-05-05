// ── Built-in slash command handlers ──────────────────────────────────

import type { CommandResult } from "../result.js";
import {
	errorResult,
	markdownResult,
	runReportResult,
	tableResult,
	textResult,
	wizardResult,
} from "../result.js";
import { MODE_ACCENTS, type ModeId } from "../modes/mode.js";
import type { CommandHandler, CommandRegistry, CommandSession } from "./registry.js";
import { generateHelp } from "./help.js";
import type { WizardAnswers } from "../wizard/types.js";
import { isEnvelopeResponse, isErrorResponse } from "../hise.js";
import { ScriptMode } from "../modes/script.js";

// ── Handler implementations ─────────────────────────────────────────

async function handleExit(
	_args: string,
	session: CommandSession,
): Promise<CommandResult> {
	return session.popMode();
}

async function handleQuit(
	_args: string,
	session: CommandSession,
): Promise<CommandResult> {
	// Force quit regardless of mode stack depth
	session.requestQuit();
	return textResult("Goodbye.");
}

async function handleHelp(
	_args: string,
	session: CommandSession,
): Promise<CommandResult> {
	const modeId = session.currentModeId as ModeId;
	const commands = session.allCommands();
	const help = generateHelp(modeId, commands);

	const result = markdownResult(help.content);
	result.accent = modeId === "root" ? "#90FFB1" : MODE_ACCENTS[modeId];
	return result;
}

async function handleModes(
	_args: string,
	_session: CommandSession,
): Promise<CommandResult> {
	const modeInfo: Array<[string, string, string]> = [
		["builder", "Module tree", MODE_ACCENTS.builder],
		["script", "HiseScript REPL", MODE_ACCENTS.script],
		["dsp", "Scriptnode DSP", MODE_ACCENTS.dsp],
		["sampler", "Sample maps", MODE_ACCENTS.sampler],
		["inspect", "Runtime monitor", MODE_ACCENTS.inspect],
		["project", "Project settings", MODE_ACCENTS.project],
		["export", "Build targets", MODE_ACCENTS.compile],
		["undo", "Undo history & plan groups", MODE_ACCENTS.undo],
		["publish", "Build & sign installers", MODE_ACCENTS.publish],
		["assets", "Install, manage, and publish asset packages", MODE_ACCENTS.assets],
		["api", "HiseScript API doc browser", MODE_ACCENTS.api],
	];

	return tableResult(
		["Mode", "Description", "Color"],
		modeInfo.map(([name, desc, color]) => [name, desc, color]),
	);
}

function createModeHandler(modeId: ModeId): CommandHandler {
	const handler: CommandHandler = async (args, session) => {
		// Parse args: [.context] [command]
		// - /builder → enter mode
		// - /builder.SineGenerator → enter mode with context
		// - /builder add SimpleGain → one-shot execution
		// - /builder.SineGenerator add LFO → one-shot with context
		
		let context: string | undefined;
		let commandInput: string | undefined;
		
		if (args.startsWith(".")) {
			// Dot-notation: extract context path
			const spaceIndex = args.indexOf(" ");
			if (spaceIndex === -1) {
				// Just context, no command: /builder.SineGenerator
				context = args.slice(1);
			} else {
				// Context + command: /builder.SineGenerator add LFO
				context = args.slice(1, spaceIndex);
				commandInput = args.slice(spaceIndex + 1).trim();
			}
		} else if (args) {
			// No dot prefix → one-shot command
			commandInput = args;
		}
		
		// Determine execution mode
		if (commandInput) {
			// One-shot execution
			const mode = session.getOrCreateMode(modeId);
			
			// Set context if provided
			if (context && mode.setContext) {
				mode.setContext(context);
			}
			
			// Execute one-shot
			return session.executeOneShot(modeId, commandInput);
		} else {
			// Enter mode (with optional context)
			const mode = session.getOrCreateMode(modeId);

			// Set context if provided
			if (context && mode.setContext) {
				mode.setContext(context);
			}

			// If already in this mode, don't push again
			if (session.currentModeId === modeId) {
				if (mode.onEnter) {
					await mode.onEnter(session as unknown as import("../modes/mode.js").SessionContext);
				}
				const label = context ? `${modeId}.${context}` : modeId;
				const result = textResult(`Already in ${label} mode.`);
				result.accent = mode.accent;
				return result;
			}

			// Push mode onto stack
			const pushResult = session.pushMode(modeId);
			if (pushResult) return pushResult;

			// Fetch initial data (tree, history) so sidebar shows content immediately
			if (mode.onEnter) {
				await mode.onEnter(session as unknown as import("../modes/mode.js").SessionContext);
			}

			const label = context ? `${modeId}.${context}` : modeId;
			const result = textResult(`Entered ${label} mode.`);
			// Tag with target mode's accent for output border
			result.accent = mode.accent;
			return result;
		}
	};
	return handler;
}

// ── Wizard command ──────────────────────────────────────────────────

/**
 * Parse pre-fill arguments from a wizard command line.
 * E.g., "target:standalone format:vst" → { target: "standalone", format: "vst" }
 */
function parseWizardPrefill(args: string): { prefill: WizardAnswers; flags: Set<string>; remaining: string } {
	const prefill: WizardAnswers = {};
	const flags = new Set<string>();
	const remaining: string[] = [];

	for (const token of args.split(/\s+/).filter(Boolean)) {
		if (token.startsWith("--")) {
			flags.add(token.slice(2));
		} else if (token.includes(":")) {
			const colonIdx = token.indexOf(":");
			const key = token.slice(0, colonIdx);
			const value = token.slice(colonIdx + 1);
			if (key) prefill[key] = value;
		} else {
			remaining.push(token);
		}
	}

	return { prefill, flags, remaining: remaining.join(" ") };
}

async function handleWizard(
	args: string,
	session: CommandSession,
): Promise<CommandResult> {
	const registry = session.wizardRegistry;
	if (!registry) {
		return errorResult("No wizard definitions loaded.");
	}

	const trimmed = args.trim();

	// /wizard or /wizard list → list available wizards
	if (!trimmed || trimmed === "list") {
		const wizards = registry.list();
		if (wizards.length === 0) {
			return textResult("No wizards available.");
		}
		return tableResult(
			["ID", "Name"],
			wizards.map((w) => [w.id, w.header]),
		);
	}

	// Split first verb token off
	const spaceIdx = trimmed.indexOf(" ");
	const verb = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
	const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

	if (verb === "get") return handleWizardGet(rest, session);
	if (verb === "run") return handleWizardRun(rest, session);

	// Fall-through: first token is a wizard id (legacy form-opener path,
	// used by /setup-style aliases registered via registerWizardAliases).
	const def = resolveWizardId(verb, registry);
	if (!def) {
		return errorResult(`Unknown wizard: "${verb}". Use /wizard list to see available wizards.`);
	}
	return handleWizardWithDef(def, rest, session);
}

function resolveWizardId(
	id: string,
	registry: import("../wizard/registry.js").WizardRegistry,
): import("../wizard/types.js").WizardDefinition | null {
	const direct = registry.get(id);
	if (direct) return direct;
	const match = registry.list().find((w) => w.id.startsWith(id));
	return match ? registry.get(match.id) ?? null : null;
}

async function handleWizardGet(
	args: string,
	session: CommandSession,
): Promise<CommandResult> {
	const registry = session.wizardRegistry;
	if (!registry) return errorResult("No wizard definitions loaded.");

	const trimmed = args.trim();
	if (!trimmed) {
		return errorResult("Usage: /wizard get <id>");
	}

	const idEnd = trimmed.indexOf(" ");
	const wizardId = idEnd === -1 ? trimmed : trimmed.slice(0, idEnd);

	const def = resolveWizardId(wizardId, registry);
	if (!def) {
		return errorResult(`Unknown wizard: "${wizardId}". Use /wizard list to see available wizards.`);
	}

	const hasHttpInit = def.init?.type === "http";
	if (hasHttpInit && !session.connection) {
		return errorResult(`No HISE connection — cannot fetch init defaults for ${def.id}.`);
	}

	const { WizardExecutor } = await import("../wizard/executor.js");
	const executor = new WizardExecutor({
		connection: session.connection,
		handlerRegistry: session.handlerRegistry,
	});

	const initDefaults = await executor.initialize(def);

	// Merge: globalDefaults -> per-field defaultValue -> init defaults (init wins)
	const merged: Record<string, string> = { ...def.globalDefaults };
	for (const tab of def.tabs) {
		for (const field of tab.fields) {
			if (field.defaultValue !== undefined) {
				merged[field.id] = String(field.defaultValue);
			}
		}
	}
	Object.assign(merged, initDefaults);

	const rows: string[][] = [];
	for (const tab of def.tabs) {
		for (const field of tab.fields) {
			rows.push([
				field.id,
				field.type ?? "",
				merged[field.id] ?? "",
				field.required ? "yes" : "",
			]);
		}
	}

	return tableResult(["Field", "Type", "Default", "Required"], rows);
}

async function handleWizardRun(
	args: string,
	session: CommandSession,
): Promise<CommandResult> {
	const registry = session.wizardRegistry;
	if (!registry) return errorResult("No wizard definitions loaded.");

	const trimmed = args.trim();
	if (!trimmed) {
		return errorResult("Usage: /wizard run <id> [with Key=Value, Key2=Value2]");
	}

	// Split id and (optional) `with ...` clause
	const withMatch = trimmed.match(/^(\S+)(?:\s+with\s+(.*))?$/);
	if (!withMatch) {
		return errorResult("Usage: /wizard run <id> [with Key=Value, Key2=Value2]");
	}

	const wizardId = withMatch[1]!;
	const withExpr = (withMatch[2] ?? "").trim();

	const def = resolveWizardId(wizardId, registry);
	if (!def) {
		return errorResult(`Unknown wizard: "${wizardId}". Use /wizard list to see available wizards.`);
	}

	let prefill: WizardAnswers = {};
	if (withExpr) {
		const parsed = parseWithClause(withExpr);
		if ("error" in parsed) return errorResult(parsed.error);
		prefill = parsed.prefill;
	}

	return runWizardHeadless(def, prefill, session);
}

/**
 * Parse a `with K=V, K2=V2` clause into an answers record.
 * Supports double- and single-quoted values that may contain commas/spaces.
 */
export function parseWithClause(
	expr: string,
): { prefill: WizardAnswers } | { error: string } {
	const tokens: string[] = [];
	let buf = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < expr.length; i++) {
		const ch = expr[i]!;
		if (quote) {
			buf += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			buf += ch;
			continue;
		}
		if (ch === ",") {
			tokens.push(buf);
			buf = "";
			continue;
		}
		buf += ch;
	}
	if (quote) return { error: `Unterminated ${quote} in with-clause.` };
	if (buf.trim()) tokens.push(buf);

	const prefill: WizardAnswers = {};
	for (const raw of tokens) {
		const tok = raw.trim();
		if (!tok) continue;
		const eq = tok.indexOf("=");
		if (eq === -1) {
			return { error: `Malformed override: "${tok}". Expected Key=Value.` };
		}
		const key = tok.slice(0, eq).trim();
		let value = tok.slice(eq + 1).trim();
		if (!key) {
			return { error: `Malformed override: "${tok}". Empty key.` };
		}
		if (value.length >= 2) {
			const first = value[0]!;
			const last = value[value.length - 1]!;
			if ((first === '"' || first === "'") && first === last) {
				value = value.slice(1, -1);
			}
		}
		prefill[key] = value;
	}
	return { prefill };
}

/**
 * Serialize an answers record to a `with`-clause body — inverse of parseWithClause.
 * Used by wizard form submit handlers to dispatch through the regular slash command path.
 * Values containing whitespace, commas, or `=` are quoted; preferring double quotes,
 * falling back to single quotes if the value contains `"`.
 */
export function formatWithClause(answers: WizardAnswers): string {
	const needsQuote = /[\s,=]/;
	const parts: string[] = [];
	for (const [key, raw] of Object.entries(answers)) {
		const value = String(raw);
		if (!needsQuote.test(value) && !value.includes('"') && !value.includes("'")) {
			parts.push(`${key}=${value}`);
		} else if (!value.includes('"')) {
			parts.push(`${key}="${value}"`);
		} else if (!value.includes("'")) {
			parts.push(`${key}='${value}'`);
		} else {
			// Both quote chars present in a single value — rare for wizard fields.
			// Strip single quotes (less common in paths/identifiers) and use them as the wrapper.
			parts.push(`${key}='${value.replace(/'/g, "")}'`);
		}
	}
	return parts.join(", ");
}

async function runWizardHeadless(
	def: import("../wizard/types.js").WizardDefinition,
	prefill: WizardAnswers,
	session: CommandSession,
): Promise<CommandResult> {
	const { WizardExecutor } = await import("../wizard/executor.js");
	const { mergeInitDefaults } = await import("../wizard/types.js");
	const executor = new WizardExecutor({
		connection: session.connection,
		handlerRegistry: session.handlerRegistry,
	});

	const initDefaults = await executor.initialize(def);
	const mergedDef = mergeInitDefaults(def, initDefaults);

	const answers: WizardAnswers = { ...mergedDef.globalDefaults };
	for (const tab of mergedDef.tabs) {
		for (const field of tab.fields) {
			if (field.defaultValue !== undefined) {
				answers[field.id] = field.defaultValue;
			}
		}
	}
	Object.assign(answers, prefill);

	const { validateAnswers } = await import("../wizard/validator.js");
	const validation = validateAnswers(mergedDef, answers);
	if (!validation.valid) {
		const messages = validation.errors.map((e) => `  ${e.fieldId}: ${e.message}`).join("\n");
		return errorResult(`Validation failed:\n${messages}`);
	}

	return executeWizardInline(mergedDef, answers, session, executor, 0);
}

/**
 * Execute a fully-prepared wizard (definition merged, answers validated).
 * Single execution path used by /wizard run, /resume, and form-submit flows.
 * Tracks active-wizard state for status-bar display and wires AbortController
 * for Esc cancellation.
 */
async function executeWizardInline(
	def: import("../wizard/types.js").WizardDefinition,
	answers: WizardAnswers,
	session: CommandSession,
	executor: import("../wizard/executor.js").WizardExecutor,
	startIndex: number,
): Promise<CommandResult> {
	const hasHttpTasks = def.tasks.some((t) => t.type === "http");
	if (hasHttpTasks && !session.connection) {
		return errorResult("No HISE connection — cannot execute HTTP wizard tasks.");
	}

	const ctrl = new AbortController();
	session.setActiveWizard?.(def.header ?? def.id, ctrl);

	let result: import("../wizard/executor.js").WizardExecFailure;
	try {
		result = await executor.execute(def, answers, session.onWizardProgress, {
			signal: ctrl.signal,
			startIndex,
		});
	} finally {
		session.clearActiveWizard?.();
	}

	if (result.success) {
		session.clearPendingWizard?.();
		// Render as markdown so handlers can include code blocks / lists in
		// their per-task logs (e.g. install_package_maker shows the manifest
		// JSON and a file preview).
		return markdownResult(result.message);
	}
	if (typeof result.nextTaskIndex === "number") {
		const failedTask = def.tasks[result.nextTaskIndex];
		session.setPendingWizard?.({
			wizardId: def.id,
			answers,
			nextTaskIndex: result.nextTaskIndex,
			failedTaskLabel: failedTask?.label ?? failedTask?.id ?? "task",
		});
	}
	return errorResult(result.message);
}

async function handleResume(
	_args: string,
	session: CommandSession,
): Promise<CommandResult> {
	const pending = session.pendingWizard;
	if (!pending) {
		return errorResult("No paused wizard to resume.");
	}

	const registry = session.wizardRegistry;
	if (!registry) {
		return errorResult("Wizard registry not loaded.");
	}

	const def = registry.get(pending.wizardId);
	if (!def) {
		session.clearPendingWizard?.();
		return errorResult(`Paused wizard "${pending.wizardId}" is no longer registered.`);
	}

	const { WizardExecutor } = await import("../wizard/executor.js");
	const executor = new WizardExecutor({
		connection: session.connection,
		handlerRegistry: session.handlerRegistry,
	});
	return executeWizardInline(def, pending.answers, session, executor, pending.nextTaskIndex);
}

async function handleWizardWithDef(
	def: import("../wizard/types.js").WizardDefinition,
	args: string,
	_session: CommandSession,
): Promise<CommandResult> {
	const { prefill } = parseWizardPrefill(args);
	// Open the form in TUI with optional pre-fill (used by /<alias> shortcuts).
	return wizardResult(def, prefill);
}

// ── /wait command ──────────────────────────────────────────────────

async function handleWait(
	args: string,
	_session: CommandSession,
): Promise<CommandResult> {
	const { parseWait } = await import("../run/parser.js");
	const parsed = parseWait(args);
	if (typeof parsed === "string") {
		return errorResult(parsed);
	}
	await new Promise((resolve) => setTimeout(resolve, parsed.ms));
	return textResult(`Waited ${args.trim()}`);
}

// ── /expect command ────────────────────────────────────────────────

async function handleExpect(
	args: string,
	session: CommandSession,
): Promise<CommandResult> {
	const { parseExpect, compareValues } = await import("../run/parser.js");
	const { extractResultValue } = await import("../run/executor.js");
	const parsed = parseExpect(args);
	if (typeof parsed === "string") {
		return errorResult(parsed);
	}

	if (session.currentModeId === "root") {
		return errorResult("/expect requires an active mode (e.g., /script, /builder)");
	}

	// Execute the command in the current mode
	const mode = session.getOrCreateMode(session.currentModeId);
	const sessionContext = {
		connection: session.connection,
		projectName: session.projectName,
		projectFolder: session.projectFolder,
		cwd: session.cwd,
		popMode: () => session.popMode(true),
		invalidateAllTrees: () => {},
		resolvePath: (fp: string) => session.resolvePath(fp),
		readBinaryFile: session.readBinaryFile,
		writeTextFile: session.writeTextFile,
		listDirectory: session.listDirectory,
	};
	const result = await mode.parse(parsed.command, sessionContext);

	// Handle "matches" comparison (file-based)
	if ("kind" in parsed && parsed.kind === "match") {
		if (!session.loadScriptFile) {
			return errorResult("File reading not available for /expect matches.");
		}
		const actual = extractResultValue(result);
		let expected: string;
		try {
			expected = await session.loadScriptFile(parsed.referenceFile);
			// Trim trailing newline from file for comparison
			expected = expected.replace(/\n$/, "");
		} catch (err) {
			return errorResult(`Cannot read reference file "${parsed.referenceFile}": ${String(err)}`);
		}
		if (actual === expected) {
			return textResult(`\u2713 ${parsed.command} matches ${parsed.referenceFile}`);
		}
		return errorResult(
			`\u2717 Output does not match ${parsed.referenceFile}`,
			`Expected:\n${expected}\n\nActual:\n${actual}`,
		);
	}

	// Standard "is" comparison
	const actual = extractResultValue(result);
	const passed = compareValues(actual, parsed.expected, parsed.tolerance);

	if (passed) {
		return textResult(`\u2713 ${parsed.command} is ${parsed.expected}`);
	}
	return errorResult(`\u2717 Expected ${parsed.expected}, got ${actual}`);
}

// ── /run and /parse commands ───────────────────────────────────────

async function handleRun(
	args: string,
	session: CommandSession,
): Promise<CommandResult> {
	return runOrParse(args, session, false);
}

async function handleParse(
	args: string,
	session: CommandSession,
): Promise<CommandResult> {
	return runOrParse(args, session, true);
}

async function handleCallback(
	args: string,
	session: CommandSession,
): Promise<CommandResult> {
	if (session.currentModeId !== "script") {
		return errorResult("/callback requires script mode.");
	}

	const scriptMode = session.getOrCreateMode("script");
	if (!(scriptMode instanceof ScriptMode)) {
		return errorResult("Active script mode is unavailable.");
	}

	const target = args.trim();
	if (!target) {
		return errorResult("Usage: /callback <name> or /callback <processor.callback>");
	}

	const resolved = resolveCallbackTarget(target, scriptMode.processorId);
	if (typeof resolved === "string") {
		return errorResult(resolved);
	}

	if (resolved.processorId !== scriptMode.processorId) {
		return errorResult(
			`Current script mode targets ${scriptMode.processorId}. Switch processors before collecting ${resolved.processorId}.${resolved.callbackId}.`,
		);
	}

	session.setActiveScriptCallback?.(resolved.processorId, resolved.callbackId);
	return textResult(`Collecting raw body for ${resolved.processorId}.${resolved.callbackId}.`);
}

async function handleCompileCallbacks(
	_args: string,
	session: CommandSession,
): Promise<CommandResult> {
	if (session.currentModeId !== "script") {
		return errorResult("/compile requires script mode.");
	}

	if (!session.connection) {
		return errorResult("No HISE connection. Connect to HISE before compiling callbacks.");
	}

	const scriptMode = session.getOrCreateMode("script");
	if (!(scriptMode instanceof ScriptMode)) {
		return errorResult("Active script mode is unavailable.");
	}

	const collected = session.getCollectedScriptCallbacks?.(scriptMode.processorId) ?? {};
	if (Object.keys(collected).length === 0) {
		// No callbacks collected — just recompile the existing script
		const recompileResp = await session.connection.post("/api/recompile", {
			moduleId: scriptMode.processorId,
		});
		const result = formatCompileResponse(recompileResp, scriptMode.processorId);
		if (result.type !== "error") {
			session.markProjectTreeDirty?.();
		}
		return result;
	}

	const callbacks = Object.fromEntries(
		Object.entries(collected).map(([callbackId, body]) => [
			callbackId,
			callbackId === "onInit"
				? body
				: wrapCallback(callbackId, body),
		]),
	);

	const response = await session.connection.post("/api/set_script", {
		moduleId: scriptMode.processorId,
		callbacks,
		compile: true,
	});

	const result = formatSetScriptResponse(response, scriptMode.processorId);
	if (result.type !== "error") {
		session.clearScriptCompilerState?.(scriptMode.processorId);
		session.markProjectTreeDirty?.();
	}
	return result;
}

async function runOrParse(
	args: string,
	session: CommandSession,
	dryRun: boolean,
	verbosityOverride?: import("../run/executor.js").RunReportVerbosity,
): Promise<CommandResult> {
	// Parse --verbosity / --quiet / --verbose flags off the args string
	const { path: filePath, verbosity: parsedVerb, error: flagError } = parseRunFlags(args);
	if (flagError) return errorResult(flagError);
	const verbosity = verbosityOverride ?? parsedVerb ?? "verbose";

	if (!filePath) {
		return errorResult(`Usage: /${dryRun ? "parse" : "run"} <file.hsc> [--verbosity=verbose|summary|quiet]`);
	}

	// Glob expansion for wildcards
	if (!dryRun && (filePath.includes("*") || filePath.includes("?"))) {
		if (!session.globScriptFiles) {
			return errorResult("Glob expansion not available in this environment.");
		}
		let files: string[];
		try {
			files = await session.globScriptFiles(filePath);
		} catch (err) {
			return errorResult(`Glob failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (files.length === 0) {
			return errorResult(`No files matched "${filePath}"`);
		}
		// Build a combined RunResult so the executor can flatten per-file
		// results into the enclosing /run invocation (see executor.ts
		// nested-run handling).
		const combined = {
			ok: true,
			linesExecuted: 0,
			expects: [] as Array<import("../run/types.js").ExpectResult>,
			results: [] as Array<import("../run/types.js").CommandOutput>,
			error: undefined as { line: number; message: string } | undefined,
		};
		const combinedSources: string[] = [];
		let lineCursor = 0;
		for (const file of files) {
			const name = file.split(/[\\/]/).pop() ?? file;
			combinedSources.push(`# ${name}`);
			const headerLine = ++lineCursor;
			const result = await runOrParse(file, session, false, verbosity);
			if (result.type === "run-report") {
				const inner = result.runResult;
				combined.ok = combined.ok && inner.ok;
				combined.linesExecuted += inner.linesExecuted;
				for (const cmd of inner.results) {
					combined.results.push({
						...cmd,
						line: cmd.line + headerLine,
						label: cmd.label ?? name,
					});
				}
				for (const exp of inner.expects) {
					combined.expects.push({ ...exp, line: exp.line + headerLine });
				}
				for (const l of result.source.split("\n")) {
					combinedSources.push(l);
					lineCursor++;
				}
				if (inner.error && !combined.error) {
					combined.error = {
						line: inner.error.line + headerLine,
						message: `${name}: ${inner.error.message}`,
					};
				}
			} else if (result.type === "error") {
				combined.ok = false;
				if (!combined.error) {
					combined.error = { line: headerLine, message: `${name}: ${result.message}` };
				}
			} else if (result.type === "text") {
				combined.results.push({
					line: headerLine,
					content: `/run ${name}`,
					result,
					label: name,
				});
			}
		}
		const runResult: import("../run/types.js").RunResult = {
			ok: combined.ok,
			linesExecuted: combined.linesExecuted,
			expects: combined.expects,
			results: combined.results,
			...(combined.error ? { error: combined.error } : {}),
		};
		return runReportResult(combinedSources.join("\n"), runResult, verbosity);
	}
	if (!session.loadScriptFile) {
		return errorResult("Script file loading not available in this environment.");
	}

	let source: string;
	try {
		source = await session.loadScriptFile(filePath);
	} catch (err) {
		return errorResult(`Failed to load "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
	}

	const { parseScript } = await import("../run/parser.js");
	const script = parseScript(source);

	if (script.lines.length === 0) {
		return textResult("Script is empty (no executable lines).");
	}

	// Validation phase (always runs)
	const { validateScript, formatValidationReport } = await import("../run/validator.js");
	// validateScript needs a Session, but we have CommandSession.
	// Cast is safe because the concrete type is always Session.
	const { Session } = await import("../session.js");
	if (!(session instanceof Session)) {
		return errorResult("Script execution requires a full Session instance.");
	}

	const validation = validateScript(script, session);

	if (dryRun) {
		return textResult(formatValidationReport(validation));
	}

	if (!validation.ok) {
		return errorResult(formatValidationReport(validation));
	}

	// Recursion guard: check if this file is already on the script stack
	const resolvedPath = session.resolvePath(filePath);
	if (session.scriptStack.includes(resolvedPath)) {
		const chain = [...session.scriptStack, resolvedPath].map(p => p.split(/[\\/]/).pop()).join(" → ");
		return errorResult(`Recursive script call detected: ${chain}`);
	}

	// Execution phase
	session.scriptStack.push(resolvedPath);
	try {
		const { executeScript } = await import("../run/executor.js");
		const result = await executeScript(script, session);
		return runReportResult(source, result, verbosity);
	} finally {
		session.scriptStack.pop();
	}
}

function parseRunFlags(args: string): {
	path: string;
	verbosity: import("../run/executor.js").RunReportVerbosity | null;
	error?: string;
} {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let verbosity: import("../run/executor.js").RunReportVerbosity | null = null;
	const remaining: string[] = [];
	for (const tok of tokens) {
		if (tok === "--quiet") {
			verbosity = "quiet";
		} else if (tok === "--verbose") {
			verbosity = "verbose";
		} else if (tok.startsWith("--verbosity=")) {
			const v = tok.slice("--verbosity=".length);
			if (v !== "verbose" && v !== "summary" && v !== "quiet") {
				return { path: "", verbosity: null, error: `Invalid --verbosity value "${v}". Use verbose, summary, or quiet.` };
			}
			verbosity = v;
		} else if (tok === "--verbosity") {
			return { path: "", verbosity: null, error: "--verbosity requires =<level> (verbose|summary|quiet)" };
		} else {
			remaining.push(tok);
		}
	}
	return { path: remaining.join(" "), verbosity };
}

// ── Registration ────────────────────────────────────────────────────

// ── Connect command ──────────────────────────────────────────────────

async function handleConnect(
	_args: string,
	session: CommandSession,
): Promise<CommandResult> {
	if (!session.connection) {
		return errorResult("No connection configured.");
	}
	const alive = await session.connection.probe();
	if (alive) {
		return textResult("Connected to HISE on localhost:1900.");
	}
	return errorResult("HISE not responding on localhost:1900. Start HISE and try again.");
}

export function registerBuiltinCommands(registry: CommandRegistry): void {
	registry.register({
		name: "exit",
		description: "Exit current mode (or quit at root)",
		handler: handleExit,
		kind: "command",
	});

	registry.register({
		name: "quit",
		description: "Quit the application",
		handler: handleQuit,
		kind: "command",
	});

	registry.register({
		name: "help",
		description: "Show available commands and help topics",
		handler: handleHelp,
		kind: "command",
	});

	registry.register({
		name: "modes",
		description: "List available modes",
		handler: handleModes,
		kind: "command",
	});

	registry.register({
		name: "builder",
		description: "Enter builder mode (module tree)",
		handler: createModeHandler("builder"),
		kind: "mode",
	});

	registry.register({
		name: "script",
		description: "Enter script mode (HiseScript REPL)",
		handler: createModeHandler("script"),
		kind: "mode",
	});

	registry.register({
		name: "dsp",
		description: "Enter DSP mode (scriptnode)",
		handler: createModeHandler("dsp"),
		kind: "mode",
	});

	registry.register({
		name: "sampler",
		description: "Enter sampler mode",
		handler: createModeHandler("sampler"),
		kind: "mode",
	});

	registry.register({
		name: "inspect",
		description: "Enter inspect mode (runtime monitor)",
		handler: createModeHandler("inspect"),
		kind: "mode",
	});

	registry.register({
		name: "project",
		description: "Enter project mode (settings)",
		handler: createModeHandler("project"),
		kind: "mode",
	});

	registry.register({
		name: "export",
		description: "Enter export mode (build targets)",
		handler: createModeHandler("compile"),
		kind: "mode",
	});

	registry.register({
		name: "compile",
		description: "Compile collected script callbacks in script mode",
		handler: async (args, session) => {
			if (session.currentModeId === "script" && args.trim() === "") {
				return handleCompileCallbacks(args, session);
			}
			return errorResult("/compile is reserved for script callback compilation. Use /export for build targets.");
		},
		kind: "command",
	});

	registry.register({
		name: "undo",
		description: "Enter undo mode (history & plan groups)",
		handler: createModeHandler("undo"),
		kind: "mode",
	});

	registry.register({
		name: "ui",
		description: "Enter UI mode (component CRUD & layout)",
		handler: createModeHandler("ui"),
		kind: "mode",
	});

	registry.register({
		name: "sequence",
		description: "Enter sequence mode (timed MIDI sequences)",
		handler: createModeHandler("sequence"),
		kind: "mode",
	});

	registry.register({
		name: "hise",
		description: "Enter HISE control mode (launch, screenshot, profile)",
		handler: createModeHandler("hise"),
		kind: "mode",
	});

	registry.register({
		name: "analyse",
		description: "Enter audio analysis mode (waveform, spectrogram)",
		handler: createModeHandler("analyse"),
		kind: "mode",
		embedBlockedReason: "Audio file analysis needs local filesystem access.",
	});

	registry.register({
		name: "publish",
		description: "Enter publish mode (build & sign installers)",
		handler: createModeHandler("publish"),
		kind: "mode",
	});

	registry.register({
		name: "assets",
		description: "Install, manage, and publish HISE asset packages",
		handler: createModeHandler("assets"),
		kind: "mode",
		embedBlockedReason: "Asset operations need local filesystem and HTTP access.",
	});

	registry.register({
		name: "api",
		description: "Browse HiseScript API docs (e.g. /api Console, /api Console.print())",
		handler: createModeHandler("api"),
		kind: "mode",
	});

	registry.register({
		name: "connect",
		description: "Check HISE connection status",
		handler: handleConnect,
		kind: "command",
		surfaces: ["tui"],
	});

	registry.register({
		name: "wizard",
		description: "Run a wizard (list | get <id> | run <id> [with K=V, K2=V2])",
		handler: handleWizard,
		kind: "command",
	});

	registry.register({
		name: "resume",
		description: "Resume the most recently paused wizard from the failed task",
		handler: handleResume,
		kind: "command",
	});

	registry.register({
		name: "compact",
		description: "Toggle compact tree view (hide chains, show modules only)",
		handler: async (_args, session) => {
			const mode = session.getOrCreateMode(session.currentModeId) as { compactView?: boolean };
			if (typeof mode.compactView !== "boolean") {
				return textResult("/compact is only available in builder mode");
			}
			mode.compactView = !mode.compactView;
			return textResult(mode.compactView ? "Compact view (chains hidden)" : "Full view (chains visible)");
		},
		kind: "command",
		surfaces: ["tui"],
	});

	registry.register({
		name: "wait",
		description: "Pause execution for a duration (e.g., /wait 500ms, /wait 0.5s)",
		handler: handleWait,
		kind: "command",
	});

	registry.register({
		name: "expect",
		description: "Assert a command result (e.g., /expect getValue() is 0.5)",
		handler: handleExpect,
		kind: "command",
	});

	registry.register({
		name: "run",
		description: "Execute a .hsc script file",
		handler: handleRun,
		kind: "command",
		embedBlockedReason: "Reading .hsc files needs local filesystem access.",
	});

	registry.register({
		name: "parse",
		description: "Validate a .hsc script file (dry run, no execution)",
		handler: handleParse,
		kind: "command",
		embedBlockedReason: "Reading .hsc files needs local filesystem access.",
	});

	registry.register({
		name: "callback",
		description: "Collect raw callback body lines in script mode",
		handler: handleCallback,
		kind: "command",
	});

	registry.register({
		name: "edit",
		description: "Open multiline script editor (Ctrl+Enter to run, Escape to cancel)",
		handler: async (_args, _session) => textResult("edit:open"),
		kind: "command",
		surfaces: ["tui"],
	});
}

function resolveCallbackTarget(
	target: string,
	defaultProcessorId: string,
): { processorId: string; callbackId: string } | string {
	const trimmed = target.trim();
	const parts = trimmed.split(".");
	if (parts.length > 2) {
		return `Invalid callback target: ${trimmed}`;
	}

	const processorId = parts.length === 2 ? parts[0]! : defaultProcessorId;
	const callbackId = parts.length === 2 ? parts[1]! : parts[0]!;
	if (!/^[A-Za-z_]\w*$/.test(processorId) || !/^[A-Za-z_]\w*$/.test(callbackId)) {
		return `Invalid callback target: ${trimmed}`;
	}

	return { processorId, callbackId };
}

function wrapCallback(callbackId: string, body: string): string {
	const lines = body.split("\n");
	const indentedBody = lines.length === 1 && lines[0] === ""
		? ""
		: lines.map((line) => `\t${line}`).join("\n");
	return indentedBody
		? `function ${callbackId}()\n{\n${indentedBody}\n}`
		: `function ${callbackId}()\n{\n}`;
}

function formatSetScriptResponse(
	response: import("../hise.js").HiseResponse,
	processorId: string,
): CommandResult {
	if (isErrorResponse(response)) {
		return errorResult(response.message);
	}

	if (!isEnvelopeResponse(response)) {
		return errorResult("Unexpected response from HISE");
	}

	if (response.errors.length > 0) {
		const errorMessages = response.errors.map((e) => e.callstack.length > 0
			? `${e.errorMessage}\n${e.callstack.join("\n")}`
			: e.errorMessage).join("\n");
		return errorResult(errorMessages);
	}

	if (!response.success) {
		return errorResult(String(response.result ?? "Callback compilation failed"));
	}

	const body = response as unknown as {
		updatedCallbacks?: string[];
		result?: string | null;
		logs?: string[];
	};
	const updated = body.updatedCallbacks?.length
		? ` (${body.updatedCallbacks.join(", ")})`
		: "";
	const logs = body.logs && body.logs.length > 0 ? `\n${body.logs.join("\n")}` : "";
	return textResult(`${String(body.result ?? "Compiled OK")} for ${processorId}${updated}.${logs}`.trim());
}

/** Format a /api/recompile response with full error context (callstack + logs). */
function formatCompileResponse(
	response: import("../hise.js").HiseResponse,
	processorId: string,
): CommandResult {
	if (isErrorResponse(response)) return errorResult(response.message);
	if (!isEnvelopeResponse(response)) return errorResult("Unexpected response from HISE");

	if (response.errors.length > 0) {
		const errorMessages = response.errors.map((e) => e.callstack.length > 0
			? `${e.errorMessage}\n${e.callstack.join("\n")}`
			: e.errorMessage).join("\n");
		const logs = response.logs.length > 0 ? `\n${response.logs.join("\n")}` : "";
		return errorResult(errorMessages + logs);
	}

	if (!response.success) {
		return errorResult(String(response.result ?? "Recompile failed"));
	}

	const logs = response.logs.length > 0 ? `\n${response.logs.join("\n")}` : "";
	return textResult(`Recompiled ${processorId}.${logs}`.trim());
}

/**
 * Register wizard aliases as top-level slash commands.
 * Called after wizard definitions are loaded from YAML.
 * E.g., aliases: ["setup"] → /setup opens the wizard form.
 */
export function registerWizardAliases(
	commandRegistry: CommandRegistry,
	wizardRegistry: import("../wizard/registry.js").WizardRegistry,
): void {
	for (const [alias, wizardId] of wizardRegistry.aliases()) {
		// Skip if a command with this name already exists (modes, builtins take precedence)
		if (commandRegistry.has(alias)) continue;

		const def = wizardRegistry.get(wizardId);
		if (!def) continue;

		commandRegistry.register({
			name: alias,
			description: `${def.header} (wizard)`,
			handler: (args, session) => handleWizardWithDef(def, args, session),
			kind: "command",
			embedBlockedReason: "Wizards run shell commands and need the local CLI.",
		});
	}
}

// ── Script executor — runtime serial execution ─────────────────────

import type { CommandResult } from "../result.js";
import { textResult, errorResult } from "../result.js";
import type { Session } from "../session.js";
import type { Mode } from "../modes/mode.js";
import type {
	ParsedScript,
	RunResult,
	ExpectResult,
	ScriptLine,
	ScriptProgressEvent,
} from "./types.js";
import { parseExpect, parseWait, compareValues } from "./parser.js";
import { compareLogLines, normalizeErrorMessage } from "./log-compare.js";
import { optimizeScript } from "./optimizer.js";
import { buildModeMap } from "./mode-map.js";
import { isEnvelopeResponse, isErrorResponse } from "../hise.js";
import { ScriptMode } from "../modes/script.js";
import type { ParseError } from "./types.js";

/**
 * Execute a parsed .hsc script against a live session.
 *
 * - Optimizes consecutive builder commands into batched requests
 * - Saves/restores the session mode stack around execution
 * - Fail-fast on runtime errors (non-expect)
 * - /expect assertions continue on failure (unless "or abort")
 * - Returns a RunResult with test report data
 */
export async function executeScript(
	script: ParsedScript,
	session: Session,
	onProgress?: (event: ScriptProgressEvent) => void,
): Promise<RunResult> {
	// Optimize: batch consecutive builder commands
	script = optimizeScript(script);
	const savedStack = saveModeStack(session);
	const expects: ExpectResult[] = [];
	const results: import("./types.js").CommandOutput[] = [];
	let linesExecuted = 0;
	let abortError: { line: number; message: string } | undefined;

	// Check if already in a plan group before execution (for unclosed detection)
	let wasInPlan = false;
	if (session.connection) {
		try {
			const resp = await session.connection.get("/api/undo/diff?scope=group");
			if (isEnvelopeResponse(resp) && resp.success) {
				const r = resp.result as Record<string, unknown> | null;
				wasInPlan = typeof r?.groupName === "string" && r.groupName !== "root";
			}
		} catch { /* no connection — skip check */ }
	}

	try {
		for (const line of script.lines) {
			// Active processor for /capture buffer routing.
			const activeProcessor = activeScriptProcessor(session);

			// Handle special /expect and /wait commands directly
			if (line.kind === "slash") {
				const cmd = extractSlashCommand(line.content);

				if (cmd.name === "wait") {
					const parsed = parseWait(cmd.args);
					if (typeof parsed === "string") {
						abortError = { line: line.lineNumber, message: parsed };
						break;
					}
					await sleep(parsed.ms);
					linesExecuted++;
					continue;
				}

				if (cmd.name === "expect") {
					const parsed = parseExpect(cmd.args);
					if (typeof parsed === "string") {
						abortError = { line: line.lineNumber, message: parsed };
						break;
					}

					// "matches" comparison not supported in batch executor
					if (parsed.kind === "match") {
						abortError = { line: line.lineNumber, message: "/expect matches is only supported in interactive mode" };
						break;
					}

					const expectResult = await executeExpect(parsed, line, session);
					expects.push(expectResult);
					onProgress?.({ type: "expect", result: expectResult });
					linesExecuted++;

					if (!expectResult.passed && parsed.abortOnFail) {
						abortError = {
							line: line.lineNumber,
							message: `Assertion failed (abort): expected ${expectResult.expected}, got ${expectResult.actual}`,
						};
						onProgress?.({ type: "error", line: line.lineNumber, message: abortError.message });
						break;
					}
					continue;
				}

				if (cmd.name === "capture") {
					if (!activeProcessor) {
						abortError = { line: line.lineNumber, message: "/capture requires script mode" };
						break;
					}
					session.startCapture?.(activeProcessor);
					linesExecuted++;
					continue;
				}

				if (cmd.name === "expect-logs") {
					const { runExpectLogs } = await import("../commands/slash.js");
					const outcome = await runExpectLogs(cmd.args, session);
					const expectResult: ExpectResult = {
						line: line.lineNumber,
						command: outcome.command || "/expect-logs",
						expected: JSON.stringify(outcome.expectedLines),
						actual: JSON.stringify(outcome.actualLines),
						actualLines: outcome.actualLines,
						passed: outcome.passed,
						tolerance: outcome.tolerance,
						verb: "logs",
					};
					expects.push(expectResult);
					onProgress?.({ type: "expect", result: expectResult });
					linesExecuted++;

					if (outcome.error) {
						abortError = { line: line.lineNumber, message: outcome.error };
						onProgress?.({ type: "error", line: line.lineNumber, message: outcome.error });
						break;
					}
					if (!outcome.passed && outcome.abortOnFail) {
						const msg = `Assertion failed (abort): ${outcome.failure ?? "logs mismatch"}`;
						abortError = { line: line.lineNumber, message: msg };
						onProgress?.({ type: "error", line: line.lineNumber, message: msg });
						break;
					}
					continue;
				}

				if (cmd.name === "expect-compile") {
					const { runExpectCompile } = await import("../commands/slash.js");
					const outcome = await runExpectCompile(cmd.args, session);
					const expectResult: ExpectResult = {
						line: line.lineNumber,
						command: "/expect-compile",
						expected: `throws "${outcome.pattern}"`,
						actual: outcome.actualError,
						actualError: outcome.actualError,
						passed: outcome.passed,
						verb: "compile-throws",
					};
					expects.push(expectResult);
					onProgress?.({ type: "expect", result: expectResult });
					linesExecuted++;

					if (outcome.error) {
						abortError = { line: line.lineNumber, message: outcome.error };
						onProgress?.({ type: "error", line: line.lineNumber, message: outcome.error });
						break;
					}
					if (!outcome.passed && outcome.abortOnFail) {
						const msg = `Assertion failed (abort): expected throws "${outcome.pattern}", got ${outcome.actualError}`;
						abortError = { line: line.lineNumber, message: msg };
						onProgress?.({ type: "error", line: line.lineNumber, message: msg });
						break;
					}
					continue;
				}
			}

			// Capture mode: non-slash lines accumulate in the buffer instead of running.
			if (line.kind === "command" && activeProcessor && session.isCapturing?.(activeProcessor)) {
				session.appendCaptureLine?.(activeProcessor, line.content);
				linesExecuted++;
				continue;
			}

			// AI line: resolve `?<NL>` to a CLI command via the LLM provider, then
			// dispatch the resolved command through the normal session pipeline.
			if (line.kind === "ai") {
				const resolved = await resolveAiLine(line.content, session);
				if (!resolved.ok) {
					abortError = { line: line.lineNumber, message: `AI prediction failed: ${resolved.error}` };
					onProgress?.({ type: "error", line: line.lineNumber, message: abortError.message });
					break;
				}
				// Record the prediction as its own output entry so reports show
				// the NL → command mapping. Then dispatch the resolved command.
				const aiOutput = {
					line: line.lineNumber,
					content: `?${line.content}`,
					result: textResult(`→ ${resolved.command}`),
					label: "ai",
				};
				results.push(aiOutput);
				onProgress?.({ type: "command", output: aiOutput });
				const aiResult = await session.handleInput(resolved.command);
				linesExecuted++;
				const dispatchOutput = { line: line.lineNumber, content: resolved.command, result: aiResult };
				results.push(dispatchOutput);
				onProgress?.({ type: "command", output: dispatchOutput });
				if (aiResult.type === "error") {
					abortError = { line: line.lineNumber, message: `AI command rejected: ${aiResult.message}` };
					onProgress?.({ type: "error", line: line.lineNumber, message: abortError.message });
					break;
				}
				continue;
			}

			// Normal command: dispatch through session
			const result = await session.handleInput(line.content);
			linesExecuted++;

			// Flatten nested /run results into this report
			if (result.type === "run-report") {
				const inner = result.runResult;
				const fileName = line.content.replace(/^\/run\s+/, "").replace(/^["']|["']$/g, "");
				// Section header
				const labelEntry = { line: line.lineNumber, content: line.content, result: textResult(fileName), label: fileName };
				results.push(labelEntry);
				onProgress?.({ type: "command", output: labelEntry });
				// Build mode map from inner source to filter mode entries and tag accents
				const innerLines = result.source.split("\n").map(l => l.trim());
				const innerModeMap = buildModeMap(innerLines);
				// Inline inner results (skip mode entry/exit, tag with accent)
				for (const cmd of inner.results) {
					const entry = cmd.line > 0 && cmd.line <= innerModeMap.length
						? innerModeMap[cmd.line - 1]
						: undefined;
					// Skip mode entry/exit (but keep one-shots)
					if (entry && entry.isModeEntry && !entry.isOneShot) continue;
					if (entry && entry.isModeExit) continue;
					// Tag with mode accent (propagate if not already set)
					const accent = cmd.accent ?? entry?.accent;
					const tagged = accent ? { ...cmd, accent } : cmd;
					results.push(tagged);
					onProgress?.({ type: "command", output: tagged });
				}
				for (const exp of inner.expects) {
					expects.push(exp);
					onProgress?.({ type: "expect", result: exp });
				}
				linesExecuted += inner.linesExecuted;
				// Propagate abort
				if (inner.error) {
					abortError = { line: line.lineNumber, message: `${fileName}: ${inner.error.message}` };
					onProgress?.({ type: "error", line: line.lineNumber, message: abortError.message });
					break;
				}
				continue;
			}

			const output = { line: line.lineNumber, content: line.content, result };
			results.push(output);
			onProgress?.({ type: "command", output });

			if (result.type === "error") {
				abortError = {
					line: line.lineNumber,
					message: result.message,
				};
				onProgress?.({ type: "error", line: line.lineNumber, message: result.message });
				break;
			}
		}
	} finally {
		restoreModeStack(session, savedStack);
	}

	// Detect unclosed plan group opened during script execution
	if (!abortError && session.connection) {
		try {
			const resp = await session.connection.get("/api/undo/diff?scope=group");
			if (isEnvelopeResponse(resp) && resp.success) {
				const r = resp.result as Record<string, unknown> | null;
				const nowInPlan = typeof r?.groupName === "string" && r.groupName !== "root";
				if (!wasInPlan && nowInPlan) {
					abortError = {
						line: script.lines[script.lines.length - 1]?.lineNumber ?? 0,
						message: `Unclosed plan group "${r!.groupName}" \u2014 add /undo apply or /undo discard`,
					};
					onProgress?.({ type: "error", line: abortError.line, message: abortError.message });
				}
			}
		} catch { /* no connection — skip check */ }
	}

	const allPassed = expects.every((e) => e.passed);
	return {
		ok: !abortError && allPassed,
		linesExecuted,
		expects,
		results,
		error: abortError,
	};
}

// ── Dry-run validation — undo-group-wrapped execution ───────────────
//
// Pushes an undo group, executes the script for real (so HISE validates
// every operation against the live module tree), then discards the group.
// Collects all errors rather than failing on the first one.

/**
 * Dry-run a parsed script against a live HISE session.
 *
 * Wraps execution in an undo group that is always discarded, so the
 * project state is unchanged. Skips /wait and /expect lines (they are
 * not relevant for structural validation). Continues past errors to
 * collect as many diagnostics as possible.
 *
 * Requires a live HISE connection. Returns a ValidationResult.
 */
export async function dryRunScript(
	script: ParsedScript,
	session: Session,
): Promise<import("./types.js").ValidationResult> {
	const conn = session.connection;
	if (!conn) {
		return { ok: false, errors: [{ line: 0, message: "No HISE connection — cannot validate live" }] };
	}

	// Optimize builder batches (same as real execution)
	script = optimizeScript(script);
	const savedStack = saveModeStack(session);
	const errors: ParseError[] = [];

	// Push a disposable undo group
	const pushResp = await conn.post("/api/undo/push_group", { name: "validate" });
	if (isErrorResponse(pushResp)) {
		return { ok: false, errors: [{ line: 0, message: `Failed to open undo group: ${pushResp.message}` }] };
	}

	try {
		for (const line of script.lines) {
			if (line.kind === "slash") {
				const cmd = extractSlashCommand(line.content);

				// Skip timing/assertion commands — not relevant for validation
				if (
					cmd.name === "wait"
					|| cmd.name === "expect"
					|| cmd.name === "expect-logs"
					|| cmd.name === "expect-compile"
					|| cmd.name === "capture"
				) continue;

				// Skip /run — nested scripts are validated separately
				if (cmd.name === "run") continue;
			}

			// AI lines: resolve via LLM, then execute the resolved command.
			if (line.kind === "ai") {
				const resolved = await resolveAiLine(line.content, session);
				if (!resolved.ok) {
					errors.push({ line: line.lineNumber, message: `AI prediction failed: ${resolved.error}` });
					continue;
				}
				const aiResult = await session.handleInput(resolved.command);
				if (aiResult.type === "error") {
					errors.push({ line: line.lineNumber, message: `AI command "${resolved.command}" rejected: ${aiResult.message}` });
				}
				continue;
			}

			// Execute against HISE (inside the undo group)
			const result = await session.handleInput(line.content);

			if (result.type === "error") {
				errors.push({ line: line.lineNumber, message: result.message });
				// Continue to collect more errors — but mode state may be
				// unreliable after a failure, so subsequent errors could be
				// cascading. That's acceptable for diagnostics.
			}
		}
	} finally {
		// Always discard the undo group and restore mode stack
		restoreModeStack(session, savedStack);
		// Best-effort undo group cleanup — connection may already be gone
		// after a failed execution. Swallowing is intentional.
		await conn.post("/api/undo/pop_group", { cancel: true }).catch(() => {});
	}

	return { ok: errors.length === 0, errors };
}

// ── /expect execution ──────────────────────────────────���────────────

async function executeExpect(
	parsed:
		| import("./types.js").ParsedExpect
		| import("./types.js").ParsedExpectLogs
		| import("./types.js").ParsedExpectThrows
		| import("./types.js").ParsedExpectContains,
	line: ScriptLine,
	session: Session,
): Promise<ExpectResult> {
	if (parsed.kind === "logs") {
		const result = await session.handleInput(parsed.command);
		const actualLines = session.lastLogs ?? [];
		session.lastLogs = [];
		const cmp = compareLogLines(actualLines, parsed.expectedLines, parsed.tolerance);
		return {
			line: line.lineNumber,
			command: parsed.command,
			expected: JSON.stringify(parsed.expectedLines),
			actual: JSON.stringify(actualLines),
			actualLines,
			passed: cmp.passed,
			tolerance: parsed.tolerance,
			verb: "logs",
			actualError: result.type === "error" ? result.message : undefined,
		};
	}

	if (parsed.kind === "contains") {
		const result = await session.handleInput(parsed.command);
		const actual = extractResultValue(result);
		return {
			line: line.lineNumber,
			command: parsed.command,
			expected: `contains "${parsed.pattern}"`,
			actual,
			passed: result.type !== "error" && actual.includes(parsed.pattern),
			verb: "contains",
		};
	}

	if (parsed.kind === "throws") {
		const result = await session.handleInput(parsed.command);
		if (result.type === "error") {
			const errMsg = normalizeErrorMessage(result.message);
			return {
				line: line.lineNumber,
				command: parsed.command,
				expected: `throws "${parsed.pattern}"`,
				actual: errMsg,
				actualError: errMsg,
				passed: errMsg.includes(parsed.pattern),
				verb: "throws",
			};
		}
		const value = extractResultValue(result);
		return {
			line: line.lineNumber,
			command: parsed.command,
			expected: `throws "${parsed.pattern}"`,
			actual: `(no throw — got ${value})`,
			actualError: "(no throw)",
			passed: false,
			verb: "throws",
		};
	}

	const result = await session.handleInput(parsed.command);
	const actual = extractResultValue(result);
	const passed = compareValues(actual, parsed.expected, parsed.tolerance);
	return {
		line: line.lineNumber,
		command: parsed.command,
		expected: parsed.expected,
		actual,
		passed,
		tolerance: parsed.tolerance,
		verb: "is",
	};
}

/** Resolve the active processor id for /capture routing. Returns null when
 *  the current mode isn't script. */
async function resolveAiLine(nl: string, session: Session): Promise<{ ok: true; command: string } | { ok: false; error: string }> {
	if (!session.llmProvider) {
		return { ok: false, error: "no LLM provider configured on session (set session.llmProvider)" };
	}
	const mode = session.modeStack[session.modeStack.length - 1];
	if (!mode || (mode.id !== "builder" && mode.id !== "ui" && mode.id !== "dsp")) {
		return { ok: false, error: `?-lines require builder/ui/dsp mode (current: ${mode?.id ?? "root"})` };
	}
	const helpText = session.getHelpText?.(mode.id) ?? "";
	const tree = mode.getTree?.() ?? null;
	const moduleList = session.getModuleList?.();
	const componentProperties = session.getComponentProperties?.();
	const { runStructuredIntent, runIntent, treeNodeToLlmJson } = await import("../llm/index.js");
	const useStructured = mode.id === "builder" || mode.id === "ui";
	const outcome = useStructured
		? await runStructuredIntent(session.llmProvider, {
				mode: mode.id,
				nl,
				tree,
				helpText,
				moduleList,
				componentProperties,
			})
		: await runIntent(session.llmProvider, {
				mode: mode.id,
				nl,
				treeJson: treeNodeToLlmJson(tree),
				helpText,
			});
	if (!outcome.ok) {
		const detail = outcome.raw ? ` (raw: ${truncate(outcome.raw, 240)})` : "";
		return { ok: false, error: `${outcome.error}${detail}` };
	}
	return { ok: true, command: outcome.result.command };
}

function truncate(s: string, max: number): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function activeScriptProcessor(session: Session): string | null {
	const mode = session.currentMode();
	if (mode instanceof ScriptMode) return mode.processorId;
	return null;
}

/**
 * Extract a comparable string value from a CommandResult.
 * - text: content directly
 * - markdown: last non-blockquoted section (the return value)
 * - error: the error message (prefixed with "ERROR: ")
 * - other: type name as fallback
 */
export function extractResultValue(result: CommandResult): string {
	switch (result.type) {
		case "text":
			return result.content.trim();
		case "markdown": {
			// Script mode returns markdown with optional blockquoted logs
			// followed by the plain return value. Extract the last non-quoted section.
			const sections = result.content.split("\n\n");
			for (let i = sections.length - 1; i >= 0; i--) {
				const section = sections[i]!.trim();
				if (!section.startsWith(">")) {
					return section;
				}
			}
			return result.content.trim();
		}
		case "error": {
			// Strip noisy REPL callstack lines (e.g. "eval() at Interface.js:1:1")
			const msg = result.message.split("\n")
				.filter(l => !l.trim().startsWith("eval()") && !l.trim().match(/^at\s/))
				.join("\n")
				.trim();
			return `ERROR: ${msg}`;
		}
		case "code":
			return result.content.trim();
		case "preformatted":
			return result.content.trim();
		case "empty":
			return "";
		default:
			return `[${result.type}]`;
	}
}

// ── Run log formatting ──────────────────────────────────────────────
//
// Formats a CommandResult for the run log output. Separate from
// extractResultValue() which is used for /expect comparisons and needs
// raw values. This pipeline produces human-friendly one-line summaries
// and applies noise filters.

/** Filters applied to log output lines. Add new filters here. */
const LOG_LINE_FILTERS: Array<(line: string) => boolean> = [
	// Suppress mode navigation noise in batch logs
	(l) => !l.trim().match(/^(Entered |Exited |Already in )/),
	// Strip REPL callstack noise
	(l) => !l.trim().startsWith("eval()"),
	(l) => !l.trim().match(/^at\s/),
	// Suppress callback capture status noise in batch logs
	(l) => !l.trim().startsWith("Collecting raw body for "),
];

/** Filter noise from a multi-line string. */
export function filterLogNoise(text: string): string {
	return text.split("\n")
		.filter(l => LOG_LINE_FILTERS.every(f => f(l)))
		.join("\n")
		.trim();
}

/**
 * Format a CommandResult for the run log.
 * Returns null if the result should be suppressed (empty, meta, etc.).
 */
export function formatResultForLog(result: CommandResult): string | null {
	switch (result.type) {
		case "empty":
			return null;
		case "text":
			return filterLogNoise(result.content);
		case "markdown": {
			// Extract plain text: strip blockquotes (logs), keep return value
			const sections = result.content.split("\n\n");
			const parts: string[] = [];
			for (const section of sections) {
				const trimmed = section.trim();
				if (trimmed.startsWith(">")) {
					// Blockquoted log lines — strip > prefix
					const logLines = trimmed.split("\n").map(l => l.replace(/^>\s?/, "")).join("\n");
					parts.push(logLines);
				} else if (trimmed) {
					parts.push(trimmed);
				}
			}
			return filterLogNoise(parts.join("\n")) || null;
		}
		case "error": {
			const msg = filterLogNoise(result.message);
			return msg ? `ERROR: ${msg}` : null;
		}
		case "code":
			return filterLogNoise(result.content) || null;
		case "preformatted":
			return result.content;
		case "table": {
			// Summarize table as compact rows
			if (result.rows.length === 0) return null;
			const lines = result.rows.map(row => row.join("  "));
			return lines.join("\n");
		}
		case "wizard":
			return null; // Wizard results don't belong in run log
		default:
			return null;
	}
}

// ── Mode stack save/restore ─────────────────────────────────────────

function saveModeStack(session: Session): Mode[] {
	return [...session.modeStack];
}

function restoreModeStack(session: Session, saved: Mode[]): void {
	session.modeStack.length = 0;
	for (const mode of saved) {
		session.modeStack.push(mode);
	}
}

// ── Helpers ─────────────────────────────────────────────────────────

function extractSlashCommand(content: string): { name: string; args: string } {
	const withoutSlash = content.slice(1);
	const spaceIdx = withoutSlash.indexOf(" ");
	if (spaceIdx === -1) {
		return { name: withoutSlash, args: "" };
	}
	return {
		name: withoutSlash.slice(0, spaceIdx),
		args: withoutSlash.slice(spaceIdx + 1).trim(),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Test report formatting ──────────────────────────────────────────

/**
 * Format a RunResult as a human-readable test report string.
 */
export type RunReportVerbosity = "verbose" | "summary" | "quiet";

export const RUN_REPORT_VERBOSITIES: readonly RunReportVerbosity[] = [
	"verbose",
	"summary",
	"quiet",
] as const;

export function formatRunReport(
	result: RunResult,
	verbosity: RunReportVerbosity = "verbose",
): string {
	const lines: string[] = [];

	// Per-command results (verbose only)
	if (verbosity === "verbose") {
		for (const cmd of result.results) {
			const val = formatResultForLog(cmd.result);
			if (val) {
				for (const line of val.split("\n")) {
					lines.push(line);
				}
			}
		}
	}

	// AI predictions are always shown (even in summary/quiet) — high-signal
	// info: which NL → which command. Pair the `?<nl>` echo with the resolved
	// command on the next line for readability.
	if (verbosity !== "verbose") {
		for (const cmd of result.results) {
			if (cmd.label !== "ai") continue;
			const resolvedLine = formatResultForLog(cmd.result);
			if (resolvedLine) {
				lines.push(`line ${cmd.line}: ${cmd.content}`);
				lines.push(`         ${resolvedLine}`);
			}
		}
	}

	// Expect results (verbose + summary)
	if (verbosity !== "quiet") {
		for (const expect of result.expects) {
			const icon = expect.passed ? "\u2713" : "\u2717";
			const verb = expect.verb ?? "is";
			const verbLabel = verb === "compile-throws" ? "compile-throws" : verb;
			const line = ` ${icon} line ${expect.line}: ${expect.command} ${verbLabel} ${expect.expected}`;
			if (!expect.passed) {
				lines.push(`${line} \u2014 got ${expect.actual}`);
			} else {
				lines.push(line);
			}
		}
	}

	if (result.error) {
		lines.push("");
		lines.push(`ABORTED at line ${result.error.line}: ${result.error.message}`);
	}

	// Summary footer
	const parts: string[] = [];
	if (result.linesExecuted > 0) parts.push(`${result.linesExecuted} commands executed`);
	if (result.expects.length > 0) {
		const passed = result.expects.filter((e) => e.passed).length;
		const total = result.expects.length;
		parts.push(result.ok ? `PASSED ${passed}/${total}` : `FAILED ${passed}/${total}`);
	}
	if (parts.length > 0) {
		if (lines.length > 0) lines.push("");
		const icon = result.ok ? "\u2713" : "\u2717";
		lines.push(`${icon} ${parts.join(", ")}`);
	}

	return lines.join("\n");
}

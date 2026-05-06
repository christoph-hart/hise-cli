import { isEnvelopeResponse, isErrorResponse, type HiseResponse } from "../engine/hise.js";
import type { CommandResult } from "../engine/result.js";
import { formatRunReport } from "../engine/run/executor.js";

export type CliOutputPayload =
	| { ok: true; logs?: string[]; value?: unknown }
	| { ok: false; error: string }
	| { ok: boolean; result: CommandResult };

export function serializeCliOutput(
	mode: string,
	result: CommandResult,
	replResponse?: HiseResponse | null,
): CliOutputPayload {
	if (mode === "script") {
		const serializedScript = serializeScriptOutput(replResponse, result);
		if (serializedScript) {
			return serializedScript;
		}
	}

	// run-report: compact summary for LLM consumers
	if (result.type === "run-report") {
		return serializeRunReport(result);
	}

	// json: emit the structured value directly (e.g. `show tree` raw HISE result)
	if (result.type === "json") {
		return { ok: true, value: result.value };
	}

	return {
		ok: result.type !== "error",
		result: stripAccent(result),
	};
}

function serializeScriptOutput(
	replResponse: HiseResponse | null | undefined,
	result: CommandResult,
): { ok: true; logs?: string[]; value?: unknown } | { ok: false; error: string } | null {
	if (replResponse) {
		if (isErrorResponse(replResponse)) {
			return { ok: false, error: replResponse.message };
		}

		if (!isEnvelopeResponse(replResponse)) {
			return { ok: false, error: "Unexpected response from HISE" };
		}

		if (replResponse.errors.length > 0) {
			return { ok: false, error: formatScriptErrors(replResponse.errors) };
		}

		if (!replResponse.success) {
			return { ok: false, error: String(replResponse.result ?? "REPL evaluation failed") };
		}

		const payload: { ok: true; logs?: string[]; value?: unknown } = { ok: true };
		if (replResponse.logs.length > 0) {
			payload.logs = replResponse.logs;
		}
		if (hasMeaningfulValue(replResponse.value)) {
			payload.value = replResponse.value;
		}
		return payload;
	}

	if (result.type === "error") {
		return { ok: false, error: formatCommandError(result) };
	}

	return null;
}

function serializeRunReport(
	result: Extract<CommandResult, { type: "run-report" }>,
): CliOutputPayload {
	const r = result.runResult;
	const verbosity = result.verbosity;
	const passed = r.expects.filter(e => e.passed).length;
	const total = r.expects.length;

	const payload: Record<string, unknown> = {
		ok: r.ok,
		linesExecuted: r.linesExecuted,
	};

	if (r.error) {
		payload.error = { line: r.error.line, message: r.error.message };
	}

	if (total > 0) {
		payload.expects = { passed, total };
		const failures = r.expects.filter(e => !e.passed);
		if (failures.length > 0) {
			payload.failures = failures.map(e => ({
				line: e.line,
				command: e.command,
				expected: e.expected,
				actual: e.actual,
			}));
		}
	}

	// Summary line
	const parts: string[] = [];
	if (r.linesExecuted > 0) parts.push(`${r.linesExecuted} commands`);
	if (total > 0) parts.push(r.ok ? `PASSED ${passed}/${total}` : `FAILED ${passed}/${total}`);
	payload.summary = (r.ok ? "\u2713 " : "\u2717 ") + parts.join(", ");

	// Logs derived from formatRunReport so JSON and human output stay aligned.
	// quiet -> omit logs entirely.
	const logs = verbosity === "quiet"
		? []
		: logLinesFromReport(formatRunReport(r, verbosity));

	const cliPayload: { ok: boolean; value: Record<string, unknown>; logs?: string[] } = {
		ok: r.ok,
		value: payload,
	};
	if (logs.length > 0) {
		cliPayload.logs = logs;
	}
	return cliPayload as CliOutputPayload;
}

function logLinesFromReport(report: string): string[] {
	const out: string[] = [];
	for (const line of report.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) out.push(trimmed);
	}
	return out;
}

function stripAccent(result: CommandResult): CommandResult {
	const { accent: _accent, ...stripped } = result;
	return stripped as CommandResult;
}

function hasMeaningfulValue(value: unknown): boolean {
	return value !== undefined && value !== null && value !== "undefined";
}

function formatScriptErrors(errors: Array<{ errorMessage: string; callstack: string[] }>): string {
	return errors
		.map((error) => {
			if (error.callstack.length === 0) {
				return error.errorMessage;
			}
			return `${error.errorMessage}\n${error.callstack.join("\n")}`;
		})
		.join("\n");
}

function formatCommandError(result: Extract<CommandResult, { type: "error" }>): string {
	return result.detail
		? `${result.message}\n${result.detail}`
		: result.message;
}

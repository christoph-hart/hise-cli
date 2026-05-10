import { isEnvelopeResponse, isErrorResponse, type HiseResponse } from "../engine/hise.js";
import type { CommandResult } from "../engine/result.js";
import { formatRunReport } from "../engine/run/executor.js";
import type { CliOutputOptions } from "./args.js";
import { cliError, type CliErrorCode, type CliErrorPayload } from "./errors.js";

export type CliOutputPayload =
	| { ok: true; logs?: string[]; value?: unknown }
	| CliErrorPayload
	| { ok: boolean; result: CommandResult; logs?: string[] };

export function processCliOutputPayload(
	payload: CliOutputPayload,
	options: CliOutputOptions,
): CliOutputPayload {
	let next = payload;
	if (options.compact || options.agent) {
		next = compactPayload(next) as CliOutputPayload;
	}
	if (options.select) {
		next = selectPayloadValue(next, options.select);
	}
	if (options.agent && !next.ok && !("code" in next)) {
		return cliError("execution_error", payloadErrorText(next));
	}
	return next;
}

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
		return result.logs && result.logs.length > 0
			? { ok: true, value: result.value, logs: result.logs }
			: { ok: true, value: result.value };
	}

	const logs = "logs" in result && result.logs && result.logs.length > 0 ? result.logs : undefined;

	return {
		ok: result.type !== "error",
		result: stripAccent(result),
		...(logs ? { logs } : {}),
	};
}

function serializeScriptOutput(
	replResponse: HiseResponse | null | undefined,
	result: CommandResult,
): { ok: true; logs?: string[]; value?: unknown } | CliErrorPayload | null {
	if (replResponse) {
		if (isErrorResponse(replResponse)) {
			return { ok: false, code: classifyCliError(replResponse.message), error: replResponse.message };
		}

		if (!isEnvelopeResponse(replResponse)) {
		return cliError("hise_api_error", "Unexpected response from HISE");
		}

		if (replResponse.errors.length > 0) {
		return cliError("hise_api_error", formatScriptErrors(replResponse.errors));
		}

		if (!replResponse.success) {
		return cliError("hise_api_error", String(replResponse.result ?? "REPL evaluation failed"));
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
		return cliError("execution_error", formatCommandError(result));
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
	if (!r.ok) {
		return {
			...cliPayload,
			code: total > 0 && passed < total ? "expectation_failed" : "execution_error",
		} as CliOutputPayload;
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
	const { accent: _accent, ...withoutAccent } = result;
	if ("logs" in withoutAccent) {
		const { logs: _logs, ...stripped } = withoutAccent;
		return stripped as CommandResult;
	}
	const stripped = withoutAccent;
	return stripped as CommandResult;
}

function compactPayload(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(compactPayload);
	}
	if (!value || typeof value !== "object") {
		return value;
	}

	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if ((key === "logs" || key === "errors") && Array.isArray(child) && child.length === 0) continue;
		out[key] = compactPayload(child);
	}
	return out;
}

function selectPayloadValue(payload: CliOutputPayload, path: string): CliOutputPayload {
	const selected = selectPath(payload, path);
	if (!selected.found) {
		return cliError("select_not_found", `Selection path not found: ${path}`);
	}
	return { ok: true, value: selected.value };
}

function payloadErrorText(payload: CliOutputPayload): string {
	if ("error" in payload && typeof payload.error === "string") return payload.error;
	if ("result" in payload && payload.result.type === "error") return formatCommandError(payload.result);
	return "Command failed";
}

function classifyCliError(message: string): CliErrorCode {
	return /^(GET|POST)\s+\/api\//.test(message) ? "hise_unavailable" : "hise_api_error";
}

function selectPath(root: unknown, path: string): { found: true; value: unknown } | { found: false } {
	let current = root;
	for (const part of parseSelectPath(path)) {
		if (typeof part === "number") {
			if (!Array.isArray(current) || part < 0 || part >= current.length) return { found: false };
			current = current[part];
			continue;
		}
		if (!current || typeof current !== "object" || !(part in current)) return { found: false };
		current = (current as Record<string, unknown>)[part];
	}
	return { found: true, value: current };
}

function parseSelectPath(path: string): Array<string | number> {
	const parts: Array<string | number> = [];
	for (const segment of path.split(".")) {
		if (!segment) continue;
		const re = /([^\[\]]+)|\[(\d+)\]/g;
		let match: RegExpExecArray | null;
		while ((match = re.exec(segment)) !== null) {
			if (match[1]) parts.push(match[1]);
			else if (match[2]) parts.push(Number(match[2]));
		}
	}
	return parts;
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

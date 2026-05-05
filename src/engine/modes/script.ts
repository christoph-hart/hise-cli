// ── Script mode — HiseScript REPL via POST /api/repl ────────────────

import type { HiseResponse } from "../hise.js";
import { isEnvelopeResponse, isErrorResponse } from "../hise.js";
import type { CommandResult } from "../result.js";
import { emptyResult, errorResult, markdownResult, textResult } from "../result.js";
import type { TokenSpan } from "../highlight/tokens.js";
import { tokenize } from "../highlight/hisescript.js";
import { tokenizeSlash } from "../highlight/slash.js";
import type { CompletionResult, Mode, SessionContext } from "./mode.js";
import { MODE_ACCENTS } from "./mode.js";
import type { CompletionEngine } from "../completion/engine.js";

const MIDI_PROCESSOR_CALLBACKS = [
	"onNoteOn",
	"onNoteOff",
	"onController",
	"onTimer",
	"onControl",
] as const;

export class ScriptMode implements Mode {
	readonly id: Mode["id"] = "script";
	readonly name = "Script";
	readonly accent = MODE_ACCENTS.script;
	private processorIdValue: string;
	private readonly completionEngine: CompletionEngine | null;

	constructor(processorId = "Interface", completionEngine?: CompletionEngine) {
		this.processorIdValue = processorId;
		this.completionEngine = completionEngine ?? null;
	}

	get processorId(): string {
		return this.processorIdValue;
	}

	get prompt(): string {
		return this.processorId === "Interface"
			? "[script] > "
			: `[script:${this.processorId}] > `;
	}

	setContext(path: string): void {
		this.processorIdValue = path || "Interface";
	}

	async onEnter(session: SessionContext): Promise<void> {
		session.clearAllScriptCompilerState?.();
		session.clearAllCaptureBuffers?.();
	}

	onExit(session: SessionContext): void {
		session.clearAllScriptCompilerState?.();
		session.clearAllCaptureBuffers?.();
	}

	async parse(
		input: string,
		session: SessionContext,
	): Promise<CommandResult> {
		if (!session.connection) {
			return errorResult(
				"No HISE connection. Connect to HISE before using script mode.",
			);
		}

		const activeCallback = session.getActiveScriptCallback?.(this.processorId) ?? null;
		if (activeCallback) {
			if (/^function\s+[A-Za-z_]\w*\s*\(/.test(input.trim())) {
				return errorResult(
					`/callback ${activeCallback} expects raw callback body only. Do not paste a function wrapper.`,
				);
			}
			const appended = session.appendScriptCallbackLine?.(this.processorId, input) ?? false;
			if (!appended) {
				return errorResult(`No active callback buffer for ${this.processorId}.`);
			}
			return emptyResult();
		}

		const response = await session.connection.post("/api/repl", {
			expression: input,
			moduleId: this.processorId,
		});

		// Stash logs so /expect <expr> logs <...> can read them after dispatch.
		session.lastReplLogs = isEnvelopeResponse(response) ? [...response.logs] : [];

		return formatReplResponse(response, input);
	}

	tokenizeInput(value: string): TokenSpan[] {
		if (value.startsWith("/")) {
			return tokenizeSlash(value);
		}
		return tokenize(value);
	}

	complete(input: string, _cursor: number): CompletionResult {
		const callbackCompletion = this.completeCallbackTarget(input);
		if (callbackCompletion) {
			return callbackCompletion;
		}

		if (!this.completionEngine) {
			return { items: [], from: 0, to: input.length };
		}

		// Find the last token boundary for completion context.
		// In script mode, we complete the last expression segment
		// (handles "var x = Synth.add" → complete from "Synth.add").
		const token = extractLastToken(input);
		if (!token.text) {
			return { items: [], from: token.from, to: input.length };
		}

		const result = this.completionEngine.completeScript(token.text);
		// Adjust offsets relative to full input
		return {
			items: result.items,
			from: token.from + result.from,
			to: input.length,
			label: result.label,
		};
	}

	private completeCallbackTarget(input: string): CompletionResult | null {
		const match = input.match(/^\/callback(?:\s+([A-Za-z0-9_.]*))?$/);
		if (!match) {
			return null;
		}

		const availableCallbacks = getAvailableCallbacksForProcessor(this.processorId);
		const target = match[1] ?? "";
		const dotIndex = target.lastIndexOf(".");
		const callbackPrefix = dotIndex === -1 ? target : target.slice(dotIndex + 1);
		const callbackFrom = input.length - callbackPrefix.length;

		const items = availableCallbacks
			.filter((callbackId) => callbackId.toLowerCase().includes(callbackPrefix.toLowerCase()))
			.map((callbackId) => ({
				label: callbackId,
				detail: "MIDI callback",
			}));

		return {
			items,
			from: callbackFrom,
			to: input.length,
			label: "Callbacks",
		};
	}
}

export function getAvailableCallbacksForProcessor(processorId: string): readonly string[] {
	return processorId === "Interface" ? [] : MIDI_PROCESSOR_CALLBACKS;
}

// ── Token extraction for completion ─────────────────────────────────

/** Extract the last identifier-like token (with dots) from script input. */
export function extractLastToken(input: string): { text: string; from: number } {
	// Walk backwards from end to find the start of the current token.
	// A token is a contiguous run of [A-Za-z0-9_.] characters.
	let i = input.length - 1;
	while (i >= 0 && /[A-Za-z0-9_.]/.test(input[i])) {
		i--;
	}
	const from = i + 1;
	return { text: input.slice(from), from };
}

// ── Response formatting (pure function, testable) ───────────────────

export function formatReplResponse(
	response: HiseResponse,
	_input: string,
): CommandResult {
	if (isErrorResponse(response)) {
		return errorResult(response.message);
	}

	if (!isEnvelopeResponse(response)) {
		return errorResult("Unexpected response from HISE");
	}

	// Check for script errors in the response
	if (response.errors.length > 0) {
		const errorMessages = response.errors
			.map((e) => {
				const stack =
					e.callstack.length > 0
						? `\n  ${e.callstack.join("\n  ")}`
						: "";
				return `${e.errorMessage}${stack}`;
			})
			.join("\n");
		return errorResult(errorMessages);
	}

	if (!response.success) {
		return errorResult(String(response.result ?? "REPL evaluation failed"));
	}

	// Build markdown with blockquoted logs and plain return value
	const sections: string[] = [];

	// Console output (logs) — blockquoted
	if (response.logs.length > 0) {
		const quotedLogs = response.logs
			.flatMap(log => log.split("\n"))  // Handle multi-line log entries
			.map(line => `> ${line}`)
			.join("\n");
		sections.push(quotedLogs);
	}

	// Evaluation result — plain (not blockquoted)
	if (response.value !== undefined) {
		const formatted = formatValue(response.value);
		sections.push(formatted);
	}

	if (sections.length === 0) {
		return textResult("(no output)");
	}

	// Use blank line separator to prevent blockquote continuation
	return markdownResult(sections.join("\n\n"));
}

function formatValue(value: unknown): string {
	if (value === undefined || value === null) {
		return "undefined";
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number") {
		return String(value);
	}
	if (typeof value === "boolean") {
		return String(value);
	}
	if (typeof value === "object") {
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}
	return String(value);
}

// ── /capture buffer submission ──────────────────────────────────────

/**
 * Submit a buffered HiseScript block as a single REPL expression. Returns the
 * raw envelope response so callers can pull `logs` / `errors` directly. Used by
 * /expect-logs to flush the /capture buffer.
 *
 * The block is wrapped in an IIFE — `(function(){ ... })()` — because the HISE
 * REPL forbids `var` declarations at the root namespace (root structure must
 * stay immutable). Wrapping gives the buffered code its own local scope so
 * `var x = 5; Console.print(x);` works as expected.
 */
export async function submitReplBuffer(
	session: SessionContext,
	processorId: string,
	lines: string[],
): Promise<HiseResponse | null> {
	if (!session.connection) return null;
	const body = lines.join("\n");
	const expression = `(function(){\n${body}\n})()`;
	return session.connection.post("/api/repl", {
		expression,
		moduleId: processorId,
	});
}

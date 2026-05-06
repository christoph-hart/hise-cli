// ── Parse-phase validation — multi-recovery error collection ────────
//
// Walks ScriptLine[] simulating mode transitions to validate each line
// in context. Collects all errors rather than failing on the first one.

import type { ModeId } from "../modes/mode.js";
import { SLASH_MODE_IDS } from "../modes/mode.js";
import type { Session } from "../session.js";
import type { ParsedScript, ParseError, ValidationResult } from "./types.js";
import { parseExpect, parseWait } from "./parser.js";
import { parseBuilderInput } from "../modes/builder.js";

const MODE_IDS = SLASH_MODE_IDS;

/** Slash commands that are valid tool commands (no mode needed). */
const TOOL_COMMANDS = new Set<string>([
	"wait", "expect", "run", "parse",
]);

/** Slash commands that are always valid. */
const BUILTIN_COMMANDS = new Set<string>([
	"exit", "quit", "help", "modes", "connect",
	"wizard", "compact",
]);

/**
 * Validate a parsed script without executing it.
 *
 * Simulates mode transitions and validates:
 * - Mode commands are not issued in root mode
 * - /expect and /wait have valid syntax
 * - Slash commands reference known commands
 * - Builder commands parse correctly (via Chevrotain, if in builder mode)
 *
 * Some modes (script REPL) can't validate without execution —
 * for those, validation is limited to "we're in the right mode".
 */
export function validateScript(
	script: ParsedScript,
	session: Session,
): ValidationResult {
	const errors: ParseError[] = [];
	let currentModeId: ModeId = "root";
	const modeStack: ModeId[] = ["root"];

	for (const line of script.lines) {
		if (line.kind === "slash") {
			const cmd = extractSlashName(line.content);

			if (cmd.name === "compile" && currentModeId === "script" && !cmd.args) {
				continue;
			}

			if (cmd.name === "callback") {
				if (currentModeId !== "script") {
					errors.push({
						line: line.lineNumber,
						message: "/callback requires script mode",
					});
				}
				continue;
			}

			// Mode entry
			if (MODE_IDS.has(cmd.name)) {
				const modeId = (cmd.name === "export" ? "compile" : cmd.name) as ModeId;
				if (cmd.args) {
					// One-shot: validate the command in that mode's context
					validateModeCommand(cmd.args, modeId, line.lineNumber, session, errors);
				} else {
					// Enter mode
					modeStack.push(modeId);
					currentModeId = modeId;
				}
				continue;
			}

			// /exit
			if (cmd.name === "exit") {
				if (modeStack.length <= 1) {
					errors.push({ line: line.lineNumber, message: "/exit at root level — nothing to exit" });
				} else {
					modeStack.pop();
					currentModeId = modeStack[modeStack.length - 1]!;
				}
				continue;
			}

			// Tool commands
			if (cmd.name === "wait") {
				const parsed = parseWait(cmd.args);
				if (typeof parsed === "string") {
					errors.push({ line: line.lineNumber, message: parsed });
				}
				continue;
			}

			if (cmd.name === "expect") {
				const parsed = parseExpect(cmd.args);
				if (typeof parsed === "string") {
					errors.push({ line: line.lineNumber, message: parsed });
				}
				continue;
			}

			// Known builtins and tool commands — always valid
			if (BUILTIN_COMMANDS.has(cmd.name) || TOOL_COMMANDS.has(cmd.name)) {
				continue;
			}

			// Check if it's a registered command (wizard aliases, etc.)
			if (session.registry.has(cmd.name)) {
				continue;
			}

			errors.push({
				line: line.lineNumber,
				message: `Unknown command: /${cmd.name}`,
			});
			continue;
		}

		// AI line: resolution is dynamic and depends on live HISE state +
		// model output, so static validation can only check that the host
		// mode supports AI dispatch.
		if (line.kind === "ai") {
			if (currentModeId !== "builder" && currentModeId !== "ui" && currentModeId !== "dsp") {
				errors.push({
					line: line.lineNumber,
					message: `?-lines require builder/ui/dsp mode (current: ${currentModeId})`,
				});
			}
			continue;
		}

		// Mode-specific command (no slash)
		if (currentModeId === "root") {
			errors.push({
				line: line.lineNumber,
				message: `Command "${line.content}" requires a mode — enter a mode first (e.g., /builder, /script)`,
			});
			continue;
		}

		// Validate in the context of the current mode
		validateModeCommand(line.content, currentModeId, line.lineNumber, session, errors);
	}

	return {
		ok: errors.length === 0,
		errors,
	};
}

/**
 * Validate a single command in the context of a specific mode.
 * Uses the mode's parser for syntax validation where possible.
 */
function validateModeCommand(
	input: string,
	modeId: ModeId,
	lineNumber: number,
	_session: Session,
	errors: ParseError[],
): void {
	// For builder mode, run full Chevrotain parse (lexer + parser).
	// This catches syntax errors that tokenization alone misses.
	// Semantic validation (module existence, parameter ranges) is
	// deferred to the live dry-run which has the actual module tree.
	if (modeId === "builder") {
		// Skip navigation commands — they don't go through the parser
		const first = input.split(/\s/)[0]?.toLowerCase();
		if (first === "cd" || first === "ls" || first === "pwd" || first === "reset") {
			return;
		}
		const result = parseBuilderInput(input);
		if ("error" in result) {
			errors.push({ line: lineNumber, message: result.error });
		}
		return;
	}

	// For script, undo, dsp, etc. — we can't validate without execution.
	// Just check that we're in a mode (already handled above).
}

// ── Formatting ──────────────────────────────────────────────────────

/**
 * Format validation errors into a human-readable report.
 */
export function formatValidationReport(result: ValidationResult): string {
	if (result.ok) {
		return "Validation passed — no errors found.";
	}

	const lines = result.errors.map(
		(e) => `  line ${e.line}: ${e.message}`,
	);
	return `Validation found ${result.errors.length} error(s):\n${lines.join("\n")}`;
}

// ── Helpers ─────────────────────────────────────────────────────────

function extractSlashName(content: string): { name: string; args: string } {
	const withoutSlash = content.slice(1);
	// Handle dot-notation: /builder.context → name="builder"
	const dotIdx = withoutSlash.indexOf(".");
	const spaceIdx = withoutSlash.indexOf(" ");

	let nameEnd: number;
	if (dotIdx !== -1 && (spaceIdx === -1 || dotIdx < spaceIdx)) {
		nameEnd = dotIdx;
	} else if (spaceIdx !== -1) {
		nameEnd = spaceIdx;
	} else {
		nameEnd = withoutSlash.length;
	}

	const name = withoutSlash.slice(0, nameEnd);
	const args = withoutSlash.slice(nameEnd).trim();

	// If args starts with a dot, it's dot-notation context — still part of args
	return { name, args };
}

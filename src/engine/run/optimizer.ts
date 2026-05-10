// ── Builder batch optimizer — minimize HTTP requests ────────────────
//
// Scans parsed script lines and merges consecutive builder-mode commands
// into single comma-chained lines. This leverages the builder's existing
// comma-chaining support to batch operations into one API call.
//
// Segment boundaries are forced by:
// - Mode switches (/builder, /script, etc.)
// - Tool commands (/wait, /expect, /midi)
// - /undo plan / /undo apply
// - /exit
// - cd commands (change relative path context)
// - Navigation commands (ls, pwd, reset)

import type { ParsedScript, ScriptLine } from "./types.js";
import { SLASH_MODE_IDS, type ModeId } from "../modes/mode.js";

/** Commands that force a segment boundary (can't be batched). */
const BOUNDARY_PREFIXES = ["cd ", "cd\t", "ls", "pwd", "reset"];

/**
 * Optimize a parsed script by merging consecutive batchable builder
 * commands into comma-chained single lines.
 *
 * Only operates on mode-command lines (non-slash) that appear while
 * the virtual mode is "builder". Slash commands are never merged.
 */
export interface OptimizeScriptOptions {
	initialMode?: ModeId;
}

export function optimizeScript(script: ParsedScript, options: OptimizeScriptOptions = {}): ParsedScript {
	const result: ScriptLine[] = [];
	let currentMode: string = options.initialMode ?? "root";
	let batch: ScriptLine[] = [];
	let batchVerb: string | null = null;

	const flushBatch = () => {
		if (batch.length === 0) return;
		if (batch.length === 1) {
			result.push(batch[0]!);
		} else {
			// Merge into a single comma-chained line
			const merged: ScriptLine = {
				lineNumber: batch[0]!.lineNumber,
				raw: batch.map((l) => l.raw).join("\n"),
				content: mergeBatchContent(batch, batchVerb!),
				kind: "command",
			};
			result.push(merged);
		}
		batch = [];
		batchVerb = null;
	};

	for (const line of script.lines) {
		if (line.kind === "slash") {
			flushBatch();

			// Track mode transitions
			const cmd = extractSlashName(line.content);
			if (isModeCommand(cmd)) {
				if (!cmd.args) {
					// Entering mode
					currentMode = cmd.name;
				}
				// One-shot mode commands are not batchable
			} else if (cmd.name === "exit") {
				currentMode = "root";
			}

			result.push(line);
			continue;
		}

		// AI lines never batch — each needs its own LLM round-trip + dispatch.
		if (line.kind === "ai") {
			flushBatch();
			result.push(line);
			continue;
		}

		// Mode-specific command
		const verb = currentMode === "builder" ? batchableVerb(line.content) : null;
		if (verb) {
			if (batchVerb && batchVerb !== verb) flushBatch();
			batchVerb = verb;
			batch.push(line);
		} else {
			flushBatch();
			result.push(line);
		}
	}

	flushBatch();
	return { lines: result };
}

/**
 * Return the builder verb if this line can be safely comma-batched with
 * other clauses of the same verb. Mixed verbs must remain separate lines.
 */
function batchableVerb(content: string): string | null {
	const lower = content.toLowerCase();
	for (const prefix of BOUNDARY_PREFIXES) {
		if (lower === prefix.trimEnd() || lower.startsWith(prefix)) {
			return null;
		}
	}
	const match = lower.match(/^([a-z_][a-z0-9_]*)\b/);
	const verb = match?.[1] ?? null;
	if (!verb) return null;
	if (verb === "add" && /\sto\s/.test(lower)) return null;
	return ["add", "set", "get", "remove"].includes(verb) ? verb : null;
}

function mergeBatchContent(batch: ScriptLine[], verb: string): string {
	return batch.map((line, index) => {
		if (index === 0) return line.content;
		return line.content.replace(new RegExp(`^${verb}\\s+`, "i"), "");
	}).join(", ");
}

const MODE_IDS = SLASH_MODE_IDS;

function isModeCommand(cmd: { name: string; args: string }): boolean {
	return MODE_IDS.has(cmd.name);
}

function extractSlashName(content: string): { name: string; args: string } {
	const withoutSlash = content.slice(1);
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

	return {
		name: withoutSlash.slice(0, nameEnd),
		args: withoutSlash.slice(nameEnd).trim(),
	};
}

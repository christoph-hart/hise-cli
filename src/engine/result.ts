// ── CommandResult — engine output contract ──────────────────────────

// Pure data types that both TUI and CLI frontends consume.
// TUI renders them visually; CLI serializes them as JSON.

import type { WizardDefinition, WizardAnswers } from "./wizard/types.js";
import type { RunResult } from "./run/types.js";

export interface TreeNode {
	label: string;
	type?: string;
	children?: TreeNode[];
	/** Unique path identifier for selection tracking (e.g. "Master.Gain Modulation.LFO") */
	id?: string;
	/** Whether this node is a module or a chain container */
	nodeKind?: "module" | "chain";
	/** For chain nodes: constrainer pattern controlling what subtypes are accepted
	 *  (e.g. "*", "VoiceStartModulator", "MasterEffect"). See docs/MODULE_TREE.md. */
	chainConstrainer?: string;
	/** Hex color for the dot indicator. Set by the data pipeline (builder propagates
	 *  chain colors to children). undefined = no dot rendered. */
	colour?: string;
	/** Dot style: true = ● (filled, modules), false = ○ (unfilled, chains).
	 *  undefined = no dot rendered (sound generators not in a chain). */
	filledDot?: boolean;
	/** When true, the node's label and dot are rendered in muted/dimmed color.
	 *  Used for empty chains (no children) and bypassed modules. */
	dimmed?: boolean;
	/** Diff status for visual indicators in the tree sidebar.
	 *  "added" (green +) and "removed" (red -) propagate to all children.
	 *  "modified" (amber *) does not propagate. Set by the data pipeline. */
	diff?: "added" | "removed" | "modified";
	/** When true and layout.sidebarTopMargin is enabled, the tree sidebar
	 *  renders a blank continuation-connector row above this node. Each mode
	 *  decides which nodes get top margin (builder: sound generators,
	 *  script: class nodes, dsp: container nodes). Set by the data pipeline. */
	topMargin?: boolean;
	/** Optional suffix badge rendered after the label (e.g. ★ for saveInPreset).
	 *  Displayed in the given colour. Truncation removes label text before badge. */
	badge?: { text: string; colour: string };
}

export type CommandResult =
	| { type: "text"; content: string; accent?: string }
	| { type: "error"; message: string; detail?: string; accent?: string }
	| { type: "code"; content: string; language?: string; accent?: string }
	| { type: "table"; headers: string[]; rows: string[][]; accent?: string }
	| { type: "markdown"; content: string; accent?: string }
	| { type: "wizard"; definition: WizardDefinition; prefill: WizardAnswers; autoRun: boolean; accent?: string }
	| { type: "run-report"; source: string; runResult: RunResult; verbosity: import("./run/executor.js").RunReportVerbosity; accent?: string }
	| { type: "preformatted"; content: string; accent?: string; plain?: boolean }
	| { type: "json"; value: unknown; fallbackText?: string; accent?: string }
	| { type: "empty"; accent?: string };

// ── Result factory helpers ──────────────────────────────────────────

export function textResult(content: string): CommandResult {
	return { type: "text", content };
}

export function errorResult(
	message: string,
	detail?: string,
): CommandResult {
	return { type: "error", message, detail };
}

export function codeResult(
	content: string,
	language?: string,
): CommandResult {
	return { type: "code", content, language };
}

export function tableResult(
	headers: string[],
	rows: string[][],
): CommandResult {
	return { type: "table", headers, rows };
}

export function markdownResult(content: string): CommandResult {
	return { type: "markdown", content };
}

export function wizardResult(
	definition: WizardDefinition,
	prefill: WizardAnswers = {},
	autoRun = false,
): CommandResult {
	return { type: "wizard", definition, prefill, autoRun, accent: "#e8a060" };
}

export function runReportResult(
	source: string,
	runResult: RunResult,
	verbosity: import("./run/executor.js").RunReportVerbosity = "verbose",
): CommandResult {
	return { type: "run-report", source, runResult, verbosity };
}

export function preformattedResult(content: string, accent?: string, plain?: boolean): CommandResult {
	return { type: "preformatted", content, accent, plain };
}

/** Structured JSON result. CLI --json mode emits `value` directly; TUI falls
 *  back to `fallbackText` when present, otherwise pretty-prints `value`. */
export function jsonResult(value: unknown, fallbackText?: string): CommandResult {
	return { type: "json", value, fallbackText };
}

export function emptyResult(): CommandResult {
	return { type: "empty" };
}

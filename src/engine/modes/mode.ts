// ── Mode interface — domain-specific input parsing ──────────────────

import type { CommandResult, TreeNode } from "../result.js";
import type { TokenSpan } from "../highlight/tokens.js";

// Re-export shared constants. Source of truth lives in the highlighter
// directory (src/engine/highlight/constants.ts) so the highlighter can
// be exported verbatim to external consumers.
export { MODE_ACCENTS, SLASH_MODE_IDS } from "../highlight/constants.js";

export type ModeId =
	| "root"
	| "builder"
	| "script"
	| "dsp"
	| "sampler"
	| "inspect"
	| "project"
	| "compile"
	| "undo"
	| "wizard"
	| "ui"
	| "sequence"
	| "hise"
	| "analyse"
	| "publish"
	| "assets"
	| "api";

export interface CompletionItem {
	label: string;
	detail?: string;
	insertText?: string;
}

export interface CompletionResult {
	items: CompletionItem[];
	from: number;
	to: number;
	/** Displayed as a header row in the completion popup (e.g. "Slash commands") */
	label?: string;
}

// Minimal session interface that modes depend on.
// The full Session class implements this. Avoids circular imports.
export interface SessionContext {
	readonly connection: import("../hise.js").HiseConnection | null;
	/** HISE project name (set on initial connection or after /hise launch). */
	projectName?: string | null;
	/** HISE project folder (set on initial connection or after /hise launch). */
	projectFolder?: string | null;
	/** Host process working directory. Used by `/project switch ./` and other
	 *  CWD-relative resolutions in the engine layer. */
	cwd?: string | null;
	/** True when the snippet browser (a second HISE instance) is the active backend.
	 *  Mirrors `/api/status`'s `activeIsSnippetBrowser`. Null until the first probe. */
	playgroundActive?: boolean | null;
	/** Exit the current mode (pops the mode stack). At root, signals quit. */
	popMode(): import("../result.js").CommandResult;
	/** Invalidate all cached mode trees — call after undo/redo operations. */
	invalidateAllTrees?(): void;
	/** Reset the undo mode's local plan tracking state (HISE discards groups on reset). */
	resetPlanState?(): void;
	/** Clear transient script compiler state for a processor. */
	clearScriptCompilerState?(processorId: string): void;
	/** Clear all transient script compiler state. */
	clearAllScriptCompilerState?(): void;
	/** Set the active callback target for transient script compilation. */
	setActiveScriptCallback?(processorId: string, callbackId: string): void;
	/** Append a raw body line to the active callback buffer. */
	appendScriptCallbackLine?(processorId: string, line: string): boolean;
	/** Return the active callback target for a processor, if any. */
	getActiveScriptCallback?(processorId: string): string | null;
	/** Return collected callback source by callback id. */
	getCollectedScriptCallbacks?(processorId: string): Record<string, string>;

	// ── /capture buffer hooks (Console output assertion) ───────────
	/** Open a Console.print capture buffer for a processor. */
	startCapture?(processorId: string): void;
	/** Append a non-slash line to the active capture buffer. Returns false if not capturing. */
	appendCaptureLine?(processorId: string, line: string): boolean;
	/** Read the buffered lines for a processor. Empty if not capturing. */
	getCaptureBuffer?(processorId: string): string[];
	/** Close and discard the capture buffer for a processor. */
	clearCapture?(processorId: string): void;
	/** True iff a capture buffer is open for the processor. */
	isCapturing?(processorId: string): boolean;
	/** Discard all capture buffers (called on script-mode entry/exit). */
	clearAllCaptureBuffers?(): void;
	/** Logs from the most recent /api/repl call, populated by ScriptMode.parse. */
	lastReplLogs?: string[];

	/** Resolve a file path against the project folder. Absolute paths pass through. */
	resolvePath?(filePath: string): string;

	/** Dispatch a slash command through the regular session pipeline. Lets modes
	 *  forward to other handlers (e.g. /project export -> /wizard run <id>) without
	 *  duplicating logic. */
	handleInput?(raw: string): Promise<import("../result.js").CommandResult>;

	// ── Project mode hooks ──────────────────────────────────────────
	/** Wizard registry — used by /project create to launch the new_project wizard. */
	readonly wizardRegistry?: import("../wizard/registry.js").WizardRegistry | null;
	/** Mark the project tree as needing a refetch on the next read. Cross-mode
	 *  mutators (script save/recompile, builder/dsp/ui apply, sampler save_map,
	 *  preset save) call this after a successful state change. */
	markProjectTreeDirty?(): void;
	/** Copy text to the host's clipboard. Wired by the TUI via OSC 52; CLI uses stdout. */
	copyToClipboard?(text: string): void;
	/** Read text from the host's clipboard. Returns null when unavailable. */
	readClipboard?(): Promise<string | null>;
	// ── File I/O hooks for /analyse mode ────────────────────────────
	readBinaryFile?(path: string): Promise<Uint8Array>;
	writeTextFile?(path: string, content: string): Promise<void>;
	listDirectory?(dir: string): Promise<Array<{ name: string; isDir: boolean }>>;
	/** Resolve HISE project folder from projects.xml (works without HISE running). */
	resolveHiseProjectFolder?(): Promise<string | null>;
}

export interface Mode {
	readonly id: ModeId;
	readonly name: string;
	readonly accent: string;
	readonly prompt: string;
	/** Dynamic context path (e.g. "SineGenerator.pitch" in builder mode) */
	readonly contextLabel?: string;
	parse(input: string, session: SessionContext): Promise<CommandResult>;
	complete?(input: string, cursor: number): CompletionResult;
	/** Tokenize input for syntax highlighting. Returns spans with token types. */
	tokenizeInput?(value: string): TokenSpan[];

	// ── Context entry (Phase 3.5.3) ─────────────────────────────
	/** Set the mode's context path (e.g., builder's currentPath, script's processor ID).
	 *  Called by dot-notation mode entry (/builder.SineGenerator.pitch) to navigate
	 *  to a specific location before entering the mode or executing a one-shot command. */
	setContext?(path: string): void;

	// ── Tree sidebar support ────────────────────────────────────
	/** Return the mode's navigable tree hierarchy, or null if the mode has no tree. */
	getTree?(): TreeNode | null;
	/** Return the currently selected path in the tree (array of node ids). */
	getSelectedPath?(): string[];
	/** Navigate to a node by path (called when the user selects a tree node). */
	selectNode?(path: string[]): void;

	/** Mark the mode's cached tree as stale so it re-fetches on next use.
	 *  Called by the session after one-shot undo commands change shared state. */
	invalidateTree?(): void;

	/** Called when the mode is entered (pushed onto stack). Async to allow data fetching. */
	onEnter?(session: SessionContext): Promise<void>;
	/** Called when the mode is exited (popped from stack). */
	onExit?(session: SessionContext): void;
}

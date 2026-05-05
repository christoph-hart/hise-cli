// ── Session — core state container ──────────────────────────────────

// Both TUI and CLI frontends consume Session. Class with thin methods
// delegating to pure functions for testability.

import type { HiseConnection } from "./hise.js";
import type { CommandResult } from "./result.js";
import { errorResult, textResult } from "./result.js";
import type { CompletionResult, Mode, SessionContext } from "./modes/mode.js";
import { RootMode } from "./modes/root.js";
import {
	CommandRegistry,
	type CommandSession,
} from "./commands/registry.js";
import { registerBuiltinCommands } from "./commands/slash.js";
import type { CompletionEngine } from "./completion/engine.js";
import type { WizardRegistry } from "./wizard/registry.js";
import type { WizardHandlerRegistry } from "./wizard/handler-registry.js";
import type { WizardAnswers } from "./wizard/types.js";

/** Snapshot of a wizard whose task sequence halted mid-flight, kept on the
 *  session so the user can run `/resume` after fixing the underlying issue. */
export interface PendingWizard {
	readonly wizardId: string;
	readonly answers: WizardAnswers;
	/** Index of the task that failed — resume restarts here. */
	readonly nextTaskIndex: number;
	/** Human-readable label of the failed task for the resume hint. */
	readonly failedTaskLabel: string;
}

// ── Path classification helpers ─────────────────────────────────────

/** True when path begins with `/`, drive letter (`C:/`, `C:\`). */
export function isAbsolutePath(filePath: string): boolean {
	return filePath.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(filePath);
}

/** True when path begins with `./`, `../`, `.\`, or `..\` — explicit
 *  CWD-relative form, mirroring POSIX shell convention. */
export function isExplicitRelative(filePath: string): boolean {
	return /^\.\.?[/\\]/.test(filePath);
}

// ── Mode factory registry ───────────────────────────────────────────

// Maps mode identifiers (e.g. "script", "script:Interface") to factory
// functions that create Mode instances. Session uses this to instantiate
// modes when pushMode is called from slash command handlers.

export type ModeFactory = (context: string | undefined) => Mode;

interface ScriptCompilerState {
	activeCallback: string | null;
	callbacks: Map<string, string[]>;
}

// ── Session class ───────────────────────────────────────────────────

export class Session implements SessionContext, CommandSession {
	readonly modeStack: Mode[];
	readonly history: string[] = [];
	readonly connection: HiseConnection | null;
	readonly registry: CommandRegistry;
	readonly completionEngine: CompletionEngine | null;
	wizardRegistry: WizardRegistry | null = null;
	handlerRegistry: WizardHandlerRegistry | null = null;
	pendingWizard: PendingWizard | null = null;
	/** Header of the wizard currently executing, or null if none.
	 *  Read by status-bar renderers (TUI, web) to show "Running <header>" with a spinner. */
	activeWizard: string | null = null;
	/** Abort controller for the active wizard run. Esc in the TUI calls .abort(). */
	activeWizardAbort: AbortController | null = null;
	/** Render-tick counter — bumped when activeWizard changes so React TUI re-renders the status bar. */
	activeWizardTick = 0;
	projectName: string | null = null;
	projectFolder: string | null = null;
	/** Current working directory the host process started in. Set by the
	 *  platform bootstrap (`process.cwd()`) so the engine can resolve `./`
	 *  paths without importing `node:`. Falls back to "." when unset. */
	cwd: string | null = null;
	playgroundActive: boolean | null = null;
	loadScriptFile?: (filePath: string) => Promise<string>;
	saveScriptFile?: (filePath: string, content: string) => Promise<void>;
	globScriptFiles?: (pattern: string) => Promise<string[]>;

	// ── File I/O hooks for /analyse mode ────────────────────────────
	readBinaryFile?: (path: string) => Promise<Uint8Array>;
	writeTextFile?: (path: string, content: string) => Promise<void>;
	listDirectory?: (dir: string) => Promise<Array<{ name: string; isDir: boolean }>>;
	resolveHiseProjectFolder?: () => Promise<string | null>;
	onWizardProgress?: (progress: import("./wizard/types.js").WizardProgress) => void;

	// ── Clipboard hooks (wired by TUI; CLI uses stdout for snippet export) ──
	copyToClipboard?: (text: string) => void;
	readClipboard?: () => Promise<string | null>;

	setPendingWizard(pending: PendingWizard | null): void {
		this.pendingWizard = pending;
	}

	clearPendingWizard(): void {
		this.pendingWizard = null;
	}

	/** Mark a wizard as actively running. Triggers status-bar spinner in the TUI. */
	setActiveWizard(header: string, abort: AbortController): void {
		this.activeWizard = header;
		this.activeWizardAbort = abort;
		this.activeWizardTick++;
	}

	/** Clear the active wizard marker. Called in the finally block of every run. */
	clearActiveWizard(): void {
		this.activeWizard = null;
		this.activeWizardAbort = null;
		this.activeWizardTick++;
	}

	/** Stack of script files currently executing (recursion guard). */
	readonly scriptStack: string[] = [];

	/** Cached list of .hsc file paths (relative) for /edit and /run completion. */
	scriptFileCache: string[] = [];

	/** Refresh the script file cache. Requires globScriptFiles to be wired. */
	async refreshScriptFileCache(): Promise<void> {
		if (!this.globScriptFiles) return;
		try {
			const files = await this.globScriptFiles("*.hsc");
			// Normalize to forward slashes and strip project folder prefix for relative paths
			const base = this.projectFolder
				? this.projectFolder.replace(/\\/g, "/") + "/"
				: "";
			this.scriptFileCache = files.map(f => {
				const norm = f.replace(/\\/g, "/");
				return base && norm.startsWith(base) ? norm.slice(base.length) : norm;
			}).sort();
		} catch { /* ignore — cache stays empty */ }
	}

	/** Resolve a file path.
	 *
	 *  - Absolute paths (POSIX `/foo`, Windows `C:/foo` or `C:\foo`) pass through.
	 *  - Explicit-relative paths starting with `./`, `../`, `.\`, `..\` are
	 *    returned as-is, signalling CWD-relative resolution to the I/O layer.
	 *  - Bare-relative paths are joined with `projectFolder` when available;
	 *    when no project is connected, the path is returned as-is and the
	 *    caller decides whether to abort or fall through to CWD. */
	resolvePath(filePath: string): string {
		if (isAbsolutePath(filePath)) return filePath;
		if (isExplicitRelative(filePath)) return filePath;
		if (this.projectFolder) {
			return this.projectFolder + "/" + filePath;
		}
		return filePath;
	}

	/** @deprecated Use resolvePath() instead. */
	resolveScriptPath(filePath: string): string {
		return this.resolvePath(filePath);
	}

	private readonly modeFactories = new Map<string, ModeFactory>();
	private readonly modeCache = new Map<string, Mode>();
	private readonly scriptCompilerStates = new Map<string, ScriptCompilerState>();
	private readonly captureBuffers = new Map<string, string[]>();
	/** Most recent log buffer — populated by ScriptMode.parse (REPL),
	 *  submitReplBuffer (/capture flush), and compileCallbacks (/compile).
	 *  Read by /expect <expr> logs <values> and /expect-logs. */
	lastLogs: string[] = [];

	// Signal for TUI to handle quit
	private quitRequested = false;

	constructor(
		connection: HiseConnection | null = null,
		completionEngine?: CompletionEngine,
	) {
		this.connection = connection;
		this.completionEngine = completionEngine ?? null;
		this.modeStack = [new RootMode()];
		this.registry = new CommandRegistry();
		registerBuiltinCommands(this.registry);

		// Feed slash commands into the completion engine
		if (this.completionEngine) {
			this.completionEngine.setSlashCommands(this.registry.all());
		}
	}

	// ── Mode factory registration ───────────────────────────────────

	registerMode(id: string, factory: ModeFactory): void {
		this.modeFactories.set(id, factory);
	}

	// ── Mode instance cache ─────────────────────────────────────────

	getOrCreateMode(modeId: string): Mode {
		let mode = this.modeCache.get(modeId);
		if (!mode) {
			const colonIndex = modeId.indexOf(":");
			const baseId = colonIndex === -1 ? modeId : modeId.slice(0, colonIndex);
			const context = colonIndex === -1 ? undefined : modeId.slice(colonIndex + 1);

			const factory = this.modeFactories.get(baseId);
			if (!factory) {
				throw new Error(`Mode "${baseId}" is not registered`);
			}

			mode = factory(context);
			this.modeCache.set(modeId, mode);
		}
		return mode;
	}

	/** Invalidate all cached mode trees — called after undo operations
	 *  which can affect any domain (builder, ui). */
	invalidateAllTrees(): void {
		for (const mode of this.modeCache.values()) {
			mode.invalidateTree?.();
		}
	}

	/** Signal that filesystem state has changed — invalidates the cached
	 *  /project tree so the next read refetches from HISE. Called by
	 *  cross-mode mutators (builder/dsp/ui apply, script save/recompile,
	 *  sampler save_map / import, presets save) and by the project mode
	 *  itself after save/load/switch/set/snippet load. */
	markProjectTreeDirty(): void {
		const projectMode = this.modeCache.get("project");
		projectMode?.invalidateTree?.();
	}

	/** Reset the undo mode's local plan tracking state. */
	resetPlanState(): void {
		const undoMode = this.modeCache.get("undo");
		if (undoMode && "resetPlanState" in undoMode) {
			(undoMode as import("./modes/undo.js").UndoMode).resetPlanState();
		}
	}

	// ── Mode stack ──────────────────────────────────────────────────

	currentMode(): Mode {
		return this.modeStack[this.modeStack.length - 1];
	}

	get modeStackDepth(): number {
		// Root mode doesn't count
		return this.modeStack.length - 1;
	}

	get currentModeId(): string {
		return this.currentMode().id;
	}

	allCommands(): import("./commands/registry.js").CommandEntry[] {
		return this.registry.all();
	}

	// Called by slash command handlers via CommandSession interface.
	// Returns null on success, or a CommandResult error.
	pushMode(modeId: string): CommandResult | null {
		const colonIndex = modeId.indexOf(":");
		const baseId = colonIndex === -1 ? modeId : modeId.slice(0, colonIndex);

		const factory = this.modeFactories.get(baseId);
		if (!factory) {
			return errorResult(
				`Mode "${baseId}" is not registered. Available modes: ${[...this.modeFactories.keys()].join(", ") || "(none)"}`,
			);
		}

		const mode = this.getOrCreateMode(modeId);
		this.modeStack.push(mode);
		return null;
	}

	// Called by /exit handler via CommandSession interface.
	// If silent is true, returns empty result instead of exit message.
	popMode(silent?: boolean): CommandResult {
		if (this.modeStack.length <= 1) {
			// At root — signal quit
			this.quitRequested = true;
			return textResult("Goodbye.");
		}
		const popped = this.modeStack.pop()!;
		popped.onExit?.(this);
		if (silent) {
			return { type: "empty" };
		}
		return textResult(`Exited ${popped.name} mode.`);
	}

	requestQuit(): void {
		this.quitRequested = true;
	}

	get shouldQuit(): boolean {
		return this.quitRequested;
	}

	// ── One-shot execution ──────────────────────────────────────────

	async executeOneShot(modeId: string, input: string): Promise<CommandResult> {
		const activeMode = this.currentMode(); // save reference before push
		const mode = this.getOrCreateMode(modeId);
		this.modeStack.push(mode);
		await mode.onEnter?.(this);
		// Slash commands inside one-shot dispatch through the registry
		// (e.g. /script /compile → registry handles /compile while in script mode)
		const result = input.startsWith("/")
			? await this.registry.dispatch(input, this)
			: await mode.parse(input, this);
		this.popMode(true); // Silent pop

		// After undo one-shot, invalidate all cached mode trees and eagerly
		// re-fetch the active mode's tree so getTree() returns fresh data.
		if (modeId === "undo") {
			this.invalidateAllTrees();
			// Re-run ensureTree by triggering a parse-like flow on the active mode
			if (activeMode.onEnter && this.connection) {
				await activeMode.onEnter(this);
			}
		}

		// Tag the result with the mode's accent so the TUI can use it for output borders
		if (result.type !== "empty") {
			result.accent = mode.accent;
		}

		return result;
	}

	clearScriptCompilerState(processorId: string): void {
		this.scriptCompilerStates.set(processorId, {
			activeCallback: null,
			callbacks: new Map(),
		});
	}

	clearAllScriptCompilerState(): void {
		this.scriptCompilerStates.clear();
	}

	setActiveScriptCallback(processorId: string, callbackId: string): void {
		let state = this.scriptCompilerStates.get(processorId);
		if (!state) {
			state = { activeCallback: null, callbacks: new Map() };
			this.scriptCompilerStates.set(processorId, state);
		}
		state.activeCallback = callbackId;
		state.callbacks.set(callbackId, []);
	}

	appendScriptCallbackLine(processorId: string, line: string): boolean {
		const state = this.scriptCompilerStates.get(processorId);
		if (!state?.activeCallback) {
			return false;
		}
		const lines = state.callbacks.get(state.activeCallback) ?? [];
		lines.push(line);
		state.callbacks.set(state.activeCallback, lines);
		return true;
	}

	getActiveScriptCallback(processorId: string): string | null {
		return this.scriptCompilerStates.get(processorId)?.activeCallback ?? null;
	}

	getCollectedScriptCallbacks(processorId: string): Record<string, string> {
		const state = this.scriptCompilerStates.get(processorId);
		if (!state) {
			return {};
		}
		return Object.fromEntries(
			[...state.callbacks.entries()].map(([callbackId, lines]) => [
				callbackId,
				lines.join("\n"),
			]),
		);
	}

	// ── /capture buffer (Console.print log assertion) ───────────────

	startCapture(processorId: string): void {
		this.captureBuffers.set(processorId, []);
	}

	appendCaptureLine(processorId: string, line: string): boolean {
		const buf = this.captureBuffers.get(processorId);
		if (!buf) return false;
		buf.push(line);
		return true;
	}

	getCaptureBuffer(processorId: string): string[] {
		return this.captureBuffers.get(processorId) ?? [];
	}

	clearCapture(processorId: string): void {
		this.captureBuffers.delete(processorId);
	}

	isCapturing(processorId: string): boolean {
		return this.captureBuffers.has(processorId);
	}

	clearAllCaptureBuffers(): void {
		this.captureBuffers.clear();
	}

	// ── Completion ─────────────────────────────────────────────────

	complete(input: string, cursor: number): CompletionResult {
		// Slash commands: check if we're completing mode arguments
		if (input.startsWith("/")) {
			// Pattern: /mode[.context] args
			// If there's a space after the mode name, delegate to that mode's completion
			const spaceIndex = input.indexOf(" ");
			if (spaceIndex > 0) {
				// Extract mode spec (e.g., "builder" or "script" from "/builder add" or "/script Interface")
				const modeSpec = input.slice(1, spaceIndex);
				const args = input.slice(spaceIndex + 1);
				
				// Try to resolve the mode (ignore dots for now, they're for context)
				const dotIndex = modeSpec.indexOf(".");
				const baseModeId = dotIndex === -1 ? modeSpec : modeSpec.slice(0, dotIndex);
				
				// /run and /edit: complete with .hsc files from cache
				if (baseModeId === "run" || baseModeId === "edit") {
					let prefix = args.replace(/^["']/, "");
					if (prefix.endsWith('"') || prefix.endsWith("'")) prefix = prefix.slice(0, -1);
					const items: CompletionResult["items"] = this.scriptFileCache
						.filter(f => f.toLowerCase().includes(prefix.toLowerCase()))
						.map(f => ({ label: f }));
					return {
						items,
						from: spaceIndex + 1,
						to: input.length,
						label: "Script files",
					};
				}

				// /expect: delegate command part to current mode's completion
				if (baseModeId === "expect") {
					const mode = this.currentMode();
					if (mode.complete) {
						// Only complete the command portion (before " is ")
						const isIdx = args.lastIndexOf(" is ");
						const commandPart = isIdx === -1 ? args : args.slice(0, isIdx);
						const commandCursor = isIdx === -1
							? cursor - (spaceIndex + 1)
							: Math.min(cursor - (spaceIndex + 1), commandPart.length);
						const result = mode.complete(commandPart, commandCursor);
						return {
							items: result.items,
							from: result.from + spaceIndex + 1,
							to: result.to + spaceIndex + 1,
							label: result.label,
						};
					}
				}

				if (baseModeId === "callback" && this.currentModeId === "script") {
					const mode = this.currentMode();
					if (mode.complete) {
						return mode.complete(input, cursor);
					}
				}

				// Check if this mode is registered
				if (this.modeFactories.has(baseModeId)) {
					try {
						const mode = this.getOrCreateMode(baseModeId);
						if (mode.complete) {
							// Delegate to mode's completion with adjusted cursor
							const adjustedCursor = cursor - (spaceIndex + 1);
							const result = mode.complete(args, adjustedCursor);
							// Shift the result positions back to absolute
							return {
								items: result.items,
								from: result.from + spaceIndex + 1,
								to: result.to + spaceIndex + 1,
								label: result.label,
							};
						}
					} catch {
						// Mode not registered, fall through to slash completion
					}
				}
			}
			
			// Normal slash command completion
			if (this.completionEngine) {
				return this.completionEngine.completeSlash(input);
			}
		}

		// Delegate to current mode's complete() if available
		const mode = this.currentMode();
		if (mode.complete) {
			return mode.complete(input, cursor);
		}

		return { items: [], from: 0, to: input.length };
	}

	// ── Input dispatch ──────────────────────────────────────────────

	async handleInput(raw: string): Promise<CommandResult> {
		const trimmed = raw.trim();
		if (trimmed === "") {
			return { type: "empty" };
		}

		// Record in history (deduplicate consecutive duplicates)
		if (
			this.history.length === 0 ||
			this.history[this.history.length - 1] !== trimmed
		) {
			this.history.push(trimmed);
		}

		// Slash commands are always dispatched to the registry
		if (trimmed.startsWith("/")) {
			return this.registry.dispatch(trimmed, this);
		}

		// Everything else goes to the current mode's parser
		return this.currentMode().parse(trimmed, this);
	}
}

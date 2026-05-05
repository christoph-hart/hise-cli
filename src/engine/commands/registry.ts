// ── CommandRegistry — slash command dispatch ─────────────────────────

import type { CommandResult } from "../result.js";
import { errorResult } from "../result.js";

// Forward reference to avoid circular imports with session.ts.
// The full Session class will satisfy this interface.
export interface CommandSession {
	pushMode(modeId: string): CommandResult | null;
	popMode(silent?: boolean): CommandResult;
	/** Force quit the application regardless of mode stack depth */
	requestQuit(): void;
	readonly modeStackDepth: number;
	readonly currentModeId: string;
	readonly connection: import("../hise.js").HiseConnection | null;
	readonly projectName: string | null;
	readonly projectFolder: string | null;
	readonly cwd: string | null;
	allCommands(): CommandEntry[];
	/** Get or create a cached mode instance (for one-shot execution and argument completion) */
	getOrCreateMode(modeId: string): import("../modes/mode.js").Mode;
	/** Execute a command in a mode without entering it (one-shot) */
	executeOneShot(modeId: string, input: string): Promise<CommandResult>;
	/** Wizard definitions registry (loaded from data/wizards/) */
	readonly wizardRegistry: import("../wizard/registry.js").WizardRegistry | null;
	/** Internal wizard handler registry (task + init functions) */
	readonly handlerRegistry: import("../wizard/handler-registry.js").WizardHandlerRegistry | null;
	/** Resolve a file path against the project folder. */
	resolvePath(filePath: string): string;
	/** @deprecated Use resolvePath() instead. */
	resolveScriptPath(filePath: string): string;
	/** Load a .hsc script file by path. Set by TUI/CLI layer. */
	loadScriptFile?(filePath: string): Promise<string>;
	/** Save a .hsc script file by path. Set by TUI/CLI layer. */
	saveScriptFile?(filePath: string, content: string): Promise<void>;
	/** Expand a glob pattern to matching file paths. Set by TUI/CLI layer. */
	globScriptFiles?(pattern: string): Promise<string[]>;
	/** Read a binary file. Set by TUI/CLI layer (for /analyse mode). */
	readBinaryFile?(path: string): Promise<Uint8Array>;
	/** Write a text file. Set by TUI/CLI layer (for /analyse mode). */
	writeTextFile?(path: string, content: string): Promise<void>;
	/** List directory entries. Set by TUI/CLI layer (for /analyse mode). */
	listDirectory?(dir: string): Promise<Array<{ name: string; isDir: boolean }>>;
	/** Resolve HISE project folder from projects.xml. */
	resolveHiseProjectFolder?(): Promise<string | null>;
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
	startCapture?(processorId: string): void;
	appendCaptureLine?(processorId: string, line: string): boolean;
	getCaptureBuffer?(processorId: string): string[];
	clearCapture?(processorId: string): void;
	isCapturing?(processorId: string): boolean;
	clearAllCaptureBuffers?(): void;
	/** Most recent log buffer (REPL / capture flush / compile). */
	lastLogs?: string[];
	/** Progress callback for `/wizard run` streaming. Always wired. */
	onWizardProgress?(progress: import("../wizard/types.js").WizardProgress): void;
	/** Snapshot of the most recently paused wizard (null when none). */
	pendingWizard?: import("../session.js").PendingWizard | null;
	/** Store/replace the paused-wizard checkpoint. */
	setPendingWizard?(pending: import("../session.js").PendingWizard | null): void;
	/** Clear the paused-wizard checkpoint. */
	clearPendingWizard?(): void;
	/** Header of the wizard currently executing (null if none). */
	activeWizard?: string | null;
	/** Abort controller for the active wizard run. */
	activeWizardAbort?: AbortController | null;
	/** Render tick — bumped when activeWizard changes; status bar reads this to re-render. */
	activeWizardTick?: number;
	/** Mark a wizard as actively running. */
	setActiveWizard?(header: string, abort: AbortController): void;
	/** Clear the active wizard marker. */
	clearActiveWizard?(): void;
	/** Mark the cached /project tree as stale — called by FS-mutating ops
	 *  in other modes so the project sidebar refreshes on next access. */
	markProjectTreeDirty?(): void;
}

export type CommandHandler = (
	args: string,
	session: CommandSession,
) => Promise<CommandResult>;

export interface CommandEntry {
	name: string;
	description: string;
	handler: CommandHandler;
	surfaces?: CommandSurface[];
	kind?: "command" | "mode";
	/** If set, this command cannot run in the web-embed bundle. The string
	 *  is the user-facing reason — surfaced as the "Run" button tooltip. */
	embedBlockedReason?: string;
}

export type CommandSurface = "tui" | "cli";

export function supportsSurface(
	entry: CommandEntry,
	surface: CommandSurface,
): boolean {
	return entry.surfaces ? entry.surfaces.includes(surface) : true;
}

export class CommandRegistry {
	private readonly commands = new Map<string, CommandEntry>();

	register(entry: CommandEntry): void {
		this.commands.set(entry.name, entry);
	}

	get(name: string): CommandEntry | undefined {
		return this.commands.get(name);
	}

	has(name: string): boolean {
		return this.commands.has(name);
	}

	all(): CommandEntry[] {
		return [...this.commands.values()];
	}

	names(): string[] {
		return [...this.commands.keys()];
	}

	async dispatch(
		input: string,
		session: CommandSession,
	): Promise<CommandResult> {
		// Input should start with /
		const trimmed = input.trim();
		if (!trimmed.startsWith("/")) {
			return errorResult("Not a slash command");
		}

		const withoutSlash = trimmed.slice(1);
		const spaceIndex = withoutSlash.indexOf(" ");
		const fullName =
			spaceIndex === -1
				? withoutSlash
				: withoutSlash.slice(0, spaceIndex);
		let args =
			spaceIndex === -1
				? ""
				: withoutSlash.slice(spaceIndex + 1).trim();

		// Dot-notation: split on first dot to separate command from context
		// e.g., "builder.SineGenerator" → name="builder", prepend ".SineGenerator" to args
		const dotIndex = fullName.indexOf(".");
		const name = dotIndex === -1 ? fullName : fullName.slice(0, dotIndex);
		const dotSuffix = dotIndex === -1 ? "" : fullName.slice(dotIndex);
		
		// Prepend dot-suffix to args
		if (dotSuffix) {
			args = dotSuffix + (args ? " " + args : "");
		}

		const entry = this.commands.get(name);
		if (!entry) {
			const suggestions = this.suggestCommand(name);
			const hint = suggestions.length > 0
				? ` Did you mean /${suggestions[0]}?`
				: "";
			return errorResult(`Unknown command: /${name}.${hint}`);
		}

		return entry.handler(args, session);
	}

	private suggestCommand(input: string): string[] {
		const names = this.names();
		// Simple prefix matching first
		const prefixMatches = names.filter((n) => n.startsWith(input));
		if (prefixMatches.length > 0) return prefixMatches.slice(0, 3);

		// Levenshtein fallback for typos
		return names
			.map((n) => ({ name: n, dist: levenshteinDistance(input, n) }))
			.filter((x) => x.dist <= 3)
			.sort((a, b) => a.dist - b.dist)
			.slice(0, 3)
			.map((x) => x.name);
	}
}

// Simple Levenshtein distance for typo suggestions
function levenshteinDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		Array(n + 1).fill(0) as number[],
	);

	for (let i = 0; i <= m; i++) dp[i][0] = i;
	for (let j = 0; j <= n; j++) dp[0][j] = j;

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[i][j] = Math.min(
				dp[i - 1][j] + 1,
				dp[i][j - 1] + 1,
				dp[i - 1][j - 1] + cost,
			);
		}
	}

	return dp[m][n];
}

// ── PhaseExecutor interface — platform-specific shell command execution ──
//
// Engine-layer interface (zero node: imports). Node.js implementation
// lives in src/tui/nodePhaseExecutor.ts.

/** Result of a spawned process. */
export interface SpawnResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Options for spawning a process. */
export interface SpawnOptions {
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	// `transient` is true when the line was emitted because of a bare CR (or
	// a cursor/erase CSI sequence) — i.e. the producing program intended to
	// redraw the current line in place. Consumers may render transient
	// lines as a single self-updating slot instead of appending.
	readonly onLog?: (line: string, transient?: boolean) => void;
	readonly signal?: AbortSignal;
	/** Temporarily yield terminal stdin to the child process. Node adapters may
	 *  reject this when running without a TTY or behind the web frontend. */
	readonly interactive?: boolean;
}

/** Platform-specific shell command executor. */
export interface PhaseExecutor {
	readonly supportsInteractive?: boolean;
	spawn(command: string, args: string[], options: SpawnOptions): Promise<SpawnResult>;
}

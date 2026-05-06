// ── Run system types — script runner & test framework ────────────────

/** A single parsed line from a .hsc script file. */
export interface ScriptLine {
	/** 1-based line number in the source file */
	lineNumber: number;
	/** Original text (for error messages) */
	raw: string;
	/** Trimmed text, ready to dispatch.
	 *  For kind="ai": the natural-language request (no leading `?`). */
	content: string;
	/** Whether this is a slash command, an AI prompt, or a mode-specific command */
	kind: "slash" | "command" | "ai";
}

/** Parsed .hsc script ready for validation/execution. */
export interface ParsedScript {
	lines: ScriptLine[];
}

/** A single parse-phase error (non-fatal, collected). */
export interface ParseError {
	line: number;
	message: string;
}

/** Result of parse-phase validation. */
export interface ValidationResult {
	ok: boolean;
	errors: ParseError[];
}

/** Verb tag for /expect-style assertions. */
export type ExpectVerb = "is" | "match" | "logs" | "throws" | "compile-throws" | "contains";

/** Result of a single /expect assertion. */
export interface ExpectResult {
	line: number;
	/** The command that was executed */
	command: string;
	/** Expected value (string representation) */
	expected: string;
	/** Actual value received */
	actual: string;
	passed: boolean;
	/** Float tolerance used (if numeric comparison) */
	tolerance?: number;
	/** Verb form. Defaults to "is" for legacy callers. */
	verb?: ExpectVerb;
	/** For "logs" verb: the actual log lines captured. */
	actualLines?: string[];
	/** For "throws" / "compile-throws": the captured error message (or "(no throw)"). */
	actualError?: string;
}

/** Per-command output collected during script execution. */
export interface CommandOutput {
	line: number;
	content: string;
	result: import("../result.js").CommandResult;
	/** Section label for grouped results (e.g. filename from nested /run) */
	label?: string;
	/** Mode accent color (set when flattening nested /run results) */
	accent?: string;
}

/** Result of a full script run. */
export interface RunResult {
	ok: boolean;
	linesExecuted: number;
	expects: ExpectResult[];
	/** Per-command results for rendering output */
	results: CommandOutput[];
	/** Set if execution was aborted by a runtime error or "or abort" */
	error?: { line: number; message: string };
}

/** Parsed /expect command (value comparison). */
export interface ParsedExpect {
	/** The command to execute in the current mode */
	command: string;
	/** Expected value to compare against */
	expected: string;
	/** Float tolerance (default 0.01) */
	tolerance: number;
	/** If true, abort the script on failure */
	abortOnFail: boolean;
	kind: "is";
}

/** Parsed /expect command (file match comparison). */
export interface ParsedExpectMatch {
	/** The command to execute in the current mode */
	command: string;
	/** Path to the reference file to compare against */
	referenceFile: string;
	/** If true, abort the script on failure */
	abortOnFail: boolean;
	kind: "match";
}

/** Parsed /expect command (Console.print log comparison). */
export interface ParsedExpectLogs {
	/** The command to execute in the current mode */
	command: string;
	/** Expected log lines (positional, ordered). */
	expectedLines: unknown[];
	/** Float tolerance for numeric line compare (default 0.01) */
	tolerance: number;
	/** If true, abort the script on failure */
	abortOnFail: boolean;
	kind: "logs";
}

/** Parsed /expect command (error throw assertion). */
export interface ParsedExpectThrows {
	/** The command to execute in the current mode */
	command: string;
	/** Substring pattern to match against the error message. */
	pattern: string;
	/** If true, abort the script on failure */
	abortOnFail: boolean;
	kind: "throws";
}

/** Parsed /expect command (substring match on success result). */
export interface ParsedExpectContains {
	/** The command to execute in the current mode */
	command: string;
	/** Substring pattern to match against the result value. */
	pattern: string;
	/** If true, abort the script on failure */
	abortOnFail: boolean;
	kind: "contains";
}

/** Parsed /wait command. */
export interface ParsedWait {
	/** Duration in milliseconds */
	ms: number;
}

/** Progress event emitted during streaming script execution. */
export type ScriptProgressEvent =
	| { type: "command"; output: CommandOutput }
	| { type: "expect"; result: ExpectResult }
	| { type: "error"; line: number; message: string };

/** Execution segment for the optimizer. */
export type ExecutionSegment =
	| { kind: "single"; line: ScriptLine }
	| { kind: "batch"; lines: ScriptLine[]; mode: "builder" };

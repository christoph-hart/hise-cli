import type { CommandEntry } from "../engine/commands/registry.js";

export type CliParseResult =
	| { kind: "tui"; args: string[] }
	| { kind: "help"; scope?: string }
	| { kind: "error"; message: string }
	| { kind: "diagnose"; filePath: string }
	| { kind: "run"; source: { type: "file"; path: string } | { type: "stdin" } | { type: "inline"; content: string }; dryRun: boolean; useMock: boolean; watch: boolean; verbosity: import("../engine/run/executor.js").RunReportVerbosity; output: CliOutputOptions }
	| { kind: "script-api"; command: ScriptApiCommand; useMock: boolean; output: CliOutputOptions }
	| { kind: "update"; check: boolean }
	| { kind: "version"; output: CliOutputOptions }
	| { kind: "status"; output: CliOutputOptions }
	| {
		kind: "execute";
		entry: CommandEntry;
		canonicalCommand: string;
		mode: string;
		useMock: boolean;
		stdin: boolean;
		output: CliOutputOptions;
	};

export interface CliOutputOptions {
	json: boolean;
	agent: boolean;
	compact: boolean;
	select?: string;
}

export type ScriptApiCommand =
	| { action: "repl"; moduleId: string; source: { type: "stdin" } }
	| { action: "get"; moduleId: string; callback?: string }
	| { action: "set"; moduleId: string; callback?: string; source: { type: "stdin" } | { type: "file"; path: string } | { type: "callbacks-json"; path: string }; compile: boolean }
	| { action: "compile"; moduleId: string };

const RESERVED_FLAGS = new Set(["--help", "-h", "--mock", "--dry-run", "--watch", "--show-keys", "--quiet", "--verbose", "--pretty", "--json", "--stdin", "--agent", "--compact", "--select"]);

const VALID_VERBOSITIES = new Set(["verbose", "summary", "quiet"]);

function parseVerbosityFlags(
	rest: string[],
): { verbosity: import("../engine/run/executor.js").RunReportVerbosity } | { error: string } {
	let verbosity: import("../engine/run/executor.js").RunReportVerbosity | null = null;
	let explicit = false;
	for (const arg of rest) {
		if (arg === "--quiet") {
			if (!explicit) verbosity = "quiet";
		} else if (arg === "--verbose") {
			if (!explicit) verbosity = "verbose";
		} else if (arg === "--verbosity" || arg.startsWith("--verbosity=")) {
			const eq = arg.indexOf("=");
			const value = eq === -1 ? null : arg.slice(eq + 1);
			if (!value) {
				return { error: "--verbosity requires a value: verbose | summary | quiet" };
			}
			if (!VALID_VERBOSITIES.has(value)) {
				return { error: `Invalid --verbosity value "${value}". Use verbose, summary, or quiet.` };
			}
			verbosity = value as import("../engine/run/executor.js").RunReportVerbosity;
			explicit = true;
		}
	}
	return { verbosity: verbosity ?? "summary" };
}

function stripVerbosityFlags(rest: string[]): string[] {
	return rest.filter((a) =>
		a !== "--quiet"
		&& a !== "--verbose"
		&& a !== "--verbosity"
		&& !a.startsWith("--verbosity="),
	);
}

/**
 * Reverse MSYS/git-bash path mangling on inline script content.
 * Git-bash on Windows converts leading `/word` in arguments to
 * `C:/Program Files/Git/word`. This undoes that for each line.
 * E.g. "C:/Program Files/Git/script" → "/script"
 */
/**
 * Strip a single matched pair of outer quotes (" or ') from an arg.
 * Git Bash on Windows can preserve the user's quotes inside argv, so
 * `-builder "show tree"` arrives here as the literal string `"show tree"`.
 * Only strips if the first and last char are the same quote — does not
 * touch args that contain quotes internally.
 */
function stripMatchedOuterQuotes(s: string): string {
	if (s.length < 2) return s;
	const first = s[0]!;
	const last = s[s.length - 1]!;
	if ((first === '"' || first === "'") && first === last) {
		return s.slice(1, -1);
	}
	return s;
}

function demangleMsys(content: string): string {
	// Only applies on Windows with MSYS-style paths
	return content.replace(
		/^([A-Z]:\/(?:Program Files|msys64)\/Git\/)(\S+)/gm,
		(_match, _prefix, rest) => `/${rest}`,
	);
}

function readFlagValue(args: string[], name: string): string | undefined {
	const eq = args.find((arg) => arg.startsWith(`${name}=`));
	if (eq) return eq.slice(name.length + 1);
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	return value && !value.startsWith("--") ? value : undefined;
}

function parseOutputOptions(args: string[]): { args: string[]; output: CliOutputOptions } | { error: string } {
	const stripped: string[] = [];
	let agent = false;
	let compact = false;
	let json = false;
	let select: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--agent") {
			agent = true;
			json = true;
			compact = true;
			continue;
		}
		if (arg === "--compact") {
			compact = true;
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--select") {
			const value = args[i + 1];
			if (!value || value.startsWith("--")) return { error: "--select requires a path value" };
			select = value;
			json = true;
			i++;
			continue;
		}
		if (arg.startsWith("--select=")) {
			const value = arg.slice("--select=".length);
			if (!value) return { error: "--select requires a path value" };
			select = value;
			json = true;
			continue;
		}
		stripped.push(arg);
	}

	return { args: stripped, output: { json, agent, compact, select } };
}

function findUnexpectedArgs(args: string[], valueFlags: Set<string>, booleanFlags: Set<string>): string | null {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		const eq = arg.indexOf("=");
		const flagName = eq === -1 ? arg : arg.slice(0, eq);
		if (valueFlags.has(flagName)) {
			if (eq === -1) i++;
			continue;
		}
		if (booleanFlags.has(arg)) continue;
		return arg;
	}
	return null;
}

function parseScriptApiArgs(args: string[], output: CliOutputOptions): CliParseResult {
	const action = args[1];
	if (!action) return { kind: "error", message: "script requires a subcommand: repl | get | set | compile" };
	if (action !== "repl" && action !== "get" && action !== "set" && action !== "compile") {
		return { kind: "error", message: `Unknown script subcommand "${action}". Use repl, get, set, or compile.` };
	}

	const rest = args.slice(2);
	const moduleId = readFlagValue(rest, "--module-id") ?? "Interface";
	const callback = readFlagValue(rest, "--callback");
	const useMock = rest.includes("--mock");
	const commonValueFlags = new Set(["--module-id"]);
	const commonBooleanFlags = new Set(["--mock", "--json", "--pretty"]);

	if (action === "repl") {
		const unexpected = findUnexpectedArgs(rest, commonValueFlags, new Set([...commonBooleanFlags, "--stdin", "-"]));
		if (unexpected) return { kind: "error", message: `Unexpected argument for script repl: ${unexpected}` };
		if (!rest.includes("--stdin") && !rest.includes("-")) {
			return { kind: "error", message: "script repl requires --stdin (or -)" };
		}
		return { kind: "script-api", command: { action, moduleId, source: { type: "stdin" } }, useMock, output };
	}

	if (action === "get") {
		const unexpected = findUnexpectedArgs(rest, new Set([...commonValueFlags, "--callback"]), commonBooleanFlags);
		if (unexpected) return { kind: "error", message: `Unexpected argument for script get: ${unexpected}` };
		return { kind: "script-api", command: { action, moduleId, callback }, useMock, output };
	}

	if (action === "compile") {
		const unexpected = findUnexpectedArgs(rest, commonValueFlags, commonBooleanFlags);
		if (unexpected) return { kind: "error", message: `Unexpected argument for script compile: ${unexpected}` };
		return { kind: "script-api", command: { action, moduleId }, useMock, output };
	}

	const unexpected = findUnexpectedArgs(
		rest,
		new Set([...commonValueFlags, "--callback", "--file", "--callbacks-json"]),
		new Set([...commonBooleanFlags, "--stdin", "-", "--no-compile"]),
	);
	if (unexpected) return { kind: "error", message: `Unexpected argument for script set: ${unexpected}` };

	const stdin = rest.includes("--stdin") || rest.includes("-");
	const file = readFlagValue(rest, "--file");
	const callbacksJson = readFlagValue(rest, "--callbacks-json");
	const sourceCount = [stdin, Boolean(file), Boolean(callbacksJson)].filter(Boolean).length;
	if (sourceCount !== 1) {
		return { kind: "error", message: "script set requires exactly one source: --stdin, --file <path>, or --callbacks-json <path>" };
	}
	if ((stdin || file) && !callback) {
		return { kind: "error", message: "script set with --stdin or --file requires --callback <name>" };
	}
	const compile = !rest.includes("--no-compile");
	const source = stdin
		? { type: "stdin" as const }
		: file
			? { type: "file" as const, path: file }
			: { type: "callbacks-json" as const, path: callbacksJson! };
	return { kind: "script-api", command: { action, moduleId, callback, source, compile }, useMock, output };
}

export function parseCliArgs(argv: string[], commands: CommandEntry[]): CliParseResult {
	const outputResult = parseOutputOptions(argv.slice(2));
	if ("error" in outputResult) return { kind: "error", message: outputResult.error };
	const { args, output } = outputResult;
	if (args.length === 0) return { kind: "tui", args: [] };

	// --help with no mode flag → global help
	// -builder --help or wizard --help → scoped help
	if (args.includes("--help") || args.includes("-h")) {
		const nonHelp = args.filter((a) => a !== "--help" && a !== "-h");
		if (nonHelp.length === 0) return { kind: "help" };
		const scopeArg = nonHelp[0]!;
		const scope = scopeArg.replace(/^-{1,2}/, "");
		return { kind: "help", scope };
	}

	const first = args[0]!;

	if (first === "--version" || first === "-version") {
		return { kind: "version", output };
	}

	if (first === "--status" || first === "-status") {
		return { kind: "status", output };
	}

	if (first === "script") {
		return parseScriptApiArgs(args, output);
	}

	// --run <file.hsc | - | --inline "script"> [--mock] [--dry-run] [--verbosity=<level>]
	if (first === "--run" || first === "-run" || first === "run") {
		const rest = args.slice(1);
		const useMock = rest.includes("--mock");
		const dryRun = rest.includes("--dry-run");
		const watch = rest.includes("--watch");

		const verbosityResult = parseVerbosityFlags(rest);
		if ("error" in verbosityResult) {
			return { kind: "error", message: verbosityResult.error };
		}
		const verbosity = verbosityResult.verbosity;

		const inlineIdx = rest.indexOf("--inline");

		if (inlineIdx !== -1) {
			const content = rest[inlineIdx + 1];
			if (!content) {
				return { kind: "error", message: "--inline requires a script string argument" };
			}
			if (watch) {
				return { kind: "error", message: "--watch cannot be used with --inline" };
			}
			return { kind: "run", source: { type: "inline", content: demangleMsys(content) }, dryRun, useMock, watch: false, verbosity, output };
		}

		const positional = stripVerbosityFlags(rest).find((a) => !a.startsWith("--"));
		if (!positional) {
			return { kind: "error", message: "--run requires a file path, -, or --inline <script>" };
		}
		if (positional === "-") {
			if (watch) {
				return { kind: "error", message: "--watch cannot be used with stdin" };
			}
			return { kind: "run", source: { type: "stdin" }, dryRun, useMock, watch: false, verbosity, output };
		}
		return { kind: "run", source: { type: "file", path: positional }, dryRun, useMock, watch, verbosity, output };
	}

	if (first === "repl") {
		return { kind: "tui", args: args.slice(1) };
	}

	if (first === "update") {
		return { kind: "update", check: args.includes("--check") };
	}

	if (first === "diagnose") {
		const rest = args.slice(1);
		if (rest.length === 0) {
			return { kind: "error", message: "diagnose requires a file path argument" };
		}
		return { kind: "diagnose", filePath: rest[0]! };
	}

	const flagToEntry = new Map<string, CommandEntry>();
	for (const command of commands) {
		flagToEntry.set(`-${command.name}`, command);
		flagToEntry.set(`--${command.name}`, command);
	}
	// Find the first arg that matches a registered command flag.
	// Everything after it is treated as tail args (not as command flags),
	// so `-script --compile` doesn't clash with the /compile command.
	let commandFlag: string | undefined;
	let entry: CommandEntry | undefined;
	for (const arg of args) {
		if (RESERVED_FLAGS.has(arg)) continue;
		if (arg.startsWith("--target:")) continue;
		if (flagToEntry.has(arg)) {
			commandFlag = arg;
			entry = flagToEntry.get(arg)!;
			break;
		}
	}

	if (!commandFlag || !entry) {
		return { kind: "tui", args };
	}

	const useMock = args.includes("--mock");
	const targetArg = args.find((arg) => arg.startsWith("--target:"));
	const target = targetArg ? targetArg.slice("--target:".length) : "";

	if (target && entry.kind !== "mode") {
		return { kind: "error", message: `${commandFlag} does not support --target` };
	}

	const rawTailParts = args.filter((arg) => arg !== commandFlag && arg !== targetArg && arg !== "--mock" && arg !== "--pretty");
	const stdin = rawTailParts.includes("--stdin") || rawTailParts.includes("-");
	const tailParts = rawTailParts.filter((arg) => arg !== "--stdin" && arg !== "-");

	if (stdin && entry.kind !== "mode") {
		return { kind: "error", message: `${commandFlag} does not support stdin input` };
	}
	if (stdin && tailParts.length > 0) {
		return { kind: "error", message: `${commandFlag} --stdin cannot be combined with an inline one-shot command` };
	}
	// Do NOT re-add quotes around multi-word args. The mode parsers treat a
	// quoted string as a distinct QuotedString token, so wrapping the user's
	// input in quotes turns a valid verb like `show tree` into an unparseable
	// quoted identifier. Multi-word targets and identifiers are handled by
	// the parsers' greedy Identifier+ rule instead.
	//
	// Also strip matched outer quotes that Git Bash on Windows sometimes
	// preserves literally in argv (`-builder "show tree"` → `"show tree"`).
	//
	// Normalize --subcommand to /subcommand for mode one-shots
	// (e.g. hise-cli -script --compile → /script /compile).
	const tail = tailParts.map((p) => {
		const stripped = stripMatchedOuterQuotes(p);
		if (stripped.startsWith("--") && !stripped.includes("=") && entry.kind === "mode") {
			return "/" + stripped.slice(2);
		}
		return stripped;
	}).join(" ").trim();

	if (entry.kind === "mode" && tail === "" && !stdin) {
		return { kind: "error", message: `${commandFlag} requires a one-shot command or expression` };
	}

	const mode = entry.kind === "mode" ? entry.name : "root";
	const targetSuffix = target ? `.${target}` : "";
	const canonicalCommand = `/${entry.name}${targetSuffix}${tail ? ` ${tail}` : ""}`;

	return { kind: "execute", entry, canonicalCommand, mode, useMock, stdin, output };
}


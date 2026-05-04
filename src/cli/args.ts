import type { CommandEntry } from "../engine/commands/registry.js";

export type CliParseResult =
	| { kind: "tui"; args: string[] }
	| { kind: "help"; scope?: string }
	| { kind: "error"; message: string }
	| { kind: "diagnose"; filePath: string }
	| { kind: "run"; source: { type: "file"; path: string } | { type: "stdin" } | { type: "inline"; content: string }; dryRun: boolean; useMock: boolean; watch: boolean; verbosity: import("../engine/run/executor.js").RunReportVerbosity }
	| { kind: "update"; check: boolean }
	| { kind: "version" }
	| { kind: "status" }
	| {
		kind: "execute";
		entry: CommandEntry;
		canonicalCommand: string;
		mode: string;
		useMock: boolean;
	};

const RESERVED_FLAGS = new Set(["--help", "-h", "--mock", "--dry-run", "--watch", "--show-keys", "--quiet", "--verbose", "--pretty"]);

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

export function parseCliArgs(argv: string[], commands: CommandEntry[]): CliParseResult {
	const args = argv.slice(2);
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
		return { kind: "version" };
	}

	if (first === "--status" || first === "-status") {
		return { kind: "status" };
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
			return { kind: "run", source: { type: "inline", content: demangleMsys(content) }, dryRun, useMock, watch: false, verbosity };
		}

		const positional = stripVerbosityFlags(rest).find((a) => !a.startsWith("--"));
		if (!positional) {
			return { kind: "error", message: "--run requires a file path, -, or --inline <script>" };
		}
		if (positional === "-") {
			if (watch) {
				return { kind: "error", message: "--watch cannot be used with stdin" };
			}
			return { kind: "run", source: { type: "stdin" }, dryRun, useMock, watch: false, verbosity };
		}
		return { kind: "run", source: { type: "file", path: positional }, dryRun, useMock, watch, verbosity };
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

	const tailParts = args.filter((arg) => arg !== commandFlag && arg !== targetArg && arg !== "--mock" && arg !== "--pretty");
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

	if (entry.kind === "mode" && tail === "") {
		return { kind: "error", message: `${commandFlag} requires a one-shot command or expression` };
	}

	const mode = entry.kind === "mode" ? entry.name : "root";
	const targetSuffix = target ? `.${target}` : "";
	const canonicalCommand = `/${entry.name}${targetSuffix}${tail ? ` ${tail}` : ""}`;

	return { kind: "execute", entry, canonicalCommand, mode, useMock };
}


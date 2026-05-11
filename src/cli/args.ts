import type { CommandEntry } from "../engine/commands/registry.js";
import type { ScriptShowFilters } from "../engine/modes/script-symbols.js";

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
	| { kind: "agent-context"; query: AgentContextQuery; output: CliOutputOptions }
	| { kind: "which"; query: string; limit: number; output: CliOutputOptions }
	| { kind: "mcp"; command: McpCliCommand; output: CliOutputOptions }
	| {
		kind: "execute";
		entry: CommandEntry;
		canonicalCommand: string;
		mode: string;
		useMock: boolean;
		stdin: boolean;
		dryRun: boolean;
		output: CliOutputOptions;
	};

export interface CliOutputOptions {
	json: boolean;
	agent: boolean;
	compact: boolean;
	select?: string;
	pretty?: boolean;
}

export type AgentContextQuery =
	| { type: "manifest" }
	| { type: "mode"; modeId: string }
	| { type: "command"; id: string }
	| { type: "command-index" };

export interface McpCliCommand {
	target: string;
	mode: "tool" | "method";
	argsSource: { type: "none" } | { type: "inline"; json: string } | { type: "file"; path: string } | { type: "stdin" } | { type: "fields"; fields: Array<{ key: string; value: string | true }> };
	url?: string;
	timeoutMs?: number;
}

export type ScriptApiCommand =
	| { action: "repl"; moduleId: string; source: { type: "stdin" } }
	| { action: "get"; moduleId: string; callback?: string }
	| { action: "set"; moduleId: string; callback?: string; source: { type: "stdin" } | { type: "file"; path: string } | { type: "callbacks-json"; path: string }; compile: boolean; rollback: boolean }
	| { action: "compile"; moduleId: string }
	| { action: "diagnose"; moduleId: string; filePath?: string; async: boolean }
	| { action: "add-file"; moduleId: string; relativePath: string }
	| { action: "show"; moduleId: string; target: "tree" | string; filters: ScriptShowFilters };

const RESERVED_FLAGS = new Set(["--help", "-h", "--mock", "--dry-run", "--watch", "--show-keys", "--quiet", "--verbose", "--pretty", "--json", "--stdin", "--agent", "--compact", "--select", "--target"]);

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

function readTargetFlag(args: string[]): { target: string; flagArgs: Set<number> } | { error: string } {
	const flagArgs = new Set<number>();
	let target = "";

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg.startsWith("--target:")) {
			target = arg.slice("--target:".length);
			flagArgs.add(i);
			continue;
		}
		if (arg.startsWith("--target=")) {
			target = arg.slice("--target=".length);
			flagArgs.add(i);
			continue;
		}
		if (arg === "--target") {
			const value = args[i + 1];
			if (!value || value.startsWith("--")) return { error: "--target requires a path value" };
			target = value;
			flagArgs.add(i);
			flagArgs.add(i + 1);
			i++;
		}
	}

	return { target, flagArgs };
}

function formatTargetSuffix(target: string): string {
	if (!target) return "";
	if (/\s/.test(target)) {
		return `."${target.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return `.${target}`;
}

function parseOutputOptions(args: string[]): { args: string[]; output: CliOutputOptions } | { error: string } {
	const stripped: string[] = [];
	let agent = false;
	let compact = false;
	let json = false;
	let select: string | undefined;
	let pretty = false;

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
		if (arg === "--pretty") {
			pretty = true;
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

	return { args: stripped, output: { json, agent, compact, select, ...(pretty ? { pretty } : {}) } };
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
	if (!action) return { kind: "error", message: "script requires a subcommand: repl | get | set | add-file | compile" };
	if (action !== "repl" && action !== "get" && action !== "set" && action !== "add-file" && action !== "compile" && action !== "diagnose" && action !== "show") {
		return { kind: "error", message: `Unknown script subcommand "${action}". Use repl, get, set, add-file, compile, diagnose, or show.` };
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

	if (action === "diagnose") {
		const unexpected = findUnexpectedArgs(rest, new Set([...commonValueFlags, "--file-path"]), new Set([...commonBooleanFlags, "--async"]));
		if (unexpected) return { kind: "error", message: `Unexpected argument for script diagnose: ${unexpected}` };
		const filePath = readFlagValue(rest, "--file-path");
		return { kind: "script-api", command: { action, moduleId, filePath, async: rest.includes("--async") }, useMock, output };
	}

	if (action === "add-file") {
		const positional: string[] = [];
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i]!;
			const eq = arg.indexOf("=");
			const flagName = eq === -1 ? arg : arg.slice(0, eq);
			if (commonValueFlags.has(flagName)) {
				if (eq === -1) i++;
				continue;
			}
			if (commonBooleanFlags.has(arg)) continue;
			if (arg.startsWith("--")) return { kind: "error", message: `Unexpected argument for script add-file: ${arg}` };
			positional.push(arg);
		}
		if (positional.length !== 1) return { kind: "error", message: "script add-file requires exactly one relative path" };
		return { kind: "script-api", command: { action, moduleId, relativePath: positional[0]! }, useMock, output };
	}

	if (action === "show") {
		return parseScriptShowApiArgs(rest, moduleId, useMock, output);
	}

	const unexpected = findUnexpectedArgs(
		rest,
		new Set([...commonValueFlags, "--callback", "--file", "--callbacks-json"]),
		new Set([...commonBooleanFlags, "--stdin", "-", "--no-compile", "--no-rollback"]),
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
	const rollback = compile && !rest.includes("--no-rollback");
	const source = stdin
		? { type: "stdin" as const }
		: file
			? { type: "file" as const, path: file }
			: { type: "callbacks-json" as const, path: callbacksJson! };
	return { kind: "script-api", command: { action, moduleId, callback, source, compile, rollback }, useMock, output };
}

function parseAgentContextArgs(args: string[], output: CliOutputOptions): CliParseResult {
	const rest = args.slice(1);
	let modeId: string | undefined;
	let commandId: string | undefined;
	let listCommands = false;

	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]!;
		if (arg === "--list-commands") {
			listCommands = true;
			continue;
		}
		if (arg === "--command") {
			const value = rest[i + 1];
			if (!value || value.startsWith("--")) return { kind: "error", message: `${arg} requires an id` };
			commandId = value;
			i++;
			continue;
		}
		if (arg.startsWith("--command=")) {
			const value = arg.slice("--command=".length);
			if (!value) return { kind: "error", message: "--command requires an id" };
			commandId = value;
			continue;
		}
		if (arg.startsWith("--")) return { kind: "error", message: `Unexpected argument for agent-context: ${arg}` };
		if (modeId) return { kind: "error", message: `Unexpected argument for agent-context: ${arg}` };
		modeId = stripMatchedOuterQuotes(arg);
	}

	const queryCount = [Boolean(modeId), Boolean(commandId), listCommands].filter(Boolean).length;
	if (queryCount > 1) return { kind: "error", message: "agent-context accepts only one query: <mode>, --command <id>, or --list-commands" };
	if (commandId) return { kind: "agent-context", query: { type: "command", id: commandId }, output: { ...output, json: true } };
	if (listCommands) return { kind: "agent-context", query: { type: "command-index" }, output: { ...output, json: true } };
	if (modeId) return { kind: "agent-context", query: { type: "mode", modeId }, output: { ...output, json: true } };
	return { kind: "agent-context", query: { type: "manifest" }, output: { ...output, json: true } };
}

function parseMcpArgs(args: string[], output: CliOutputOptions): CliParseResult {
	const rest = args.slice(1);
	const target = rest[0];
	if (!target || target.startsWith("--")) return { kind: "error", message: "mcp requires a tool or method name" };
	let url: string | undefined;
	let timeoutMs: number | undefined;
	let inlineJson: string | undefined;
	let argsFile: string | undefined;
	let argsStdin = false;
	const fields: Array<{ key: string; value: string | true }> = [];

	for (let i = 1; i < rest.length; i++) {
		const arg = rest[i]!;
		if (arg === "--args") {
			const value = rest[i + 1];
			if (!value || value.startsWith("--")) return { kind: "error", message: "--args requires a JSON value" };
			inlineJson = value;
			i++;
			continue;
		}
		if (arg.startsWith("--args=")) {
			inlineJson = arg.slice("--args=".length);
			if (!inlineJson) return { kind: "error", message: "--args requires a JSON value" };
			continue;
		}
		if (arg === "--args-file") {
			const value = rest[i + 1];
			if (!value || value.startsWith("--")) return { kind: "error", message: "--args-file requires a path" };
			argsFile = value;
			i++;
			continue;
		}
		if (arg.startsWith("--args-file=")) {
			argsFile = arg.slice("--args-file=".length);
			if (!argsFile) return { kind: "error", message: "--args-file requires a path" };
			continue;
		}
		if (arg === "--args-stdin") {
			argsStdin = true;
			continue;
		}
		if (arg === "--url") {
			const value = rest[i + 1];
			if (!value || value.startsWith("--")) return { kind: "error", message: "--url requires a value" };
			url = value;
			i++;
			continue;
		}
		if (arg.startsWith("--url=")) {
			url = arg.slice("--url=".length);
			if (!url) return { kind: "error", message: "--url requires a value" };
			continue;
		}
		if (arg === "--timeout") {
			const value = rest[i + 1];
			if (!value || value.startsWith("--")) return { kind: "error", message: "--timeout requires seconds or milliseconds" };
			const parsed = parseTimeoutMs(value);
			if (parsed == null) return { kind: "error", message: "--timeout must be a positive duration" };
			timeoutMs = parsed;
			i++;
			continue;
		}
		if (arg.startsWith("--timeout=")) {
			const parsed = parseTimeoutMs(arg.slice("--timeout=".length));
			if (parsed == null) return { kind: "error", message: "--timeout must be a positive duration" };
			timeoutMs = parsed;
			continue;
		}
		if (!arg.startsWith("--")) return { kind: "error", message: `Unexpected argument for mcp ${target}: ${arg}` };
		const eq = arg.indexOf("=");
		if (eq !== -1) {
			fields.push({ key: arg.slice(2, eq), value: arg.slice(eq + 1) });
			continue;
		}
		const value = rest[i + 1];
		if (value && !value.startsWith("--")) {
			fields.push({ key: arg.slice(2), value });
			i++;
		} else {
			fields.push({ key: arg.slice(2), value: true });
		}
	}

	const jsonSourceCount = [Boolean(inlineJson), Boolean(argsFile), argsStdin].filter(Boolean).length;
	if (jsonSourceCount > 1) return { kind: "error", message: "mcp accepts only one args source: --args, --args-file, or --args-stdin" };
	if (jsonSourceCount > 0 && fields.length > 0) return { kind: "error", message: "mcp field flags cannot be combined with --args, --args-file, or --args-stdin" };
	const argsSource = inlineJson
		? { type: "inline" as const, json: inlineJson }
		: argsFile
			? { type: "file" as const, path: argsFile }
			: argsStdin
				? { type: "stdin" as const }
				: fields.length > 0
					? { type: "fields" as const, fields }
					: { type: "none" as const };
	return { kind: "mcp", command: { target, mode: target.includes("/") ? "method" : "tool", argsSource, url, timeoutMs }, output: { ...output, json: true } };
}

function parseTimeoutMs(value: string): number | null {
	const match = value.match(/^(\d+(?:\.\d+)?)(ms|s)?$/);
	if (!match) return null;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return null;
	return Math.round(amount * (match[2] === "ms" ? 1 : 1000));
}

function parseScriptShowApiArgs(rest: string[], moduleId: string, useMock: boolean, output: CliOutputOptions): CliParseResult {
	const positional: Array<{ value: string; index: number }> = [];
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]!;
		if (arg === "--module-id" || arg === "--namespace" || arg === "--search" || arg === "--type" || arg === "--data-type" || arg === "--format" || arg === "--max-depth" || arg === "--limit") { i++; continue; }
		if (arg.startsWith("--module-id=")) continue;
		if (!arg.startsWith("--")) positional.push({ value: arg, index: i });
	}
	const target = positional[0]?.value ?? "";
	if (!target) return { kind: "error", message: "script show requires tree or an expression" };
	const targetIndex = positional[0]!.index;
	const args = rest.filter((_, index) => index !== targetIndex);
	const filters: ScriptShowFilters = { symbolsOnly: false };
	let positionalSearch: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--module-id" || arg.startsWith("--module-id=")) {
			if (arg === "--module-id") i++;
			continue;
		}
		if (arg === "--mock") continue;
		if (arg === "--symbols-only") { filters.symbolsOnly = true; continue; }
		if (arg === "--namespace" || arg === "--search" || arg === "--type" || arg === "--data-type" || arg === "--format" || arg === "--max-depth" || arg === "--limit") {
			const value = args[i + 1];
			if (!value || value.startsWith("--")) return { kind: "error", message: `${arg} requires a value` };
			const err = assignScriptShowFilter(filters, arg, value);
			if (err) return { kind: "error", message: err };
			i++;
			continue;
		}
		if (arg.startsWith("--")) return { kind: "error", message: `Unexpected argument for script show: ${arg}` };
		if (target === "tree") positionalSearch = positionalSearch ? `${positionalSearch} ${arg}` : arg;
		else return { kind: "error", message: `Unexpected argument for script show ${target}: ${arg}` };
	}
	if (positionalSearch && filters.search) return { kind: "error", message: "script show tree accepts either a positional search or --search, not both" };
	if (positionalSearch) filters.search = positionalSearch;
	return { kind: "script-api", command: { action: "show", moduleId, target, filters }, useMock, output };
}

function assignScriptShowFilter(filters: ScriptShowFilters, flag: string, value: string): string | null {
	if (flag === "--namespace") filters.namespace = value;
	else if (flag === "--search") filters.search = value;
	else if (flag === "--type") filters.type = value;
	else if (flag === "--data-type") filters.dataType = value;
	else if (flag === "--format") {
		if (value !== "tree" && value !== "flat") return "--format must be tree or flat";
		filters.format = value;
	} else if (flag === "--max-depth") {
		const n = Number(value);
		if (!Number.isInteger(n) || n < 0) return "--max-depth must be a non-negative integer";
		filters.maxDepth = n;
	} else if (flag === "--limit") {
		const n = Number(value);
		if (!Number.isInteger(n) || n < 1) return "--limit must be a positive integer";
		filters.limit = n;
	}
	return null;
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

	if (first === "agent-context") {
		return parseAgentContextArgs(args, output);
	}

	if (first === "which") {
		const rest = args.slice(1);
		let limit = 3;
		const queryParts: string[] = [];
		for (let i = 0; i < rest.length; i++) {
			const arg = rest[i]!;
			if (arg === "--limit") {
				const value = rest[i + 1];
				if (!value || value.startsWith("--")) return { kind: "error", message: "--limit requires a number" };
				limit = Number(value);
				if (!Number.isInteger(limit) || limit < 1) return { kind: "error", message: "--limit must be a positive integer" };
				i++;
				continue;
			}
			if (arg.startsWith("--limit=")) {
				limit = Number(arg.slice("--limit=".length));
				if (!Number.isInteger(limit) || limit < 1) return { kind: "error", message: "--limit must be a positive integer" };
				continue;
			}
			queryParts.push(stripMatchedOuterQuotes(arg));
		}
		return { kind: "which", query: queryParts.join(" ").trim(), limit, output: { ...output, json: true } };
	}

	if (first === "mcp") {
		return parseMcpArgs(args, output);
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
		if (arg.startsWith("--target=")) continue;
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
	const targetResult = readTargetFlag(args);
	if ("error" in targetResult) return { kind: "error", message: targetResult.error };
	const { target, flagArgs: targetArgIndexes } = targetResult;

	if (target && entry.kind !== "mode") {
		return { kind: "error", message: `${commandFlag} does not support --target` };
	}

	const rawTailParts = args.filter((arg, index) => arg !== commandFlag && !targetArgIndexes.has(index) && arg !== "--mock" && arg !== "--pretty");
	const dryRun = rawTailParts.includes("--dry-run");
	const stdin = rawTailParts.includes("--stdin") || rawTailParts.includes("-");
	const tailParts = rawTailParts.filter((arg) => arg !== "--stdin" && arg !== "-" && arg !== "--dry-run");

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
		if (stripped.startsWith("--") && !stripped.includes("=") && entry.kind === "mode" && !(entry.name === "script" && tailParts[0] === "show")) {
			return "/" + stripped.slice(2);
		}
		return stripped;
	}).join(" ").trim();

	if (entry.kind === "mode" && tail === "" && !stdin) {
		return { kind: "error", message: `${commandFlag} requires a one-shot command or expression` };
	}

	const mode = entry.kind === "mode" ? entry.name : "root";
	const targetSuffix = formatTargetSuffix(target);
	const canonicalCommand = `/${entry.name}${targetSuffix}${tail ? ` ${tail}` : ""}`;

	return { kind: "execute", entry, canonicalCommand, mode, useMock, stdin, dryRun, output };
}


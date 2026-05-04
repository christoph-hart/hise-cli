// Parser for assets-mode subcommand input. Produces a discriminated union
// AssetsCommand consumed by the dispatcher in `assets.ts`.
//
// Syntax:
//   help
//   create
//   list [installed|uninstalled|local|store]
//   info <name>
//   install <name> [version=X.Y.Z] [--dry-run]
//   uninstall <name>
//   cleanup <name>
//   local add <path>
//   local remove <name|path>
//   login [token=<t>]
//   logout
//
// Flag forms:
//   --dry-run         boolean flag
//   key=value         string flag (e.g. token=abc, version=1.2.0)

export type ListFilter = "all" | "installed" | "uninstalled" | "local" | "store";

export type AssetsCommand =
	| { type: "help" }
	| { type: "create" }
	| { type: "list"; filter: ListFilter }
	| { type: "info"; name: string }
	| {
		type: "install";
		name: string;
		version?: string;
		dryRun: boolean;
	}
	| { type: "uninstall"; name: string }
	| { type: "cleanup"; name: string }
	| { type: "localAdd"; path: string }
	| { type: "localRemove"; query: string }
	| { type: "login"; token?: string }
	| { type: "logout" }
	| { type: "error"; message: string };

interface ParsedTokens {
	positional: string[];
	flags: Map<string, string | true>;
}

const KEY_VALUE_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*=/;

function tokenize(input: string): ParsedTokens {
	const tokens = input.match(/(?:[^\s"]+|"(?:\\"|[^"])*")+/g) ?? [];
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	for (const raw of tokens) {
		const t = unquote(raw);
		if (t.startsWith("--") && !t.includes("=")) {
			flags.set(t.slice(2), true);
		} else if (KEY_VALUE_RE.test(t)) {
			const eq = t.indexOf("=");
			flags.set(t.slice(0, eq), unquote(t.slice(eq + 1)));
		} else {
			positional.push(t);
		}
	}
	return { positional, flags };
}

function unquote(s: string): string {
	if (s.length >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
		return s.slice(1, -1).replace(/\\"/g, "\"");
	}
	return s;
}

export function parseAssetsCommand(input: string): AssetsCommand {
	const trimmed = input.trim();
	if (trimmed.length === 0 || trimmed === "help") return { type: "help" };

	const { positional, flags } = tokenize(trimmed);
	const verb = positional[0]?.toLowerCase() ?? "";
	const args = positional.slice(1);

	switch (verb) {
		case "help":
			return { type: "help" };
		case "create":
			return { type: "create" };
		case "list":
			return parseList(args);
		case "info":
			return requireOne("info", args, (n) => ({ type: "info", name: n }));
		case "install":
			return parseInstall(args, flags);
		case "uninstall":
			return requireOne("uninstall", args, (n) => ({ type: "uninstall", name: n }));
		case "cleanup":
			return requireOne("cleanup", args, (n) => ({ type: "cleanup", name: n }));
		case "local":
			return parseLocal(args);
		case "login":
			return { type: "login", token: readStringFlag(flags, "token") };
		case "logout":
			return { type: "logout" };
		default:
			return { type: "error", message: `Unknown command: "${verb}". Type "help" for available commands.` };
	}
}

function parseList(args: string[]): AssetsCommand {
	const filter = (args[0] ?? "all").toLowerCase();
	if (!isListFilter(filter)) {
		return { type: "error", message: `Unknown list filter: "${filter}". Use installed, uninstalled, local, or store.` };
	}
	return { type: "list", filter };
}

function isListFilter(s: string): s is ListFilter {
	return s === "all" || s === "installed" || s === "uninstalled" || s === "local" || s === "store";
}

function parseInstall(args: string[], flags: Map<string, string | true>): AssetsCommand {
	const name = args[0];
	if (!name) {
		return { type: "error", message: "install requires a package name" };
	}
	const version = readStringFlag(flags, "version");
	const dryRun = flags.has("dry-run");
	return { type: "install", name, version, dryRun };
}

function parseLocal(args: string[]): AssetsCommand {
	const sub = args[0]?.toLowerCase();
	if (sub === "add") {
		const path = args[1];
		if (!path) return { type: "error", message: "local add requires a path" };
		return { type: "localAdd", path };
	}
	if (sub === "remove") {
		const q = args[1];
		if (!q) return { type: "error", message: "local remove requires a name or path" };
		return { type: "localRemove", query: q };
	}
	return { type: "error", message: "local: expected 'add' or 'remove'" };
}

function requireOne(verb: string, args: string[], fn: (name: string) => AssetsCommand): AssetsCommand {
	const name = args[0];
	if (!name) return { type: "error", message: `${verb} requires a package name` };
	return fn(name);
}

function readStringFlag(flags: Map<string, string | true>, key: string): string | undefined {
	const v = flags.get(key);
	if (v === undefined) return undefined;
	if (v === true) return undefined;
	return v;
}

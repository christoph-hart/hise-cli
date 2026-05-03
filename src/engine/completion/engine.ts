// ── CompletionEngine — fuzzy matching across static datasets ────────

// Consumes all three static datasets (moduleList, scriptingApi,
// scriptnodeList) and the command registry. Provides mode-aware
// completion candidates with prefix matching + Levenshtein fallback
// for close misses.

import type { CompletionItem, CompletionResult } from "../modes/mode.js";
import type {
	DataLoader,
	ModuleList,
	ScriptingApi,
	ScriptnodeList,
} from "../data.js";
import type { CommandEntry } from "../commands/registry.js";

// ── Levenshtein distance (inline — no external dep for engine) ──────

export function levenshteinDistance(a: string, b: string): number {
	const la = a.length;
	const lb = b.length;
	if (la === 0) return lb;
	if (lb === 0) return la;

	// Single-row DP
	const row = new Array<number>(lb + 1);
	for (let j = 0; j <= lb; j++) row[j] = j;

	for (let i = 1; i <= la; i++) {
		let prev = i - 1;
		row[0] = i;
		for (let j = 1; j <= lb; j++) {
			const cur = a[i - 1] === b[j - 1] ? prev : Math.min(prev, row[j], row[j - 1]) + 1;
			prev = row[j];
			row[j] = cur;
		}
	}
	return row[lb];
}

// ── Fuzzy match scoring ─────────────────────────────────────────────

export interface ScoredItem {
	item: CompletionItem;
	score: number; // lower is better: 0 = exact, 1 = prefix, 2+ = fuzzy
}

/**
 * Score a candidate against input prefix. Returns null if no match.
 * Scoring:
 *   0 — exact match
 *   1 — case-insensitive prefix match
 *   2 — case-insensitive substring match (contains)
 *   3+ — Levenshtein distance (scaled to input length)
 *
 * Levenshtein only fires for input length ≥ 3, with maxDistance scaled
 * to ceil(len/3). Keeps real typos ("Synht" → "Synth", "/hlep" → "/help")
 * while rejecting unrelated short tokens ("F9" → "FFT").
 */
export function scoreMatch(
	input: string,
	candidate: string,
): number | null {
	const lower = input.toLowerCase();
	const candidateLower = candidate.toLowerCase();

	if (lower === candidateLower) return 0;
	if (candidateLower.startsWith(lower)) return 1;
	if (candidateLower.includes(lower)) return 2;

	if (input.length >= 3) {
		const maxDistance = Math.ceil(input.length / 3);
		const dist = levenshteinDistance(lower, candidateLower);
		if (dist <= maxDistance) return 2 + dist;
	}

	return null;
}

function namedItems(names: string[], detail?: string): CompletionItem[] {
	return names.map((label) => detail ? { label, detail } : { label });
}

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

/**
 * Filter and sort items by fuzzy match score.
 * Returns items sorted best-first (lowest score), capped at limit.
 */
export function fuzzyFilter(
	input: string,
	items: CompletionItem[],
	limit = 20,
): CompletionItem[] {
	if (input === "") return items.slice(0, limit);

	const scored: ScoredItem[] = [];
	for (const item of items) {
		// Match against label, insertText, and detail — take the best score
		let best = scoreMatch(input, item.label);
		if (item.insertText) {
			const s = scoreMatch(input, item.insertText);
			if (s !== null && (best === null || s < best)) best = s;
		}
		if (item.detail) {
			const s = scoreMatch(input, item.detail);
			if (s !== null && (best === null || s < best)) best = s;
		}
		if (best !== null) {
			scored.push({ item, score: best });
		}
	}

	scored.sort((a, b) => {
		if (a.score !== b.score) return a.score - b.score;
		return a.item.label.localeCompare(b.item.label);
	});

	return scored.slice(0, limit).map((s) => s.item);
}

// ── Cached dataset items ────────────────────────────────────────────

export interface CompletionDatasets {
	moduleItems: CompletionItem[];
	moduleParamMap: Map<string, CompletionItem[]>; // moduleId → params
	apiNamespaceItems: CompletionItem[];
	apiMethodMap: Map<string, CompletionItem[]>; // className → methods
	scriptnodeItems: CompletionItem[];
	scriptnodeFactories: CompletionItem[];
	scriptnodeByFactory: Map<string, CompletionItem[]>; // factory → nodes
}

/**
 * Build completion items from raw datasets. Called once at startup,
 * results cached in the CompletionEngine.
 */
export function buildDatasets(
	moduleList: ModuleList | null,
	scriptingApi: ScriptingApi | null,
	scriptnodeList: ScriptnodeList | null,
): CompletionDatasets {
	// ── Modules ──────────────────────────────────────────────────
	const moduleItems: CompletionItem[] = [];
	const moduleParamMap = new Map<string, CompletionItem[]>();

	if (moduleList) {
		for (const m of moduleList.modules) {
			moduleItems.push({
				label: m.prettyName,
				detail: m.id,
			});

			if (m.parameters?.length > 0) {
				const params: CompletionItem[] = m.parameters.map((p) => ({
					label: p.id,
					detail: `${p.range.min}–${p.range.max} (${p.type})`,
				}));
				moduleParamMap.set(m.id, params);
			}
		}
	}

	// ── Scripting API ───────────────────────────────────────────
	const apiNamespaceItems: CompletionItem[] = [];
	const apiMethodMap = new Map<string, CompletionItem[]>();

	if (scriptingApi) {
		for (const [name, cls] of Object.entries(scriptingApi.classes)) {
			// Brief description: first sentence, fall back to category.
			const nsBrief = cls.description
				? cls.description.split(/\.\s/)[0]!.replace(/\.$/, "")
				: cls.category;
			apiNamespaceItems.push({
				label: name,
				detail: nsBrief,
			});

			if (cls.methods.length > 0) {
				const methods: CompletionItem[] = cls.methods.map((m) => {
					// Brief description: first sentence (up to first period).
					const brief = m.description
						? m.description.split(/\.\s/)[0]!.replace(/\.$/, "")
						: "";
					return {
						label: m.name,
						detail: brief,
						insertText: (m.parameters?.length ?? 0) === 0
							? `${m.name}()`
							: `${m.name}(`,
					};
				});
				apiMethodMap.set(name, methods);
			}
		}
	}

	// ── Scriptnode ──────────────────────────────────────────────
	const scriptnodeItems: CompletionItem[] = [];
	const scriptnodeFactories: CompletionItem[] = [];
	const scriptnodeByFactory = new Map<string, CompletionItem[]>();
	const factorySet = new Set<string>();

	if (scriptnodeList) {
		for (const [fullId, node] of Object.entries(scriptnodeList)) {
			scriptnodeItems.push({
				label: fullId,
				detail: node.type,
			});

			const dotIndex = fullId.indexOf(".");
			if (dotIndex !== -1) {
				const factory = fullId.slice(0, dotIndex);
				const nodeId = fullId.slice(dotIndex + 1);

				factorySet.add(factory);

				const existing = scriptnodeByFactory.get(factory) ?? [];
				existing.push({
					label: nodeId,
					detail: node.type,
					insertText: fullId,
				});
				scriptnodeByFactory.set(factory, existing);
			}
		}

		for (const f of factorySet) {
			const count = scriptnodeByFactory.get(f)?.length ?? 0;
			scriptnodeFactories.push({
				label: f,
				detail: `${count} node${count !== 1 ? "s" : ""}`,
				insertText: `${f}.`,
			});
		}
	}

	return {
		moduleItems,
		moduleParamMap,
		apiNamespaceItems,
		apiMethodMap,
		scriptnodeItems,
		scriptnodeFactories,
		scriptnodeByFactory,
	};
}

// ── Slash command items ─────────────────────────────────────────────

export function buildSlashItems(commands: CommandEntry[]): CompletionItem[] {
	return commands.map((c) => ({
		label: `/${c.name}`,
		detail: c.description,
		insertText: `/${c.name}`,
	}));
}

// ── CompletionEngine class ──────────────────────────────────────────

export class CompletionEngine {
	private datasets: CompletionDatasets | null = null;
	private slashItems: CompletionItem[] = [];
	private loading: Promise<void> | null = null;

	/**
	 * Initialize with data loader. Safe to call multiple times —
	 * second call is a no-op if already loaded.
	 */
	async init(loader: DataLoader): Promise<void> {
		if (this.datasets) return;
		if (this.loading) return this.loading;

		this.loading = (async () => {
			const [moduleList, scriptingApi, scriptnodeList] = await Promise.all([
				loader.loadModuleList().catch(() => null),
				loader.loadScriptingApi().catch(() => null),
				loader.loadScriptnodeList().catch(() => null),
			]);

			this.datasets = buildDatasets(moduleList, scriptingApi, scriptnodeList);
		})();

		return this.loading;
	}

	/** Set slash command items from the registry. */
	setSlashCommands(commands: CommandEntry[]): void {
		this.slashItems = buildSlashItems(commands);
	}

	/** Manual dataset injection (for testing). */
	setDatasets(datasets: CompletionDatasets): void {
		this.datasets = datasets;
	}

	// ── Query methods ───────────────────────────────────────────

	/**
	 * Complete slash commands. Input includes the leading `/`.
	 * Returns completions for the command name portion.
	 */
	completeSlash(input: string): CompletionResult {
		const prefix = input.startsWith("/") ? input : `/${input}`;
		const items = fuzzyFilter(prefix, this.slashItems);
		return { items, from: 0, to: input.length, label: "Slash commands" };
	}

	/**
	 * Complete module type names (for `add <type>` in builder mode).
	 */
	completeModuleType(prefix: string): CompletionItem[] {
		if (!this.datasets) return [];
		return fuzzyFilter(prefix, this.datasets.moduleItems);
	}

	/**
	 * Complete module parameters (for `set <module> <param>` in builder).
	 */
	completeModuleParam(moduleId: string, prefix: string): CompletionItem[] {
		if (!this.datasets) return [];
		const params = this.datasets.moduleParamMap.get(moduleId);
		if (!params) return [];
		return fuzzyFilter(prefix, params);
	}

	/**
	 * Complete scripting API namespaces (top-level identifiers in script mode).
	 * Handles "Namespace.method" dotted access — returns methods after dot.
	 */
	completeScript(input: string): CompletionResult {
		if (!this.datasets) return { items: [], from: 0, to: input.length };

		const dotIndex = input.lastIndexOf(".");
		if (dotIndex !== -1) {
			// After a dot — complete method names
			const ns = input.slice(0, dotIndex);
			const methodPrefix = input.slice(dotIndex + 1);
			const methods = this.datasets.apiMethodMap.get(ns);
			if (methods) {
				const items = fuzzyFilter(methodPrefix, methods);
				return { items, from: dotIndex + 1, to: input.length, label: `${ns} methods` };
			}
			return { items: [], from: dotIndex + 1, to: input.length };
		}

		// Before dot — complete namespace names
		const items = fuzzyFilter(input, this.datasets.apiNamespaceItems);
		return { items, from: 0, to: input.length, label: "API namespaces" };
	}

	/**
	 * Complete scriptnode factory.nodeId (for DSP mode).
	 * Handles "factory." prefix — returns nodes in that factory after dot.
	 */
	completeScriptnode(input: string): CompletionResult {
		if (!this.datasets) return { items: [], from: 0, to: input.length };

		const dotIndex = input.indexOf(".");
		if (dotIndex !== -1) {
			const factory = input.slice(0, dotIndex);
			const nodePrefix = input.slice(dotIndex + 1);
			const nodes = this.datasets.scriptnodeByFactory.get(factory);
			if (nodes) {
				// After the dot: replacement range starts at dotIndex+1, so
				// the inserted text is only the nodeId suffix. The cached
				// items carry the full "factory.node" as insertText (for
				// cross-factory search); strip it here so we don't duplicate
				// the factory prefix.
				const items = fuzzyFilter(nodePrefix, nodes).map((it) => ({
					label: it.label,
					detail: it.detail,
				}));
				return { items, from: dotIndex + 1, to: input.length };
			}
			return { items: [], from: dotIndex + 1, to: input.length };
		}

		// Before dot — complete factory names
		const items = fuzzyFilter(input, this.datasets.scriptnodeFactories);
		return { items, from: 0, to: input.length };
	}

	/**
	 * Complete /project mode subcommands. Pulls dynamic candidates
	 * (setting keys, preprocessor names, project names) from the caller
	 * since they live outside the static dataset cache.
	 */
	completeProject(
		prefix: string,
		dynamic: { preprocessorNames: string[]; settingKeys: string[]; projectNames: string[] },
	): CompletionItem[] {
		const tokens = prefix.trimStart().split(/\s+/);
		const verb = tokens[0]?.toLowerCase() ?? "";
		const tail = tokens[tokens.length - 1] ?? "";

		// Empty / first token: complete top-level verbs.
		if (tokens.length <= 1) {
			const verbs: CompletionItem[] = [
				{ label: "info", detail: "Show project info" },
				{ label: "show", detail: "show projects | settings | files | preprocessors | tree" },
				{ label: "describe", detail: "describe <key>" },
				{ label: "switch", detail: "switch <name|path>" },
				{ label: "save", detail: "save xml | hip [as <filename>]" },
				{ label: "load", detail: "load <relative-path>" },
				{ label: "get", detail: "get <key>" },
				{ label: "set", detail: "set <key> <value> | preprocessor <name> ..." },
				{ label: "clear", detail: "clear preprocessor <name> ..." },
				{ label: "snippet", detail: "snippet export | snippet load" },
				{ label: "create", detail: "Alias for /wizard new_project" },
				{ label: "export", detail: "export dll | project (wizard alias)" },
				{ label: "help", detail: "Show /project commands" },
			];
			return fuzzyFilter(prefix, verbs);
		}

		if (verb === "show" && tokens.length === 2) {
			return fuzzyFilter(tail, [
				{ label: "projects" },
				{ label: "settings" },
				{ label: "files" },
				{ label: "preprocessors" },
				{ label: "tree" },
			]);
		}

		if (verb === "save" && tokens.length === 2) {
			return fuzzyFilter(tail, [
				{ label: "xml", detail: "Human-readable XML preset" },
				{ label: "hip", detail: "Binary archive" },
			]);
		}

		if (verb === "switch" && tokens.length === 2) {
			return fuzzyFilter(tail, dynamic.projectNames.map((name) => ({ label: name })));
		}

		if (verb === "describe" && tokens.length === 2) {
			return fuzzyFilter(tail, dynamic.settingKeys.map((key) => ({ label: key })));
		}

		if (verb === "get" && tokens.length === 2) {
			return fuzzyFilter(tail, dynamic.settingKeys.map((key) => ({ label: key })));
		}

		if (verb === "set" && tokens.length === 2) {
			const items: CompletionItem[] = dynamic.settingKeys.map((key) => ({ label: key }));
			items.push({ label: "preprocessor", detail: "set preprocessor <name> <value> ..." });
			return fuzzyFilter(tail, items);
		}

		if (verb === "set" && tokens[1]?.toLowerCase() === "preprocessor" && tokens.length === 3) {
			return fuzzyFilter(tail, dynamic.preprocessorNames.map((name) => ({ label: name })));
		}

		if (verb === "clear" && tokens.length === 2) {
			return fuzzyFilter(tail, [{ label: "preprocessor", detail: "Clear a preprocessor override" }]);
		}

		if (verb === "clear" && tokens[1]?.toLowerCase() === "preprocessor" && tokens.length === 3) {
			return fuzzyFilter(tail, dynamic.preprocessorNames.map((name) => ({ label: name })));
		}

		if (verb === "snippet" && tokens.length === 2) {
			return fuzzyFilter(tail, [
				{ label: "export", detail: "Export snippet to clipboard" },
				{ label: "load", detail: "Load snippet (clipboard if blank)" },
			]);
		}

		if (verb === "export" && tokens.length === 2) {
			return fuzzyFilter(tail, [
				{ label: "dll", detail: "Alias for /wizard compile_networks" },
				{ label: "project", detail: "Alias for /wizard plugin_export" },
			]);
		}

		// Trailing scope clause helpers.
		const lastToken = tokens[tokens.length - 2]?.toLowerCase();
		if (lastToken === "on") {
			return fuzzyFilter(tail, [
				{ label: "Windows" },
				{ label: "macOS" },
				{ label: "Linux" },
				{ label: "all" },
			]);
		}
		if (lastToken === "for") {
			return fuzzyFilter(tail, [
				{ label: "Project" },
				{ label: "Dll" },
				{ label: "all" },
			]);
		}

		return [];
	}

	/**
	 * Complete inspect mode subcommands.
	 */
	completeInspect(prefix: string): CompletionItem[] {
		const items: CompletionItem[] = [
			{ label: "version", detail: "Show HISE server version information" },
			{ label: "project", detail: "Show current project information" },
			{ label: "help", detail: "Show inspect mode commands" },
		];
		return fuzzyFilter(prefix, items);
	}

	/**
	 * Complete assets mode subcommands. Slot-aware: top-level verbs at
	 * position 0, then per-verb argument slots (package names, sub-verbs,
	 * filter keywords, --flags). Dynamic candidates (installed / local
	 * package names) come from the AssetsMode cache.
	 */
	completeAssets(
		prefix: string,
		dynamic: { installedNames: string[]; localNames: string[]; needsCleanupNames: string[] },
	): CompletionItem[] {
		const tokens = prefix.trimStart().split(/\s+/);
		const verb = tokens[0]?.toLowerCase() ?? "";
		const sub = tokens[1]?.toLowerCase() ?? "";
		const tail = tokens[tokens.length - 1] ?? "";
		const tokenCount = tokens.length;

		// Top-level verbs at position 0 (or while still typing first token).
		if (tokenCount <= 1) {
			return fuzzyFilter(prefix, [
				{ label: "list", detail: "Show packages by category" },
				{ label: "info", detail: "Show details for a package" },
				{ label: "install", detail: "Install or update a package" },
				{ label: "uninstall", detail: "Remove an installed package" },
				{ label: "cleanup", detail: "Finish a previous uninstall" },
				{ label: "local", detail: "Manage your asset library" },
				{ label: "auth", detail: "Sign in to / out of the HISE store" },
				{ label: "create", detail: "Open the package-author wizard" },
				{ label: "help", detail: "Show assets commands" },
			]);
		}

		// `install` flag completion: trigger whenever the trailing token starts with --,
		// regardless of where it lands among the install args.
		if (verb === "install" && tail.startsWith("--")) {
			return fuzzyFilter(tail, [
				{ label: "--dry-run", detail: "Preview without writing" },
				{ label: "--version=", detail: "Pin a specific store tag" },
			]);
		}

		// list <filter>
		if (verb === "list" && tokenCount === 2) {
			return fuzzyFilter(tail, [
				{ label: "installed" },
				{ label: "uninstalled" },
				{ label: "local" },
				{ label: "store" },
			]);
		}

		// info <name> — any known package
		if (verb === "info" && tokenCount === 2) {
			return fuzzyFilter(tail, namedItems(unique([
				...dynamic.installedNames,
				...dynamic.localNames,
			])));
		}

		// uninstall <name> — installed packages only
		if (verb === "uninstall" && tokenCount === 2) {
			return fuzzyFilter(tail, namedItems(dynamic.installedNames, "installed"));
		}

		// cleanup <name> — needs-cleanup entries; fall back to all installed if empty
		if (verb === "cleanup" && tokenCount === 2) {
			const candidates = dynamic.needsCleanupNames.length > 0
				? namedItems(dynamic.needsCleanupNames, "needs cleanup")
				: namedItems(dynamic.installedNames, "installed");
			return fuzzyFilter(tail, candidates);
		}

		// install <name> — packages from your asset library not currently installed
		if (verb === "install" && tokenCount === 2) {
			const installed = new Set(dynamic.installedNames);
			const installable = dynamic.localNames.filter((n) => !installed.has(n));
			return fuzzyFilter(tail, namedItems(installable, "in library"));
		}

		// local <add|remove>
		if (verb === "local" && tokenCount === 2) {
			return fuzzyFilter(tail, [
				{ label: "add", detail: "Add a project to your asset library" },
				{ label: "remove", detail: "Remove a project from your asset library" },
			]);
		}
		if (verb === "local" && sub === "remove" && tokenCount === 3) {
			return fuzzyFilter(tail, namedItems(dynamic.localNames, "in library"));
		}

		// auth <login|logout>
		if (verb === "auth" && tokenCount === 2) {
			return fuzzyFilter(tail, [
				{ label: "login", detail: "Sign in to the HISE store" },
				{ label: "logout", detail: "Sign out" },
			]);
		}

		return [];
	}

	/**
	 * Complete sequence mode commands and event verbs.
	 */
	completeSequence(prefix: string): CompletionItem[] {
		const items: CompletionItem[] = [
			{ label: "create", detail: "Start defining a named sequence" },
			{ label: "flush", detail: "End the sequence definition" },
			{ label: "show", detail: "Show sequence details" },
			{ label: "play", detail: "Execute a sequence (blocking)" },
			{ label: "record", detail: "Record sequence output to WAV" },
			{ label: "stop", detail: "Send all-notes-off" },
			{ label: "get", detail: "Retrieve eval result" },
			{ label: "help", detail: "Show sequence mode commands" },
			// Event verbs (for defining phase)
			{ label: "send", detail: "Send CC or pitchbend" },
			{ label: "set", detail: "Set module attribute" },
			{ label: "eval", detail: "Evaluate script expression" },
			// Signal types
			{ label: "sine", detail: "Sine test signal" },
			{ label: "saw", detail: "Saw test signal" },
			{ label: "sweep", detail: "Frequency sweep signal" },
			{ label: "dirac", detail: "Impulse test signal" },
			{ label: "noise", detail: "White noise signal" },
			{ label: "silence", detail: "Silence signal" },
		];
		return fuzzyFilter(prefix, items);
	}

	/**
	 * Complete builder mode keywords at position 0.
	 */
	completeBuilderKeyword(prefix: string): CompletionItem[] {
		const items: CompletionItem[] = [
			{ label: "add", detail: "Add a module to the tree" },
			{ label: "clone", detail: "Duplicate a module" },
			{ label: "remove", detail: "Remove a module" },
			{ label: "move", detail: "Move a module (stub)" },
			{ label: "rename", detail: "Rename a module" },
			{ label: "set", detail: "Set a module parameter" },
			{ label: "get", detail: "Get a parameter value" },
			{ label: "load", detail: "Load DSP network into module" },
			{ label: "bypass", detail: "Bypass a module" },
			{ label: "enable", detail: "Enable a bypassed module" },
			{ label: "show", detail: "Show tree, types, or module" },
			{ label: "cd", detail: "Navigate to a processor (cd .., cd /)" },
			{ label: "ls", detail: "List children at current path" },
			{ label: "pwd", detail: "Print current path" },
		];
		return fuzzyFilter(prefix, items);
	}

	/**
	 * Complete "show" subcommands in builder mode.
	 */
	completeBuilderShow(prefix: string): CompletionItem[] {
		const items: CompletionItem[] = [
			{ label: "tree", detail: "Show module tree" },
			{ label: "types", detail: "List available module types" },
		];
		return fuzzyFilter(prefix, items);
	}

	/**
	 * Complete undo mode keywords.
	 */
	completeUndo(prefix: string, inPlan: boolean): CompletionItem[] {
		const items: CompletionItem[] = [
			{ label: "back", detail: "Undo one action/group" },
			{ label: "forward", detail: "Redo one action/group" },
			{ label: "clear", detail: "Clear all undo history" },
			{ label: "diff", detail: "Show current diff" },
			{ label: "history", detail: "Show undo history" },
		];
		if (inPlan) {
			items.push(
				{ label: "apply", detail: "Commit plan group" },
				{ label: "discard", detail: "Discard plan group" },
			);
		} else {
			items.push(
				{ label: "plan", detail: "Start a plan group" },
			);
		}
		return fuzzyFilter(prefix, items);
	}
}

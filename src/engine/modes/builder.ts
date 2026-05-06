// ── Builder mode — main class + barrel re-exports ────────────────────

// Phase 4.2: Commands execute against live HISE via POST /api/builder/apply.
// Falls back to local-only validation when no connection is available.

import type { CommandResult } from "../result.js";
import {
	errorResult,
	jsonResult,
	preformattedResult,
	tableResult,
	textResult,
} from "../result.js";
import type {
	DataLoader,
	ModuleList,
} from "../data.js";
import { ConstrainerParser } from "../constrainer-parser.js";
import type { TreeNode } from "../result.js";
import type { TokenSpan } from "../highlight/tokens.js";
import { tokenizeBuilder } from "../highlight/builder.js";
import type { CompletionItem, CompletionResult, Mode, SessionContext } from "./mode.js";
import { MODE_ACCENTS } from "./mode.js";
import {
	isErrorResponse,
	isEnvelopeResponse,
} from "../hise.js";
import { stripQuotes } from "../string-utils.js";
import { findNodeById, resolveNodeByPath } from "../tree-utils.js";
import {
	normalizeBuilderTreeResponse,
	normalizeBuilderApplyResult,
	applyDiffToTree,
	cleanBuilderTreeForLlm,
} from "../../mock/contracts/builder.js";
import type { CompletionEngine } from "../completion/engine.js";
import { fuzzyFilter } from "../completion/engine.js";
import { builderLexer } from "./tokens.js";

// ── Re-exports from sub-modules ──────────────────────────────────

export type {
	AddCommand,
	CloneCommand,
	RemoveCommand,
	MoveCommand,
	RenameCommand,
	SetCommand,
	LoadCommand,
	BypassCommand,
	EnableCommand,
	GetCommand,
	ShowCommand,
	BuilderCommand,
} from "./builder-parser.js";
export {
	parseSingleCommand,
	parseBuilderInput,
} from "./builder-parser.js";
export type { ValidationResult } from "./builder-validate.js";
export {
	validateAddCommand,
	validateSetCommand,
	resolveModuleTypeId,
} from "./builder-validate.js";
export type { BuilderOp, ModuleInstance } from "./builder-ops.js";
export {
	resolveChainIndex,
	commandToOps,
	collectModuleIds,
} from "./builder-ops.js";

// Import for local use (BuilderMode methods)
import type {
	BuilderCommand,
	SetCommand,
	ShowCommand,
	GetCommand,
} from "./builder-parser.js";
import {
	parseSingleCommand,
	parseBuilderInput,
	findLastUnquotedComma,
} from "./builder-parser.js";
import {
	validateAddCommand,
	validateSetCommand,
	resolveModuleTypeId,
} from "./builder-validate.js";
import type { BuilderOp, ModuleInstance } from "./builder-ops.js";
import {
	resolveChainIndex,
	commandToOps,
	collectModuleIds,
	moduleIdCompletionItems,
	resolveInstanceType,
	compactTree,
	renderTreeBox,
} from "./builder-ops.js";

// ── Chain color constants (FX and MIDI are always fixed) ────────────

const FX_CHAIN_COLOUR = "#3a6666";
const MIDI_CHAIN_COLOUR = "#C65638";
const FALLBACK_CHAIN_COLOUR = "#666666"; // grey for chains with no resolved colour

/**
 * Walk a TreeNode tree and propagate chain colors + dot styles.
 *
 * Rules:
 * - Chain nodes: filledDot = false (○). colour = own colour, or
 *   FX/MIDI constant, or inherited from parent chain, or grey fallback.
 * - Module nodes inside a chain: filledDot = true (●). colour = inherited.
 * - Sound generators (not in a chain): no dot (filledDot/colour undefined).
 *   Their children start with a fresh colour context.
 *
 * Mutates the tree in place and returns it.
 */
type DiffStatus = "added" | "removed" | "modified";

function propagateChainColors(
	node: TreeNode,
	parentChainColour: string | null = null,
	parentDiff?: DiffStatus,
	depth: number = 0,
): TreeNode {
	// ── Resolve diff status ─────────────────────────────────────
	// Node's own diff wins. Otherwise inherit added/removed from parent.
	// "modified" is never inherited — it stays on the node that set it.
	const resolvedDiff: DiffStatus | undefined = node.diff
		?? (parentDiff === "added" || parentDiff === "removed" ? parentDiff : undefined);
	node.diff = resolvedDiff;

	// Diff to pass to children: propagate added/removed, not modified
	const childDiff: DiffStatus | undefined =
		resolvedDiff === "added" || resolvedDiff === "removed" ? resolvedDiff : undefined;

	if (node.nodeKind === "chain") {
		// Resolve this chain's colour
		let colour: string;
		if (node.colour && typeof node.colour === "string" && node.colour.startsWith("#")) {
			// Explicit hex colour from data
			colour = node.colour;
		} else if (node.label === "FX Chain") {
			colour = FX_CHAIN_COLOUR;
		} else if (node.label === "MIDI Processor Chain") {
			colour = MIDI_CHAIN_COLOUR;
		} else if (parentChainColour) {
			// Inherit from parent chain (sub-chains like AttackTimeModulation)
			colour = parentChainColour;
		} else {
			colour = FALLBACK_CHAIN_COLOUR;
		}

		node.colour = colour;
		node.filledDot = false; // unfilled ○
		// Dim empty chains (no children or empty children array)
		node.dimmed = !node.children || node.children.length === 0;

		// Propagate to children
		if (node.children) {
			for (const child of node.children) {
				propagateChainColors(child, colour, childDiff, depth + 1);
			}
		}
	} else if (node.nodeKind === "module" && parentChainColour) {
		// Module inside a chain — filled dot, inherited colour
		node.colour = parentChainColour;
		node.filledDot = true; // filled ●

		// Module's children (e.g. AHDSR's sub-chains) inherit the same colour
		if (node.children) {
			for (const child of node.children) {
				propagateChainColors(child, parentChainColour, childDiff, depth + 1);
			}
		}
	} else {
		// Sound generator or module not in a chain — no dot
		node.colour = undefined;
		node.filledDot = undefined;
		// Sound generators at depth > 0 get topMargin for visual separation
		// (root node is excluded — sidebar top padding handles that separately)
		node.topMargin = depth > 0;

		// Children start with fresh colour context (null) but inherit diff
		if (node.children) {
			for (const child of node.children) {
				propagateChainColors(child, null, childDiff, depth + 1);
			}
		}
	}

	return node;
}

// ── Builder mode class ──────────────────────────────────────────────

export class BuilderMode implements Mode {
	readonly id: Mode["id"] = "builder";
	readonly name = "Builder";
	readonly accent = MODE_ACCENTS.builder;
	readonly prompt = "[builder] > ";

	private moduleList: ModuleList | null = null;
	private readonly completionEngine: CompletionEngine | null;
	private currentPath: string[] = [];
	private treeRoot: TreeNode | null = null;
	/** Raw HISE response.result from the most recent fetchTree call.
	 *  Used by `show tree` in forLlm sessions to bypass ASCII rendering. */
	private lastTreeResult: unknown = null;
	compactView = false;

	constructor(moduleList?: ModuleList, completionEngine?: CompletionEngine, initialPath?: string, treeRoot?: TreeNode | null) {
		this.moduleList = moduleList ?? null;
		this.completionEngine = completionEngine ?? null;
		this.treeRoot = treeRoot ?? null;
		if (initialPath) {
			this.currentPath = initialPath.split(".").filter((s) => s !== "");
		}
	}

	tokenizeInput(value: string): TokenSpan[] {
		return tokenizeBuilder(value);
	}

	// ── Tree sidebar support ────────────────────────────────────

	getTree(): TreeNode | null {
		if (!this.treeRoot) return null;
		let tree = propagateChainColors(structuredClone(this.treeRoot));
		if (this.compactView) tree = compactTree(tree, this.currentPath);
		return tree;
	}

	getSelectedPath(): string[] {
		return [...this.currentPath];
	}

	selectNode(path: string[]): void {
		this.currentPath = [...path];
	}

	/** Dynamic context path shown in prompt (e.g. "SineGenerator.pitch") */
	get contextLabel(): string {
		return this.currentPath.length > 0 ? this.currentPath.join(".") : "";
	}

	setContext(path: string): void {
		this.currentPath = path.split(".").filter((s) => s !== "");
	}

	setModuleList(moduleList: ModuleList): void {
		this.moduleList = moduleList;
	}

	setTreeRoot(treeRoot: TreeNode | null): void {
		this.treeRoot = treeRoot;
	}

	complete(input: string, _cursor: number): CompletionResult {
		if (!this.completionEngine) {
			return { items: [], from: 0, to: input.length };
		}

		// Handle comma chaining: complete only the last segment
		const lastComma = findLastUnquotedComma(input);
		if (lastComma !== -1) {
			return this.completeSegment(
				input.slice(lastComma + 1),
				lastComma + 1,
				input.length,
			);
		}

		return this.completeSegment(input, 0, input.length);
	}

	/**
	 * Complete a single segment (no commas). `offset` is the position
	 * within the full input where this segment starts.
	 */
	private completeSegment(
		segment: string,
		offset: number,
		inputLength: number,
	): CompletionResult {
		const engine = this.completionEngine!;
		const trimmed = segment.trimStart();
		const leadingSpaces = segment.length - trimmed.length;
		const trailingSpace = segment.endsWith(" ");

		// Lex with Chevrotain to get proper tokens (handles quotes, numbers, keywords)
		const lexResult = builderLexer.tokenize(trimmed);
		const tokens = lexResult.tokens;

		const empty: CompletionResult = { items: [], from: offset, to: inputLength };

		// No tokens or typing first word - suggest keywords
		if (tokens.length === 0 || (tokens.length === 1 && !trailingSpace)) {
			const prefix = tokens.length > 0 ? tokens[0].image.toLowerCase() : "";
			const items = engine.completeBuilderKeyword(prefix);
			return {
				items,
				from: offset + leadingSpaces,
				to: inputLength,
				label: "Builder keywords",
			};
		}

		const verb = tokens[0].image.toLowerCase();

		// ── cd <child> — complete with children of current node ──
		if (verb === "cd") {
			return this.completeCd(tokens, trailingSpace, offset, inputLength, segment);
		}

		const modules = collectModuleIds(this.treeRoot);
		const moduleItems = moduleIdCompletionItems(modules);

		// ── add <type> [as "<name>"] [to <target>[.<chain>]] ──
		if (verb === "add") {
			return this.completeAdd(tokens, trailingSpace, offset, inputLength, segment, modules, moduleItems);
		}

		// ── set <target>.<param> [to] <value> ──
		// ── get <target>.<param> ──
		if (verb === "set" || verb === "get") {
			return this.completeSet(tokens, trailingSpace, offset, inputLength, segment, modules);
		}

		// ── show tree | types [filter] | <target> ──
		if (verb === "show") {
			if (tokens.length === 1 && trailingSpace) {
				// Merge show subcommands + module IDs
				const showItems = engine.completeBuilderShow("");
				const items = [...showItems, ...moduleItems];
				return { items, from: offset + segment.length, to: inputLength, label: "Show arguments" };
			}
			if (tokens.length === 2 && !trailingSpace) {
				const prefix = tokens[1].image;
				const showItems = engine.completeBuilderShow(prefix);
				const idItems = fuzzyFilter(prefix, moduleItems);
				const items = [...showItems, ...idItems];
				const from = offset + (tokens[1].startOffset ?? 0) + leadingSpaces;
				return { items, from, to: inputLength, label: "Show arguments" };
			}
			return empty;
		}

		// ── Commands that take a single target: remove, clone, bypass, enable, rename ──
		const TARGET_COMMANDS = ["remove", "clone", "bypass", "enable", "rename", "move", "load"];
		if (TARGET_COMMANDS.includes(verb)) {
			return this.completeTarget(tokens, trailingSpace, offset, inputLength, segment, moduleItems);
		}

		return empty;
	}

	private completeCd(
		tokens: import("chevrotain").IToken[],
		trailingSpace: boolean,
		offset: number,
		inputLength: number,
		segment: string,
	): CompletionResult {
		const empty: CompletionResult = { items: [], from: offset, to: inputLength };

		// Find the node at the current path
		const contextNode = resolveNodeByPath(this.treeRoot, this.currentPath) ?? this.treeRoot;
		if (!contextNode?.children) return empty;

		// Build completion items from children
		const childItems: CompletionItem[] = contextNode.children.map((c) => ({
			label: c.label,
			detail: c.nodeKind === "chain" ? "chain" : (c.type ?? ""),
			insertText: c.label.includes(" ") ? `"${c.label}"` : c.label,
		}));

		// "cd " — show all children
		if (tokens.length === 1 && trailingSpace) {
			return { items: childItems, from: offset + segment.length, to: inputLength, label: "Children" };
		}

		// "cd Fx" or "cd "FX Ch" — filter by prefix
		if (tokens.length >= 2) {
			const prefixTokens = tokens.slice(1);
			let prefix = prefixTokens.map((t) => t.image).join(" ");
			// Strip quotes from QuotedString tokens
			if (prefix.startsWith('"')) prefix = prefix.slice(1);
			if (prefix.endsWith('"')) prefix = prefix.slice(0, -1);
			const from = offset + prefixTokens[0].startOffset;
			const items = fuzzyFilter(prefix, childItems);
			return { items, from, to: inputLength, label: "Children" };
		}

		return empty;
	}

	/** Filter module type completions by the current chain's constrainer. */
	private filterByChainContext(items: CompletionItem[]): CompletionItem[] {
		const contextNode = resolveNodeByPath(this.treeRoot, this.currentPath);
		if (!contextNode || contextNode.nodeKind !== "chain" || !contextNode.chainConstrainer) {
			return items;
		}

		const constrainer = new ConstrainerParser(contextNode.chainConstrainer);
		return items.filter((item) => {
			// detail is the type ID (e.g., "SineSynth"), insertText is also the type ID
			const typeId = item.insertText ?? item.detail ?? item.label;
			const mod = this.moduleList?.modules.find((m) => m.id === typeId);
			if (!mod) return false;
			return constrainer.check({ id: mod.id, subtype: mod.subtype }).ok;
		});
	}

	private completeAdd(
		tokens: import("chevrotain").IToken[],
		trailingSpace: boolean,
		offset: number,
		inputLength: number,
		segment: string,
		modules: ModuleInstance[],
		moduleItems: CompletionItem[],
	): CompletionResult {
		const engine = this.completionEngine!;

		// Position 1: module type (filtered by chain context if cd'd into a chain)
		if (tokens.length === 1 && trailingSpace) {
			const items = this.filterByChainContext(engine.completeModuleType(""));
			return { items, from: offset + segment.length, to: inputLength, label: "Module types" };
		}
		if (tokens.length === 2 && !trailingSpace) {
			const prefix = tokens[1].image;
			const items = this.filterByChainContext(engine.completeModuleType(prefix));
			const from = offset + tokens[1].startOffset;
			return { items, from, to: inputLength, label: "Module types" };
		}

		// After type + space: check if "to" or "as" already present
		const lastToken = tokens[tokens.length - 1];
		const lastImage = lastToken.image.toLowerCase();

		// After "to" keyword - complete with module instance IDs
		if (lastImage === "to" && trailingSpace) {
			return { items: moduleItems, from: offset + segment.length, to: inputLength, label: "Module targets" };
		}

		// Typing after "to " - completing a target
		const toIndex = tokens.findIndex((t) => t.image.toLowerCase() === "to");
		if (toIndex !== -1 && toIndex < tokens.length - 1) {
			// Currently typing a target after "to"
			const targetTokens = tokens.slice(toIndex + 1);
			const lastTargetToken = targetTokens[targetTokens.length - 1];
			if (!trailingSpace && lastTargetToken.image !== ".") {
				const prefix = lastTargetToken.image;
				const items = fuzzyFilter(prefix, moduleItems);
				const from = offset + lastTargetToken.startOffset;
				return { items, from, to: inputLength, label: "Module targets" };
			}
		}

		return { items: [], from: offset, to: inputLength };
	}

	private completeSet(
		tokens: import("chevrotain").IToken[],
		trailingSpace: boolean,
		offset: number,
		inputLength: number,
		segment: string,
		modules: ModuleInstance[],
	): CompletionResult {
		const engine = this.completionEngine!;
		const moduleItems = moduleIdCompletionItems(modules);

		// After "set " - complete with module IDs (target before dot)
		if (tokens.length === 1 && trailingSpace) {
			return { items: moduleItems, from: offset + segment.length, to: inputLength, label: "Module targets" };
		}

		// Find the dot that separates target from param
		const dotIndex = tokens.findIndex((t) => t.image === ".");
		if (dotIndex === -1) {
			// No dot yet - still typing target
			if (!trailingSpace) {
				const lastToken = tokens[tokens.length - 1];
				const prefix = lastToken.image;
				const items = fuzzyFilter(prefix, moduleItems);
				const from = offset + lastToken.startOffset;
				return { items, from, to: inputLength, label: "Module targets" };
			}
			// Trailing space but no dot - still accumulating multi-word target
			return { items: moduleItems, from: offset + segment.length, to: inputLength, label: "Module targets" };
		}

		// Dot found - resolve target type and complete params
		const targetTokens = tokens.slice(1, dotIndex);
		let targetName: string;
		if (targetTokens.length === 1 && targetTokens[0].tokenType.name === "QuotedString") {
			targetName = stripQuotes(targetTokens[0].image);
		} else {
			targetName = targetTokens.map((t) => t.image).join(" ");
		}

		// Resolve instance to type for parameter lookup
		const moduleType = resolveInstanceType(targetName, modules)
			?? targetName; // fallback to treating target as type name

		const paramIndex = dotIndex + 1;
		if (paramIndex >= tokens.length) {
			// "set Target." or "set Target. " - complete params (dot is last token)
			const items = engine.completeModuleParam(moduleType, "");
			return { items, from: offset + segment.length, to: inputLength, label: `${targetName} parameters` };
		}
		if (!trailingSpace) {
			// "set Target.Att" - filtering params
			const prefix = tokens[paramIndex].image;
			const items = engine.completeModuleParam(moduleType, prefix);
			const from = offset + tokens[paramIndex].startOffset;
			return { items, from, to: inputLength, label: `${targetName} parameters` };
		}

		return { items: [], from: offset, to: inputLength };
	}

	private completeTarget(
		tokens: import("chevrotain").IToken[],
		trailingSpace: boolean,
		offset: number,
		inputLength: number,
		segment: string,
		moduleItems: CompletionItem[],
	): CompletionResult {
		// After verb + space: complete with module IDs
		if (tokens.length === 1 && trailingSpace) {
			return { items: moduleItems, from: offset + segment.length, to: inputLength, label: "Module targets" };
		}

		// Typing the target
		if (!trailingSpace) {
			const lastToken = tokens[tokens.length - 1];
			const prefix = lastToken.image;
			const items = fuzzyFilter(prefix, moduleItems);
			const from = offset + lastToken.startOffset;
			return { items, from, to: inputLength, label: "Module targets" };
		}

		return { items: [], from: offset, to: inputLength };
	}

	// ── Tree fetching ───────────────────────────────────────────

	private treeFetched = false;

	/** Fetch the module tree from HISE and update treeRoot.
	 *  Detects plan state via undo diff — uses ?group=current when a plan group is active. */
	async fetchTree(connection: import("../hise.js").HiseConnection): Promise<void> {
		// Detect plan state: if groupName !== "root", use plan tree endpoint
		let inPlan = false;
		const diffResp = await connection.get("/api/undo/diff?scope=group");
		if (isEnvelopeResponse(diffResp) && diffResp.success) {
			const groupName = diffResp.groupName as string | undefined;
			inPlan = typeof groupName === "string" && groupName !== "root";
		}

		const endpoint = inPlan ? "/api/builder/tree?group=current" : "/api/builder/tree";
		const response = await connection.get(endpoint);
		if (isErrorResponse(response)) return;
		if (!isEnvelopeResponse(response) || !response.success) return;
		this.lastTreeResult = response.result ?? null;
		try {
			this.treeRoot = normalizeBuilderTreeResponse(response.result);
		} catch {
			// Normalization failed — keep existing tree
		}
	}

	/** Lazily fetch the tree on first parse if connected and not yet fetched. */
	private async ensureTree(session: SessionContext): Promise<void> {
		if (!this.treeFetched && session.connection) {
			this.treeFetched = true;
			await this.fetchTree(session.connection);
		}
	}

	/** Mark the cached tree as stale so it re-fetches on next parse. */
	invalidateTree(): void {
		this.treeFetched = false;
	}

	/** Fetch tree on mode entry so the sidebar shows content immediately. */
	async onEnter(session: SessionContext): Promise<void> {
		await this.ensureTree(session);
	}

	// ── Parse entry point ───────────────────────────────────────

	async parse(
		input: string,
		session: SessionContext,
	): Promise<CommandResult> {
		await this.ensureTree(session);

		const trimmed = input.trim();
		const parts = trimmed.split(/\s+/);
		const keyword = parts[0]?.toLowerCase();

		// ── Navigation commands (handled before Chevrotain parser) ──
		if (keyword === "cd") {
			let cdTarget = parts.slice(1).join(" ").trim();
			// Strip surrounding quotes
			if (cdTarget.startsWith('"') && cdTarget.endsWith('"')) {
				cdTarget = cdTarget.slice(1, -1);
			}
			return this.handleCd(cdTarget, session);
		}
		if (keyword === "ls" || keyword === "dir") {
			return this.handleLs();
		}
		if (keyword === "pwd") {
			return this.handlePwd();
		}
		if (keyword === "reset") {
			return this.handleReset(session);
		}

		// ── Chevrotain-parsed builder commands ──
		const result = parseBuilderInput(input);

		if ("error" in result) {
			return errorResult(result.error);
		}

		// Execute all commands from comma chaining; return last result
		let lastResult: CommandResult = textResult("(no commands)");
		for (const cmd of result.commands) {
			lastResult = await this.dispatchCommand(cmd, session);
			if (lastResult.type === "error") return lastResult;
		}
		return lastResult;
	}

	// ── Navigation handlers ─────────────────────────────────────────

	private handleCd(target: string, session: SessionContext): CommandResult {
		if (!target || target === "/") {
			this.currentPath = [];
			return textResult("/");
		}

		if (target === "..") {
			if (this.currentPath.length === 0) {
				return session.popMode();
			}
			this.currentPath.pop();
			return textResult(this.currentPath.length > 0 ? this.currentPath.join(".") : "/");
		}

		// Navigate down — validate against tree if available
		const segments = target.split(".").filter((s) => s !== "");
		for (const seg of segments) {
			if (seg === "..") {
				if (this.currentPath.length > 0) this.currentPath.pop();
			} else {
				// Validate the segment exists in the tree
				if (this.treeRoot) {
					const node = findNodeById(this.treeRoot, seg);
					if (!node) {
						return errorResult(`"${seg}" not found in module tree.`);
					}
				}
				this.currentPath.push(seg);
			}
		}
		return textResult(this.currentPath.join("."));
	}

	private handleLs(): CommandResult {
		if (!this.treeRoot) {
			const path = this.currentPath.length > 0 ? this.currentPath.join(".") : "/";
			return textResult(
				`${path}: listing children requires a HISE connection (use show types for available module types)`,
			);
		}

		// Find the node at the current path
		let node: TreeNode | null = this.treeRoot;
		if (this.currentPath.length > 0) {
			node = findNodeById(this.treeRoot, this.currentPath[this.currentPath.length - 1]);
		}
		if (!node) {
			return errorResult(`Path not found: ${this.currentPath.join(".")}`);
		}

		if (!node.children || node.children.length === 0) {
			return textResult(`${node.label}: (no children)`);
		}

		return tableResult(
			["Name", "Type", "Kind"],
			node.children.map((c) => [
				c.label,
				c.type ?? "",
				c.nodeKind ?? "",
			]),
		);
	}

	private handlePwd(): CommandResult {
		return textResult(this.currentPath.length > 0 ? this.currentPath.join(".") : "/");
	}

	private async handleReset(session: SessionContext): Promise<CommandResult> {
		if (!session.connection) {
			return errorResult("reset requires a HISE connection");
		}
		const response = await session.connection.post("/api/builder/reset", {});
		if (isErrorResponse(response)) {
			return errorResult(response.message);
		}
		if (!isEnvelopeResponse(response) || !response.success) {
			const msg = isEnvelopeResponse(response) && response.errors.length > 0
				? response.errors.map((e) => e.errorMessage).join("\n")
				: "Reset failed";
			return errorResult(msg);
		}
		this.treeRoot = null;
		this.currentPath = [];
		this.treeFetched = false;
		// HISE discards undo groups on reset — sync the TUI's plan state
		session.resetPlanState?.();
		await this.fetchTree(session.connection);
		return textResult(response.logs.length > 0 ? response.logs.join("; ") : "Module tree reset");
	}

	// ── Command dispatch and execution ──────────────────────────

	private async dispatchCommand(
		cmd: BuilderCommand,
		session: SessionContext,
	): Promise<CommandResult> {
		// Get command — fetch single parameter value
		if (cmd.type === "get") {
			return this.handleGet(cmd, session.connection ?? null);
		}

		// Show commands are always local (except show target which may fetch params)
		if (cmd.type === "show") {
			return this.handleShow(cmd, session);
		}

		// Move is not yet in C++ API
		if (cmd.type === "move") {
			const dest = cmd.chain ? `${cmd.parent}.${cmd.chain}` : cmd.parent;
			return textResult(`move ${cmd.target} to ${dest} (not yet in HISE C++ API)`);
		}

		// Never allow removing the root container
		if (cmd.type === "remove" && this.treeRoot) {
			const rootId = this.treeRoot.id ?? this.treeRoot.label;
			if (cmd.target.toLowerCase() === rootId.toLowerCase()) {
				return errorResult("Cannot remove the root container.");
			}
		}

		// Local validation for add and set
		if (cmd.type === "add" && this.moduleList) {
			const validation = validateAddCommand(cmd, this.moduleList);
			if (!validation.valid) {
				return errorResult(validation.errors.join("\n"));
			}
		}
		if (cmd.type === "set" && this.moduleList) {
			const validation = validateSetCommand(cmd, this.moduleList);
			if (!validation.valid) {
				return errorResult(validation.errors.join("\n"));
			}
		}

		// If no connection, return local-only result
		if (!session.connection) {
			return this.localFallback(cmd);
		}

		// Build API operations
		const opsResult = commandToOps(cmd, this.treeRoot, this.moduleList, this.currentPath);
		if ("error" in opsResult) {
			return errorResult(opsResult.error);
		}

		// Execute against HISE
		const result = await this.executeOps(opsResult.ops, session.connection);

		if (result.type !== "error") {
			session.markProjectTreeDirty?.();
		}

		// For successful set commands, echo the changed parameter as a table row
		if (cmd.type === "set" && result.type !== "error") {
			const echo = await this.echoSetParam(cmd, session.connection);
			if (echo) return echo;
		}

		return result;
	}

	/** Execute operations against POST /api/builder/apply, re-fetch tree. */
	private async executeOps(
		ops: BuilderOp[],
		connection: import("../hise.js").HiseConnection,
	): Promise<CommandResult> {
		const response = await connection.post("/api/builder/apply", { operations: ops });

		if (isErrorResponse(response)) {
			return errorResult(response.message);
		}
		if (!isEnvelopeResponse(response)) {
			return errorResult("Unexpected response from HISE");
		}
		if (!response.success) {
			const msg = response.errors.length > 0
				? response.errors.map((e) => e.errorMessage).join("\n")
				: "Builder operation failed";
			return errorResult(msg);
		}

		// Parse the diff result — new API has scope/groupName/diff at top level
		const applyResult = normalizeBuilderApplyResult(response);

		// Re-fetch the tree to get the updated state
		await this.fetchTree(connection);

		// Apply diff markers to the refreshed tree for sidebar indicators
		if (applyResult?.diff && this.treeRoot) {
			applyDiffToTree(this.treeRoot, applyResult.diff);
		}

		// Build a human-readable summary from logs
		const summary = response.logs.length > 0
			? response.logs.join("; ")
			: (applyResult?.diff ?? []).map((d) => `${d.action} ${d.target}`).join(", ") || "OK";

		return textResult(summary);
	}

	/** After a successful set, fetch the updated parameter and return it as a single-row table. */
	private async echoSetParam(
		cmd: SetCommand,
		connection: import("../hise.js").HiseConnection,
	): Promise<CommandResult | null> {
		const response = await connection.get(
			`/api/builder/tree?moduleId=${encodeURIComponent(cmd.target)}`,
		);
		if (!isEnvelopeResponse(response) || !response.success) return null;
		const raw = response.result as Record<string, unknown>;
		const params = raw.parameters as Array<{
			id: string;
			value: number;
			valueAsString: string;
			range: { min: number; max: number };
			defaultValue: number;
		}> | undefined;
		if (!params) return null;
		const param = params.find((p) => p.id === cmd.param);
		if (!param) return null;
		return tableResult(
			["Parameter", "Value", "Range", "Default"],
			[[
				param.id,
				param.valueAsString ?? String(param.value),
				`${param.range.min} – ${param.range.max}`,
				String(param.defaultValue),
			]],
		);
	}

	/** Fallback for disconnected mode — validation + description only. */
	private localFallback(cmd: BuilderCommand): CommandResult {
		switch (cmd.type) {
			case "add": {
				const parts = [`add ${cmd.moduleType}`];
				if (cmd.alias) parts.push(`as "${cmd.alias}"`);
				if (cmd.parent) {
					const dest = cmd.chain ? `${cmd.parent}.${cmd.chain}` : cmd.parent;
					parts.push(`to ${dest}`);
				}
				return textResult(`${parts.join(" ")} (no HISE connection)`);
			}
			case "set":
				return textResult(`set ${cmd.target}.${cmd.param} to ${cmd.value} (no HISE connection)`);
			case "clone": {
				const parts = [`clone ${cmd.source}`];
				if (cmd.count > 1) parts.push(`x${cmd.count}`);
				return textResult(`${parts.join(" ")} (no HISE connection)`);
			}
			case "remove":
				return textResult(`remove ${cmd.target} (no HISE connection)`);
			case "rename":
				return textResult(`rename ${cmd.target} to "${cmd.name}" (no HISE connection)`);
			case "load":
				return textResult(`load "${cmd.source}" into ${cmd.target} (no HISE connection)`);
			case "bypass":
				return textResult(`bypass ${cmd.target} (no HISE connection)`);
			case "enable":
				return textResult(`enable ${cmd.target} (no HISE connection)`);
			case "get":
				return textResult(`get ${cmd.target}.${cmd.param} (no HISE connection)`);
			default:
				return textResult("(no HISE connection)");
		}
	}

	private async handleShow(
		cmd: ShowCommand,
		session: SessionContext,
	): Promise<CommandResult> {
		const connection = session.connection ?? null;
		if (cmd.what === "types") {
			if (!this.moduleList) {
				return errorResult("Module data not loaded");
			}
			let modules = this.moduleList.modules;
			if (cmd.filter) {
				const f = cmd.filter.toLowerCase();
				modules = modules.filter((m) =>
					m.id.toLowerCase().includes(f)
					|| m.type.toLowerCase().includes(f)
					|| m.subtype.toLowerCase().includes(f),
				);
			}
			if (modules.length === 0) {
				return textResult(
					cmd.filter
						? `(no module types match "${cmd.filter}" — try "show types" without a filter to list all)`
						: "(no module types available)",
				);
			}
			return tableResult(
				["Module", "Type", "Subtype", "Category"],
				modules.map((m) => [
					m.id,
					m.type,
					m.subtype,
					m.category.join(", "),
				]),
			);
		}

		if (cmd.what === "target") {
			return this.handleShowTarget(cmd.target!, connection);
		}

		// show tree — emit cleaned HISE result for LLM sessions, ASCII tree otherwise
		if (session.forLlm) {
			if (!this.lastTreeResult) {
				return textResult("No module tree available (requires HISE connection).");
			}
			return jsonResult(cleanBuilderTreeForLlm(this.lastTreeResult));
		}
		if (!this.treeRoot) {
			return textResult("No module tree available (requires HISE connection).");
		}
		const tree = this.getTree();
		if (!tree) return textResult("No module tree available (requires HISE connection).");
		const pwdNode = this.currentPath.length > 0 ? resolveNodeByPath(tree, this.currentPath) : null;
		return preformattedResult(renderTreeBox(tree, { pwdNode, compact: this.compactView }), undefined, true);
	}

	private async handleGet(
		cmd: GetCommand,
		connection: import("../hise.js").HiseConnection | null,
	): Promise<CommandResult> {
		if (!connection) {
			return textResult(`get ${cmd.target}.${cmd.param} (no HISE connection)`);
		}

		const response = await connection.get(
			`/api/builder/tree?moduleId=${encodeURIComponent(cmd.target)}`,
		);

		if (!isEnvelopeResponse(response) || !response.success) {
			return errorResult(`Module "${cmd.target}" not found`);
		}

		const raw = response.result as Record<string, unknown>;
		const params = raw.parameters as Array<{
			id: string;
			value: number;
			valueAsString: string;
			range: { min: number; max: number };
			defaultValue: number;
		}> | undefined;

		if (!params) {
			return errorResult(`Module "${cmd.target}" has no parameters`);
		}

		const param = params.find((p) => p.id === cmd.param);
		if (!param) {
			return errorResult(`Parameter "${cmd.param}" not found on "${cmd.target}"`);
		}

		return textResult(param.valueAsString ?? String(param.value));
	}

	private async handleShowTarget(
		target: string,
		connection: import("../hise.js").HiseConnection | null,
	): Promise<CommandResult> {
		// Fetch live parameters from HISE
		if (connection) {
			const response = await connection.get(
				`/api/builder/tree?moduleId=${encodeURIComponent(target)}`,
			);
			if (isEnvelopeResponse(response) && response.success) {
				const raw = response.result as Record<string, unknown>;
				const params = raw.parameters as Array<{
					id: string;
					value: number;
					valueAsString: string;
					range: { min: number; max: number };
					defaultValue: number;
				}> | undefined;

				if (params && params.length > 0) {
					return tableResult(
						["Parameter", "Value", "Range", "Default"],
						params.map((p) => [
							p.id,
							p.valueAsString ?? String(p.value),
							`${p.range.min} – ${p.range.max}`,
							String(p.defaultValue),
						]),
					);
				}

				// Module found but no parameters
				const label = (raw.processorId as string) ?? target;
				const type = (raw.prettyName as string) ?? (raw.id as string) ?? "unknown";
				return textResult(`${label} (${type}) — no parameters`);
			}
		}

		// Fallback: use cached tree for basic info
		if (this.treeRoot) {
			const node = findNodeById(this.treeRoot, target);
			if (node) {
				const info = [`${node.label} (${node.type ?? "unknown"})`];
				if (node.children) {
					info.push(`  ${node.children.length} children`);
				}
				return textResult(info.join("\n"));
			}
		}
		return errorResult(`Module "${target}" not found`);
	}
}

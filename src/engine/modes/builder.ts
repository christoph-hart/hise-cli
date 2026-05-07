// ── Builder mode — main class + barrel re-exports ────────────────────

import type { CommandResult } from "../result.js";
import {
	errorResult,
	jsonResult,
	preformattedResult,
	tableResult,
	textResult,
} from "../result.js";
import type {
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
import { resolvePath } from "../grammar/path-resolver.js";
import {
	pathRefSegments,
	pathRefToString,
	type PathRef,
} from "../grammar/path-parser.js";

// ── Re-exports from sub-modules ──────────────────────────────────

export type {
	AddCommand,
	AddChainCommand,
	CloneCommand,
	RemoveCommand,
	RenameCommand,
	SetCommand,
	SetClause,
	GetCommand,
	ShowCommand,
	ListCommand,
	CdCommand,
	LsCommand,
	PwdCommand,
	ResetCommand,
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
	validateRenameCommand,
	validateCloneCommand,
	resolveModuleTypeId,
} from "./builder-validate.js";
export type { BuilderOp, ModuleInstance } from "./builder-ops.js";
export {
	resolveChainIndex,
	commandToOps,
	collectModuleIds,
} from "./builder-ops.js";

import type {
	BuilderCommand,
	CdCommand,
	GetCommand,
	ListCommand,
	SetCommand,
	ShowCommand,
} from "./builder-parser.js";
import {
	parseSingleCommand,
	parseBuilderInput,
	findLastUnquotedComma,
} from "./builder-parser.js";
import {
	validateAddCommand,
	validateSetCommand,
} from "./builder-validate.js";
import type { BuilderOp, ModuleInstance } from "./builder-ops.js";
import {
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
const FALLBACK_CHAIN_COLOUR = "#666666";

type DiffStatus = "added" | "removed" | "modified";

function propagateChainColors(
	node: TreeNode,
	parentChainColour: string | null = null,
	parentDiff?: DiffStatus,
	depth: number = 0,
): TreeNode {
	const resolvedDiff: DiffStatus | undefined = node.diff
		?? (parentDiff === "added" || parentDiff === "removed" ? parentDiff : undefined);
	node.diff = resolvedDiff;

	const childDiff: DiffStatus | undefined =
		resolvedDiff === "added" || resolvedDiff === "removed" ? resolvedDiff : undefined;

	if (node.nodeKind === "chain") {
		let colour: string;
		if (node.colour && typeof node.colour === "string" && node.colour.startsWith("#")) {
			colour = node.colour;
		} else if (node.label === "FX Chain") {
			colour = FX_CHAIN_COLOUR;
		} else if (node.label === "MIDI Processor Chain") {
			colour = MIDI_CHAIN_COLOUR;
		} else if (parentChainColour) {
			colour = parentChainColour;
		} else {
			colour = FALLBACK_CHAIN_COLOUR;
		}

		node.colour = colour;
		node.filledDot = false;
		node.dimmed = !node.children || node.children.length === 0;

		if (node.children) {
			for (const child of node.children) {
				propagateChainColors(child, colour, childDiff, depth + 1);
			}
		}
	} else if (node.nodeKind === "module" && parentChainColour) {
		node.colour = parentChainColour;
		node.filledDot = true;

		if (node.children) {
			for (const child of node.children) {
				propagateChainColors(child, parentChainColour, childDiff, depth + 1);
			}
		}
	} else {
		node.colour = undefined;
		node.filledDot = undefined;
		node.topMargin = depth > 0;

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

	private completeSegment(
		segment: string,
		offset: number,
		inputLength: number,
	): CompletionResult {
		const engine = this.completionEngine!;
		const trimmed = segment.trimStart();
		const leadingSpaces = segment.length - trimmed.length;
		const trailingSpace = segment.endsWith(" ");

		const lexResult = builderLexer.tokenize(trimmed);
		const tokens = lexResult.tokens;

		const empty: CompletionResult = { items: [], from: offset, to: inputLength };

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

		if (verb === "cd") {
			return this.completeCd(tokens, trailingSpace, offset, inputLength, segment);
		}

		const modules = collectModuleIds(this.treeRoot);
		const moduleItems = moduleIdCompletionItems(modules);

		if (verb === "add") {
			return this.completeAdd(tokens, trailingSpace, offset, inputLength, segment, modules, moduleItems);
		}

		if (verb === "set" || verb === "get") {
			return this.completeSet(tokens, trailingSpace, offset, inputLength, segment, modules);
		}

		if (verb === "show") {
			if (tokens.length === 1 && trailingSpace) {
				return { items: moduleItems, from: offset + segment.length, to: inputLength, label: "Show targets" };
			}
			if (tokens.length === 2 && !trailingSpace) {
				const prefix = tokens[1].image;
				const items = fuzzyFilter(prefix, moduleItems);
				const from = offset + (tokens[1].startOffset ?? 0) + leadingSpaces;
				return { items, from, to: inputLength, label: "Show targets" };
			}
			return empty;
		}

		if (verb === "list") {
			const nouns: CompletionItem[] = [
				{ label: "types", detail: "module type catalog" },
				{ label: "tree", detail: "module tree" },
			];
			if (tokens.length === 1 && trailingSpace) {
				return { items: nouns, from: offset + segment.length, to: inputLength, label: "List nouns" };
			}
			if (tokens.length === 2 && !trailingSpace) {
				const prefix = tokens[1].image.toLowerCase();
				const items = nouns.filter((i) => i.label.startsWith(prefix));
				const from = offset + (tokens[1].startOffset ?? 0) + leadingSpaces;
				return { items, from, to: inputLength, label: "List nouns" };
			}
			return empty;
		}

		const TARGET_COMMANDS = ["remove", "clone", "rename"];
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

		const contextNode = resolveNodeByPath(this.treeRoot, this.currentPath) ?? this.treeRoot;
		if (!contextNode?.children) return empty;

		const childItems: CompletionItem[] = contextNode.children.map((c) => ({
			label: c.label,
			detail: c.nodeKind === "chain" ? "chain" : (c.type ?? ""),
			insertText: c.label.includes(" ") ? `"${c.label}"` : c.label,
		}));

		if (tokens.length === 1 && trailingSpace) {
			return { items: childItems, from: offset + segment.length, to: inputLength, label: "Children" };
		}

		if (tokens.length >= 2) {
			const prefixTokens = tokens.slice(1);
			let prefix = prefixTokens.map((t) => t.image).join(" ");
			if (prefix.startsWith('"')) prefix = prefix.slice(1);
			if (prefix.endsWith('"')) prefix = prefix.slice(0, -1);
			const from = offset + prefixTokens[0].startOffset;
			const items = fuzzyFilter(prefix, childItems);
			return { items, from, to: inputLength, label: "Children" };
		}

		return empty;
	}

	private filterByChainContext(items: CompletionItem[]): CompletionItem[] {
		const contextNode = resolveNodeByPath(this.treeRoot, this.currentPath);
		if (!contextNode || contextNode.nodeKind !== "chain" || !contextNode.chainConstrainer) {
			return items;
		}

		const constrainer = new ConstrainerParser(contextNode.chainConstrainer);
		return items.filter((item) => {
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
		_modules: ModuleInstance[],
		moduleItems: CompletionItem[],
	): CompletionResult {
		const engine = this.completionEngine!;

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

		const lastToken = tokens[tokens.length - 1];
		const lastImage = lastToken.image.toLowerCase();

		if (lastImage === "to" && trailingSpace) {
			return { items: moduleItems, from: offset + segment.length, to: inputLength, label: "Module targets" };
		}

		const toIndex = tokens.findIndex((t) => t.image.toLowerCase() === "to");
		if (toIndex !== -1 && toIndex < tokens.length - 1) {
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

		if (tokens.length === 1 && trailingSpace) {
			return { items: moduleItems, from: offset + segment.length, to: inputLength, label: "Module targets" };
		}

		const dotIndex = tokens.findIndex((t) => t.image === ".");
		if (dotIndex === -1) {
			if (!trailingSpace) {
				const lastToken = tokens[tokens.length - 1];
				const prefix = lastToken.image;
				const items = fuzzyFilter(prefix, moduleItems);
				const from = offset + lastToken.startOffset;
				return { items, from, to: inputLength, label: "Module targets" };
			}
			return { items: moduleItems, from: offset + segment.length, to: inputLength, label: "Module targets" };
		}

		const targetTokens = tokens.slice(1, dotIndex);
		let targetName: string;
		if (targetTokens.length === 1 && targetTokens[0].tokenType.name === "QuotedString") {
			targetName = stripQuotes(targetTokens[0].image);
		} else {
			targetName = targetTokens.map((t) => t.image).join(" ");
		}

		const moduleType = resolveInstanceType(targetName, modules) ?? targetName;

		const paramIndex = dotIndex + 1;
		if (paramIndex >= tokens.length) {
			const items = engine.completeModuleParam(moduleType, "");
			return { items, from: offset + segment.length, to: inputLength, label: `${targetName} parameters` };
		}
		if (!trailingSpace) {
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
		if (tokens.length === 1 && trailingSpace) {
			return { items: moduleItems, from: offset + segment.length, to: inputLength, label: "Module targets" };
		}

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

	async fetchTree(connection: import("../hise.js").HiseConnection): Promise<void> {
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

	private async ensureTree(session: SessionContext): Promise<void> {
		if (!this.treeFetched && session.connection) {
			this.treeFetched = true;
			await this.fetchTree(session.connection);
		}
	}

	invalidateTree(): void {
		this.treeFetched = false;
	}

	async onEnter(session: SessionContext): Promise<void> {
		await this.ensureTree(session);
	}

	// ── Parse entry point ───────────────────────────────────────

	async parse(
		input: string,
		session: SessionContext,
	): Promise<CommandResult> {
		await this.ensureTree(session);

		const result = parseBuilderInput(input);
		if ("error" in result) {
			return errorResult(result.error);
		}

		let lastResult: CommandResult = textResult("(no commands)");
		for (const cmd of result.commands) {
			lastResult = await this.dispatchCommand(cmd, session);
			if (lastResult.type === "error") return lastResult;
		}
		return lastResult;
	}

	// ── Navigation handlers ─────────────────────────────────────────

	private handleCd(cmd: CdCommand, session: SessionContext): CommandResult {
		if (cmd.target.kind === "parent") {
			if (this.currentPath.length === 0) {
				return session.popMode();
			}
			this.currentPath.pop();
			return textResult(this.currentPath.length > 0 ? this.currentPath.join(".") : "/");
		}

		if (!this.treeRoot) {
			// Offline — accept the literal segments as a relative descent.
			const segs = pathRefSegments(cmd.target);
			for (const seg of segs) this.currentPath.push(seg.id);
			return textResult(this.currentPath.length > 0 ? this.currentPath.join(".") : "/");
		}

		const r = resolvePath(this.treeRoot, this.currentPath, cmd.target, "cd");
		if (!r.ok) {
			return errorResult(r.message);
		}
		const rootId = this.treeRoot.id;
		const stripped = (rootId && r.fullPath[0]?.toLowerCase() === rootId.toLowerCase())
			? r.fullPath.slice(1)
			: r.fullPath;
		this.currentPath = stripped;
		return textResult(this.currentPath.length > 0 ? this.currentPath.join(".") : "/");
	}

	private handleLs(): CommandResult {
		if (!this.treeRoot) {
			const path = this.currentPath.length > 0 ? this.currentPath.join(".") : "/";
			return textResult(
				`${path}: listing children requires a HISE connection (use list types for available module types)`,
			);
		}

		const node = resolveNodeByPath(this.treeRoot, this.currentPath) ?? this.treeRoot;
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
		session.resetPlanState?.();
		await this.fetchTree(session.connection);
		return textResult(response.logs.length > 0 ? response.logs.join("; ") : "Module tree reset");
	}

	// ── Command dispatch and execution ──────────────────────────

	private async dispatchCommand(
		cmd: BuilderCommand,
		session: SessionContext,
	): Promise<CommandResult> {
		switch (cmd.type) {
			case "cd": return this.handleCd(cmd, session);
			case "ls": return this.handleLs();
			case "pwd": return this.handlePwd();
			case "reset": return this.handleReset(session);
			case "get": return this.handleGet(cmd, session.connection ?? null);
			case "show": return this.handleShow(cmd, session);
			case "list": return this.handleList(cmd);
			default:
				break;
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

		// Disallow removing the root container.
		if (cmd.type === "remove" && this.treeRoot) {
			const rootId = this.treeRoot.id ?? this.treeRoot.label;
			for (const t of cmd.targets) {
				const segs = pathRefSegments(t);
				if (segs.length === 1 && segs[0].id.toLowerCase() === rootId.toLowerCase()) {
					return errorResult("Cannot remove the root container.");
				}
			}
		}

		if (!session.connection) {
			return this.localFallback(cmd);
		}

		const opsResult = commandToOps(cmd, this.treeRoot, this.moduleList, this.currentPath);
		if ("error" in opsResult) {
			return errorResult(opsResult.error);
		}

		const result = await this.executeOps(opsResult.ops, session.connection);

		if (result.type !== "error") {
			session.markProjectTreeDirty?.();
		}

		if (cmd.type === "set" && result.type !== "error") {
			const echo = await this.echoSetParam(cmd, session.connection);
			if (echo) return echo;
		}

		return result;
	}

	/** Execute mixed apply / init_network ops. Apply ops batch into one
	 *  POST /api/builder/apply; init ops dispatch one POST /api/dsp/init each. */
	private async executeOps(
		ops: BuilderOp[],
		connection: import("../hise.js").HiseConnection,
	): Promise<CommandResult> {
		const initOps = ops.filter((o) => o.op === "init_network");
		const applyOps = ops.filter((o) => o.op !== "init_network");

		for (const op of initOps) {
			const moduleId = op.moduleId as string;
			const body = { name: op.name as string, mode: op.mode as "create" | "load" };
			const response = await connection.post(
				`/api/dsp/init?moduleId=${encodeURIComponent(moduleId)}`,
				body,
			);
			if (isErrorResponse(response)) return errorResult(response.message);
			if (!isEnvelopeResponse(response) || !response.success) {
				const msg = isEnvelopeResponse(response) && response.errors.length > 0
					? response.errors.map((e) => e.errorMessage).join("\n")
					: `network ${body.mode} failed`;
				return errorResult(msg);
			}
		}

		if (applyOps.length === 0) {
			await this.fetchTree(connection);
			return textResult(initOps.length > 0 ? "OK" : "");
		}

		const response = await connection.post("/api/builder/apply", { operations: applyOps });

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

		const applyResult = normalizeBuilderApplyResult(response);

		await this.fetchTree(connection);

		if (applyResult?.diff && this.treeRoot) {
			applyDiffToTree(this.treeRoot, applyResult.diff);
		}

		const summary = response.logs.length > 0
			? response.logs.join("; ")
			: (applyResult?.diff ?? []).map((d) => `${d.action} ${d.target}`).join(", ") || "OK";

		return textResult(summary);
	}

	private async echoSetParam(
		cmd: SetCommand,
		connection: import("../hise.js").HiseConnection,
	): Promise<CommandResult | null> {
		if (cmd.clauses.length !== 1) return null;
		const clause = cmd.clauses[0];
		const segs = pathRefSegments(clause.path);
		if (segs.length < 2) return null;
		const fieldName = segs[segs.length - 1].id;
		// Skip echoing for ops that don't map to module parameters.
		const tail = fieldName.toLowerCase();
		if (["bypassed", "samplemap", "network", "effect", "routing", "send", "parent", "index"].includes(tail)) {
			return null;
		}
		const targetSegs = segs.slice(0, -1);
		const targetName = targetSegs[targetSegs.length - 1].id;

		const response = await connection.get(
			`/api/builder/tree?moduleId=${encodeURIComponent(targetName)}`,
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
		const param = params.find((p) => p.id === fieldName);
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

	private localFallback(cmd: BuilderCommand): CommandResult {
		switch (cmd.type) {
			case "add": {
				const parts = [`add ${cmd.moduleType} as "${cmd.alias}"`];
				if (cmd.parent) parts.push(`to ${pathRefToString(cmd.parent)}`);
				return textResult(`${parts.join(" ")} (no HISE connection)`);
			}
			case "addChain": {
				const parts = cmd.clauses.map((c) => `${c.moduleType} as "${c.alias}"`);
				return textResult(`add ${parts.join(", ")} (no HISE connection)`);
			}
			case "set": {
				const parts = cmd.clauses.map((c) => {
					const v = c.value;
					const valueStr = v.kind === "string" ? `"${v.s}"`
						: v.kind === "number" || v.kind === "hex" ? String(v.n)
						: v.kind === "boolean" ? String(v.b)
						: v.kind === "array2" || v.kind === "array4" || v.kind === "arrayN" ? `[${(v.n as readonly number[]).join(", ")}]`
						: pathRefToString(v.ref);
					return `${pathRefToString(c.path)} ${valueStr}`;
				});
				return textResult(`set ${parts.join(", ")} (no HISE connection)`);
			}
			case "clone":
				return textResult(`clone ${pathRefToString(cmd.target)} ${cmd.count} (no HISE connection)`);
			case "remove":
				return textResult(`remove ${cmd.targets.map(pathRefToString).join(", ")} (no HISE connection)`);
			case "rename":
				return textResult(`rename ${pathRefToString(cmd.target)} as "${cmd.name}" (no HISE connection)`);
			case "get":
				return textResult(`get ${cmd.paths.map(pathRefToString).join(", ")} (no HISE connection)`);
			default:
				return textResult("(no HISE connection)");
		}
	}

	private async handleList(cmd: ListCommand): Promise<CommandResult> {
		if (cmd.noun === "types") {
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
						? `(no module types match "${cmd.filter}" — try \`list types\` without a filter)`
						: "(no module types available)",
				);
			}
			return tableResult(
				["Module", "Type", "Subtype", "Category"],
				modules.map((m) => [m.id, m.type, m.subtype, m.category.join(", ")]),
			);
		}

		// list tree
		if (!this.treeRoot) {
			return textResult("No module tree available (requires HISE connection).");
		}
		const tree = this.getTree();
		if (!tree) return textResult("No module tree available (requires HISE connection).");
		const pwdNode = this.currentPath.length > 0 ? resolveNodeByPath(tree, this.currentPath) : null;
		return preformattedResult(renderTreeBox(tree, { pwdNode, compact: this.compactView }), undefined, true);
	}

	private async handleShow(
		cmd: ShowCommand,
		session: SessionContext,
	): Promise<CommandResult> {
		const connection = session.connection ?? null;
		const r = this.resolveRefForRead(cmd.target);
		if ("error" in r) return errorResult(r.error);

		// Live fetch when connected.
		if (connection) {
			const response = await connection.get(
				`/api/builder/tree?moduleId=${encodeURIComponent(r.id)}`,
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

				if (session.forLlm) {
					return jsonResult(raw);
				}

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

				const label = (raw.processorId as string) ?? r.id;
				const type = (raw.prettyName as string) ?? (raw.id as string) ?? "unknown";
				return textResult(`${label} (${type}) — no parameters`);
			}
		}

		// Offline fallback — render the cached tree row.
		if (this.treeRoot) {
			const node = findNodeById(this.treeRoot, r.id);
			if (node) {
				const info = [`${node.label} (${node.type ?? "unknown"})`];
				if (node.children) info.push(`  ${node.children.length} children`);
				return textResult(info.join("\n"));
			}
		}
		return errorResult(`Module "${r.id}" not found`);
	}

	private async handleGet(
		cmd: GetCommand,
		connection: import("../hise.js").HiseConnection | null,
	): Promise<CommandResult> {
		if (cmd.paths.length === 0) return errorResult("get: no paths");
		const ref = cmd.paths[0];
		const segs = pathRefSegments(ref);
		if (segs.length < 2) return errorResult("get: path must have at least 2 segments");
		const fieldName = segs[segs.length - 1].id;
		const targetName = segs[segs.length - 2].id;

		if (!connection) {
			return textResult(`get ${pathRefToString(ref)} (no HISE connection)`);
		}

		const response = await connection.get(
			`/api/builder/tree?moduleId=${encodeURIComponent(targetName)}`,
		);

		if (!isEnvelopeResponse(response) || !response.success) {
			return errorResult(`Module "${targetName}" not found`);
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
			return errorResult(`Module "${targetName}" has no parameters`);
		}

		const param = params.find((p) => p.id === fieldName);
		if (!param) {
			return errorResult(`Parameter "${fieldName}" not found on "${targetName}"`);
		}

		return textResult(param.valueAsString ?? String(param.value));
	}

	private resolveRefForRead(ref: PathRef): { id: string } | { error: string } {
		if (!this.treeRoot) {
			const segs = pathRefSegments(ref);
			if (segs.length === 0) return { error: "cannot resolve `..`" };
			return { id: segs[segs.length - 1].id };
		}
		const r = resolvePath(this.treeRoot, this.currentPath, ref, "lookup");
		if (!r.ok) return { error: r.message };
		return { id: r.node.id ?? r.fullPath[r.fullPath.length - 1] };
	}
}

// Re-exported for completion engines and tests.
export { cleanBuilderTreeForLlm };

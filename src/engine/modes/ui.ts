// ── UI mode — main class + barrel re-exports ─────────────────────────

import type { CommandResult, TreeNode } from "../result.js";
import { errorResult, jsonResult, preformattedResult, tableResult, textResult } from "../result.js";
import type { TokenSpan } from "../highlight/tokens.js";
import { tokenizeUi } from "../highlight/ui.js";
import type { CompletionItem, CompletionResult, Mode, ModeId, SessionContext } from "./mode.js";
import { MODE_ACCENTS } from "./mode.js";
import { isErrorResponse, isEnvelopeResponse } from "../hise.js";
import { stripQuotes } from "../string-utils.js";
import { findNodeById, resolveNodeByPath } from "../tree-utils.js";
import { renderTreeBox } from "./builder-ops.js";
import {
	normalizeUiTreeResponse,
	applyUiDiffToTree,
	collectComponentIds,
	cleanUiTreeForLlm,
} from "../../mock/contracts/ui.js";
import type { CompletionEngine } from "../completion/engine.js";
import { fuzzyFilter } from "../completion/engine.js";
import { uiLexer } from "./tokens.js";
import { resolvePath } from "../grammar/path-resolver.js";
import {
	pathRefSegments,
	pathRefToString,
	type PathRef,
} from "../grammar/path-parser.js";

// ── Re-exports ──────────────────────────────────────────────────

export {
	VALID_COMPONENT_TYPES,
	COMMON_COMPONENT_PROPERTIES,
} from "./ui-parser.js";
export type {
	ComponentPropertyDef,
	ComponentPropertyMap,
	UiAddCommand,
	UiAddChainCommand,
	UiRemoveCommand,
	UiSetCommand,
	UiSetClause,
	UiRenameCommand,
	UiGetCommand,
	UiShowCommand,
	UiListCommand,
	UiCdCommand,
	UiLsCommand,
	UiPwdCommand,
	UiResetCommand,
	UiCommand,
} from "./ui-parser.js";
export {
	parseSingleUiCommand,
	parseUiInput,
	validateComponentType,
} from "./ui-parser.js";
export type { UiOp } from "./ui-ops.js";
export { commandToOps } from "./ui-ops.js";

import type {
	ComponentPropertyMap,
	UiCdCommand,
	UiCommand,
	UiGetCommand,
	UiListCommand,
	UiSetCommand,
	UiShowCommand,
} from "./ui-parser.js";
import {
	VALID_COMPONENT_TYPES,
	COMMON_COMPONENT_PROPERTIES,
	parseUiInput,
	findLastUnquotedComma,
	validateComponentType,
} from "./ui-parser.js";
import type { UiOp } from "./ui-ops.js";
import { commandToOps } from "./ui-ops.js";

// ── Helpers ──────────────────────────────────────────────────────

function componentIdCompletionItems(tree: TreeNode | null): CompletionItem[] {
	if (!tree) return [];
	const ids = collectComponentIds(tree);
	return ids.map((id) => ({
		label: id,
		insertText: id.includes(" ") ? `"${id}"` : id,
	}));
}

// ── UI mode class ────────────────────────────────────────────────

export class UiMode implements Mode {
	readonly id: ModeId = "ui";
	readonly name = "UI";
	readonly accent = MODE_ACCENTS.ui;
	readonly prompt = "[ui] > ";

	private moduleId = "Interface";
	private currentPath: string[] = [];
	private treeRoot: TreeNode | null = null;
	private lastTreeResult: unknown = null;
	private treeFetched = false;
	private readonly completionEngine: CompletionEngine | null;
	private readonly componentProperties: ComponentPropertyMap | null;

	constructor(
		completionEngine?: CompletionEngine,
		initialPath?: string,
		componentProperties?: ComponentPropertyMap,
	) {
		this.completionEngine = completionEngine ?? null;
		this.componentProperties = componentProperties ?? null;
		if (initialPath) {
			this.currentPath = initialPath.split(".").filter((s) => s !== "");
		}
	}

	tokenizeInput(value: string): TokenSpan[] { return tokenizeUi(value); }

	getTree(): TreeNode | null {
		if (!this.treeRoot) return null;
		return structuredClone(this.treeRoot);
	}
	getSelectedPath(): string[] { return [...this.currentPath]; }
	selectNode(path: string[]): void { this.currentPath = [...path]; }
	get contextLabel(): string { return this.currentPath.join("."); }
	setContext(path: string): void {
		this.currentPath = path.split(".").filter((s) => s !== "");
	}
	invalidateTree(): void { this.treeFetched = false; }
	async onEnter(session: SessionContext): Promise<void> { await this.ensureTree(session); }

	// ── Completion ──────────────────────────────────────────────

	complete(input: string, _cursor: number): CompletionResult {
		const lastComma = findLastUnquotedComma(input);
		if (lastComma !== -1) {
			return this.completeSegment(input.slice(lastComma + 1), lastComma + 1, input.length);
		}
		return this.completeSegment(input, 0, input.length);
	}

	private completeSegment(segment: string, offset: number, inputLength: number): CompletionResult {
		const trimmed = segment.trimStart();
		const leadingSpaces = segment.length - trimmed.length;
		const trailingSpace = segment.endsWith(" ");

		const lexResult = uiLexer.tokenize(trimmed);
		const tokens = lexResult.tokens;

		const empty: CompletionResult = { items: [], from: offset, to: inputLength };

		if (tokens.length === 0 || (tokens.length === 1 && !trailingSpace)) {
			const prefix = tokens.length > 0 ? tokens[0].image.toLowerCase() : "";
			const keywords = ["add", "remove", "set", "get", "rename", "show", "list", "cd", "ls", "pwd", "reset"];
			const items: CompletionItem[] = keywords
				.filter((k) => k.startsWith(prefix))
				.map((k) => ({ label: k }));
			return {
				items,
				from: offset + leadingSpaces,
				to: inputLength,
				label: "UI keywords",
			};
		}

		const verb = tokens[0].image.toLowerCase();
		if (verb === "cd") return this.completeCd(tokens, trailingSpace, offset, inputLength, segment);

		const componentItems = componentIdCompletionItems(this.treeRoot);

		if (verb === "add") return this.completeAdd(tokens, trailingSpace, offset, inputLength, segment);

		if (verb === "set" || verb === "get") {
			return this.completeSet(tokens, trailingSpace, offset, inputLength, segment, componentItems);
		}

		if (verb === "show") {
			if (tokens.length === 1 && trailingSpace) {
				return { items: componentItems, from: offset + segment.length, to: inputLength, label: "Components" };
			}
			if (tokens.length === 2 && !trailingSpace) {
				const prefix = tokens[1].image;
				const items = fuzzyFilter(prefix, componentItems);
				const from = offset + tokens[1].startOffset;
				return { items, from, to: inputLength, label: "Components" };
			}
			return empty;
		}

		if (verb === "list") {
			const nouns: CompletionItem[] = [{ label: "tree", detail: "component tree" }];
			if (tokens.length === 1 && trailingSpace) {
				return { items: nouns, from: offset + segment.length, to: inputLength, label: "List nouns" };
			}
			if (tokens.length === 2 && !trailingSpace) {
				const prefix = tokens[1].image.toLowerCase();
				const items = nouns.filter((i) => i.label.startsWith(prefix));
				const from = offset + tokens[1].startOffset;
				return { items, from, to: inputLength, label: "List nouns" };
			}
			return empty;
		}

		const TARGET_COMMANDS = ["remove", "rename"];
		if (TARGET_COMMANDS.includes(verb)) {
			return this.completeTarget(tokens, trailingSpace, offset, inputLength, segment, componentItems, "Components");
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
			detail: c.type ?? "",
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

	private completeAdd(
		tokens: import("chevrotain").IToken[],
		trailingSpace: boolean,
		offset: number,
		inputLength: number,
		segment: string,
	): CompletionResult {
		const typeItems: CompletionItem[] = VALID_COMPONENT_TYPES.map((t) => ({
			label: t,
			detail: "component",
		}));
		if (tokens.length === 1 && trailingSpace) {
			return { items: typeItems, from: offset + segment.length, to: inputLength, label: "Component types" };
		}
		if (tokens.length === 2 && !trailingSpace) {
			const prefix = tokens[1].image;
			const items = fuzzyFilter(prefix, typeItems);
			const from = offset + tokens[1].startOffset;
			return { items, from, to: inputLength, label: "Component types" };
		}
		return { items: [], from: offset, to: inputLength };
	}

	private completeSet(
		tokens: import("chevrotain").IToken[],
		trailingSpace: boolean,
		offset: number,
		inputLength: number,
		segment: string,
		componentItems: CompletionItem[],
	): CompletionResult {
		if (tokens.length === 1 && trailingSpace) {
			return { items: componentItems, from: offset + segment.length, to: inputLength, label: "Components" };
		}

		const dotIndex = tokens.findIndex((t) => t.image === ".");
		if (dotIndex === -1) {
			if (!trailingSpace) {
				const lastToken = tokens[tokens.length - 1];
				const prefix = lastToken.image;
				const items = fuzzyFilter(prefix, componentItems);
				const from = offset + lastToken.startOffset;
				return { items, from, to: inputLength, label: "Components" };
			}
			return { items: componentItems, from: offset + segment.length, to: inputLength, label: "Components" };
		}

		const targetTokens = tokens.slice(1, dotIndex);
		let targetName: string;
		if (targetTokens.length === 1 && targetTokens[0].tokenType.name === "QuotedString") {
			targetName = stripQuotes(targetTokens[0].image);
		} else {
			targetName = targetTokens.map((t) => t.image).join(" ");
		}

		const propItems = this.getPropertyCompletionItems(targetName);

		const propIndex = dotIndex + 1;
		if (propIndex >= tokens.length) {
			return { items: propItems, from: offset + segment.length, to: inputLength, label: `${targetName} properties` };
		}
		if (!trailingSpace) {
			const prefix = tokens[propIndex].image;
			const items = fuzzyFilter(prefix, propItems);
			const from = offset + tokens[propIndex].startOffset;
			return { items, from, to: inputLength, label: `${targetName} properties` };
		}

		return { items: [], from: offset, to: inputLength };
	}

	private getPropertyCompletionItems(componentId: string): CompletionItem[] {
		const items: CompletionItem[] = [];
		items.push({ label: "type", detail: "read-only" });
		for (const p of COMMON_COMPONENT_PROPERTIES) {
			items.push({ label: p, detail: "common" });
		}
		if (this.componentProperties) {
			const node = findNodeById(this.treeRoot, componentId);
			const componentType = node?.type;
			if (componentType) {
				const props = this.componentProperties[componentType];
				if (props) {
					for (const [name, def] of Object.entries(props)) {
						items.push({ label: name, detail: def.type });
					}
				}
			}
		}
		return items;
	}

	private completeTarget(
		tokens: import("chevrotain").IToken[],
		trailingSpace: boolean,
		offset: number,
		inputLength: number,
		segment: string,
		componentItems: CompletionItem[],
		label: string,
	): CompletionResult {
		if (tokens.length === 1 && trailingSpace) {
			return { items: componentItems, from: offset + segment.length, to: inputLength, label };
		}
		if (!trailingSpace) {
			const lastToken = tokens[tokens.length - 1];
			const prefix = lastToken.image;
			const items = fuzzyFilter(prefix, componentItems);
			const from = offset + lastToken.startOffset;
			return { items, from, to: inputLength, label };
		}
		return { items: [], from: offset, to: inputLength };
	}

	// ── Tree fetching ───────────────────────────────────────────

	async fetchTree(connection: import("../hise.js").HiseConnection): Promise<void> {
		let inPlan = false;
		const diffResp = await connection.get("/api/undo/diff?scope=group");
		if (isEnvelopeResponse(diffResp) && diffResp.success) {
			const groupName = diffResp.groupName as string | undefined;
			inPlan = typeof groupName === "string" && groupName !== "root";
		}
		const base = `/api/ui/tree?moduleId=${encodeURIComponent(this.moduleId)}`;
		const endpoint = inPlan ? `${base}&group=current` : base;
		const response = await connection.get(endpoint);
		if (isErrorResponse(response)) return;
		if (!isEnvelopeResponse(response) || !response.success) return;
		this.lastTreeResult = response.result ?? null;
		try {
			this.treeRoot = normalizeUiTreeResponse(response.result);
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

	// ── Parse entry point ───────────────────────────────────────

	async parse(input: string, session: SessionContext): Promise<CommandResult> {
		await this.ensureTree(session);

		const result = parseUiInput(input);
		if ("error" in result) return errorResult(result.error);

		let lastResult: CommandResult = textResult("(no commands)");
		for (const cmd of result.commands) {
			lastResult = await this.dispatchCommand(cmd, session);
			if (lastResult.type === "error") return lastResult;
		}
		return lastResult;
	}

	// ── Navigation handlers ─────────────────────────────────────

	private handleCd(cmd: UiCdCommand, session: SessionContext): CommandResult {
		if (cmd.target.kind === "parent") {
			if (this.currentPath.length === 0) return session.popMode();
			this.currentPath.pop();
			return textResult(this.currentPath.length > 0 ? this.currentPath.join(".") : "/");
		}

		if (!this.treeRoot) {
			const segs = pathRefSegments(cmd.target);
			for (const seg of segs) this.currentPath.push(seg.id);
			return textResult(this.currentPath.length > 0 ? this.currentPath.join(".") : "/");
		}

		const r = resolvePath(this.treeRoot, this.currentPath, cmd.target, "cd");
		if (!r.ok) return errorResult(r.message);
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
			return textResult(`${path}: listing children requires a HISE connection`);
		}

		const node = resolveNodeByPath(this.treeRoot, this.currentPath) ?? this.treeRoot;
		if (!node) return errorResult(`Path not found: ${this.currentPath.join(".")}`);
		if (!node.children || node.children.length === 0) return textResult(`${node.label}: (no children)`);

		return tableResult(
			["Name", "Type"],
			node.children.map((c) => [c.label, c.type ?? ""]),
		);
	}

	private handlePwd(): CommandResult {
		return textResult(this.currentPath.length > 0 ? this.currentPath.join(".") : "/");
	}

	private handleReset(): CommandResult {
		// UI mode has no `/api/ui/reset` endpoint; treat reset as cwd reset.
		this.currentPath = [];
		return textResult("/");
	}

	private async handleList(cmd: UiListCommand): Promise<CommandResult> {
		if (cmd.noun !== "tree") return errorResult(`unknown list noun: ${cmd.noun}`);
		if (!this.treeRoot) return textResult("No component tree available (requires HISE connection).");
		const pwdNode = this.currentPath.length > 0 ? resolveNodeByPath(this.treeRoot, this.currentPath) : null;
		return preformattedResult(renderTreeBox(this.treeRoot, { pwdNode }), undefined, true);
	}

	// ── Command dispatch and execution ──────────────────────────

	private async dispatchCommand(
		cmd: UiCommand,
		session: SessionContext,
	): Promise<CommandResult> {
		switch (cmd.type) {
			case "cd": return this.handleCd(cmd, session);
			case "ls": return this.handleLs();
			case "pwd": return this.handlePwd();
			case "reset": return this.handleReset();
			case "get": return this.handleGet(cmd, session.connection ?? null);
			case "show": return this.handleShow(cmd, session);
			case "list": return this.handleList(cmd);
			default: break;
		}

		// Local validation for add commands (single + chained)
		if (cmd.type === "add") {
			const typeError = validateComponentType(cmd.componentType);
			if (typeError) return errorResult(typeError);
		}
		if (cmd.type === "addChain") {
			for (const cl of cmd.clauses) {
				const typeError = validateComponentType(cl.componentType);
				if (typeError) return errorResult(typeError);
			}
		}

		if (!session.connection) return this.localFallback(cmd);

		const opsResult = commandToOps(cmd, this.treeRoot, this.currentPath);
		if ("error" in opsResult) return errorResult(opsResult.error);

		const result = await this.executeOps(opsResult.ops, session.connection);

		if (result.type !== "error") session.markProjectTreeDirty?.();

		if (cmd.type === "set" && result.type !== "error" && cmd.clauses.length === 1) {
			const echo = await this.echoSetClause(cmd.clauses[0]!, session.connection);
			if (echo) return echo;
		}

		return result;
	}

	/** Execute mixed apply / set_value ops. */
	private async executeOps(
		ops: UiOp[],
		connection: import("../hise.js").HiseConnection,
	): Promise<CommandResult> {
		const valueOps = ops.filter((o) => o.op === "set_value");
		const applyOps = ops.filter((o) => o.op !== "set_value");

		for (const op of valueOps) {
			const response = await connection.post("/api/set_component_value", {
				moduleId: this.moduleId,
				id: op.target,
				value: op.value,
			});
			if (isErrorResponse(response)) return errorResult(response.message);
			if (isEnvelopeResponse(response) && !response.success) {
				const msg = response.errors.length > 0
					? response.errors.map((e) => e.errorMessage).join("\n")
					: `Failed to set value on "${op.target as string}"`;
				return errorResult(msg);
			}
		}

		if (applyOps.length === 0) {
			await this.fetchTree(connection);
			return textResult(valueOps.length > 0 ? "OK" : "");
		}

		const response = await connection.post("/api/ui/apply", {
			moduleId: this.moduleId,
			operations: applyOps,
		});

		if (isErrorResponse(response)) return errorResult(response.message);
		if (!isEnvelopeResponse(response)) return errorResult("Unexpected response from HISE");
		if (!response.success) {
			const msg = response.errors.length > 0
				? response.errors.map((e) => e.errorMessage).join("\n")
				: "UI operation failed";
			return errorResult(msg);
		}

		await this.fetchTree(connection);

		if (this.treeRoot) {
			const localDiff = applyOps.map(op => {
				const action = op.op === "add" ? "+" as const
					: op.op === "remove" ? "-" as const
					: "*" as const;
				const target = (op as Record<string, unknown>).target as string
					?? (op as Record<string, unknown>).id as string
					?? "";
				return { domain: "ui", action, target };
			}).filter(d => d.target);
			applyUiDiffToTree(this.treeRoot, localDiff);
		}

		const summary = response.logs.length > 0
			? response.logs.join("; ")
			: applyOps.map((o) => `${o.op} ${(o as Record<string, unknown>).target ?? (o as Record<string, unknown>).id ?? ""}`).join(", ") || "OK";

		return textResult(summary);
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

	private async handleShow(cmd: UiShowCommand, session: SessionContext): Promise<CommandResult> {
		const connection = session.connection ?? null;
		const r = this.resolveRefForRead(cmd.target);
		if ("error" in r) return errorResult(r.error);

		if (!connection) return textResult(`show ${r.id} (no HISE connection)`);

		const response = await connection.get(
			`/api/get_component_properties?moduleId=${encodeURIComponent(this.moduleId)}&id=${encodeURIComponent(r.id)}`,
		);
		if (isErrorResponse(response)) return errorResult(response.message);

		const data = response as unknown as Record<string, unknown>;
		if (!data.success) {
			const errors = (data as { errors?: Array<{ errorMessage: string }> }).errors;
			const msg = errors?.[0]?.errorMessage ?? `Could not fetch properties for "${r.id}"`;
			return errorResult(msg);
		}

		if (session.forLlm) {
			return jsonResult(cleanUiTreeForLlm(data));
		}

		const properties = data.properties as Array<{ id: string; value: unknown; isDefault: boolean }> | undefined;
		if (!properties || !Array.isArray(properties)) return textResult(`${r.id}: no properties`);

		const rows = properties.map((p) => [p.id, String(p.value), p.isDefault ? "" : "*"]);
		return tableResult(["Property", "Value", ""], rows);
	}

	private async handleGet(
		cmd: UiGetCommand,
		connection: import("../hise.js").HiseConnection | null,
	): Promise<CommandResult> {
		if (cmd.paths.length === 0) return errorResult("get: no paths");
		const ref = cmd.paths[0];
		const segs = pathRefSegments(ref);
		if (segs.length < 2) return errorResult("get: path must have at least 2 segments");
		const fieldName = segs[segs.length - 1].id;
		const targetName = segs[segs.length - 2].id;

		if (!connection) return textResult(`get ${pathRefToString(ref)} (no HISE connection)`);

		// Field "value" → /api/get_component_value
		if (fieldName.toLowerCase() === "value") {
			const response = await connection.get(
				`/api/get_component_value?moduleId=${encodeURIComponent(this.moduleId)}&id=${encodeURIComponent(targetName)}`,
			);
			if (isErrorResponse(response)) return errorResult(response.message);
			const data = response as unknown as Record<string, unknown>;
			if (data.success === false) {
				const errors = (data as { errors?: Array<{ errorMessage: string }> }).errors;
				const msg = errors?.[0]?.errorMessage ?? `Could not get value for "${targetName}"`;
				return errorResult(msg);
			}
			return textResult(String(data.value ?? ""));
		}

		const response = await connection.get(
			`/api/get_component_properties?moduleId=${encodeURIComponent(this.moduleId)}&id=${encodeURIComponent(targetName)}`,
		);
		if (isErrorResponse(response)) return errorResult(response.message);
		const data = response as unknown as Record<string, unknown>;
		if (!data.success) {
			const errors = (data as { errors?: Array<{ errorMessage: string }> }).errors;
			const msg = errors?.[0]?.errorMessage ?? `Could not fetch properties for "${targetName}"`;
			return errorResult(msg);
		}

		// Special case: .type lives at top-level of the response.
		if (fieldName === "type") {
			if (typeof data.type !== "string") return errorResult(`Component "${targetName}" has no type`);
			return textResult(data.type);
		}

		const properties = data.properties as Array<{ id: string; value: unknown }> | undefined;
		if (!properties) return errorResult(`${targetName}: no properties`);
		const prop = properties.find((p) => p.id === fieldName);
		if (!prop) return errorResult(`Property "${fieldName}" not found on "${targetName}"`);
		return textResult(String(prop.value));
	}

	private async echoSetClause(
		clause: { path: PathRef; value: unknown },
		connection: import("../hise.js").HiseConnection,
	): Promise<CommandResult | null> {
		const segs = pathRefSegments(clause.path);
		if (segs.length < 2) return null;
		const fieldName = segs[segs.length - 1].id;
		const fieldLower = fieldName.toLowerCase();
		// Skip echo for non-property writes.
		if (fieldLower === "parent" || fieldLower === "index" || fieldLower === "value") return null;
		const targetName = segs[segs.length - 2].id;

		const response = await connection.get(
			`/api/get_component_properties?moduleId=${encodeURIComponent(this.moduleId)}&id=${encodeURIComponent(targetName)}`,
		);
		if (isErrorResponse(response)) return null;
		const data = response as unknown as Record<string, unknown>;
		if (!data.success) return null;
		const properties = data.properties as Array<{ id: string; value: unknown }> | undefined;
		if (!properties) return null;
		const prop = properties.find((p) => p.id === fieldName);
		if (!prop) return null;
		return textResult(`${targetName}.${fieldName}: ${prop.value}`);
	}

	private localFallback(cmd: UiCommand): CommandResult {
		switch (cmd.type) {
			case "add": {
				const parts = [`add ${cmd.componentType} as "${cmd.alias}"`];
				if (cmd.parent) parts.push(`to ${pathRefToString(cmd.parent)}`);
				return textResult(`${parts.join(" ")} (no HISE connection)`);
			}
			case "addChain": {
				const parts = cmd.clauses.map((c) => `${c.componentType} as "${c.alias}"`);
				return textResult(`add ${parts.join(", ")} (no HISE connection)`);
			}
			case "remove":
				return textResult(`remove ${cmd.targets.map(pathRefToString).join(", ")} (no HISE connection)`);
			case "set":
				return textResult(`set ${cmd.clauses.map((c) => pathRefToString(c.path)).join(", ")} (no HISE connection)`);
			case "rename":
				return textResult(`rename ${pathRefToString(cmd.target)} as "${cmd.name}" (no HISE connection)`);
			case "get":
				return textResult(`get ${cmd.paths.map(pathRefToString).join(", ")} (no HISE connection)`);
			default:
				return textResult("(no HISE connection)");
		}
	}
}

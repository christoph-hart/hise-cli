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
	cleanUiPropertiesForLlm,
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
	UiConnectCommand,
	UiGetCommand,
	UiShowCommand,
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
	UiConnectCommand,
	UiGetCommand,
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

type UiConnectComponentType = "ScriptSlider" | "ScriptComboBox" | "ScriptButton";
type BuilderParameterType = "Slider" | "ComboBox" | "Button";

interface BuilderParameterInfo {
	id: string;
	type?: string;
	range?: {
		min?: number;
		max?: number;
		stepSize?: number;
		middlePosition?: number;
	};
	defaultValue?: unknown;
	mode?: string;
	unit?: string;
	items?: string[];
}

interface BuilderProcessorInfo {
	id: string;
	path: string[];
	parameters: BuilderParameterInfo[];
}

const UI_TO_PARAMETER_TYPE: Record<UiConnectComponentType, BuilderParameterType> = {
	ScriptSlider: "Slider",
	ScriptComboBox: "ComboBox",
	ScriptButton: "Button",
};

function isConnectComponentType(value: string | undefined): value is UiConnectComponentType {
	return value === "ScriptSlider" || value === "ScriptComboBox" || value === "ScriptButton";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usableDefaultValue(value: unknown): unknown {
	return value === "dynamic" ? undefined : value;
}

function parseConnectTarget(ref: PathRef): { processorId: string; parameterId: string } | { error: string } {
	const segs = pathRefSegments(ref);
	if (segs.length < 2) return { error: "connect: target must be <processor>.<parameter>" };
	return {
		processorId: segs.slice(0, -1).map((seg) => seg.id).join("."),
		parameterId: segs[segs.length - 1]!.id,
	};
}

function collectBuilderProcessors(raw: unknown): BuilderProcessorInfo[] {
	const out: BuilderProcessorInfo[] = [];
	const visit = (value: unknown, path: string[]): void => {
		if (!isRecord(value)) return;
		const processorId = typeof value.processorId === "string"
			? value.processorId
			: typeof value.id === "string" ? value.id : null;
		const nextPath = processorId ? [...path, processorId] : path;
		if (processorId) {
			out.push({ id: processorId, path: nextPath, parameters: parseBuilderParameters(value.parameters) });
		}
		for (const key of ["children", "midi", "fx"] as const) {
			const children = value[key];
			if (Array.isArray(children)) for (const child of children) visit(child, nextPath);
		}
		const modulation = value.modulation;
		if (Array.isArray(modulation)) {
			for (const chain of modulation) {
				if (!isRecord(chain)) continue;
				const chainPath = typeof chain.id === "string" ? [...nextPath, chain.id] : nextPath;
				const children = chain.children;
				if (Array.isArray(children)) for (const child of children) visit(child, chainPath);
			}
		}
	};
	visit(raw, []);
	return out;
}

function parseBuilderParameters(value: unknown): BuilderParameterInfo[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry): BuilderParameterInfo[] => {
		if (!isRecord(entry) || typeof entry.id !== "string") return [];
		const range = isRecord(entry.range)
			? {
				min: finiteNumber(entry.range.min),
				max: finiteNumber(entry.range.max),
				stepSize: finiteNumber(entry.range.stepSize),
				middlePosition: finiteNumber(entry.range.middlePosition),
			}
			: undefined;
		return [{
			id: entry.id,
			type: typeof entry.type === "string" ? entry.type : undefined,
			range,
			defaultValue: entry.defaultValue,
			mode: typeof entry.mode === "string" ? entry.mode : undefined,
			unit: typeof entry.unit === "string" ? entry.unit : undefined,
			items: Array.isArray(entry.items) ? entry.items.filter((item): item is string => typeof item === "string") : undefined,
		}];
	});
}

function matchedPropertiesForComponent(
	componentType: UiConnectComponentType,
	parameter: BuilderParameterInfo,
): { properties: Record<string, unknown>; warnings: string[] } {
	const properties: Record<string, unknown> = {};
	const warnings: string[] = [];
	const defaultValue = usableDefaultValue(parameter.defaultValue);
	if (componentType === "ScriptSlider") {
		if (!parameter.range) {
			warnings.push("parameter range metadata unavailable");
		} else {
			if (parameter.range.min !== undefined) properties.min = parameter.range.min;
			if (parameter.range.max !== undefined) properties.max = parameter.range.max;
			if (parameter.range.stepSize !== undefined) {
				const stepSize = formatSliderStepSize(parameter.range.stepSize);
				if (stepSize) properties.stepSize = stepSize;
				else warnings.push(`unsupported slider stepSize: ${parameter.range.stepSize}`);
			}
			if (parameter.range.middlePosition !== undefined) properties.middlePosition = parameter.range.middlePosition;
		}
		if (defaultValue !== undefined) properties.defaultValue = defaultValue;
		if (parameter.mode) properties.mode = parameter.mode;
		if (parameter.unit) properties.suffix = parameter.unit;
		return { properties, warnings };
	}
	if (componentType === "ScriptComboBox") {
		if (parameter.items && parameter.items.length > 0) properties.items = parameter.items.join("\n");
		else warnings.push("parameter item metadata unavailable");
		if (defaultValue !== undefined) properties.defaultValue = defaultValue;
		return { properties, warnings };
	}
	properties.text = parameter.id;
	if (defaultValue !== undefined) properties.defaultValue = defaultValue;
	return { properties, warnings };
}

function formatSliderStepSize(value: number): string | undefined {
	if (value === 0) return "0.0";
	if (value === 1) return "1.0";
	const text = String(value);
	return /^0\.0*1$/.test(text) ? text : undefined;
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
			const keywords = ["add", "remove", "set", "get", "connect", "rename", "show", "cd", "ls", "pwd", "reset"];
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
		if (verb === "connect") return this.completeTarget(tokens, trailingSpace, offset, inputLength, segment, componentItems, "Components");

		if (verb === "set" || verb === "get") {
			return this.completeSet(tokens, trailingSpace, offset, inputLength, segment, componentItems);
		}

		if (verb === "show") {
			const nouns: CompletionItem[] = [{ label: "tree", detail: "component tree" }];
			if (tokens.length === 1 && trailingSpace) {
				return { items: [...nouns, ...componentItems], from: offset + segment.length, to: inputLength, label: "Show targets" };
			}
			if (tokens.length === 2 && !trailingSpace) {
				const prefix = tokens[1].image;
				const items = [...fuzzyFilter(prefix, nouns), ...fuzzyFilter(prefix, componentItems)];
				const from = offset + tokens[1].startOffset;
				return { items, from, to: inputLength, label: "Show targets" };
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

	private handleShowTree(session: SessionContext): CommandResult {
		if (!this.treeRoot) return textResult("No component tree available (requires HISE connection).");
		if (session.forLlm) return jsonResult(cleanUiTreeForLlm(this.lastTreeResult ?? this.treeRoot));
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
		if (cmd.type === "connect") return this.handleConnect(cmd, session.connection);

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
		const logs: string[] = [];

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
			if (isEnvelopeResponse(response)) logs.push(...response.logs);
		}

		if (applyOps.length === 0) {
			await this.fetchTree(connection);
			return { type: "text", content: valueOps.length > 0 ? "OK" : "", logs };
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

		logs.push(...response.logs);
		const summary = logs.length > 0
			? logs.join("; ")
			: applyOps.map((o) => `${o.op} ${(o as Record<string, unknown>).target ?? (o as Record<string, unknown>).id ?? ""}`).join(", ") || "OK";

		return { type: "text", content: summary, logs };
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
		if (cmd.kind === "tree") return this.handleShowTree(session);
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
			return jsonResult(cleanUiPropertiesForLlm(data));
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

	private async handleConnect(
		cmd: UiConnectCommand,
		connection: import("../hise.js").HiseConnection,
	): Promise<CommandResult> {
		const component = this.resolveRefForRead(cmd.component);
		if ("error" in component) return errorResult(component.error);
		const componentNode = this.findComponentNode(component.id);
		if (!componentNode) return errorResult(`Component "${component.id}" not found`);
		if (!isConnectComponentType(componentNode.type)) {
			return errorResult(`connect requires ScriptSlider, ScriptComboBox, or ScriptButton; "${component.id}" is ${componentNode.type ?? "unknown"}`);
		}

		const target = parseConnectTarget(cmd.target);
		if ("error" in target) return errorResult(target.error);

		const metadata = await this.fetchBuilderParameterInfo(connection, target.processorId, target.parameterId);
		if ("error" in metadata) return errorResult(metadata.error);

		const expectedType = UI_TO_PARAMETER_TYPE[componentNode.type];
		if (metadata.parameter.type !== expectedType) {
			return errorResult(`Cannot connect ${componentNode.type} to ${metadata.processor.id}.${metadata.parameter.id}: parameter type is ${metadata.parameter.type ?? "unknown"}, expected ${expectedType}`);
		}

		const properties: Record<string, unknown> = {
			processorId: metadata.processor.id,
			parameterId: metadata.parameter.id,
		};
		const warnings: string[] = [];

		if (cmd.matched) {
			const matched = matchedPropertiesForComponent(componentNode.type, metadata.parameter);
			Object.assign(properties, matched.properties);
			warnings.push(...matched.warnings);
		}

		const result = await this.executeOps([{ op: "set", target: component.id, properties }], connection);
		if (result.type === "error") return result;
		if (result.type !== "text") return result;
		const suffix = cmd.matched ? " matched" : "";
		const warningText = warnings.length > 0 ? ` (${warnings.join("; ")})` : "";
		return { ...result, content: `connected ${component.id} to ${metadata.processor.id}.${metadata.parameter.id}${suffix}${warningText}` };
	}

	private findComponentNode(id: string): TreeNode | null {
		if (!this.treeRoot) return null;
		const lower = id.toLowerCase();
		const visit = (node: TreeNode): TreeNode | null => {
			if ((node.id ?? node.label).toLowerCase() === lower) return node;
			for (const child of node.children ?? []) {
				const found = visit(child);
				if (found) return found;
			}
			return null;
		};
		return visit(this.treeRoot);
	}

	private async fetchBuilderParameterInfo(
		connection: import("../hise.js").HiseConnection,
		processorId: string,
		parameterId: string,
	): Promise<{ processor: BuilderProcessorInfo; parameter: BuilderParameterInfo } | { error: string }> {
		const response = await connection.get("/api/builder/tree?verbose=true");
		if (isErrorResponse(response)) return { error: response.message };
		if (!isEnvelopeResponse(response) || !response.success || !response.result) {
			return { error: "Could not fetch verbose builder tree" };
		}
		const matches = collectBuilderProcessors(response.result)
			.filter((processor) => processor.id.toLowerCase() === processorId.toLowerCase());
		if (matches.length === 0) return { error: `Processor "${processorId}" not found` };
		if (matches.length > 1) {
			return { error: `ambiguous processor id "${processorId}": ${matches.map((m) => m.path.join(".")).join(", ")}` };
		}
		const processor = matches[0]!;
		const parameter = processor.parameters.find((param) => param.id.toLowerCase() === parameterId.toLowerCase());
		if (!parameter) return { error: `Parameter "${parameterId}" not found on "${processor.id}"` };
		return { processor, parameter };
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
			case "connect":
				return textResult(`connect ${pathRefToString(cmd.component)} to ${pathRefToString(cmd.target)}${cmd.matched ? " matched" : ""} (no HISE connection)`);
			case "get":
				return textResult(`get ${cmd.paths.map(pathRefToString).join(", ")} (no HISE connection)`);
			default:
				return textResult("(no HISE connection)");
		}
	}
}

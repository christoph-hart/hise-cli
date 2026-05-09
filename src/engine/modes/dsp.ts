// ── DSP mode — scriptnode graph editor ─────────────────────────────────

import type { CommandResult } from "../result.js";
import {
	errorResult,
	jsonResult,
	preformattedResult,
	tableResult,
	textResult,
} from "../result.js";
import { renderTreeBox } from "./builder-ops.js";
import type { ScriptnodeList } from "../data.js";
import type { TreeNode } from "../result.js";
import type { TokenSpan } from "../highlight/tokens.js";
import { tokenizeDsp } from "../highlight/dsp.js";
import type { CompletionResult, Mode, SessionContext } from "./mode.js";
import { MODE_ACCENTS } from "./mode.js";
import { isEnvelopeResponse, isErrorResponse } from "../hise.js";
import type { HiseConnection } from "../hise.js";
import type { RawDspNode } from "../../mock/contracts/dsp.js";
import {
	cleanDspTreeForLlm,
	cleanDspParameterForLlm,
	findDspConnectionTargeting,
	findDspNode,
	findDspParent,
	normalizeDspApplyResponse,
	normalizeDspList,
	normalizeDspSaveResponse,
	normalizeDspTreeResponse,
} from "../../mock/contracts/dsp.js";
import { applyDiffToTree } from "../../mock/contracts/builder.js";
import type { CompletionEngine } from "../completion/engine.js";
import type {
	CdCommand,
	DspCommand,
	GetCommand,
	ScreenshotCommand,
	ShowCommand,
} from "./dsp-parser.js";
import { parseDspInput, findLastUnquotedComma, parseSingleDspCommand } from "./dsp-parser.js";
import type { DspOp } from "./dsp-ops.js";
import {
	commandToDspOps,
	collectDspNodeIds,
	nodeParameters,
	nodeParametersAndProperties,
} from "./dsp-ops.js";
import {
	validateAddCommand,
	validateCreateParameterCommand,
	validateSetCommand,
} from "./dsp-validate.js";
import { resolvePath } from "../grammar/path-resolver.js";
import {
	pathRefSegments,
	pathRefToString,
	type PathRef,
} from "../grammar/path-parser.js";

// ── Re-exports ────────────────────────────────────────────────────

export type {
	AddCommand,
	AddChainCommand,
	RemoveCommand,
	RenameCommand,
	ConnectCommand,
	ConnectClause,
	DisconnectCommand,
	SetCommand,
	SetClause,
	GetCommand,
	CreateParameterCommand,
	ScreenshotCommand,
	ShowCommand,
	CdCommand,
	LsCommand,
	PwdCommand,
	ResetCommand,
	SaveCommand,
	DspCommand,
} from "./dsp-parser.js";
export {
	parseSingleDspCommand,
	parseDspInput,
} from "./dsp-parser.js";
export type { DspOp } from "./dsp-ops.js";
export {
	commandToDspOps,
	collectDspNodeIds,
	nodeParameters,
} from "./dsp-ops.js";

// ── Tree decoration ────────────────────────────────────────────────

const CONTAINER_COLOUR = MODE_ACCENTS.dsp;
type DiffStatus = "added" | "removed" | "modified";

function decorateDspTree(
	node: TreeNode,
	rawIndex: Map<string, RawDspNode>,
	parentDiff?: DiffStatus,
): TreeNode {
	const resolvedDiff: DiffStatus | undefined = node.diff
		?? (parentDiff === "added" || parentDiff === "removed" ? parentDiff : undefined);
	node.diff = resolvedDiff;
	const childDiff = resolvedDiff === "added" || resolvedDiff === "removed"
		? resolvedDiff
		: undefined;

	const raw = node.id ? rawIndex.get(node.id) : undefined;
	node.colour = CONTAINER_COLOUR;
	if (node.nodeKind === "chain") {
		node.filledDot = false;
		node.dimmed = !node.children || node.children.length === 0;
	} else {
		node.filledDot = true;
		node.dimmed = raw?.bypassed === true;
	}
	if (node.children) {
		for (const child of node.children) decorateDspTree(child, rawIndex, childDiff);
	}
	return node;
}

function buildRawIndex(raw: RawDspNode | null): Map<string, RawDspNode> {
	const map = new Map<string, RawDspNode>();
	if (!raw) return map;
	const walk = (n: RawDspNode) => {
		map.set(n.nodeId, n);
		for (const c of n.children) walk(c);
	};
	walk(raw);
	return map;
}

// ── DSP mode class ─────────────────────────────────────────────────

export class DspMode implements Mode {
	readonly id: Mode["id"] = "dsp";
	readonly name = "DSP";
	readonly accent = MODE_ACCENTS.dsp;
	readonly prompt = "[dsp] > ";

	private readonly scriptnodeList: ScriptnodeList | null;
	private readonly completionEngine: CompletionEngine | null;
	private moduleId: string | null = null;
	private currentPath: string[] = [];
	private rawTree: RawDspNode | null = null;
	private lastTreeResult: unknown = null;
	private treeRoot: TreeNode | null = null;
	private treeFetched = false;
	private lastTreeError: string | null = null;
	/** Set in onEnter when a network is missing; first parse pops + errors. */
	private noNetworkError: string | null = null;

	constructor(
		scriptnodeList?: ScriptnodeList,
		completionEngine?: CompletionEngine,
		initialPath?: string,
	) {
		this.scriptnodeList = scriptnodeList ?? null;
		this.completionEngine = completionEngine ?? null;
		if (initialPath) this.setContext(initialPath);
	}

	tokenizeInput(value: string): TokenSpan[] { return tokenizeDsp(value); }

	get contextLabel(): string {
		if (!this.moduleId) return "";
		if (this.currentPath.length === 0) return this.moduleId;
		return `${this.moduleId}/${this.currentPath.join("/")}`;
	}

	setContext(path: string): void {
		const segments = path.split(".").filter((s) => s !== "");
		if (segments.length === 0) return;
		this.moduleId = segments[0]!;
		this.currentPath = segments.slice(1);
	}

	getTree(): TreeNode | null {
		if (!this.treeRoot) return null;
		const rawIndex = buildRawIndex(this.rawTree);
		return decorateDspTree(structuredClone(this.treeRoot), rawIndex);
	}

	getSelectedPath(): string[] { return [...this.currentPath]; }
	selectNode(path: string[]): void { this.currentPath = [...path]; }
	invalidateTree(): void { this.treeFetched = false; }

	async onEnter(session: SessionContext): Promise<void> {
		if (this.moduleId && session.connection) {
			await this.fetchTree(session.connection);
			this.treeFetched = true;
			if (!this.rawTree) {
				this.noNetworkError = `No network loaded on "${this.moduleId}". Assign one first via builder: \`set ${this.moduleId}.network "<name>"\`.`;
			}
		}
	}

	// ── Tree fetch ──────────────────────────────────────────────

	async fetchTree(connection: HiseConnection): Promise<void> {
		if (!this.moduleId) return;
		let inPlan = false;
		const diffResp = await connection.get("/api/undo/diff?scope=group");
		if (isEnvelopeResponse(diffResp) && diffResp.success) {
			const groupName = diffResp.groupName as string | undefined;
			inPlan = typeof groupName === "string" && groupName !== "root" && groupName !== "";
		}
		const endpoint = `/api/dsp/tree?moduleId=${encodeURIComponent(this.moduleId)}${inPlan ? "&group=current" : ""}`;
		const response = await connection.get(endpoint);
		if (isErrorResponse(response)) {
			this.lastTreeError = `tree fetch failed: ${response.message}`;
			return;
		}
		if (!isEnvelopeResponse(response) || !response.success) {
			this.lastTreeError = "tree fetch returned non-success envelope";
			return;
		}
		this.lastTreeResult = response.result ?? null;
		try {
			const { raw, tree } = normalizeDspTreeResponse(response.result);
			this.rawTree = raw;
			this.treeRoot = tree;
			this.lastTreeError = null;
		} catch (e) {
			this.lastTreeError = `tree normalization failed: ${String(e)}`;
		}
	}

	private async ensureTree(session: SessionContext): Promise<void> {
		if (!this.treeFetched && this.moduleId && session.connection) {
			this.treeFetched = true;
			await this.fetchTree(session.connection);
		}
	}

	// ── Parse entry ─────────────────────────────────────────────

	async parse(input: string, session: SessionContext): Promise<CommandResult> {
		// No-network guard: surface the error and pop the mode.
		if (this.noNetworkError) {
			const msg = this.noNetworkError;
			this.noNetworkError = null;
			session.popMode();
			return errorResult(msg);
		}

		await this.ensureTree(session);

		const trimmed = input.trim();
		if (!trimmed) return textResult("");

		const result = parseDspInput(input);
		if ("error" in result) return errorResult(result.error);

		let last: CommandResult = textResult("(no commands)");
		for (const cmd of result.commands) {
			last = await this.dispatch(cmd, session);
			if (last.type === "error") return last;
		}
		return last;
	}

	// ── Dispatch ────────────────────────────────────────────────

	private async dispatch(cmd: DspCommand, session: SessionContext): Promise<CommandResult> {
		switch (cmd.type) {
			case "cd": return this.handleCd(cmd, session);
			case "ls": return this.handleLs(session);
			case "pwd": return this.handlePwd();
			case "save": return this.handleSave(session);
			case "show": return this.handleShow(cmd, session);
			case "get": return this.handleGet(cmd);
			case "screenshot": return this.handleScreenshot(cmd, session);
			default:
				return this.handleMutation(cmd, session);
		}
	}

	// ── Navigation ──────────────────────────────────────────────

	private async handleCd(cmd: CdCommand, session: SessionContext): Promise<CommandResult> {
		if (cmd.target.kind === "parent") {
			if (this.currentPath.length === 0) return session.popMode();
			this.currentPath.pop();
			return textResult(this.currentPath.length > 0 ? this.currentPath.join("/") : "/");
		}

		// Refresh tree before navigating; template-spawning factories may
		// expand server-side after the apply op returns.
		if (session.connection) await this.fetchTree(session.connection);

		if (!this.treeRoot) {
			const segs = pathRefSegments(cmd.target);
			for (const seg of segs) this.currentPath.push(seg.id);
			return textResult(this.currentPath.join("/"));
		}

		const r = resolvePath(this.treeRoot, this.currentPath, cmd.target, "cd");
		if (!r.ok) return errorResult(r.message);
		const rootId = this.treeRoot.id;
		const stripped = (rootId && r.fullPath[0]?.toLowerCase() === rootId.toLowerCase())
			? r.fullPath.slice(1)
			: r.fullPath;
		this.currentPath = stripped;
		return textResult(this.currentPath.length > 0 ? this.currentPath.join("/") : "/");
	}

	private async handleLs(session: SessionContext): Promise<CommandResult> {
		if (session.connection) await this.fetchTree(session.connection);
		if (this.lastTreeError) return errorResult(this.lastTreeError);
		if (!this.rawTree) {
			return textResult(this.moduleId
				? "(no network loaded)"
				: "(no module context — enter via /dsp.<moduleId>)");
		}
		const node = this.currentPath.length === 0
			? this.rawTree
			: findDspNode(this.rawTree, this.currentPath[this.currentPath.length - 1]!);
		if (!node) return errorResult(`Path not found: ${this.currentPath.join("/")}`);
		if (node.children.length === 0) return textResult(`${node.nodeId}: (no children)`);
		return tableResult(
			["Name", "Factory", "Bypassed"],
			node.children.map((c) => [c.nodeId, c.factoryPath, String(c.bypassed)]),
		);
	}

	private handlePwd(): CommandResult {
		if (!this.moduleId) return textResult("(no module context)");
		const suffix = this.currentPath.length > 0 ? "/" + this.currentPath.join("/") : "";
		return textResult(`${this.moduleId}${suffix}`);
	}

	// ── Save ────────────────────────────────────────────────────

	private async handleSave(session: SessionContext): Promise<CommandResult> {
		if (!this.moduleId) return errorResult("save: no module context.");
		if (!session.connection) return errorResult("save requires a HISE connection");
		const resp = await session.connection.post(
			`/api/dsp/save?moduleId=${encodeURIComponent(this.moduleId)}`,
			{ moduleId: this.moduleId },
		);
		if (isErrorResponse(resp)) return errorResult(resp.message);
		if (!isEnvelopeResponse(resp) || !resp.success) {
			return errorResult(envelopeError(resp, "save failed"));
		}
		try {
			const parsed = normalizeDspSaveResponse(resp);
			session.markProjectTreeDirty?.();
			return textResult(`Saved: ${parsed.filePath}`);
		} catch (e) {
			return errorResult(String(e));
		}
	}

	// ── Screenshot ──────────────────────────────────────────────

	private async handleScreenshot(
		cmd: ScreenshotCommand,
		session: SessionContext,
	): Promise<CommandResult> {
		if (!this.moduleId) return errorResult("screenshot: no module context.");
		if (!session.connection) return errorResult("screenshot requires a HISE connection");

		const params = new URLSearchParams();
		params.set("moduleId", this.moduleId);
		params.set("outputPath", normalizeScreenshotPath(cmd.file));
		params.set("scale", String(cmd.scale));

		const response = await session.connection.get(
			`/api/dsp/screenshot?${params.toString()}`,
		);
		if (isErrorResponse(response)) return errorResult(response.message);
		if (!isEnvelopeResponse(response) || !response.success) {
			return errorResult(envelopeError(response, "Screenshot failed"));
		}

		const data = response as unknown as Record<string, unknown>;
		const width = data.width ?? "?";
		const height = data.height ?? "?";
		const filePath = typeof data.filePath === "string" ? data.filePath : cmd.file;
		return textResult(`Screenshot saved to ${filePath} (${width}x${height})`);
	}

	// ── Show ────────────────────────────────────────────────────

	private async handleShow(cmd: ShowCommand, session: SessionContext): Promise<CommandResult> {
		if (cmd.kind !== "target") {
			return this.handleShowNoun(cmd.kind, cmd.filter, session);
		}
		if (!this.moduleId) {
			return errorResult("show: no module context.");
		}
		if (!session.connection) return errorResult("show <node> requires a HISE connection");

		// Resolve target id from PathRef. ≥2 segs = parameter detail.
		const segs = pathRefSegments(cmd.target);
		const moduleRef: PathRef = segs.length === 0
			? cmd.target
			: { kind: "bare", segment: segs[0] };
		const r = this.resolveRefForRead(moduleRef);
		if ("error" in r) return errorResult(r.error);

		const wantsParam = segs.length >= 2;
		const paramName = wantsParam ? segs[1].id : null;
		if (segs.length > 2) {
			return errorResult("show: parameter detail does not support sub-fields (use `set` for range subfields)");
		}

		const endpoint = `/api/dsp/tree?moduleId=${encodeURIComponent(this.moduleId)}&verbose=true`;
		const resp = await session.connection.get(endpoint);
		if (isErrorResponse(resp)) return errorResult(resp.message);
		if (!isEnvelopeResponse(resp) || !resp.success) {
			return errorResult(envelopeError(resp, "show failed"));
		}

		let verboseRoot: RawDspNode;
		try {
			verboseRoot = normalizeDspTreeResponse(resp.result).raw;
		} catch (e) {
			return errorResult(String(e));
		}

		const node = findDspNode(verboseRoot, r.id);
		if (!node) return errorResult(`Node "${r.id}" not found`);

		if (wantsParam) {
			const param = node.parameters?.find((p) => p.parameterId.toLowerCase() === paramName!.toLowerCase());
			if (!param) return errorResult(`Parameter "${paramName}" not found on "${r.id}"`);
			if (session.forLlm) return jsonResult(cleanDspParameterForLlm(param));
			return tableResult(
				["Field", "Value"],
				[
					["id", param.parameterId],
					["value", String(param.value ?? "")],
					["range", `${param.min ?? "?"} – ${param.max ?? "?"}`],
					["default", String(param.defaultValue ?? "")],
				],
			);
		}

		if (session.forLlm) {
			return jsonResult(node);
		}

		const parent = findDspParent(verboseRoot, r.id);
		const parentId = parent ? parent.nodeId : "(root)";
		return preformattedResult(renderDspNodeShow(node, parentId, verboseRoot));
	}

	private async handleShowNoun(
		kind: "tree" | "networks" | "modules" | "connections",
		filter: string | undefined,
		session: SessionContext,
	): Promise<CommandResult> {
		const filterLower = filter ? filter.toLowerCase() : null;
		const filterFn = (s: string): boolean => !filterLower || s.toLowerCase().includes(filterLower);

		if (kind === "tree") {
			if (session.forLlm) {
				if (!this.lastTreeResult) return textResult("(no tree)");
				return jsonResult(cleanDspTreeForLlm(this.lastTreeResult));
			}
			if (!this.treeRoot) return textResult("(no tree)");
			return preformattedResult(renderTreeBox(this.getTree()!), undefined, true);
		}

		if (kind === "networks") {
			if (!session.connection) return errorResult("show networks requires a HISE connection");
			const resp = await session.connection.get("/api/dsp/list");
			if (isErrorResponse(resp)) return errorResult(resp.message);
			if (!isEnvelopeResponse(resp) || !resp.success) {
				return errorResult("Failed to list networks");
			}
			try {
				const networks = normalizeDspList(resp.networks).filter(filterFn);
				if (networks.length === 0) return textResult("(no networks)");
				return tableResult(["Network"], networks.map((n) => [n]));
			} catch (e) {
				return errorResult(String(e));
			}
		}

		if (kind === "modules") {
			if (!session.connection) return errorResult("show modules requires a HISE connection");
			const resp = await session.connection.get("/api/status");
			if (isErrorResponse(resp)) return errorResult(resp.message);
			if (!isEnvelopeResponse(resp) || !resp.success) return errorResult("Failed to list modules");
			const processors = (resp.scriptProcessors as Array<{ moduleId: string }> | undefined) ?? [];
			const filtered = processors.filter((p) => filterFn(p.moduleId));
			if (filtered.length === 0) return textResult("(no script processors)");
			return tableResult(["Module ID"], filtered.map((p) => [p.moduleId]));
		}

		// connections
		if (!this.rawTree) return textResult("(no tree)");
		const rows: string[][] = [];
		collectConnections(this.rawTree, rows);
		const filtered = filterLower ? rows.filter((r) => r.some(filterFn)) : rows;
		if (filtered.length === 0) return textResult("(no modulation connections)");
		return tableResult(["Source", "Output", "Target", "Parameter"], filtered);
	}

	// ── Get ─────────────────────────────────────────────────────

	private handleGet(cmd: GetCommand): CommandResult {
		if (!this.rawTree) return errorResult("(no network loaded)");
		if (cmd.paths.length === 0) return errorResult("get: no paths");
		const ref = cmd.paths[0];
		const segs = pathRefSegments(ref);
		if (segs.length < 2) return errorResult("get: path must have at least 2 segments");
		const nodeId = segs[0].id;
		const fieldName = segs[1].id;
		const fieldLower = fieldName.toLowerCase();
		const node = findDspNode(this.rawTree, nodeId);
		if (!node) return errorResult(`Node "${nodeId}" not found`);

		// Source / parent universal queries
		if (fieldLower === "parent") {
			const parent = findDspParent(this.rawTree, nodeId);
			return textResult(parent?.nodeId ?? "(root)");
		}

		// Connection source query: get X.p.source
		if (segs.length >= 3 && segs[2].id.toLowerCase() === "source") {
			const conn = findDspConnectionTargeting(this.rawTree, nodeId, fieldName);
			return textResult(conn ? conn.source : "(not connected)");
		}

		// Parameter / property value
		const param = node.parameters.find((p) => p.parameterId === fieldName);
		if (param) return textResult(String(param.value));
		const prop = node.properties?.find((p) => p.propertyId === fieldName);
		if (prop) return textResult(String(prop.value));
		return errorResult(`"${fieldName}" not found on ${nodeId}`);
	}

	// ── Mutations ───────────────────────────────────────────────

	private async handleMutation(
		cmd: DspCommand,
		session: SessionContext,
	): Promise<CommandResult> {
		if (!this.moduleId) {
			return errorResult("No module context. Enter mode via /dsp.<moduleId>.");
		}

		// Local validation
		if (cmd.type === "add" && this.scriptnodeList) {
			const v = validateAddCommand(cmd, this.scriptnodeList);
			if (!v.valid) return errorResult(v.errors.join("\n"));
		}
		if (cmd.type === "set" && this.scriptnodeList) {
			const v = validateSetCommand(cmd, this.scriptnodeList, this.rawTree);
			if (!v.valid) return errorResult(v.errors.join("\n"));
		}
		if (cmd.type === "createParameter" && this.scriptnodeList) {
			const v = validateCreateParameterCommand(cmd, this.scriptnodeList, this.rawTree);
			if (!v.valid) return errorResult(v.errors.join("\n"));
		}

		const opsResult = commandToDspOps(cmd, this.rawTree, this.treeRoot, this.currentPath);
		if ("error" in opsResult) return errorResult(opsResult.error);
		if (opsResult.ops.length === 0) return textResult("(no operations)");

		if (!session.connection) {
			return textResult(`(offline) would apply: ${JSON.stringify(opsResult.ops)}`);
		}
		const result = await this.executeOps(opsResult.ops, session.connection);
		if (result.type !== "error") session.markProjectTreeDirty?.();
		return result;
	}

	private async executeOps(
		ops: DspOp[],
		connection: HiseConnection,
	): Promise<CommandResult> {
		const body = { moduleId: this.moduleId, operations: ops };
		const response = await connection.post("/api/dsp/apply", body);
		if (isErrorResponse(response)) return errorResult(response.message);
		if (!isEnvelopeResponse(response)) return errorResult("Unexpected response from HISE");
		if (!response.success) return errorResult(envelopeError(response, "DSP operation failed"));

		let applyResult;
		try {
			applyResult = normalizeDspApplyResponse(response);
		} catch (e) {
			return errorResult(String(e));
		}

		await this.fetchTree(connection);
		if (applyResult.diff.length > 0 && this.treeRoot) {
			applyDiffToTree(this.treeRoot, applyResult.diff);
		}

		const summary = response.logs.length > 0
			? response.logs.join("; ")
			: applyResult.diff.map((d) => `${d.action} ${d.target}`).join(", ") || "OK";
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

	// ── Completion ──────────────────────────────────────────────

	complete(input: string, _cursor: number): CompletionResult {
		const lastComma = findLastUnquotedComma(input);
		const segStart = lastComma + 1;
		const segment = input.slice(segStart);
		const offset = segStart + (segment.length - segment.trimStart().length);

		if (!this.completionEngine) return { items: [], from: 0, to: input.length };
		const trimmed = segment.trimStart();
		const inputLength = input.length;
		const tokens = trimmed.split(/\s+/);
		const first = tokens[0]?.toLowerCase() ?? "";

		if (tokens.length <= 1) {
			const items = DSP_KEYWORDS.filter((k) => k.label.startsWith(first));
			return { items, from: offset, to: inputLength, label: "DSP commands" };
		}

		if (first === "show" && tokens.length === 2) {
			const prefix = tokens[1]!;
			const lower = prefix.toLowerCase();
			// Parameter detail: `show <node>.<param>` — complete params after dot.
			const dotIdx = prefix.indexOf(".");
			if (dotIdx !== -1) {
				const nodeId = prefix.slice(0, dotIdx);
				const paramPrefix = prefix.slice(dotIdx + 1).toLowerCase();
				const names = this.scriptnodeList
					? nodeParametersAndProperties(this.rawTree, this.scriptnodeList, nodeId)
					: nodeParameters(this.rawTree, nodeId);
				const items = names
					.filter((p) => p.toLowerCase().startsWith(paramPrefix))
					.map((p) => ({ label: p }));
				return {
					items,
					from: offset + tokens[0]!.length + 1 + dotIdx + 1,
					to: inputLength,
				};
			}
			const nouns = DSP_SHOW_NOUNS.filter((k) => k.label.startsWith(lower));
			const nodes = collectDspNodeIds(this.rawTree)
				.filter((n) => n.nodeId.toLowerCase().startsWith(lower))
				.map((n) => ({ label: n.nodeId, detail: n.factoryPath }));
			return { items: [...nouns, ...nodes], from: offset + tokens[0]!.length + 1, to: inputLength };
		}

		if (first === "add" && tokens.length === 2) {
			const res = this.completionEngine.completeScriptnode(tokens[1]!);
			const fromBase = offset + tokens[0]!.length + 1;
			return { items: res.items, from: fromBase + res.from, to: inputLength };
		}

		if ((first === "set" || first === "get" || first === "remove") && tokens.length === 2) {
			const tail = tokens[1]!;
			const firstDot = tail.indexOf(".");
			if (firstDot !== -1) {
				const nodeId = tail.slice(0, firstDot);
				const afterFirst = tail.slice(firstDot + 1);
				const secondDot = afterFirst.indexOf(".");
				if (first === "set" && secondDot !== -1) {
					const fieldPrefix = afterFirst.slice(secondDot + 1).toLowerCase();
					const fields = ["min", "max", "stepSize", "middlePosition", "skewFactor", "range"]
						.filter((f) => f.toLowerCase().startsWith(fieldPrefix))
						.map((f) => ({ label: f }));
					return {
						items: fields,
						from: offset + tokens[0]!.length + 1 + firstDot + 1 + secondDot + 1,
						to: inputLength,
					};
				}
				const paramPrefix = afterFirst;
				const names = this.scriptnodeList
					? nodeParametersAndProperties(this.rawTree, this.scriptnodeList, nodeId)
					: nodeParameters(this.rawTree, nodeId);
				const params = names
					.filter((p) => p.toLowerCase().startsWith(paramPrefix.toLowerCase()))
					.map((p) => ({ label: p }));
				return {
					items: params,
					from: offset + tokens[0]!.length + 1 + firstDot + 1,
					to: inputLength,
				};
			}
			const nodeIds = collectDspNodeIds(this.rawTree)
				.filter((n) => n.nodeId.toLowerCase().startsWith(tail.toLowerCase()))
				.map((n) => ({ label: n.nodeId, detail: n.factoryPath }));
			return { items: nodeIds, from: offset + tokens[0]!.length + 1, to: inputLength };
		}

		return { items: [], from: offset, to: inputLength };
	}
}

// ── Internal helpers ────────────────────────────────────────────

function envelopeError(response: import("../hise.js").HiseResponse, fallback: string): string {
	if (isEnvelopeResponse(response) && response.errors.length > 0) {
		return response.errors.map((e) => e.errorMessage).join("\n");
	}
	return fallback;
}

function normalizeScreenshotPath(raw: string): string {
	const forward = raw.replace(/\\/g, "/");
	const hasDriveLetter = /^[A-Za-z]:\//.test(forward);
	if (hasDriveLetter) return forward;
	return forward.replace(/^\/+/, "");
}

function collectConnections(node: RawDspNode, rows: string[][]): void {
	if (node.connections) {
		for (const c of node.connections) {
			rows.push([c.source, String(c.sourceOutput), c.target, c.parameter]);
		}
	}
	for (const child of node.children) collectConnections(child, rows);
}

function collectAllConnections(
	node: RawDspNode,
	out: import("../../mock/contracts/dsp.js").RawDspConnection[],
): void {
	if (node.connections) out.push(...node.connections);
	for (const child of node.children) collectAllConnections(child, out);
}

function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function formatPropertyValue(v: string | number | boolean): string {
	if (typeof v === "string") return `"${v}"`;
	if (typeof v === "number") {
		if (Number.isInteger(v) && v !== 0 && v > 0xFF) {
			return `0x${v.toString(16).toUpperCase().padStart(8, "0")}`;
		}
		return String(v);
	}
	return v ? "true" : "false";
}

function renderDspNodeShow(
	node: RawDspNode,
	parentId: string,
	root: RawDspNode,
): string {
	const lines: string[] = [];

	lines.push(
		`${node.factoryPath}  ${node.nodeId}  parent: ${parentId}  bypassed: ${node.bypassed ? "yes" : "no"}`,
	);

	if (node.properties && node.properties.length > 0) {
		const idWidth = Math.max(...node.properties.map((p) => p.propertyId.length));
		for (const p of node.properties) {
			lines.push(`  ${pad(p.propertyId, idWidth)}  ${formatPropertyValue(p.value)}`);
		}
	}

	if (node.parameters.length > 0) {
		lines.push("  Parameters");
		const idWidth = Math.max(...node.parameters.map((p) => p.parameterId.length));
		const valStrs = node.parameters.map((p) => String(p.value));
		const valWidth = Math.max(...valStrs.map((s) => s.length));
		for (let i = 0; i < node.parameters.length; i++) {
			const p = node.parameters[i]!;
			const parts = [
				`    ${pad(p.parameterId, idWidth)}  ${pad(valStrs[i]!, valWidth)}`,
			];
			if (p.min !== undefined && p.max !== undefined) {
				parts.push(`range ${p.min} - ${p.max}`);
			}
			if (p.defaultValue !== undefined) {
				parts.push(`default ${p.defaultValue}`);
			}
			lines.push(parts.join("    "));
		}
	}

	const allEdges: import("../../mock/contracts/dsp.js").RawDspConnection[] = [];
	collectAllConnections(root, allEdges);
	const out = allEdges.filter((c) => c.source === node.nodeId);
	const incoming = allEdges.filter((c) => c.target === node.nodeId);
	lines.push("  Modulation");
	if (out.length === 0) {
		lines.push("    out -> (none)");
	} else {
		for (const c of out) {
			const srcOut = c.sourceOutput !== undefined && c.sourceOutput !== ""
				? ` (${c.sourceOutput})`
				: "";
			const tgt = c.parameter ? `${c.target}.${c.parameter}` : c.target;
			lines.push(`    out -> ${tgt}${srcOut}`);
		}
	}
	if (incoming.length === 0) {
		lines.push("    in  <- (none)");
	} else {
		for (const c of incoming) {
			const srcOut = c.sourceOutput !== undefined && c.sourceOutput !== ""
				? `.${c.sourceOutput}`
				: "";
			const param = c.parameter ? `.${c.parameter}` : "";
			lines.push(`    in  <- ${c.source}${srcOut}${param ? ` (${param.slice(1)})` : ""}`);
		}
	}

	return lines.join("\n");
}

// ── Completion keyword tables ───────────────────────────────────

const DSP_KEYWORDS = [
	{ label: "show", detail: "show tree | networks | modules | connections | <nodeId> | <nodeId>.<param>" },
	{ label: "save", detail: "Save the network to its .xml file" },
	{ label: "reset", detail: "Empty the loaded network" },
	{ label: "add", detail: "add <factory>.<node> as \"<id>\" [to <parent>]" },
	{ label: "remove", detail: "Remove a node" },
	{ label: "rename", detail: "rename <nodeId> as \"<newId>\"" },
	{ label: "connect", detail: "Connect modulation source to target param" },
	{ label: "disconnect", detail: "Disconnect modulation by target" },
	{ label: "set", detail: "Set a parameter value or range field" },
	{ label: "get", detail: "Get a parameter value or universal field" },
	{ label: "create_parameter", detail: "Create a dynamic parameter on a container" },
	{ label: "screenshot", detail: "screenshot scale <s> file \"<path>\"" },
	{ label: "cd", detail: "Navigate into a container" },
	{ label: "ls", detail: "List children at current path" },
	{ label: "pwd", detail: "Print current path" },
];

const DSP_SHOW_NOUNS = [
	{ label: "tree", detail: "Network hierarchy" },
	{ label: "networks", detail: "Available DspNetwork xml files" },
	{ label: "modules", detail: "Script processors hosting networks" },
	{ label: "connections", detail: "Modulation edges in the network" },
];

// Stand-in to silence unused-import warnings when the dispatcher path
// is exercised but parseSingleDspCommand is only used by the shared
// parseDspInput export.
void parseSingleDspCommand;
void pathRefToString;

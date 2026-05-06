// ── DSP mode — scriptnode graph editor ─────────────────────────────────
//
// Mirrors builder/ui pattern: GET /api/dsp/tree + POST /api/dsp/apply.
// Context is a moduleId (the DspNetwork::Holder script processor).
// Tree data is cached as RawDspNode for parameter/connection lookups and
// as TreeNode for sidebar rendering.

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
	findDspConnectionTargeting,
	findDspNode,
	findDspParent,
	normalizeDspApplyResponse,
	normalizeDspInitResponse,
	normalizeDspList,
	normalizeDspSaveResponse,
	normalizeDspTreeResponse,
} from "../../mock/contracts/dsp.js";
import { applyDiffToTree } from "../../mock/contracts/builder.js";
import type { CompletionEngine } from "../completion/engine.js";
import type { DspCommand, GetCommand, ShowCommand } from "./dsp-parser.js";
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

// ── Re-exports ────────────────────────────────────────────────────

export type {
	AddCommand,
	RemoveCommand,
	MoveCommand,
	ConnectCommand,
	DisconnectCommand,
	SetCommand,
	GetCommand,
	BypassCommand,
	EnableCommand,
	CreateParameterCommand,
	ShowCommand,
	UseCommand,
	InitCommand,
	SaveCommand,
	ResetCommand,
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

// ── Screenshot clause parsing ──────────────────────────────────────

interface DspScreenshotOptions {
	scale?: number;
	outputPath?: string;
}

const DSP_SCREENSHOT_VALID_SCALES = [0.5, 1.0, 2.0];

export function parseDspScreenshotClauses(
	args: string,
): DspScreenshotOptions | string {
	const opts: DspScreenshotOptions = {};

	// "at <N>%" or "at <0.N>" / "at <N.N>"
	const atPercentMatch = args.match(/\bat\s+(\d+)%/i);
	if (atPercentMatch) {
		opts.scale = parseInt(atPercentMatch[1], 10) / 100;
	} else {
		const atDecimalMatch = args.match(/\bat\s+(0?\.\d+|\d+(?:\.\d+)?)/i);
		if (atDecimalMatch) opts.scale = parseFloat(atDecimalMatch[1]);
	}

	if (opts.scale !== undefined && !DSP_SCREENSHOT_VALID_SCALES.includes(opts.scale)) {
		return `Invalid scale ${opts.scale}. Valid values: 0.5, 1.0, 2.0`;
	}

	// "to <path>"
	const toMatch = args.match(/\bto\s+(\S+)/i);
	if (toMatch) {
		const raw = toMatch[1];
		if (!raw.toLowerCase().endsWith(".png")) {
			return `Output path must end with .png (got "${raw}")`;
		}
		opts.outputPath = normalizeDspScreenshotPath(raw);
	}

	return opts;
}

/**
 * Normalize a screenshot output path so it is unambiguously interpreted by
 * HISE. Leading `/` or `\` on a path without a drive letter is stripped so
 * the path is treated as relative to the project's Images/ folder (users
 * often type `/subfolder/foo.png` meaning "under Images" — Windows would
 * otherwise resolve this to the filesystem root). Absolute paths with a
 * drive letter (e.g. `D:/…`) pass through unchanged. Backslashes are
 * converted to forward slashes.
 */
function normalizeDspScreenshotPath(raw: string): string {
	const forward = raw.replace(/\\/g, "/");
	const hasDriveLetter = /^[A-Za-z]:\//.test(forward);
	if (hasDriveLetter) return forward;
	return forward.replace(/^\/+/, "");
}

// ── Tree decoration ────────────────────────────────────────────────

const CONTAINER_COLOUR = MODE_ACCENTS.dsp;

/**
 * Walk the TreeNode produced by normalizeDspTree and decorate it with
 * dots / colours / dim state for the sidebar:
 *  - containers (chain kind) get the ○ dot in the DSP accent
 *  - leaves (module kind) get the ● filled dot in the DSP accent
 *  - bypassed nodes get dimmed
 * Diff inheritance mirrors builder: added/removed propagate, modified
 * does not.
 */
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
		for (const child of node.children) {
			decorateDspTree(child, rawIndex, childDiff);
		}
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
	/**
	 * Last normalizer error from fetchTree. Surface in handleLs / handleCd
	 * so silent normalization failures don't masquerade as "stale tree".
	 */
	private lastTreeError: string | null = null;

	constructor(
		scriptnodeList?: ScriptnodeList,
		completionEngine?: CompletionEngine,
		initialPath?: string,
	) {
		this.scriptnodeList = scriptnodeList ?? null;
		this.completionEngine = completionEngine ?? null;
		if (initialPath) this.setContext(initialPath);
	}

	tokenizeInput(value: string): TokenSpan[] {
		return tokenizeDsp(value);
	}

	get contextLabel(): string {
		if (!this.moduleId) return "";
		if (this.currentPath.length === 0) return this.moduleId;
		return `${this.moduleId}/${this.currentPath.join("/")}`;
	}

	setContext(path: string): void {
		// Dot-entry: "/dsp.Script FX1" or "/dsp.Script FX1.Main.Osc1"
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

	getSelectedPath(): string[] {
		return [...this.currentPath];
	}

	selectNode(path: string[]): void {
		this.currentPath = [...path];
	}

	invalidateTree(): void {
		this.treeFetched = false;
	}

	async onEnter(session: SessionContext): Promise<void> {
		if (this.moduleId && session.connection) {
			await this.fetchTree(session.connection);
			this.treeFetched = true;
		}
	}

	// ── Tree fetch ──────────────────────────────────────────────

	/**
	 * Fetch the current module's network tree from HISE. Honours plan
	 * state by switching to `?group=current` when an undo group is
	 * active. Updates rawTree and treeRoot.
	 */
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
			// Normalization failed — keep last good tree but surface why.
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
		await this.ensureTree(session);

		const trimmed = input.trim();
		if (!trimmed) return textResult("");

		const parts = trimmed.split(/\s+/);
		const keyword = parts[0]?.toLowerCase();

		if (keyword === "help") return this.handleHelp();
		if (keyword === "cd") {
			const target = parts.slice(1).join(" ").trim();
			return this.handleCd(target, session);
		}
		if (keyword === "ls" || keyword === "dir") return this.handleLs(session);
		if (keyword === "pwd") return this.handlePwd();
		if (keyword === "screenshot") {
			const rest = trimmed.slice("screenshot".length).trim();
			return this.handleScreenshot(rest, session);
		}

		// Chevrotain-parsed commands (with comma chaining)
		const result = parseDspInput(input);
		if ("error" in result) return errorResult(result.error);

		let last: CommandResult = textResult("(no commands)");
		for (const cmd of result.commands) {
			last = await this.dispatch(cmd, session);
			if (last.type === "error") return last;
		}
		return last;
	}

	// ── Navigation ──────────────────────────────────────────────

	private async handleCd(target: string, session: SessionContext): Promise<CommandResult> {
		if (!target || target === "/") {
			this.currentPath = [];
			return textResult("/");
		}
		if (target === "..") {
			if (this.currentPath.length === 0) return session.popMode();
			this.currentPath.pop();
			return textResult(this.currentPath.length > 0 ? this.currentPath.join("/") : "/");
		}
		// Refresh tree before navigating. Template-spawning factories
		// expand their internal subtree server-side after the apply op
		// returns, so the snapshot fetched at apply time may not yet
		// include the spawned children. Re-fetching here ensures cd /
		// ls / get see the live structure.
		if (session.connection) await this.fetchTree(session.connection);
		const segments = target.split(/[./]/).filter((s) => s !== "");
		for (const seg of segments) {
			if (seg === "..") {
				if (this.currentPath.length > 0) this.currentPath.pop();
			} else {
				if (this.rawTree && !findDspNode(this.rawTree, seg)) {
					return errorResult(`"${seg}" not found in DSP graph.`);
				}
				this.currentPath.push(seg);
			}
		}
		return textResult(this.currentPath.join("/"));
	}

	private async handleLs(session: SessionContext): Promise<CommandResult> {
		// Refresh before reading — see handleCd for rationale.
		if (session.connection) await this.fetchTree(session.connection);
		if (this.lastTreeError) return errorResult(this.lastTreeError);
		if (!this.rawTree) {
			return textResult(this.moduleId ? "(tree not loaded — run `init <name>` first)" : "(no module context — enter via /dsp.<moduleId>)");
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

	// ── Screenshot ──────────────────────────────────────────────

	private async handleScreenshot(
		args: string,
		session: SessionContext,
	): Promise<CommandResult> {
		if (!this.moduleId) {
			return errorResult("screenshot: no module context. Enter via /dsp.<moduleId> or run `use <moduleId>` first.");
		}
		if (!session.connection) {
			return errorResult("screenshot requires a HISE connection");
		}

		const parsed = parseDspScreenshotClauses(args);
		if (typeof parsed === "string") return errorResult(parsed);

		const outputPath = parsed.outputPath ?? "screenshot.png";

		const params = new URLSearchParams();
		params.set("moduleId", this.moduleId);
		params.set("outputPath", outputPath);
		if (parsed.scale !== undefined) params.set("scale", String(parsed.scale));

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
		const filePath = typeof data.filePath === "string" ? data.filePath : outputPath;
		return textResult(`Screenshot saved to ${filePath} (${width}x${height})`);
	}

	// ── Dispatch ────────────────────────────────────────────────

	private async dispatch(cmd: DspCommand, session: SessionContext): Promise<CommandResult> {
		switch (cmd.type) {
			case "show": return this.handleShow(cmd, session);
			case "use": return this.handleUse(cmd.moduleId, session);
			case "init": return this.handleInit(cmd.name, cmd.mode, session);
			case "save": return this.handleSave(session);
			case "get": return this.handleGet(cmd);
			// Mutation commands: validate locally, then apply.
			case "add":
			case "remove":
			case "move":
			case "connect":
			case "disconnect":
			case "set":
			case "bypass":
			case "enable":
			case "create_parameter":
			case "reset":
				return this.handleMutation(cmd, session);
		}
	}

	// ── Show ────────────────────────────────────────────────────

	private async handleShow(
		cmd: ShowCommand,
		session: SessionContext,
	): Promise<CommandResult> {
		if (cmd.what === "node") {
			return this.handleShowNode(cmd.nodeId, session);
		}
		const what = cmd.what;
		if (what === "tree") {
			if (session.forLlm) {
				if (!this.lastTreeResult) return textResult("(no tree — call `init <name>` first)");
				return jsonResult(cleanDspTreeForLlm(this.lastTreeResult));
			}
			if (!this.treeRoot) return textResult("(no tree — call `init <name>` first)");
			return preformattedResult(renderTreeBox(this.getTree()!), undefined, true);
		}
		if (what === "networks") {
			if (!session.connection) return errorResult("show networks requires a HISE connection");
			const resp = await session.connection.get("/api/dsp/list");
			if (isErrorResponse(resp)) return errorResult(resp.message);
			if (!isEnvelopeResponse(resp) || !resp.success) {
				return errorResult("Failed to list networks");
			}
			try {
				const networks = normalizeDspList(resp.networks);
				if (networks.length === 0) return textResult("(no networks)");
				return tableResult(["Network"], networks.map((n) => [n]));
			} catch (e) {
				return errorResult(String(e));
			}
		}
		if (what === "modules") {
			if (!session.connection) return errorResult("show modules requires a HISE connection");
			const resp = await session.connection.get("/api/status");
			if (isErrorResponse(resp)) return errorResult(resp.message);
			if (!isEnvelopeResponse(resp) || !resp.success) {
				return errorResult("Failed to list modules");
			}
			const processors = (resp.scriptProcessors as Array<{ moduleId: string }> | undefined) ?? [];
			if (processors.length === 0) return textResult("(no script processors)");
			return tableResult(
				["Module ID"],
				processors.map((p) => [p.moduleId]),
			);
		}
		if (what === "connections") {
			if (!this.rawTree) return textResult("(no tree — call `init <name>` first)");
			const rows: string[][] = [];
			collectConnections(this.rawTree, rows);
			if (rows.length === 0) return textResult("(no modulation connections)");
			return tableResult(["Source", "Output", "Target", "Parameter"], rows);
		}
		return errorResult(`Unknown show target: ${what}`);
	}

	private async handleShowNode(
		nodeId: string,
		session: SessionContext,
	): Promise<CommandResult> {
		if (!this.moduleId) {
			return errorResult("show: no module context. Enter via /dsp.<moduleId> or run `use <moduleId>` first.");
		}
		if (!session.connection) return errorResult("show <node> requires a HISE connection");

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

		const node = findDspNode(verboseRoot, nodeId);
		if (!node) return errorResult(`Node "${nodeId}" not found`);

		const parent = findDspParent(verboseRoot, nodeId);
		const parentId = parent ? parent.nodeId : "(root)";
		return preformattedResult(renderDspNodeShow(node, parentId, verboseRoot));
	}

	// ── Use ─────────────────────────────────────────────────────

	private async handleUse(moduleId: string, session: SessionContext): Promise<CommandResult> {
		this.moduleId = moduleId;
		this.currentPath = [];
		this.rawTree = null;
		this.treeRoot = null;
		this.treeFetched = false;
		if (session.connection) {
			await this.fetchTree(session.connection);
			this.treeFetched = true;
		}
		return textResult(`Using module "${moduleId}"`);
	}

	// ── Init / Save ─────────────────────────────────────────────

	private async handleInit(
		name: string,
		mode: "auto" | "load" | "create",
		session: SessionContext,
	): Promise<CommandResult> {
		const verb = mode === "auto" ? "init" : mode;
		if (!this.moduleId) {
			return errorResult(`${verb}: no module context. Enter mode via /dsp.<moduleId> or run \`use <moduleId>\` first.`);
		}
		if (!session.connection) return errorResult(`${verb} requires a HISE connection`);
		const body = { moduleId: this.moduleId, name, mode };
		const resp = await session.connection.post(
			`/api/dsp/init?moduleId=${encodeURIComponent(this.moduleId)}`,
			body,
		);
		if (isErrorResponse(resp)) return errorResult(resp.message);
		if (!isEnvelopeResponse(resp) || !resp.success) {
			return errorResult(mapInitError(resp, name, mode));
		}
		try {
			const parsed = normalizeDspInitResponse(resp);
			const { raw, tree } = normalizeDspTreeResponse(parsed.tree);
			this.rawTree = raw;
			this.treeRoot = tree;
			this.treeFetched = true;
			this.currentPath = [];
			const where = parsed.filePath ? ` (${parsed.filePath})` : "";
			const msg = parsed.source === "loaded"
				? `Loaded existing "${name}" on ${this.moduleId}${where}`
				: `Created new "${name}" on ${this.moduleId}${where}`;
			return textResult(msg);
		} catch (e) {
			return errorResult(String(e));
		}
	}

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

	// ── Get (local tree queries) ───────────────────────────────

	private handleGet(cmd: GetCommand): CommandResult {
		if (!this.rawTree) return errorResult("(no tree — call `init <name>` first)");
		if (cmd.query === "factory") {
			const node = findDspNode(this.rawTree, cmd.nodeId);
			if (!node) return errorResult(`Node "${cmd.nodeId}" not found`);
			return textResult(node.factoryPath);
		}
		if (cmd.query === "param") {
			const node = findDspNode(this.rawTree, cmd.nodeId);
			if (!node) return errorResult(`Node "${cmd.nodeId}" not found`);
			const param = node.parameters.find((p) => p.parameterId === cmd.parameterId);
			if (!param) return errorResult(`Parameter "${cmd.parameterId}" not found on ${cmd.nodeId}`);
			return textResult(String(param.value));
		}
		if (cmd.query === "source") {
			const conn = findDspConnectionTargeting(this.rawTree, cmd.nodeId, cmd.parameterId);
			if (!conn) return textResult("(not connected)");
			return textResult(conn.source);
		}
		if (cmd.query === "parent") {
			const node = findDspNode(this.rawTree, cmd.nodeId);
			if (!node) return errorResult(`Node "${cmd.nodeId}" not found`);
			const parent = findDspParent(this.rawTree, cmd.nodeId);
			return textResult(parent?.nodeId ?? "(root)");
		}
		return errorResult("Unknown get query");
	}

	// ── Mutations ───────────────────────────────────────────────

	private async handleMutation(
		cmd: DspCommand,
		session: SessionContext,
	): Promise<CommandResult> {
		if (!this.moduleId) {
			return errorResult("No module context. Enter mode via /dsp.<moduleId> or run `use <moduleId>` first.");
		}

		// Local validation
		if (cmd.type === "add" && this.scriptnodeList) {
			const v = validateAddCommand(cmd, this.scriptnodeList);
			if (!v.valid) return errorResult(v.errors.join("\n"));
		}
		if (cmd.type === "set" && this.scriptnodeList) {
			const factoryPath = this.rawTree
				? findDspNode(this.rawTree, cmd.nodeId)?.factoryPath ?? null
				: null;
			const rootNodeId = this.rawTree?.nodeId ?? null;
			const v = validateSetCommand(
				cmd,
				factoryPath,
				this.scriptnodeList,
				this.rawTree,
				rootNodeId,
			);
			if (!v.valid) return errorResult(v.errors.join("\n"));
		}
		if (cmd.type === "create_parameter" && this.scriptnodeList) {
			const factoryPath = this.rawTree
				? findDspNode(this.rawTree, cmd.nodeId)?.factoryPath ?? null
				: null;
			const v = validateCreateParameterCommand(cmd, factoryPath, this.scriptnodeList);
			if (!v.valid) return errorResult(v.errors.join("\n"));
		}

		// Translate to ops
		const opsResult = commandToDspOps(cmd, this.rawTree, this.currentPath);
		if ("error" in opsResult) return errorResult(opsResult.error);
		if (opsResult.ops.length === 0) return textResult("(no operations)");

		if (!session.connection) {
			return textResult(`(offline) would apply: ${JSON.stringify(opsResult.ops)}`);
		}
		const result = await this.executeOps(opsResult.ops, session.connection);
		if (result.type !== "error") {
			session.markProjectTreeDirty?.();
		}
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
		if (!response.success) {
			return errorResult(envelopeError(response, "DSP operation failed"));
		}

		let applyResult;
		try {
			applyResult = normalizeDspApplyResponse(response);
		} catch (e) {
			return errorResult(String(e));
		}

		// Re-fetch the tree to reflect mutations.
		await this.fetchTree(connection);
		if (applyResult.diff.length > 0 && this.treeRoot) {
			applyDiffToTree(this.treeRoot, applyResult.diff);
		}

		const summary = response.logs.length > 0
			? response.logs.join("; ")
			: applyResult.diff.map((d) => `${d.action} ${d.target}`).join(", ") || "OK";
		return textResult(summary);
	}

	// ── Completion ──────────────────────────────────────────────

	complete(input: string, _cursor: number): CompletionResult {
		const lastComma = findLastUnquotedComma(input);
		const segStart = lastComma + 1;
		const segment = input.slice(segStart);
		const offset = segStart + (segment.length - segment.trimStart().length);
		{
			const trimmedSegment = segment.trimStart();
			const earlyTokens = trimmedSegment.split(/\s+/);
			if (earlyTokens[0]?.toLowerCase() === "screenshot" && earlyTokens.length >= 2) {
				const keywords = ["at", "to"];
				const lastWord = earlyTokens[earlyTokens.length - 1]!.toLowerCase();
				const wordFrom = input.length - earlyTokens[earlyTokens.length - 1]!.length;
				const priorJoined = earlyTokens.slice(1, -1).join(" ").toLowerCase();
				const items = keywords
					.filter((k) => k.startsWith(lastWord) && !priorJoined.includes(k + " "))
					.map((k) => ({ label: k }));
				return { items, from: wordFrom, to: input.length };
			}
		}

		if (!this.completionEngine) return { items: [], from: 0, to: input.length };
		const trimmed = segment.trimStart();
		const inputLength = input.length;
		const tokens = trimmed.split(/\s+/);
		const first = tokens[0]?.toLowerCase() ?? "";

		// Word 0 — top-level keyword
		if (tokens.length <= 1) {
			const items = DSP_KEYWORDS.filter((k) => k.label.startsWith(first));
			return { items, from: offset, to: inputLength, label: "DSP commands" };
		}

		// show <what> — sub-keywords + node IDs from the live tree
		if (first === "show" && tokens.length === 2) {
			const prefix = tokens[1]!.toLowerCase();
			const kw = DSP_SHOW_SUBCOMMANDS.filter((k) => k.label.startsWith(prefix));
			const nodes = collectDspNodeIds(this.rawTree)
				.filter((n) => n.nodeId.toLowerCase().startsWith(prefix))
				.map((n) => ({ label: n.nodeId, detail: n.factoryPath }));
			return { items: [...kw, ...nodes], from: offset + tokens[0]!.length + 1, to: inputLength };
		}

		// add <factory>[.<node>] — delegate to scriptnode completion
		if (first === "add" && tokens.length === 2) {
			const res = this.completionEngine.completeScriptnode(tokens[1]!);
			const fromBase = offset + tokens[0]!.length + 1;
			return { items: res.items, from: fromBase + res.from, to: inputLength };
		}

		// set/get/remove/bypass/enable <nodeId>[.<param>[.<rangeField>]]
		if ((first === "set" || first === "get" || first === "remove"
				|| first === "bypass" || first === "enable") && tokens.length === 2) {
			const tail = tokens[1]!;
			const firstDot = tail.indexOf(".");
			if (firstDot !== -1) {
				const nodeId = tail.slice(0, firstDot);
				const afterFirst = tail.slice(firstDot + 1);
				const secondDot = afterFirst.indexOf(".");
				// Double-dot range field: `set X.param.<field>` — only meaningful for `set`.
				if (first === "set" && secondDot !== -1) {
					const fieldPrefix = afterFirst.slice(secondDot + 1).toLowerCase();
					const fields = ["min", "max", "step", "mid", "skew"]
						.filter((f) => f.startsWith(fieldPrefix))
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

		// set <node>.<param> <prefix-of-range-keyword>
		// Suggest `range` and `to` after the `.param` segment is fully typed.
		if (first === "set" && tokens.length === 3) {
			const word = tokens[2]!.toLowerCase();
			const candidates = ["range", "to"]
				.filter((k) => k.startsWith(word))
				.map((k) => ({ label: k }));
			if (candidates.length > 0) {
				const prevTokens = tokens.slice(0, 2).join(" ");
				return {
					items: candidates,
					from: offset + prevTokens.length + 1,
					to: inputLength,
				};
			}
		}

		// add <factory.id> [as <id>] [to <p>] — suggest `at` for index.
		// connect <src> to <tgt>[.<p>] — suggest `matched`.
		if ((first === "add" || first === "connect") && tokens.length >= 3) {
			const last = tokens[tokens.length - 1]!;
			const lastLower = last.toLowerCase();
			const trailing = first === "add" ? ["as", "to", "at"] : ["matched"];
			const candidates = trailing
				.filter((k) => k.startsWith(lastLower))
				.map((k) => ({ label: k }));
			if (candidates.length > 0) {
				const wordFrom = inputLength - last.length;
				return { items: candidates, from: wordFrom, to: inputLength };
			}
		}

		// get source of <node>.<param> | get parent of <node>.<param>
		if (first === "get" && tokens.length === 2
				&& (tokens[1] === "source" || tokens[1] === "parent")) {
			return {
				items: [{ label: "of", detail: "of <node>.<param>" }],
				from: offset + tokens[0]!.length + 1 + tokens[1]!.length + 1,
				to: inputLength,
			};
		}

		return { items: [], from: offset, to: inputLength };
	}

	// ── Help ────────────────────────────────────────────────────

	private handleHelp(): CommandResult {
		return textResult(DSP_HELP);
	}
}

// ── Internal helpers ────────────────────────────────────────────

function envelopeError(response: import("../hise.js").HiseResponse, fallback: string): string {
	if (isEnvelopeResponse(response) && response.errors.length > 0) {
		return response.errors.map((e) => e.errorMessage).join("\n");
	}
	return fallback;
}

// Map HISE's init failure envelopes to short, actionable CLI messages.
// HISE returns full absolute paths in errorMessage; we strip that and
// point the user at the sibling verb.
function mapInitError(
	response: import("../hise.js").HiseResponse,
	name: string,
	mode: "auto" | "load" | "create",
): string {
	const raw = envelopeError(response, "init failed");
	if (/already exists/i.test(raw)) {
		return `Network "${name}" already exists. Use \`load ${name}\` to open it, or pick a different name.`;
	}
	if (/no network xml found|not found/i.test(raw)) {
		return `Network "${name}" does not exist. Use \`create ${name}\` to make a new one, or \`show networks\` to list existing.`;
	}
	return `${mode === "auto" ? "init" : mode} failed: ${raw}`;
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
		// Render NodeColour-style values as 0xAARRGGBB hex when non-zero
		// and Integer, else decimal.
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

	// Header: factory  nodeId  parent: X  bypassed: yes/no
	lines.push(
		`${node.factoryPath}  ${node.nodeId}  parent: ${parentId}  bypassed: ${node.bypassed ? "yes" : "no"}`,
	);

	// Properties
	if (node.properties && node.properties.length > 0) {
		const idWidth = Math.max(...node.properties.map((p) => p.propertyId.length));
		for (const p of node.properties) {
			lines.push(`  ${pad(p.propertyId, idWidth)}  ${formatPropertyValue(p.value)}`);
		}
	}

	// Parameters
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

	// Modulation (incoming and outgoing)
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
	{ label: "show", detail: "show networks | modules | tree | connections | <nodeId>" },
	{ label: "use", detail: "Switch host moduleId" },
	{ label: "load", detail: "Load an existing DspNetwork (errors if missing)" },
	{ label: "create", detail: "Create a new DspNetwork (errors if exists)" },
	{ label: "init", detail: "Load-or-create a DspNetwork" },
	{ label: "save", detail: "Save the network to its .xml file" },
	{ label: "reset", detail: "Empty the loaded network" },
	{ label: "add", detail: "Add a node (factory.nodeId)" },
	{ label: "remove", detail: "Remove a node" },
	{ label: "move", detail: "Move a node" },
	{ label: "connect", detail: "Connect modulation source to target param" },
	{ label: "disconnect", detail: "Disconnect modulation" },
	{ label: "set", detail: "Set a parameter value" },
	{ label: "get", detail: "Get a node or parameter" },
	{ label: "bypass", detail: "Bypass a node" },
	{ label: "enable", detail: "Enable a bypassed node" },
	{ label: "create_parameter", detail: "Create a dynamic parameter on a container" },
	{ label: "screenshot", detail: "Render DspNetwork graph to PNG" },
	{ label: "cd", detail: "Navigate into a container" },
	{ label: "ls", detail: "List children at current path" },
	{ label: "pwd", detail: "Print current path" },
	{ label: "help", detail: "Show DSP mode commands" },
];

const DSP_SHOW_SUBCOMMANDS = [
	{ label: "networks", detail: "List available DspNetwork xml files" },
	{ label: "modules", detail: "List DspNetwork-capable script processors" },
	{ label: "tree", detail: "Show current network hierarchy" },
	{ label: "connections", detail: "List modulation edges in the network" },
];

const DSP_HELP = [
	"DSP mode — scriptnode graph editor",
	"",
	"Context: one moduleId per mode entry. Use /dsp.<moduleId> to enter with",
	"a module pre-selected, or `use <moduleId>` once inside.",
	"",
	"Commands:",
	"  show networks | modules | tree | connections",
	"  show <nodeId>                 header + properties + parameters + modulation",
	"  use <moduleId>",
	"  load <name>                   load an existing network (errors if missing)",
	"  create <name>                 create a new network (errors if exists)",
	"  init <name>                   load-or-create (catch-all)",
	"  save                          save the loaded network's .xml file",
	"  reset                         empty the loaded network",
	"  add <factory.node> [as <id>] [to <parent>] [at <index>]",
	"  remove <nodeId>",
	"  move <nodeId> to <parent> [at <index>]",
	"  connect <src>[.<out>] to <target>[.<param>] [matched]",
	"                                matched/normalize: copy target range onto source",
	"  disconnect <src> from <target>.<param>",
	"  set <node>.<param> [to] <value>                              value-write",
	"  set <node>.<param> range <min> <max> [step <s>] [mid <m>|skew <s>]",
	"                                                                full range-write",
	"  set <node>.<param>.<min|max|step|mid|skew> <number>           single field",
	"  set <root>.<NetworkProp> <value>                              network root props",
	"                                AllowCompilation, AllowPolyphonic, HasTail,",
	"                                SuspendOnSilence, CompileChannelAmount,",
	"                                ModulationBlockSize",
	"  get <nodeId>                 -> factory path",
	"  get <node>.<param>           -> current value",
	"  get source of <node>.<param> -> connected source",
	"  get parent of <node>.<param> -> parent container id",
	"  bypass <nodeId> | enable <nodeId>",
	"  create_parameter <container>.<name> [<min> <max>] [default <d>] [step <s>] [mid <m>|skew <s>]",
	"  screenshot [at <scale>] [to <path>]  render DspNetwork graph to PNG",
	"  cd / ls / pwd                navigate the graph",
	"",
	"Field aliases: stepSize|interval == step, middlePosition == mid, skewFactor == skew",
].join("\n");

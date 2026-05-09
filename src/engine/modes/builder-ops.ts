// ── Builder command → HISE API operations mapping ────────────────────

import type { TreeNode } from "../result.js";
import type { ModuleList } from "../data.js";
import type { CompletionItem } from "./mode.js";
import type {
	AddCommand,
	AddChainCommand,
	BuilderCommand,
	CloneCommand,
	RemoveCommand,
	RenameCommand,
	SetClause,
} from "./builder-parser.js";
import { resolveModuleTypeId } from "./builder-validate.js";
import { findNodeById, resolveNodeByPath } from "../tree-utils.js";
import { resolvePath } from "../grammar/path-resolver.js";
import {
	pathRefSegments,
	pathRefToString,
	type PathRef,
} from "../grammar/path-parser.js";
import {
	coerceBoolean,
	coerceFloat,
	coerceString,
} from "../grammar/coercion.js";
import type { Value } from "../grammar/value-parser.js";
import { fgHex, RESET as ANSI_RESET } from "../ansi.js";

// ── Operation types ───────────────────────────────────────────────

export interface BuilderOp {
	op: string;
	[key: string]: unknown;
}

export interface ModuleInstance {
	id: string;
	type: string;
}

const ROUTING_PRESETS = new Set(["stereo", "stereo_2", "stereo_3", "all", "all_to_stereo"]);
const READONLY_ROUTING_SUBFIELDS = new Set(["resizable", "routable", "numdestinationchannels"]);

// ── Chain index resolution ────────────────────────────────────────

/**
 * Resolve a chain name to the integer index expected by the HISE API.
 * -1 = direct children, 0 = midi, 1+ = modulation chains, 3 = fx (for top-level).
 */
export function resolveChainIndex(
	chainName: string | undefined,
	moduleType: string | undefined,
	parentNode: TreeNode | null,
	moduleList: ModuleList | null,
): number {
	if (!chainName) {
		if (!moduleType || !moduleList) return -1;
		const mod = moduleList.modules.find((m) => m.id === moduleType);
		if (!mod) return -1;
		switch (mod.type) {
			case "Effect": return 3;
			case "MidiProcessor": return 0;
			default: return -1;
		}
	}

	const lower = chainName.toLowerCase().replace(/\s+/g, "");
	if (lower === "children" || lower === "direct") return -1;
	if (lower === "midi" || lower === "midiprocessorchain") return 0;
	if (lower === "fx" || lower === "fxchain") return 3;

	const parentDef = parentNode?.type && moduleList
		? moduleList.modules.find((m) => m.id === parentNode.type)
		: null;
	if (parentDef) {
		for (const mod of parentDef.modulation) {
			const modName = mod.id.toLowerCase().replace(/\s+/g, "");
			const modShort = modName.replace(/modulation$/, "");
			const modMode = mod.modulationMode?.toLowerCase();
			if (modName === lower || modShort === lower || modMode === lower) return mod.chainIndex;
		}
	}

	const num = parseInt(chainName, 10);
	if (!isNaN(num)) return num;

	return -1;
}

// ── Path resolution helpers ───────────────────────────────────────

/** Resolve a PathRef to an instance id (the leaf node's id) plus the
 *  node when available. With no tree (offline), falls back to the
 *  literal segment image so command echo still works. */
function resolveRefToTarget(
	treeRoot: TreeNode | null,
	currentPath: string[],
	ref: PathRef,
	mode: "lookup" | "cd",
): { id: string; node: TreeNode | null } | { error: string } {
	if (!treeRoot) {
		const segs = pathRefSegments(ref);
		if (segs.length === 0) return { error: "cannot resolve `..` without tree" };
		return { id: segs[segs.length - 1].id, node: null };
	}
	const r = resolvePath(treeRoot, currentPath, ref, mode);
	if (!r.ok) return { error: r.message };
	const id = r.node.id ?? r.fullPath[r.fullPath.length - 1];
	return { id, node: r.node };
}

function findParentNode(tree: TreeNode | null, childId: string): TreeNode | null {
	if (!tree) return null;
	const lower = childId.toLowerCase();
	if (tree.children) {
		for (const child of tree.children) {
			if (child.id?.toLowerCase() === lower) return tree;
			const found = findParentNode(child, childId);
			if (found) return found;
		}
	}
	return null;
}

/** Resolve add's parent + chain. Handles bare cwd, explicit `to`, and
 *  the case where `to` lands on a chain (split into parent + chainName). */
function resolveAddParent(
	cmd: AddCommand | { parent?: PathRef },
	treeRoot: TreeNode | null,
	currentPath: string[],
	moduleList: ModuleList | null,
	moduleTypeId: string,
): { parent: string; chainName: string | undefined } | { error: string } {
	let parent: string;
	let chainName: string | undefined;

	if (cmd.parent) {
		const r = resolveRefToTarget(treeRoot, currentPath, cmd.parent, "lookup");
		if ("error" in r) return { error: r.error };
		if (r.node?.nodeKind === "chain") {
			chainName = r.node.label;
			const actual = findParentNode(treeRoot, r.id);
			parent = actual?.id ?? treeRoot?.id ?? "Master Chain";
		} else {
			parent = r.id;
		}
	} else if (currentPath.length > 0) {
		const contextNode = resolveNodeByPath(treeRoot, currentPath);
		if (contextNode?.nodeKind === "chain") {
			const ownerNode = currentPath.length > 1
				? resolveNodeByPath(treeRoot, currentPath.slice(0, -1))
				: treeRoot;
			parent = ownerNode?.id ?? treeRoot?.id ?? "Master Chain";
			chainName = contextNode.label;
		} else {
			parent = contextNode?.id ?? currentPath[currentPath.length - 1];
		}
	} else {
		parent = treeRoot?.id ?? "Master Chain";
	}

	const _resolvedParentNode = findNodeById(treeRoot, parent);
	void _resolvedParentNode;
	void moduleList;
	void moduleTypeId;
	return { parent, chainName };
}

// ── Command → ops conversion ──────────────────────────────────────

/**
 * Convert a parsed BuilderCommand into HISE API operation(s).
 *
 * Most commands map to /api/builder/apply ops (`op: "add"`, `"remove"`, …).
 * The `network` set-clause maps to /api/dsp/init via the synthetic
 * `init_network` op which the dispatcher routes separately.
 */
export function commandToOps(
	cmd: BuilderCommand,
	treeRoot: TreeNode | null,
	moduleList: ModuleList | null,
	currentPath: string[],
): { ops: BuilderOp[] } | { error: string } {
	switch (cmd.type) {
		case "add":
			return translateAdd(cmd, treeRoot, moduleList, currentPath);
		case "addChain":
			return translateAddChain(cmd, treeRoot, moduleList, currentPath);
		case "remove":
			return translateRemove(cmd, treeRoot, currentPath);
		case "rename":
			return translateRename(cmd, treeRoot, currentPath);
		case "clone":
			return translateClone(cmd, treeRoot, currentPath);
		case "set":
			return translateSet(cmd.clauses, treeRoot, moduleList, currentPath);
		case "get":
		case "show":
		case "cd":
		case "ls":
		case "pwd":
		case "reset":
			return { error: "handled locally" };
	}
}

function translateAdd(
	cmd: AddCommand,
	treeRoot: TreeNode | null,
	moduleList: ModuleList | null,
	currentPath: string[],
): { ops: BuilderOp[] } | { error: string } {
	const typeId = resolveModuleTypeId(cmd.moduleType, moduleList) ?? cmd.moduleType;
	const r = resolveAddParent(cmd, treeRoot, currentPath, moduleList, typeId);
	if ("error" in r) return { error: r.error };
	const parentNode = findNodeById(treeRoot, r.parent);
	const chainIndex = resolveChainIndex(r.chainName, typeId, parentNode, moduleList);
	return {
		ops: [{
			op: "add",
			type: typeId,
			parent: r.parent,
			chain: chainIndex,
			name: cmd.alias,
		}],
	};
}

function translateAddChain(
	cmd: AddChainCommand,
	treeRoot: TreeNode | null,
	moduleList: ModuleList | null,
	currentPath: string[],
): { ops: BuilderOp[] } | { error: string } {
	const ops: BuilderOp[] = [];
	for (const cl of cmd.clauses) {
		const typeId = resolveModuleTypeId(cl.moduleType, moduleList) ?? cl.moduleType;
		const r = resolveAddParent({ parent: undefined }, treeRoot, currentPath, moduleList, typeId);
		if ("error" in r) return { error: r.error };
		const parentNode = findNodeById(treeRoot, r.parent);
		const chainIndex = resolveChainIndex(r.chainName, typeId, parentNode, moduleList);
		ops.push({
			op: "add",
			type: typeId,
			parent: r.parent,
			chain: chainIndex,
			name: cl.alias,
		});
	}
	return { ops };
}

function translateRemove(
	cmd: RemoveCommand,
	treeRoot: TreeNode | null,
	currentPath: string[],
): { ops: BuilderOp[] } | { error: string } {
	const ops: BuilderOp[] = [];
	for (const ref of cmd.targets) {
		const r = resolveRefToTarget(treeRoot, currentPath, ref, "lookup");
		if ("error" in r) return { error: r.error };
		ops.push({ op: "remove", target: r.id });
	}
	return { ops };
}

function translateRename(
	cmd: RenameCommand,
	treeRoot: TreeNode | null,
	currentPath: string[],
): { ops: BuilderOp[] } | { error: string } {
	const r = resolveRefToTarget(treeRoot, currentPath, cmd.target, "lookup");
	if ("error" in r) return { error: r.error };
	return { ops: [{ op: "set_id", target: r.id, name: cmd.name }] };
}

function translateClone(
	cmd: CloneCommand,
	treeRoot: TreeNode | null,
	currentPath: string[],
): { ops: BuilderOp[] } | { error: string } {
	const r = resolveRefToTarget(treeRoot, currentPath, cmd.target, "lookup");
	if ("error" in r) return { error: r.error };
	return { ops: [{ op: "clone", source: r.id, count: cmd.count }] };
}

// ── Set clause translation ────────────────────────────────────────

function translateSet(
	clauses: SetClause[],
	treeRoot: TreeNode | null,
	moduleList: ModuleList | null,
	currentPath: string[],
): { ops: BuilderOp[] } | { error: string } {
	const ops: BuilderOp[] = [];
	for (const clause of clauses) {
		const r = translateSetClause(clause, treeRoot, moduleList, currentPath);
		if ("error" in r) return r;
		ops.push(...r.ops);
	}
	return { ops };
}

function translateSetClause(
	clause: SetClause,
	treeRoot: TreeNode | null,
	moduleList: ModuleList | null,
	currentPath: string[],
): { ops: BuilderOp[] } | { error: string } {
	const segs = pathRefSegments(clause.path);
	if (segs.length < 2) {
		return { error: "set: path must have at least 2 segments" };
	}

	const tail = segs[segs.length - 1].id.toLowerCase();
	const prevTail = segs.length >= 3 ? segs[segs.length - 2].id.toLowerCase() : null;

	// routing.<sub> — sub-field. Detect before stripping tail.
	if (prevTail === "routing") {
		if (tail === "send") {
			const targetRef = makeRefFromSegments(clause.path, segs.length - 2);
			const r = resolveRefToTarget(treeRoot, currentPath, targetRef, "lookup");
			if ("error" in r) return r;
			const arr = expectIntArray(clause.value);
			if ("error" in arr) return arr;
			return { ops: [{ op: "set_routing", target: r.id, send: arr.values }] };
		}
		if (READONLY_ROUTING_SUBFIELDS.has(tail)) {
			return { error: `routing.${tail} is read-only` };
		}
		return { error: `unknown routing sub-field: routing.${tail}` };
	}

	// All other writes: path[0..n-1] is the target, path[n-1] is the field.
	const targetRef = makeRefFromSegments(clause.path, segs.length - 1);
	const target = resolveRefToTarget(treeRoot, currentPath, targetRef, "lookup");
	if ("error" in target) return target;
	const fieldName = segs[segs.length - 1].id;

	switch (tail) {
		case "bypassed": {
			const b = coerceBoolean(clause.value);
			if (!b.ok) return { error: b.error };
			return { ops: [{ op: "set_bypassed", target: target.id, bypassed: b.out }] };
		}
		case "parent": {
			let parentRef: PathRef | undefined;
			if (clause.value.kind === "path") {
				parentRef = clause.value.ref;
			} else if (clause.value.kind === "string") {
				const segs = clause.value.s.split(".").filter((s) => s.length > 0);
				if (segs.length === 0) return { error: "set parent: empty path" };
				parentRef = segs.length === 1
					? { kind: "bare", segment: { id: segs[0]!, quoted: false } }
					: { kind: "dotted", segments: segs.map((id) => ({ id, quoted: false })) };
			} else {
				return { error: "set parent: value must be a path or string" };
			}
			const r = resolveAddParent({ parent: parentRef }, treeRoot, currentPath, moduleList, "");
			if ("error" in r) return { error: r.error };
			const parentNode = findNodeById(treeRoot, r.parent);
			const chainIndex = resolveChainIndex(r.chainName, target.node?.type, parentNode, moduleList);
			return { ops: [{ op: "move", target: target.id, parent: r.parent, chain: chainIndex }] };
		}
		case "index": {
			const n = coerceFloat(clause.value);
			if (!n.ok) return { error: n.error };
			if (!Number.isInteger(n.out)) return { error: `set index: expected integer, got ${n.out}` };
			return { ops: [{ op: "move", target: target.id, index: n.out }] };
		}
		case "samplemap": {
			const s = coerceString(clause.value);
			if (!s.ok) return { error: s.error };
			return { ops: [{ op: "set_attributes", target: target.id, attributes: { samplemap: s.out } }] };
		}
		case "effect": {
			const s = coerceString(clause.value);
			if (!s.ok) return { error: s.error };
			return { ops: [{ op: "set_effect", target: target.id, effect: s.out }] };
		}
		case "network": {
			const s = coerceString(clause.value);
			if (!s.ok) return { error: s.error };
			const raw = s.out;
			let mode: "create" | "load";
			let name: string;
			if (raw.toLowerCase().endsWith(".xml")) {
				mode = "load";
				name = raw.slice(0, -".xml".length);
			} else {
				mode = "create";
				name = raw;
			}
			return { ops: [{ op: "init_network", moduleId: target.id, name, mode }] };
		}
		case "routing": {
			if (clause.value.kind === "string") {
				const preset = clause.value.s;
				if (!ROUTING_PRESETS.has(preset.toLowerCase())) {
					return { error: `unknown routing preset "${preset}"; expected one of ${[...ROUTING_PRESETS].join(", ")}` };
				}
				return { ops: [{ op: "set_routing", target: target.id, preset }] };
			}
			const arr = expectIntArray(clause.value);
			if ("error" in arr) return arr;
			return { ops: [{ op: "set_routing", target: target.id, matrix: arr.values }] };
		}
		default: {
			const f = coerceFloat(clause.value);
			if (!f.ok) {
				const s = coerceString(clause.value);
				if (s.ok) {
					return { ops: [{ op: "set_attributes", target: target.id, attributes: { [fieldName]: s.out } }] };
				}
				return { error: f.error };
			}
			return { ops: [{ op: "set_attributes", target: target.id, attributes: { [fieldName]: f.out } }] };
		}
	}
}

function makeRefFromSegments(original: PathRef, count: number): PathRef {
	const segs = pathRefSegments(original);
	if (count <= 0) {
		return { kind: "parent" };
	}
	if (count === 1) {
		return { kind: "bare", segment: segs[0] };
	}
	return { kind: "dotted", segments: segs.slice(0, count) };
}

function expectIntArray(value: Value): { values: number[] } | { error: string } {
	if (value.kind !== "array2" && value.kind !== "array4" && value.kind !== "arrayN") {
		return { error: `expected numeric array; got ${value.kind}` };
	}
	const nums = value.n as readonly number[];
	const out: number[] = [];
	for (const n of nums) {
		if (!Number.isInteger(n)) {
			return { error: `routing array values must be integers (got ${n})` };
		}
		out.push(n);
	}
	return { values: out };
}

// Helper exported for echo/display logic in builder.ts.
export function pathRefDisplay(ref: PathRef): string {
	return pathRefToString(ref);
}

// ── Tree collection utilities ─────────────────────────────────────

export function collectModuleIds(tree: TreeNode | null): ModuleInstance[] {
	if (!tree) return [];
	const result: ModuleInstance[] = [];
	walkModules(tree, result);
	return result;
}

function walkModules(node: TreeNode, out: ModuleInstance[]): void {
	if (node.nodeKind === "module" && node.id && node.type) {
		out.push({ id: node.id, type: node.type });
	}
	if (node.children) {
		for (const child of node.children) {
			walkModules(child, out);
		}
	}
}

export function moduleIdCompletionItems(modules: ModuleInstance[]): CompletionItem[] {
	return modules.map((m) => ({
		label: m.id,
		detail: m.type,
		insertText: m.id.includes(" ") ? `"${m.id}"` : m.id,
	}));
}

export function resolveInstanceType(
	instanceName: string,
	modules: ModuleInstance[],
): string | undefined {
	return modules.find((m) => m.id === instanceName)?.type;
}

// ── Tree display utilities ────────────────────────────────────────

export function compactTree(node: TreeNode, remainingPath: string[]): TreeNode {
	if (!node.children) return node;

	const newChildren: TreeNode[] = [];
	const nextSeg = remainingPath.length > 0 ? remainingPath[0].toLowerCase() : null;

	for (const child of node.children) {
		const childId = (child.id ?? child.label).toLowerCase();
		const isOnPath = nextSeg !== null && childId === nextSeg;

		if (child.nodeKind === "chain" && !isOnPath) {
			if (child.children) {
				for (const grandchild of child.children) {
					newChildren.push(compactTree(grandchild, []));
				}
			}
		} else {
			const childPath = isOnPath ? remainingPath.slice(1) : [];
			newChildren.push(compactTree(child, childPath));
		}
	}

	return { ...node, children: newChildren.length > 0 ? newChildren : undefined };
}

function formatTreeNodeLabel(node: TreeNode, compact: boolean): string {
	if (node.nodeKind === "chain") {
		return node.label;
	}
	if (compact) {
		return node.label || node.type || "";
	}
	if (node.type && node.label && node.type !== node.label) {
		return `${node.type} "${node.label}"`;
	}
	return node.type ?? node.label;
}

const DEFAULT_SIGNAL_HEX = "#90FFB1";
const DEFAULT_MUTED_HEX = "#888888";

const DIFF_CHARS = {
	added: { char: "+", hex: "#4E8E35" },
	removed: { char: "-", hex: "#BB3434" },
	modified: { char: "*", hex: "#E0A93B" },
} as const;

const fgAnsi = fgHex;

export interface RenderTreeBoxOptions {
	pwdNode?: TreeNode | null;
	signalColor?: string;
	mutedColor?: string;
	maxDepth?: number;
	compact?: boolean;
}

interface RenderCtx {
	pwdNode?: TreeNode | null;
	signalAnsi: string;
	mutedAnsi: string;
	maxDepth?: number;
	compact: boolean;
}

export function renderTreeBox(node: TreeNode, options: RenderTreeBoxOptions = {}): string {
	const ctx: RenderCtx = {
		pwdNode: options.pwdNode,
		signalAnsi: fgAnsi(options.signalColor ?? DEFAULT_SIGNAL_HEX),
		mutedAnsi: fgAnsi(options.mutedColor ?? DEFAULT_MUTED_HEX),
		maxDepth: options.maxDepth,
		compact: options.compact ?? false,
	};
	const lines: string[] = [formatTreeRow(node, "", "", ctx)];
	if (ctx.maxDepth === undefined || ctx.maxDepth >= 1) {
		const children = node.children ?? [];
		for (let i = 0; i < children.length; i++) {
			renderTreeBoxRec(children[i]!, "", i === children.length - 1, lines, ctx, 1);
		}
	}
	return lines.join("\n");
}

function formatTreeRow(node: TreeNode, prefix: string, connector: string, ctx: RenderCtx): string {
	let diffPrefix = "";
	if (node.diff && DIFF_CHARS[node.diff]) {
		const d = DIFF_CHARS[node.diff];
		diffPrefix = fgAnsi(d.hex) + d.char + ANSI_RESET + " ";
	}

	const treeAnsi = ctx.mutedAnsi;
	let line = diffPrefix + (treeAnsi ? treeAnsi + prefix + connector + ANSI_RESET : prefix + connector);

	if (node.colour != null && node.filledDot != null) {
		const dot = node.filledDot ? "● " : "○ ";
		const dotAnsi = node.dimmed ? ctx.mutedAnsi : fgAnsi(node.colour);
		line += dotAnsi + dot + ANSI_RESET;
	}

	const label = formatTreeNodeLabel(node, ctx.compact);
	const isPwd = ctx.pwdNode != null && node === ctx.pwdNode;
	let labelAnsi = "";
	if (isPwd) labelAnsi = ctx.signalAnsi;
	else if (node.dimmed) labelAnsi = ctx.mutedAnsi;
	line += labelAnsi + label + (labelAnsi ? ANSI_RESET : "");

	if (node.badge) {
		const badgeAnsi = fgAnsi(node.badge.colour);
		line += " " + badgeAnsi + node.badge.text + ANSI_RESET;
	}

	return line;
}

function renderTreeBoxRec(node: TreeNode, prefix: string, isLast: boolean, out: string[], ctx: RenderCtx, depth: number): void {
	const connector = isLast ? "└── " : "├── ";
	out.push(formatTreeRow(node, prefix, connector, ctx));
	if (ctx.maxDepth !== undefined && depth >= ctx.maxDepth) return;
	const children = node.children ?? [];
	const childPrefix = prefix + (isLast ? "    " : "│   ");
	for (let i = 0; i < children.length; i++) {
		renderTreeBoxRec(children[i]!, childPrefix, i === children.length - 1, out, ctx, depth + 1);
	}
}

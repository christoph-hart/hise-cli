// ── Builder command → HISE API operations mapping ────────────────────

import type { TreeNode } from "../result.js";
import type { ModuleList } from "../data.js";
import type { CompletionItem } from "./mode.js";
import type { BuilderCommand } from "./builder-parser.js";
import { resolveModuleTypeId } from "./builder-validate.js";
import { findNodeById, resolveNodeByPath } from "../tree-utils.js";
import { fgHex, RESET as ANSI_RESET } from "../ansi.js";

// ── Operation types ───────────────────────────────────────────────

export interface BuilderOp {
	op: string;
	[key: string]: unknown;
}

export interface ModuleInstance {
	id: string;    // processorId (instance name, e.g. "Osc 1")
	type: string;  // module type ID (e.g. "SineSynth")
}

// ── Chain index resolution ────────────────────────────────────────

/**
 * Resolve a chain name to the integer index expected by the HISE API.
 * -1 = direct children, 0 = midi, 1+ = modulation chains, 3 = fx (for top-level).
 * Named modulation chains are resolved from the parent's tree node.
 */
export function resolveChainIndex(
	chainName: string | undefined,
	moduleType: string | undefined,
	parentNode: TreeNode | null,
	moduleList: ModuleList | null,
): number {
	if (!chainName) {
		// No chain specified: auto-resolve by module type
		if (!moduleType || !moduleList) return -1;
		const mod = moduleList.modules.find((m) => m.id === moduleType);
		if (!mod) return -1;
		// SoundGenerators go to children, Effects to fx, MidiProcessors to midi,
		// Modulators need explicit chain
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

	// Look up modulation chains from the parent module's definition.
	// Source of truth: ModuleDefinition.modulation[] carries the real chainIndex,
	// which is non-sequential for parents like WaveSynth (Mix=4, Osc2 Pitch=5).
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

	// Last resort: try parsing as a number
	const num = parseInt(chainName, 10);
	if (!isNaN(num)) return num;

	// Default to direct children
	return -1;
}

// ── Parent/tree helpers ───────────────────────────────────────────

/**
 * Resolve the parent node for a path — the second-to-last node.
 * For path ["SineSynth", "FX Chain"], returns the SineSynth node.
 */
function resolveParentByPath(tree: TreeNode | null, path: string[]): TreeNode | null {
	if (!tree || path.length <= 1) return tree;
	return resolveNodeByPath(tree, path.slice(0, -1));
}

/** Find the parent tree node of a node by its id (case-insensitive). */
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

// ── Command → ops conversion ──────────────────────────────────────

/**
 * Convert a parsed BuilderCommand into HISE API operation(s).
 * Returns an array of ops (most commands produce exactly one).
 */
export function commandToOps(
	cmd: BuilderCommand,
	treeRoot: TreeNode | null,
	moduleList: ModuleList | null,
	currentPath: string[],
): { ops: BuilderOp[] } | { error: string } {
	switch (cmd.type) {
		case "add": {
			let parent: string;
			let explicitChain = cmd.chain;

			if (cmd.parent) {
				// Explicit parent given — use it directly
				parent = cmd.parent;
			} else if (currentPath.length > 0) {
				// Resolve from current path context using path-aware lookup
				const contextNode = resolveNodeByPath(treeRoot, currentPath);
				if (contextNode?.nodeKind === "chain") {
					// cd'd into a chain — parent is the module owning this chain
					const ownerNode = resolveParentByPath(treeRoot, currentPath);
					parent = ownerNode?.id ?? treeRoot?.id ?? "Master Chain";
					explicitChain = explicitChain ?? contextNode.label;
				} else {
					// cd'd into a module — use it as parent
					parent = contextNode?.id ?? currentPath[currentPath.length - 1];
				}
			} else {
				parent = treeRoot?.id ?? "Master Chain";
			}

			// If explicit parent (from `add X to Y.chain`) resolves to a chain, fix it up
			if (cmd.parent) {
				const parentNode = findNodeById(treeRoot, parent);
				if (parentNode?.nodeKind === "chain") {
					const actualParent = findParentNode(treeRoot, parent);
					if (actualParent) {
						explicitChain = explicitChain ?? parentNode.label;
						parent = actualParent.id ?? actualParent.label;
					}
				}
			}

			const resolvedParentNode = findNodeById(treeRoot, parent);
			// Resolve pretty name → type ID for the API, keep pretty name for default instance name
			const typeId = resolveModuleTypeId(cmd.moduleType, moduleList) ?? cmd.moduleType;
			const chainIndex = resolveChainIndex(explicitChain, typeId, resolvedParentNode, moduleList);
			const op: BuilderOp = {
				op: "add",
				type: typeId,
				parent,
				chain: chainIndex,
				name: cmd.alias ?? cmd.moduleType,
			};
			return { ops: [op] };
		}
		case "remove":
			return { ops: [{ op: "remove", target: cmd.target }] };
		case "clone":
			return { ops: [{ op: "clone", source: cmd.source, count: cmd.count }] };
		case "set":
			return { ops: [{ op: "set_attributes", target: cmd.target, attributes: { [cmd.param]: cmd.value } }] };
		case "rename":
			return { ops: [{ op: "set_id", target: cmd.target, name: cmd.name }] };
		case "bypass":
			return { ops: [{ op: "set_bypassed", target: cmd.target, bypassed: true }] };
		case "enable":
			return { ops: [{ op: "set_bypassed", target: cmd.target, bypassed: false }] };
		case "load":
			return { ops: [{ op: "set_effect", target: cmd.target, effect: cmd.source }] };
		case "move":
			return { error: "move is not yet supported by the HISE C++ API" };
		case "get":
			return { error: "get commands are handled locally" };
		case "show":
			return { error: "show commands are handled locally" };
	}
}

// ── Tree collection utilities ─────────────────────────────────────

/** Walk a TreeNode tree and collect all module instances with their types. */
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

/** Build CompletionItems from module instances. Auto-quotes IDs with spaces. */
export function moduleIdCompletionItems(modules: ModuleInstance[]): CompletionItem[] {
	return modules.map((m) => ({
		label: m.id,
		detail: m.type,
		insertText: m.id.includes(" ") ? `"${m.id}"` : m.id,
	}));
}

/** Resolve an instance name to its module type using the tree. */
export function resolveInstanceType(
	instanceName: string,
	modules: ModuleInstance[],
): string | undefined {
	return modules.find((m) => m.id === instanceName)?.type;
}

// ── Tree display utilities ────────────────────────────────────────

/**
 * Strip chain nodes from the tree, promoting their module children up.
 * Chains that are part of the currentPath are preserved so the sidebar
 * can still show where the user has navigated.
 */
export function compactTree(node: TreeNode, remainingPath: string[]): TreeNode {
	if (!node.children) return node;

	const newChildren: TreeNode[] = [];
	// The next segment of the path that needs to be matched at this level
	const nextSeg = remainingPath.length > 0 ? remainingPath[0].toLowerCase() : null;

	for (const child of node.children) {
		const childId = (child.id ?? child.label).toLowerCase();
		const isOnPath = nextSeg !== null && childId === nextSeg;

		if (child.nodeKind === "chain" && !isOnPath) {
			// Not on the active path — promote chain's module children up
			if (child.children) {
				for (const grandchild of child.children) {
					newChildren.push(compactTree(grandchild, []));
				}
			}
		} else {
			// Keep the node: either a module, or the specific chain on the active path
			const childPath = isOnPath ? remainingPath.slice(1) : [];
			newChildren.push(compactTree(child, childPath));
		}
	}

	return { ...node, children: newChildren.length > 0 ? newChildren : undefined };
}

/**
 * Format a single TreeNode label for the box-drawing tree renderer.
 *
 * - Chain: bare label (e.g. "GainModulation").
 * - Module with distinct type + label: `Type "Label"` (e.g. `SynthChain "Master Chain"`).
 * - Otherwise: type or label, whichever is set.
 */
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
	added: { char: "+", hex: "#4E8E35" },     // green
	removed: { char: "-", hex: "#BB3434" },   // red
	modified: { char: "*", hex: "#E0A93B" },  // amber
} as const;

const fgAnsi = fgHex;

export interface RenderTreeBoxOptions {
	/** Node to highlight as PWD. Compared by reference identity, so callers
	 *  must pass a node from the same tree object that's being rendered. */
	pwdNode?: TreeNode | null;
	/** Hex colour for the PWD node label. Default: brand signal. */
	signalColor?: string;
	/** Hex colour for dimmed nodes (and bypassed/invisible labels). Default: muted grey. */
	mutedColor?: string;
	/** Cap on recursion depth. Root is depth 0. When set, descendants
	 *  beyond `maxDepth` are not rendered. */
	maxDepth?: number;
	/** Compact label format: drop the `Type "Label"` form, render just label. */
	compact?: boolean;
}

interface RenderCtx {
	pwdNode?: TreeNode | null;
	signalAnsi: string;
	mutedAnsi: string;
	maxDepth?: number;
	compact: boolean;
}

/**
 * Render a TreeNode as a Unicode box-drawing tree with ANSI colour annotations.
 * Used by `show tree` commands across builder/ui/dsp modes.
 *
 * Honours TreeNode flags from the data pipeline:
 * - `colour` + `filledDot` → coloured `●` / `○` prefix.
 * - `dimmed` → label rendered in muted colour.
 * - `badge` → suffix (e.g. `★` for saveInPreset) in badge colour.
 * - PWD match (via `pwdId`) overrides label colour with signal colour.
 */
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
	// Diff indicator (added/removed/modified) — leftmost column, before connector.
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

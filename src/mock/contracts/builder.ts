// Builder contract - normalizes raw HISE builder tree and diff responses.
//
// Raw tree shape from GET /api/builder/tree uses split arrays (children[],
// midi[], fx[]) and inline modulation[] chains. This normalizer converts
// to the unified TreeNode display format used by the sidebar.
//
// Diff responses from POST /api/builder/apply track changes scoped to
// the current undo group: "+" added, "-" removed, "*" modified.

import type { TreeNode } from "../../engine/result.js";
import { toBool } from "./coerce.js";

// ── Raw HISE tree types (from GET /api/builder/tree) ────────────────

export interface RawModulationChain {
	chainIndex: number;
	id: string;
	parameterIndex?: number;
	disabled: boolean;
	constrainer: string;
	modulationMode: string;
	colour: string;
	children?: RawTreeNode[];
	description?: string;
	metadataType?: string;
}

export interface RawTreeNode {
	id: string;
	processorId: string;
	prettyName: string;
	type: string;
	subtype: string;
	category: string[];
	hasChildren: boolean;
	hasFX: boolean;
	constrainer?: string;
	fx_constrainer?: string;
	child_fx_constrainer?: string;
	modulation: RawModulationChain[];
	bypassed: boolean;
	colour: string;
	parameters: unknown[];
	// Split child arrays
	children?: RawTreeNode[];
	midi?: RawTreeNode[];
	fx?: RawTreeNode[];
	// Metadata (not needed for display, preserved for validation)
	builderPath?: string;
	description?: string;
	metadataType?: string;
	interfaces?: string[];
}

// ── Diff types (shared across builder apply and undo diff responses) ─

/** A single diff entry from HISE — used by both builder and undo APIs. */
export interface DiffEntry {
	domain: string;
	action: "+" | "-" | "*";
	target: string;
}

/** @deprecated Use DiffEntry — kept as alias for backwards compatibility. */
export type BuilderDiffEntry = DiffEntry;

export interface BuilderApplyResult {
	scope: string;
	groupName: string;
	diff: BuilderDiffEntry[];
}

// ── Tree normalizer ─────────────────────────────────────────────────

/** Convert a raw HISE tree node into the TreeNode display format. */
export function normalizeBuilderTree(raw: RawTreeNode): TreeNode {
	return normalizeModule(raw);
}

function normalizeModule(raw: RawTreeNode): TreeNode {
	const children: TreeNode[] = [];

	// MIDI chain
	if (raw.midi && raw.midi.length > 0) {
		children.push(normalizeChain(
			"MIDI Processor Chain",
			"MidiProcessor",
			raw.midi.map(normalizeModule),
		));
	}

	// Modulation chains
	for (const mod of raw.modulation) {
		children.push(normalizeModulationChain(mod));
	}

	// FX chain
	if (raw.fx && raw.fx.length > 0) {
		children.push(normalizeChain(
			"FX Chain",
			raw.fx_constrainer ?? "MasterEffect",
			raw.fx.map(normalizeModule),
		));
	} else if (toBool(raw.hasFX)) {
		// Empty FX chain - still show it
		children.push(normalizeChain(
			"FX Chain",
			raw.fx_constrainer ?? "MasterEffect",
			[],
		));
	}

	// Direct children (SynthGroup / SynthChain children)
	if (raw.children) {
		for (const child of raw.children) {
			children.push(normalizeModule(child));
		}
	}

	return {
		label: raw.processorId,
		id: raw.processorId,
		type: raw.id,
		nodeKind: "module",
		children: children.length > 0 ? children : undefined,
	};
}

function normalizeModulationChain(mod: RawModulationChain): TreeNode {
	const children = mod.children
		? mod.children.map(normalizeModule)
		: [];

	const colour = mod.colour.startsWith("#") ? mod.colour : undefined;

	return {
		label: mod.id,
		id: mod.id,
		nodeKind: "chain",
		chainConstrainer: mod.constrainer,
		colour,
		children: children.length > 0 ? children : undefined,
	};
}

function normalizeChain(
	label: string,
	constrainer: string,
	children: TreeNode[],
): TreeNode {
	return {
		label,
		id: label,
		nodeKind: "chain",
		chainConstrainer: constrainer,
		children: children.length > 0 ? children : undefined,
	};
}

// ── Diff application ────────────────────────────────────────────────

/**
 * Apply a diff list to an existing TreeNode tree.
 *
 * Walks the tree and sets `diff` status on nodes whose `id` (processorId)
 * matches a diff entry target:
 * - "+" action -> "added"
 * - "-" action -> "removed"
 * - "*" action -> "modified"
 *
 * Nodes not in the diff list have their diff cleared.
 * Returns the mutated tree.
 */
export function applyDiffToTree(
	tree: TreeNode,
	diff: BuilderDiffEntry[],
): TreeNode {
	// Build a lookup: processorId -> diff status
	// Structural actions (+/-) take priority over * (modified)
	const diffMap = new Map<string, "added" | "removed" | "modified">();
	for (const entry of diff) {
		if (entry.domain !== "builder") continue;
		const status = entry.action === "+" ? "added" as const
			: entry.action === "-" ? "removed" as const
			: "modified" as const;
		const existing = diffMap.get(entry.target);
		if (!existing || (status !== "modified" && existing === "modified")) {
			diffMap.set(entry.target, status);
		}
	}

	applyDiffRecursive(tree, diffMap);
	return tree;
}

function applyDiffRecursive(
	node: TreeNode,
	diffMap: Map<string, "added" | "removed" | "modified">,
): void {
	// Only apply diff to module nodes (chains don't have processorIds in the diff)
	if (node.nodeKind === "module") {
		const status = diffMap.get(node.id ?? node.label);
		node.diff = status;
	} else {
		node.diff = undefined;
	}

	if (node.children) {
		for (const child of node.children) {
			applyDiffRecursive(child, diffMap);
		}
	}
}

// ── Response normalizers ────────────────────────────────────────────

/** Normalize the result from GET /api/builder/tree into a TreeNode. */
/** Strip a raw HISE builder tree to the minimum useful for LLM context:
 *  per-module: id, type, bypassed, plus recursive children/midi/fx/modulation.
 *  Per-modulation chain: id and children. Empty chains and empty arrays are
 *  dropped to keep the payload compact. */
export function cleanBuilderTreeForLlm(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return null;
	const n = raw as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	if (typeof n.id === "string") out.id = n.id;
	if (typeof n.type === "string") out.type = n.type;
	if (typeof n.bypassed === "boolean") out.bypassed = n.bypassed;

	const children = cleanArrayForLlm(n.children, cleanBuilderTreeForLlm);
	const midi = cleanArrayForLlm(n.midi, cleanBuilderTreeForLlm);
	const fx = cleanArrayForLlm(n.fx, cleanBuilderTreeForLlm);
	const modulation = cleanArrayForLlm(n.modulation, cleanBuilderModChainForLlm);

	if (children) out.children = children;
	if (midi) out.midi = midi;
	if (fx) out.fx = fx;
	if (modulation) out.modulation = modulation;
	return out;
}

function cleanBuilderModChainForLlm(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return null;
	const n = raw as Record<string, unknown>;
	const children = cleanArrayForLlm(n.children, cleanBuilderTreeForLlm);
	if (!children) return null;
	const out: Record<string, unknown> = {};
	if (typeof n.id === "string") out.id = n.id;
	out.children = children;
	return out;
}

/** Strip the response from `show <moduleId>` (single-module GET) to the
 *  minimum useful for LLM context: instance id, module type, bypassed,
 *  parameter IDs only (no value / range / default — fetch via `get`),
 *  and a per-mod-chain summary listing chain ids + child module ids and
 *  their parameter IDs. fx / midi children carry the same shape. Empty
 *  arrays drop out so the payload stays compact. */
export function cleanBuilderShowForLlm(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return null;
	const n = raw as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	if (typeof n.processorId === "string") out.id = n.processorId;
	if (typeof n.id === "string") out.type = n.id;
	if (typeof n.prettyName === "string") out.prettyName = n.prettyName;
	if (typeof n.bypassed === "boolean") out.bypassed = n.bypassed;

	const params = pluckParameterIds(n.parameters);
	if (params) out.parameters = params;

	const modulation = cleanArrayForLlm(n.modulation, cleanShowModChain);
	if (modulation) out.modulation = modulation;

	const fx = cleanArrayForLlm(n.fx, cleanBuilderShowForLlm);
	if (fx) out.fx = fx;

	const midi = cleanArrayForLlm(n.midi, cleanBuilderShowForLlm);
	if (midi) out.midi = midi;

	if (n.routing && typeof n.routing === "object") {
		const r = n.routing as Record<string, unknown>;
		const matrix = Array.isArray(r.matrix) ? r.matrix : undefined;
		if (matrix) out.routing = { matrix };
	}

	return out;
}

function cleanShowModChain(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return null;
	const n = raw as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	if (typeof n.id === "string") out.id = n.id;
	if (typeof n.modulationMode === "string") out.mode = n.modulationMode;
	if (typeof n.constrainer === "string" && n.constrainer !== "*") out.constrainer = n.constrainer;
	const children = cleanArrayForLlm(n.children, cleanBuilderShowForLlm);
	if (children) out.children = children;
	return out;
}

/** Strip a single raw parameter object to the minimum useful for LLM
 *  context: id, range (min/max + optional curve subfields), defaultValue,
 *  current value + valueAsString, items[] for enums. Drops parameterIndex,
 *  chainIndex, disabled, valueNormalized. */
export function cleanBuilderParameterForLlm(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return null;
	const p = raw as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	if (typeof p.id === "string") out.id = p.id;
	if (p.range && typeof p.range === "object") {
		const r = p.range as Record<string, unknown>;
		const range: Record<string, unknown> = {};
		if (typeof r.min === "number") range.min = r.min;
		if (typeof r.max === "number") range.max = r.max;
		if (typeof r.stepSize === "number" && r.stepSize !== 0) range.stepSize = r.stepSize;
		if (typeof r.middlePosition === "number") range.middlePosition = r.middlePosition;
		if (typeof r.skewFactor === "number" && r.skewFactor !== 1) range.skewFactor = r.skewFactor;
		out.range = range;
	}
	if (p.defaultValue !== undefined) out.defaultValue = p.defaultValue;
	if (typeof p.value === "number") out.value = p.value;
	if (typeof p.valueAsString === "string") out.valueAsString = p.valueAsString;
	if (Array.isArray(p.items)) out.items = p.items;
	return out;
}

function pluckParameterIds(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const ids: string[] = [];
	for (const p of raw) {
		if (p && typeof p === "object" && typeof (p as Record<string, unknown>).id === "string") {
			ids.push((p as { id: string }).id);
		}
	}
	return ids.length > 0 ? ids : undefined;
}

function cleanArrayForLlm(
	value: unknown,
	mapper: (v: unknown) => unknown,
): unknown[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const mapped = value.map(mapper).filter((v) => v !== null && v !== undefined);
	return mapped.length > 0 ? mapped : undefined;
}

export function normalizeBuilderTreeResponse(value: unknown): TreeNode {
	if (!value || typeof value !== "object") {
		throw new Error("Builder tree result must be an object");
	}
	const raw = value as RawTreeNode;
	if (typeof raw.id !== "string" || typeof raw.processorId !== "string") {
		throw new Error("Builder tree node must have id and processorId");
	}
	return normalizeBuilderTree(raw);
}

/** Normalize the result from POST /api/builder/apply. */
export function normalizeBuilderApplyResult(value: unknown): BuilderApplyResult | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value !== "object") {
		throw new Error("Builder apply result must be an object or null");
	}
	const data = value as Record<string, unknown>;
	return {
		scope: typeof data.scope === "string" ? data.scope : "unknown",
		groupName: typeof data.groupName === "string" ? data.groupName : "unknown",
		diff: normalizeBuilderDiff(data.diff),
	};
}

function normalizeBuilderDiff(value: unknown): BuilderDiffEntry[] {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => {
		if (!entry || typeof entry !== "object") {
			throw new Error("Builder diff entry must be an object");
		}
		const data = entry as Record<string, unknown>;
		const action = data.action === "+" ? "+" as const
			: data.action === "-" ? "-" as const
			: "*" as const;
		return {
			domain: typeof data.domain === "string" ? data.domain : "unknown",
			action,
			target: typeof data.target === "string" ? data.target : "",
		};
	});
}

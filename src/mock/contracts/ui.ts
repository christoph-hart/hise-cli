// UI contract — normalizes raw HISE component tree and apply responses.
//
// Raw tree shape from GET /api/ui/tree is a recursive hierarchy with
// id, type, visible, enabled, saveInPreset, position, and childComponents[].
//
// The normalizer converts to the unified TreeNode display format:
// - Invisible components (and all descendants) are dimmed
// - saveInPreset components get a ★ badge in signal colour
// - All components get a filled dot in the UI mode accent colour
//
// Apply responses from POST /api/ui/apply use the same DiffEntry shape
// as builder (domain: "ui" instead of "builder").

import type { TreeNode } from "../../engine/result.js";
import type { RawComponentNode } from "../componentTree.js";
import type { DiffEntry, BuilderApplyResult } from "./builder.js";
import { toBool } from "./coerce.js";

// Re-export shared types for consumers
export type { RawComponentNode };
export type UiApplyResult = BuilderApplyResult;

// ── Constants ──────────────────────────────────────────────────────

const UI_ACCENT = "#66d9ef";
const PRESET_BADGE_COLOUR = "#e6db74";
const PRESET_BADGE = "★";

// ── Tree normalizer ────────────────────────────────────────────────

/**
 * Convert a raw HISE component tree into the TreeNode display format.
 *
 * Rules:
 * - Every component gets a filled dot (●) in UI accent colour
 * - Components with saveInPreset get a ★ badge in signal colour
 * - Invisible components and all their descendants are dimmed
 * - Root-level panels (depth 1) get topMargin for visual separation
 */
export function normalizeComponentTree(raw: RawComponentNode): TreeNode {
	return normalizeNode(raw, false, 0);
}

function normalizeNode(
	raw: RawComponentNode,
	parentInvisible: boolean,
	depth: number,
): TreeNode {
	const invisible = !toBool(raw.visible) || parentInvisible;

	const children = raw.childComponents.length > 0
		? raw.childComponents.map(child => normalizeNode(child, invisible, depth + 1))
		: undefined;

	const node: TreeNode = {
		label: raw.id,
		id: raw.id,
		type: raw.type,
		nodeKind: "module",
		colour: UI_ACCENT,
		filledDot: true,
		dimmed: invisible,
		children,
	};

	if (toBool(raw.saveInPreset)) {
		node.badge = { text: PRESET_BADGE, colour: PRESET_BADGE_COLOUR };
	}

	// Visual separation for root-level panels (direct children of Content)
	if (depth === 1 && raw.type === "ScriptPanel") {
		node.topMargin = true;
	}

	return node;
}

// ── Response normalizers ───────────────────────────────────────────

/** Strip a raw HISE UI tree to the minimum useful for LLM context:
 *  id, type, optional visible (when false), optional saveInPreset (when true),
 *  recursive childComponents. Empty arrays are dropped. */
export function cleanUiTreeForLlm(raw: unknown): unknown {
	return cleanUiTreeNodeForLlm(raw, true);
}

function cleanUiTreeNodeForLlm(raw: unknown, isRoot: boolean): unknown {
	if (!raw || typeof raw !== "object") return null;
	const n = raw as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	if (typeof n.id === "string") out.id = isRoot && n.id === "Content" ? "root" : n.id;
	if (typeof n.type === "string") out.type = isRoot && n.id === "Content" && n.type === "ScriptPanel" ? "Root" : n.type;
	if (n.visible === false) out.visible = false;
	if (n.saveInPreset === true) out.saveInPreset = true;
	if (Array.isArray(n.childComponents)) {
		const kids = n.childComponents
			.map((child) => cleanUiTreeNodeForLlm(child, false))
			.filter((v) => v !== null && v !== undefined);
		if (kids.length > 0) out.childComponents = kids;
	}
	return out;
}

/** Strip GET /api/get_component_properties to the fields agents need for
 *  discovery and safe writes: component id/type and current property values. */
export function cleanUiPropertiesForLlm(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return null;
	const n = raw as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	if (typeof n.id === "string") out.id = n.id;
	if (typeof n.type === "string") out.type = n.type;

	const properties = Array.isArray(n.properties) ? n.properties : [];
	const cleaned = properties
		.map((property) => {
			if (!property || typeof property !== "object") return null;
			const p = property as Record<string, unknown>;
			if (typeof p.id !== "string") return null;
			const entry: Record<string, unknown> = { id: p.id };
			if ("value" in p) entry.value = p.value;
			if (p.isDefault === false) entry.modified = true;
			if (Array.isArray(p.items) && p.items.length > 0) entry.items = p.items;
			return entry;
		})
		.filter((property) => property !== null);

	if (cleaned.length > 0) out.properties = cleaned;
	return out;
}

/** Normalize the result from GET /api/ui/tree into a TreeNode. */
export function normalizeUiTreeResponse(value: unknown): TreeNode {
	if (!value || typeof value !== "object") {
		throw new Error("UI tree result must be an object");
	}
	const raw = value as RawComponentNode;
	if (typeof raw.id !== "string" || typeof raw.type !== "string") {
		throw new Error("UI tree node must have id and type");
	}
	return normalizeComponentTree(raw);
}

/** Normalize the result from POST /api/ui/apply. */
export function normalizeUiApplyResult(value: unknown): UiApplyResult | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value !== "object") {
		throw new Error("UI apply result must be an object or null");
	}
	const data = value as Record<string, unknown>;
	return {
		scope: typeof data.scope === "string" ? data.scope : "unknown",
		groupName: typeof data.groupName === "string" ? data.groupName : "unknown",
		diff: normalizeDiff(data.diff),
	};
}

function normalizeDiff(value: unknown): DiffEntry[] {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => {
		if (!entry || typeof entry !== "object") {
			throw new Error("UI diff entry must be an object");
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

// ── Diff application ───────────────────────────────────────────────

/**
 * Apply a diff list to a UI component tree.
 * Same logic as builder's applyDiffToTree but filters for domain "ui".
 */
export function applyUiDiffToTree(
	tree: TreeNode,
	diff: DiffEntry[],
): TreeNode {
	const diffMap = new Map<string, "added" | "removed" | "modified">();
	for (const entry of diff) {
		if (entry.domain !== "ui") continue;
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
	const status = diffMap.get(node.id ?? node.label);
	node.diff = status;

	if (node.children) {
		for (const child of node.children) {
			applyDiffRecursive(child, diffMap);
		}
	}
}

// ── Utility ────────────────────────────────────────────────────────

/** Collect all component IDs from a TreeNode tree (for completion). */
export function collectComponentIds(tree: TreeNode): string[] {
	const ids: string[] = [];
	function walk(node: TreeNode): void {
		if (node.id) ids.push(node.id);
		if (node.children) {
			for (const child of node.children) walk(child);
		}
	}
	walk(tree);
	return ids;
}

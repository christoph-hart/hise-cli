// ── UI command → HISE API operations mapping ────────────────────────

import type { TreeNode } from "../result.js";
import type {
	UiAddCommand,
	UiAddChainCommand,
	UiCommand,
	UiRemoveCommand,
	UiRenameCommand,
	UiSetClause,
} from "./ui-parser.js";
import { resolvePath } from "../grammar/path-resolver.js";
import {
	pathRefSegments,
	type PathRef,
} from "../grammar/path-parser.js";
import {
	coerceBoolean,
	coerceFloat,
	coerceString,
	coerceInt,
} from "../grammar/coercion.js";
import type { Value } from "../grammar/value-parser.js";

export interface UiOp {
	op: string;
	[key: string]: unknown;
}

const READONLY_FIELDS = new Set(["type"]);

// Field-write coercion: most UI props are scalars. Compound fields are
// expanded before generic property writes so HISE only sees native props.
function coerceFieldValue(field: string, value: Value): { out: unknown } | { error: string } {
	const lower = field.toLowerCase();
	if (lower === "bounds" || lower === "position" || lower === "size") {
		return { error: `set X.${lower} is a compound field and must be expanded before coercion` };
	}
	if (lower === "visible" || lower === "enabled" || lower === "locked"
		|| lower === "saveinpreset" || lower === "ispluginparameter"
		|| lower === "isMetaParameter" || lower === "deferControlCallback"
		|| lower === "useUndoManager") {
		const b = coerceBoolean(value);
		if (!b.ok) return { error: b.error };
		return { out: b.out };
	}
	if (value.kind === "number" || value.kind === "hex") return { out: value.n };
	if (value.kind === "boolean") return { out: value.b };
	if (value.kind === "string") return { out: value.s };
	if (value.kind === "path") {
		// Treat path as bare identifier
		const segs = pathRefSegments(value.ref);
		if (segs.length === 1) return { out: segs[0].id };
		return { out: segs.map((s) => s.id).join(".") };
	}
	const f = coerceFloat(value);
	if (f.ok) return { out: f.out };
	const s = coerceString(value);
	if (s.ok) return { out: s.out };
	return { error: `cannot coerce ${value.kind} to UI field value` };
}

function coerceCompoundProperties(field: string, value: Value): { properties: Record<string, number> } | { error: string } | null {
	const lower = field.toLowerCase();
	if (lower === "bounds") {
		if (value.kind !== "arrayN" && value.kind !== "array4") {
			return { error: `set X.bounds requires a 4-element array; got ${value.kind}` };
		}
		const arr = value.n as readonly number[];
		if (arr.length !== 4) return { error: `set X.bounds requires 4 ints (got ${arr.length})` };
		return { properties: { x: arr[0]!, y: arr[1]!, width: arr[2]!, height: arr[3]! } };
	}
	if (lower === "position") {
		if (value.kind !== "arrayN" && value.kind !== "array2") {
			return { error: `set X.position requires a 2-element array; got ${value.kind}` };
		}
		const arr = value.n as readonly number[];
		if (arr.length !== 2) return { error: `set X.position requires 2 ints (got ${arr.length})` };
		return { properties: { x: arr[0]!, y: arr[1]! } };
	}
	if (lower === "size") {
		if (value.kind !== "arrayN" && value.kind !== "array2") {
			return { error: `set X.size requires a 2-element array; got ${value.kind}` };
		}
		const arr = value.n as readonly number[];
		if (arr.length !== 2) return { error: `set X.size requires 2 ints (got ${arr.length})` };
		return { properties: { width: arr[0]!, height: arr[1]! } };
	}
	return null;
}

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

function findParentIdOf(tree: TreeNode | null, childId: string): string | null {
	if (!tree) return null;
	const lower = childId.toLowerCase();
	if (tree.children) {
		for (const child of tree.children) {
			if ((child.id ?? "").toLowerCase() === lower) return tree.id ?? null;
			const found = findParentIdOf(child, childId);
			if (found) return found;
		}
	}
	return null;
}

function makeRefFromSegments(original: PathRef, count: number): PathRef {
	const segs = pathRefSegments(original);
	if (count <= 0) return { kind: "parent" };
	if (count === 1) return { kind: "bare", segment: segs[0] };
	return { kind: "dotted", segments: segs.slice(0, count) };
}

// ── Translation ──────────────────────────────────────────────────

export function commandToOps(
	cmd: UiCommand,
	treeRoot: TreeNode | null,
	currentPath: string[],
): { ops: UiOp[] } | { error: string } {
	switch (cmd.type) {
		case "add":
			return translateAdd(cmd, treeRoot, currentPath);
		case "addChain":
			return translateAddChain(cmd, treeRoot, currentPath);
		case "remove":
			return translateRemove(cmd, treeRoot, currentPath);
		case "rename":
			return translateRename(cmd, treeRoot, currentPath);
		case "set":
			return translateSet(cmd.clauses, treeRoot, currentPath);
		case "connect":
			return { error: "handled dynamically" };
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
	cmd: UiAddCommand,
	treeRoot: TreeNode | null,
	currentPath: string[],
): { ops: UiOp[] } | { error: string } {
	const op: UiOp = {
		op: "add",
		componentType: cmd.componentType,
		id: cmd.alias,
	};
	if (cmd.parent) {
		const r = resolveRefToTarget(treeRoot, currentPath, cmd.parent, "lookup");
		if ("error" in r) return { error: r.error };
		op.parentId = r.id;
	} else if (currentPath.length > 0) {
		op.parentId = currentPath[currentPath.length - 1];
	}
	return { ops: [op] };
}

function translateAddChain(
	cmd: UiAddChainCommand,
	_treeRoot: TreeNode | null,
	currentPath: string[],
): { ops: UiOp[] } | { error: string } {
	const ops: UiOp[] = [];
	const parentId = currentPath.length > 0 ? currentPath[currentPath.length - 1] : undefined;
	for (const cl of cmd.clauses) {
		const op: UiOp = { op: "add", componentType: cl.componentType, id: cl.alias };
		if (parentId) op.parentId = parentId;
		ops.push(op);
	}
	return { ops };
}

function translateRemove(
	cmd: UiRemoveCommand,
	treeRoot: TreeNode | null,
	currentPath: string[],
): { ops: UiOp[] } | { error: string } {
	const ops: UiOp[] = [];
	for (const ref of cmd.targets) {
		const r = resolveRefToTarget(treeRoot, currentPath, ref, "lookup");
		if ("error" in r) return { error: r.error };
		ops.push({ op: "remove", target: r.id });
	}
	return { ops };
}

function translateRename(
	cmd: UiRenameCommand,
	treeRoot: TreeNode | null,
	currentPath: string[],
): { ops: UiOp[] } | { error: string } {
	const r = resolveRefToTarget(treeRoot, currentPath, cmd.target, "lookup");
	if ("error" in r) return { error: r.error };
	return { ops: [{ op: "rename", target: r.id, newId: cmd.name }] };
}

function translateSet(
	clauses: UiSetClause[],
	treeRoot: TreeNode | null,
	currentPath: string[],
): { ops: UiOp[] } | { error: string } {
	const ops: UiOp[] = [];
	for (const clause of clauses) {
		const r = translateSetClause(clause, treeRoot, currentPath);
		if ("error" in r) return r;
		ops.push(...r.ops);
	}
	return { ops };
}

function translateSetClause(
	clause: UiSetClause,
	treeRoot: TreeNode | null,
	currentPath: string[],
): { ops: UiOp[] } | { error: string } {
	const segs = pathRefSegments(clause.path);
	if (segs.length < 2) return { error: "set: path must have at least 2 segments" };

	const tail = segs[segs.length - 1].id;
	const tailLower = tail.toLowerCase();

	if (READONLY_FIELDS.has(tailLower)) {
		return { error: `${tail} is read-only` };
	}

	const targetRef = makeRefFromSegments(clause.path, segs.length - 1);
	const target = resolveRefToTarget(treeRoot, currentPath, targetRef, "lookup");
	if ("error" in target) return target;

	if (tailLower === "value") {
		const f = coerceFieldValue(tail, clause.value);
		if ("error" in f) return f;
		return { ops: [{ op: "set_value", target: target.id, value: f.out }] };
	}

	if (tailLower === "parent") {
		// New parent expressed as path → resolve to id.
		if (clause.value.kind !== "path" && clause.value.kind !== "string") {
			return { error: "set X.parent requires an identifier or quoted path" };
		}
		let newParentId: string;
		if (clause.value.kind === "path") {
			const r = resolveRefToTarget(treeRoot, currentPath, clause.value.ref, "lookup");
			if ("error" in r) return r;
			newParentId = r.id;
		} else {
			newParentId = clause.value.s;
		}
		return { ops: [{ op: "move", target: target.id, parent: newParentId }] };
	}

	if (tailLower === "index") {
		const idx = coerceInt(clause.value);
		if (!idx.ok) return { error: idx.error };
		const currentParent = findParentIdOf(treeRoot, target.id);
		if (!currentParent) {
			return { error: `cannot determine current parent of "${target.id}" — tree unavailable` };
		}
		return { ops: [{ op: "move", target: target.id, parent: currentParent, index: idx.out }] };
	}

	const compound = coerceCompoundProperties(tail, clause.value);
	if (compound) {
		if ("error" in compound) return compound;
		return {
			ops: Object.entries(compound.properties).map(([key, value]) => ({
				op: "set",
				target: target.id,
				properties: { [key]: value },
			})),
		};
	}

	const f = coerceFieldValue(tail, clause.value);
	if ("error" in f) return f;
	return { ops: [{ op: "set", target: target.id, properties: { [tail]: f.out } }] };
}

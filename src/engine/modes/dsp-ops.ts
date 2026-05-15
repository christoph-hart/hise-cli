// ── DSP command → HISE API operations mapping ────────────────────────

import type {
	AddCommand,
	AddChainCommand,
	ConnectCommand,
	CreateParameterCommand,
	DisconnectCommand,
	DspCommand,
	RemoveCommand,
	RenameCommand,
	SetClause,
} from "./dsp-parser.js";
import type { RawDspNode } from "../../mock/contracts/dsp.js";
import { findDspNode, findDspParent } from "../../mock/contracts/dsp.js";
import type { ScriptnodeList } from "../data.js";
import { nodePropertyNames, ROOT_NETWORK_PROPERTY_NAMES } from "./dsp-properties.js";
import { resolvePath } from "../grammar/path-resolver.js";
import type { TreeNode } from "../result.js";
import {
	pathRefSegments,
	type PathRef,
} from "../grammar/path-parser.js";
import {
	coerceBoolean,
	coerceFloat,
	coerceInt,
	coerceString,
} from "../grammar/coercion.js";
import type { Value } from "../grammar/value-parser.js";

export interface DspOp {
	op: string;
	[key: string]: unknown;
}

const READONLY_PARAM_SUBFIELDS = new Set(["source"]);
const RANGE_FIELDS = new Set(["min", "max", "stepsize", "middleposition", "skewfactor"]);

// ── Public translator entrypoint ──────────────────────────────────

/**
 * Convert a parsed DSP command into apply-ready ops. Returns either
 * `{ ops }` (possibly an empty array for locally-handled commands) or
 * `{ error }` when translation fails.
 *
 * `treeRoot` is the TreeNode wrapper used by path-resolver. `rawTree` is
 * the RawDspNode root used for parameter / property lookups. `currentPath`
 * is the cwd inside the network (post the moduleId prefix).
 */
export function commandToDspOps(
	cmd: DspCommand,
	rawTree: RawDspNode | null,
	treeRoot: TreeNode | null,
	currentPath: string[],
): { ops: DspOp[] } | { error: string } {
	switch (cmd.type) {
		case "add": return translateAdd(cmd, rawTree, treeRoot, currentPath);
		case "addChain": return translateAddChain(cmd, rawTree, currentPath);
		case "remove": return translateRemove(cmd, treeRoot, currentPath);
		case "rename": return translateRename(cmd, treeRoot, currentPath);
		case "set": return translateSet(cmd.clauses, rawTree, treeRoot, currentPath);
		case "connect": return translateConnect(cmd);
		case "disconnect": return translateDisconnect(cmd);
		case "createParameter": return translateCreateParameter(cmd);
		case "reset": return { ops: [{ op: "clear" }] };
		case "show":
		case "get":
		case "cd":
		case "ls":
		case "pwd":
		case "save":
		case "screenshot":
		case "trace":
			return { ops: [] };
	}
}

// ── Path resolution helpers ──────────────────────────────────────

function resolveRefToId(
	treeRoot: TreeNode | null,
	currentPath: string[],
	ref: PathRef,
): { id: string } | { error: string } {
	if (!treeRoot) {
		const segs = pathRefSegments(ref);
		if (segs.length === 0) return { error: "cannot resolve `..` without tree" };
		return { id: segs[segs.length - 1].id };
	}
	const r = resolvePath(treeRoot, currentPath, ref, "lookup");
	if (!r.ok) return { error: r.message };
	return { id: r.node.id ?? r.fullPath[r.fullPath.length - 1] };
}

// ── Add ───────────────────────────────────────────────────────────

function translateAdd(
	cmd: AddCommand,
	rawTree: RawDspNode | null,
	treeRoot: TreeNode | null,
	currentPath: string[],
): { ops: DspOp[] } | { error: string } {
	const factoryPath = `${cmd.factory}.${cmd.node}`;
	const parent = resolveAddParent(cmd.parent, rawTree, treeRoot, currentPath);
	if ("error" in parent) return parent;
	const op: DspOp = {
		op: "add",
		factoryPath,
		parent: parent.id,
		nodeId: cmd.alias,
	};
	return { ops: [op] };
}

function translateAddChain(
	cmd: AddChainCommand,
	rawTree: RawDspNode | null,
	currentPath: string[],
): { ops: DspOp[] } | { error: string } {
	const parent = resolveAddParent(undefined, rawTree, null, currentPath);
	if ("error" in parent) return parent;
	const ops: DspOp[] = cmd.clauses.map((cl): DspOp => ({
		op: "add",
		factoryPath: `${cl.factory}.${cl.node}`,
		parent: parent.id,
		nodeId: cl.alias,
	}));
	return { ops };
}

function resolveAddParent(
	explicit: PathRef | undefined,
	rawTree: RawDspNode | null,
	treeRoot: TreeNode | null,
	currentPath: string[],
): { id: string } | { error: string } {
	if (explicit) {
		if (treeRoot) {
			const r = resolvePath(treeRoot, currentPath, explicit, "lookup");
			if (!r.ok) return { error: r.message };
			return { id: r.node.id ?? r.fullPath[r.fullPath.length - 1] };
		}
		const segs = pathRefSegments(explicit);
		if (segs.length === 0) return { error: "add: invalid `to` path" };
		return { id: segs[segs.length - 1].id };
	}
	if (currentPath.length > 0) return { id: currentPath[currentPath.length - 1]! };
	if (rawTree) return { id: rawTree.nodeId };
	return { error: "add: no parent resolvable (no tree, no `to`, no cd path)" };
}

// ── Remove / Rename ───────────────────────────────────────────────

function translateRemove(
	cmd: RemoveCommand,
	treeRoot: TreeNode | null,
	currentPath: string[],
): { ops: DspOp[] } | { error: string } {
	const ops: DspOp[] = [];
	for (const ref of cmd.targets) {
		const r = resolveRefToId(treeRoot, currentPath, ref);
		if ("error" in r) return r;
		ops.push({ op: "remove", nodeId: r.id });
	}
	return { ops };
}

function translateRename(
	cmd: RenameCommand,
	treeRoot: TreeNode | null,
	currentPath: string[],
): { ops: DspOp[] } | { error: string } {
	const r = resolveRefToId(treeRoot, currentPath, cmd.target);
	if ("error" in r) return r;
	return { ops: [{ op: "set_id", nodeId: r.id, newId: cmd.name }] };
}

// ── Set ───────────────────────────────────────────────────────────

function translateSet(
	clauses: SetClause[],
	rawTree: RawDspNode | null,
	treeRoot: TreeNode | null,
	currentPath: string[],
): { ops: DspOp[] } | { error: string } {
	const ops: DspOp[] = [];
	for (const clause of clauses) {
		const r = translateSetClause(clause, rawTree, treeRoot, currentPath);
		if ("error" in r) return r;
		ops.push(...r.ops);
	}
	return { ops };
}

function translateSetClause(
	clause: SetClause,
	rawTree: RawDspNode | null,
	treeRoot: TreeNode | null,
	currentPath: string[],
): { ops: DspOp[] } | { error: string } {
	const segs = pathRefSegments(clause.path);
	if (segs.length < 2) return { error: "set: path must have at least 2 segments" };

	const nodeId = segs[0].id;
	const fieldName = segs[1].id;
	const fieldLower = fieldName.toLowerCase();

	if (segs.length === 2) {
		// Universal/property/parameter writes on the node itself.
		switch (fieldLower) {
			case "bypassed": {
				const b = coerceBoolean(clause.value);
				if (!b.ok) return { error: b.error };
				return { ops: [{ op: "bypass", nodeId, bypassed: b.out }] };
			}
			case "parent": {
				const newParent = extractIdValue(clause.value);
				if ("error" in newParent) return newParent;
				return { ops: [{ op: "move", nodeId, parent: newParent.id }] };
			}
			case "index": {
				const idx = coerceInt(clause.value);
				if (!idx.ok) return { error: idx.error };
				const parent = findDspParent(rawTree, nodeId);
				if (!parent) return { error: `cannot determine current parent of "${nodeId}" — tree unavailable` };
				return { ops: [{ op: "move", nodeId, parent: parent.nodeId, index: idx.out }] };
			}
			default: {
				const v = coerceParameterValue(clause.value);
				if ("error" in v) return v;
				return { ops: [{ op: "set", nodeId, parameterId: fieldName, value: v.out }] };
			}
		}
	}

	// 3+ segments: parameter sub-field write.
	if (segs.length === 3) {
		const subfield = segs[2].id;
		const subLower = subfield.toLowerCase();

		if (READONLY_PARAM_SUBFIELDS.has(subLower)) {
			return { error: `${nodeId}.${fieldName}.${subfield} is read-only` };
		}

		// `set X.p.range [min, max]`
		if (subLower === "range") {
			const arr = expectFloatArray(clause.value);
			if ("error" in arr) return arr;
			if (arr.values.length !== 2) {
				return { error: `set ${nodeId}.${fieldName}.range expects [min, max] (got ${arr.values.length})` };
			}
			return {
				ops: [{
					op: "set",
					nodeId,
					parameterId: fieldName,
					min: arr.values[0],
					max: arr.values[1],
				}],
			};
		}

		if (RANGE_FIELDS.has(subLower)) {
			const f = coerceFloat(clause.value);
			if (!f.ok) return { error: f.error };
			const canonical = canonicalRangeFieldName(subfield);
			return {
				ops: [{
					op: "set",
					nodeId,
					parameterId: fieldName,
					[canonical]: f.out,
				}],
			};
		}

		return { error: `unknown sub-field: ${nodeId}.${fieldName}.${subfield}` };
	}

	return { error: `set: path too deep (got ${segs.length} segments)` };
}

function canonicalRangeFieldName(name: string): string {
	switch (name.toLowerCase()) {
		case "min": return "min";
		case "max": return "max";
		case "stepsize": return "stepSize";
		case "middleposition": return "middlePosition";
		case "skewfactor": return "skewFactor";
		default: return name;
	}
}

function extractIdValue(value: Value): { id: string } | { error: string } {
	if (value.kind === "string") return { id: value.s };
	if (value.kind === "path") {
		const segs = pathRefSegments(value.ref);
		if (segs.length === 0) return { error: "expected identifier path, got `..`" };
		return { id: segs[segs.length - 1].id };
	}
	return { error: `expected identifier or quoted string; got ${value.kind}` };
}

function coerceParameterValue(value: Value): { out: string | number | boolean } | { error: string } {
	if (value.kind === "number" || value.kind === "hex") return { out: value.n };
	if (value.kind === "boolean") return { out: value.b };
	if (value.kind === "string") return { out: value.s };
	if (value.kind === "path") {
		const segs = pathRefSegments(value.ref);
		if (segs.length === 1) return { out: segs[0].id };
	}
	const f = coerceFloat(value);
	if (f.ok) return { out: f.out };
	const s = coerceString(value);
	if (s.ok) return { out: s.out };
	return { error: `cannot coerce ${value.kind} to scalar value` };
}

function expectFloatArray(value: Value): { values: number[] } | { error: string } {
	if (value.kind !== "array2" && value.kind !== "array4" && value.kind !== "arrayN") {
		return { error: `expected numeric array; got ${value.kind}` };
	}
	return { values: [...(value.n as readonly number[])] };
}

// ── Connect / Disconnect ──────────────────────────────────────────

function translateConnect(cmd: ConnectCommand): { ops: DspOp[] } | { error: string } {
	const ops: DspOp[] = [];
	for (const cl of cmd.clauses) {
		const srcSegs = pathRefSegments(cl.source);
		const tgtSegs = pathRefSegments(cl.target);
		if (srcSegs.length === 0) return { error: "connect: source path is empty" };
		if (tgtSegs.length === 0) return { error: "connect: target path is empty" };
		const op: DspOp = {
			op: "connect",
			source: srcSegs[0].id,
			target: tgtSegs[0].id,
		};
		if (srcSegs.length >= 2) {
			// Detect numeric output index (e.g. xfader1.0)
			const outImage = srcSegs[1].id;
			if (/^-?\d+$/.test(outImage)) {
				op.sourceOutput = parseInt(outImage, 10);
			} else {
				op.sourceOutput = outImage;
			}
		}
		if (tgtSegs.length >= 2) {
			op.parameter = tgtSegs[1].id;
		}
		if (cl.matched) op.matchRange = true;
		ops.push(op);
	}
	return { ops };
}

function translateDisconnect(cmd: DisconnectCommand): { ops: DspOp[] } | { error: string } {
	const ops: DspOp[] = [];
	for (const ref of cmd.targets) {
		const segs = pathRefSegments(ref);
		if (segs.length < 2) {
			return { error: "disconnect: path must have at least 2 segments (use `disconnect <node>.<param>`)" };
		}
		ops.push({
			op: "disconnect",
			target: segs[0].id,
			parameter: segs[1].id,
		});
	}
	return { ops };
}

// ── Create parameter ─────────────────────────────────────────────

function translateCreateParameter(cmd: CreateParameterCommand): { ops: DspOp[] } | { error: string } {
	const segs = pathRefSegments(cmd.container);
	if (segs.length === 0) return { error: "create_parameter: empty container path" };
	const containerId = segs[segs.length - 1].id;
	const op: DspOp = {
		op: "create_parameter",
		nodeId: containerId,
		parameterId: cmd.paramName,
		min: cmd.range[0],
		max: cmd.range[1],
	};
	if (cmd.defaultValue !== undefined) op.defaultValue = cmd.defaultValue;
	if (cmd.stepSize !== undefined) op.stepSize = cmd.stepSize;
	if (cmd.middlePosition !== undefined) op.middlePosition = cmd.middlePosition;
	if (cmd.skewFactor !== undefined) op.skewFactor = cmd.skewFactor;
	return { ops: [op] };
}

// ── Tree introspection helpers (used by completion) ──────────────

export interface NodeInstance {
	nodeId: string;
	factoryPath: string;
}

export function collectDspNodeIds(root: RawDspNode | null): NodeInstance[] {
	if (!root) return [];
	const result: NodeInstance[] = [];
	walk(root, result);
	return result;
}

function walk(node: RawDspNode, out: NodeInstance[]): void {
	out.push({ nodeId: node.nodeId, factoryPath: node.factoryPath });
	for (const c of node.children) walk(c, out);
}

export function nodeParameters(root: RawDspNode | null, nodeId: string): string[] {
	const node = findDspNode(root, nodeId);
	if (!node) return [];
	return node.parameters.map((p) => p.parameterId);
}

export function nodeParametersAndProperties(
	root: RawDspNode | null,
	list: ScriptnodeList,
	nodeId: string,
): string[] {
	const node = findDspNode(root, nodeId);
	if (!node) return [];
	const paramIds = node.parameters.map((p) => p.parameterId);
	const isRoot = root !== null && root.nodeId === nodeId;
	const rootProps = isRoot ? ROOT_NETWORK_PROPERTY_NAMES : [];
	const def = list[node.factoryPath];
	if (!def) return [...paramIds, ...rootProps];
	return [...paramIds, ...nodePropertyNames(def), ...rootProps];
}

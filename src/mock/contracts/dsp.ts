// DSP contract — normalizes raw HISE scriptnode tree, init, apply, and save
// responses. Field names are authoritative against openapi.json:
//   nodeId, factoryPath, parameterId, source/target/parameter/sourceOutput.
//
// Tree shape from GET /api/dsp/tree returns a recursive node rooted at the
// network's container. Connections live on the owning container (scope is
// the container's modulation edges). Containers have hasChildren:true in the
// scriptnode dataset — identified here by `factoryPath` starting with
// "container." or by the presence of a non-empty children array.
//
// Apply response envelope mirrors builder/ui: { scope, groupName, diff }.

import type { TreeNode } from "../../engine/result.js";
import type { DiffEntry } from "./builder.js";

// ── Raw DSP types (from GET /api/dsp/tree, POST /api/dsp/init) ──────

export interface RawDspParameter {
	parameterId: string;
	value: number;
	// Present only when GET /api/dsp/tree is called with verbose=true.
	min?: number;
	max?: number;
	stepSize?: number;
	middlePosition?: number;
	defaultValue?: number;
}

export interface RawDspConnection {
	source: string;
	sourceOutput: string | number;
	target: string;
	parameter: string;
}

export interface RawDspProperty {
	propertyId: string;
	value: string | number | boolean;
}

export interface RawDspNode {
	nodeId: string;
	factoryPath: string;
	bypassed: boolean;
	parameters: RawDspParameter[];
	/** Node-level properties (Name, NodeColour, Comment, factory-specific). */
	properties?: RawDspProperty[];
	/** Present on container nodes. Lists modulation edges scoped to this container. */
	connections?: RawDspConnection[];
	children: RawDspNode[];
}

// ── Response envelopes ──────────────────────────────────────────────

export interface DspApplyResult {
	scope: string;
	groupName: string;
	diff: DiffEntry[];
}

export interface DspInitResult {
	tree: RawDspNode;
	filePath?: string;
	source: "created" | "loaded";
}

export interface DspSaveResult {
	filePath: string;
}

// ── Raw node validation ─────────────────────────────────────────────

/** Validate and return a RawDspNode. Throws on any shape violation. */
export function validateRawDspNode(value: unknown, path = "root"): RawDspNode {
	if (!value || typeof value !== "object") {
		throw new Error(`DSP tree node at ${path} must be an object`);
	}
	const raw = value as Record<string, unknown>;
	if (typeof raw.nodeId !== "string") {
		throw new Error(`DSP tree node at ${path} missing required string "nodeId"`);
	}
	if (typeof raw.factoryPath !== "string") {
		throw new Error(`DSP tree node "${raw.nodeId}" missing required string "factoryPath"`);
	}
	if (typeof raw.bypassed !== "boolean") {
		throw new Error(`DSP tree node "${raw.nodeId}" missing required boolean "bypassed"`);
	}
	if (!Array.isArray(raw.parameters)) {
		throw new Error(`DSP tree node "${raw.nodeId}" missing required array "parameters"`);
	}
	if (!Array.isArray(raw.children)) {
		throw new Error(`DSP tree node "${raw.nodeId}" missing required array "children"`);
	}

	const parameters = raw.parameters.map((p, i) => validateRawParameter(p, `${raw.nodeId}.parameters[${i}]`));
	const properties = raw.properties !== undefined
		? validateProperties(raw.properties, raw.nodeId as string)
		: undefined;
	const connections = raw.connections !== undefined
		? validateConnections(raw.connections, raw.nodeId as string)
		: undefined;
	const children = raw.children.map((c, i) => validateRawDspNode(c, `${raw.nodeId}.children[${i}]`));

	return {
		nodeId: raw.nodeId,
		factoryPath: raw.factoryPath,
		bypassed: raw.bypassed,
		parameters,
		properties,
		connections,
		children,
	};
}

function validateProperties(value: unknown, nodeId: string): RawDspProperty[] {
	if (!Array.isArray(value)) {
		throw new Error(`DSP properties on "${nodeId}" must be an array`);
	}
	return value.map((p, i) => {
		if (!p || typeof p !== "object") {
			throw new Error(`DSP property at "${nodeId}".properties[${i}] must be an object`);
		}
		const raw = p as Record<string, unknown>;
		if (typeof raw.propertyId !== "string") {
			throw new Error(`DSP property at "${nodeId}".properties[${i}] missing string "propertyId"`);
		}
		const v = raw.value;
		if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
			throw new Error(`DSP property "${raw.propertyId}" on "${nodeId}" "value" must be string, number, or boolean`);
		}
		return { propertyId: raw.propertyId, value: v };
	});
}

function validateRawParameter(value: unknown, path: string): RawDspParameter {
	if (!value || typeof value !== "object") {
		throw new Error(`DSP parameter at ${path} must be an object`);
	}
	const raw = value as Record<string, unknown>;
	if (typeof raw.parameterId !== "string") {
		throw new Error(`DSP parameter at ${path} missing string "parameterId"`);
	}
	// HISE emits `null` for container-level parameters that have no
	// driving source (e.g. `container.split` DryWet before connection).
	// Treat null as 0 — this matches the IDE's display of those slots
	// and avoids throwing on otherwise-valid tree responses.
	const numericValue = raw.value === null
		? 0
		: typeof raw.value === "number"
			? raw.value
			: null;
	if (numericValue === null) {
		throw new Error(`DSP parameter "${raw.parameterId}" at ${path} "value" must be number or null`);
	}
	const out: RawDspParameter = {
		parameterId: raw.parameterId,
		value: numericValue,
	};
	if (typeof raw.min === "number") out.min = raw.min;
	if (typeof raw.max === "number") out.max = raw.max;
	if (typeof raw.stepSize === "number") out.stepSize = raw.stepSize;
	if (typeof raw.middlePosition === "number") out.middlePosition = raw.middlePosition;
	if (typeof raw.defaultValue === "number") out.defaultValue = raw.defaultValue;
	return out;
}

function validateConnections(value: unknown, nodeId: string): RawDspConnection[] {
	if (!Array.isArray(value)) {
		throw new Error(`DSP connections on "${nodeId}" must be an array`);
	}
	return value.map((c, i) => {
		if (!c || typeof c !== "object") {
			throw new Error(`DSP connection at "${nodeId}".connections[${i}] must be an object`);
		}
		const raw = c as Record<string, unknown>;
		if (typeof raw.source !== "string") {
			throw new Error(`DSP connection at "${nodeId}".connections[${i}] missing string "source"`);
		}
		if (typeof raw.target !== "string") {
			throw new Error(`DSP connection at "${nodeId}".connections[${i}] missing string "target"`);
		}
		if (typeof raw.parameter !== "string") {
			throw new Error(`DSP connection at "${nodeId}".connections[${i}] missing string "parameter"`);
		}
		if (typeof raw.sourceOutput !== "string" && typeof raw.sourceOutput !== "number") {
			throw new Error(`DSP connection at "${nodeId}".connections[${i}] "sourceOutput" must be string or number`);
		}
		return {
			source: raw.source,
			sourceOutput: raw.sourceOutput,
			target: raw.target,
			parameter: raw.parameter,
		};
	});
}

// ── Tree normalizer ─────────────────────────────────────────────────

/**
 * Convert a RawDspNode into the sidebar-friendly TreeNode display format.
 *
 * - Container nodes (factoryPath starts with "container.") map to
 *   nodeKind "chain" so the sidebar shows them with the ○ unfilled dot.
 * - Leaf nodes map to nodeKind "module" for the filled ● dot.
 * - Parameter and connection metadata is not encoded in the display
 *   TreeNode — callers keep the RawDspNode separately for value lookups.
 */
export function normalizeDspTree(raw: RawDspNode): TreeNode {
	return toTreeNode(raw);
}

function toTreeNode(raw: RawDspNode): TreeNode {
	const isContainer = isContainerFactory(raw.factoryPath) || raw.children.length > 0;
	const children = raw.children.map(toTreeNode);
	return {
		label: raw.nodeId,
		id: raw.nodeId,
		type: raw.factoryPath,
		nodeKind: isContainer ? "chain" : "module",
		children: children.length > 0 ? children : undefined,
	};
}

/** True when the factory path is a `container.*` node. */
export function isContainerFactory(factoryPath: string): boolean {
	return factoryPath.startsWith("container.");
}

// ── Response-level normalizers ──────────────────────────────────────

/** Normalize GET /api/dsp/list. Expects a top-level `networks` string array. */
export function normalizeDspList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		throw new Error("DSP list response must be a string array");
	}
	return value.map((entry, i) => {
		if (typeof entry !== "string") {
			throw new Error(`DSP list entry [${i}] must be a string`);
		}
		return entry;
	});
}

/** Normalize the `result` of GET /api/dsp/tree into a TreeNode. */
export function normalizeDspTreeResponse(value: unknown): { raw: RawDspNode; tree: TreeNode } {
	const raw = validateRawDspNode(value);
	return { raw, tree: normalizeDspTree(raw) };
}

/** Strip a raw HISE DSP tree to the minimum useful for LLM context:
 *  nodeId, factoryPath, bypassed, recursive children. Parameters, properties,
 *  and connections are dropped. */
export function cleanDspTreeForLlm(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return null;
	const n = raw as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	if (typeof n.nodeId === "string") out.nodeId = n.nodeId;
	if (typeof n.factoryPath === "string") out.factoryPath = n.factoryPath;
	if (typeof n.bypassed === "boolean") out.bypassed = n.bypassed;
	if (Array.isArray(n.children)) {
		const kids = n.children
			.map(cleanDspTreeForLlm)
			.filter((v) => v !== null && v !== undefined);
		if (kids.length > 0) out.children = kids;
	}
	return out;
}

/** Normalize the full response of POST /api/dsp/init. */
export function normalizeDspInitResponse(body: unknown): DspInitResult {
	if (!body || typeof body !== "object") {
		throw new Error("DSP init response must be an object");
	}
	const data = body as Record<string, unknown>;
	const rawTree = data.result;
	if (rawTree === undefined) {
		throw new Error('DSP init response missing "result" (initial tree)');
	}
	if (data.filePath !== undefined && typeof data.filePath !== "string") {
		throw new Error('DSP init response "filePath" must be a string when present');
	}
	if (data.source !== "created" && data.source !== "loaded") {
		throw new Error('DSP init response missing "source" ("created" | "loaded")');
	}
	return {
		tree: validateRawDspNode(rawTree),
		filePath: typeof data.filePath === "string" ? data.filePath : undefined,
		source: data.source,
	};
}

/** Normalize the full response of POST /api/dsp/apply. */
export function normalizeDspApplyResponse(body: unknown): DspApplyResult {
	if (!body || typeof body !== "object") {
		throw new Error("DSP apply response must be an object");
	}
	const data = body as Record<string, unknown>;
	return {
		scope: typeof data.scope === "string" ? data.scope : "unknown",
		groupName: typeof data.groupName === "string" ? data.groupName : "",
		diff: normalizeDiff(data.diff, "dsp"),
	};
}

/** Normalize the full response of POST /api/dsp/save. */
export function normalizeDspSaveResponse(body: unknown): DspSaveResult {
	if (!body || typeof body !== "object") {
		throw new Error("DSP save response must be an object");
	}
	const data = body as Record<string, unknown>;
	if (typeof data.filePath !== "string") {
		throw new Error('DSP save response missing string "filePath"');
	}
	return { filePath: data.filePath };
}

function normalizeDiff(value: unknown, defaultDomain: string): DiffEntry[] {
	if (!Array.isArray(value)) return [];
	return value.map((entry, i) => {
		if (!entry || typeof entry !== "object") {
			throw new Error(`DSP diff entry [${i}] must be an object`);
		}
		const data = entry as Record<string, unknown>;
		const action = data.action === "+" ? "+" as const
			: data.action === "-" ? "-" as const
				: "*" as const;
		return {
			domain: typeof data.domain === "string" ? data.domain : defaultDomain,
			action,
			target: typeof data.target === "string" ? data.target : "",
		};
	});
}

// ── Raw-tree query helpers ──────────────────────────────────────────

/** Depth-first search for a node by nodeId. Case-sensitive. */
export function findDspNode(root: RawDspNode | null, nodeId: string): RawDspNode | null {
	if (!root) return null;
	if (root.nodeId === nodeId) return root;
	for (const child of root.children) {
		const found = findDspNode(child, nodeId);
		if (found) return found;
	}
	return null;
}

/** Find a parameter by id on a node. Returns null if not present. */
export function findDspParameter(
	node: RawDspNode,
	parameterId: string,
): RawDspParameter | null {
	return node.parameters.find((p) => p.parameterId === parameterId) ?? null;
}

/**
 * Walk the tree looking for the connection targeting `nodeId.parameterId`.
 * Connections live on containers, so we search every container's
 * `connections` array for a matching `{target, parameter}`.
 * Returns the first match (or null).
 */
export function findDspConnectionTargeting(
	root: RawDspNode | null,
	targetId: string,
	parameter: string,
): RawDspConnection | null {
	if (!root) return null;
	if (root.connections) {
		for (const c of root.connections) {
			if (c.target === targetId && c.parameter === parameter) return c;
		}
	}
	for (const child of root.children) {
		const found = findDspConnectionTargeting(child, targetId, parameter);
		if (found) return found;
	}
	return null;
}

/** Return the parent container of a node, or null for root / missing. */
export function findDspParent(
	root: RawDspNode | null,
	nodeId: string,
): RawDspNode | null {
	if (!root) return null;
	for (const child of root.children) {
		if (child.nodeId === nodeId) return root;
		const found = findDspParent(child, nodeId);
		if (found) return found;
	}
	return null;
}

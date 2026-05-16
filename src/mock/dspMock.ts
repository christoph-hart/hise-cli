// Mock DSP runtime state — a minimal in-memory scriptnode network store
// used by the `--mock` profile. Supports one active network per moduleId,
// mirrors the real openapi shape, and applies operations from POST
// /api/dsp/apply in-place.

import type { HiseResponse, MockHiseConnection } from "../engine/hise.js";
import type {
	RawDspNode,
	RawDspParameter,
	RawDspConnection,
} from "./contracts/dsp.js";
import { findDspNode, findDspParent } from "./contracts/dsp.js";
import type { DiffEntry } from "./contracts/builder.js";

interface DspNetworkState {
	name: string;
	tree: RawDspNode;
}

interface DspOp {
	op: string;
	[key: string]: unknown;
}

interface DspUndoState {
	inGroup: () => boolean;
	groupName: () => string;
	pushDiff: (entries: DiffEntry[]) => void;
}

// Fixed list of .xml files the mock pretends exist in DspNetworks/.
export const MOCK_DSP_NETWORK_NAMES: readonly string[] = [
	"MyDSP",
	"Reverb",
	"TestSynth",
];

// Default module available as a DspNetwork host.
export const DEFAULT_MOCK_DSP_MODULE = "ScriptFX1";

function emptyTree(name: string): RawDspNode {
	return {
		nodeId: name,
		factoryPath: "container.chain",
		bypassed: false,
		parameters: [],
		connections: [],
		children: [],
	};
}

/** Register DSP endpoint handlers on a MockHiseConnection. */
export function installDspMock(
	connection: MockHiseConnection,
	undo: DspUndoState,
): void {
	// Per-moduleId active network. Starts empty.
	const networks = new Map<string, DspNetworkState>();

	// Names the mock pretends are already persisted on disk — seeded with
	// MOCK_DSP_NETWORK_NAMES. `load` must find the name here; `save` adds
	// a new name; `create` errors if the name is already present.
	const persistedNetworks = new Set<string>(MOCK_DSP_NETWORK_NAMES);

	// ── GET /api/dsp/list ──────────────────────────────────────
	connection.onGet("/api/dsp/list", () => ({
		success: true,
		networks: [...persistedNetworks],
		logs: [],
		errors: [],
	}));

	// ── POST /api/dsp/init ─────────────────────────────────────
	connection.onPost("/api/dsp/init", (body) => {
		const data = (body ?? {}) as Record<string, unknown>;
		const moduleId = typeof data.moduleId === "string" && data.moduleId
			? data.moduleId
			: DEFAULT_MOCK_DSP_MODULE;
		const name = typeof data.name === "string" ? data.name : "";
		if (!name) {
			return errorEnvelope("init: missing required 'name' field");
		}
		const mode = data.mode === "load" || data.mode === "create" || data.mode === "auto"
			? data.mode
			: "auto";
		const exists = persistedNetworks.has(name);
		if (mode === "create" && exists) {
			return errorEnvelope(`Network XML already exists: MOCK_PROJECT/DspNetworks/${name}.xml`);
		}
		if (mode === "load" && !exists) {
			return errorEnvelope(`No network XML found: MOCK_PROJECT/DspNetworks/${name}.xml`);
		}
		const source: "created" | "loaded" = exists && mode !== "create" ? "loaded" : "created";
		const state: DspNetworkState = {
			name,
			tree: emptyTree(name),
		};
		networks.set(moduleId, state);
		return {
			success: true,
			result: state.tree,
			filePath: `MOCK_PROJECT/DspNetworks/${name}.xml`,
			source,
			logs: [source === "loaded" ? `Loaded network from XML ${name}.xml` : "Created new network"],
			errors: [],
		};
	});

	// ── GET /api/dsp/tree ──────────────────────────────────────
	// Mock only tracks one network globally — no per-moduleId routing
	// (the matcher strips query strings before dispatching).
	connection.onGet("/api/dsp/tree", () => {
		const state = firstNetwork(networks);
		if (!state) {
			return errorEnvelope("tree: no active DspNetwork on any module (call init first)");
		}
		return {
			success: true,
			result: state.tree,
			logs: [],
			errors: [],
		};
	});

	// ── GET /api/dsp/runtime_status ─────────────────────────────
	connection.onGet("/api/dsp/runtime_status", () => {
		const state = firstNetwork(networks);
		if (!state) {
			return errorEnvelope("runtime_status: no active DspNetwork on any module (call init first)");
		}
		return {
			success: true,
			apiVersion: "0.9.0",
			moduleId: DEFAULT_MOCK_DSP_MODULE,
			ok: true,
			logs: [],
			errors: [],
		};
	});

	// ── POST /api/dsp/apply ────────────────────────────────────
	connection.onPost("/api/dsp/apply", (body) => {
		const data = (body ?? {}) as Record<string, unknown>;
		const moduleId = typeof data.moduleId === "string" ? data.moduleId : "";
		const ops = Array.isArray(data.operations) ? data.operations : [];

		const state = moduleId ? networks.get(moduleId) : firstNetwork(networks);
		if (!state) {
			return errorEnvelope(`apply: no active DspNetwork${moduleId ? ` on module "${moduleId}"` : ""}`);
		}

		const diff: DiffEntry[] = [];
		for (const opValue of ops) {
			if (!opValue || typeof opValue !== "object") continue;
			const op = opValue as DspOp;
			const err = applyOp(state.tree, op, diff);
			if (err) return errorEnvelope(`apply: ${err}`);
		}

		undo.pushDiff(diff);

		return {
			success: true,
			scope: undo.inGroup() ? "group" : "root",
			groupName: undo.inGroup() ? undo.groupName() : "",
			diff,
			logs: [],
			errors: [],
		};
	});

	// ── POST /api/dsp/save ─────────────────────────────────────
	connection.onPost("/api/dsp/save", (body) => {
		const data = (body ?? {}) as Record<string, unknown>;
		const moduleId = typeof data.moduleId === "string" ? data.moduleId : "";
		const state = moduleId ? networks.get(moduleId) : firstNetwork(networks);
		if (!state) {
			return errorEnvelope(`save: no active DspNetwork${moduleId ? ` on module "${moduleId}"` : ""}`);
		}
		persistedNetworks.add(state.name);
		return {
			success: true,
			filePath: `MOCK_PROJECT/DspNetworks/${state.name}.xml`,
			logs: [`Saved ${state.name}.xml`],
			errors: [],
		};
	});
}

function firstNetwork(networks: Map<string, DspNetworkState>): DspNetworkState | null {
	for (const state of networks.values()) return state;
	return null;
}

function errorEnvelope(message: string): HiseResponse {
	return {
		success: false,
		logs: [],
		errors: [{ errorMessage: message, callstack: [] }],
	};
}

// ── Op application ──────────────────────────────────────────────

function applyOp(tree: RawDspNode, op: DspOp, diff: DiffEntry[]): string | null {
	switch (op.op) {
		case "add": return applyAdd(tree, op, diff);
		case "remove": return applyRemove(tree, op, diff);
		case "move": return applyMove(tree, op, diff);
		case "connect": return applyConnect(tree, op, diff);
		case "disconnect": return applyDisconnect(tree, op, diff);
		case "set": return applySet(tree, op, diff);
		case "bypass": return applyBypass(tree, op, diff);
		case "create_parameter": return applyCreateParameter(tree, op, diff);
		case "clear": return applyClear(tree, diff);
		default: return `unknown op "${String(op.op)}"`;
	}
}

function applyAdd(tree: RawDspNode, op: DspOp, diff: DiffEntry[]): string | null {
	const factoryPath = typeof op.factoryPath === "string" ? op.factoryPath : "";
	const parentId = typeof op.parent === "string" ? op.parent : "";
	if (!factoryPath) return "add: missing factoryPath";
	if (!parentId) return "add: missing parent";

	const parent = findDspNode(tree, parentId);
	if (!parent) return `add: parent "${parentId}" not found`;

	const baseId = typeof op.nodeId === "string" && op.nodeId
		? op.nodeId
		: deriveNodeId(factoryPath);
	const nodeId = ensureUniqueId(tree, baseId);
	const newNode: RawDspNode = {
		nodeId,
		factoryPath,
		bypassed: false,
		parameters: [],
		connections: factoryPath.startsWith("container.") ? [] : undefined,
		children: [],
	};

	const index = typeof op.index === "number" ? op.index : parent.children.length;
	parent.children.splice(index, 0, newNode);
	diff.push({ domain: "dsp", action: "+", target: nodeId });
	return null;
}

function applyRemove(tree: RawDspNode, op: DspOp, diff: DiffEntry[]): string | null {
	const nodeId = typeof op.nodeId === "string" ? op.nodeId : "";
	if (!nodeId) return "remove: missing nodeId";
	const parent = findDspParent(tree, nodeId);
	if (!parent) return `remove: "${nodeId}" not found`;
	parent.children = parent.children.filter((c) => c.nodeId !== nodeId);
	diff.push({ domain: "dsp", action: "-", target: nodeId });
	return null;
}

function applyMove(tree: RawDspNode, op: DspOp, diff: DiffEntry[]): string | null {
	const nodeId = typeof op.nodeId === "string" ? op.nodeId : "";
	const parentId = typeof op.parent === "string" ? op.parent : "";
	if (!nodeId) return "move: missing nodeId";
	if (!parentId) return "move: missing parent";
	const currentParent = findDspParent(tree, nodeId);
	if (!currentParent) return `move: "${nodeId}" not found`;
	const newParent = findDspNode(tree, parentId);
	if (!newParent) return `move: parent "${parentId}" not found`;
	const node = currentParent.children.find((c) => c.nodeId === nodeId)!;
	currentParent.children = currentParent.children.filter((c) => c.nodeId !== nodeId);
	const index = typeof op.index === "number" ? op.index : newParent.children.length;
	newParent.children.splice(index, 0, node);
	diff.push({ domain: "dsp", action: "*", target: nodeId });
	return null;
}

function applyConnect(tree: RawDspNode, op: DspOp, diff: DiffEntry[]): string | null {
	const source = typeof op.source === "string" ? op.source : "";
	const target = typeof op.target === "string" ? op.target : "";
	const parameter = typeof op.parameter === "string" ? op.parameter : "";
	if (!source || !target || !parameter) return "connect: missing source/target/parameter";
	const container = findDspParent(tree, target) ?? tree;
	if (!container.connections) container.connections = [];
	const sourceOutput = typeof op.sourceOutput === "string" || typeof op.sourceOutput === "number"
		? op.sourceOutput
		: 0;
	const conn: RawDspConnection = { source, sourceOutput, target, parameter };
	container.connections.push(conn);
	diff.push({ domain: "dsp", action: "*", target });
	return null;
}

function applyDisconnect(tree: RawDspNode, op: DspOp, diff: DiffEntry[]): string | null {
	const source = typeof op.source === "string" ? op.source : "";
	const target = typeof op.target === "string" ? op.target : "";
	const parameter = typeof op.parameter === "string" ? op.parameter : "";
	if (!source || !target || !parameter) return "disconnect: missing source/target/parameter";
	const container = findDspParent(tree, target) ?? tree;
	if (!container.connections) return null;
	const before = container.connections.length;
	container.connections = container.connections.filter(
		(c) => !(c.source === source && c.target === target && c.parameter === parameter),
	);
	if (container.connections.length === before) {
		return `disconnect: connection ${source} -> ${target}.${parameter} not found`;
	}
	diff.push({ domain: "dsp", action: "*", target });
	return null;
}

function applySet(tree: RawDspNode, op: DspOp, diff: DiffEntry[]): string | null {
	const nodeId = typeof op.nodeId === "string" ? op.nodeId : "";
	const parameterId = typeof op.parameterId === "string" ? op.parameterId : "";
	if (!nodeId) return "set: missing nodeId";
	if (!parameterId) return "set: missing parameterId";
	const node = findDspNode(tree, nodeId);
	if (!node) return `set: node "${nodeId}" not found`;
	let param = node.parameters.find((p) => p.parameterId === parameterId);
	if (!param) {
		const value = coerceNumeric(op.value, 0);
		param = { parameterId, value };
		node.parameters.push(param);
	} else if (op.value !== undefined) {
		const value = coerceNumeric(op.value);
		param.value = value;
	}
	if (typeof op.min === "number") param.min = op.min;
	if (typeof op.max === "number") param.max = op.max;
	if (typeof op.stepSize === "number") param.stepSize = op.stepSize;
	if (typeof op.middlePosition === "number") param.middlePosition = op.middlePosition;
	if (typeof op.defaultValue === "number") param.defaultValue = op.defaultValue;
	diff.push({ domain: "dsp", action: "*", target: nodeId });
	return null;
}

function applyBypass(tree: RawDspNode, op: DspOp, diff: DiffEntry[]): string | null {
	const nodeId = typeof op.nodeId === "string" ? op.nodeId : "";
	if (!nodeId) return "bypass: missing nodeId";
	const node = findDspNode(tree, nodeId);
	if (!node) return `bypass: node "${nodeId}" not found`;
	node.bypassed = op.bypassed === true;
	diff.push({ domain: "dsp", action: "*", target: nodeId });
	return null;
}

function applyCreateParameter(tree: RawDspNode, op: DspOp, diff: DiffEntry[]): string | null {
	const nodeId = typeof op.nodeId === "string" ? op.nodeId : "";
	const parameterId = typeof op.parameterId === "string" ? op.parameterId : "";
	if (!nodeId) return "create_parameter: missing nodeId";
	if (!parameterId) return "create_parameter: missing parameterId";
	const node = findDspNode(tree, nodeId);
	if (!node) return `create_parameter: node "${nodeId}" not found`;
	const existing = node.parameters.find((p) => p.parameterId === parameterId);
	const defaultValue = coerceNumeric(op.defaultValue, 0);
	const param: RawDspParameter = existing ?? { parameterId, value: defaultValue };
	if (typeof op.min === "number") param.min = op.min;
	if (typeof op.max === "number") param.max = op.max;
	if (typeof op.stepSize === "number") param.stepSize = op.stepSize;
	if (typeof op.middlePosition === "number") param.middlePosition = op.middlePosition;
	if (typeof op.defaultValue === "number") param.defaultValue = op.defaultValue;
	if (!existing) node.parameters.push(param);
	diff.push({ domain: "dsp", action: "*", target: nodeId });
	return null;
}

function applyClear(tree: RawDspNode, diff: DiffEntry[]): string | null {
	for (const child of tree.children) {
		diff.push({ domain: "dsp", action: "-", target: child.nodeId });
	}
	tree.children = [];
	if (tree.connections) tree.connections = [];
	return null;
}

// ── Helpers ──────────────────────────────────────────────────────

function deriveNodeId(factoryPath: string): string {
	const dot = factoryPath.lastIndexOf(".");
	const base = dot >= 0 ? factoryPath.slice(dot + 1) : factoryPath;
	// Capitalise first letter to mirror HISE's auto-id convention (osc → Osc1).
	return base.charAt(0).toUpperCase() + base.slice(1);
}

function ensureUniqueId(tree: RawDspNode, baseId: string): string {
	if (!findDspNode(tree, baseId)) return baseId;
	let n = 1;
	while (findDspNode(tree, `${baseId}${n}`)) n++;
	return `${baseId}${n}`;
}

function coerceNumeric(value: unknown, fallback = 0): number {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	if (typeof value === "boolean") return value ? 1 : 0;
	return fallback;
}

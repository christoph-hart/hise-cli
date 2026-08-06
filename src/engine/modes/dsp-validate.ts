// ── DSP local validation against scriptnodeList.json ─────────────────

import { closest } from "fastest-levenshtein";
import type { ScriptnodeList, ScriptnodeDefinition } from "../data.js";
import type { RawDspNode } from "../../mock/contracts/dsp.js";
import { findDspNode } from "../../mock/contracts/dsp.js";
import type {
	AddCommand,
	CreateParameterCommand,
	SetCommand,
	SetClause,
	SetComplexDataCommand,
} from "./dsp-parser.js";
import {
	nodePropertyNames,
	ROOT_NETWORK_PROPERTIES,
	ROOT_NETWORK_PROPERTY_NAMES,
} from "./dsp-properties.js";
import {
	pathRefSegments,
} from "../grammar/path-parser.js";
import type { Value } from "../grammar/value-parser.js";

export interface ValidationResult {
	valid: boolean;
	errors: string[];
	suggestions?: string[];
}

export function findScriptnode(
	factoryPath: string,
	list: ScriptnodeList,
): ScriptnodeDefinition | undefined {
	return list[factoryPath];
}

export function validateAddCommand(
	cmd: AddCommand,
	list: ScriptnodeList,
): ValidationResult {
	const factoryPath = `${cmd.factory}.${cmd.node}`;
	if (findScriptnode(factoryPath, list)) {
		return { valid: true, errors: [] };
	}
	const allPaths = Object.keys(list);
	const suggestion = allPaths.length > 0 ? closest(factoryPath, allPaths) : undefined;
	const errors = [`Unknown factory path "${factoryPath}".`];
	const suggestions: string[] = [];
	if (suggestion && suggestion !== factoryPath) {
		suggestions.push(suggestion);
		errors[0] += ` Did you mean "${suggestion}"?`;
	}
	return { valid: false, errors, suggestions };
}

/**
 * Validate every clause in a SetCommand. Per-clause checks:
 *  - 2-seg `set X.foo V`: parameter or property write. Check param exists
 *    in the factory's metadata; range-check numeric values.
 *  - 3-seg `set X.foo.range [a, b]` or `set X.foo.<rangeField> N`: deferred
 *    cross-field validation; only trivial constraints checked here
 *    (stepSize >= 0, skewFactor > 0).
 *  - Universal fields (bypassed/parent/index) skip validation here.
 */
export function validateSetCommand(
	cmd: SetCommand,
	list: ScriptnodeList,
	rawTree: RawDspNode | null,
): ValidationResult {
	const errors: string[] = [];
	for (const clause of cmd.clauses) {
		const r = validateSetClause(clause, list, rawTree);
		if (!r.valid) errors.push(...r.errors);
	}
	return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

const UNIVERSAL_FIELDS = new Set(["bypassed", "parent", "index", "name"]);
const RANGE_SUBFIELDS_FLOAT = new Set(["min", "max", "stepsize", "middleposition", "skewfactor"]);
const COMPLEX_DATA_TYPES = new Set(["table", "sliderpack", "audiofile", "filtercoefficients", "displaybuffer"]);

export function validateSetComplexDataCommand(
	cmd: SetComplexDataCommand,
	rawTree: RawDspNode | null,
): ValidationResult {
	const errors: string[] = [];
	for (const clause of cmd.clauses) {
		const segs = pathRefSegments(clause.path);
		if (segs.length !== 2 && segs.length !== 3) {
			errors.push("set_complex_data: path must be <node>.<dataType>[.<slot>]");
			continue;
		}
		if (!COMPLEX_DATA_TYPES.has(segs[1]!.id.toLowerCase())) {
			errors.push(`set_complex_data: unsupported data type "${segs[1]!.id}"`);
		}
		if (segs.length === 3) {
			const slot = Number(segs[2]!.id);
			if (!Number.isInteger(slot) || slot < 0) {
				errors.push("set_complex_data: slot must be a non-negative integer");
			}
		}
		if (clause.dataIndex < -1) {
			errors.push("set_complex_data: index must be -1 or greater");
		}
		if (rawTree && !findDspNode(rawTree, segs[0]!.id)) {
			errors.push(`set_complex_data: node "${segs[0]!.id}" not found`);
		}
	}
	return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

function validateSetClause(
	clause: SetClause,
	list: ScriptnodeList,
	rawTree: RawDspNode | null,
): ValidationResult {
	const segs = pathRefSegments(clause.path);
	if (segs.length < 2) return { valid: false, errors: ["set: path must have at least 2 segments"] };

	const nodeId = segs[0].id;
	const fieldName = segs[1].id;
	const fieldLower = fieldName.toLowerCase();

	if (UNIVERSAL_FIELDS.has(fieldLower)) {
		return { valid: true, errors: [] };
	}

	// 3-seg sub-field write
	if (segs.length === 3) {
		const subfield = segs[2].id.toLowerCase();
		if (subfield === "range") return { valid: true, errors: [] };
		if (RANGE_SUBFIELDS_FLOAT.has(subfield)) {
			if (clause.value.kind === "number" || clause.value.kind === "hex") {
				const v = clause.value.n;
				if (subfield === "stepsize" && v < 0) {
					return { valid: false, errors: [`range: stepSize must be >= 0 (got ${v})`] };
				}
				if (subfield === "skewfactor" && v <= 0) {
					return { valid: false, errors: [`range: skewFactor must be > 0 (got ${v})`] };
				}
			}
			return { valid: true, errors: [] };
		}
		return { valid: false, errors: [`unknown sub-field: ${nodeId}.${fieldName}.${segs[2].id}`] };
	}

	// 2-seg parameter / property write — look up in tree.
	const node = rawTree ? findDspNode(rawTree, nodeId) : null;

	// Network-level root property write
	if (rawTree && rawTree.nodeId === nodeId) {
		const def = ROOT_NETWORK_PROPERTIES[fieldName];
		if (def) return validateRootProperty(fieldName, clause.value, def);
		// Falls through if the root has a real parameter named the same.
	}

	if (!node) return { valid: true, errors: [] };
	const factoryDef = findScriptnode(node.factoryPath, list);
	if (!factoryDef) return { valid: true, errors: [] };

	const param = factoryDef.parameters.find((p) => p.id === fieldName);
	if (!param) {
		const propertyNames = nodePropertyNames(factoryDef);
		if (propertyNames.includes(fieldName)) return { valid: true, errors: [] };
		const isRoot = rawTree?.nodeId === nodeId;
		const allNames = [
			...factoryDef.parameters.map((p) => p.id),
			...propertyNames,
			...(isRoot ? ROOT_NETWORK_PROPERTY_NAMES : []),
		];
		const suggestion = allNames.length > 0 ? closest(fieldName, allNames) : undefined;
		let msg = `Unknown parameter "${fieldName}" on ${node.factoryPath}.`;
		if (suggestion) msg += ` Did you mean "${suggestion}"?`;
		return { valid: false, errors: [msg] };
	}

	if (clause.value.kind === "number" || clause.value.kind === "hex") {
		const v = clause.value.n;
		const liveParam = node.parameters.find((p) => p.parameterId === fieldName);
		const min = liveParam?.min ?? param.range.min;
		const max = liveParam?.max ?? param.range.max;
		if (v < min || v > max) {
			return {
				valid: false,
				errors: [
					`Value ${v} out of range for ${nodeId}.${fieldName} (${min}-${max}).`,
				],
			};
		}
	}
	return { valid: true, errors: [] };
}

function validateRootProperty(
	name: string,
	value: Value,
	def: import("./dsp-properties.js").RootNetworkPropertyDef,
): ValidationResult {
	if (def.kind === "bool") {
		if (value.kind === "boolean") return { valid: true, errors: [] };
		if (value.kind === "number" && (value.n === 0 || value.n === 1)) return { valid: true, errors: [] };
		return {
			valid: false,
			errors: [`Network property "${name}" expects a boolean (true/false), got ${value.kind}.`],
		};
	}
	// int
	if (value.kind !== "number" && value.kind !== "hex") {
		return {
			valid: false,
			errors: [`Network property "${name}" expects an integer, got ${value.kind}.`],
		};
	}
	const n = value.n;
	if (!Number.isInteger(n)) {
		return { valid: false, errors: [`Network property "${name}" expects an integer, got ${n}.`] };
	}
	if (def.powerOfTwo) {
		const ok = (def.allowZero && n === 0) || (n > 0 && (n & (n - 1)) === 0);
		if (!ok) {
			return {
				valid: false,
				errors: [`Network property "${name}" expects a power-of-two${def.allowZero ? " (or 0)" : ""}, got ${n}.`],
			};
		}
	}
	return { valid: true, errors: [] };
}

export function validateCreateParameterCommand(
	cmd: CreateParameterCommand,
	list: ScriptnodeList,
	rawTree: RawDspNode | null,
): ValidationResult {
	const segs = pathRefSegments(cmd.container);
	if (segs.length === 0) return { valid: false, errors: ["create_parameter: empty container path"] };
	const containerId = segs[segs.length - 1].id;
	const node = rawTree ? findDspNode(rawTree, containerId) : null;
	const factoryDef = node ? findScriptnode(node.factoryPath, list) : undefined;
	if (factoryDef && !factoryDef.hasChildren) {
		return {
			valid: false,
			errors: [`Cannot create parameter on ${containerId}: ${node!.factoryPath} is not a container node.`],
		};
	}
	const [min, max] = cmd.range;
	if (min >= max) {
		return { valid: false, errors: [`create_parameter: min (${min}) must be less than max (${max}).`] };
	}
	if (cmd.middlePosition !== undefined && cmd.skewFactor !== undefined) {
		return {
			valid: false,
			errors: ["create_parameter: middlePosition and skewFactor are mutually exclusive."],
		};
	}
	if (cmd.skewFactor !== undefined && cmd.skewFactor <= 0) {
		return { valid: false, errors: [`create_parameter: skewFactor must be > 0 (got ${cmd.skewFactor}).`] };
	}
	if (cmd.middlePosition !== undefined && (cmd.middlePosition <= min || cmd.middlePosition >= max)) {
		return {
			valid: false,
			errors: [`create_parameter: middlePosition (${cmd.middlePosition}) must lie strictly between min (${min}) and max (${max}).`],
		};
	}
	if (cmd.stepSize !== undefined && cmd.stepSize < 0) {
		return { valid: false, errors: [`create_parameter: stepSize must be >= 0 (got ${cmd.stepSize}).`] };
	}
	return { valid: true, errors: [] };
}

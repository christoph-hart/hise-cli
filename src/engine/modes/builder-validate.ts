// ── Builder validation against moduleList.json ───────────────────────

import { closest } from "fastest-levenshtein";
import type { ModuleDefinition, ModuleList } from "../data.js";
import { ConstrainerParser } from "../constrainer-parser.js";
import type { AddCommand, CloneCommand, RenameCommand, SetCommand } from "./builder-parser.js";
import { coerceFloat } from "../grammar/coercion.js";
import { pathRefSegments } from "../grammar/path-parser.js";

// ── Validation result ─────────────────────────────────────────────

export interface ValidationResult {
	valid: boolean;
	errors: string[];
	suggestions?: string[];
}

// ── Module name resolution ────────────────────────────────────────

/** Lowercase + strip ASCII whitespace. Used for spaceless-ID matches. */
function compactName(s: string): string {
	return s.toLowerCase().replace(/\s+/g, "");
}

/**
 * Look up a module definition by pretty name or type ID. Tiers:
 *   1. Exact (prettyName or id)
 *   2. Case-insensitive
 *   3. Case-insensitive + whitespace-stripped (matches the spaceless
 *      CamelCase form users type in HiseScript, e.g. `ParametriqEQ`
 *      against prettyName `"Parametriq EQ"`).
 */
export function findModuleByName(
	name: string,
	moduleList: ModuleList,
): ModuleDefinition | undefined {
	const lower = name.toLowerCase();
	const compact = compactName(name);
	return moduleList.modules.find((m) => m.prettyName === name || m.id === name)
		?? moduleList.modules.find((m) => m.prettyName.toLowerCase() === lower || m.id.toLowerCase() === lower)
		?? moduleList.modules.find((m) => compactName(m.prettyName) === compact || compactName(m.id) === compact);
}

/**
 * Resolve a user-facing module name (pretty name or type ID) to the
 * internal type ID. Delegates to findModuleByName.
 */
export function resolveModuleTypeId(
	name: string,
	moduleList: ModuleList | null,
): string | null {
	if (!moduleList) return null;
	return findModuleByName(name, moduleList)?.id ?? null;
}

// ── Validators ────────────────────────────────────────────────────

export function validateAddCommand(
	cmd: AddCommand,
	moduleList: ModuleList,
): ValidationResult {
	const errors: string[] = [];
	const suggestions: string[] = [];

	const module = findModuleByName(cmd.moduleType, moduleList);

	if (!module) {
		const allNames = moduleList.modules.flatMap((m) => [m.prettyName, m.id]);
		const closestName = closest(cmd.moduleType, allNames);
		const closestModule = closestName
			? moduleList.modules.find((m) => m.prettyName === closestName || m.id === closestName)
			: undefined;
		const suggestion = closestModule?.prettyName;
		errors.push(`Unknown module type "${cmd.moduleType}".`);
		if (suggestion) {
			suggestions.push(suggestion);
			errors[0] += ` Did you mean "${suggestion}"?`;
		}
		return { valid: false, errors, suggestions };
	}

	return { valid: true, errors: [], suggestions };
}

export function validateRenameCommand(_cmd: RenameCommand): ValidationResult {
	return { valid: true, errors: [] };
}

export function validateCloneCommand(cmd: CloneCommand): ValidationResult {
	if (cmd.count < 1) {
		return { valid: false, errors: [`clone count must be ≥ 1 (got ${cmd.count})`] };
	}
	return { valid: true, errors: [] };
}

/**
 * Validate a single set clause. Path must have ≥2 segments. The first
 * segment is the target instance name; the tail (last segment) is the
 * field name. Module-type-specific properties are checked against
 * moduleList; reserved field names (parent, bypassed, samplemap, …)
 * are accepted without parameter lookup since they are universal.
 */
const RESERVED_FIELD_NAMES = new Set([
	"parent", "index", "bypassed", "name",
	"samplemap", "network", "effect",
	"routing", "send",
	"resizable", "routable", "numdestinationchannels",
]);

export function validateSetCommand(
	cmd: SetCommand,
	moduleList: ModuleList,
): ValidationResult {
	const errors: string[] = [];

	for (const clause of cmd.clauses) {
		const segs = pathRefSegments(clause.path);
		if (segs.length < 2) {
			errors.push("set: path must have at least 2 segments");
			continue;
		}
		const targetName = segs[0].id;
		const fieldName = segs[segs.length - 1].id;
		const fieldLower = fieldName.toLowerCase();

		if (RESERVED_FIELD_NAMES.has(fieldLower)) continue;

		// Look up by target name. In real use the target is an instance ID
		// whose type comes from the live tree; here we fall back to
		// matching the name against the module catalog (covers cases where
		// the user types the type name directly).
		const module = findModuleByName(targetName, moduleList);
		if (!module) continue;

		const param = module.parameters.find((p) => p.id === fieldName);
		if (!param) {
			const paramNames = module.parameters.map((p) => p.id);
			let msg = `Unknown parameter "${fieldName}" for ${module.id}.`;
			if (paramNames.length > 0) {
				const suggestion = closest(fieldName, paramNames);
				if (suggestion) msg += ` Did you mean "${suggestion}"?`;
			}
			errors.push(msg);
			continue;
		}

		const numeric = coerceFloat(clause.value);
		if (numeric.ok) {
			if (numeric.out < param.range.min || numeric.out > param.range.max) {
				errors.push(
					`Value ${numeric.out} out of range for ${module.id}.${param.id} (${param.range.min}–${param.range.max}).`,
				);
			}
		}
	}

	return { valid: errors.length === 0, errors };
}

// ── Internal helpers ──────────────────────────────────────────────

/** Map chain name to the constrainer string from a parent module definition. */
export function resolveChainConstrainer(
	parentModule: ModuleDefinition,
	chainName: string,
): string | null {
	const lower = chainName.toLowerCase();

	if (lower === "fx") {
		return parentModule.fx_constrainer ?? null;
	}

	if (lower === "children") {
		return parentModule.constrainer ?? null;
	}

	if (lower === "midi") {
		return null;
	}

	for (const mod of parentModule.modulation) {
		const modName = mod.id.toLowerCase().replace(/\s+/g, "");
		const modMode = mod.modulationMode?.toLowerCase();
		if (modName.includes(lower) || modMode === lower || lower === `chain${mod.chainIndex}`) {
			return mod.constrainer;
		}
	}

	return null;
}

/** Check whether a module type can be added under a parent's chain. */
export function checkChainConstraint(
	module: ModuleDefinition,
	chainName: string,
	parentModule: ModuleDefinition | null,
): string | null {
	const lower = chainName.toLowerCase();

	if (lower === "midi" && module.type !== "MidiProcessor") {
		return `${module.id} is a ${module.type}, not a MidiProcessor.`;
	}
	if (lower === "fx" && module.type !== "Effect") {
		return `${module.id} is a ${module.type}, not an Effect.`;
	}
	if (lower === "children" && module.type !== "SoundGenerator") {
		return `${module.id} is a ${module.type}, not a SoundGenerator.`;
	}
	if (lower !== "midi" && lower !== "fx" && lower !== "children" && module.type !== "Modulator") {
		return `${module.id} is a ${module.type}, not a Modulator.`;
	}

	if (parentModule) {
		const constrainerStr = resolveChainConstrainer(parentModule, chainName);
		if (constrainerStr) {
			const cp = new ConstrainerParser(constrainerStr);
			const result = cp.check({ id: module.id, subtype: module.subtype });
			if (!result.ok) {
				return `${module.id} cannot be added to ${parentModule.id}.${chainName}: ${result.error}`;
			}
		}
	}

	return null;
}

// ── Builder validation against moduleList.json ───────────────────────

import { closest } from "fastest-levenshtein";
import type { ModuleDefinition, ModuleList } from "../data.js";
import { ConstrainerParser } from "../constrainer-parser.js";
import type { AddCommand, SetCommand } from "./builder-parser.js";

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

	// 1. Check module type exists (by pretty name or type ID)
	const module = findModuleByName(cmd.moduleType, moduleList);

	if (!module) {
		// Suggest closest match from both pretty names and type IDs
		const allNames = moduleList.modules.flatMap((m) => [m.prettyName, m.id]);
		const closestName = closest(cmd.moduleType, allNames);
		// Map back to the pretty name for display
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

	// 2. Validate chain constraint if parent.chain specified
	if (cmd.chain) {
		const chainError = validateChainConstraint(
			module,
			cmd.chain,
			cmd.parent,
			moduleList,
		);
		if (chainError) {
			errors.push(chainError);
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		suggestions,
	};
}

export function validateSetCommand(
	cmd: SetCommand,
	moduleList: ModuleList,
): ValidationResult {
	const errors: string[] = [];

	// Find the target module by pretty name or type ID (in builder context,
	// target is a module instance name — but for validation we check param
	// against all modules of matching type)
	const module = findModuleByName(cmd.target, moduleList);
	if (!module) {
		// Can't validate without knowing the module type
		return { valid: true, errors: [] };
	}

	// Check parameter exists
	const paramNames = module.parameters.map((p) => p.id);
	const param = module.parameters.find((p) => p.id === cmd.param);

	if (!param) {
		const suggestion = paramNames.length > 0
			? closest(cmd.param, paramNames)
			: undefined;
		let msg = `Unknown parameter "${cmd.param}" for ${module.id}.`;
		if (suggestion) {
			msg += ` Did you mean "${suggestion}"?`;
		}
		errors.push(msg);
		return { valid: false, errors };
	}

	// Check value range
	if (typeof cmd.value === "number") {
		if (cmd.value < param.range.min || cmd.value > param.range.max) {
			errors.push(
				`Value ${cmd.value} out of range for ${module.id}.${param.id} (${param.range.min}–${param.range.max}).`,
			);
		}
	}

	return { valid: errors.length === 0, errors };
}

// ── Internal helpers ──────────────────────────────────────────────

/** Map chain name to the constrainer string from a parent module definition. */
function resolveChainConstrainer(
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
		// midi chains only accept MidiProcessors - no constrainer string needed,
		// validated by type check below
		return null;
	}

	// Modulation chains: match by name (gain, pitch, or internal chain names)
	// or by modulationMode (e.g. GlobalModulatorContainer's "Global Modulators"
	// chain has modulationMode="gain", but its id doesn't contain "gain").
	for (const mod of parentModule.modulation) {
		const modName = mod.id.toLowerCase().replace(/\s+/g, "");
		const modMode = mod.modulationMode?.toLowerCase();
		if (modName.includes(lower) || modMode === lower || lower === `chain${mod.chainIndex}`) {
			return mod.constrainer;
		}
	}

	return null;
}

function validateChainConstraint(
	module: ModuleDefinition,
	chainName: string,
	parentName: string | undefined,
	moduleList: ModuleList,
): string | null {
	const lower = chainName.toLowerCase();

	// Basic type-level check: midi chains only accept MidiProcessors
	if (lower === "midi" && module.type !== "MidiProcessor") {
		return `${module.id} is a ${module.type}, not a MidiProcessor. Only MIDI processors can be added to midi chains.`;
	}

	// fx chains only accept Effects
	if (lower === "fx" && module.type !== "Effect") {
		return `${module.id} is a ${module.type}, not an Effect. Only effects can be added to fx chains.`;
	}

	// children chains only accept SoundGenerators
	if (lower === "children" && module.type !== "SoundGenerator") {
		return `${module.id} is a ${module.type}, not a SoundGenerator. Only sound generators can be added as children.`;
	}

	// Modulation chains (gain, pitch, etc.) only accept Modulators
	if (lower !== "midi" && lower !== "fx" && lower !== "children" && module.type !== "Modulator") {
		return `${module.id} is a ${module.type}, not a Modulator. Only modulators can be added to modulation chains.`;
	}

	// If parent is specified and matches a module type, do constrainer validation
	if (parentName) {
		const parentModule = findModuleByName(parentName, moduleList);
		if (parentModule) {
			const constrainerStr = resolveChainConstrainer(parentModule, chainName);
			if (constrainerStr) {
				const cp = new ConstrainerParser(constrainerStr);
				const result = cp.check({ id: module.id, subtype: module.subtype });
				if (!result.ok) {
					return `${module.id} cannot be added to ${parentName}.${chainName}: ${result.error}`;
				}
			}
		}
	}

	return null;
}

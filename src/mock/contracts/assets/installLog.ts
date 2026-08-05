// Contract for `install_packages_log.json` — install manifest in target project root.
// Spec §3.3.
//
// Read code accepts legacy shapes:
//   - Hash field as JSON number (pre-fix HISE) or as decimal string
//   - Missing Hash on now-text-classified extensions (legacy compat per §4.1)
// Write code always emits the new shape (Hash as decimal string for text files).

import { parseHashField } from "../../../engine/assets/hash.js";

export type InstallMode = "Undefined" | "UninstallOnly" | "StoreDownload" | "LocalFolder";

export type InstallStep =
	| PreprocessorStep
	| ProjectSettingStep
	| FileStep
	| InfoStep
	| ClipboardStep;

export interface PreprocessorStep {
	type: "Preprocessor";
	// macroName -> [oldValue, newValue]; null means "not set".
	data: Record<string, [string | null, string | null]>;
}

export interface ProjectSettingStep {
	type: "ProjectSetting";
	oldValues: Record<string, string>;
	newValues: Record<string, string>;
}

export interface FileStep {
	type: "File";
	target: string;     // forward-slash, project-root-relative
	hash: bigint | null; // null = binary semantics OR legacy missing hash
	hasHashField: boolean; // distinguishes legacy-missing-hash from null/binary
	shared: boolean;
	modified: string;   // ISO-8601 without ms (YYYY-MM-DDTHH:MM:SS)
}

export interface InfoStep {
	type: "Info";
}

export interface ClipboardStep {
	type: "Clipboard";
}

interface InstallLogEntryBase {
	name: string;
	company: string;
	version: string;
	date: string;
	mode: InstallMode;
}

export interface ActiveInstallLogEntry extends InstallLogEntryBase {
	kind: "active";
	steps: InstallStep[];
}

export interface NeedsCleanupLogEntry extends InstallLogEntryBase {
	kind: "needsCleanup";
	skippedFiles: string[]; // absolute paths
}

export type InstallLogEntry = ActiveInstallLogEntry | NeedsCleanupLogEntry;

const VALID_MODES: ReadonlySet<string> = new Set([
	"Undefined", "UninstallOnly", "StoreDownload", "LocalFolder",
]);

export function normalizeInstallLog(value: unknown): InstallLogEntry[] {
	if (!Array.isArray(value)) {
		throw new Error("install_packages_log.json must be a JSON array");
	}
	return value.map((entry, i) => {
		try {
			return normalizeEntry(entry);
		} catch (err) {
			throw new Error(`install_packages_log.json[${i}]: ${(err as Error).message}`);
		}
	});
}

function normalizeEntry(value: unknown): InstallLogEntry {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("entry must be an object");
	}
	const data = value as Record<string, unknown>;
	const base: InstallLogEntryBase = {
		name: requireString(data.Name, "Name"),
		company: requireString(data.Company, "Company"),
		version: requireString(data.Version, "Version"),
		date: requireString(data.Date, "Date"),
		mode: normalizeMode(data.Mode),
	};

	if (data.NeedsCleanup === true) {
		const skippedFiles = data.SkippedFiles;
		if (!Array.isArray(skippedFiles)) {
			throw new Error("NeedsCleanup entry requires SkippedFiles array");
		}
		return {
			...base,
			kind: "needsCleanup",
			skippedFiles: skippedFiles.map((p, i) => {
				if (typeof p !== "string") throw new Error(`SkippedFiles[${i}] must be a string`);
				return p;
			}),
		};
	}

	const stepsRaw = data.Steps;
	if (!Array.isArray(stepsRaw)) {
		throw new Error("entry requires Steps array (or NeedsCleanup: true with SkippedFiles)");
	}
	return {
		...base,
		kind: "active",
		steps: stepsRaw.map((step, i) => {
			try {
				return normalizeStep(step);
			} catch (err) {
				throw new Error(`Steps[${i}]: ${(err as Error).message}`);
			}
		}),
	};
}

// Mode is optional in real HISE install logs — `toInstallLog` (HiseAssetInstaller.cpp)
// writes Name/Company/Version/Date/Steps only. Default to "Undefined" when
// the field is absent or unknown. Numeric values (rare; legacy paths) are
// looked up against the enum order in HiseAssetInstaller.h.
const MODE_BY_INDEX: InstallMode[] = ["Undefined", "UninstallOnly", "StoreDownload", "LocalFolder"];

function normalizeMode(value: unknown): InstallMode {
	if (value === undefined || value === null) return "Undefined";
	if (typeof value === "string") {
		return VALID_MODES.has(value) ? (value as InstallMode) : "Undefined";
	}
	if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < MODE_BY_INDEX.length) {
		return MODE_BY_INDEX[value];
	}
	return "Undefined";
}

function normalizeStep(value: unknown): InstallStep {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("step must be an object");
	}
	const data = value as Record<string, unknown>;
	const type = requireString(data.Type, "Type");
	switch (type) {
		case "Preprocessor": return normalizePreprocessorStep(data);
		case "ProjectSetting": return normalizeProjectSettingStep(data);
		case "File": return normalizeFileStep(data);
		case "Info": return { type: "Info" };
		case "Clipboard": return { type: "Clipboard" };
		default:
			throw new Error(`unknown step Type "${type}"`);
	}
}

function normalizePreprocessorStep(data: Record<string, unknown>): PreprocessorStep {
	const dataField = data.Data;
	if (!dataField || typeof dataField !== "object" || Array.isArray(dataField)) {
		throw new Error("Preprocessor step requires Data object");
	}
	const out: Record<string, [string | null, string | null]> = {};
	for (const [k, raw] of Object.entries(dataField as Record<string, unknown>)) {
		if (!Array.isArray(raw) || raw.length !== 2) {
			throw new Error(`Preprocessor.Data["${k}"] must be a 2-element array`);
		}
		out[k] = [coercePreprocessorValue(raw[0], k, 0), coercePreprocessorValue(raw[1], k, 1)];
	}
	return { type: "Preprocessor", data: out };
}

function coercePreprocessorValue(value: unknown, name: string, idx: number): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	if (typeof value === "boolean") return value ? "1" : "0";
	throw new Error(`Preprocessor.Data["${name}"][${idx}] must be a scalar value`);
}

function normalizeProjectSettingStep(data: Record<string, unknown>): ProjectSettingStep {
	return {
		type: "ProjectSetting",
		oldValues: requireStringMap(data.oldValues, "oldValues"),
		newValues: requireStringMap(data.newValues, "newValues"),
	};
}

function normalizeFileStep(data: Record<string, unknown>): FileStep {
	const target = requireString(data.Target, "Target").replaceAll("\\", "/");
	const modified = requireString(data.Modified, "Modified");
	const hasHashField = data.Hash !== undefined;
	const hash = hasHashField ? parseHashField(data.Hash) : null;
	return { type: "File", target, hash, hasHashField, shared: data.Shared === true, modified };
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value;
}

function requireStringMap(value: unknown, label: string): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (typeof v !== "string") throw new Error(`${label}["${k}"] must be a string`);
		out[k] = v;
	}
	return out;
}

// ── Serialization ─────────────────────────────────────────────────────
//
// Always emits the post-fix shape. Hash is written as a decimal string for
// text files; absent for binary files.

export function serializeInstallLog(entries: InstallLogEntry[]): unknown[] {
	return entries.map(serializeEntry);
}

function serializeEntry(entry: InstallLogEntry): Record<string, unknown> {
	const base: Record<string, unknown> = {
		Name: entry.name,
		Company: entry.company,
		Version: entry.version,
		Date: entry.date,
		Mode: entry.mode,
	};
	if (entry.kind === "needsCleanup") {
		base.NeedsCleanup = true;
		base.SkippedFiles = [...entry.skippedFiles];
		return base;
	}
	base.Steps = entry.steps.map(serializeStep);
	return base;
}

function serializeStep(step: InstallStep): Record<string, unknown> {
	switch (step.type) {
		case "Preprocessor": {
			const data: Record<string, [string | null, string | null]> = {};
			for (const [k, [oldV, newV]] of Object.entries(step.data)) {
				data[k] = [oldV, newV];
			}
			return { Type: "Preprocessor", Data: data };
		}
		case "ProjectSetting":
			return {
				Type: "ProjectSetting",
				oldValues: { ...step.oldValues },
				newValues: { ...step.newValues },
			};
		case "File": {
			const out: Record<string, unknown> = {
				Type: "File",
				Target: step.target,
				Modified: step.modified,
			};
			if (step.hash !== null) out.Hash = step.hash.toString();
			if (step.shared) out.Shared = true;
			return out;
		}
		case "Info": return { Type: "Info" };
		case "Clipboard": return { Type: "Clipboard" };
	}
}

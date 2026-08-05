// Pure plan computation for an asset install.
// Given the resolved source manifest, source files, current target state, and
// existing log, produces an ordered InstallPlan or a refusal variant.
//
// All I/O happens in the runtime layer; this module does no FS/HTTP/HISE work.

import type {
	ActiveInstallLogEntry,
	InstallMode,
	InstallStep,
	PreprocessorStep,
	ProjectSettingStep,
	FileStep,
} from "../../mock/contracts/assets/installLog.js";
import type { PackageInstallManifest } from "../../mock/contracts/assets/packageInstall.js";
import type { OwnershipMap } from "./ownership.js";
import {
	lookupSourcePreprocessor,
	type ProjectInfo,
} from "../../mock/contracts/assets/projectInfoXml.js";
import { compareVersions } from "./semver.js";
import { matchesWildcard, shouldIncludeFile, type CandidateFile } from "./wildcard.js";

// Settings copied verbatim from source -> target. Spec §8 step 6.2.
const PORTABLE_SETTINGS = ["OSXStaticLibs", "WindowsStaticLibFolder"] as const;

export interface SourceFileEntry {
	relPath: string;     // forward-slash, source-relative
	name: string;        // basename
	isText: boolean;     // computed by caller from extension whitelist
	hash: bigint | null; // text files only
	modified: string;    // ISO-8601 without milliseconds
}

export interface InstallPlanInput {
	packageName: string;
	packageCompany: string;
	packageVersion: string;
	mode: InstallMode;
	date: string;
	manifest: PackageInstallManifest;
	sourceFiles: SourceFileEntry[];
	sourceProjectInfo: ProjectInfo;
	// Per macro listed in manifest.preprocessors: current target value (null = unset).
	targetPreprocessors: Record<string, string | null>;
	// Current target settings; only PORTABLE_SETTINGS are read from this map.
	targetSettings: Record<string, string>;
	// Project-relative paths that currently exist on disk in the target project.
	targetExistingPaths: Set<string>;
	ownership: OwnershipMap;
	// Existing install log — used to detect the "already installed" / "different version" cases.
	existingPackageVersion: string | null;
}

export interface InstallPlan {
	entry: ActiveInstallLogEntry;
	// File targets in install order (relative paths). Convenience for the runtime.
	filesToCopy: string[];
	sharedFilesToReuse: string[];
	warnings: string[];
}

export interface InstallConflict {
	target: string;
	reason: string;
}

export type InstallPlanResult =
	| { kind: "ok"; plan: InstallPlan }
	| { kind: "alreadyInstalled"; existingVersion: string }
	| { kind: "needsUpgrade"; existingVersion: string }
	| { kind: "fileConflict"; collisions: InstallConflict[] };

export function computeInstallPlan(input: InstallPlanInput): InstallPlanResult {
	if (input.existingPackageVersion !== null) {
		if (compareVersions(input.existingPackageVersion, input.packageVersion) === 0) {
			return { kind: "alreadyInstalled", existingVersion: input.existingPackageVersion };
		}
		return { kind: "needsUpgrade", existingVersion: input.existingPackageVersion };
	}

	const warnings: string[] = [];
	const steps: InstallStep[] = [];

	// 1. Preprocessor step
	if (input.manifest.preprocessors.length > 0) {
		const data: Record<string, [string | null, string | null]> = {};
		for (const macro of input.manifest.preprocessors) {
			const lookup = lookupSourcePreprocessor(input.sourceProjectInfo, macro);
			warnings.push(...lookup.warnings);
			if (lookup.value === null) {
				warnings.push(`Preprocessor ${macro} declared but not defined in source project_info.xml; skipping`);
				continue;
			}
			const oldValue = input.targetPreprocessors[macro] ?? null;
			data[macro] = [oldValue, lookup.value];
		}
		if (Object.keys(data).length > 0) {
			steps.push({ type: "Preprocessor", data } satisfies PreprocessorStep);
		}
	}

	// 2. ProjectSetting step (portable settings only)
	const settingStep = computeProjectSettingStep(input);
	if (settingStep !== null) steps.push(settingStep);

	// 3. File steps
	const filesToCopy: string[] = [];
	const sharedFilesToReuse: string[] = [];
	const collisions: InstallConflict[] = [];
	for (const f of input.sourceFiles) {
		const candidate: CandidateFile = { relPath: f.relPath, name: f.name };
		if (!shouldIncludeFile(candidate, {
			fileTypes: input.manifest.fileTypes,
			positivePatterns: input.manifest.positiveWildcard,
			negativePatterns: input.manifest.negativeWildcard,
		})) continue;

		const targetRel = f.relPath;
		const shared = isSharedFile(f, candidate, input.manifest);
		const owners = input.ownership.get(targetRel) ?? [];
		if (input.targetExistingPaths.has(targetRel)) {
			if (owners.length === 0) {
				collisions.push({ target: targetRel, reason: `${targetRel}: trying to overwrite a user file` });
				continue;
			}
			const accepted = classifyOwnedExisting(targetRel, shared, f.hash, owners);
			if (accepted !== null) {
				if (accepted === "reuse") sharedFilesToReuse.push(targetRel);
				else collisions.push({ target: targetRel, reason: accepted });
				if (accepted !== "reuse") continue;
			} else {
				filesToCopy.push(targetRel);
			}
		} else {
			filesToCopy.push(targetRel);
		}
		steps.push({
			type: "File",
			target: targetRel,
			hash: f.isText ? f.hash : null,
			hasHashField: f.isText,
			shared,
			modified: f.modified,
		} satisfies FileStep);
	}

	if (collisions.length > 0) {
		return { kind: "fileConflict", collisions };
	}

	// 4. Info step
	if (input.manifest.infoText.length > 0) steps.push({ type: "Info" });
	// 5. Clipboard step
	if (input.manifest.clipboardContent.length > 0) steps.push({ type: "Clipboard" });

	const entry: ActiveInstallLogEntry = {
		kind: "active",
		name: input.packageName,
		company: input.packageCompany,
		version: input.packageVersion,
		date: input.date,
		mode: input.mode,
		steps,
	};
	return { kind: "ok", plan: { entry, filesToCopy, sharedFilesToReuse, warnings } };
}

function isSharedFile(file: SourceFileEntry, candidate: CandidateFile, manifest: PackageInstallManifest): boolean {
	if (!file.isText || file.hash === null) return false;
	return manifest.sharedWildcard.some((pattern) => matchesWildcard(pattern, candidate));
}

function classifyOwnedExisting(
	target: string,
	incomingShared: boolean,
	incomingHash: bigint | null,
	owners: readonly { name: string; version: string; shared: boolean; hash: bigint | null; hasHashField: boolean }[],
): "reuse" | string | null {
	if (owners.length === 0) return null;
	if (!incomingShared) return `${target}: trying to overwrite a file from another package`;
	for (const owner of owners) {
		if (!owner.shared) return `${target}: file conflict with existing package`;
		if (!owner.hasHashField || owner.hash === null || incomingHash === null) return `${target}: file conflict with existing package`;
		if (owner.hash !== incomingHash) return `${target}: shared file content differs from existing package ${owner.name} ${owner.version}`;
	}
	return "reuse";
}

function computeProjectSettingStep(input: InstallPlanInput): ProjectSettingStep | null {
	const oldValues: Record<string, string> = {};
	const newValues: Record<string, string> = {};
	let any = false;
	for (const name of PORTABLE_SETTINGS) {
		const sourceValue = input.sourceProjectInfo.settings[name] ?? "";
		if (sourceValue.length === 0) continue;
		const targetValue = input.targetSettings[name] ?? "";
		oldValues[name] = targetValue;
		newValues[name] = sourceValue;
		any = true;
	}
	if (!any) return null;
	return { type: "ProjectSetting", oldValues, newValues };
}

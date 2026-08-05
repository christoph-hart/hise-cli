// `install <packageName> [version=X.Y.Z] [--dry-run]`. Spec §8.

import {
	type ActiveInstallLogEntry,
	type InstallLogEntry,
} from "../../../mock/contracts/assets/installLog.js";
import type { PackageInstallManifest } from "../../../mock/contracts/assets/packageInstall.js";
import type { AssetEnvironment } from "../environment.js";
import { isoDate } from "../environment.js";
import { hashCode64 } from "../hash.js";
import {
	getProjectFolder,
	HiseError,
	readTargetPreprocessor,
	readTargetSettings,
	writeTargetPreprocessor,
	writeTargetSetting,
} from "../hiseAdapter.js";
import {
	computeInstallPlan,
	type InstallPlan,
	type SourceFileEntry,
} from "../installPlan.js";
import { joinPath } from "../io.js";
import { buildOwnershipMap, otherOwners } from "../ownership.js";
import { compareVersions } from "../semver.js";
import {
	isTextExtension,
	TEXT_FILE_SIZE_CAP,
} from "../textExtensions.js";
import { matchesWildcard, shouldIncludeFile } from "../wildcard.js";
import { readStoredToken } from "./auth.js";
import { readInstallLog, writeInstallLog } from "./log.js";
import { acquireLocal, acquireStore, type AcquiredSource } from "./source.js";
import { uninstall } from "./uninstall.js";

export type InstallSource =
	| { kind: "local"; folder: string }
	| { kind: "store"; packageName: string; version?: string; token?: string };

export interface InstallOptions {
	source: InstallSource;
	dryRun?: boolean;
}

export interface InstallPreview {
	packageName: string;
	packageVersion: string;
	files: string[];
	preprocessors: Record<string, [string | null, string]>;
	settings: Record<string, [string, string]>;
	infoText: string;
	clipboardContent: string;
	warnings: string[];
}

export type InstallResult =
	| {
		kind: "ok";
		entry: ActiveInstallLogEntry;
		warnings: string[];
		infoText: string;
		clipboardWritten: boolean;
		sharedFilesReused: string[];
	}
	| { kind: "alreadyInstalled"; existingVersion: string }
	| { kind: "fileConflict"; collisions: string[] }
	| { kind: "updateConflict"; collisions: string[] }
	| { kind: "invalidPackage"; message: string }
	| { kind: "corruptedLog"; message: string }
	| { kind: "transportError"; message: string }
	| { kind: "needsCleanupFirst"; package: string }
	| { kind: "missingToken" }
	| { kind: "dryRun"; preview: InstallPreview };

const DECODER = new TextDecoder();

export async function install(
	env: AssetEnvironment,
	opts: InstallOptions,
): Promise<InstallResult> {
	let projectFolder: string;
	try {
		projectFolder = await getProjectFolder(env.hise);
	} catch (err) {
		return { kind: "transportError", message: (err as Error).message };
	}

	let log: InstallLogEntry[];
	try {
		log = await readInstallLog(env, projectFolder);
	} catch (err) {
		return { kind: "corruptedLog", message: (err as Error).message };
	}

	let source: AcquiredSource;
	try {
		source = await acquireSource(env, opts.source);
	} catch (err) {
		if (err instanceof MissingTokenError) return { kind: "missingToken" };
		return { kind: "invalidPackage", message: (err as Error).message };
	}

	// First pass: walk source files to compute hashes / metadata. Bytes are
	// not retained — applyPlan walks again to write keepers.
	const sourceFiles: SourceFileEntry[] = [];
	for await (const f of source.walkFiles()) {
		const isText = isTextExtension(f.relPath);
		let hash: bigint | null = null;
		if (isText && f.bytes.byteLength <= TEXT_FILE_SIZE_CAP) {
			hash = hashCode64(DECODER.decode(f.bytes));
		}
		sourceFiles.push({
			relPath: f.relPath,
			name: f.name,
			isText,
			hash,
			modified: isoDate(env.now()),
		});
	}

	// Same-version short-circuit.
	const existing = log.find((e) => e.name === source.packageName);
	if (existing) {
		if (existing.kind === "needsCleanup") {
			return { kind: "needsCleanupFirst", package: source.packageName };
		}
		if (compareVersions(existing.version, source.packageVersion) === 0) {
			return { kind: "alreadyInstalled", existingVersion: existing.version };
		}
		if (!opts.dryRun) {
			const updateConflicts = preflightSharedUpdate(log, source, sourceFiles);
			if (updateConflicts.length > 0) {
				return { kind: "updateConflict", collisions: updateConflicts };
			}
			const ur = await uninstall(env, source.packageName);
			if (ur.kind !== "ok") {
				return { kind: "transportError", message: `Auto-uninstall failed (${ur.kind})` };
			}
			if (ur.needsCleanup) {
				return { kind: "needsCleanupFirst", package: source.packageName };
			}
			try {
				log = await readInstallLog(env, projectFolder);
			} catch (err) {
				return { kind: "corruptedLog", message: (err as Error).message };
			}
		}
	}

	let targetPreprocessors: Record<string, string | null> = {};
	let targetSettings: Record<string, string> = {};
	try {
		for (const macro of source.manifest.preprocessors) {
			targetPreprocessors[macro] = await readTargetPreprocessor(env.hise, macro);
		}
		targetSettings = await readTargetSettings(env.hise);
	} catch (err) {
		return { kind: "transportError", message: (err as Error).message };
	}

	const targetExistingPaths = await collectProjectFiles(env, projectFolder);
	const ownership = buildOwnershipMap(log);

	const planResult = computeInstallPlan({
		packageName: source.packageName,
		packageCompany: source.packageCompany,
		packageVersion: source.packageVersion,
		mode: source.mode,
		date: isoDate(env.now()),
		manifest: source.manifest,
		sourceFiles,
		sourceProjectInfo: source.projectInfo,
		targetPreprocessors,
		targetSettings,
		targetExistingPaths,
		ownership,
		existingPackageVersion: null,
	});

	if (planResult.kind === "fileConflict") {
		return { kind: "fileConflict", collisions: planResult.collisions.map((c) => c.reason) };
	}
	if (planResult.kind !== "ok") {
		return { kind: "transportError", message: `internal: unexpected plan variant ${planResult.kind}` };
	}
	const plan = planResult.plan;

	if (opts.dryRun) {
		return { kind: "dryRun", preview: buildPreview(source.packageName, source.packageVersion, plan, source.manifest) };
	}

	try {
		await applyPlan(env, projectFolder, source, plan);
	} catch (err) {
		return { kind: "transportError", message: (err as Error).message };
	}

	let clipboardWritten = false;
	if (source.manifest.clipboardContent.length > 0 && env.clipboard) {
		try {
			await env.clipboard.write(source.manifest.clipboardContent);
			clipboardWritten = true;
		} catch {
			// non-fatal
		}
	}

	log.push(plan.entry);
	await writeInstallLog(env, projectFolder, log);

	return {
		kind: "ok",
		entry: plan.entry,
		warnings: plan.warnings,
		infoText: source.manifest.infoText,
		clipboardWritten,
		sharedFilesReused: plan.sharedFilesToReuse,
	};
}

function preflightSharedUpdate(
	log: InstallLogEntry[],
	source: AcquiredSource,
	sourceFiles: SourceFileEntry[],
): string[] {
	const ownership = buildOwnershipMap(log);
	const collisions: string[] = [];
	for (const f of sourceFiles) {
		const candidate = { relPath: f.relPath, name: f.name };
		if (!shouldIncludeFile(candidate, {
			fileTypes: source.manifest.fileTypes,
			positivePatterns: source.manifest.positiveWildcard,
			negativePatterns: source.manifest.negativeWildcard,
		})) continue;
		const owners = otherOwners(ownership.get(f.relPath), { name: source.packageName, company: source.packageCompany });
		if (owners.length === 0) continue;
		const incomingShared = f.isText
			&& f.hash !== null
			&& source.manifest.sharedWildcard.some((pattern) => matchesWildcard(pattern, candidate));
		if (!incomingShared) {
			collisions.push(`${f.relPath}: update would stop sharing a file still used by another package`);
			continue;
		}
		for (const owner of owners) {
			if (!owner.shared || !owner.hasHashField || owner.hash === null) {
				collisions.push(`${f.relPath}: installed package has inconsistent shared file ownership`);
				break;
			}
			if (owner.hash !== f.hash) {
				collisions.push(`${f.relPath}: shared file content differs from existing package ${owner.name} ${owner.version}`);
				break;
			}
		}
	}
	return collisions;
}

class MissingTokenError extends Error {}

async function acquireSource(env: AssetEnvironment, src: InstallSource): Promise<AcquiredSource> {
	if (src.kind === "local") return acquireLocal(env, src.folder);
	const token = src.token ?? await readStoredToken(env);
	if (!token) throw new MissingTokenError("Store install requires a token");
	return acquireStore(env, src.packageName, src.version ?? "latest", token);
}

async function applyPlan(
	env: AssetEnvironment,
	projectFolder: string,
	source: AcquiredSource,
	plan: InstallPlan,
): Promise<void> {
	// Apply non-file steps in order. File writes are deferred to a single
	// streaming walk over the source so we don't materialize all bytes at once.
	for (const step of plan.entry.steps) {
		if (step.type === "Preprocessor") {
			for (const [macro, [, newValue]] of Object.entries(step.data)) {
				if (newValue === null) continue;
				try {
					await writeTargetPreprocessor(env.hise, macro, newValue);
				} catch (err) {
					if (err instanceof HiseError) throw err;
					throw err;
				}
			}
			continue;
		}
		if (step.type === "ProjectSetting") {
			for (const [key, val] of Object.entries(step.newValues)) {
				await writeTargetSetting(env.hise, key, val);
			}
		}
	}

	const filesToWrite = new Set<string>(plan.filesToCopy);
	if (filesToWrite.size === 0) return;

	let written = 0;
	for await (const f of source.walkFiles()) {
		if (!filesToWrite.has(f.relPath)) continue;
		const abs = joinPath(projectFolder, f.relPath);
		await env.fs.writeBytes(abs, f.bytes);
		written++;
		if (written === filesToWrite.size) break;
	}
	if (written < filesToWrite.size) {
		throw new Error(`Source file(s) disappeared during apply (wrote ${written} of ${filesToWrite.size})`);
	}
}

async function collectProjectFiles(env: AssetEnvironment, projectFolder: string): Promise<Set<string>> {
	const allAbs = await env.fs.listFiles(projectFolder);
	const out = new Set<string>();
	const prefix = projectFolder.replace(/\/+$/, "") + "/";
	for (const abs of allAbs) {
		if (!abs.startsWith(prefix)) continue;
		out.add(abs.slice(prefix.length));
	}
	return out;
}

function buildPreview(
	packageName: string,
	packageVersion: string,
	plan: InstallPlan,
	manifest: PackageInstallManifest,
): InstallPreview {
	const files: string[] = [];
	const preprocessors: Record<string, [string | null, string]> = {};
	const settings: Record<string, [string, string]> = {};
	for (const step of plan.entry.steps) {
		if (step.type === "File") files.push(step.target);
		else if (step.type === "Preprocessor") {
			for (const [k, [oldV, newV]] of Object.entries(step.data)) {
				if (newV !== null) preprocessors[k] = [oldV, newV];
			}
		} else if (step.type === "ProjectSetting") {
			for (const k of Object.keys(step.newValues)) {
				settings[k] = [step.oldValues[k] ?? "", step.newValues[k]];
			}
		}
	}
	return {
		packageName,
		packageVersion,
		files,
		preprocessors,
		settings,
		infoText: manifest.infoText,
		clipboardContent: manifest.clipboardContent,
		warnings: plan.warnings,
	};
}

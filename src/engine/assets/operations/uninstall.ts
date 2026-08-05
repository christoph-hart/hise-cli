// `uninstall <packageName>`. Spec §9.
//
// Walks Steps in reverse, classifying File steps via hash check and restoring
// preprocessor / setting values via HISE. On preprocessor/setting failure the
// log is left untouched (re-run picks up where we stopped). On modified file
// the entry is rewritten as NeedsCleanup with absolute SkippedFiles.

import {
	type InstallLogEntry,
	type NeedsCleanupLogEntry,
} from "../../../mock/contracts/assets/installLog.js";
import type { AssetEnvironment } from "../environment.js";
import { hashCode64 } from "../hash.js";
import {
	clearTargetPreprocessor,
	getProjectFolder,
	HiseError,
	writeTargetPreprocessor,
	writeTargetSetting,
} from "../hiseAdapter.js";
import { joinPath } from "../io.js";
import { buildOwnershipMap, otherOwners } from "../ownership.js";
import { classifyFileForUninstall, reverseSteps } from "../uninstallPlan.js";
import { isTextExtension } from "../textExtensions.js";
import { readInstallLog, writeInstallLog } from "./log.js";

export type UninstallResult =
	| { kind: "ok"; deleted: string[]; skipped: string[]; keptOwned: string[]; needsCleanup: boolean }
	| { kind: "notFound"; package: string }
	| { kind: "alreadyNeedsCleanup"; package: string }
	| { kind: "transportError"; message: string };

export async function uninstall(
	env: AssetEnvironment,
	packageName: string,
): Promise<UninstallResult> {
	let projectFolder: string;
	try {
		projectFolder = await getProjectFolder(env.hise);
	} catch (err) {
		return { kind: "transportError", message: (err as Error).message };
	}

	const entries = await readInstallLog(env, projectFolder);
	const idx = entries.findIndex((e) => e.name === packageName);
	if (idx < 0) return { kind: "notFound", package: packageName };
	const entry = entries[idx];
	if (entry.kind !== "active") {
		return { kind: "alreadyNeedsCleanup", package: packageName };
	}

	const reversed = reverseSteps(entry.steps);
	const ownership = buildOwnershipMap(entries);
	const deleted: string[] = [];
	const skipped: string[] = [];
	const keptOwned: string[] = [];

	for (const step of reversed) {
		if (step.type === "File") {
			const abs = joinPath(projectFolder, step.target);
			const owners = otherOwners(ownership.get(step.target), { name: entry.name, company: entry.company });
			if (owners.length > 0) {
				keptOwned.push(abs);
				continue;
			}
			let currentHash: bigint | null = null;
			if (step.hasHashField && isTextExtension(step.target) && await env.fs.exists(abs)) {
				try {
					currentHash = hashCode64(await env.fs.readText(abs));
				} catch {
					currentHash = null;
				}
			}
			const action = classifyFileForUninstall(step, currentHash);
			if (action === "delete") {
				if (await env.fs.exists(abs)) {
					try {
						await env.fs.delete(abs);
						deleted.push(abs);
					} catch {
						skipped.push(abs);
					}
				} else {
					deleted.push(abs);
				}
			} else {
				skipped.push(abs);
			}
			continue;
		}
		if (step.type === "Preprocessor") {
			for (const [name, [oldValue]] of Object.entries(step.data)) {
				try {
					if (oldValue === null) {
						await clearTargetPreprocessor(env.hise, name);
					} else {
						await writeTargetPreprocessor(env.hise, name, oldValue);
					}
				} catch (err) {
					if (err instanceof HiseError) {
						return { kind: "transportError", message: err.message };
					}
					throw err;
				}
			}
			continue;
		}
		if (step.type === "ProjectSetting") {
			for (const [key, oldValue] of Object.entries(step.oldValues)) {
				try {
					await writeTargetSetting(env.hise, key, oldValue);
				} catch (err) {
					if (err instanceof HiseError) {
						return { kind: "transportError", message: err.message };
					}
					throw err;
				}
			}
			continue;
		}
		// Info / Clipboard: no-op
	}

	let next: InstallLogEntry[];
	if (skipped.length === 0) {
		next = entries.filter((_, i) => i !== idx);
	} else {
		const cleanupEntry: NeedsCleanupLogEntry = {
			kind: "needsCleanup",
			name: entry.name,
			company: entry.company,
			version: entry.version,
			date: entry.date,
			mode: entry.mode,
			skippedFiles: skipped,
		};
		next = entries.map((e, i) => (i === idx ? cleanupEntry : e));
	}
	await writeInstallLog(env, projectFolder, next);

	return { kind: "ok", deleted, skipped, keptOwned, needsCleanup: skipped.length > 0 };
}

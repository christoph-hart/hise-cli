// ── install_package_maker wizard handlers ───────────────────────────
//
// init: probes /api/status for the project folder, /api/project/preprocessor/list
//   for the dynamic preprocessor multiselect items, and reads any existing
//   package_install.json to prefill the form.
// task: serializes the answers into a PackageInstallManifest and atomically
//   writes <projectFolder>/package_install.json. Optionally registers the
//   project as a local asset source.

import { isEnvelopeResponse, type HiseConnection } from "../../engine/hise.js";
import type {
	InternalInitHandler,
	InternalTaskHandler,
} from "../../engine/wizard/handler-registry.js";
import { isOn } from "../../engine/wizard/types.js";
import {
	ASSET_DIRECTORY_IDS,
	shouldIncludeFile,
} from "../../engine/assets/wildcard.js";
import {
	normalizePackageInstall,
	type PackageInstallManifest,
} from "../../mock/contracts/assets/packageInstall.js";
import { joinPath } from "../../engine/assets/io.js";
import { addLocalFolder } from "../../engine/assets/operations/local.js";
import type { AssetEnvironment } from "../../engine/assets/environment.js";

const PACKAGE_INSTALL_BASENAME = "package_install.json";

const PREPROCESSOR_SCOPE_ORDER = [
	"*.*",
	"Project.*", "Dll.*",
	"Project.Windows", "Project.macOS", "Project.Linux",
	"Dll.Windows", "Dll.macOS", "Dll.Linux",
] as const;

interface ProbedStatus {
	projectFolder: string;
}

async function probeStatus(connection: HiseConnection): Promise<ProbedStatus | null> {
	const res = await connection.get("/api/status");
	if (!isEnvelopeResponse(res) || !res.success) return null;
	const project = (res as { project?: { projectFolder?: unknown } }).project;
	if (!project || typeof project.projectFolder !== "string") return null;
	return { projectFolder: project.projectFolder };
}

async function probeMacros(connection: HiseConnection): Promise<{ name: string; value: string }[]> {
	const res = await connection.get("/api/project/preprocessor/list?OS=all&target=all");
	if (!isEnvelopeResponse(res) || !res.success) return [];
	const scopes = (res as { preprocessors?: Record<string, Record<string, unknown>> }).preprocessors;
	if (!scopes) return [];
	const flat = new Map<string, string>();
	for (const scope of PREPROCESSOR_SCOPE_ORDER) {
		const slot = scopes[scope];
		if (!slot) continue;
		for (const [name, val] of Object.entries(slot)) {
			flat.set(name, String(val));
		}
	}
	return [...flat.entries()]
		.map(([name, value]) => ({ name, value }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function createInstallPackageMakerInitHandler(
	env: AssetEnvironment,
): InternalInitHandler {
	return async () => {
		const defaults: Record<string, string> = {
			FileTypes: ASSET_DIRECTORY_IDS.join(", "),
			PositiveWildcard: "*",
			NegativeWildcard: "",
			SharedWildcard: "",
			Preprocessors: "",
			InfoText: "",
			ClipboardContent: "",
			RegisterAsLocalSource: "true",
		};
		const items: Record<string, string[]> = {};
		const itemDescriptions: Record<string, string[]> = {};

		const status = await probeStatus(env.hise);
		if (!status) {
			return { defaults, items, itemDescriptions };
		}

		const macros = await probeMacros(env.hise);
		items.Preprocessors = macros.map((m) => m.name);
		itemDescriptions.Preprocessors = macros.map((m) => `= ${m.value || "(empty)"}`);

		const existingPath = joinPath(status.projectFolder, PACKAGE_INSTALL_BASENAME);
		if (await env.fs.exists(existingPath)) {
			try {
				const raw = await env.fs.readText(existingPath);
				const parsed = normalizePackageInstall(JSON.parse(raw));
				if (parsed.fileTypes.length > 0) {
					defaults.FileTypes = parsed.fileTypes.join(", ");
				}
				defaults.PositiveWildcard = parsed.positiveWildcard.join(", ");
				defaults.NegativeWildcard = parsed.negativeWildcard.join(", ");
				defaults.SharedWildcard = parsed.sharedWildcard.join(", ");
				defaults.Preprocessors = parsed.preprocessors.join(", ");
				defaults.InfoText = parsed.infoText;
				defaults.ClipboardContent = parsed.clipboardContent;
			} catch {
				// Existing manifest unreadable — keep defaults, user can rewrite.
			}
		}

		return { defaults, items, itemDescriptions };
	};
}

export function createInstallPackageMakerWriteHandler(
	env: AssetEnvironment,
): InternalTaskHandler {
	return async (answers, onProgress) => {
		onProgress({ phase: "write", message: "Resolving project folder…" });
		const status = await probeStatus(env.hise);
		if (!status) {
			return {
				success: false,
				message: "HISE is not reachable. Start HISE before running this wizard.",
			};
		}
		const projectFolder = status.projectFolder;

		const manifest = buildManifest(answers);
		let normalized: PackageInstallManifest;
		try {
			normalized = normalizePackageInstall(manifest);
		} catch (err) {
			return { success: false, message: `Invalid manifest: ${(err as Error).message}` };
		}

		const outputPath = joinPath(projectFolder, PACKAGE_INSTALL_BASENAME);
		onProgress({ phase: "write", message: `Writing ${outputPath}…` });
		const json = JSON.stringify(manifest, null, 2);
		await env.fs.writeAtomic(outputPath, json);

		const logs: string[] = [`Saved package definition to \`${outputPath}\`.`];

		if (isOn(answers.RegisterAsLocalSource)) {
			onProgress({ phase: "write", message: `Adding to your asset library…` });
			try {
				const result = await addLocalFolder(env, projectFolder);
				if (result.kind === "ok") {
					logs.push(`Added this project to your asset library — you can now \`/assets install <name>\` it from any other project.`);
				} else if (result.kind === "duplicate") {
					logs.push(`This project is already in your asset library.`);
				} else {
					logs.push(`Could not add to asset library (${result.kind}).`);
				}
			} catch (err) {
				logs.push(`Could not add to asset library: ${(err as Error).message}`);
			}
		}

		// File preview — count + first N matches.
		onProgress({ phase: "write", message: `Listing files in the package…` });
		const matched = await previewMatchedFiles(env, projectFolder, normalized);
		logs.push("", `### Files in the package (${matched.length})`);
		if (matched.length === 0) {
			logs.push("_No files match the current selection — check the File Types and Wildcards on the Files tab._");
		} else {
			const cap = 50;
			for (const rel of matched.slice(0, cap)) logs.push(`- \`${rel}\``);
			if (matched.length > cap) logs.push(`- _… ${matched.length - cap} more_`);
		}

		// Final manifest.
		logs.push("", `### Package definition`, "```json", json, "```");

		// Hint at next step.
		const projectName = await readProjectName(env, projectFolder);
		if (projectName) {
			logs.push("", `From another project, run \`/assets install ${projectName}\` to try it out.`);
		}

		return {
			success: true,
			message: `Saved package definition to ${outputPath}`,
			logs,
		};
	};
}

async function previewMatchedFiles(
	env: AssetEnvironment,
	projectFolder: string,
	manifest: PackageInstallManifest,
): Promise<string[]> {
	const all = await env.fs.listFiles(projectFolder);
	const prefix = projectFolder.replace(/\/+$/, "") + "/";
	const out: string[] = [];
	for (const abs of all) {
		if (!abs.startsWith(prefix)) continue;
		const rel = abs.slice(prefix.length);
		const name = rel.split("/").at(-1) ?? rel;
		if (shouldIncludeFile({ relPath: rel, name }, {
			fileTypes: manifest.fileTypes,
			positivePatterns: manifest.positiveWildcard,
			negativePatterns: manifest.negativeWildcard,
		})) {
			out.push(rel);
		}
	}
	return out.sort();
}

function buildManifest(answers: Record<string, string>): Record<string, unknown> {
	const fileTypes = parseList(answers.FileTypes ?? "");
	const positiveWildcard = parseList(answers.PositiveWildcard ?? "*");
	const negativeWildcard = parseList(answers.NegativeWildcard ?? "");
	const sharedWildcard = parseList(answers.SharedWildcard ?? "");
	const preprocessors = parseList(answers.Preprocessors ?? "");
	const infoText = answers.InfoText ?? "";
	const clipboardContent = answers.ClipboardContent ?? "";

	const manifest: Record<string, unknown> = {};
	if (fileTypes.length > 0 && fileTypes.length < ASSET_DIRECTORY_IDS.length) {
		manifest.FileTypes = fileTypes;
	}
	if (!(positiveWildcard.length === 1 && positiveWildcard[0] === "*") && positiveWildcard.length > 0) {
		manifest.PositiveWildcard = positiveWildcard;
	}
	if (negativeWildcard.length > 0) manifest.NegativeWildcard = negativeWildcard;
	if (sharedWildcard.length > 0) manifest.SharedWildcard = sharedWildcard;
	if (preprocessors.length > 0) manifest.Preprocessors = preprocessors;
	if (infoText.length > 0) manifest.InfoText = infoText;
	if (clipboardContent.length > 0) manifest.ClipboardContent = clipboardContent;
	return manifest;
}

function parseList(raw: string): string[] {
	return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function readProjectName(env: AssetEnvironment, projectFolder: string): Promise<string | null> {
	try {
		const xml = await env.fs.readText(joinPath(projectFolder, "project_info.xml"));
		const m = /<Name\b[^>]*\bvalue\s*=\s*"([^"]*)"/i.exec(xml);
		return m?.[1] ?? null;
	} catch {
		return null;
	}
}

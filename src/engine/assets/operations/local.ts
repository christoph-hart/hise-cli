// Local folder add / remove / list. Spec §11.

import { parseProjectInfoXml } from "../../../mock/contracts/assets/projectInfoXml.js";
import { parseUserInfoXml } from "../../../mock/contracts/assets/userInfoXml.js";
import type { AssetEnvironment } from "../environment.js";
import { dirname, joinPath } from "../io.js";

export const LOCAL_FOLDERS_BASENAME = "localAssetFolders.js";

export function localFoldersPath(env: AssetEnvironment): string {
	return joinPath(env.appData.hiseDir(), LOCAL_FOLDERS_BASENAME);
}

export async function readLocalFolders(env: AssetEnvironment): Promise<string[]> {
	const path = localFoldersPath(env);
	if (!await env.fs.exists(path)) return [];
	const raw = await env.fs.readText(path);
	const trimmed = raw.trim();
	if (trimmed.length === 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (err) {
		throw new Error(`${LOCAL_FOLDERS_BASENAME} is not valid JSON: ${(err as Error).message}`);
	}
	if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== "string")) {
		throw new Error(`${LOCAL_FOLDERS_BASENAME} must be a JSON array of strings`);
	}
	return dedupeFolders((parsed as string[]).map(normalizeLocalFolderPath));
}

export async function writeLocalFolders(env: AssetEnvironment, folders: string[]): Promise<void> {
	await env.fs.writeText(localFoldersPath(env), JSON.stringify(dedupeFolders(folders.map(normalizeLocalFolderPath)), null, 2));
}

export interface LocalFolderInfo {
	folder: string;
	name: string | null;
	version: string | null;
	company: string | null;
}

export async function describeLocalFolder(env: AssetEnvironment, folder: string): Promise<LocalFolderInfo> {
	folder = normalizeLocalFolderPath(folder);
	const xmlPath = joinPath(folder, "project_info.xml");
	const userPath = joinPath(folder, "user_info.xml");
	let name: string | null = null;
	let version: string | null = null;
	let company: string | null = null;
	if (await env.fs.exists(xmlPath)) {
		const info = parseProjectInfoXml(await env.fs.readText(xmlPath));
		name = info.settings.Name ?? null;
		version = info.settings.Version ?? null;
	}
	if (await env.fs.exists(userPath)) {
		company = parseUserInfoXml(await env.fs.readText(userPath)).company;
	}
	return { folder, name, version, company };
}

export type AddLocalResult =
	| { kind: "ok"; folder: string; info: LocalFolderInfo }
	| { kind: "duplicate"; folder: string }
	| { kind: "missingProjectInfo"; folder: string };

export async function addLocalFolder(env: AssetEnvironment, input: string): Promise<AddLocalResult> {
	const folder = normalizeLocalFolderPath(input);
	if (!await env.fs.exists(joinPath(folder, "project_info.xml"))) {
		return { kind: "missingProjectInfo", folder };
	}
	const list = await readLocalFolders(env);
	if (list.some((existing) => sameFolder(existing, folder))) {
		return { kind: "duplicate", folder };
	}
	list.push(folder);
	await writeLocalFolders(env, list);
	return { kind: "ok", folder, info: await describeLocalFolder(env, folder) };
}

export type RemoveLocalResult =
	| { kind: "ok"; folder: string }
	| { kind: "notFound"; query: string };

export async function removeLocalFolder(env: AssetEnvironment, query: string): Promise<RemoveLocalResult> {
	const list = await readLocalFolders(env);
	const normalizedQuery = normalizeLocalFolderPath(query);
	let idx = list.findIndex((folder) => sameFolder(folder, normalizedQuery));
	if (idx < 0) {
		for (let i = 0; i < list.length; i++) {
			const xmlPath = joinPath(list[i], "project_info.xml");
			if (!await env.fs.exists(xmlPath)) continue;
			const info = parseProjectInfoXml(await env.fs.readText(xmlPath));
			if (info.settings.Name === query) { idx = i; break; }
		}
	}
	if (idx < 0) return { kind: "notFound", query };
	const removed = list[idx];
	list.splice(idx, 1);
	await writeLocalFolders(env, list);
	return { kind: "ok", folder: removed };
}

function normalizeLocalFolderPath(input: string): string {
	let folder = input.trim().replaceAll("\\", "/").replace(/\/+$/, "");
	// User may have passed the package_install.json file directly.
	if (folder.endsWith("/package_install.json")) folder = dirname(folder);
	return folder;
}

function sameFolder(a: string, b: string): boolean {
	return folderKey(a) === folderKey(b);
}

function folderKey(folder: string): string {
	return normalizeLocalFolderPath(folder).toLowerCase();
}

function dedupeFolders(folders: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const folder of folders) {
		const key = folderKey(folder);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(folder);
	}
	return out;
}

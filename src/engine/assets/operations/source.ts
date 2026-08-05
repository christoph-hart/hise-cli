// Source acquisition for asset install. Two flavors:
//   - local: source is a folder on disk, accessed through env.fs
//   - store: source is a gitea zipball, downloaded via env.http and extracted
//     via env.zip
//
// Files are exposed via a `walkFiles()` async iterable. Callers iterate
// once to compute hashes and again to write keepers; only one file's bytes
// are held in memory at a time. The store flavor still buffers the full
// zip in memory (Tier 2 streaming would push that to disk).

import {
	normalizePackageInstall,
	type PackageInstallManifest,
} from "../../../mock/contracts/assets/packageInstall.js";
import {
	parseProjectInfoXml,
	type ProjectInfo,
} from "../../../mock/contracts/assets/projectInfoXml.js";
import { parseUserInfoXml } from "../../../mock/contracts/assets/userInfoXml.js";
import {
	normalizeGiteaTags,
	type GiteaTag,
} from "../../../mock/contracts/assets/giteaTag.js";
import { normalizeStoreCatalog } from "../../../mock/contracts/assets/storeProduct.js";
import type { InstallMode } from "../../../mock/contracts/assets/installLog.js";
import type { AssetEnvironment } from "../environment.js";
import { joinPath } from "../io.js";
import { pickLatest } from "../semver.js";

export interface SourceFile {
	relPath: string; // forward-slash, source-root-relative
	name: string;    // basename
	bytes: Uint8Array;
}

export interface AcquiredSource {
	packageName: string;
	packageVersion: string;
	packageCompany: string;
	manifest: PackageInstallManifest;
	projectInfo: ProjectInfo;
	mode: InstallMode;
	// Lazy iterator over source files. Safe to call multiple times — each call
	// re-walks the underlying source (re-listing the local folder or re-opening
	// the buffered zip). Each yielded entry holds bytes for that one file only.
	walkFiles(): AsyncIterable<SourceFile>;
}

const DECODER = new TextDecoder();

export async function acquireLocal(env: AssetEnvironment, folder: string): Promise<AcquiredSource> {
	const f = folder.replaceAll("\\", "/").replace(/\/+$/, "");
	const projectXmlPath = joinPath(f, "project_info.xml");
	if (!await env.fs.exists(projectXmlPath)) {
		throw new Error(`Local source missing project_info.xml: ${f}`);
	}
	const packageJsonPath = joinPath(f, "package_install.json");
	if (!await env.fs.exists(packageJsonPath)) {
		throw new Error(`Local source missing package_install.json: ${f}`);
	}

	const projectInfo = parseProjectInfoXml(await env.fs.readText(projectXmlPath));
	const userInfoPath = joinPath(f, "user_info.xml");
	const userInfo = await env.fs.exists(userInfoPath)
		? parseUserInfoXml(await env.fs.readText(userInfoPath))
		: { company: null };
	const manifest = normalizePackageInstall(JSON.parse(await env.fs.readText(packageJsonPath)));

	return {
		packageName: requireSetting(projectInfo, "Name"),
		packageVersion: requireSetting(projectInfo, "Version"),
		packageCompany: userInfo.company ?? "",
		manifest,
		projectInfo,
		mode: "LocalFolder",
		walkFiles: () => walkLocalFiles(env, f),
	};
}

async function* walkLocalFiles(env: AssetEnvironment, root: string): AsyncIterable<SourceFile> {
	const all = await env.fs.listFiles(root);
	for (const abs of all) {
		const rel = relativize(root, abs);
		if (rel === null) continue;
		yield {
			relPath: rel,
			name: basename(rel),
			bytes: await env.fs.readBytes(abs),
		};
	}
}

export async function acquireStore(
	env: AssetEnvironment,
	packageName: string,
	versionInput: string,
	token: string,
): Promise<AcquiredSource> {
	const catalogRes = await env.http.request({
		method: "GET",
		url: "https://store.hise.dev/api/products/",
	});
	if (catalogRes.status !== 200) {
		throw new Error(`Store catalog request failed: HTTP ${catalogRes.status}`);
	}
	const catalog = normalizeStoreCatalog(await catalogRes.json());
	const product = catalog.find((p) => p.repoId === packageName || p.productName === packageName);
	if (!product) {
		throw new Error(`Package not found in store catalog: ${packageName}`);
	}

	const tagsUrl = `https://git.hise.dev/api/v1/repos/${product.vendor}/${product.repoId}/tags`;
	const tagsRes = await env.http.request({
		method: "GET",
		url: tagsUrl,
		headers: { Authorization: `Bearer ${token}` },
	});
	if (tagsRes.status === 401) throw new Error("Unauthorized (HTTP 401) — check token");
	if (tagsRes.status !== 200) throw new Error(`Tag list failed: HTTP ${tagsRes.status}`);
	const tags = normalizeGiteaTags(await tagsRes.json());

	const tag = selectTag(tags, versionInput);
	if (!tag) throw new Error(`Version "${versionInput}" not found for package ${packageName}`);

	const zipRes = await env.http.request({
		method: "GET",
		url: tag.zipballUrl,
		headers: { Authorization: `Bearer ${token}` },
	});
	if (zipRes.status !== 200) throw new Error(`Zipball download failed: HTTP ${zipRes.status}`);
	const zipBytes = await zipRes.bytes();

	// First pass: locate the package_install.json to determine the strip prefix
	// and parse manifest + XMLs. Only these small entries get held in memory
	// past this function — the rest are re-read on each walkFiles() call.
	const { relativePath, manifest, projectInfo, userInfo } = await readManifestPass(env, zipBytes);

	return {
		packageName: requireSetting(projectInfo, "Name"),
		packageVersion: tag.name,
		packageCompany: userInfo.company ?? "",
		manifest,
		projectInfo,
		mode: "StoreDownload",
		walkFiles: () => walkStoreFiles(env, zipBytes, relativePath),
	};
}

interface ManifestPassResult {
	relativePath: string;
	manifest: PackageInstallManifest;
	projectInfo: ProjectInfo;
	userInfo: { company: string | null };
}

async function readManifestPass(env: AssetEnvironment, zipBytes: Uint8Array): Promise<ManifestPassResult> {
	const archive = await env.zip.open(zipBytes);
	let relativePath: string | null = null;
	let manifestRaw: Uint8Array | null = null;
	let projectXmlRaw: Uint8Array | null = null;
	let userXmlRaw: Uint8Array | null = null;

	for await (const entry of archive.entries()) {
		if (entry.isDirectory) continue;
		const path = entry.path;
		const baseFile = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
		// Capture the strip prefix from package_install.json's parent.
		if (baseFile === "package_install.json" && relativePath === null) {
			relativePath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
			manifestRaw = await entry.read();
			continue;
		}
		if (baseFile === "project_info.xml" && projectXmlRaw === null) {
			projectXmlRaw = await entry.read();
			continue;
		}
		if (baseFile === "user_info.xml" && userXmlRaw === null) {
			userXmlRaw = await entry.read();
			continue;
		}
	}
	await archive.close();

	if (relativePath === null || manifestRaw === null) {
		throw new Error("Zipball missing package_install.json (InvalidPackage)");
	}
	if (projectXmlRaw === null) {
		throw new Error("Source missing project_info.xml");
	}
	const manifest = normalizePackageInstall(JSON.parse(DECODER.decode(manifestRaw)));
	const projectInfo = parseProjectInfoXml(DECODER.decode(projectXmlRaw));
	const userInfo = userXmlRaw
		? parseUserInfoXml(DECODER.decode(userXmlRaw))
		: { company: null };

	return { relativePath, manifest, projectInfo, userInfo };
}

async function* walkStoreFiles(
	env: AssetEnvironment,
	zipBytes: Uint8Array,
	relativePath: string,
): AsyncIterable<SourceFile> {
	const archive = await env.zip.open(zipBytes);
	const prefix = relativePath.length > 0 ? relativePath + "/" : "";
	try {
		for await (const entry of archive.entries()) {
			if (entry.isDirectory) continue;
			if (prefix.length > 0 && !entry.path.startsWith(prefix)) continue;
			const rel = entry.path.slice(prefix.length);
			if (rel.length === 0) continue;
			yield {
				relPath: rel,
				name: basename(rel),
				bytes: await entry.read(),
			};
		}
	} finally {
		await archive.close();
	}
}

function selectTag(tags: GiteaTag[], versionInput: string): GiteaTag | undefined {
	if (versionInput === "latest") {
		const latestName = pickLatest(tags.map((t) => t.name));
		if (!latestName) return undefined;
		return tags.find((t) => t.name === latestName);
	}
	return tags.find((t) => t.name === versionInput);
}

function requireSetting(info: ProjectInfo, key: string): string {
	const v = info.settings[key];
	if (!v) throw new Error(`Source project_info.xml missing required setting: ${key}`);
	return v;
}

function relativize(root: string, abs: string): string | null {
	const r = root.replaceAll("\\", "/").replace(/\/+$/, "") + "/";
	const normalizedAbs = abs.replaceAll("\\", "/");
	if (!normalizedAbs.startsWith(r)) return null;
	return normalizedAbs.slice(r.length);
}

function basename(p: string): string {
	const i = p.lastIndexOf("/");
	return i < 0 ? p : p.slice(i + 1);
}

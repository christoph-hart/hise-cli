import { describe, expect, it } from "vitest";
import { MockHiseConnection } from "../../hise.js";
import { MockAppDataPaths, MockFilesystem, MockHttpClient, MockZipReader } from "../../../mock/assetIo.js";
import type { AssetEnvironment } from "../environment.js";
import {
	addLocalFolder,
	describeLocalFolder,
	localFoldersPath,
	readLocalFolders,
	removeLocalFolder,
	writeLocalFolders,
} from "./local.js";

function makeEnv() {
	const fs = new MockFilesystem();
	const env: AssetEnvironment = {
		fs,
		http: new MockHttpClient(),
		zip: new MockZipReader(),
		appData: new MockAppDataPaths(),
		hise: new MockHiseConnection(),
		now: () => new Date("2026-04-09T14:30:00Z"),
	};
	return { env, fs };
}

const PROJECT_XML = `<?xml version="1.0"?>
<ProjectSettings>
  <Name value="MyLib"/>
  <Version value="2.1.0"/>
</ProjectSettings>`;

const USER_XML = `<?xml version="1.0"?>
<UserSettings>
  <Company value="vendor_username"/>
</UserSettings>`;

describe("readLocalFolders", () => {
	it("returns empty when file missing", async () => {
		const { env } = makeEnv();
		expect(await readLocalFolders(env)).toEqual([]);
	});

	it("parses JSON array", async () => {
		const { env, fs } = makeEnv();
		fs.seedText(localFoldersPath(env), JSON.stringify(["/a", "/b"]));
		expect(await readLocalFolders(env)).toEqual(["/a", "/b"]);
	});

	it("normalizes and deduplicates slash variants on read", async () => {
		const { env, fs } = makeEnv();
		fs.seedText(localFoldersPath(env), JSON.stringify([
			"D:\\Development\\Projekte\\MyLib",
			"D:/Development/Projekte/MyLib/",
		]));
		expect(await readLocalFolders(env)).toEqual(["D:/Development/Projekte/MyLib"]);
	});

	it("rejects non-array", async () => {
		const { env, fs } = makeEnv();
		fs.seedText(localFoldersPath(env), '"not an array"');
		await expect(readLocalFolders(env)).rejects.toThrow(/JSON array of strings/);
	});

	it("rejects malformed JSON", async () => {
		const { env, fs } = makeEnv();
		fs.seedText(localFoldersPath(env), "not json");
		await expect(readLocalFolders(env)).rejects.toThrow(/valid JSON/);
	});
});

describe("addLocalFolder", () => {
	it("adds folder containing project_info.xml", async () => {
		const { env, fs } = makeEnv();
		fs.seedText("/proj/MyLib/project_info.xml", PROJECT_XML);
		fs.seedText("/proj/MyLib/user_info.xml", USER_XML);
		const r = await addLocalFolder(env, "/proj/MyLib");
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.info).toEqual({
			folder: "/proj/MyLib",
			name: "MyLib",
			version: "2.1.0",
			company: "vendor_username",
		});
		expect(await readLocalFolders(env)).toEqual(["/proj/MyLib"]);
	});

	it("strips trailing /package_install.json", async () => {
		const { env, fs } = makeEnv();
		fs.seedText("/proj/MyLib/project_info.xml", PROJECT_XML);
		const r = await addLocalFolder(env, "/proj/MyLib/package_install.json");
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.folder).toBe("/proj/MyLib");
	});

	it("returns missingProjectInfo when no XML", async () => {
		const { env } = makeEnv();
		const r = await addLocalFolder(env, "/empty");
		expect(r).toEqual({ kind: "missingProjectInfo", folder: "/empty" });
	});

	it("returns duplicate when already in list", async () => {
		const { env, fs } = makeEnv();
		fs.seedText("/proj/MyLib/project_info.xml", PROJECT_XML);
		await addLocalFolder(env, "/proj/MyLib");
		const r = await addLocalFolder(env, "/proj/MyLib");
		expect(r).toEqual({ kind: "duplicate", folder: "/proj/MyLib" });
	});

	it("returns duplicate for Windows slash variants", async () => {
		const { env, fs } = makeEnv();
		fs.seedText("D:/Development/Projekte/MyLib/project_info.xml", PROJECT_XML);
		await addLocalFolder(env, "D:\\Development\\Projekte\\MyLib");
		const r = await addLocalFolder(env, "D:/Development/Projekte/MyLib/");
		expect(r).toEqual({ kind: "duplicate", folder: "D:/Development/Projekte/MyLib" });
		expect(await readLocalFolders(env)).toEqual(["D:/Development/Projekte/MyLib"]);
	});
});

describe("removeLocalFolder", () => {
	it("removes by absolute path", async () => {
		const { env } = makeEnv();
		await writeLocalFolders(env, ["/proj/MyLib", "/proj/Other"]);
		const r = await removeLocalFolder(env, "/proj/MyLib");
		expect(r).toEqual({ kind: "ok", folder: "/proj/MyLib" });
		expect(await readLocalFolders(env)).toEqual(["/proj/Other"]);
	});

	it("removes by normalized path variant", async () => {
		const { env } = makeEnv();
		await writeLocalFolders(env, ["D:/Development/Projekte/MyLib", "/proj/Other"]);
		const r = await removeLocalFolder(env, "D:\\Development\\Projekte\\MyLib\\");
		expect(r).toEqual({ kind: "ok", folder: "D:/Development/Projekte/MyLib" });
		expect(await readLocalFolders(env)).toEqual(["/proj/Other"]);
	});

	it("removes by package name", async () => {
		const { env, fs } = makeEnv();
		fs.seedText("/proj/MyLib/project_info.xml", PROJECT_XML);
		await writeLocalFolders(env, ["/proj/MyLib"]);
		const r = await removeLocalFolder(env, "MyLib");
		expect(r.kind).toBe("ok");
		expect(await readLocalFolders(env)).toEqual([]);
	});

	it("notFound when no match", async () => {
		const { env } = makeEnv();
		await writeLocalFolders(env, ["/proj/MyLib"]);
		const r = await removeLocalFolder(env, "Nope");
		expect(r).toEqual({ kind: "notFound", query: "Nope" });
	});
});

describe("describeLocalFolder", () => {
	it("returns nulls when XMLs missing", async () => {
		const { env } = makeEnv();
		expect(await describeLocalFolder(env, "/empty")).toEqual({
			folder: "/empty",
			name: null,
			version: null,
			company: null,
		});
	});
});

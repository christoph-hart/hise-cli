import { describe, expect, it } from "vitest";
import { MockHiseConnection } from "../../hise.js";
import {
	MockAppDataPaths,
	MockFilesystem,
	MockHttpClient,
	MockZipReader,
} from "../../../mock/assetIo.js";
import type { AssetEnvironment } from "../environment.js";
import { hashCode64 } from "../hash.js";
import { tokenFilePath } from "./auth.js";
import { install } from "./install.js";
import { installLogPath, readInstallLog } from "./log.js";

const PROJECT = "/projects/Demo";

function statusFixture() {
	return {
		success: true,
		server: { version: "1.0", buildCommit: "x" },
		project: { name: "Demo", projectFolder: PROJECT, scriptsFolder: `${PROJECT}/Scripts` },
		scriptProcessors: [],
		logs: [],
		errors: [],
	};
}

interface CapturingClipboard {
	text: string;
	write(t: string): void;
}

function makeEnv() {
	const fs = new MockFilesystem();
	const hise = new MockHiseConnection();
	const http = new MockHttpClient();
	const zip = new MockZipReader();
	hise.onGet("/api/status", () => statusFixture());
	hise.onGet("/api/project/settings/list", () => ({
		success: true,
		settings: { OSXStaticLibs: { value: "" }, WindowsStaticLibFolder: { value: "" } },
		logs: [],
		errors: [],
	}));
	hise.onGet("/api/project/preprocessor/list?OS=all&target=all", () => ({
		success: true,
		preprocessors: {},
		logs: [],
		errors: [],
	}));
	hise.onPost("/api/project/preprocessor/set", () => ({
		success: true, result: "OK", logs: [], errors: [],
	}));
	hise.onPost("/api/project/settings/set", () => ({
		success: true, result: "OK", logs: [], errors: [],
	}));
	const clipboard: CapturingClipboard = {
		text: "",
		write(t: string) { this.text = t; },
	};
	const env: AssetEnvironment = {
		fs,
		http,
		zip,
		appData: new MockAppDataPaths(),
		hise,
		now: () => new Date("2026-04-09T14:30:00Z"),
		clipboard,
	};
	return { env, fs, hise, http, zip, clipboard };
}

const SOURCE_PROJECT_XML = `<?xml version="1.0"?>
<ProjectSettings>
  <Name value="synth_blocks"/>
  <Version value="1.0.0"/>
  <ExtraDefinitionsWindows value="HISE_NUM_CHANNELS=4"/>
  <ExtraDefinitionsOSX value="HISE_NUM_CHANNELS=4"/>
  <ExtraDefinitionsLinux value=""/>
  <ExtraDefinitionsNetworkDll value=""/>
  <OSXStaticLibs value=""/>
  <WindowsStaticLibFolder value=""/>
</ProjectSettings>`;

const SOURCE_USER_XML = `<?xml version="1.0"?>
<UserSettings><Company value="vendor_username"/></UserSettings>`;

function seedLocalSource(fs: MockFilesystem, root: string, manifest: object): string {
	fs.seedText(`${root}/project_info.xml`, SOURCE_PROJECT_XML);
	fs.seedText(`${root}/user_info.xml`, SOURCE_USER_XML);
	fs.seedText(`${root}/package_install.json`, JSON.stringify(manifest));
	return root;
}

describe("install (local)", () => {
	it("happy path: copies files, writes log entry, marks ok", async () => {
		const { env, fs } = makeEnv();
		const src = seedLocalSource(fs, "/source", {});
		fs.seedText(`${src}/Scripts/main.js`, "var x = 1;");
		fs.seedText(`${src}/Images/logo.png`, "fakebinary");

		const r = await install(env, { source: { kind: "local", folder: src } });
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.entry.name).toBe("synth_blocks");
		expect(r.entry.version).toBe("1.0.0");
		expect(r.entry.mode).toBe("LocalFolder");

		expect(await fs.readText(`${PROJECT}/Scripts/main.js`)).toBe("var x = 1;");
		expect(await fs.exists(`${PROJECT}/Images/logo.png`)).toBe(true);

		const log = await readInstallLog(env, PROJECT);
		expect(log).toHaveLength(1);
		expect(log[0].name).toBe("synth_blocks");
	});

	it("text file gets recorded hash; binary file omits Hash", async () => {
		const { env, fs } = makeEnv();
		const content = "var hello = 1;";
		const src = seedLocalSource(fs, "/source", {});
		fs.seedText(`${src}/Scripts/a.js`, content);
		fs.seedBytes(`${src}/Images/logo.png`, new Uint8Array([1, 2, 3]));

		const r = await install(env, { source: { kind: "local", folder: src } });
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		const fileSteps = r.entry.steps.filter((s) => s.type === "File");
		const jsStep = fileSteps.find((s) => s.target === "Scripts/a.js");
		const pngStep = fileSteps.find((s) => s.target === "Images/logo.png");
		expect(jsStep?.hasHashField).toBe(true);
		expect(jsStep?.hash).toBe(hashCode64(content));
		expect(pngStep?.hasHashField).toBe(false);
		expect(pngStep?.hash).toBeNull();
	});

	it("respects FileTypes filter and reserved files", async () => {
		const { env, fs } = makeEnv();
		const src = seedLocalSource(fs, "/source", { FileTypes: ["Scripts"] });
		fs.seedText(`${src}/Scripts/a.js`, "x");
		fs.seedText(`${src}/Images/skipped.png`, "y");

		const r = await install(env, { source: { kind: "local", folder: src } });
		expect(r.kind).toBe("ok");
		expect(await fs.exists(`${PROJECT}/Scripts/a.js`)).toBe(true);
		expect(await fs.exists(`${PROJECT}/Images/skipped.png`)).toBe(false);
	});

	it("installs from a Windows-style local source path", async () => {
		const { env, fs } = makeEnv();
		seedLocalSource(fs, "D:/Development/Projekte/source", { UseFileTypeFilter: true, FileTypeFilter: ["Scripts"] });
		fs.seedText("D:/Development/Projekte/source/Scripts/a.js", "x");
		fs.seedText("D:/Development/Projekte/source/Images/skipped.png", "y");

		const r = await install(env, { source: { kind: "local", folder: "D:\\Development\\Projekte\\source" } });
		expect(r.kind).toBe("ok");
		expect(await fs.exists(`${PROJECT}/Scripts/a.js`)).toBe(true);
		expect(await fs.exists(`${PROJECT}/Images/skipped.png`)).toBe(false);
	});

	it("applies preprocessor step", async () => {
		const { env, fs, hise } = makeEnv();
		const writes: unknown[] = [];
		hise.onPost("/api/project/preprocessor/set", (body) => {
			writes.push(body);
			return { success: true, result: "OK", logs: [], errors: [] };
		});
		const src = seedLocalSource(fs, "/source", { Preprocessors: ["HISE_NUM_CHANNELS"] });
		fs.seedText(`${src}/Scripts/x.js`, "x");

		const r = await install(env, { source: { kind: "local", folder: src } });
		expect(r.kind).toBe("ok");
		expect(writes).toEqual([
			{ OS: "all", target: "all", preprocessor: "HISE_NUM_CHANNELS", value: "4" },
		]);
	});

	it("returns alreadyInstalled when same version recorded", async () => {
		const { env, fs } = makeEnv();
		const src = seedLocalSource(fs, "/source", {});
		fs.seedText(`${src}/Scripts/x.js`, "x");
		fs.seedText(installLogPath(PROJECT), JSON.stringify([{
			Name: "synth_blocks", Company: "v", Version: "1.0.0",
			Date: "2026-01-01T00:00:00", Mode: "LocalFolder",
			Steps: [],
		}]));

		const r = await install(env, { source: { kind: "local", folder: src } });
		expect(r).toEqual({ kind: "alreadyInstalled", existingVersion: "1.0.0" });
	});

	it("auto-uninstalls older version then installs new", async () => {
		const { env, fs } = makeEnv();
		const src = seedLocalSource(fs, "/source", {});
		fs.seedText(`${src}/Scripts/main.js`, "new");

		// Pre-existing 0.9 install with file present and matching hash.
		const oldContent = "old";
		const oldHash = hashCode64(oldContent).toString();
		fs.seedText(`${PROJECT}/Scripts/old.js`, oldContent);
		fs.seedText(installLogPath(PROJECT), JSON.stringify([{
			Name: "synth_blocks", Company: "v", Version: "0.9.0",
			Date: "2026-01-01T00:00:00", Mode: "LocalFolder",
			Steps: [
				{ Type: "File", Target: "Scripts/old.js", Hash: oldHash, Modified: "2026-01-01T00:00:00" },
			],
		}]));

		const r = await install(env, { source: { kind: "local", folder: src } });
		expect(r.kind).toBe("ok");
		expect(await fs.exists(`${PROJECT}/Scripts/old.js`)).toBe(false);
		expect(await fs.exists(`${PROJECT}/Scripts/main.js`)).toBe(true);

		const log = await readInstallLog(env, PROJECT);
		expect(log).toHaveLength(1);
		expect(log[0].version).toBe("1.0.0");
	});

	it("blocks upgrade when previous version had user-modified files", async () => {
		const { env, fs } = makeEnv();
		const src = seedLocalSource(fs, "/source", {});
		fs.seedText(`${src}/Scripts/main.js`, "new");

		// Pre-existing 0.9 with hash that won't match user-edited file.
		const recordedHash = hashCode64("expected").toString();
		fs.seedText(`${PROJECT}/Scripts/old.js`, "user edited");
		fs.seedText(installLogPath(PROJECT), JSON.stringify([{
			Name: "synth_blocks", Company: "v", Version: "0.9.0",
			Date: "2026-01-01T00:00:00", Mode: "LocalFolder",
			Steps: [{ Type: "File", Target: "Scripts/old.js", Hash: recordedHash, Modified: "2026-01-01T00:00:00" }],
		}]));

		const r = await install(env, { source: { kind: "local", folder: src } });
		expect(r).toEqual({ kind: "needsCleanupFirst", package: "synth_blocks" });
	});

	it("blocks upgrade before uninstall when shared file content would change", async () => {
		const { env, fs } = makeEnv();
		const src = seedLocalSource(fs, "/source", { SharedWildcard: ["Scripts/Common/*"] });
		fs.seedText(`${src}/Scripts/Common/util.js`, "new shared");
		fs.seedText(`${PROJECT}/Scripts/Common/util.js`, "old shared");
		fs.seedText(installLogPath(PROJECT), JSON.stringify([
			{
				Name: "synth_blocks", Company: "vendor_username", Version: "0.9.0",
				Date: "2026-01-01T00:00:00", Mode: "LocalFolder",
				Steps: [
					{ Type: "File", Target: "Scripts/Common/util.js", Hash: hashCode64("old shared").toString(), Shared: true, Modified: "2026-01-01T00:00:00" },
				],
			},
			{
				Name: "other_pack", Company: "vendor_username", Version: "1.0.0",
				Date: "2026-01-01T00:00:00", Mode: "LocalFolder",
				Steps: [
					{ Type: "File", Target: "Scripts/Common/util.js", Hash: hashCode64("old shared").toString(), Shared: true, Modified: "2026-01-01T00:00:00" },
				],
			},
		]));

		const r = await install(env, { source: { kind: "local", folder: src } });
		expect(r.kind).toBe("updateConflict");
		if (r.kind !== "updateConflict") return;
		expect(r.collisions[0]).toMatch(/shared file content differs/);
		const log = await readInstallLog(env, PROJECT);
		expect(log.map((e) => e.name)).toEqual(["synth_blocks", "other_pack"]);
	});

	it("returns fileConflict for unclaimed pre-existing file", async () => {
		const { env, fs } = makeEnv();
		const src = seedLocalSource(fs, "/source", {});
		fs.seedText(`${src}/Scripts/x.js`, "fresh");
		fs.seedText(`${PROJECT}/Scripts/x.js`, "user-owned");

		const r = await install(env, { source: { kind: "local", folder: src } });
		expect(r.kind).toBe("fileConflict");
		if (r.kind !== "fileConflict") return;
		expect(r.collisions).toEqual(["Scripts/x.js: trying to overwrite a user file"]);
		// Target file untouched.
		expect(await fs.readText(`${PROJECT}/Scripts/x.js`)).toBe("user-owned");
	});

	it("reuses identical shared files owned by another package", async () => {
		const { env, fs } = makeEnv();
		const content = "const shared = 1;";
		const hash = hashCode64(content).toString();
		const src = seedLocalSource(fs, "/source", { SharedWildcard: ["Scripts/Common/*"] });
		fs.seedText(`${src}/Scripts/Common/util.js`, content);
		fs.seedText(`${PROJECT}/Scripts/Common/util.js`, content);
		fs.seedText(installLogPath(PROJECT), JSON.stringify([{
			Name: "other_pack", Company: "vendor_username", Version: "1.0.0",
			Date: "2026-01-01T00:00:00", Mode: "LocalFolder",
			Steps: [
				{ Type: "File", Target: "Scripts/Common/util.js", Hash: hash, Shared: true, Modified: "2026-01-01T00:00:00" },
			],
		}]));

		const r = await install(env, { source: { kind: "local", folder: src } });
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.sharedFilesReused).toEqual(["Scripts/Common/util.js"]);
		expect(await fs.readText(`${PROJECT}/Scripts/Common/util.js`)).toBe(content);
		const log = await readInstallLog(env, PROJECT);
		expect(log).toHaveLength(2);
		const installed = log[1];
		expect(installed.kind).toBe("active");
		if (installed.kind !== "active") return;
		const step = installed.steps.find((s) => s.type === "File" && s.target === "Scripts/Common/util.js");
		expect(step).toMatchObject({ shared: true, hash: hashCode64(content) });
	});

	it("blocks shared files with differing existing content hash", async () => {
		const { env, fs } = makeEnv();
		const src = seedLocalSource(fs, "/source", { SharedWildcard: ["Scripts/Common/*"] });
		fs.seedText(`${src}/Scripts/Common/util.js`, "new shared");
		fs.seedText(`${PROJECT}/Scripts/Common/util.js`, "old shared");
		fs.seedText(installLogPath(PROJECT), JSON.stringify([{
			Name: "other_pack", Company: "vendor_username", Version: "1.0.0",
			Date: "2026-01-01T00:00:00", Mode: "LocalFolder",
			Steps: [
				{ Type: "File", Target: "Scripts/Common/util.js", Hash: hashCode64("old shared").toString(), Shared: true, Modified: "2026-01-01T00:00:00" },
			],
		}]));

		const r = await install(env, { source: { kind: "local", folder: src } });
		expect(r.kind).toBe("fileConflict");
		if (r.kind !== "fileConflict") return;
		expect(r.collisions[0]).toMatch(/shared file content differs/);
	});

	it("returns invalidPackage when source is missing package_install.json", async () => {
		const { env, fs } = makeEnv();
		fs.seedText("/empty/project_info.xml", SOURCE_PROJECT_XML);
		const r = await install(env, { source: { kind: "local", folder: "/empty" } });
		expect(r.kind).toBe("invalidPackage");
	});

	it("returns corruptedLog on garbage install log", async () => {
		const { env, fs } = makeEnv();
		fs.seedText(installLogPath(PROJECT), "not valid json");
		const r = await install(env, { source: { kind: "local", folder: "/source" } });
		expect(r.kind).toBe("corruptedLog");
	});

	it("dryRun returns preview without writing", async () => {
		const { env, fs } = makeEnv();
		const src = seedLocalSource(fs, "/source", {
			Preprocessors: ["HISE_NUM_CHANNELS"],
			InfoText: "## hello",
			ClipboardContent: "include();",
		});
		fs.seedText(`${src}/Scripts/x.js`, "x");

		const r = await install(env, { source: { kind: "local", folder: src }, dryRun: true });
		expect(r.kind).toBe("dryRun");
		if (r.kind !== "dryRun") return;
		expect(r.preview.files).toEqual(["Scripts/x.js"]);
		expect(r.preview.preprocessors).toEqual({ HISE_NUM_CHANNELS: [null, "4"] });
		expect(r.preview.infoText).toBe("## hello");
		expect(r.preview.clipboardContent).toBe("include();");
		expect(await fs.exists(`${PROJECT}/Scripts/x.js`)).toBe(false);
		expect(await readInstallLog(env, PROJECT)).toEqual([]);
	});

	it("writes clipboard content when manifest has it", async () => {
		const { env, fs, clipboard } = makeEnv();
		const src = seedLocalSource(fs, "/source", { ClipboardContent: "snippet" });
		fs.seedText(`${src}/Scripts/x.js`, "x");

		const r = await install(env, { source: { kind: "local", folder: src } });
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.clipboardWritten).toBe(true);
		expect(clipboard.text).toBe("snippet");
	});
});

describe("install (store)", () => {
	interface StoreSetup {
		seenAuths: Array<string | undefined>;
	}
	function setupStore(env: AssetEnvironment, http: MockHttpClient, zip: MockZipReader): StoreSetup {
		const seenAuths: Array<string | undefined> = [];
		http.onGet("https://store.hise.dev/api/products/", () => ({
			status: 200,
			body: JSON.stringify([{
				product_name: "Synth Blocks",
				repo_link: "https://git.hise.dev/vendor/synth_blocks",
			}]),
		}));
		http.onGet("https://git.hise.dev/api/v1/repos/vendor/synth_blocks/tags", (req) => {
			seenAuths.push(req.headers?.Authorization);
			return {
				status: 200,
				body: JSON.stringify([
					{
						name: "1.0.0",
						commit: { sha: "abc", created: "2026-01-01T00:00:00Z" },
						zipball_url: "https://git.hise.dev/vendor/synth_blocks/archive/1.0.0.zip",
					},
					{
						name: "0.9.0",
						commit: { sha: "def", created: "2025-12-01T00:00:00Z" },
						zipball_url: "https://git.hise.dev/vendor/synth_blocks/archive/0.9.0.zip",
					},
				]),
			};
		});
		zip.register("v1", [
			{ path: "vendor-synth_blocks-abc/project_info.xml", content: SOURCE_PROJECT_XML },
			{ path: "vendor-synth_blocks-abc/user_info.xml", content: SOURCE_USER_XML },
			{ path: "vendor-synth_blocks-abc/package_install.json", content: "{}" },
			{ path: "vendor-synth_blocks-abc/Scripts/main.js", content: "alert(1)" },
		]);
		http.onGet("https://git.hise.dev/vendor/synth_blocks/archive/1.0.0.zip", (req) => {
			seenAuths.push(req.headers?.Authorization);
			return { status: 200, body: zip.bytesFor("v1") };
		});
		env.fs.writeText(tokenFilePath(env), "good-token");
		return { seenAuths };
	}

	it("downloads and installs latest", async () => {
		const { env, fs, http, zip } = makeEnv();
		setupStore(env, http, zip);

		const r = await install(env, { source: { kind: "store", packageName: "synth_blocks" } });
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.entry.mode).toBe("StoreDownload");
		expect(r.entry.version).toBe("1.0.0");
		expect(await fs.readText(`${PROJECT}/Scripts/main.js`)).toBe("alert(1)");
	});

	it("returns missingToken when no token is stored", async () => {
		const { env, http, zip } = makeEnv();
		setupStore(env, http, zip);
		// Remove the token.
		await env.fs.delete(tokenFilePath(env));

		const r = await install(env, { source: { kind: "store", packageName: "synth_blocks" } });
		expect(r).toEqual({ kind: "missingToken" });
	});

	it("explicit token in opts overrides stored token", async () => {
		const { env, http, zip } = makeEnv();
		const { seenAuths } = setupStore(env, http, zip);
		await env.fs.delete(tokenFilePath(env));

		const r = await install(env, {
			source: { kind: "store", packageName: "synth_blocks", token: "explicit-token" },
		});
		expect(r.kind).toBe("ok");
		expect(seenAuths.every((a) => a === "Bearer explicit-token")).toBe(true);
	});

	it("returns invalidPackage when zipball lacks package_install.json", async () => {
		const { env, http, zip } = makeEnv();
		setupStore(env, http, zip);
		// Replace the registered archive with one missing the manifest.
		zip.register("v1", [
			{ path: "vendor-synth_blocks-abc/project_info.xml", content: SOURCE_PROJECT_XML },
			{ path: "vendor-synth_blocks-abc/Scripts/main.js", content: "x" },
		]);

		const r = await install(env, { source: { kind: "store", packageName: "synth_blocks" } });
		expect(r.kind).toBe("invalidPackage");
		if (r.kind !== "invalidPackage") return;
		expect(r.message).toMatch(/package_install\.json/i);
	});
});

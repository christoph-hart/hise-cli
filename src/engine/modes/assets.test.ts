import { describe, expect, it } from "vitest";
import { MockHiseConnection } from "../hise.js";
import {
	MockAppDataPaths,
	MockFilesystem,
	MockHttpClient,
	MockZipReader,
} from "../../mock/assetIo.js";
import type { AssetEnvironment } from "../assets/environment.js";
import { CompletionEngine } from "../completion/engine.js";
import { installLogPath } from "../assets/operations/log.js";
import { writeLocalFolders } from "../assets/operations/local.js";
import { AssetsMode } from "./assets.js";
import type { Mode, SessionContext } from "./mode.js";

const PROJECT = "/projects/Demo";

function statusFixture() {
	return {
		success: true,
		server: { version: "1.0", buildCommit: "x" },
		project: { name: "Demo", projectFolder: PROJECT, scriptsFolder: `${PROJECT}/Scripts` },
		scriptProcessors: [],
		logs: [], errors: [],
	};
}

function makeEnv(): { env: AssetEnvironment; fs: MockFilesystem; http: MockHttpClient } {
	const fs = new MockFilesystem();
	const http = new MockHttpClient();
	const hise = new MockHiseConnection();
	hise.onGet("/api/status", () => statusFixture());
	const env: AssetEnvironment = {
		fs,
		http,
		zip: new MockZipReader(),
		appData: new MockAppDataPaths(),
		hise,
		now: () => new Date("2026-04-09T14:30:00Z"),
	};
	return { env, fs, http };
}

const dummySession = {} as SessionContext;

describe("AssetsMode.parse", () => {
	it("help returns markdown listing commands", async () => {
		const mode = new AssetsMode(null);
		const r = await mode.parse("help", dummySession);
		expect(r.type).toBe("markdown");
		if (r.type !== "markdown") return;
		expect(r.content).toMatch(/Assets Commands/);
	});

	it("returns error when no env wired and command needs work", async () => {
		const mode = new AssetsMode(null);
		const r = await mode.parse("list", dummySession);
		expect(r.type).toBe("error");
	});

	it("error variant on bad input", async () => {
		const { env } = makeEnv();
		const mode = new AssetsMode(env);
		const r = await mode.parse("explode pkg", dummySession);
		expect(r.type).toBe("error");
	});

	it("list installed via env", async () => {
		const { env } = makeEnv();
		const mode = new AssetsMode(env);
		const r = await mode.parse("list installed", dummySession);
		expect(r.type).toBe("markdown");
		if (r.type !== "markdown") return;
		expect(r.content).toMatch(/Installed/);
	});

	it("login without token returns error", async () => {
		const { env } = makeEnv();
		const mode = new AssetsMode(env);
		const r = await mode.parse("login", dummySession);
		expect(r.type).toBe("error");
	});

	it("login with token persists and returns ok", async () => {
		const { env, http } = makeEnv();
		http.onGet("https://git.hise.dev/api/v1/user", () => ({
			status: 200,
			body: JSON.stringify({ username: "vendor", email: "v@example.com" }),
		}));
		const mode = new AssetsMode(env);
		const r = await mode.parse("login token=abc", dummySession);
		expect(r.type).toBe("markdown");
		if (r.type !== "markdown") return;
		expect(r.content).toMatch(/Signed in as/);
	});

	it("info returns markdown with state", async () => {
		const { env } = makeEnv();
		const mode = new AssetsMode(env);
		const r = await mode.parse("info pkg", dummySession);
		expect(r.type).toBe("markdown");
		if (r.type !== "markdown") return;
		expect(r.content).toMatch(/Uninstalled/);
	});

	it("uninstall returns notFound error for missing package", async () => {
		const { env } = makeEnv();
		const mode = new AssetsMode(env);
		const r = await mode.parse("uninstall ghost", dummySession);
		expect(r.type).toBe("error");
	});
});

describe("AssetsMode context-aware completion", () => {
	function setup() {
		const { env, fs, http } = makeEnv();
		const engine = new CompletionEngine();
		const mode = new AssetsMode(env, engine);
		return { mode, env, fs, http };
	}

	it("position 0 returns top-level verbs", async () => {
		const { mode } = setup();
		const r = mode.complete!("", 0);
		const labels = r.items.map((i) => i.label);
		expect(labels).toEqual(expect.arrayContaining(["list", "install", "uninstall", "info"]));
	});

	it("'list ' returns filter keywords", async () => {
		const { mode } = setup();
		const r = mode.complete!("list ", 5);
		const labels = r.items.map((i) => i.label);
		expect(labels).toEqual(expect.arrayContaining(["installed", "uninstalled", "local", "store"]));
	});

	it("'uninstall ' returns installed package names", async () => {
		const { mode, fs } = setup();
		fs.seedText(installLogPath(PROJECT), JSON.stringify([
			{ Name: "synth_blocks", Company: "v", Version: "1.0.0", Date: "x", Steps: [] },
			{ Name: "drum_kit", Company: "v", Version: "1.0.0", Date: "x", Steps: [] },
		]));
		await mode.onEnter!({} as SessionContext);
		const r = mode.complete!("uninstall ", 10);
		const labels = r.items.map((i) => i.label);
		expect(labels).toEqual(expect.arrayContaining(["synth_blocks", "drum_kit"]));
	});

	it("'install ' returns local names not yet installed", async () => {
		const { mode, env, fs } = setup();
		fs.seedText("/local/Already/project_info.xml", `<?xml version="1.0"?>
<ProjectSettings><Name value="Already"/><Version value="1.0"/></ProjectSettings>`);
		fs.seedText("/local/Fresh/project_info.xml", `<?xml version="1.0"?>
<ProjectSettings><Name value="Fresh"/><Version value="1.0"/></ProjectSettings>`);
		await writeLocalFolders(env, ["/local/Already", "/local/Fresh"]);
		fs.seedText(installLogPath(PROJECT), JSON.stringify([
			{ Name: "Already", Company: "v", Version: "1.0", Date: "x", Steps: [] },
		]));
		await mode.onEnter!({} as SessionContext);
		const r = mode.complete!("install ", 8);
		const labels = r.items.map((i) => i.label);
		expect(labels).toContain("Fresh");
		expect(labels).not.toContain("Already");
	});

	it("'install pkg ' returns flag completions", async () => {
		const { mode } = setup();
		const r = mode.complete!("install pkg ", 12);
		const labels = r.items.map((i) => i.label);
		expect(labels).toEqual(expect.arrayContaining(["--dry-run", "version="]));
		expect(labels).not.toContain("token=");
		expect(labels).not.toContain("local=");
	});

	it("'cleanup ' prioritises NeedsCleanup names", async () => {
		const { mode, fs } = setup();
		fs.seedText(installLogPath(PROJECT), JSON.stringify([
			{ Name: "ok_pkg", Company: "v", Version: "1.0", Date: "x", Steps: [] },
			{ Name: "stuck_pkg", Company: "v", Version: "1.0", Date: "x", NeedsCleanup: true, SkippedFiles: [] },
		]));
		await mode.onEnter!({} as SessionContext);
		const r = mode.complete!("cleanup ", 8);
		const labels = r.items.map((i) => i.label);
		expect(labels).toContain("stuck_pkg");
		expect(labels).not.toContain("ok_pkg");
	});

	it("'local remove ' returns local folder names", async () => {
		const { mode, env, fs } = setup();
		fs.seedText("/local/MyLib/project_info.xml", `<?xml version="1.0"?>
<ProjectSettings><Name value="MyLib"/><Version value="1.0"/></ProjectSettings>`);
		await writeLocalFolders(env, ["/local/MyLib"]);
		await mode.onEnter!({} as SessionContext);
		const r = mode.complete!("local remove ", 13);
		const labels = r.items.map((i) => i.label);
		expect(labels).toContain("MyLib");
	});

	it("top-level verbs include login/logout", async () => {
		const { mode } = setup();
		const r = mode.complete!("", 0);
		const labels = r.items.map((i) => i.label);
		expect(labels).toEqual(expect.arrayContaining(["login", "logout"]));
		expect(labels).not.toContain("auth");
	});

	it("refreshes cache after a successful uninstall", async () => {
		const { mode, fs } = setup();
		fs.seedText(installLogPath(PROJECT), JSON.stringify([
			{ Name: "doomed", Company: "v", Version: "1.0", Date: "x", Steps: [] },
		]));
		await mode.onEnter!({} as SessionContext);
		expect(mode.complete!("uninstall ", 10).items.map((i) => i.label)).toContain("doomed");
		await mode.parse("uninstall doomed", {} as SessionContext);
		expect(mode.complete!("uninstall ", 10).items.map((i) => i.label)).not.toContain("doomed");
	});
});

describe("AssetsMode install resolution", () => {
	it("install <name> resolves against local folders before falling back to store", async () => {
		const { env, fs } = makeEnv();
		const mode = new AssetsMode(env);
		// Register a local folder containing a package named MyLib.
		fs.seedText("/local/MyLib/project_info.xml", `<?xml version="1.0"?>
<ProjectSettings>
  <Name value="MyLib"/>
  <Version value="1.0.0"/>
  <ExtraDefinitionsWindows value=""/>
  <ExtraDefinitionsOSX value=""/>
  <ExtraDefinitionsLinux value=""/>
  <ExtraDefinitionsNetworkDll value=""/>
  <OSXStaticLibs value=""/>
  <WindowsStaticLibFolder value=""/>
</ProjectSettings>`);
		fs.seedText("/local/MyLib/user_info.xml", `<?xml version="1.0"?>
<UserSettings><Company value="vendor"/></UserSettings>`);
		fs.seedText("/local/MyLib/package_install.json", "{}");
		fs.seedText("/local/MyLib/Scripts/main.js", "x");
		await writeLocalFolders(env, ["/local/MyLib"]);

		// Wire HISE settings/preprocessor mocks so install can read target state.
		const hise = (env.hise as MockHiseConnection);
		hise.onGet("/api/project/settings/list", () => ({
			success: true,
			settings: { OSXStaticLibs: { value: "" }, WindowsStaticLibFolder: { value: "" } },
			logs: [], errors: [],
		}));
		hise.onGet("/api/project/preprocessor/list?OS=all&target=all", () => ({
			success: true, preprocessors: {}, logs: [], errors: [],
		}));
		hise.onPost("/api/project/preprocessor/set", () => ({ success: true, result: "OK", logs: [], errors: [] }));
		hise.onPost("/api/project/settings/set", () => ({ success: true, result: "OK", logs: [], errors: [] }));

		const r = await mode.parse("install MyLib", {} as SessionContext);
		expect(r.type).not.toBe("error");
		// File copied to target -> proves local source path was used.
		expect(await fs.exists("/projects/Demo/Scripts/main.js")).toBe(true);
	});
});

describe("AssetsMode create -> wizard", () => {
	it("returns wizardResult when registry has install_package_maker", async () => {
		const { env } = makeEnv();
		const fakeDef = { id: "install_package_maker", header: "X", tabs: [], tasks: [], postActions: [], globalDefaults: {} };
		const session = {
			wizardRegistry: { get: (id: string) => id === "install_package_maker" ? fakeDef : undefined },
		} as unknown as SessionContext;
		const mode = new AssetsMode(env);
		const r = await mode.parse("create", session);
		expect(r.type).toBe("wizard");
	});

	it("returns error when registry missing", async () => {
		const { env } = makeEnv();
		const session = {} as SessionContext;
		const mode = new AssetsMode(env);
		const r = await mode.parse("create", session);
		expect(r.type).toBe("error");
	});
});

describe("AssetsMode interface", () => {
	it("has expected id and accent", () => {
		const mode: Mode = new AssetsMode(null);
		expect(mode.id).toBe("assets");
		expect(mode.name).toBe("Assets");
		expect(mode.accent.startsWith("#")).toBe(true);
	});

	it("tokenizeInput recognises subcommand keywords", () => {
		const mode = new AssetsMode(null);
		const tokens = mode.tokenizeInput?.("install pkg --dry-run") ?? [];
		const installSpan = tokens.find((t) => t.text.startsWith("install"));
		expect(installSpan?.token).toBe("keyword");
		const flagSpan = tokens.find((t) => t.text === "--dry-run");
		expect(flagSpan?.token).toBe("keyword");
	});

	it("complete returns assets-mode items", () => {
		const stubEngine = {
			completeAssets: (prefix: string) => [
				{ label: "list" }, { label: "install" }, { label: "info" },
			].filter((i) => i.label.startsWith(prefix)),
		} as unknown as import("../completion/engine.js").CompletionEngine;
		const mode = new AssetsMode(null, stubEngine);
		const r = mode.complete!("inst", 4);
		const labels = r.items.map((i) => i.label);
		expect(labels).toContain("install");
		expect(labels).not.toContain("list");
	});
});

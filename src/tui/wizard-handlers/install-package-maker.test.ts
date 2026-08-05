import { describe, expect, it } from "vitest";
import { MockHiseConnection } from "../../engine/hise.js";
import {
	MockAppDataPaths,
	MockFilesystem,
	MockHttpClient,
	MockZipReader,
} from "../../mock/assetIo.js";
import type { AssetEnvironment } from "../../engine/assets/environment.js";
import {
	createInstallPackageMakerInitHandler,
	createInstallPackageMakerWriteHandler,
} from "./install-package-maker.js";

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

function makeEnv() {
	const fs = new MockFilesystem();
	const hise = new MockHiseConnection();
	hise.onGet("/api/status", () => statusFixture());
	const env: AssetEnvironment = {
		fs,
		http: new MockHttpClient(),
		zip: new MockZipReader(),
		appData: new MockAppDataPaths(),
		hise,
		now: () => new Date("2026-04-09T14:30:00Z"),
	};
	return { env, fs, hise };
}

describe("createInstallPackageMakerInitHandler", () => {
	it("returns defaults + dynamic preprocessor items from /api/project/preprocessor/list", async () => {
		const { env, hise } = makeEnv();
		hise.onGet("/api/project/preprocessor/list?OS=all&target=all", () => ({
			success: true,
			preprocessors: {
				"*.*": { HISE_NUM_CHANNELS: 4 },
				"Project.Windows": { HAS_LICENSE_KEY: 1 },
			},
			logs: [], errors: [],
		}));

		const handler = createInstallPackageMakerInitHandler(env);
		const result = await handler("install_package_maker");

		const struct = result as {
			defaults: Record<string, string>;
			items?: Record<string, string[]>;
			itemDescriptions?: Record<string, string[]>;
		};
		expect(struct.items?.Preprocessors).toEqual(["HAS_LICENSE_KEY", "HISE_NUM_CHANNELS"]);
		expect(struct.itemDescriptions?.Preprocessors).toEqual(["= 1", "= 4"]);
	});

	it("prefills defaults from existing package_install.json", async () => {
		const { env, fs, hise } = makeEnv();
		hise.onGet("/api/project/preprocessor/list?OS=all&target=all", () => ({
			success: true, preprocessors: {}, logs: [], errors: [],
		}));
		fs.seedText(`${PROJECT}/package_install.json`, JSON.stringify({
			FileTypes: ["Scripts"],
			PositiveWildcard: ["*.js"],
			NegativeWildcard: ["*.tmp"],
			SharedWildcard: ["Scripts/Common/*"],
			Preprocessors: ["FOO"],
			InfoText: "## Setup",
			ClipboardContent: "include();",
		}));

		const handler = createInstallPackageMakerInitHandler(env);
		const result = await handler("install_package_maker");
		const struct = result as { defaults: Record<string, string> };
		expect(struct.defaults.FileTypes).toBe("Scripts");
		expect(struct.defaults.PositiveWildcard).toBe("*.js");
		expect(struct.defaults.NegativeWildcard).toBe("*.tmp");
		expect(struct.defaults.SharedWildcard).toBe("Scripts/Common/*");
		expect(struct.defaults.Preprocessors).toBe("FOO");
		expect(struct.defaults.InfoText).toBe("## Setup");
		expect(struct.defaults.ClipboardContent).toBe("include();");
	});

	it("falls back to all-defaults when HISE is unreachable", async () => {
		const fs = new MockFilesystem();
		const hise = new MockHiseConnection(); // no /api/status handler
		const env: AssetEnvironment = {
			fs, http: new MockHttpClient(), zip: new MockZipReader(),
			appData: new MockAppDataPaths(), hise,
			now: () => new Date(),
		};
		const handler = createInstallPackageMakerInitHandler(env);
		const result = await handler("install_package_maker");
		const struct = result as { defaults: Record<string, string> };
		expect(struct.defaults.PositiveWildcard).toBe("*");
	});
});

describe("createInstallPackageMakerWriteHandler", () => {
	it("writes a minimal manifest when only InfoText is set", async () => {
		const { env, fs } = makeEnv();
		const handler = createInstallPackageMakerWriteHandler(env);
		const result = await handler({
			FileTypes: "Scripts, AdditionalSourceCode, Samples, Images, AudioFiles, SampleMaps, MidiFiles, DspNetworks, Presets",
			PositiveWildcard: "*",
			NegativeWildcard: "",
			SharedWildcard: "",
			Preprocessors: "",
			InfoText: "## Hello",
			ClipboardContent: "",
			RegisterAsLocalSource: "false",
		}, () => {}, undefined, undefined);

		expect(result.success).toBe(true);
		const written = JSON.parse(await fs.readText(`${PROJECT}/package_install.json`));
		expect(written).toEqual({ InfoText: "## Hello" });
	});

	it("writes FileTypes when subset selected", async () => {
		const { env, fs } = makeEnv();
		const handler = createInstallPackageMakerWriteHandler(env);
		await handler({
			FileTypes: "Scripts, Images",
			PositiveWildcard: "*",
			NegativeWildcard: "",
			SharedWildcard: "Scripts/Common/*, AdditionalSourceCode/Vendor/Common/*",
			Preprocessors: "FOO, BAR",
			InfoText: "",
			ClipboardContent: "",
			RegisterAsLocalSource: "false",
		}, () => {}, undefined, undefined);
		const written = JSON.parse(await fs.readText(`${PROJECT}/package_install.json`));
		expect(written.FileTypes).toEqual(["Scripts", "Images"]);
		expect(written.SharedWildcard).toEqual(["Scripts/Common/*", "AdditionalSourceCode/Vendor/Common/*"]);
		expect(written.Preprocessors).toEqual(["FOO", "BAR"]);
	});

	it("registers project as local source when toggle is on", async () => {
		const { env, fs } = makeEnv();
		const handler = createInstallPackageMakerWriteHandler(env);
		fs.seedText(`${PROJECT}/project_info.xml`, `<?xml version="1.0"?>
<ProjectSettings><Name value="Demo"/><Version value="1.0"/></ProjectSettings>`);
		const result = await handler({
			FileTypes: "Scripts, AdditionalSourceCode, Samples, Images, AudioFiles, SampleMaps, MidiFiles, DspNetworks, Presets",
			PositiveWildcard: "*",
			NegativeWildcard: "",
			SharedWildcard: "",
			Preprocessors: "",
			InfoText: "",
			ClipboardContent: "",
			RegisterAsLocalSource: "true",
		}, () => {}, undefined, undefined);
		expect(result.success).toBe(true);
		const localFolders = JSON.parse(await fs.readText(`/mock/AppData/HISE/localAssetFolders.js`));
		expect(localFolders).toContain(PROJECT);
	});

	it("aborts when HISE not reachable", async () => {
		const fs = new MockFilesystem();
		const hise = new MockHiseConnection();
		const env: AssetEnvironment = {
			fs, http: new MockHttpClient(), zip: new MockZipReader(),
			appData: new MockAppDataPaths(), hise,
			now: () => new Date(),
		};
		const handler = createInstallPackageMakerWriteHandler(env);
		const result = await handler({}, () => {}, undefined, undefined);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/HISE is not reachable/);
	});
});

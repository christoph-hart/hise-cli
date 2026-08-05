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
import { installLogPath, readInstallLog } from "./log.js";
import { uninstall } from "./uninstall.js";

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

function makeFileEntry(target: string, content: string) {
	const hash = hashCode64(content).toString();
	return { Type: "File", Target: target, Hash: hash, Modified: "2026-01-01T00:00:00" };
}

const baseMeta = {
	Name: "pkg", Company: "v", Version: "1.0.0",
	Date: "2026-04-09T14:30:00", Mode: "StoreDownload",
};

describe("uninstall", () => {
	it("notFound when package missing", async () => {
		const { env, fs } = makeEnv();
		fs.seedText(installLogPath(PROJECT), JSON.stringify([]));
		const r = await uninstall(env, "missing");
		expect(r).toEqual({ kind: "notFound", package: "missing" });
	});

	it("alreadyNeedsCleanup for cleanup-state entry", async () => {
		const { env, fs } = makeEnv();
		fs.seedText(installLogPath(PROJECT), JSON.stringify([
			{ ...baseMeta, NeedsCleanup: true, SkippedFiles: [] },
		]));
		const r = await uninstall(env, "pkg");
		expect(r).toEqual({ kind: "alreadyNeedsCleanup", package: "pkg" });
	});

	it("deletes unmodified text files and removes the entry", async () => {
		const { env, fs } = makeEnv();
		const content = "var x = 1;";
		fs.seedText(`${PROJECT}/Scripts/a.js`, content);
		fs.seedText(installLogPath(PROJECT), JSON.stringify([
			{ ...baseMeta, Steps: [makeFileEntry("Scripts/a.js", content)] },
		]));

		const r = await uninstall(env, "pkg");
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.deleted).toEqual([`${PROJECT}/Scripts/a.js`]);
		expect(r.needsCleanup).toBe(false);
		expect(await fs.exists(`${PROJECT}/Scripts/a.js`)).toBe(false);
		expect(await readInstallLog(env, PROJECT)).toEqual([]);
	});

	it("keeps files still owned by another active package", async () => {
		const { env, fs } = makeEnv();
		const content = "shared";
		fs.seedText(`${PROJECT}/Scripts/common.js`, content);
		fs.seedText(installLogPath(PROJECT), JSON.stringify([
			{
				...baseMeta,
				Steps: [{ ...makeFileEntry("Scripts/common.js", content), Shared: true }],
			},
			{
				Name: "other", Company: "v", Version: "1.0.0",
				Date: "2026-04-09T14:30:00", Mode: "StoreDownload",
				Steps: [{ ...makeFileEntry("Scripts/common.js", content), Shared: true }],
			},
		]));

		const r = await uninstall(env, "pkg");
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.deleted).toEqual([]);
		expect(r.skipped).toEqual([]);
		expect(r.keptOwned).toEqual([`${PROJECT}/Scripts/common.js`]);
		expect(r.needsCleanup).toBe(false);
		expect(await fs.exists(`${PROJECT}/Scripts/common.js`)).toBe(true);
		const log = await readInstallLog(env, PROJECT);
		expect(log.map((e) => e.name)).toEqual(["other"]);
	});

	it("skips modified text files and rewrites entry as NeedsCleanup", async () => {
		const { env, fs } = makeEnv();
		const original = "original contents";
		fs.seedText(`${PROJECT}/Scripts/a.js`, "user edited");
		fs.seedText(installLogPath(PROJECT), JSON.stringify([
			{ ...baseMeta, Steps: [makeFileEntry("Scripts/a.js", original)] },
		]));

		const r = await uninstall(env, "pkg");
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.skipped).toEqual([`${PROJECT}/Scripts/a.js`]);
		expect(r.needsCleanup).toBe(true);
		expect(await fs.exists(`${PROJECT}/Scripts/a.js`)).toBe(true);
		const log = await readInstallLog(env, PROJECT);
		expect(log[0].kind).toBe("needsCleanup");
		if (log[0].kind === "needsCleanup") {
			expect(log[0].skippedFiles).toEqual([`${PROJECT}/Scripts/a.js`]);
		}
	});

	it("deletes binary files unconditionally", async () => {
		const { env, fs } = makeEnv();
		fs.seedBytes(`${PROJECT}/Images/logo.png`, new Uint8Array([1, 2, 3]));
		// No Hash field on log entry -> binary semantics.
		fs.seedText(installLogPath(PROJECT), JSON.stringify([
			{
				...baseMeta,
				Steps: [{ Type: "File", Target: "Images/logo.png", Modified: "2026-01-01T00:00:00" }],
			},
		]));

		const r = await uninstall(env, "pkg");
		expect(r.kind).toBe("ok");
		expect(await fs.exists(`${PROJECT}/Images/logo.png`)).toBe(false);
	});

	it("restores preprocessor old value (catch-all)", async () => {
		const { env, fs, hise } = makeEnv();
		const writes: unknown[] = [];
		hise.onPost("/api/project/preprocessor/set", (body) => {
			writes.push(body);
			return { success: true, result: "OK", logs: [], errors: [] };
		});
		fs.seedText(installLogPath(PROJECT), JSON.stringify([
			{
				...baseMeta,
				Steps: [
					{ Type: "Preprocessor", Data: { FOO: ["1", "2"] } },
				],
			},
		]));

		const r = await uninstall(env, "pkg");
		expect(r.kind).toBe("ok");
		expect(writes).toEqual([
			{ OS: "all", target: "all", preprocessor: "FOO", value: "1" },
		]);
	});

	it("clears preprocessor when oldValue is null", async () => {
		const { env, fs, hise } = makeEnv();
		const writes: Array<{ value: unknown }> = [];
		hise.onPost("/api/project/preprocessor/set", (body) => {
			writes.push(body as { value: unknown });
			return { success: true, result: "OK", logs: [], errors: [] };
		});
		fs.seedText(installLogPath(PROJECT), JSON.stringify([
			{
				...baseMeta,
				Steps: [
					{ Type: "Preprocessor", Data: { FOO: [null, "1"] } },
				],
			},
		]));

		await uninstall(env, "pkg");
		expect(writes[0].value).toBe("default");
	});

	it("restores project settings", async () => {
		const { env, fs, hise } = makeEnv();
		const writes: unknown[] = [];
		hise.onPost("/api/project/settings/set", (body) => {
			writes.push(body);
			return { success: true, result: "OK", logs: [], errors: [] };
		});
		fs.seedText(installLogPath(PROJECT), JSON.stringify([
			{
				...baseMeta,
				Steps: [
					{ Type: "ProjectSetting",
					  oldValues: { OSXStaticLibs: "" },
					  newValues: { OSXStaticLibs: "-framework Foo" } },
				],
			},
		]));

		await uninstall(env, "pkg");
		expect(writes).toEqual([{ key: "OSXStaticLibs", value: "" }]);
	});

	it("walks steps in REVERSE order", async () => {
		const { env, fs, hise } = makeEnv();
		const order: string[] = [];
		hise.onPost("/api/project/preprocessor/set", () => {
			order.push("preprocessor");
			return { success: true, result: "OK", logs: [], errors: [] };
		});
		hise.onPost("/api/project/settings/set", () => {
			order.push("setting");
			return { success: true, result: "OK", logs: [], errors: [] };
		});
		const fileContent = "x";
		fs.seedText(`${PROJECT}/Scripts/a.js`, fileContent);
		fs.seedText(installLogPath(PROJECT), JSON.stringify([
			{
				...baseMeta,
				Steps: [
					{ Type: "Preprocessor", Data: { FOO: [null, "1"] } },
					{ Type: "ProjectSetting", oldValues: { OSXStaticLibs: "" }, newValues: { OSXStaticLibs: "x" } },
					makeFileEntry("Scripts/a.js", fileContent),
				],
			},
		]));

		await uninstall(env, "pkg");
		// File first (last step), then setting, then preprocessor.
		expect(order).toEqual(["setting", "preprocessor"]);
	});

	it("transportError leaves log untouched", async () => {
		const { env, fs, hise } = makeEnv();
		hise.onPost("/api/project/preprocessor/set", () => ({
			success: false, result: null, logs: [],
			errors: [{ errorMessage: "HISE blew up", callstack: [] }],
		}));
		const before = JSON.stringify([
			{
				...baseMeta,
				Steps: [{ Type: "Preprocessor", Data: { FOO: [null, "1"] } }],
			},
		]);
		fs.seedText(installLogPath(PROJECT), before);

		const r = await uninstall(env, "pkg");
		expect(r.kind).toBe("transportError");
		// Log untouched.
		expect(await fs.readText(installLogPath(PROJECT))).toBe(before);
	});
});

import { describe, expect, it } from "vitest";
import { parseProjectInfoXml } from "../../mock/contracts/assets/projectInfoXml.js";
import {
	computeInstallPlan,
	type InstallPlanInput,
	type SourceFileEntry,
} from "./installPlan.js";
import type { PackageInstallManifest } from "../../mock/contracts/assets/packageInstall.js";
import type { ActiveInstallLogEntry } from "../../mock/contracts/assets/installLog.js";

function defaultManifest(over: Partial<PackageInstallManifest> = {}): PackageInstallManifest {
	return {
		fileTypes: [],
		positiveWildcard: ["*"],
		negativeWildcard: [],
		sharedWildcard: [],
		preprocessors: [],
		infoText: "",
		clipboardContent: "",
		...over,
	};
}

const SOURCE_XML = `<?xml version="1.0"?>
<ProjectSettings>
  <Name value="MyPlugin"/>
  <Version value="1.0.0"/>
  <ExtraDefinitionsWindows value="HISE_NUM_CHANNELS=4"/>
  <ExtraDefinitionsOSX value="HISE_NUM_CHANNELS=4"/>
  <ExtraDefinitionsLinux value=""/>
  <ExtraDefinitionsNetworkDll value=""/>
  <OSXStaticLibs value=""/>
  <WindowsStaticLibFolder value=""/>
</ProjectSettings>`;

function defaultInput(over: Partial<InstallPlanInput> = {}): InstallPlanInput {
	return {
		packageName: "pkg",
		packageCompany: "vendor",
		packageVersion: "1.0.0",
		mode: "StoreDownload",
		date: "2026-04-09T14:30:00",
		manifest: defaultManifest(),
		sourceFiles: [],
		sourceProjectInfo: parseProjectInfoXml(SOURCE_XML),
		targetPreprocessors: {},
		targetSettings: {},
		targetExistingPaths: new Set(),
		ownership: new Map(),
		existingPackageVersion: null,
		...over,
	};
}

function txt(relPath: string, hash: bigint = 0n): SourceFileEntry {
	return {
		relPath,
		name: relPath.split("/").at(-1)!,
		isText: true,
		hash,
		modified: "2026-04-09T14:29:58",
	};
}

function bin(relPath: string): SourceFileEntry {
	return {
		relPath,
		name: relPath.split("/").at(-1)!,
		isText: false,
		hash: null,
		modified: "2026-04-09T14:29:58",
	};
}

describe("computeInstallPlan", () => {
	it("emits empty Steps for empty source", () => {
		const r = computeInstallPlan(defaultInput());
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.plan.entry.steps).toHaveLength(0);
	});

	it("produces File steps in source-iteration order", () => {
		const r = computeInstallPlan(defaultInput({
			sourceFiles: [
				txt("Scripts/a.js", 11n),
				bin("Images/logo.png"),
			],
		}));
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.plan.filesToCopy).toEqual(["Scripts/a.js", "Images/logo.png"]);
		expect(r.plan.entry.steps).toEqual([
			{ type: "File", target: "Scripts/a.js", hash: 11n, hasHashField: true, shared: false, modified: "2026-04-09T14:29:58" },
			{ type: "File", target: "Images/logo.png", hash: null, hasHashField: false, shared: false, modified: "2026-04-09T14:29:58" },
		]);
	});

	it("filters reserved files and Binaries", () => {
		const r = computeInstallPlan(defaultInput({
			sourceFiles: [
				txt("Scripts/main.js", 1n),
				txt("project_info.xml", 2n),     // reserved
				txt("Scripts/Binaries/x.js", 3n), // excluded ancestor
			],
		}));
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.plan.filesToCopy).toEqual(["Scripts/main.js"]);
	});

	it("respects FileTypes restriction", () => {
		const r = computeInstallPlan(defaultInput({
			manifest: defaultManifest({ fileTypes: ["Scripts"] }),
			sourceFiles: [
				txt("Scripts/a.js", 1n),
				txt("Images/logo.png", 2n),
			],
		}));
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.plan.filesToCopy).toEqual(["Scripts/a.js"]);
	});

	it("emits Preprocessor step from source XML lookup", () => {
		const r = computeInstallPlan(defaultInput({
			manifest: defaultManifest({ preprocessors: ["HISE_NUM_CHANNELS"] }),
			targetPreprocessors: { HISE_NUM_CHANNELS: null },
		}));
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.plan.entry.steps[0]).toEqual({
			type: "Preprocessor",
			data: { HISE_NUM_CHANNELS: [null, "4"] },
		});
	});

	it("warns on undefined source preprocessor and skips it", () => {
		const r = computeInstallPlan(defaultInput({
			manifest: defaultManifest({ preprocessors: ["NEVER_DEFINED"] }),
		}));
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.plan.warnings.some((w) => w.includes("NEVER_DEFINED"))).toBe(true);
		// No Preprocessor step emitted because data map is empty.
		expect(r.plan.entry.steps.find((s) => s.type === "Preprocessor")).toBeUndefined();
	});

	it("emits ProjectSetting step only when source has non-empty portable settings", () => {
		const xmlWith = `<?xml version="1.0"?>
<ProjectSettings>
  <ExtraDefinitionsWindows value=""/>
  <ExtraDefinitionsOSX value=""/>
  <ExtraDefinitionsLinux value=""/>
  <ExtraDefinitionsNetworkDll value=""/>
  <OSXStaticLibs value="-framework Foo"/>
  <WindowsStaticLibFolder value=""/>
</ProjectSettings>`;
		const r = computeInstallPlan(defaultInput({
			sourceProjectInfo: parseProjectInfoXml(xmlWith),
			targetSettings: { OSXStaticLibs: "" },
		}));
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.plan.entry.steps[0]).toEqual({
			type: "ProjectSetting",
			oldValues: { OSXStaticLibs: "" },
			newValues: { OSXStaticLibs: "-framework Foo" },
		});
	});

	it("appends Info and Clipboard markers when manifest has them", () => {
		const r = computeInstallPlan(defaultInput({
			manifest: defaultManifest({
				infoText: "## Setup",
				clipboardContent: "include(\"x.js\");",
			}),
		}));
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.plan.entry.steps).toEqual([
			{ type: "Info" },
			{ type: "Clipboard" },
		]);
	});

	it("orders steps Preprocessor -> ProjectSetting -> File -> Info -> Clipboard", () => {
		const xml = `<?xml version="1.0"?>
<ProjectSettings>
  <ExtraDefinitionsWindows value="FOO=1"/>
  <ExtraDefinitionsOSX value="FOO=1"/>
  <ExtraDefinitionsLinux value=""/>
  <ExtraDefinitionsNetworkDll value=""/>
  <OSXStaticLibs value="-framework Foo"/>
  <WindowsStaticLibFolder value=""/>
</ProjectSettings>`;
		const r = computeInstallPlan(defaultInput({
			manifest: defaultManifest({
				preprocessors: ["FOO"],
				infoText: "info",
				clipboardContent: "clip",
			}),
			sourceProjectInfo: parseProjectInfoXml(xml),
			targetPreprocessors: { FOO: null },
			sourceFiles: [txt("Scripts/a.js", 1n)],
		}));
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.plan.entry.steps.map((s) => s.type)).toEqual([
			"Preprocessor", "ProjectSetting", "File", "Info", "Clipboard",
		]);
	});

	it("returns alreadyInstalled when same version recorded", () => {
		const r = computeInstallPlan(defaultInput({
			existingPackageVersion: "1.0.0",
			packageVersion: "1.0.0",
		}));
		expect(r).toEqual({ kind: "alreadyInstalled", existingVersion: "1.0.0" });
	});

	it("returns needsUpgrade when different version recorded", () => {
		const r = computeInstallPlan(defaultInput({
			existingPackageVersion: "0.9.0",
			packageVersion: "1.0.0",
		}));
		expect(r).toEqual({ kind: "needsUpgrade", existingVersion: "0.9.0" });
	});

	it("returns fileConflict for unclaimed pre-existing file", () => {
		const r = computeInstallPlan(defaultInput({
			sourceFiles: [txt("Scripts/a.js", 1n), txt("Scripts/b.js", 2n)],
			targetExistingPaths: new Set(["Scripts/b.js"]),
			ownership: new Map(), // not claimed by any existing pkg
		}));
		expect(r).toEqual({ kind: "fileConflict", collisions: [{ target: "Scripts/b.js", reason: "Scripts/b.js: trying to overwrite a user file" }] });
	});

	it("reuses identical shared file claimed by existing log", () => {
		const r = computeInstallPlan(defaultInput({
			manifest: defaultManifest({ sharedWildcard: ["Scripts/*"] }),
			sourceFiles: [txt("Scripts/a.js", 1n)],
			targetExistingPaths: new Set(["Scripts/a.js"]),
			ownership: new Map([["Scripts/a.js", [{
				packageId: "other::other",
				name: "other",
				company: "other",
				version: "1.0.0",
				target: "Scripts/a.js",
				shared: true,
				hash: 1n,
				hasHashField: true,
			}]]]),
		}));
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
	expect(r.plan.filesToCopy).toEqual([]);
	expect(r.plan.sharedFilesToReuse).toEqual(["Scripts/a.js"]);
	expect(r.plan.entry.steps[0]).toMatchObject({ type: "File", target: "Scripts/a.js", shared: true });
	});

	it("logs entry metadata", () => {
		const r = computeInstallPlan(defaultInput({
			packageName: "synth_building_blocks",
			packageCompany: "vendor_username",
			packageVersion: "1.2.0",
			date: "2026-04-09T14:30:00",
			mode: "LocalFolder",
			sourceFiles: [txt("Scripts/a.js", 7n)],
		}));
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		const e = r.plan.entry as ActiveInstallLogEntry;
		expect(e).toMatchObject({
			kind: "active",
			name: "synth_building_blocks",
			company: "vendor_username",
			version: "1.2.0",
			date: "2026-04-09T14:30:00",
			mode: "LocalFolder",
		});
	});
});

import { describe, expect, it } from "vitest";
import {
	normalizeInstallLog,
	serializeInstallLog,
	type ActiveInstallLogEntry,
	type FileStep,
} from "./installLog.js";

const sampleActive = {
	Name: "synth_building_blocks",
	Company: "vendor",
	Version: "1.2.0",
	Date: "2026-04-09T14:30:00",
	Mode: "StoreDownload",
	Steps: [
		{ Type: "Preprocessor", Data: { HISE_NUM_CHANNELS: [null, "4"] } },
		{ Type: "ProjectSetting",
		  oldValues: { OSXStaticLibs: "" },
		  newValues: { OSXStaticLibs: "-framework Foo" } },
		{ Type: "File",
		  Target: "Scripts/sbb/main.js",
		  Hash: "-8123456789012345678",
		  Modified: "2026-04-09T14:29:58" },
		{ Type: "Info" },
		{ Type: "Clipboard" },
	],
};

describe("normalizeInstallLog", () => {
	it("parses the canonical happy-path entry", () => {
		const got = normalizeInstallLog([sampleActive]);
		expect(got).toHaveLength(1);
		const entry = got[0] as ActiveInstallLogEntry;
		expect(entry.kind).toBe("active");
		expect(entry.name).toBe("synth_building_blocks");
		expect(entry.steps).toHaveLength(5);
		expect(entry.steps[0]).toEqual({
			type: "Preprocessor",
			data: { HISE_NUM_CHANNELS: [null, "4"] },
		});
			expect(entry.steps[2]).toEqual({
				type: "File",
				target: "Scripts/sbb/main.js",
				hash: -8123456789012345678n,
				hasHashField: true,
				shared: false,
				modified: "2026-04-09T14:29:58",
			});
		expect(entry.steps[3]).toEqual({ type: "Info" });
		expect(entry.steps[4]).toEqual({ type: "Clipboard" });
	});

	it("accepts legacy Hash as JSON number", () => {
		const got = normalizeInstallLog([
			{
				...sampleActive,
				Steps: [
					{ Type: "File", Target: "Scripts/a.h", Hash: 1234, Modified: "2026-01-01T00:00:00" },
				],
			},
		]);
		const file = (got[0] as ActiveInstallLogEntry).steps[0] as FileStep;
		expect(file.hash).toBe(1234n);
		expect(file.hasHashField).toBe(true);
		expect(file.shared).toBe(false);
	});

	it("parses Shared true on file steps", () => {
		const got = normalizeInstallLog([
			{
				...sampleActive,
				Steps: [
					{ Type: "File", Target: "Scripts/a.h", Hash: "1234", Shared: true, Modified: "2026-01-01T00:00:00" },
				],
			},
		]);
		const file = (got[0] as ActiveInstallLogEntry).steps[0] as FileStep;
		expect(file.shared).toBe(true);
	});

	it("treats missing Hash field as legacy missing", () => {
		const got = normalizeInstallLog([
			{
				...sampleActive,
				Steps: [
					{ Type: "File", Target: "Images/logo.png", Modified: "2026-01-01T00:00:00" },
				],
			},
		]);
		const file = (got[0] as ActiveInstallLogEntry).steps[0] as FileStep;
		expect(file.hash).toBeNull();
		expect(file.hasHashField).toBe(false);
	});

	it("normalizes backslashes in Target", () => {
		const got = normalizeInstallLog([
			{
				...sampleActive,
				Steps: [
					{ Type: "File", Target: "Scripts\\sbb\\a.js", Hash: "0", Modified: "2026-01-01T00:00:00" },
				],
			},
		]);
		const file = (got[0] as ActiveInstallLogEntry).steps[0] as FileStep;
		expect(file.target).toBe("Scripts/sbb/a.js");
	});

	it("parses NeedsCleanup variant and drops Steps", () => {
		const got = normalizeInstallLog([
			{
				Name: "x", Company: "c", Version: "1.0.0", Date: "2026-04-09T14:30:00",
				Mode: "StoreDownload",
				NeedsCleanup: true,
				SkippedFiles: ["/abs/x.js", "/abs/y.png"],
			},
		]);
		expect(got[0]).toMatchObject({
			kind: "needsCleanup",
			skippedFiles: ["/abs/x.js", "/abs/y.png"],
		});
	});

	it("rejects unknown step Type", () => {
		expect(() => normalizeInstallLog([
			{ ...sampleActive, Steps: [{ Type: "Bogus" }] },
		])).toThrow(/unknown step Type/);
	});

	it("unknown Mode falls back to 'Undefined'", () => {
		const got = normalizeInstallLog([{ ...sampleActive, Mode: "InvalidMode" }]);
		expect(got[0].mode).toBe("Undefined");
	});

	it("missing Mode (real HISE shape) defaults to 'Undefined'", () => {
		const { Mode: _ignored, ...without } = sampleActive;
		const got = normalizeInstallLog([without]);
		expect(got[0].mode).toBe("Undefined");
	});

	it("numeric Mode (legacy) is mapped via enum order", () => {
		const got = normalizeInstallLog([{ ...sampleActive, Mode: 2 }]);
		expect(got[0].mode).toBe("StoreDownload");
	});

	it("rejects entry that is neither active (Steps) nor needsCleanup", () => {
		expect(() => normalizeInstallLog([
			{ Name: "x", Company: "c", Version: "1.0", Date: "...", Mode: "StoreDownload" },
		])).toThrow(/Steps array/);
	});

	it("rejects non-array root", () => {
		expect(() => normalizeInstallLog({})).toThrow(/must be a JSON array/);
	});

	it("includes index in error path", () => {
		expect(() => normalizeInstallLog([
			sampleActive,
			{ ...sampleActive, Name: 42 }, // wrong type triggers entry-level error
		])).toThrow(/install_packages_log\.json\[1\]/);
	});

	it("includes step index in error path", () => {
		expect(() => normalizeInstallLog([
			{ ...sampleActive, Steps: [{ Type: "Info" }, { Type: "Bogus" }] },
		])).toThrow(/Steps\[1\]/);
	});
});

describe("serializeInstallLog", () => {
	it("round-trips canonical entry", () => {
		const parsed = normalizeInstallLog([sampleActive]);
		const serialized = serializeInstallLog(parsed);
		// Hash must be string on the way out.
		const fileStep = (serialized[0] as { Steps: Array<{ Type: string; Hash?: unknown }> }).Steps[2];
		expect(fileStep.Type).toBe("File");
		expect(fileStep.Hash).toBe("-8123456789012345678");
		expect(fileStep).not.toHaveProperty("Shared");
	});

	it("serializes Shared only when true", () => {
		const parsed = normalizeInstallLog([
			{
				...sampleActive,
				Steps: [
					{ Type: "File", Target: "Scripts/a.js", Hash: "42", Shared: true, Modified: "2026-01-01T00:00:00" },
				],
			},
		]);
		const out = serializeInstallLog(parsed);
		const fileStep = (out[0] as { Steps: Array<Record<string, unknown>> }).Steps[0];
		expect(fileStep.Shared).toBe(true);
	});

	it("legacy number Hash is migrated to string on write", () => {
		const parsed = normalizeInstallLog([
			{
				...sampleActive,
				Steps: [
					{ Type: "File", Target: "Scripts/a.js", Hash: 42, Modified: "2026-01-01T00:00:00" },
				],
			},
		]);
		const out = serializeInstallLog(parsed);
		const fileStep = (out[0] as { Steps: Array<{ Hash?: unknown }> }).Steps[0];
		expect(fileStep.Hash).toBe("42");
	});

	it("legacy missing Hash stays absent", () => {
		const parsed = normalizeInstallLog([
			{
				...sampleActive,
				Steps: [
					{ Type: "File", Target: "Images/logo.png", Modified: "2026-01-01T00:00:00" },
				],
			},
		]);
		const out = serializeInstallLog(parsed);
		const fileStep = (out[0] as { Steps: Array<Record<string, unknown>> }).Steps[0];
		expect(fileStep).not.toHaveProperty("Hash");
	});

	it("serializes NeedsCleanup without Steps", () => {
		const parsed = normalizeInstallLog([
			{
				Name: "x", Company: "c", Version: "1.0.0", Date: "2026-04-09T14:30:00",
				Mode: "StoreDownload",
				NeedsCleanup: true,
				SkippedFiles: ["/abs/a"],
			},
		]);
		const out = serializeInstallLog(parsed);
		expect(out[0]).toMatchObject({
			NeedsCleanup: true,
			SkippedFiles: ["/abs/a"],
		});
		expect(out[0]).not.toHaveProperty("Steps");
	});
});

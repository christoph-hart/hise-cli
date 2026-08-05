import { describe, expect, it } from "vitest";
import { normalizePackageInstall } from "./packageInstall.js";

describe("normalizePackageInstall", () => {
	it("applies all defaults on minimal input", () => {
		const got = normalizePackageInstall({});
		expect(got).toEqual({
			fileTypes: [],
			positiveWildcard: ["*"],
			negativeWildcard: [],
			sharedWildcard: [],
			preprocessors: [],
			infoText: "",
			clipboardContent: "",
		});
	});

	it("preserves shared wildcard list", () => {
		const got = normalizePackageInstall({ SharedWildcard: ["Scripts/Common/*", "AdditionalSourceCode/Vendor/Common/*"] });
		expect(got.sharedWildcard).toEqual(["Scripts/Common/*", "AdditionalSourceCode/Vendor/Common/*"]);
	});

	it("preserves explicit positive wildcard list", () => {
		const got = normalizePackageInstall({ PositiveWildcard: ["*.js", "*.css"] });
		expect(got.positiveWildcard).toEqual(["*.js", "*.css"]);
	});

	it("substitutes ['*'] when PositiveWildcard is explicitly empty", () => {
		const got = normalizePackageInstall({ PositiveWildcard: [] });
		expect(got.positiveWildcard).toEqual(["*"]);
	});

	it("accepts all valid asset directory ids", () => {
		const got = normalizePackageInstall({
			FileTypes: ["Scripts", "Images", "Samples"],
		});
		expect(got.fileTypes).toEqual(["Scripts", "Images", "Samples"]);
	});

	it("accepts C++ FileTypeFilter when enabled", () => {
		const got = normalizePackageInstall({
			UseFileTypeFilter: true,
			FileTypeFilter: ["Scripts"],
		});
		expect(got.fileTypes).toEqual(["Scripts"]);
	});

	it("ignores C++ FileTypeFilter when disabled", () => {
		const got = normalizePackageInstall({
			UseFileTypeFilter: false,
			FileTypeFilter: ["Scripts"],
		});
		expect(got.fileTypes).toEqual([]);
	});

	it("rejects unknown FileTypes id", () => {
		expect(() => normalizePackageInstall({ FileTypes: ["Wrong"] }))
			.toThrow(/unknown directory id/);
	});

	it("rejects non-object input", () => {
		expect(() => normalizePackageInstall(null)).toThrow();
		expect(() => normalizePackageInstall("hello")).toThrow();
		expect(() => normalizePackageInstall([])).toThrow();
	});

	it("rejects non-string array elements", () => {
		expect(() => normalizePackageInstall({ Preprocessors: [1, 2] }))
			.toThrow(/must be a string/);
	});

	it("preserves preprocessor list verbatim", () => {
		const got = normalizePackageInstall({
			Preprocessors: ["HISE_NUM_CHANNELS", "HAS_LICENSE_KEY"],
		});
		expect(got.preprocessors).toEqual(["HISE_NUM_CHANNELS", "HAS_LICENSE_KEY"]);
	});

	it("reads InfoText and ClipboardContent", () => {
		const got = normalizePackageInstall({
			InfoText: "## Setup\nFoo",
			ClipboardContent: "include(\"x.js\");",
		});
		expect(got.infoText).toBe("## Setup\nFoo");
		expect(got.clipboardContent).toBe("include(\"x.js\");");
	});
});

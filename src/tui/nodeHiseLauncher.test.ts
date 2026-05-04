import { describe, expect, it } from "vitest";
import { hiseBinaryCandidates, parseHisePath } from "./nodeHiseLauncher.js";

describe("node HISE launcher settings fallback", () => {
	it("extracts HisePath from compilerSettings.xml", () => {
		const xml = `<?xml version="1.0"?>
<CompilerSettings>
	<HisePath value="/Users/me/HISE"/>
</CompilerSettings>`;

		expect(parseHisePath(xml)).toBe("/Users/me/HISE");
	});

	it("ignores missing or empty HisePath values", () => {
		expect(parseHisePath("<CompilerSettings></CompilerSettings>")).toBeNull();
		expect(parseHisePath("<HisePath value=\"\"/>")).toBeNull();
	});

	it("resolves macOS release binaries from HisePath", () => {
		expect(hiseBinaryCandidates("/Users/me/HISE", "HISE", "darwin")).toEqual([
			"/Users/me/HISE/projects/standalone/Builds/MacOSXMakefile/build/ReleaseWithFaust/HISE.app/Contents/MacOS/HISE",
			"/Users/me/HISE/projects/standalone/Builds/MacOSXMakefile/build/Release/HISE.app/Contents/MacOS/HISE",
			"/Users/me/HISE/projects/standalone/Builds/MacOSX/build/Release/HISE.app/Contents/MacOS/HISE",
			"/Users/me/HISE/projects/standalone/Builds/MacOSX/build/ReleaseWithFaust/HISE.app/Contents/MacOS/HISE",
			"/Users/me/HISE/projects/standalone/Builds/MacOSX/build/CI/HISE.app/Contents/MacOS/HISE",
			"/Users/me/HISE/projects/standalone/Builds/MacOSX/build/Minimal/HISE.app/Contents/MacOS/HISE",
		]);
	});

	it("resolves macOS debug binaries from HisePath", () => {
		expect(hiseBinaryCandidates("/Users/me/HISE", "HISE Debug", "darwin")).toEqual([
			"/Users/me/HISE/projects/standalone/Builds/MacOSXMakefile/build/DebugWithFaust/HISE Debug.app/Contents/MacOS/HISE Debug",
			"/Users/me/HISE/projects/standalone/Builds/MacOSXMakefile/build/Debug/HISE Debug.app/Contents/MacOS/HISE Debug",
			"/Users/me/HISE/projects/standalone/Builds/MacOSXMakefile/build/Minimal/HISE Debug.app/Contents/MacOS/HISE Debug",
			"/Users/me/HISE/projects/standalone/Builds/MacOSX/build/Debug/HISE Debug.app/Contents/MacOS/HISE Debug",
			"/Users/me/HISE/projects/standalone/Builds/MacOSX/build/Minimal/HISE Debug.app/Contents/MacOS/HISE Debug",
		]);
	});

	it("resolves Windows release binaries from HisePath", () => {
		expect(hiseBinaryCandidates("C:\\HISE", "HISE", "win32")).toEqual([
			"C:\\HISE\\projects\\standalone\\Builds\\VisualStudio2022\\x64\\ReleaseWithFaust\\App\\HISE.exe",
			"C:\\HISE\\projects\\standalone\\Builds\\VisualStudio2022\\x64\\Release\\App\\HISE.exe",
			"C:\\HISE\\projects\\standalone\\Builds\\VisualStudio2026\\x64\\ReleaseWithFaust\\App\\HISE.exe",
			"C:\\HISE\\projects\\standalone\\Builds\\VisualStudio2026\\x64\\Release\\App\\HISE.exe",
		]);
	});

	it("resolves Windows debug binaries from HisePath (Minimal/Debug/DebugWithFaust)", () => {
		expect(hiseBinaryCandidates("C:\\HISE", "HISE Debug", "win32")).toEqual([
			"C:\\HISE\\projects\\standalone\\Builds\\VisualStudio2022\\x64\\DebugWithFaust\\App\\HISE Debug.exe",
			"C:\\HISE\\projects\\standalone\\Builds\\VisualStudio2022\\x64\\Debug\\App\\HISE Debug.exe",
			"C:\\HISE\\projects\\standalone\\Builds\\VisualStudio2022\\x64\\Minimal\\App\\HISE Debug.exe",
			"C:\\HISE\\projects\\standalone\\Builds\\VisualStudio2026\\x64\\DebugWithFaust\\App\\HISE Debug.exe",
			"C:\\HISE\\projects\\standalone\\Builds\\VisualStudio2026\\x64\\Debug\\App\\HISE Debug.exe",
			"C:\\HISE\\projects\\standalone\\Builds\\VisualStudio2026\\x64\\Minimal\\App\\HISE Debug.exe",
		]);
	});
});

import { describe, expect, it } from "vitest";
import {
	matchesWildcard,
	normalizeRelPath,
	passesGate1,
	passesGate2,
	passesGate3,
	passesGate4,
	shouldIncludeFile,
	type CandidateFile,
} from "./wildcard.js";

function file(relPath: string): CandidateFile {
	const name = relPath.split("/").at(-1)!;
	return { relPath, name };
}

describe("normalizeRelPath", () => {
	it("converts backslashes", () => {
		expect(normalizeRelPath("a\\b\\c.js")).toBe("a/b/c.js");
	});
	it("strips leading slash", () => {
		expect(normalizeRelPath("/Scripts/a.js")).toBe("Scripts/a.js");
	});
});

describe("matchesWildcard", () => {
	it("glob matches against filename only when there is no path segment", () => {
		expect(matchesWildcard("*.js", file("Scripts/main.js"))).toBe(true);
		expect(matchesWildcard("*.js", file("Scripts/main.css"))).toBe(false);
	});
	it("glob with a path segment matches against relPath", () => {
		expect(matchesWildcard("Scripts/Common/*", file("Scripts/Common/main.js"))).toBe(true);
		expect(matchesWildcard("Scripts/Common/*", file("Scripts/Other/main.js"))).toBe(false);
	});
	it("? matches single char", () => {
		expect(matchesWildcard("a?.js", file("Scripts/ab.js"))).toBe(true);
		expect(matchesWildcard("a?.js", file("Scripts/abc.js"))).toBe(false);
	});
	it("non-glob is substring against relPath", () => {
		expect(matchesWildcard("sbb", file("Scripts/sbb/main.js"))).toBe(true);
		expect(matchesWildcard("Scripts/sbb", file("Scripts/sbb/main.js"))).toBe(true);
		expect(matchesWildcard("missing", file("Scripts/sbb/main.js"))).toBe(false);
	});
});

describe("passesGate1 (FileTypes restriction)", () => {
	it("empty FileTypes -> default all asset dirs", () => {
		expect(passesGate1(file("Scripts/a.js"), [])).toBe(true);
		expect(passesGate1(file("Images/a.png"), [])).toBe(true);
		expect(passesGate1(file("OtherDir/a.js"), [])).toBe(false);
	});
	it("explicit FileTypes restricts to listed", () => {
		expect(passesGate1(file("Scripts/a.js"), ["Scripts"])).toBe(true);
		expect(passesGate1(file("Images/a.png"), ["Scripts"])).toBe(false);
	});
	it("source-root files pass through", () => {
		expect(passesGate1(file("Readme.md"), ["Scripts"])).toBe(true);
	});
});

describe("passesGate2 (Binaries exclusion)", () => {
	it("rejects any path containing Binaries segment", () => {
		expect(passesGate2(file("Binaries/x.dll"))).toBe(false);
		expect(passesGate2(file("Scripts/Binaries/x.js"))).toBe(false);
	});
	it("accepts paths without Binaries segment", () => {
		expect(passesGate2(file("Scripts/main.js"))).toBe(true);
	});
	it("does not match Binaries as substring", () => {
		expect(passesGate2(file("Scripts/BinariesHelper.js"))).toBe(true);
	});
});

describe("passesGate3 (reserved basenames)", () => {
	it("rejects reserved files", () => {
		expect(passesGate3(file("project_info.xml"))).toBe(false);
		expect(passesGate3(file("subdir/Readme.md"))).toBe(false);
		expect(passesGate3(file("install_packages_log.json"))).toBe(false);
	});
	it("rejects .DS_Store at any depth", () => {
		expect(passesGate3(file(".DS_Store"))).toBe(false);
		expect(passesGate3(file("Scripts/.DS_Store"))).toBe(false);
		expect(passesGate3(file("Samples/sub/.DS_Store"))).toBe(false);
	});
	it("accepts non-reserved files", () => {
		expect(passesGate3(file("Scripts/main.js"))).toBe(true);
	});
});

describe("passesGate4 (wildcard match)", () => {
	it("empty positive defaults include=true", () => {
		expect(passesGate4(file("Scripts/main.js"), [], [])).toBe(true);
	});
	it("requires at least one positive match", () => {
		expect(passesGate4(file("Scripts/main.js"), ["*.js"], [])).toBe(true);
		expect(passesGate4(file("Images/a.png"), ["*.js"], [])).toBe(false);
	});
	it("negative removes after positive", () => {
		expect(passesGate4(file("Scripts/secret.js"), ["*.js"], ["secret"])).toBe(false);
		expect(passesGate4(file("Scripts/main.js"), ["*.js"], ["secret"])).toBe(true);
	});
});

describe("shouldIncludeFile (all gates)", () => {
	it("typical happy path", () => {
		expect(shouldIncludeFile(
			file("Scripts/sbb/main.js"),
			{ fileTypes: [], positivePatterns: ["*"], negativePatterns: [] },
		)).toBe(true);
	});
	it("Binaries always excluded even with permissive wildcards", () => {
		expect(shouldIncludeFile(
			file("Scripts/Binaries/main.js"),
			{ fileTypes: [], positivePatterns: ["*"], negativePatterns: [] },
		)).toBe(false);
	});
	it("reserved filename always excluded", () => {
		expect(shouldIncludeFile(
			file("project_info.xml"),
			{ fileTypes: [], positivePatterns: ["*"], negativePatterns: [] },
		)).toBe(false);
	});
	it("FileTypes filter respected", () => {
		expect(shouldIncludeFile(
			file("Images/logo.png"),
			{ fileTypes: ["Scripts"], positivePatterns: [], negativePatterns: [] },
		)).toBe(false);
	});
});

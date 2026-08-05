import { describe, expect, it } from "vitest";
import type { FileStep } from "../../mock/contracts/assets/installLog.js";
import { classifyFileForUninstall, reverseSteps } from "./uninstallPlan.js";

function fileStep(over: Partial<FileStep> = {}): FileStep {
	return {
		type: "File",
		target: "Scripts/a.js",
		hash: 12345n,
		hasHashField: true,
		shared: false,
		modified: "2026-01-01T00:00:00",
		...over,
	};
}

describe("classifyFileForUninstall", () => {
	it("text + hash match -> delete", () => {
		expect(classifyFileForUninstall(fileStep({ hash: 100n }), 100n)).toBe("delete");
	});

	it("text + hash mismatch -> skip", () => {
		expect(classifyFileForUninstall(fileStep({ hash: 100n }), 999n)).toBe("skip");
	});

	it("text + currently missing on disk -> delete", () => {
		expect(classifyFileForUninstall(fileStep({ hash: 100n }), null)).toBe("delete");
	});

	it("binary file (extension not in whitelist) -> delete unchecked", () => {
		expect(classifyFileForUninstall(
			fileStep({ target: "Images/logo.png", hasHashField: false, hash: null }),
			null,
		)).toBe("delete");
	});

	it("legacy missing-hash on now-text-classified extension -> delete", () => {
		// .css is in the current whitelist but legacy HISE didn't hash it.
		expect(classifyFileForUninstall(
			fileStep({ target: "Scripts/style.css", hasHashField: false, hash: null }),
			999n,
		)).toBe("delete");
	});

	it("text + hash field present but null hash -> delete fallback", () => {
		expect(classifyFileForUninstall(
			fileStep({ hasHashField: true, hash: null }),
			999n,
		)).toBe("delete");
	});
});

describe("reverseSteps", () => {
	it("returns reverse copy without mutating input", () => {
		const input = [
			{ type: "Info" as const },
			{ type: "Clipboard" as const },
			fileStep(),
		];
		const out = reverseSteps(input);
		expect(out.map((s) => s.type)).toEqual(["File", "Clipboard", "Info"]);
		expect(input.map((s) => s.type)).toEqual(["Info", "Clipboard", "File"]);
	});
});

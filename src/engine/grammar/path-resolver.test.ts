import { describe, it, expect } from "vitest";
import { resolvePath } from "./path-resolver.js";
import { parseDottedPathString } from "./path-parser.js";
import type { TreeNode } from "../result.js";

function tree(): TreeNode {
	return {
		label: "Master",
		id: "Master",
		children: [
			{
				label: "Lead",
				id: "Lead",
				children: [
					{
						label: "Pitch",
						id: "Pitch",
						children: [
							{ label: "VelMod", id: "VelMod" },
						],
					},
					{ label: "Volume", id: "Volume" },
				],
			},
			{
				label: "Bass",
				id: "Bass",
				children: [
					{ label: "Pitch", id: "Pitch" },
				],
			},
			{ label: "Compressor", id: "Compressor" },
		],
	};
}

function ref(p: string) {
	const r = parseDottedPathString(p);
	if (!r.ok) throw new Error(r.error);
	return r.ref;
}

describe("resolvePath — lookup mode (project-wide)", () => {
	it("finds unique node by bare id", () => {
		const r = resolvePath(tree(), [], ref("Compressor"), "lookup");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.fullPath).toEqual(["Master", "Compressor"]);
	});

	it("matches case-insensitively", () => {
		const r = resolvePath(tree(), [], ref("compressor"), "lookup");
		expect(r.ok).toBe(true);
	});

	it("finds dotted path", () => {
		const r = resolvePath(tree(), [], ref("Lead.Volume"), "lookup");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.fullPath).toEqual(["Master", "Lead", "Volume"]);
	});

	it("disambiguates shared chain ids by parent", () => {
		const r = resolvePath(tree(), [], ref("Lead.Pitch"), "lookup");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.fullPath).toEqual(["Master", "Lead", "Pitch"]);
	});

	it("reports ambiguity when bare id has multiple matches", () => {
		const r = resolvePath(tree(), [], ref("Pitch"), "lookup");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toBe("ambiguous");
			expect(r.candidates?.length).toBe(2);
		}
	});

	it("returns not_found for missing node", () => {
		const r = resolvePath(tree(), [], ref("Nope"), "lookup");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("not_found");
	});
});

describe("resolvePath — cd mode (cwd-relative then project-wide)", () => {
	it("resolves cwd-relative child", () => {
		const r = resolvePath(tree(), ["Master", "Lead"], ref("Volume"), "cd");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.fullPath).toEqual(["Master", "Lead", "Volume"]);
	});

	it("falls back to project-wide when not a cwd child", () => {
		const r = resolvePath(tree(), ["Master", "Lead"], ref("Compressor"), "cd");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.fullPath).toEqual(["Master", "Compressor"]);
	});

	it("walks dotted relative path", () => {
		const r = resolvePath(tree(), ["Master", "Lead"], ref("Pitch.VelMod"), "cd");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.fullPath).toEqual(["Master", "Lead", "Pitch", "VelMod"]);
	});

	it("handles parent ref", () => {
		const r = resolvePath(tree(), ["Master", "Lead", "Pitch"], { kind: "parent" }, "cd");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.fullPath).toEqual(["Master", "Lead"]);
	});

	it("errors on parent ref at root", () => {
		const r = resolvePath(tree(), [], { kind: "parent" }, "cd");
		expect(r.ok).toBe(false);
	});
});

describe("ambiguous case fold", () => {
	it("flags two children differing only by case", () => {
		const t: TreeNode = {
			label: "root",
			id: "root",
			children: [
				{ label: "Foo", id: "Foo" },
				{ label: "FOO", id: "FOO" },
			],
		};
		const r = resolvePath(t, [], ref("foo"), "lookup");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("ambiguous");
	});
});

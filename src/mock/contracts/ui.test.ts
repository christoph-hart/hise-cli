import { describe, it, expect } from "vitest";
import {
	normalizeComponentTree,
	normalizeUiTreeResponse,
	normalizeUiApplyResult,
	applyUiDiffToTree,
	collectComponentIds,
	cleanUiPropertiesForLlm,
} from "./ui.js";
import { MOCK_COMPONENT_TREE } from "../componentTree.js";

describe("normalizeComponentTree", () => {
	it("converts root node", () => {
		const tree = normalizeComponentTree(MOCK_COMPONENT_TREE);
		expect(tree.label).toBe("Content");
		expect(tree.id).toBe("Content");
		expect(tree.type).toBe("ScriptPanel");
		expect(tree.nodeKind).toBe("module");
		expect(tree.filledDot).toBe(true);
		expect(tree.colour).toBe("#66d9ef");
		expect(tree.dimmed).toBe(false);
		expect(tree.badge).toBeUndefined(); // Content has saveInPreset: false
	});

	it("preserves hierarchy depth", () => {
		const tree = normalizeComponentTree(MOCK_COMPONENT_TREE);
		// Content > PageContainer > MainPage > OscSection > OscTune
		const pageContainer = tree.children!.find(c => c.label === "PageContainer")!;
		const mainPage = pageContainer.children!.find(c => c.label === "MainPage")!;
		const oscSection = mainPage.children!.find(c => c.label === "OscSection")!;
		const oscTune = oscSection.children!.find(c => c.label === "OscTune")!;
		expect(oscTune.type).toBe("ScriptSlider");
		expect(oscTune.children).toBeUndefined(); // leaf node
	});

	it("adds badge for saveInPreset components", () => {
		const tree = normalizeComponentTree(MOCK_COMPONENT_TREE);
		const pageContainer = tree.children!.find(c => c.label === "PageContainer")!;
		const mainPage = pageContainer.children!.find(c => c.label === "MainPage")!;
		const oscSection = mainPage.children!.find(c => c.label === "OscSection")!;
		const oscTune = oscSection.children!.find(c => c.label === "OscTune")!;
		expect(oscTune.badge).toEqual({ text: "★", colour: "#e6db74" });
	});

	it("does not add badge for non-saveInPreset components", () => {
		const tree = normalizeComponentTree(MOCK_COMPONENT_TREE);
		const header = tree.children!.find(c => c.label === "Header")!;
		const logo = header.children!.find(c => c.label === "Logo")!;
		expect(logo.badge).toBeUndefined();
	});

	it("dims invisible components", () => {
		const tree = normalizeComponentTree(MOCK_COMPONENT_TREE);
		const pageContainer = tree.children!.find(c => c.label === "PageContainer")!;
		const fxPage = pageContainer.children!.find(c => c.label === "FXPage")!;
		expect(fxPage.dimmed).toBe(true);
	});

	it("recursively dims children of invisible components", () => {
		const tree = normalizeComponentTree(MOCK_COMPONENT_TREE);
		const pageContainer = tree.children!.find(c => c.label === "PageContainer")!;
		const fxPage = pageContainer.children!.find(c => c.label === "FXPage")!;
		const delaySection = fxPage.children!.find(c => c.label === "DelaySection")!;
		const delayTime = delaySection.children!.find(c => c.label === "DelayTime")!;
		// DelayTime is visible: true in raw data, but parent FXPage is invisible
		expect(delayTime.dimmed).toBe(true);
	});

	it("does not dim visible components under visible parents", () => {
		const tree = normalizeComponentTree(MOCK_COMPONENT_TREE);
		const header = tree.children!.find(c => c.label === "Header")!;
		expect(header.dimmed).toBe(false);
		const logo = header.children!.find(c => c.label === "Logo")!;
		expect(logo.dimmed).toBe(false);
	});

	it("sets topMargin on root-level panels", () => {
		const tree = normalizeComponentTree(MOCK_COMPONENT_TREE);
		const header = tree.children!.find(c => c.label === "Header")!;
		expect(header.topMargin).toBe(true);
		// Nested panels should not get topMargin
		const pageContainer = tree.children!.find(c => c.label === "PageContainer")!;
		const mainPage = pageContainer.children!.find(c => c.label === "MainPage")!;
		expect(mainPage.topMargin).toBeUndefined();
	});
});

describe("normalizeUiTreeResponse", () => {
	it("normalizes a raw tree object", () => {
		const tree = normalizeUiTreeResponse(MOCK_COMPONENT_TREE);
		expect(tree.label).toBe("Content");
		expect(tree.children!.length).toBe(3);
	});

	it("throws on null input", () => {
		expect(() => normalizeUiTreeResponse(null)).toThrow();
	});

	it("throws on missing id", () => {
		expect(() => normalizeUiTreeResponse({ type: "ScriptPanel" })).toThrow();
	});
});

describe("normalizeUiApplyResult", () => {
	it("normalizes a valid apply result", () => {
		const result = normalizeUiApplyResult({
			scope: "root",
			groupName: "root",
			diff: [
				{ domain: "ui", action: "+", target: "NewButton" },
				{ domain: "ui", action: "*", target: "OscTune" },
			],
		});
		expect(result).not.toBeNull();
		expect(result!.diff).toHaveLength(2);
		expect(result!.diff[0].action).toBe("+");
		expect(result!.diff[1].action).toBe("*");
	});

	it("returns null for null/undefined", () => {
		expect(normalizeUiApplyResult(null)).toBeNull();
		expect(normalizeUiApplyResult(undefined)).toBeNull();
	});
});

describe("cleanUiPropertiesForLlm", () => {
	it("preserves live component property ids and values", () => {
		expect(cleanUiPropertiesForLlm({
			success: true,
			id: "Button1",
			type: "ScriptButton",
			properties: [
				{ id: "text", value: "Button1", isDefault: true },
				{ id: "radioGroup", value: 1, isDefault: false },
				{ id: "style", value: 0, items: ["Text", "Toggle"] },
			],
		})).toEqual({
			id: "Button1",
			type: "ScriptButton",
			properties: [
				{ id: "text", value: "Button1" },
				{ id: "radioGroup", value: 1, modified: true },
				{ id: "style", value: 0, items: ["Text", "Toggle"] },
			],
		});
	});
});

describe("applyUiDiffToTree", () => {
	it("marks added components", () => {
		const tree = normalizeComponentTree(MOCK_COMPONENT_TREE);
		applyUiDiffToTree(tree, [
			{ domain: "ui", action: "+", target: "OscTune" },
		]);
		const pageContainer = tree.children!.find(c => c.label === "PageContainer")!;
		const mainPage = pageContainer.children!.find(c => c.label === "MainPage")!;
		const oscSection = mainPage.children!.find(c => c.label === "OscSection")!;
		const oscTune = oscSection.children!.find(c => c.label === "OscTune")!;
		expect(oscTune.diff).toBe("added");
	});

	it("ignores builder domain entries", () => {
		const tree = normalizeComponentTree(MOCK_COMPONENT_TREE);
		applyUiDiffToTree(tree, [
			{ domain: "builder", action: "+", target: "Header" },
		]);
		const header = tree.children!.find(c => c.label === "Header")!;
		expect(header.diff).toBeUndefined();
	});

	it("clears diff on unaffected nodes", () => {
		const tree = normalizeComponentTree(MOCK_COMPONENT_TREE);
		// First apply a diff
		applyUiDiffToTree(tree, [
			{ domain: "ui", action: "+", target: "Header" },
		]);
		expect(tree.children!.find(c => c.label === "Header")!.diff).toBe("added");
		// Then apply an empty diff — should clear
		applyUiDiffToTree(tree, []);
		expect(tree.children!.find(c => c.label === "Header")!.diff).toBeUndefined();
	});
});

describe("collectComponentIds", () => {
	it("collects all IDs from the tree", () => {
		const tree = normalizeComponentTree(MOCK_COMPONENT_TREE);
		const ids = collectComponentIds(tree);
		expect(ids).toContain("Content");
		expect(ids).toContain("OscTune");
		expect(ids).toContain("DelaySync");
		expect(ids).toContain("PanicButton");
		expect(ids.length).toBe(37);
	});
});

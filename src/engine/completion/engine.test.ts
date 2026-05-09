// ── CompletionEngine tests ──────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import {
	CompletionEngine,
	buildDatasets,
	buildSlashItems,
	fuzzyFilter,
	levenshteinDistance,
	scoreMatch,
} from "./engine.js";
import type { CompletionDatasets } from "./engine.js";
import type { CompletionItem } from "../modes/mode.js";
import type { ModuleList, ScriptingApi, ScriptnodeList } from "../data.js";

// ── Levenshtein ─────────────────────────────────────────────────────

describe("levenshteinDistance", () => {
	it("returns 0 for identical strings", () => {
		expect(levenshteinDistance("abc", "abc")).toBe(0);
	});

	it("returns length for empty vs non-empty", () => {
		expect(levenshteinDistance("", "abc")).toBe(3);
		expect(levenshteinDistance("abc", "")).toBe(3);
	});

	it("returns 0 for both empty", () => {
		expect(levenshteinDistance("", "")).toBe(0);
	});

	it("handles single character difference", () => {
		expect(levenshteinDistance("abc", "adc")).toBe(1);
	});

	it("handles insertion", () => {
		expect(levenshteinDistance("ac", "abc")).toBe(1);
	});

	it("handles deletion", () => {
		expect(levenshteinDistance("abc", "ac")).toBe(1);
	});

	it("handles transposition as 2 edits", () => {
		expect(levenshteinDistance("ab", "ba")).toBe(2);
	});
});

// ── scoreMatch ──────────────────────────────────────────────────────

describe("scoreMatch", () => {
	it("returns 0 for exact match", () => {
		expect(scoreMatch("Synth", "Synth")).toBe(0);
	});

	it("returns 0 for case-insensitive exact match", () => {
		expect(scoreMatch("synth", "Synth")).toBe(0);
	});

	it("returns 1 for prefix match", () => {
		expect(scoreMatch("Syn", "Synth")).toBe(1);
	});

	it("returns 2 for substring match", () => {
		expect(scoreMatch("nth", "Synth")).toBe(2);
	});

	it("returns null for no match", () => {
		expect(scoreMatch("xyz", "Synth")).toBeNull();
	});

	it("returns fuzzy score for close typos", () => {
		// "Synht" → "Synth" = 2 edits (transposition)
		const s = scoreMatch("Synht", "Synth");
		expect(s).not.toBeNull();
		expect(s!).toBeGreaterThanOrEqual(3); // 2 + distance
	});

	it("rejects single-char input for fuzzy", () => {
		// Single char "x" should not fuzzy-match anything
		expect(scoreMatch("x", "Synth")).toBeNull();
	});
});

// ── fuzzyFilter ─────────────────────────────────────────────────────

describe("fuzzyFilter", () => {
	const items: CompletionItem[] = [
		{ label: "Synth" },
		{ label: "SynthGroup" },
		{ label: "Engine" },
		{ label: "Math" },
		{ label: "Message" },
	];

	it("returns all items for empty input", () => {
		expect(fuzzyFilter("", items)).toHaveLength(5);
	});

	it("returns prefix matches first", () => {
		const result = fuzzyFilter("Syn", items);
		expect(result[0].label).toBe("Synth");
		expect(result[1].label).toBe("SynthGroup");
	});

	it("returns empty for no matches", () => {
		expect(fuzzyFilter("ZZZZ", items)).toHaveLength(0);
	});

	it("respects limit", () => {
		const result = fuzzyFilter("", items, 2);
		expect(result).toHaveLength(2);
	});

	it("case-insensitive matching", () => {
		const result = fuzzyFilter("math", items);
		// "math" exact-matches "Math" (score 0) and fuzzy-matches "Message" (lev dist 3)
		expect(result[0].label).toBe("Math");
	});

	it("includes substring matches", () => {
		const result = fuzzyFilter("ssa", items);
		// "ssa" is a substring of "Message"
		expect(result.some((r) => r.label === "Message")).toBe(true);
	});
});

// ── buildDatasets ───────────────────────────────────────────────────

describe("buildDatasets", () => {
	const moduleList: ModuleList = {
		version: "1.0",
		categories: { "Sound Generators": "desc" },
		modules: [
			{
				id: "SineSynth",
				prettyName: "Sine Synth",
				description: "A sine wave synthesizer",
				type: "SoundGenerator",
				subtype: "SoundGenerator",
				category: ["Sound Generators"],
				builderPath: "/synth/sine",
				hasChildren: false,
				hasFX: false,
				metadataType: "SoundGenerator",
				parameters: [
					{
						parameterIndex: 0,
						id: "Gain",
						metadataType: "Float",
						description: "Output gain",
						type: "Slider",
						disabled: false,
						range: { min: -100, max: 0, stepSize: 0.1 },
						defaultValue: -12,
					},
				],
				modulation: [],
				interfaces: [],
			},
		],
	};

	const scriptingApi: ScriptingApi = {
		version: "1.0",
		generated: "2024-01-01",
		enrichedClasses: [],
		classes: {
			Synth: {
				description: "Main synthesizer namespace",
				category: "namespace",
				methods: [
					{
						name: "addNoteOn",
						returnType: "int",
						description: "Add a note on",
						parameters: [
							{ name: "channel", type: "int" },
							{ name: "noteNumber", type: "int" },
							{ name: "velocity", type: "int" },
							{ name: "timestamp", type: "int" },
						],
						examples: [],
					},
					{
						name: "playNote",
						returnType: "int",
						description: "Play a note",
						parameters: [
							{ name: "noteNumber", type: "int" },
							{ name: "velocity", type: "int" },
						],
						examples: [],
					},
				],
			},
			Engine: {
				description: "Engine namespace",
				category: "namespace",
				methods: [],
			},
		},
	};

	const scriptnodeList: ScriptnodeList = {
		"control.bang": {
			id: "bang",
			description: "Sends a bang",
			type: "Control",
			subtype: "control",
			category: ["Control"],
			hasChildren: false,
			hasFX: false,
			metadataType: "control",
			parameters: [],
			modulation: [],
			hasMidi: false,
			properties: {},
			interfaces: [],
		},
		"control.cable_pack": {
			id: "cable_pack",
			description: "Cable pack",
			type: "Control",
			subtype: "control",
			category: ["Control"],
			hasChildren: false,
			hasFX: false,
			metadataType: "control",
			parameters: [],
			modulation: [],
			hasMidi: false,
			properties: {},
			interfaces: [],
		},
		"math.add": {
			id: "add",
			description: "Add operation",
			type: "Math",
			subtype: "math",
			category: ["Math"],
			hasChildren: false,
			hasFX: false,
			metadataType: "math",
			parameters: [],
			modulation: [],
			hasMidi: false,
			properties: {},
			interfaces: [],
		},
	};

	it("builds module items from moduleList", () => {
		const ds = buildDatasets(moduleList, null, null);
		expect(ds.moduleItems).toHaveLength(1);
		expect(ds.moduleItems[0].label).toBe("Sine Synth");
		expect(ds.moduleItems[0].detail).toBe("SineSynth");
		expect(ds.moduleItems[0].insertText).toBeUndefined();
	});

	it("builds module param map", () => {
		const ds = buildDatasets(moduleList, null, null);
		const params = ds.moduleParamMap.get("SineSynth");
		expect(params).toBeDefined();
		expect(params!).toHaveLength(1);
		expect(params![0].label).toBe("Gain");
	});

	it("builds API namespace items", () => {
		const ds = buildDatasets(null, scriptingApi, null);
		expect(ds.apiNamespaceItems).toHaveLength(2);
		const labels = ds.apiNamespaceItems.map((i) => i.label);
		expect(labels).toContain("Synth");
		expect(labels).toContain("Engine");
	});

	it("builds API method map", () => {
		const ds = buildDatasets(null, scriptingApi, null);
		const methods = ds.apiMethodMap.get("Synth");
		expect(methods).toBeDefined();
		expect(methods!).toHaveLength(2);
		expect(methods![0].label).toBe("addNoteOn");
		expect(methods![0].detail).toBe("Add a note on");
	});

	it("sets insertText for zero-param methods", () => {
		// Engine has no methods, let's check Synth methods
		const ds = buildDatasets(null, scriptingApi, null);
		const methods = ds.apiMethodMap.get("Synth")!;
		// playNote has 2 params → insertText = "playNote("
		const playNote = methods.find((m) => m.label === "playNote");
		expect(playNote?.insertText).toBe("playNote(");
		// addNoteOn has 4 params → insertText = "addNoteOn("
		const addNote = methods.find((m) => m.label === "addNoteOn");
		expect(addNote?.insertText).toBe("addNoteOn(");
	});

	it("builds scriptnode items", () => {
		const ds = buildDatasets(null, null, scriptnodeList);
		expect(ds.scriptnodeItems).toHaveLength(3);
	});

	it("builds scriptnode factories", () => {
		const ds = buildDatasets(null, null, scriptnodeList);
		const labels = ds.scriptnodeFactories.map((i) => i.label);
		expect(labels).toContain("control");
		expect(labels).toContain("math");
	});

	it("groups nodes by factory", () => {
		const ds = buildDatasets(null, null, scriptnodeList);
		const controlNodes = ds.scriptnodeByFactory.get("control");
		expect(controlNodes).toBeDefined();
		expect(controlNodes!).toHaveLength(2);
		const mathNodes = ds.scriptnodeByFactory.get("math");
		expect(mathNodes!).toHaveLength(1);
	});

	it("handles all nulls gracefully", () => {
		const ds = buildDatasets(null, null, null);
		expect(ds.moduleItems).toHaveLength(0);
		expect(ds.apiNamespaceItems).toHaveLength(0);
		expect(ds.scriptnodeItems).toHaveLength(0);
	});
});

// ── buildSlashItems ─────────────────────────────────────────────────

describe("buildSlashItems", () => {
	it("prefixes command names with /", () => {
		const items = buildSlashItems([
			{ name: "help", description: "Show help", handler: async () => ({ type: "empty" }) },
			{ name: "exit", description: "Exit", handler: async () => ({ type: "empty" }) },
		]);
		expect(items).toHaveLength(2);
		expect(items[0].label).toBe("/help");
		expect(items[0].detail).toBe("Show help");
		expect(items[1].label).toBe("/exit");
	});
});

// ── CompletionEngine integration ────────────────────────────────────

describe("CompletionEngine", () => {
	let engine: CompletionEngine;
	let datasets: CompletionDatasets;

	beforeEach(() => {
		engine = new CompletionEngine();

		// Build minimal datasets for testing
		const moduleList: ModuleList = {
			version: "1.0",
			categories: {},
			modules: [
				{
					id: "SimpleGain",
					prettyName: "Simple Gain",
					description: "A gain module",
					type: "Effect",
					subtype: "MasterEffect",
					category: ["Effects"],
					builderPath: "/fx/gain",
					hasChildren: false,
					hasFX: false,
					metadataType: "Effect",
					parameters: [
						{
							parameterIndex: 0,
							id: "Gain",
							metadataType: "Float",
							description: "Gain amount",
							type: "Slider",
							disabled: false,
							range: { min: -100, max: 0, stepSize: 0.1 },
							defaultValue: 0,
						},
						{
							parameterIndex: 1,
							id: "Delay",
							metadataType: "Float",
							description: "Delay time",
							type: "Slider",
							disabled: false,
							range: { min: 0, max: 1000, stepSize: 1 },
							defaultValue: 0,
						},
					],
					modulation: [],
					interfaces: [],
				},
				{
					id: "SimpleEnvelope",
					prettyName: "Simple Envelope",
					description: "An envelope",
					type: "Modulator",
					subtype: "EnvelopeModulator",
					category: ["Modulators"],
					builderPath: "/mod/env",
					hasChildren: false,
					hasFX: false,
					metadataType: "Modulator",
					parameters: [],
					modulation: [],
					interfaces: [],
				},
			],
		};

		const scriptingApi: ScriptingApi = {
			version: "1.0",
			generated: "2024-01-01",
			enrichedClasses: [],
			classes: {
				Synth: {
					description: "Synth namespace",
					category: "namespace",
					methods: [
						{
							name: "addNoteOn",
							returnType: "int",
							description: "Add note",
							parameters: [
								{ name: "channel", type: "int" },
								{ name: "noteNumber", type: "int" },
								{ name: "velocity", type: "int" },
								{ name: "timestamp", type: "int" },
							],
							examples: [],
						},
						{
							name: "addNoteOff",
							returnType: "void",
							description: "Remove note",
							parameters: [
								{ name: "channel", type: "int" },
								{ name: "noteNumber", type: "int" },
								{ name: "timestamp", type: "int" },
							],
							examples: [],
						},
						{
							name: "getNumPressedKeys",
							returnType: "int",
							description: "Get key count",
							parameters: [],
							examples: [],
						},
					],
				},
				Math: {
					description: "Math namespace",
					category: "namespace",
					methods: [
						{
							name: "abs",
							returnType: "double",
							description: "Absolute value",
							parameters: [{ name: "value", type: "double" }],
							examples: [],
						},
					],
				},
			},
		};

		const scriptnodeList: ScriptnodeList = {
			"control.bang": {
				id: "bang",
				description: "Bang",
				type: "Control",
				subtype: "control",
				category: ["Control"],
				hasChildren: false,
				hasFX: false,
				metadataType: "control",
				parameters: [],
				modulation: [],
				hasMidi: false,
				properties: {},
				interfaces: [],
			},
			"math.add": {
				id: "add",
				description: "Add",
				type: "Math",
				subtype: "math",
				category: ["Math"],
				hasChildren: false,
				hasFX: false,
				metadataType: "math",
				parameters: [],
				modulation: [],
				hasMidi: false,
				properties: {},
				interfaces: [],
			},
		};

		datasets = buildDatasets(moduleList, scriptingApi, scriptnodeList);
		engine.setDatasets(datasets);
		engine.setSlashCommands([
			{ name: "help", description: "Show help", handler: async () => ({ type: "empty" }) },
			{ name: "exit", description: "Exit", handler: async () => ({ type: "empty" }) },
			{ name: "builder", description: "Enter builder mode", handler: async () => ({ type: "empty" }) },
			{ name: "script", description: "Enter script mode", handler: async () => ({ type: "empty" }) },
		]);
	});

	// ── Slash completion ────────────────────────────────────────

	describe("completeSlash", () => {
		it("returns all commands for /", () => {
			const result = engine.completeSlash("/");
			expect(result.items.length).toBe(4);
		});

		it("filters by prefix", () => {
			const result = engine.completeSlash("/he");
			expect(result.items).toHaveLength(1);
			expect(result.items[0].label).toBe("/help");
		});

		it("returns from=0, to=inputLength", () => {
			const result = engine.completeSlash("/he");
			expect(result.from).toBe(0);
			expect(result.to).toBe(3);
		});

		it("fuzzy matches close typos", () => {
			const result = engine.completeSlash("/hlep");
			expect(result.items.some((i) => i.label === "/help")).toBe(true);
		});
	});

	// ── Module type completion ──────────────────────────────────

	describe("completeModuleType", () => {
		it("returns all modules for empty prefix", () => {
			const items = engine.completeModuleType("");
			expect(items).toHaveLength(2);
		});

		it("filters by prefix (type ID)", () => {
			const items = engine.completeModuleType("SimpleG");
			expect(items).toHaveLength(1);
			expect(items[0].label).toBe("Simple Gain");
			expect(items[0].detail).toBe("SimpleGain");
		});

		it("filters by prefix (pretty name)", () => {
			const items = engine.completeModuleType("Simple Ga");
			expect(items).toHaveLength(1);
			expect(items[0].detail).toBe("SimpleGain");
		});

		it("returns both Simple* modules for 'Simple'", () => {
			const items = engine.completeModuleType("Simple");
			expect(items).toHaveLength(2);
		});
	});

	// ── Module param completion ─────────────────────────────────

	describe("completeModuleParam", () => {
		it("returns params for known module", () => {
			const items = engine.completeModuleParam("SimpleGain", "");
			expect(items).toHaveLength(2);
		});

		it("filters params by prefix", () => {
			const items = engine.completeModuleParam("SimpleGain", "Ga");
			expect(items).toHaveLength(1);
			expect(items[0].label).toBe("Gain");
		});

		it("returns empty for unknown module", () => {
			const items = engine.completeModuleParam("NonExistent", "");
			expect(items).toHaveLength(0);
		});
	});

	// ── Script completion ───────────────────────────────────────

	describe("completeScript", () => {
		it("returns namespaces for empty input", () => {
			const result = engine.completeScript("");
			expect(result.items).toHaveLength(2);
			const labels = result.items.map((i) => i.label);
			expect(labels).toContain("Synth");
			expect(labels).toContain("Math");
		});

		it("filters namespaces by prefix", () => {
			const result = engine.completeScript("Sy");
			expect(result.items).toHaveLength(1);
			expect(result.items[0].label).toBe("Synth");
			expect(result.from).toBe(0);
		});

		it("returns methods after dot", () => {
			const result = engine.completeScript("Synth.");
			expect(result.items).toHaveLength(3);
			expect(result.from).toBe(6); // after "Synth."
		});

		it("filters methods by prefix after dot", () => {
			const result = engine.completeScript("Synth.add");
			expect(result.items).toHaveLength(2);
			const labels = result.items.map((i) => i.label);
			expect(labels).toContain("addNoteOn");
			expect(labels).toContain("addNoteOff");
		});

		it("returns empty for unknown namespace", () => {
			const result = engine.completeScript("Unknown.");
			expect(result.items).toHaveLength(0);
		});

		it("sets insertText with parens for methods", () => {
			const result = engine.completeScript("Synth.getNum");
			expect(result.items).toHaveLength(1);
			// getNumPressedKeys has 0 params → insertText = "getNumPressedKeys()"
			expect(result.items[0].insertText).toBe("getNumPressedKeys()");
		});
	});

	// ── Scriptnode completion ───────────────────────────────────

	describe("completeScriptnode", () => {
		it("returns factories for empty input", () => {
			const result = engine.completeScriptnode("");
			expect(result.items).toHaveLength(2);
			const labels = result.items.map((i) => i.label);
			expect(labels).toContain("control");
			expect(labels).toContain("math");
		});

		it("returns nodes after factory dot", () => {
			const result = engine.completeScriptnode("control.");
			expect(result.items).toHaveLength(1);
			expect(result.items[0].label).toBe("bang");
		});

		it("returns empty for unknown factory", () => {
			const result = engine.completeScriptnode("unknown.");
			expect(result.items).toHaveLength(0);
		});

		it("strips insertText after the dot so the factory prefix is not duplicated", () => {
			// Without this guard, selecting "bang" after typing "control." would
			// replace the suffix with "control.bang" and yield "control.control.bang".
			const result = engine.completeScriptnode("control.");
			expect(result.from).toBe("control.".length);
			expect(result.items[0]?.insertText).toBeUndefined();
			expect(result.items[0]?.label).toBe("bang");
		});
	});

	// ── Inspect completion ──────────────────────────────────────

	describe("completeInspect", () => {
		it("returns all commands for empty prefix", () => {
			const items = engine.completeInspect("");
			expect(items).toHaveLength(3);
		});

		it("filters by prefix", () => {
			const items = engine.completeInspect("proj");
			expect(items).toHaveLength(1);
			expect(items[0].label).toBe("project");
		});
	});

	// ── Builder keyword completion ──────────────────────────────

	describe("completeBuilderKeyword", () => {
		it("returns the canonical builder verb set for empty prefix", () => {
			const items = engine.completeBuilderKeyword("");
			expect(items.map((i) => i.label).sort()).toEqual([
				"add", "cd", "clone", "get", "ls", "pwd",
				"remove", "rename", "reset", "set", "show",
			]);
		});

		it("filters by prefix", () => {
			const items = engine.completeBuilderKeyword("a");
			expect(items.length).toBeGreaterThan(0);
			expect(items[0].label).toBe("add");
		});

		it("does not surface removed verbs", () => {
			const items = engine.completeBuilderKeyword("");
			const labels = items.map((i) => i.label);
			for (const removed of ["move", "load", "bypass", "enable"]) {
				expect(labels).not.toContain(removed);
			}
		});
	});

	describe("completeBuilderShowNouns", () => {
		it("returns tree and types", () => {
			const items = engine.completeBuilderShowNouns("");
			expect(items.map((i) => i.label).sort()).toEqual(["tree", "types"]);
		});

		it("filters by prefix", () => {
			const items = engine.completeBuilderShowNouns("tr");
			expect(items).toHaveLength(1);
			expect(items[0].label).toBe("tree");
		});
	});

	describe("completeBuilderValue", () => {
		it("offers true/false for bypassed", () => {
			const items = engine.completeBuilderValue("bypassed", "");
			expect(items).not.toBeNull();
			expect(items!.map((i) => i.label).sort()).toEqual(["false", "true"]);
		});

		it("offers preset strings for routing", () => {
			const items = engine.completeBuilderValue("routing", "");
			expect(items).not.toBeNull();
			expect(items!.map((i) => i.label)).toContain('"stereo"');
			expect(items!.map((i) => i.label)).toContain('"all_to_stereo"');
		});

		it("returns null for unknown fields", () => {
			expect(engine.completeBuilderValue("Volume", "")).toBeNull();
		});
	});
});

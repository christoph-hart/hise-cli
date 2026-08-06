import { describe, it, expect } from "vitest";
import { DspMode } from "./dsp.js";
import { createDefaultMockRuntime } from "../../mock/runtime.js";
import type { SessionContext } from "./mode.js";
import type { ScriptnodeList } from "../data.js";
import { MockHiseConnection } from "../hise.js";

const scriptnodeFixture: ScriptnodeList = {
	"core.oscillator": {
		id: "oscillator",
		description: "",
		type: "polyphonic",
		subtype: "",
		category: [],
		hasChildren: false,
		hasFX: false,
		metadataType: "static",
		parameters: [
			{
				parameterIndex: 0, id: "Frequency", metadataType: "static",
				description: "", type: "Slider", disabled: false,
				range: { min: 20, max: 20000, stepSize: 0 }, defaultValue: 440,
			},
		],
		modulation: [],
		hasMidi: false,
		properties: {},
		interfaces: [],
	},
	"filters.svf": {
		id: "svf",
		description: "",
		type: "polyphonic",
		subtype: "",
		category: [],
		hasChildren: false,
		hasFX: false,
		metadataType: "static",
		parameters: [
			{
				parameterIndex: 0, id: "Frequency", metadataType: "static",
				description: "", type: "Slider", disabled: false,
				range: { min: 20, max: 20000, stepSize: 0 }, defaultValue: 2000,
			},
		],
		modulation: [],
		hasMidi: false,
		properties: {},
		interfaces: [],
	},
	"control.pma": {
		id: "pma",
		description: "",
		type: "polyphonic",
		subtype: "",
		category: [],
		hasChildren: false,
		hasFX: false,
		metadataType: "static",
		parameters: [],
		modulation: [],
		hasMidi: false,
		properties: {},
		interfaces: [],
	},
	"core.gain": {
		id: "gain",
		description: "",
		type: "polyphonic",
		subtype: "",
		category: [],
		hasChildren: false,
		hasFX: false,
		metadataType: "static",
		parameters: [
			{
				parameterIndex: 0, id: "Gain", metadataType: "static",
				description: "", type: "Slider", disabled: false,
				range: { min: -100, max: 0, stepSize: 0.1 }, defaultValue: 0,
			},
		],
		modulation: [],
		hasMidi: false,
		properties: {},
		interfaces: [],
	},
};

function makeSession(): { mode: DspMode; ctx: SessionContext; popped: { value: boolean } } {
	const runtime = createDefaultMockRuntime();
	const mode = new DspMode(scriptnodeFixture, undefined, "ScriptFX1");
	const popped = { value: false };
	const ctx: SessionContext = {
		connection: runtime.connection,
		popMode: () => { popped.value = true; return { type: "empty" }; },
	};
	return { mode, ctx, popped };
}

// Bootstrap a fresh network onto ScriptFX1 by invoking the builder-side
// init endpoint directly through the mock connection. PR4 dropped the
// `init`/`load`/`create` verbs — they live on builder's `set X.network`.
async function bootstrapNetwork(ctx: SessionContext, name: string): Promise<void> {
	if (!ctx.connection) throw new Error("no connection");
	await ctx.connection.post(
		`/api/dsp/init?moduleId=ScriptFX1`,
		{ moduleId: "ScriptFX1", name, mode: "auto" },
	);
}

describe("DspMode — integration", () => {
	it("rejects duplicate add IDs before mutation", async () => {
		const { mode, ctx } = makeSession();
		await bootstrapNetwork(ctx, "DupDSP");
		mode.invalidateTree();
		await mode.onEnter(ctx);
		await mode.parse('add core.oscillator as "Osc1"', ctx);

		const result = await mode.parse('add core.oscillator as "Osc1"', ctx);

		expect(result).toMatchObject({
			type: "error",
			code: "duplicate_id",
			message: "ID already exists: Osc1",
			candidates: ["DupDSP.Osc1"],
		});
	});

	it("rejects duplicate aliases in chained add before mutation", async () => {
		const { mode, ctx } = makeSession();
		await bootstrapNetwork(ctx, "ChainDupDSP");
		mode.invalidateTree();
		await mode.onEnter(ctx);

		const result = await mode.parse('add core.oscillator as "A", core.oscillator as "A"', ctx);

		expect(result).toMatchObject({ type: "error", code: "duplicate_id", candidates: ["A"] });
	});

	it("round-trips a minimal graph (add → connect → set → get → save)", async () => {
		const { mode, ctx } = makeSession();
		await bootstrapNetwork(ctx, "MyDSP");
		// Discard the no-network notice triggered by onEnter (mode was
		// constructed before the bootstrap).
		mode.invalidateTree();
		await mode.onEnter(ctx);

		const addOsc = await mode.parse('add core.oscillator as "Osc1"', ctx);
		expect(addOsc.type).not.toBe("error");

		const addFilter = await mode.parse('add filters.svf as "Filter1"', ctx);
		expect(addFilter.type).not.toBe("error");

		const addLfo = await mode.parse('add control.pma as "LFO1"', ctx);
		expect(addLfo.type).not.toBe("error");

		const connect = await mode.parse("connect LFO1 to Filter1.Frequency", ctx);
		expect(connect.type).not.toBe("error");

		const setFreq = await mode.parse("set Osc1.Frequency 880", ctx);
		expect(setFreq.type).not.toBe("error");

		const getFreq = await mode.parse("get Osc1.Frequency", ctx);
		expect(getFreq.type === "text" && getFreq.content === "880").toBe(true);

		const getSource = await mode.parse("get Filter1.Frequency.source", ctx);
		expect(getSource.type === "text" && getSource.content === "LFO1").toBe(true);

		const save = await mode.parse("save", ctx);
		expect(save.type === "text" && save.content.includes("MyDSP.xml")).toBe(true);

		const reset = await mode.parse("reset", ctx);
		expect(reset.type).not.toBe("error");
	});

	it("rejects set with value out of range (local validation)", async () => {
		const { mode, ctx } = makeSession();
		await bootstrapNetwork(ctx, "MyDSP");
		mode.invalidateTree();
		await mode.onEnter(ctx);
		await mode.parse('add core.oscillator as "Osc1"', ctx);
		const set = await mode.parse("set Osc1.Frequency 99999", ctx);
		expect(set.type).toBe("error");
	});

	it("validates set values against updated live parameter ranges", async () => {
		const { mode, ctx } = makeSession();
		await bootstrapNetwork(ctx, "RangeDSP");
		mode.invalidateTree();
		await mode.onEnter(ctx);
		await mode.parse('add core.gain as "Gain1"', ctx);

		const range = await mode.parse("set Gain1.Gain.range [-24, 6], Gain1.Gain.stepSize 0.1", ctx);
		expect(range.type).not.toBe("error");

		const set = await mode.parse("set Gain1.Gain 3", ctx);
		expect(set.type).not.toBe("error");
	});

	it("rejects add with unknown factory path (local validation)", async () => {
		const { mode, ctx } = makeSession();
		await bootstrapNetwork(ctx, "MyDSP");
		mode.invalidateTree();
		await mode.onEnter(ctx);
		const add = await mode.parse('add core.oscilator as "Osc1"', ctx);
		expect(add.type).toBe("error");
	});

	it("show networks returns the mock network list", async () => {
		const { mode, ctx } = makeSession();
		const out = await mode.parse("show networks", ctx);
		// First parse may surface no-network error; if so, verify popMode
		// fired and re-run after bootstrap.
		if (out.type === "error") {
			await bootstrapNetwork(ctx, "MyDSP");
			mode.invalidateTree();
			await mode.onEnter(ctx);
			const out2 = await mode.parse("show networks", ctx);
			expect(out2.type).toBe("table");
			return;
		}
		expect(out.type).toBe("table");
	});

	it("show connections lists edges after connect", async () => {
		const { mode, ctx } = makeSession();
		await bootstrapNetwork(ctx, "MyDSP");
		mode.invalidateTree();
		await mode.onEnter(ctx);
		await mode.parse('add filters.svf as "Filter1"', ctx);
		await mode.parse('add control.pma as "LFO1"', ctx);
		await mode.parse("connect LFO1 to Filter1.Frequency", ctx);
		const out = await mode.parse("show connections", ctx);
		expect(out.type).toBe("table");
		if (out.type !== "table") return;
		expect(out.rows).toContainEqual(["LFO1", "0", "Filter1", "Frequency"]);
	});

	it("posts trace requests to dsp probe", async () => {
		const conn = new MockHiseConnection();
		conn.onPost("/api/dsp/probe", (body) => ({
			success: true,
			logs: [],
			errors: [],
			moduleId: "ScriptFX1",
			parent: "root",
			signalType: "dirac",
			recursive: true,
			signal: [{ channelIndex: 0, min: 0, max: 1, avg: 0, peakIndex: 0, silence: false }],
			parameters: { injected: {}, probed: {}, touchedEdges: {} },
			request: body,
		}));
		const mode = new DspMode(scriptnodeFixture, undefined, "ScriptFX1");
		const ctx: SessionContext = { connection: conn, popMode: () => ({ type: "empty" }) };

		const out = await mode.parse('trace root inject dirac gain 0.25 before "gain" probe recursive probe after "delay" compact', ctx);

		expect(out.type).toBe("json");
		const call = conn.calls.find((c) => c.method === "POST" && c.endpoint === "/api/dsp/probe");
		expect(call?.body).toMatchObject({
			moduleId: "ScriptFX1",
			parent: "root",
			signalType: "dirac",
			gain: 0.25,
			injectId: "gain",
			probeId: "delay",
			recursive: true,
			filter: { compact: true, tree: true },
		});
	});

	it("show status queries DSP runtime status", async () => {
		const { mode, ctx } = makeSession();
		await bootstrapNetwork(ctx, "StatusDSP");
		mode.invalidateTree();
		await mode.onEnter(ctx);

		const out = await mode.parse("show status", ctx);

		expect(out).toEqual({ type: "text", content: "Runtime status OK: ScriptFX1" });
	});

	it("show status surfaces runtime errors without treating the request as unavailable", async () => {
		const conn = new MockHiseConnection();
		conn.onGet("/api/undo/diff", () => ({ success: true, logs: [], errors: [], groupName: "root" }));
		conn.onGet("/api/dsp/tree", () => ({
			success: true,
			result: { nodeId: "ErrDSP", factoryPath: "container.chain", bypassed: false, parameters: [], properties: [], children: [] },
			logs: [],
			errors: [],
		}));
		conn.onGet("/api/dsp/runtime_status", () => ({
			success: false,
			apiVersion: "0.9.0",
			moduleId: "ScriptFX1",
			ok: false,
			logs: [],
			errors: [{ errorMessage: "MidiNote - Can't find suitable parent node", callstack: [] }],
		}));
		const mode = new DspMode(scriptnodeFixture, undefined, "ScriptFX1");
		const ctx: SessionContext = { connection: conn, popMode: () => ({ type: "empty" }) };
		await mode.onEnter(ctx);

		const out = await mode.parse("show status", ctx);

		expect(out).toEqual({ type: "error", message: "MidiNote - Can't find suitable parent node", detail: undefined });
	});

	it("show status autofix requests autofix and marks project dirty when applied", async () => {
		const conn = new MockHiseConnection();
		conn.onGet("/api/undo/diff", () => ({ success: true, logs: [], errors: [], groupName: "root" }));
		conn.onGet("/api/dsp/tree", () => ({
			success: true,
			result: { nodeId: "FixDSP", factoryPath: "container.chain", bypassed: false, parameters: [], properties: [], children: [] },
			logs: [],
			errors: [],
		}));
		conn.onGet("/api/dsp/runtime_status?moduleId=ScriptFX1&autofix=true", () => ({
			success: true,
			apiVersion: "0.9.1",
			moduleId: "ScriptFX1",
			ok: true,
			autofixRequested: true,
			autofixApplied: true,
			fixedNodeId: "MidiNote",
			beforeError: "MidiNote - Can't find suitable parent node",
			logs: [],
			errors: [],
		}));
		const mode = new DspMode(scriptnodeFixture, undefined, "ScriptFX1");
		let dirty = false;
		const ctx: SessionContext = {
			connection: conn,
			popMode: () => ({ type: "empty" }),
			markProjectTreeDirty: () => { dirty = true; },
		};
		await mode.onEnter(ctx);

		const out = await mode.parse("show status autofix", ctx);

		expect(out.type).toBe("text");
		if (out.type === "text") {
			expect(out.content).toContain("Runtime status OK: ScriptFX1");
			expect(out.content).toContain("Autofix applied to MidiNote");
			expect(out.content).toContain("Before: MidiNote - Can't find suitable parent node");
		}
		expect(dirty).toBe(true);
		expect(conn.calls.some((c) => c.method === "GET" && c.endpoint === "/api/dsp/runtime_status?moduleId=ScriptFX1&autofix=true")).toBe(true);
	});

	it("set Code runs runtime autofix after a successful mutation", async () => {
		const conn = new MockHiseConnection();
		conn.onGet("/api/undo/diff", () => ({ success: true, logs: [], errors: [], groupName: "root" }));
		conn.onGet("/api/dsp/tree", () => ({
			success: true,
			result: {
				nodeId: "CodeDSP",
				factoryPath: "container.chain",
				bypassed: false,
				parameters: [],
				properties: [],
				children: [{ nodeId: "Expr", factoryPath: "core.expr", bypassed: false, parameters: [], properties: [], children: [] }],
			},
			logs: [],
			errors: [],
		}));
		conn.onPost("/api/dsp/apply", () => ({
			success: true,
			scope: "root",
			groupName: "",
			diff: [{ domain: "dsp", action: "*", target: "Expr" }],
			logs: [],
			errors: [],
		}));
		conn.onGet("/api/dsp/runtime_status?moduleId=ScriptFX1&autofix=true", () => ({
			success: true,
			apiVersion: "0.9.1",
			moduleId: "ScriptFX1",
			ok: true,
			autofixRequested: true,
			autofixApplied: true,
			fixedNodeId: "Expr",
			beforeError: "Expr - AllowCompilation mismatch",
			logs: [],
			errors: [],
		}));
		const mode = new DspMode(scriptnodeFixture, undefined, "ScriptFX1");
		let dirtyCount = 0;
		const ctx: SessionContext = {
			connection: conn,
			popMode: () => ({ type: "empty" }),
			markProjectTreeDirty: () => { dirtyCount++; },
		};
		await mode.onEnter(ctx);

		const out = await mode.parse('set Expr.Code "return input;"', ctx);

		expect(out.type).toBe("text");
		if (out.type === "text") expect(out.content).toContain("Autofix applied to Expr");
		expect(dirtyCount).toBe(2);
		expect(conn.calls.some((c) => c.method === "GET" && c.endpoint === "/api/dsp/runtime_status?moduleId=ScriptFX1&autofix=true")).toBe(true);
	});

	it("set non-Code checks runtime status without autofix", async () => {
		const conn = new MockHiseConnection();
		conn.onGet("/api/undo/diff", () => ({ success: true, logs: [], errors: [], groupName: "root" }));
		conn.onGet("/api/dsp/tree", () => ({
			success: true,
			result: {
				nodeId: "CodeDSP",
				factoryPath: "container.chain",
				bypassed: false,
				parameters: [],
				properties: [],
				children: [{ nodeId: "Expr", factoryPath: "core.expr", bypassed: false, parameters: [], properties: [], children: [] }],
			},
			logs: [],
			errors: [],
		}));
		conn.onPost("/api/dsp/apply", () => ({
			success: true,
			scope: "root",
			groupName: "",
			diff: [{ domain: "dsp", action: "*", target: "Expr" }],
			logs: [],
			errors: [],
		}));
		conn.onGet("/api/dsp/runtime_status?moduleId=ScriptFX1&autofix=false", () => ({
			success: true,
			apiVersion: "0.9.1",
			moduleId: "ScriptFX1",
			ok: true,
			autofixRequested: false,
			autofixApplied: false,
			logs: [],
			errors: [],
		}));
		const mode = new DspMode(scriptnodeFixture, undefined, "ScriptFX1");
		const ctx: SessionContext = { connection: conn, popMode: () => ({ type: "empty" }) };
		await mode.onEnter(ctx);

		const out = await mode.parse("set Expr.Value 1", ctx);

		expect(out.type).toBe("text");
		expect(conn.calls.some((c) => c.method === "GET" && c.endpoint === "/api/dsp/runtime_status?moduleId=ScriptFX1&autofix=false")).toBe(true);
	});

	it("add checks runtime status without autofix and surfaces graph errors", async () => {
		const conn = new MockHiseConnection();
		conn.onGet("/api/undo/diff", () => ({ success: true, logs: [], errors: [], groupName: "root" }));
		conn.onGet("/api/dsp/tree", () => ({
			success: true,
			result: { nodeId: "GraphDSP", factoryPath: "container.chain", bypassed: false, parameters: [], properties: [], children: [] },
			logs: [],
			errors: [],
		}));
		conn.onPost("/api/dsp/apply", () => ({
			success: true,
			scope: "root",
			groupName: "",
			diff: [{ domain: "dsp", action: "+", target: "MidiNote" }],
			logs: [],
			errors: [],
		}));
		conn.onGet("/api/dsp/runtime_status?moduleId=ScriptFX1&autofix=false", () => ({
			success: false,
			apiVersion: "0.9.1",
			moduleId: "ScriptFX1",
			ok: false,
			autofixRequested: false,
			autofixApplied: false,
			logs: [],
			errors: [{ errorMessage: "MidiNote - Can't find suitable parent node", callstack: [] }],
		}));
		const mode = new DspMode(undefined, undefined, "ScriptFX1");
		const ctx: SessionContext = { connection: conn, popMode: () => ({ type: "empty" }) };
		await mode.onEnter(ctx);

		const out = await mode.parse('add control.pma as "MidiNote"', ctx);

		expect(out).toEqual({ type: "error", message: "MidiNote - Can't find suitable parent node", detail: undefined });
		expect(conn.calls.some((c) => c.method === "GET" && c.endpoint === "/api/dsp/runtime_status?moduleId=ScriptFX1&autofix=false")).toBe(true);
	});

	it("failed mutation does not check runtime status", async () => {
		const conn = new MockHiseConnection();
		conn.onGet("/api/undo/diff", () => ({ success: true, logs: [], errors: [], groupName: "root" }));
		conn.onGet("/api/dsp/tree", () => ({
			success: true,
			result: { nodeId: "GraphDSP", factoryPath: "container.chain", bypassed: false, parameters: [], properties: [], children: [] },
			logs: [],
			errors: [],
		}));
		conn.onPost("/api/dsp/apply", () => ({
			success: false,
			logs: [],
			errors: [{ errorMessage: "apply failed", callstack: [] }],
		}));
		const mode = new DspMode(undefined, undefined, "ScriptFX1");
		const ctx: SessionContext = { connection: conn, popMode: () => ({ type: "empty" }) };
		await mode.onEnter(ctx);

		const out = await mode.parse('add core.gain as "Gain1"', ctx);

		expect(out.type).toBe("error");
		expect(conn.calls.some((c) => c.method === "GET" && c.endpoint.startsWith("/api/dsp/runtime_status"))).toBe(false);
	});

	it("set Code surfaces runtime errors left after autofix", async () => {
		const conn = new MockHiseConnection();
		conn.onGet("/api/undo/diff", () => ({ success: true, logs: [], errors: [], groupName: "root" }));
		conn.onGet("/api/dsp/tree", () => ({
			success: true,
			result: {
				nodeId: "CodeDSP",
				factoryPath: "container.chain",
				bypassed: false,
				parameters: [],
				properties: [],
				children: [{ nodeId: "Expr", factoryPath: "core.expr", bypassed: false, parameters: [], properties: [], children: [] }],
			},
			logs: [],
			errors: [],
		}));
		conn.onPost("/api/dsp/apply", () => ({
			success: true,
			scope: "root",
			groupName: "",
			diff: [{ domain: "dsp", action: "*", target: "Expr" }],
			logs: [],
			errors: [],
		}));
		conn.onGet("/api/dsp/runtime_status?moduleId=ScriptFX1&autofix=true", () => ({
			success: false,
			apiVersion: "0.9.1",
			moduleId: "ScriptFX1",
			ok: false,
			autofixRequested: true,
			autofixApplied: false,
			logs: [],
			errors: [{ errorMessage: "Expr - SNEX compile failed", callstack: [] }],
		}));
		const mode = new DspMode(scriptnodeFixture, undefined, "ScriptFX1");
		const ctx: SessionContext = { connection: conn, popMode: () => ({ type: "empty" }) };
		await mode.onEnter(ctx);

		const out = await mode.parse('set Expr.Code "broken"', ctx);

		expect(out).toEqual({ type: "error", message: "No autofix applied\nExpr - SNEX compile failed", detail: undefined });
	});

	it("cd/ls navigate the graph", async () => {
		const { mode, ctx } = makeSession();
		await bootstrapNetwork(ctx, "MyDSP");
		mode.invalidateTree();
		await mode.onEnter(ctx);
		await mode.parse('add core.oscillator as "Osc1"', ctx);
		const ls = await mode.parse("ls", ctx);
		expect(ls.type).toBe("table");
		if (ls.type !== "table") return;
		expect(ls.rows[0]?.[0]).toBe("Osc1");
	});

	it("sets complex data using the default slot", async () => {
		const { mode, ctx } = makeSession();
		await bootstrapNetwork(ctx, "MyDSP");
		mode.invalidateTree();
		await mode.onEnter(ctx);

		const result = await mode.parse("set_complex_data MyDSP.Table index 3", ctx);

		expect(result.type).toBe("text");
		if (result.type === "text") expect(result.content).toContain("* MyDSP");
	});

	it("entering DSP with no network loaded errors + auto-pops", async () => {
		const conn = new (await import("../hise.js")).MockHiseConnection();
		conn.onGet("/api/dsp/tree", () => ({
			error: true,
			message: "no network loaded",
		}));
		conn.onGet("/api/undo/diff", () => ({
			success: true,
			logs: [],
			errors: [],
			groupName: "root",
		}));
		const mode = new DspMode(scriptnodeFixture, undefined, "ScriptFX_NoNet");
		let popped = false;
		const ctx: SessionContext = {
			connection: conn,
			popMode: () => { popped = true; return { type: "empty" }; },
		};
		await mode.onEnter(ctx);
		const r = await mode.parse('add core.oscillator as "Osc1"', ctx);
		expect(r.type).toBe("error");
		expect(popped).toBe(true);
	});
});

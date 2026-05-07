import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BuilderMode } from "./builder.js";
import type { TreeNode } from "../result.js";
import type { ModuleList } from "../data.js";
import type { SessionContext } from "./mode.js";
import { MockHiseConnection } from "../hise.js";

let moduleList: ModuleList;

beforeAll(() => {
	const dataDir = path.resolve(import.meta.dirname, "../../../data");
	const raw = fs.readFileSync(path.join(dataDir, "moduleList.json"), "utf8");
	moduleList = JSON.parse(raw) as ModuleList;
});

const offlineSession: SessionContext = {
	connection: null,
	popMode: () => ({ type: "text", content: "Exited Builder mode." }),
};

function makeTree(): TreeNode {
	return {
		id: "Master",
		label: "Master Chain",
		nodeKind: "module",
		type: "ModulatorSynthChain",
		children: [
			{ id: "MIDI Processor Chain", label: "MIDI Processor Chain", nodeKind: "chain", children: [] },
			{ id: "FX Chain", label: "FX Chain", nodeKind: "chain", children: [] },
			{
				id: "Lead",
				label: "Lead",
				nodeKind: "module",
				type: "SineSynth",
				children: [],
			},
		],
	};
}

function makeMock(tree: TreeNode): { mock: MockHiseConnection; session: SessionContext } {
	const mock = new MockHiseConnection();
	mock.onGet("/api/undo/diff", () => ({
		success: true, logs: [], errors: [], groupName: "root",
	}));
	mock.onGet("/api/builder/tree", () => ({
		success: true, logs: [], errors: [], result: tree,
	}));
	mock.onPost("/api/builder/apply", () => ({
		success: true, logs: ["OK"], errors: [],
		scope: "group", groupName: "root", diff: [],
	}));
	mock.onPost("/api/builder/reset", () => ({
		success: true, logs: ["reset"], errors: [],
	}));
	mock.onPost("/api/dsp/init", () => ({
		success: true, logs: ["network ready"], errors: [],
	}));
	const session: SessionContext = {
		connection: mock,
		popMode: () => ({ type: "text", content: "Exited Builder mode." }),
	};
	return { mock, session };
}

describe("BuilderMode — offline (no connection)", () => {
	it("parse error surfaces from removed verbs", async () => {
		const mode = new BuilderMode(moduleList);
		const result = await mode.parse("move Lead to Master", offlineSession);
		expect(result.type).toBe("error");
	});

	it("add returns local fallback", async () => {
		const mode = new BuilderMode(moduleList);
		const result = await mode.parse('add SineSynth as "Lead"', offlineSession);
		expect(result.type).toBe("text");
		if (result.type === "text") expect(result.content).toMatch(/no HISE connection/);
	});

	it("ls without tree falls back to message", async () => {
		const mode = new BuilderMode(moduleList);
		const result = await mode.parse("ls", offlineSession);
		expect(result.type).toBe("text");
	});
});

describe("BuilderMode — with mock connection", () => {
	it("add dispatches apply", async () => {
		const tree = makeTree();
		const { mock, session } = makeMock(tree);
		const mode = new BuilderMode(moduleList, undefined, undefined, tree);
		const result = await mode.parse('add SineSynth as "Lead2"', session);
		expect(result.type).toBe("text");
		const applyCall = mock.calls.find((c) => c.endpoint === "/api/builder/apply");
		expect(applyCall).toBeDefined();
		const ops = (applyCall!.body as { operations: { op: string; type: string; name: string }[] }).operations;
		expect(ops[0]!.op).toBe("add");
		expect(ops[0]!.type).toBe("SineSynth");
		expect(ops[0]!.name).toBe("Lead2");
	});

	it("set bypassed dispatches set_bypassed op", async () => {
		const tree = makeTree();
		const { mock, session } = makeMock(tree);
		const mode = new BuilderMode(moduleList, undefined, undefined, tree);
		await mode.parse("set Lead.bypassed true", session);
		const applyCall = mock.calls.find((c) => c.endpoint === "/api/builder/apply");
		const ops = (applyCall!.body as { operations: { op: string; bypassed: boolean }[] }).operations;
		expect(ops[0]!.op).toBe("set_bypassed");
		expect(ops[0]!.bypassed).toBe(true);
	});

	it("set X.network dispatches /api/dsp/init (create)", async () => {
		const tree = makeTree();
		const { mock, session } = makeMock(tree);
		const mode = new BuilderMode(moduleList, undefined, undefined, tree);
		await mode.parse('set Lead.network "my_dsp"', session);
		const initCall = mock.calls.find((c) => c.endpoint.startsWith("/api/dsp/init"));
		expect(initCall).toBeDefined();
		expect(initCall!.endpoint).toMatch(/moduleId=Lead/);
		const body = initCall!.body as { name: string; mode: string };
		expect(body).toEqual({ name: "my_dsp", mode: "create" });
	});

	it("set X.network with .xml dispatches /api/dsp/init (load)", async () => {
		const tree = makeTree();
		const { mock, session } = makeMock(tree);
		const mode = new BuilderMode(moduleList, undefined, undefined, tree);
		await mode.parse('set Lead.network "my_dsp.xml"', session);
		const initCall = mock.calls.find((c) => c.endpoint.startsWith("/api/dsp/init"));
		const body = initCall!.body as { name: string; mode: string };
		expect(body).toEqual({ name: "my_dsp", mode: "load" });
	});

	it("set routing matrix dispatches set_routing op", async () => {
		const tree = makeTree();
		const { mock, session } = makeMock(tree);
		const mode = new BuilderMode(moduleList, undefined, undefined, tree);
		await mode.parse("set Lead.routing [0, 1, -1, -1]", session);
		const applyCall = mock.calls.find((c) => c.endpoint === "/api/builder/apply");
		const ops = (applyCall!.body as { operations: { op: string; matrix: number[] }[] }).operations;
		expect(ops[0]!.op).toBe("set_routing");
		expect(ops[0]!.matrix).toEqual([0, 1, -1, -1]);
	});

	it("set parent stub returns error", async () => {
		const tree = makeTree();
		const { session } = makeMock(tree);
		const mode = new BuilderMode(moduleList, undefined, undefined, tree);
		const r = await mode.parse("set Lead.parent Master", session);
		expect(r.type).toBe("error");
	});

	it("cd updates currentPath and pwd reports it", async () => {
		const tree = makeTree();
		const { session } = makeMock(tree);
		const mode = new BuilderMode(moduleList, undefined, undefined, tree);
		await mode.parse("cd Lead", session);
		const r = await mode.parse("pwd", session);
		expect(r.type).toBe("text");
		if (r.type === "text") expect(r.content).toBe("Lead");
	});

	it("cd .. from root pops mode", async () => {
		const tree = makeTree();
		const { session } = makeMock(tree);
		let popped = false;
		const popSession: SessionContext = {
			...session,
			popMode: () => { popped = true; return { type: "text", content: "popped" }; },
		};
		const mode = new BuilderMode(moduleList, undefined, undefined, tree);
		await mode.parse("cd ..", popSession);
		expect(popped).toBe(true);
	});

	it("ls returns table of children", async () => {
		const tree = makeTree();
		const { session } = makeMock(tree);
		const mode = new BuilderMode(moduleList, undefined, undefined, tree);
		const r = await mode.parse("ls", session);
		expect(r.type).toBe("table");
	});

	it("list types returns table", async () => {
		const tree = makeTree();
		const { session } = makeMock(tree);
		const mode = new BuilderMode(moduleList, undefined, undefined, tree);
		const r = await mode.parse("list types", session);
		expect(r.type).toBe("table");
	});

	it("reset succeeds with mock", async () => {
		const tree = makeTree();
		const { mock, session } = makeMock(tree);
		const mode = new BuilderMode(moduleList, undefined, undefined, tree);
		const r = await mode.parse("reset", session);
		expect(r.type).toBe("text");
		expect(mock.calls.find((c) => c.endpoint === "/api/builder/reset")).toBeDefined();
	});
});

// Live contract tests for PR6 builder endpoints. Requires a running
// HISE instance on :1900. Run via:
//   npm run test:live-contract -- src/live-contract/builder.live.test.ts
//
// Covers:
//   - set_routing matrix / preset / send (routing matrix surface from PR2)
//   - move op for set X.parent and set X.index (replaces PR5 stubs)
//
// Each test resets the module tree via /api/builder/reset for hermetic
// state.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HttpHiseConnection, HiseResponse } from "../engine/hise.js";
import { isEnvelopeResponse, isErrorResponse } from "../engine/hise.js";
import { requireLiveHiseConnection } from "./helpers.js";

let connection: HttpHiseConnection;

beforeAll(async () => {
	connection = await requireLiveHiseConnection();
});

afterAll(() => {
	connection.destroy();
});

beforeEach(async () => {
	const resp = await connection.post("/api/builder/reset", {});
	expectEnvelopeSuccess(resp, "builder reset");
});

function expectEnvelopeSuccess(resp: HiseResponse, label: string): void {
	if (isErrorResponse(resp)) throw new Error(`${label}: ${resp.message}`);
	if (!isEnvelopeResponse(resp) || !resp.success) {
		const errs = isEnvelopeResponse(resp) ? JSON.stringify(resp.errors) : String(resp);
		throw new Error(`${label} failed: ${errs}`);
	}
}

interface TreeNodeJson {
	id?: string;
	processorId?: string;
	routing?: { matrix?: number[]; send?: number[] };
	children?: TreeNodeJson[];
}

function findById(node: TreeNodeJson | null, id: string): TreeNodeJson | null {
	if (!node) return null;
	if (node.id === id || node.processorId === id) return node;
	for (const c of node.children ?? []) {
		const found = findById(c, id);
		if (found) return found;
	}
	return null;
}

async function fetchTreeRoot(): Promise<TreeNodeJson> {
	const resp = await connection.get("/api/builder/tree");
	expectEnvelopeSuccess(resp, "builder tree");
	return (resp as unknown as { result: TreeNodeJson }).result;
}

describe("live contract parity — builder set_routing", () => {
	it("preset → matrix readback matches", async () => {
		const addResp = await connection.post("/api/builder/apply", {
			operations: [{ op: "add", type: "SineSynth", parent: "Master Chain", chain: -1, name: "Lead" }],
		});
		expectEnvelopeSuccess(addResp, "add Lead");

		const routeResp = await connection.post("/api/builder/apply", {
			operations: [{ op: "set_routing", target: "Lead", preset: "stereo" }],
		});
		expectEnvelopeSuccess(routeResp, "set_routing preset stereo");

		const tree = await fetchTreeRoot();
		const lead = findById(tree, "Lead");
		expect(lead?.routing?.matrix).toEqual([0, 1]);
	});

	it("matrix array round-trips", async () => {
		const addResp = await connection.post("/api/builder/apply", {
			operations: [{ op: "add", type: "SineSynth", parent: "Master Chain", chain: -1, name: "Lead" }],
		});
		expectEnvelopeSuccess(addResp, "add Lead");

		const routeResp = await connection.post("/api/builder/apply", {
			operations: [{ op: "set_routing", target: "Lead", matrix: [1, 0] }],
		});
		expectEnvelopeSuccess(routeResp, "set_routing matrix");

		const tree = await fetchTreeRoot();
		const lead = findById(tree, "Lead");
		expect(lead?.routing?.matrix).toEqual([1, 0]);
	});

	it("send subfield round-trips", async () => {
		const addResp = await connection.post("/api/builder/apply", {
			operations: [{ op: "add", type: "SineSynth", parent: "Master Chain", chain: -1, name: "Lead" }],
		});
		expectEnvelopeSuccess(addResp, "add Lead");

		const routeResp = await connection.post("/api/builder/apply", {
			operations: [{ op: "set_routing", target: "Lead", send: [0, 1] }],
		});
		expectEnvelopeSuccess(routeResp, "set_routing send");

		const tree = await fetchTreeRoot();
		const lead = findById(tree, "Lead");
		expect(lead?.routing?.send).toEqual([0, 1]);
	});
});

describe("live contract parity — builder move op", () => {
	it("move with index reorders within current chain", async () => {
		const addResp = await connection.post("/api/builder/apply", {
			operations: [
				{ op: "add", type: "SineSynth", parent: "Master Chain", chain: -1, name: "A" },
				{ op: "add", type: "SineSynth", parent: "Master Chain", chain: -1, name: "B" },
				{ op: "add", type: "SineSynth", parent: "Master Chain", chain: -1, name: "C" },
			],
		});
		expectEnvelopeSuccess(addResp, "add A/B/C");

		const moveResp = await connection.post("/api/builder/apply", {
			operations: [{ op: "move", target: "C", index: 0 }],
		});
		expectEnvelopeSuccess(moveResp, "move C to index 0");
	});

	it("move with parent reparents", async () => {
		const addResp = await connection.post("/api/builder/apply", {
			operations: [
				{ op: "add", type: "SynthGroup", parent: "Master Chain", chain: -1, name: "Group1" },
				{ op: "add", type: "SineSynth", parent: "Master Chain", chain: -1, name: "Lead" },
			],
		});
		expectEnvelopeSuccess(addResp, "add Group1+Lead");

		const moveResp = await connection.post("/api/builder/apply", {
			operations: [{ op: "move", target: "Lead", parent: "Group1", chain: -1 }],
		});
		expectEnvelopeSuccess(moveResp, "move Lead under Group1");
	});
});

describe("live contract parity — DSP disconnect", () => {
	const HOST = "ScriptFX";
	let networkName = "";

	beforeEach(async () => {
		const addResp = await connection.post("/api/builder/apply", {
			operations: [{ op: "add", type: "ScriptFX", parent: "Master Chain", chain: 3, name: HOST }],
		});
		expectEnvelopeSuccess(addResp, "add ScriptFX");

		networkName = `__cli_pr6_${Date.now()}__`;
		const initResp = await connection.post(
			`/api/dsp/init?moduleId=${encodeURIComponent(HOST)}`,
			{ moduleId: HOST, name: networkName, mode: "create" },
		);
		expectEnvelopeSuccess(initResp, "dsp init");
	});

	it("disconnect with target+parameter clears modulation", async () => {
		const setupResp = await connection.post("/api/dsp/apply", {
			moduleId: HOST,
			operations: [
				{ op: "add", factoryPath: "core.oscillator", parent: networkName, nodeId: "Osc" },
				{ op: "add", factoryPath: "control.pma", parent: networkName, nodeId: "Pma" },
				{ op: "connect", source: "Pma", target: "Osc", parameter: "Frequency" },
			],
		});
		expectEnvelopeSuccess(setupResp, "setup osc+pma+connect");

		const dcResp = await connection.post("/api/dsp/apply", {
			moduleId: HOST,
			operations: [{ op: "disconnect", target: "Osc", parameter: "Frequency" }],
		});
		expectEnvelopeSuccess(dcResp, "disconnect Osc.Frequency");
	});
});

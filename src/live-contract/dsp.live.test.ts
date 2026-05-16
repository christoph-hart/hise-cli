// Live contract tests for the DSP REST endpoints. Requires a running
// HISE instance on :1900. Run via:
//   npm run test:live-contract:dsp
//
// Each test starts from a fully reset project tree via /api/builder/reset,
// adds a ScriptFX host, and inits a fresh DSP network on it. Tests are
// hermetic — no shared state between them.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HttpHiseConnection, HiseResponse } from "../engine/hise.js";
import { isEnvelopeResponse, isErrorResponse } from "../engine/hise.js";
import {
	normalizeDspApplyResponse,
	normalizeDspInitResponse,
	normalizeDspList,
	normalizeDspSaveResponse,
	normalizeDspTreeResponse,
	findDspNode,
	findDspConnectionTargeting,
} from "../mock/contracts/dsp.js";
import { requireLiveHiseConnection } from "./helpers.js";

let connection: HttpHiseConnection;

// Deterministic host for every test — `/api/builder/apply` with
// `name: "ScriptFX"` adds a ScriptFX module under that exact moduleId.
const HOST_MODULE_ID = "ScriptFX";

// Each test uses a unique network name so disk-persistence interactions
// across runs don't leak into subsequent tests.
let currentNetworkName = "";

beforeAll(async () => {
	connection = await requireLiveHiseConnection();
});

afterAll(() => {
	connection.destroy();
});

/**
 * Hermetic setup: wipe the module tree, add a ScriptFX host, and init a
 * fresh DSP network on it. Called from beforeEach so each test starts
 * from an identical known state.
 */
async function resetAndInit(): Promise<{ moduleId: string; networkName: string }> {
	// 1. Builder reset — wipes all non-root modules.
	const resetResp = await connection.post("/api/builder/reset", {});
	expectEnvelopeSuccess(resetResp, "builder reset");

	// 2. Add ScriptFX under Master Chain's FX chain (index 3).
	const addResp = await connection.post("/api/builder/apply", {
		operations: [{
			op: "add",
			type: "ScriptFX",
			parent: "Master Chain",
			chain: 3,
			name: HOST_MODULE_ID,
		}],
	});
	expectEnvelopeSuccess(addResp, "builder add ScriptFX");

	// 3. Init a fresh DSP network on the ScriptFX host.
	const networkName = `__cli_live_${Date.now()}_${Math.floor(Math.random() * 1000)}__`;
	const initResp = await connection.post(
		`/api/dsp/init?moduleId=${encodeURIComponent(HOST_MODULE_ID)}`,
		{ moduleId: HOST_MODULE_ID, name: networkName, mode: "create" },
	);
	expectEnvelopeSuccess(initResp, "dsp init");

	return { moduleId: HOST_MODULE_ID, networkName };
}

function expectEnvelopeSuccess(resp: HiseResponse, label: string): void {
	if (isErrorResponse(resp)) throw new Error(`${label}: ${resp.message}`);
	if (!isEnvelopeResponse(resp) || !resp.success) {
		const errs = isEnvelopeResponse(resp) ? JSON.stringify(resp.errors) : String(resp);
		throw new Error(`${label} failed: ${errs}`);
	}
}

beforeEach(async () => {
	const { networkName } = await resetAndInit();
	currentNetworkName = networkName;
});

describe("live contract parity — DSP endpoints", () => {
	it("GET /api/dsp/list matches the list contract", async () => {
		const resp = await connection.get("/api/dsp/list");
		if (isErrorResponse(resp)) throw new Error(resp.message);
		expect(isEnvelopeResponse(resp)).toBe(true);
		expect(resp.success).toBe(true);
		// `networks` is top-level per openapi — not under `result`.
		const networks = (resp as unknown as { networks: unknown }).networks;
		expect(() => normalizeDspList(networks)).not.toThrow();
	});

	it("POST /api/dsp/init returns {result, source}", async () => {
		// beforeEach has already created the network; call init again in
		// auto mode and verify the response shape.
		const resp = await connection.post(
			`/api/dsp/init?moduleId=${encodeURIComponent(HOST_MODULE_ID)}`,
			{ moduleId: HOST_MODULE_ID, name: currentNetworkName, mode: "auto" },
		);
		expectEnvelopeSuccess(resp, "init auto");
		const parsed = normalizeDspInitResponse(resp);
		expect(parsed.tree.nodeId).toBeTruthy();
		expect(parsed.source === "created" || parsed.source === "loaded").toBe(true);
	});

	it("POST /api/dsp/init mode=create errors when network exists, mode=load loads it", async () => {
		// beforeEach created the network in-memory. Save to disk first so
		// the name is persisted for the load/create-exists checks.
		const saveResp = await connection.post(
			`/api/dsp/save?moduleId=${encodeURIComponent(HOST_MODULE_ID)}`,
			{ moduleId: HOST_MODULE_ID },
		);
		expectEnvelopeSuccess(saveResp, "save");

		// Create again — expect 409 envelope failure.
		const dupResp = await connection.post(
			`/api/dsp/init?moduleId=${encodeURIComponent(HOST_MODULE_ID)}`,
			{ moduleId: HOST_MODULE_ID, name: currentNetworkName, mode: "create" },
		);
		expect(isEnvelopeResponse(dupResp) && dupResp.success).toBe(false);

		// Load — expect success + source: "loaded".
		const loadResp = await connection.post(
			`/api/dsp/init?moduleId=${encodeURIComponent(HOST_MODULE_ID)}`,
			{ moduleId: HOST_MODULE_ID, name: currentNetworkName, mode: "load" },
		);
		expectEnvelopeSuccess(loadResp, "load");
		expect(normalizeDspInitResponse(loadResp).source).toBe("loaded");
	});

	it("POST /api/dsp/init mode=load errors when network is missing", async () => {
		const resp = await connection.post(
			`/api/dsp/init?moduleId=${encodeURIComponent(HOST_MODULE_ID)}`,
			{ moduleId: HOST_MODULE_ID, name: `__cli_missing_${Date.now()}__`, mode: "load" },
		);
		expect(isEnvelopeResponse(resp) && resp.success).toBe(false);
	});

	it("GET /api/dsp/tree returns a contract-valid tree", async () => {
		const resp = await connection.get(
			`/api/dsp/tree?moduleId=${encodeURIComponent(HOST_MODULE_ID)}`,
		);
		expectEnvelopeSuccess(resp, "tree");
		if (!isEnvelopeResponse(resp)) throw new Error("unreachable");
		const { raw, tree } = normalizeDspTreeResponse(resp.result);
		expect(raw.nodeId).toBeTruthy();
		expect(raw.factoryPath).toBeTruthy();
		expect(tree.label).toBe(raw.nodeId);
	});

	it("GET /api/dsp/runtime_status returns graph runtime validity", async () => {
		const resp = await connection.get(
			`/api/dsp/runtime_status?moduleId=${encodeURIComponent(HOST_MODULE_ID)}`,
		);
		if (isErrorResponse(resp)) throw new Error(resp.message);
		expect(isEnvelopeResponse(resp)).toBe(true);
		if (!isEnvelopeResponse(resp)) throw new Error("unreachable");
		expect(typeof (resp as unknown as { moduleId?: unknown }).moduleId).toBe("string");
		expect(typeof (resp as unknown as { ok?: unknown }).ok).toBe("boolean");
		expect(Array.isArray(resp.logs)).toBe(true);
		expect(Array.isArray(resp.errors)).toBe(true);
	});

	it("POST /api/dsp/apply round-trips add → set → connect → get-tree", async () => {
		const ops = [
			{ op: "add", factoryPath: "core.oscillator", parent: currentNetworkName, nodeId: "OscCli" },
			{ op: "add", factoryPath: "control.pma", parent: currentNetworkName, nodeId: "PmaCli" },
			{ op: "set", nodeId: "OscCli", parameterId: "Frequency", value: 880 },
			{ op: "connect", source: "PmaCli", target: "OscCli", parameter: "Frequency" },
		];
		const apply = await connection.post(`/api/dsp/apply`, {
			moduleId: HOST_MODULE_ID, operations: ops,
		});
		expectEnvelopeSuccess(apply, "apply");
		const applyParsed = normalizeDspApplyResponse(apply);
		expect(applyParsed.diff.length).toBeGreaterThan(0);

		// Read the tree back and verify the modifications survived.
		const treeResp = await connection.get(
			`/api/dsp/tree?moduleId=${encodeURIComponent(HOST_MODULE_ID)}`,
		);
		expectEnvelopeSuccess(treeResp, "tree fetch after apply");
		if (!isEnvelopeResponse(treeResp)) throw new Error("unreachable");
		const { raw } = normalizeDspTreeResponse(treeResp.result);
		const osc = findDspNode(raw, "OscCli");
		expect(osc).not.toBeNull();
		expect(osc?.factoryPath).toBe("core.oscillator");
		expect(osc?.parameters.find((p) => p.parameterId === "Frequency")?.value).toBe(880);
		const conn = findDspConnectionTargeting(raw, "OscCli", "Frequency");
		expect(conn?.source).toBe("PmaCli");
	});

	it("POST /api/dsp/save returns a filePath", async () => {
		const resp = await connection.post(
			`/api/dsp/save?moduleId=${encodeURIComponent(HOST_MODULE_ID)}`,
			{ moduleId: HOST_MODULE_ID },
		);
		expectEnvelopeSuccess(resp, "save");
		const parsed = normalizeDspSaveResponse(resp);
		expect(parsed.filePath).toMatch(/\.xml$/);
	});

	it("POST /api/dsp/apply {op:'clear'} detaches the active network", async () => {
		// Seed a child so clear has something to remove.
		const seed = await connection.post(`/api/dsp/apply`, {
			moduleId: HOST_MODULE_ID,
			operations: [
				{ op: "add", factoryPath: "core.oscillator", parent: currentNetworkName, nodeId: "OscSeed" },
			],
		});
		expectEnvelopeSuccess(seed, "seed");

		const resp = await connection.post(`/api/dsp/apply`, {
			moduleId: HOST_MODULE_ID, operations: [{ op: "clear" }],
		});
		expectEnvelopeSuccess(resp, "clear");

		// HISE's `clear` op detaches the active network from the host — it
		// does not merely empty children. Subsequent GET /api/dsp/tree
		// therefore returns a 404 envelope until the next init call.
		const treeResp = await connection.get(
			`/api/dsp/tree?moduleId=${encodeURIComponent(HOST_MODULE_ID)}`,
		);
		expect(isEnvelopeResponse(treeResp) && treeResp.success).toBe(false);
	});
});

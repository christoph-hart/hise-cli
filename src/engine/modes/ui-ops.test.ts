import { describe, expect, it } from "vitest";
import { commandToOps } from "./ui-ops.js";
import { parseSingleUiCommand, type UiCommand } from "./ui-parser.js";
import type { TreeNode } from "../result.js";

const NULL_TREE: TreeNode | null = null;

function parseOk(input: string): UiCommand {
	const r = parseSingleUiCommand(input);
	if ("error" in r) throw new Error(r.error);
	return r.command;
}

function opsOk(input: string, tree: TreeNode | null = NULL_TREE, cwd: string[] = []): { op: string; [k: string]: unknown }[] {
	const cmd = parseOk(input);
	const r = commandToOps(cmd, tree, cwd);
	if ("error" in r) throw new Error(r.error);
	return r.ops;
}

function opsErr(input: string, tree: TreeNode | null = NULL_TREE, cwd: string[] = []): string {
	const cmd = parseOk(input);
	const r = commandToOps(cmd, tree, cwd);
	if (!("error" in r)) throw new Error(`expected error, got ${JSON.stringify(r.ops)}`);
	return r.error;
}

describe("ui-ops — add", () => {
	it("emits add op with id from alias", () => {
		const ops = opsOk('add ScriptButton as "Play"');
		expect(ops[0]).toMatchObject({
			op: "add",
			componentType: "ScriptButton",
			id: "Play",
		});
	});

	it("uses cwd as parentId when no `to`", () => {
		const ops = opsOk('add ScriptButton as "Inner"', null, ["Container"]);
		expect(ops[0]!.parentId).toBe("Container");
	});
});

describe("ui-ops — remove / rename", () => {
	it("remove emits remove op", () => {
		const ops = opsOk("remove Play");
		expect(ops[0]).toMatchObject({ op: "remove", target: "Play" });
	});

	it("rename emits rename op", () => {
		const ops = opsOk('rename Play as "PlayBtn"');
		expect(ops[0]).toMatchObject({ op: "rename", target: "Play", newId: "PlayBtn" });
	});
});

describe("ui-ops — set scalar properties", () => {
	it("set Play.x emits set with x property", () => {
		const ops = opsOk("set Play.x 120");
		expect(ops[0]).toMatchObject({
			op: "set",
			target: "Play",
			properties: { x: 120 },
		});
	});

	it("set Play.text emits string write", () => {
		const ops = opsOk('set Play.text "Hello"');
		expect((ops[0]!.properties as Record<string, unknown>).text).toBe("Hello");
	});

	it("set Play.visible emits boolean", () => {
		const ops = opsOk("set Play.visible true");
		expect((ops[0]!.properties as Record<string, unknown>).visible).toBe(true);
	});
});

describe("ui-ops — bounds / position / size", () => {
	it("set X.bounds [a,b,c,d] expands to x/y/width/height writes", () => {
		const ops = opsOk("set Play.bounds [100, 200, 80, 32]");
		expect(ops).toEqual([
			{ op: "set", target: "Play", properties: { x: 100 } },
			{ op: "set", target: "Play", properties: { y: 200 } },
			{ op: "set", target: "Play", properties: { width: 80 } },
			{ op: "set", target: "Play", properties: { height: 32 } },
		]);
	});

	it("rejects 3-int bounds", () => {
		expect(opsErr("set Play.bounds [1, 2, 3]")).toMatch(/4 ints/);
	});

	it("set X.position [a,b] expands to x/y writes", () => {
		const ops = opsOk("set Play.position [10, 20]");
		expect(ops).toEqual([
			{ op: "set", target: "Play", properties: { x: 10 } },
			{ op: "set", target: "Play", properties: { y: 20 } },
		]);
	});

	it("set X.size [w,h] expands to width/height writes", () => {
		const ops = opsOk("set Play.size [80, 32]");
		expect(ops).toEqual([
			{ op: "set", target: "Play", properties: { width: 80 } },
			{ op: "set", target: "Play", properties: { height: 32 } },
		]);
	});

	it("rejects 4-int position", () => {
		expect(opsErr("set Play.position [1, 2, 3, 4]")).toMatch(/2 ints/);
	});
});

describe("ui-ops — set X.value via set_component_value", () => {
	it("emits set_value pseudo op", () => {
		const ops = opsOk("set Play.value 0.7");
		expect(ops[0]).toMatchObject({ op: "set_value", target: "Play", value: 0.7 });
	});
});

describe("ui-ops — set X.parent → move", () => {
	it("emits move op with new parent", () => {
		const ops = opsOk("set Play.parent Container");
		expect(ops[0]).toMatchObject({ op: "move", target: "Play", parent: "Container" });
	});
});

describe("ui-ops — set X.index → move with current parent", () => {
	const tree: TreeNode = {
		id: "Interface",
		label: "Interface",
		children: [
			{ id: "Container", label: "Container", children: [
				{ id: "Play", label: "Play", children: [] },
			]},
		],
	};

	it("looks up current parent and emits move op with index", () => {
		const ops = opsOk("set Play.index 2", tree);
		expect(ops[0]).toMatchObject({ op: "move", target: "Play", parent: "Container", index: 2 });
	});

	it("errors when tree unavailable", () => {
		expect(opsErr("set Play.index 2", null)).toMatch(/cannot determine current parent/);
	});
});

describe("ui-ops — read-only fields", () => {
	it("set X.type rejected", () => {
		expect(opsErr("set Play.type ScriptButton")).toMatch(/read-only/);
	});
});

describe("ui-ops — local-only commands", () => {
	for (const input of ["get Play.x", "show Play", "show tree", "cd Play", "ls", "pwd", "reset"]) {
		it(`commandToOps('${input}') is local-only`, () => {
			expect(opsErr(input)).toBe("handled locally");
		});
	}
});

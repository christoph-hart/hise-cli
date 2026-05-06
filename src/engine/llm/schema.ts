import type { TreeNode } from "../result.js";
import type { ModuleList } from "../data.js";
import type { ComponentPropertyMap } from "../modes/ui-parser.js";
import { VALID_COMPONENT_TYPES } from "../modes/ui-parser.js";
import type { LlmMode } from "./types.js";

export interface SchemaContext {
	mode: LlmMode;
	tree: TreeNode | null;
	moduleList?: ModuleList;
	componentProperties?: ComponentPropertyMap;
}

/** JSON schema produced by the schema generator. Loose typing because schemas
 *  contain `oneOf`, `enum`, etc. and TS can't model recursively-tagged unions
 *  cleanly without bloat. */
export type JsonSchema = Record<string, unknown>;

const BUILDER_CHAINS = ["fx", "gain", "pitch", "midi", "children"];

/** Walk a TreeNode and collect every module instance id (chain nodes skipped). */
function collectModuleIds(node: TreeNode | null): string[] {
	if (!node) return [];
	const ids: string[] = [];
	const walk = (n: TreeNode): void => {
		if (n.nodeKind !== "chain") {
			const id = n.id ?? n.label;
			if (id) ids.push(id);
		}
		n.children?.forEach(walk);
	};
	walk(node);
	return ids;
}

function moduleTypeIds(list: ModuleList | undefined): string[] {
	if (!list) return [];
	return list.modules.map((m) => m.id);
}

/** Generate a JSON schema for the given mode + live state.
 *  Builder + UI have full structured schemas; DSP falls back to permissive
 *  (single string command) until its schema is implemented. */
export function buildSchema(ctx: SchemaContext): JsonSchema {
	if (ctx.mode === "builder") return buildBuilderSchema(ctx);
	if (ctx.mode === "ui") return buildUiSchema(ctx);
	return permissiveSchema();
}

function permissiveSchema(): JsonSchema {
	return {
		type: "object",
		properties: {
			command: { type: "string" },
		},
		required: ["command"],
	};
}

function buildBuilderSchema(ctx: SchemaContext): JsonSchema {
	const targets = collectModuleIds(ctx.tree);
	const types = moduleTypeIds(ctx.moduleList);

	const targetEnum = targets.length > 0 ? { enum: targets } : { type: "string" };
	const typeEnum = types.length > 0 ? { enum: types } : { type: "string" };

	const addCommand = {
		type: "object",
		properties: {
			kind: { const: "add" },
			moduleType: typeEnum,
			alias: { type: "string" },
			parent: targetEnum,
			chain: { enum: BUILDER_CHAINS },
		},
		required: ["kind", "moduleType"],
		additionalProperties: false,
	};

	const removeCommand = {
		type: "object",
		properties: {
			kind: { const: "remove" },
			target: targetEnum,
		},
		required: ["kind", "target"],
		additionalProperties: false,
	};

	const cloneCommand = {
		type: "object",
		properties: {
			kind: { const: "clone" },
			target: targetEnum,
			count: { type: "integer", minimum: 1 },
		},
		required: ["kind", "target"],
		additionalProperties: false,
	};

	const renameCommand = {
		type: "object",
		properties: {
			kind: { const: "rename" },
			target: targetEnum,
			name: { type: "string" },
		},
		required: ["kind", "target", "name"],
		additionalProperties: false,
	};

	const setCommand = {
		type: "object",
		properties: {
			kind: { const: "set" },
			target: targetEnum,
			param: { type: "string" },
			value: {
				oneOf: [
					{ type: "number" },
					{ type: "string" },
					{ type: "boolean" },
				],
			},
		},
		required: ["kind", "target", "param", "value"],
		additionalProperties: false,
	};

	const bypassCommand = {
		type: "object",
		properties: {
			kind: { const: "bypass" },
			target: targetEnum,
		},
		required: ["kind", "target"],
		additionalProperties: false,
	};

	const enableCommand = {
		type: "object",
		properties: {
			kind: { const: "enable" },
			target: targetEnum,
		},
		required: ["kind", "target"],
		additionalProperties: false,
	};

	const loadCommand = {
		type: "object",
		properties: {
			kind: { const: "load" },
			source: { type: "string" },
			target: targetEnum,
		},
		required: ["kind", "source", "target"],
		additionalProperties: false,
	};

	const showCommand = {
		type: "object",
		properties: {
			kind: { const: "show" },
			what: { enum: ["tree", "types", "target"] },
			target: targetEnum,
			filter: { type: "string" },
		},
		required: ["kind", "what"],
		additionalProperties: false,
	};

	const navCommand = {
		type: "object",
		properties: {
			kind: { enum: ["pwd", "ls", "reset"] },
		},
		required: ["kind"],
		additionalProperties: false,
	};

	const cdCommand = {
		type: "object",
		properties: {
			kind: { const: "cd" },
			path: { type: "string" },
		},
		required: ["kind", "path"],
		additionalProperties: false,
	};

	return {
		type: "object",
		properties: {
			commands: {
				type: "array",
				minItems: 1,
				maxItems: 8,
				items: {
					oneOf: [
						addCommand,
						removeCommand,
						cloneCommand,
						renameCommand,
						setCommand,
						bypassCommand,
						enableCommand,
						loadCommand,
						showCommand,
						navCommand,
						cdCommand,
					],
				},
			},
		},
		required: ["commands"],
		additionalProperties: false,
	};
}

function buildUiSchema(ctx: SchemaContext): JsonSchema {
	const targets = collectModuleIds(ctx.tree);
	const targetEnum = targets.length > 0 ? { enum: targets } : { type: "string" };
	const componentTypeEnum = { enum: [...VALID_COMPONENT_TYPES] };

	const addCommand = {
		type: "object",
		properties: {
			kind: { const: "add" },
			componentType: componentTypeEnum,
			name: { type: "string" },
			x: { type: "integer" },
			y: { type: "integer" },
			width: { type: "integer" },
			height: { type: "integer" },
		},
		required: ["kind", "componentType"],
		additionalProperties: false,
	};

	const removeCommand = {
		type: "object",
		properties: {
			kind: { const: "remove" },
			target: targetEnum,
		},
		required: ["kind", "target"],
		additionalProperties: false,
	};

	const setCommand = {
		type: "object",
		properties: {
			kind: { const: "set" },
			target: targetEnum,
			prop: { type: "string" },
			value: {
				oneOf: [
					{ type: "number" },
					{ type: "string" },
					{ type: "boolean" },
				],
			},
		},
		required: ["kind", "target", "prop", "value"],
		additionalProperties: false,
	};

	const moveCommand = {
		type: "object",
		properties: {
			kind: { const: "move" },
			target: targetEnum,
			parent: targetEnum,
			index: { type: "integer", minimum: 0 },
		},
		required: ["kind", "target", "parent"],
		additionalProperties: false,
	};

	const renameCommand = {
		type: "object",
		properties: {
			kind: { const: "rename" },
			target: targetEnum,
			newName: { type: "string" },
		},
		required: ["kind", "target", "newName"],
		additionalProperties: false,
	};

	const showCommand = {
		type: "object",
		properties: {
			kind: { const: "show" },
			what: { enum: ["tree", "target"] },
			target: targetEnum,
		},
		required: ["kind", "what"],
		additionalProperties: false,
	};

	return {
		type: "object",
		properties: {
			commands: {
				type: "array",
				minItems: 1,
				maxItems: 8,
				items: {
					oneOf: [
						addCommand,
						removeCommand,
						setCommand,
						moveCommand,
						renameCommand,
						showCommand,
					],
				},
			},
		},
		required: ["commands"],
		additionalProperties: false,
	};
}

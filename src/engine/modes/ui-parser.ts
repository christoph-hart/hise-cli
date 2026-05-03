// ── UI Chevrotain CST parser + command types ─────────────────────────

import { CstParser, type CstNode, type IToken } from "chevrotain";
import { closest } from "fastest-levenshtein";
import { stripQuotes, splitByComma, findLastUnquotedComma } from "../string-utils.js";
import {
	Add, Remove, Move, Rename, Into, Show, Set, Get, To, As, At, Tree,
	Identifier, QuotedString, NumberLiteral, Dot,
	uiLexer, UI_TOKENS, UI_VERB_KEYWORDS,
} from "./tokens.js";

// ── Valid component types ────────────────────────────────────────

export const VALID_COMPONENT_TYPES = [
	"ScriptButton", "ScriptSlider", "ScriptPanel", "ScriptComboBox",
	"ScriptLabel", "ScriptImage", "ScriptTable", "ScriptSliderPack",
	"ScriptAudioWaveform", "ScriptFloatingTile", "ScriptDynamicContainer",
	"ScriptedViewport", "ScriptMultipageDialog", "ScriptWebView",
] as const;

// ── Component property map type ──────────────────────────────────

export interface ComponentPropertyDef {
	defaultValue: unknown;
	type: string;
	options?: string[];
	description?: string;
}

export type ComponentPropertyMap = Record<string, Record<string, ComponentPropertyDef>>;

/** Common properties shared by all ScriptComponent subclasses. */
export const COMMON_COMPONENT_PROPERTIES = [
	"value", "text", "visible", "enabled", "locked",
	"x", "y", "width", "height",
	"min", "max", "defaultValue",
	"tooltip", "bgColour", "itemColour", "itemColour2", "textColour",
	"macroControl", "saveInPreset", "isPluginParameter",
	"pluginParameterName", "pluginParameterGroup",
	"deferControlCallback", "isMetaParameter", "linkedTo",
	"automationID", "useUndoManager", "parentComponent",
	"processorId", "parameterId",
] as const;

// ── Parsed command types ─────────────────────────────────────────

export interface UiAddCommand {
	type: "add";
	componentType: string;
	name?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}

export interface UiRemoveCommand {
	type: "remove";
	target: string;
}

export interface UiSetCommand {
	type: "set";
	target: string;
	prop: string;
	value: string | number;
}

export interface UiMoveCommand {
	type: "move";
	target: string;
	parent: string;
	index?: number;
}

export interface UiRenameCommand {
	type: "rename";
	target: string;
	newName: string;
}

export interface UiGetCommand {
	type: "get";
	target: string;
	prop: string;
}

export interface UiShowCommand {
	type: "show";
	what: "tree" | "target";
	target?: string;
}

export type UiCommand =
	| UiAddCommand
	| UiRemoveCommand
	| UiSetCommand
	| UiGetCommand
	| UiMoveCommand
	| UiRenameCommand
	| UiShowCommand;

// ── Chevrotain CST Parser ────────────────────────────────────────

class UiParser extends CstParser {
	constructor() {
		super(UI_TOKENS);
		this.performSelfAnalysis();
	}

	// Reusable: multi-word target (greedy Identifier+ or QuotedString)
	public targetRef = this.RULE("targetRef", () => {
		this.OR([
			{ ALT: () => this.CONSUME(QuotedString, { LABEL: "quoted" }) },
			{ ALT: () => this.AT_LEAST_ONE(() => this.CONSUME(Identifier, { LABEL: "words" })) },
		]);
	});

	// add <type> [as] ["<name>" | <name>] [at <x> <y> <w> <h>]
	public addCommand = this.RULE("addCommand", () => {
		this.CONSUME(Add);
		this.OR2([
			{ ALT: () => this.CONSUME3(QuotedString, { LABEL: "quotedType" }) },
			{ ALT: () => this.AT_LEAST_ONE2(() => this.CONSUME2(Identifier, { LABEL: "componentType" })) },
		]);
		this.OPTION(() => {
			this.OR3([
				{ ALT: () => this.CONSUME(QuotedString, { LABEL: "quotedName" }) },
				{ ALT: () => {
					this.CONSUME(As);
					this.OR4([
						{ ALT: () => this.CONSUME2(QuotedString, { LABEL: "quotedName" }) },
						{ ALT: () => this.CONSUME4(Identifier, { LABEL: "nameWord" }) },
					]);
				}},
			]);
		});
		this.OPTION2(() => {
			this.CONSUME(At);
			this.CONSUME(NumberLiteral, { LABEL: "x" });
			this.CONSUME2(NumberLiteral, { LABEL: "y" });
			this.CONSUME3(NumberLiteral, { LABEL: "width" });
			this.CONSUME4(NumberLiteral, { LABEL: "height" });
		});
	});

	// remove <target>
	public removeCommand = this.RULE("removeCommand", () => {
		this.CONSUME(Remove);
		this.SUBRULE(this.targetRef, { LABEL: "target" });
	});

	// set <target>.<prop> [to] <value>
	public setCommand = this.RULE("setCommand", () => {
		this.CONSUME(Set);
		this.OR([
			{ ALT: () => this.CONSUME(QuotedString, { LABEL: "quotedTarget" }) },
			{ ALT: () => this.AT_LEAST_ONE(() => this.CONSUME(Identifier, { LABEL: "targetWords" })) },
		]);
		this.CONSUME(Dot);
		this.CONSUME2(Identifier, { LABEL: "prop" });
		this.OPTION(() => {
			this.CONSUME(To);
		});
		this.OR2([
			{ ALT: () => this.CONSUME(NumberLiteral, { LABEL: "numValue" }) },
			{ ALT: () => this.CONSUME2(QuotedString, { LABEL: "strValue" }) },
			{ ALT: () => this.CONSUME3(Identifier, { LABEL: "idValue" }) },
		]);
	});

	// move <target> to <parent> [at <index>]
	public moveCommand = this.RULE("moveCommand", () => {
		this.CONSUME(Move);
		this.SUBRULE(this.targetRef, { LABEL: "target" });
		this.CONSUME(To);
		this.SUBRULE2(this.targetRef, { LABEL: "parent" });
		this.OPTION(() => {
			this.CONSUME(At);
			this.CONSUME(NumberLiteral, { LABEL: "index" });
		});
	});

	// rename <target> to "<newName>" | rename <target> to <newName...>
	public renameCommand = this.RULE("renameCommand", () => {
		this.CONSUME(Rename);
		this.SUBRULE(this.targetRef, { LABEL: "target" });
		this.CONSUME(To);
		this.OR([
			{ ALT: () => this.CONSUME(QuotedString, { LABEL: "quotedNewName" }) },
			{ ALT: () => this.AT_LEAST_ONE(() => this.CONSUME(Identifier, { LABEL: "newNameWords" })) },
		]);
	});

	// show tree | show <target>
	public showCommand = this.RULE("showCommand", () => {
		this.CONSUME(Show);
		this.OR([
			{ ALT: () => this.CONSUME(Tree, { LABEL: "tree" }) },
			{ ALT: () => this.SUBRULE(this.targetRef, { LABEL: "target" }) },
		]);
	});

	// get <target>.<prop>
	public getCommand = this.RULE("getCommand", () => {
		this.CONSUME(Get);
		this.OR([
			{ ALT: () => this.CONSUME(QuotedString, { LABEL: "quotedTarget" }) },
			{ ALT: () => this.AT_LEAST_ONE(() => this.CONSUME(Identifier, { LABEL: "targetWords" })) },
		]);
		this.CONSUME(Dot);
		this.CONSUME2(Identifier, { LABEL: "prop" });
	});

	// Top-level entry
	public command = this.RULE("command", () => {
		this.OR([
			{ ALT: () => this.SUBRULE(this.addCommand) },
			{ ALT: () => this.SUBRULE(this.removeCommand) },
			{ ALT: () => this.SUBRULE(this.setCommand) },
			{ ALT: () => this.SUBRULE(this.getCommand) },
			{ ALT: () => this.SUBRULE(this.moveCommand) },
			{ ALT: () => this.SUBRULE(this.renameCommand) },
			{ ALT: () => this.SUBRULE(this.showCommand) },
		]);
	});
}

const parser = new UiParser();

// ── CST extractors ───────────────────────────────────────────────

/** Narrow a CstElement to CstNode (sub-rules always produce CstNode, not IToken). */
const asNode = (el: import("chevrotain").CstElement) => el as CstNode;

function extractCommand(
	cst: CstNode,
): { command: UiCommand } | { error: string } {
	const c = cst.children;
	if (c.addCommand) return extractAddCommand(c.addCommand[0] as CstNode);
	if (c.removeCommand) return extractTargetCommand(c.removeCommand[0] as CstNode, "remove");
	if (c.setCommand) return extractSetCommand(c.setCommand[0] as CstNode);
	if (c.getCommand) return extractGetCommand(c.getCommand[0] as CstNode);
	if (c.moveCommand) return extractMoveCommand(c.moveCommand[0] as CstNode);
	if (c.renameCommand) return extractRenameCommand(c.renameCommand[0] as CstNode);
	if (c.showCommand) return extractShowCommand(c.showCommand[0] as CstNode);
	return { error: "Unknown command structure" };
}

/** Extract a multi-word target from a targetRef subrule CST node. */
function extractTargetRef(node: CstNode): string {
	if (node.children.quoted) {
		return stripQuotes((node.children.quoted[0] as IToken).image);
	}
	const words = (node.children.words as IToken[]).map((t) => t.image);
	return words.join(" ");
}

function extractAddCommand(
	node: CstNode,
): { command: UiAddCommand } | { error: string } {
	let componentType: string;
	if (node.children.quotedType) {
		componentType = stripQuotes((node.children.quotedType[0] as IToken).image);
	} else {
		const words = (node.children.componentType as IToken[]).map((t) => t.image);
		componentType = words.join(" ");
	}

	const name = node.children.quotedName
		? stripQuotes((node.children.quotedName[0] as IToken).image)
		: node.children.nameWord
			? (node.children.nameWord[0] as IToken).image
			: undefined;

	const x = node.children.x
		? parseFloat((node.children.x[0] as IToken).image)
		: undefined;
	const y = node.children.y
		? parseFloat((node.children.y[0] as IToken).image)
		: undefined;
	const width = node.children.width
		? parseFloat((node.children.width[0] as IToken).image)
		: undefined;
	const height = node.children.height
		? parseFloat((node.children.height[0] as IToken).image)
		: undefined;

	return {
		command: { type: "add", componentType, name, x, y, width, height },
	};
}

function extractTargetCommand(
	node: CstNode,
	type: "remove",
): { command: UiRemoveCommand } | { error: string } {
	const target = extractTargetRef(asNode(node.children.target[0]));
	return { command: { type, target } };
}

function extractSetCommand(
	node: CstNode,
): { command: UiSetCommand } | { error: string } {
	let target: string;
	if (node.children.quotedTarget) {
		target = stripQuotes((node.children.quotedTarget[0] as IToken).image);
	} else {
		const words = (node.children.targetWords as IToken[]).map((t) => t.image);
		target = words.join(" ");
	}

	const prop = (node.children.prop[0] as IToken).image;

	let value: string | number;
	if (node.children.numValue) {
		value = parseFloat((node.children.numValue[0] as IToken).image);
	} else if (node.children.strValue) {
		value = stripQuotes((node.children.strValue[0] as IToken).image);
	} else if (node.children.idValue) {
		value = (node.children.idValue[0] as IToken).image;
	} else {
		return { error: "Missing value in set command" };
	}

	return { command: { type: "set", target, prop, value } };
}

function extractGetCommand(
	node: CstNode,
): { command: UiGetCommand } | { error: string } {
	let target: string;
	if (node.children.quotedTarget) {
		target = stripQuotes((node.children.quotedTarget[0] as IToken).image);
	} else {
		const words = (node.children.targetWords as IToken[]).map((t) => t.image);
		target = words.join(" ");
	}
	const prop = (node.children.prop[0] as IToken).image;
	return { command: { type: "get", target, prop } };
}

function extractMoveCommand(
	node: CstNode,
): { command: UiMoveCommand } | { error: string } {
	const target = extractTargetRef(asNode(node.children.target[0]));
	const parent = extractTargetRef(asNode(node.children.parent[0]));
	const index = node.children.index
		? parseInt((node.children.index[0] as IToken).image, 10)
		: undefined;
	return { command: { type: "move", target, parent, index } };
}

function extractRenameCommand(
	node: CstNode,
): { command: UiRenameCommand } | { error: string } {
	const target = extractTargetRef(asNode(node.children.target[0]));
	const newName = node.children.quotedNewName
		? stripQuotes((node.children.quotedNewName[0] as IToken).image)
		: (node.children.newNameWords as IToken[]).map((t) => t.image).join(" ");
	return { command: { type: "rename", target, newName } };
}

function extractShowCommand(
	node: CstNode,
): { command: UiShowCommand } | { error: string } {
	if (node.children.tree) {
		return { command: { type: "show", what: "tree" } };
	}
	const target = extractTargetRef(asNode(node.children.target[0]));
	return { command: { type: "show", what: "target", target } };
}

// ── Component type validation ────────────────────────────────────

export function validateComponentType(componentType: string): string | null {
	const match = VALID_COMPONENT_TYPES.find(
		(t) => t.toLowerCase() === componentType.toLowerCase(),
	);
	if (match) return null;

	const suggestion = closest(componentType, [...VALID_COMPONENT_TYPES]);
	return `Unknown component type "${componentType}".${suggestion ? ` Did you mean "${suggestion}"?` : ""}`;
}

// ── Command → API operations mapping ─────────────────────────────

export interface UiOp {
	op: string;
	[key: string]: unknown;
}

/** Generate a default component name from a type (e.g. "ScriptButton" → "Button1"). */
function defaultComponentName(componentType: string): string {
	const base = componentType.replace(/^Script(ed)?/, "");
	return `${base}1`;
}

/**
 * Convert a parsed UiCommand into HISE API operation(s).
 * Returns an array of ops (most commands produce exactly one).
 */
export function commandToOps(
	cmd: UiCommand,
	currentPath: string[],
): { ops: UiOp[] } | { error: string } {
	switch (cmd.type) {
		case "add": {
			const op: UiOp = {
				op: "add",
				componentType: cmd.componentType,
				id: cmd.name ?? defaultComponentName(cmd.componentType),
			};
			if (cmd.x !== undefined) op.x = cmd.x;
			if (cmd.y !== undefined) op.y = cmd.y;
			if (cmd.width !== undefined) op.width = cmd.width;
			if (cmd.height !== undefined) op.height = cmd.height;
			// If inside a panel context, use it as parentId
			if (currentPath.length > 0) {
				op.parentId = currentPath[currentPath.length - 1];
			}
			return { ops: [op] };
		}
		case "remove":
			return { ops: [{ op: "remove", target: cmd.target }] };
		case "set":
			return { ops: [{ op: "set", target: cmd.target, properties: { [cmd.prop]: cmd.value } }] };
		case "move": {
			const moveOp: UiOp = { op: "move", target: cmd.target, parent: cmd.parent };
			if (cmd.index !== undefined) moveOp.index = cmd.index;
			return { ops: [moveOp] };
		}
		case "rename":
			return { ops: [{ op: "rename", target: cmd.target, newId: cmd.newName }] };
		case "get":
			return { error: "get commands are handled locally" };
		case "show":
			return { error: "show commands are handled locally" };
	}
}

// ── Parse functions ──────────────────────────────────────────────

/**
 * Parse a single command string through the Chevrotain parser.
 * Does not handle comma chaining — use parseUiInput for that.
 */
export function parseSingleUiCommand(
	input: string,
): { command: UiCommand } | { error: string } {
	const lexResult = uiLexer.tokenize(input);
	if (lexResult.errors.length > 0) {
		return { error: `Lexer error: ${lexResult.errors[0].message}` };
	}

	parser.input = lexResult.tokens;
	const cst = parser.command();

	if (parser.errors.length > 0) {
		return { error: `Parse error: ${parser.errors[0].message}` };
	}

	return extractCommand(cst);
}

/**
 * Parse UI input with comma chaining support.
 * Returns an array of commands. Supports verb inheritance and
 * set target inheritance across comma-separated segments.
 */
export function parseUiInput(
	input: string,
): { commands: UiCommand[] } | { error: string } {
	const segments = splitByComma(input);
	let lastVerb: string | null = null;
	let lastSetTarget: string | null = null;
	const commands: UiCommand[] = [];

	for (let i = 0; i < segments.length; i++) {
		const trimmed = segments[i].trim();
		if (!trimmed) continue;

		const firstToken = trimmed.split(/\s/)[0].toLowerCase();
		const isKeyword = UI_VERB_KEYWORDS.has(firstToken);

		let toParse: string;
		if (isKeyword) {
			toParse = trimmed;
			lastVerb = firstToken;
		} else if ((lastVerb === "set" || lastVerb === "get") && !trimmed.includes(".")) {
			// Set/get continuation without dot — inherit target
			if (!lastSetTarget) {
				return { error: `No target to inherit in segment: ${trimmed}` };
			}
			toParse = `${lastVerb} ${lastSetTarget}.${trimmed}`;
		} else if (lastVerb) {
			toParse = `${lastVerb} ${trimmed}`;
		} else {
			return { error: `No verb for segment: ${trimmed}` };
		}

		const result = parseSingleUiCommand(toParse);
		if ("error" in result) {
			return { error: `${result.error} (in: ${trimmed})` };
		}
		commands.push(result.command);

		// Track last set/get target for inheritance
		if (result.command.type === "set") {
			lastSetTarget = result.command.target;
		} else if (result.command.type === "get") {
			lastSetTarget = result.command.target;
		}
	}

	if (commands.length === 0) {
		return { error: "Empty command" };
	}
	return { commands };
}

export { findLastUnquotedComma };

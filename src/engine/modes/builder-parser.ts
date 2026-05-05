// ── Builder Chevrotain CST parser + command types ────────────────────

import { CstParser, type CstNode, type IToken } from "chevrotain";
import {
	Add,
	As,
	Bypass,
	Clone,
	Enable,
	Get,
	Into,
	Load,
	Move,
	Remove,
	Rename,
	builderLexer,
	Dot,
	Identifier,
	NumberLiteral,
	QuotedString,
	Set,
	Show,
	To,
	Tree,
	Types,
	XCount,
	BUILDER_TOKENS,
	VERB_KEYWORDS,
} from "./tokens.js";
import { stripQuotes, splitByComma, findLastUnquotedComma } from "../string-utils.js";

// ── Parsed command types ──────────────────────────────────────────

export interface AddCommand {
	type: "add";
	moduleType: string;
	alias?: string;
	parent?: string;
	chain?: string;
}

export interface CloneCommand {
	type: "clone";
	source: string;
	count: number;
}

export interface RemoveCommand {
	type: "remove";
	target: string;
}

export interface MoveCommand {
	type: "move";
	target: string;
	parent: string;
	chain?: string;
}

export interface RenameCommand {
	type: "rename";
	target: string;
	name: string;
}

export interface SetCommand {
	type: "set";
	target: string;
	param: string;
	value: string | number;
}

export interface LoadCommand {
	type: "load";
	source: string;
	target: string;
}

export interface BypassCommand {
	type: "bypass";
	target: string;
}

export interface EnableCommand {
	type: "enable";
	target: string;
}

export interface GetCommand {
	type: "get";
	target: string;
	param: string;
}

export interface ShowCommand {
	type: "show";
	what: "tree" | "types" | "target";
	target?: string;
	filter?: string;
}

export type BuilderCommand =
	| AddCommand
	| CloneCommand
	| RemoveCommand
	| MoveCommand
	| RenameCommand
	| SetCommand
	| GetCommand
	| LoadCommand
	| BypassCommand
	| EnableCommand
	| ShowCommand;

// ── Chevrotain CST Parser ─────────────────────────────────────────

class BuilderParser extends CstParser {
	constructor() {
		super(BUILDER_TOKENS);
		this.performSelfAnalysis();
	}

	// Reusable: multi-word target (greedy Identifier+ or QuotedString)
	public targetRef = this.RULE("targetRef", () => {
		this.OR([
			{ ALT: () => this.CONSUME(QuotedString, { LABEL: "quoted" }) },
			{ ALT: () => this.AT_LEAST_ONE(() => this.CONSUME(Identifier, { LABEL: "words" })) },
		]);
	});

	// add <type> [as "<name>"] [to <target>[.<chain>]]
	// `as` and `to` clauses are order-independent — both orderings parse the same.
	// Type can be multi-word (e.g., "Noise Generator") — greedy Identifier+ or QuotedString.
	public addCommand = this.RULE("addCommand", () => {
		this.CONSUME(Add);
		this.OR2([
			{ ALT: () => this.CONSUME3(QuotedString, { LABEL: "quotedType" }) },
			{ ALT: () => this.AT_LEAST_ONE(() => this.CONSUME2(Identifier, { LABEL: "moduleType" })) },
		]);
		this.MANY(() => {
			this.OR3([
				{ ALT: () => {
					this.CONSUME(As);
					this.OR4([
						{ ALT: () => this.CONSUME(QuotedString, { LABEL: "alias" }) },
						{ ALT: () => this.AT_LEAST_ONE2(() => this.CONSUME4(Identifier, { LABEL: "aliasWords" })) },
					]);
				}},
				{ ALT: () => {
					this.CONSUME(To);
					this.SUBRULE(this.targetRef, { LABEL: "parent" });
					this.OPTION(() => {
						this.CONSUME(Dot);
						this.CONSUME3(Identifier, { LABEL: "chain" });
					});
				}},
			]);
		});
	});

	// clone <target> [x<count>]
	public cloneCommand = this.RULE("cloneCommand", () => {
		this.CONSUME(Clone);
		this.SUBRULE(this.targetRef, { LABEL: "source" });
		this.OPTION(() => {
			this.CONSUME(XCount, { LABEL: "count" });
		});
	});

	// remove <target>
	public removeCommand = this.RULE("removeCommand", () => {
		this.CONSUME(Remove);
		this.SUBRULE(this.targetRef, { LABEL: "target" });
	});

	// move <target> to <parent>[.<chain>]
	public moveCommand = this.RULE("moveCommand", () => {
		this.CONSUME(Move);
		this.SUBRULE(this.targetRef, { LABEL: "target" });
		this.CONSUME(To);
		this.SUBRULE2(this.targetRef, { LABEL: "parent" });
		this.OPTION(() => {
			this.CONSUME(Dot);
			this.CONSUME(Identifier, { LABEL: "chain" });
		});
	});

	// rename <target> to "<name>" | rename <target> to <name...>
	public renameCommand = this.RULE("renameCommand", () => {
		this.CONSUME(Rename);
		this.SUBRULE(this.targetRef, { LABEL: "target" });
		this.CONSUME(To);
		this.OR([
			{ ALT: () => this.CONSUME(QuotedString, { LABEL: "quotedName" }) },
			{ ALT: () => this.AT_LEAST_ONE(() => this.CONSUME(Identifier, { LABEL: "nameWords" })) },
		]);
	});

	// set <target>.<param> [to] <value>
	// Target may be quoted ("My Module") or multi-word (My Module)
	public setCommand = this.RULE("setCommand", () => {
		this.CONSUME(Set);
		this.OR([
			{ ALT: () => this.CONSUME(QuotedString, { LABEL: "quotedTarget" }) },
			{ ALT: () => this.AT_LEAST_ONE(() => this.CONSUME(Identifier, { LABEL: "targetWords" })) },
		]);
		this.CONSUME(Dot);
		this.CONSUME2(Identifier, { LABEL: "param" });
		this.OPTION(() => {
			this.CONSUME(To);
		});
		this.OR2([
			{ ALT: () => this.CONSUME(NumberLiteral, { LABEL: "numValue" }) },
			{ ALT: () => this.CONSUME2(QuotedString, { LABEL: "strValue" }) },
			{ ALT: () => this.CONSUME3(Identifier, { LABEL: "idValue" }) },
		]);
	});

	// load "<source>" into <target> | load <source> into <target>
	public loadCommand = this.RULE("loadCommand", () => {
		this.CONSUME(Load);
		this.OR([
			{ ALT: () => this.CONSUME(QuotedString, { LABEL: "quotedSource" }) },
			{ ALT: () => this.CONSUME(Identifier, { LABEL: "sourceWord" }) },
		]);
		this.CONSUME(Into);
		this.SUBRULE(this.targetRef, { LABEL: "target" });
	});

	// bypass <target>
	public bypassCommand = this.RULE("bypassCommand", () => {
		this.CONSUME(Bypass);
		this.SUBRULE(this.targetRef, { LABEL: "target" });
	});

	// enable <target>
	public enableCommand = this.RULE("enableCommand", () => {
		this.CONSUME(Enable);
		this.SUBRULE(this.targetRef, { LABEL: "target" });
	});

	// show tree | show types [filter] | show <target>
	public showCommand = this.RULE("showCommand", () => {
		this.CONSUME(Show);
		this.OR([
			{ ALT: () => this.CONSUME(Tree, { LABEL: "tree" }) },
			{ ALT: () => {
				this.CONSUME(Types, { LABEL: "types" });
				this.OPTION(() => {
					this.CONSUME(Identifier, { LABEL: "filter" });
				});
			}},
			{ ALT: () => this.SUBRULE(this.targetRef, { LABEL: "target" }) },
		]);
	});

	// get <target>.<param>
	public getCommand = this.RULE("getCommand", () => {
		this.CONSUME(Get);
		this.OR([
			{ ALT: () => this.CONSUME(QuotedString, { LABEL: "quotedTarget" }) },
			{ ALT: () => this.AT_LEAST_ONE(() => this.CONSUME(Identifier, { LABEL: "targetWords" })) },
		]);
		this.CONSUME(Dot);
		this.CONSUME2(Identifier, { LABEL: "param" });
	});

	// Top-level entry: dispatches to sub-rules
	public command = this.RULE("command", () => {
		this.OR([
			{ ALT: () => this.SUBRULE(this.addCommand) },
			{ ALT: () => this.SUBRULE(this.cloneCommand) },
			{ ALT: () => this.SUBRULE(this.removeCommand) },
			{ ALT: () => this.SUBRULE(this.moveCommand) },
			{ ALT: () => this.SUBRULE(this.renameCommand) },
			{ ALT: () => this.SUBRULE(this.setCommand) },
			{ ALT: () => this.SUBRULE(this.getCommand) },
			{ ALT: () => this.SUBRULE(this.loadCommand) },
			{ ALT: () => this.SUBRULE(this.bypassCommand) },
			{ ALT: () => this.SUBRULE(this.enableCommand) },
			{ ALT: () => this.SUBRULE(this.showCommand) },
		]);
	});
}

const parser = new BuilderParser();

// ── CST extractors ────────────────────────────────────────────────

/** Narrow a CstElement to CstNode (sub-rules always produce CstNode, not IToken). */
const asNode = (el: import("chevrotain").CstElement) => el as CstNode;

function extractCommand(
	cst: CstNode,
): { command: BuilderCommand } | { error: string } {
	const c = cst.children;
	if (c.addCommand) return extractAddCommand(c.addCommand[0] as CstNode);
	if (c.cloneCommand) return extractCloneCommand(c.cloneCommand[0] as CstNode);
	if (c.removeCommand) return extractTargetCommand(c.removeCommand[0] as CstNode, "remove");
	if (c.moveCommand) return extractMoveCommand(c.moveCommand[0] as CstNode);
	if (c.renameCommand) return extractRenameCommand(c.renameCommand[0] as CstNode);
	if (c.setCommand) return extractSetCommand(c.setCommand[0] as CstNode);
	if (c.getCommand) return extractGetCommand(c.getCommand[0] as CstNode);
	if (c.loadCommand) return extractLoadCommand(c.loadCommand[0] as CstNode);
	if (c.bypassCommand) return extractTargetCommand(c.bypassCommand[0] as CstNode, "bypass");
	if (c.enableCommand) return extractTargetCommand(c.enableCommand[0] as CstNode, "enable");
	if (c.showCommand) return extractShowCommand(c.showCommand[0] as CstNode);
	return { error: "Unknown command structure" };
}

/** Extract a multi-word target from a targetRef subrule CST node. */
function extractTargetRef(node: CstNode): string {
	if (node.children.quoted) {
		return stripQuotes((node.children.quoted[0] as IToken).image);
	}
	// Multi-word: join all Identifier tokens with spaces
	const words = (node.children.words as IToken[]).map((t) => t.image);
	return words.join(" ");
}

function extractAddCommand(
	node: CstNode,
): { command: AddCommand } | { error: string } {
	let moduleType: string;
	if (node.children.quotedType) {
		moduleType = stripQuotes((node.children.quotedType[0] as IToken).image);
	} else {
		const words = (node.children.moduleType as IToken[]).map((t) => t.image);
		moduleType = words.join(" ");
	}
	const alias = node.children.alias
		? stripQuotes((node.children.alias[0] as IToken).image)
		: node.children.aliasWords
			? (node.children.aliasWords as IToken[]).map((t) => t.image).join(" ")
			: undefined;
	const parent = node.children.parent
		? extractTargetRef(asNode(node.children.parent[0]))
		: undefined;
	const chain = node.children.chain
		? (node.children.chain[0] as IToken).image
		: undefined;

	return {
		command: { type: "add", moduleType, alias, parent, chain },
	};
}

function extractCloneCommand(
	node: CstNode,
): { command: CloneCommand } | { error: string } {
	const source = extractTargetRef(asNode(node.children.source[0]));
	const countToken = node.children.count
		? (node.children.count[0] as IToken).image
		: undefined;
	const count = countToken ? parseInt(countToken.slice(1), 10) : 1;
	return { command: { type: "clone", source, count } };
}

/** Generic extractor for commands with just a target (remove, bypass, enable). */
function extractTargetCommand(
	node: CstNode,
	type: "remove" | "bypass" | "enable",
): { command: RemoveCommand | BypassCommand | EnableCommand } | { error: string } {
	const target = extractTargetRef(asNode(node.children.target[0]));
	return { command: { type, target } };
}

function extractMoveCommand(
	node: CstNode,
): { command: MoveCommand } | { error: string } {
	const target = extractTargetRef(asNode(node.children.target[0]));
	const parent = extractTargetRef(asNode(node.children.parent[0]));
	const chain = node.children.chain
		? (node.children.chain[0] as IToken).image
		: undefined;
	return { command: { type: "move", target, parent, chain } };
}

function extractRenameCommand(
	node: CstNode,
): { command: RenameCommand } | { error: string } {
	const target = extractTargetRef(asNode(node.children.target[0]));
	const name = node.children.quotedName
		? stripQuotes((node.children.quotedName[0] as IToken).image)
		: (node.children.nameWords as IToken[]).map((t) => t.image).join(" ");
	return { command: { type: "rename", target, name } };
}

function extractSetCommand(
	node: CstNode,
): { command: SetCommand } | { error: string } {
	// Target: quoted or multi-word identifiers before the dot
	let target: string;
	if (node.children.quotedTarget) {
		target = stripQuotes((node.children.quotedTarget[0] as IToken).image);
	} else {
		const words = (node.children.targetWords as IToken[]).map((t) => t.image);
		target = words.join(" ");
	}

	const param = (node.children.param[0] as IToken).image;

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

	return { command: { type: "set", target, param, value } };
}

function extractGetCommand(
	node: CstNode,
): { command: GetCommand } | { error: string } {
	let target: string;
	if (node.children.quotedTarget) {
		target = stripQuotes((node.children.quotedTarget[0] as IToken).image);
	} else {
		const words = (node.children.targetWords as IToken[]).map((t) => t.image);
		target = words.join(" ");
	}
	const param = (node.children.param[0] as IToken).image;
	return { command: { type: "get", target, param } };
}

function extractLoadCommand(
	node: CstNode,
): { command: LoadCommand } | { error: string } {
	const source = node.children.quotedSource
		? stripQuotes((node.children.quotedSource[0] as IToken).image)
		: (node.children.sourceWord[0] as IToken).image;
	const target = extractTargetRef(asNode(node.children.target[0]));
	return { command: { type: "load", source, target } };
}

function extractShowCommand(
	node: CstNode,
): { command: ShowCommand } | { error: string } {
	if (node.children.tree) {
		return { command: { type: "show", what: "tree" } };
	}
	if (node.children.types) {
		const filter = node.children.filter
			? (node.children.filter[0] as IToken).image
			: undefined;
		return { command: { type: "show", what: "types", filter } };
	}
	if (node.children.target) {
		const target = extractTargetRef(asNode(node.children.target[0]));
		return { command: { type: "show", what: "target", target } };
	}
	return { error: "Invalid show command" };
}

// ── Parse functions ───────────────────────────────────────────────

/**
 * Parse a single command string through the Chevrotain parser.
 * Does not handle comma chaining — use parseBuilderInput for that.
 */
export function parseSingleCommand(
	input: string,
): { command: BuilderCommand } | { error: string } {
	const lexResult = builderLexer.tokenize(input);
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
 * Parse builder input with comma chaining support.
 * Returns an array of commands. Supports verb inheritance and
 * set target inheritance across comma-separated segments.
 */
export function parseBuilderInput(
	input: string,
): { commands: BuilderCommand[] } | { error: string } {
	const segments = splitByComma(input);
	let lastVerb: string | null = null;
	let lastSetTarget: string | null = null;
	const commands: BuilderCommand[] = [];

	for (let i = 0; i < segments.length; i++) {
		const trimmed = segments[i].trim();
		if (!trimmed) continue;

		const firstToken = trimmed.split(/\s/)[0].toLowerCase();
		const isKeyword = VERB_KEYWORDS.has(firstToken);

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

		const result = parseSingleCommand(toParse);
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

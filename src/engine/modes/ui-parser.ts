// ── UI Chevrotain CST parser + command types ─────────────────────────
//
// Grammar surface per docs/CLI_GRAMMAR.md §204-223 (UI mode) and
// §330-408 (BNF). Native MANY_SEP comma chaining; no string preprocessor.

import { CstParser, type CstNode, type IToken } from "chevrotain";
import { closest } from "fastest-levenshtein";
import {
	Add, Remove, Rename, Show, Set, Get, Connect, Cd, Ls, Pwd, Reset,
	To, As, Tree, Types, BooleanLiteral,
	Identifier, QuotedString, NumberLiteral, PercentLiteral, HexLiteral,
	Dot, DoubleDot, Comma, LBracket, RBracket,
	uiLexer, UI_TOKENS,
} from "./tokens.js";
import {
	parseBooleanLiteral,
	parseHexLiteral,
	parseNumberLiteral,
	parseNumericArray,
	parsePercentLiteral,
	parseQuotedString,
	type Value,
	type ValueResult,
} from "../grammar/value-parser.js";
import {
	buildPathFromSegments,
	type PathRef,
} from "../grammar/path-parser.js";

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
	alias: string;
	parent?: PathRef;
}

export interface UiAddChainCommand {
	type: "addChain";
	clauses: { componentType: string; alias: string }[];
}

export interface UiRemoveCommand {
	type: "remove";
	targets: PathRef[];
}

export interface UiRenameCommand {
	type: "rename";
	target: PathRef;
	name: string;
}

export interface UiSetClause {
	path: PathRef;
	value: Value;
}

export interface UiSetCommand {
	type: "set";
	clauses: UiSetClause[];
}

export interface UiGetCommand {
	type: "get";
	paths: PathRef[];
}

export interface UiConnectCommand {
	type: "connect";
	component: PathRef;
	target: PathRef;
	matched: boolean;
}

export type UiShowCommand =
	| { type: "show"; kind: "tree"; filter?: string }
	| { type: "show"; kind: "target"; target: PathRef };

export interface UiCdCommand { type: "cd"; target: PathRef }
export interface UiLsCommand { type: "ls" }
export interface UiPwdCommand { type: "pwd" }
export interface UiResetCommand { type: "reset" }

export type UiCommand =
	| UiAddCommand
	| UiAddChainCommand
	| UiRemoveCommand
	| UiRenameCommand
	| UiSetCommand
	| UiGetCommand
	| UiConnectCommand
	| UiShowCommand
	| UiCdCommand
	| UiLsCommand
	| UiPwdCommand
	| UiResetCommand;

// ── Chevrotain CST Parser ────────────────────────────────────────

class UiParser extends CstParser {
	constructor() {
		super(UI_TOKENS);
		this.performSelfAnalysis();
	}

	public pathExpr = this.RULE("pathExpr", () => {
		this.OR([
			{ ALT: () => this.CONSUME(DoubleDot) },
			{ ALT: () => {
				this.SUBRULE(this.pathSegment, { LABEL: "first" });
				this.MANY(() => {
					this.CONSUME(Dot);
					this.SUBRULE2(this.pathSegment, { LABEL: "rest" });
				});
			}},
		]);
	});

	public pathSegment = this.RULE("pathSegment", () => {
		this.OR([
			{ ALT: () => this.CONSUME(Identifier) },
			{ ALT: () => this.CONSUME(QuotedString) },
		]);
	});

	public typeRef = this.RULE("typeRef", () => {
		this.OR([
			{ ALT: () => this.CONSUME(Identifier) },
			{ ALT: () => this.CONSUME(QuotedString) },
		]);
	});

	public arrayValue = this.RULE("arrayValue", () => {
		this.CONSUME(LBracket);
		this.AT_LEAST_ONE_SEP({
			SEP: Comma,
			DEF: () => this.CONSUME(NumberLiteral),
		});
		this.CONSUME(RBracket);
	});

	public value = this.RULE("value", () => {
		this.OR([
			{ ALT: () => this.SUBRULE(this.arrayValue) },
			{ ALT: () => this.CONSUME(HexLiteral) },
			{ ALT: () => this.CONSUME(PercentLiteral) },
			{ ALT: () => this.CONSUME(NumberLiteral) },
			{ ALT: () => this.CONSUME(BooleanLiteral) },
			{ ALT: () => this.SUBRULE(this.pathExpr) },
		]);
	});

	public addClause = this.RULE("addClause", () => {
		this.SUBRULE(this.typeRef, { LABEL: "componentType" });
		this.CONSUME(As);
		this.CONSUME(QuotedString, { LABEL: "alias" });
		this.OPTION(() => {
			this.CONSUME(To);
			this.SUBRULE(this.pathExpr, { LABEL: "parent" });
		});
	});

	public addCommand = this.RULE("addCommand", () => {
		this.CONSUME(Add);
		this.AT_LEAST_ONE_SEP({
			SEP: Comma,
			DEF: () => this.SUBRULE(this.addClause),
		});
	});

	public removeCommand = this.RULE("removeCommand", () => {
		this.CONSUME(Remove);
		this.AT_LEAST_ONE_SEP({
			SEP: Comma,
			DEF: () => this.SUBRULE(this.pathExpr, { LABEL: "target" }),
		});
	});

	public renameCommand = this.RULE("renameCommand", () => {
		this.CONSUME(Rename);
		this.SUBRULE(this.pathExpr, { LABEL: "target" });
		this.CONSUME(As);
		this.CONSUME(QuotedString, { LABEL: "name" });
	});

	public setClause = this.RULE("setClause", () => {
		this.SUBRULE(this.pathExpr, { LABEL: "path" });
		this.SUBRULE(this.value, { LABEL: "value" });
	});

	public setCommand = this.RULE("setCommand", () => {
		this.CONSUME(Set);
		this.AT_LEAST_ONE_SEP({
			SEP: Comma,
			DEF: () => this.SUBRULE(this.setClause),
		});
	});

	public getCommand = this.RULE("getCommand", () => {
		this.CONSUME(Get);
		this.AT_LEAST_ONE_SEP({
			SEP: Comma,
			DEF: () => this.SUBRULE(this.pathExpr, { LABEL: "path" }),
		});
	});

	public connectCommand = this.RULE("connectCommand", () => {
		this.CONSUME(Connect);
		this.SUBRULE(this.pathExpr, { LABEL: "component" });
		this.CONSUME(To);
		this.SUBRULE2(this.pathExpr, { LABEL: "target" });
		this.OPTION(() => {
			this.CONSUME(Identifier, { LABEL: "matched" });
		});
	});

	public showCommand = this.RULE("showCommand", () => {
		this.CONSUME(Show);
		this.OR([
			{
				ALT: () => {
					this.CONSUME(Tree, { LABEL: "noun_tree" });
					this.OPTION(() => {
						this.OR2([
							{ ALT: () => this.CONSUME(QuotedString, { LABEL: "filterQuoted" }) },
							{ ALT: () => this.CONSUME(Identifier, { LABEL: "filterBare" }) },
						]);
					});
				},
			},
			{ ALT: () => this.SUBRULE(this.pathExpr, { LABEL: "target" }) },
		]);
	});

	public cdCommand = this.RULE("cdCommand", () => {
		this.CONSUME(Cd);
		this.SUBRULE(this.pathExpr, { LABEL: "target" });
	});

	public lsCommand = this.RULE("lsCommand", () => { this.CONSUME(Ls); });
	public pwdCommand = this.RULE("pwdCommand", () => { this.CONSUME(Pwd); });
	public resetCommand = this.RULE("resetCommand", () => { this.CONSUME(Reset); });

	public command = this.RULE("command", () => {
		this.OR([
			{ ALT: () => this.SUBRULE(this.addCommand) },
			{ ALT: () => this.SUBRULE(this.removeCommand) },
			{ ALT: () => this.SUBRULE(this.renameCommand) },
			{ ALT: () => this.SUBRULE(this.setCommand) },
			{ ALT: () => this.SUBRULE(this.getCommand) },
			{ ALT: () => this.SUBRULE(this.connectCommand) },
			{ ALT: () => this.SUBRULE(this.showCommand) },
			{ ALT: () => this.SUBRULE(this.cdCommand) },
			{ ALT: () => this.SUBRULE(this.lsCommand) },
			{ ALT: () => this.SUBRULE(this.pwdCommand) },
			{ ALT: () => this.SUBRULE(this.resetCommand) },
		]);
		// Suppress unused-token warnings for tokens referenced only by
		// the lexer (kept so future grammar growth can reach them).
		void Types; void Reset;
	});
}

const parser = new UiParser();

// ── CST extractors ───────────────────────────────────────────────

function extractPathSegmentImage(node: CstNode): string {
	const c = node.children;
	if (c.Identifier) return (c.Identifier[0] as IToken).image;
	if (c.QuotedString) return (c.QuotedString[0] as IToken).image;
	throw new Error("pathSegment: no Identifier or QuotedString");
}

function extractPathExpr(node: CstNode): { ref: PathRef } | { error: string } {
	const c = node.children;
	if (c.DoubleDot) return { ref: { kind: "parent" } };
	const segments: string[] = [];
	if (c.first) segments.push(extractPathSegmentImage(c.first[0] as CstNode));
	if (c.rest) {
		for (const seg of c.rest as import("chevrotain").CstElement[]) {
			segments.push(extractPathSegmentImage(seg as CstNode));
		}
	}
	const r = buildPathFromSegments(segments);
	if (!r.ok) return { error: r.error };
	return { ref: r.ref };
}

function pathRefSegmentCount(ref: PathRef): number {
	if (ref.kind === "parent") return 0;
	if (ref.kind === "bare") return 1;
	return ref.segments.length;
}

function extractTypeRef(node: CstNode): string {
	const c = node.children;
	if (c.Identifier) return (c.Identifier[0] as IToken).image;
	if (c.QuotedString) {
		const r = parseQuotedString((c.QuotedString[0] as IToken).image);
		if (r.ok && r.value.kind === "string") return r.value.s;
	}
	throw new Error("typeRef: no Identifier or QuotedString");
}

function extractArrayValue(node: CstNode): ValueResult {
	const tokens = (node.children.NumberLiteral ?? []) as IToken[];
	const elements: Value[] = [];
	for (const t of tokens) {
		const r = parseNumberLiteral(t.image);
		if (!r.ok) return r;
		elements.push(r.value);
	}
	return parseNumericArray(elements, "N");
}

function extractValue(node: CstNode): ValueResult {
	const c = node.children;
	if (c.arrayValue) return extractArrayValue(c.arrayValue[0] as CstNode);
	if (c.HexLiteral) return parseHexLiteral((c.HexLiteral[0] as IToken).image);
	if (c.PercentLiteral) return parsePercentLiteral((c.PercentLiteral[0] as IToken).image);
	if (c.NumberLiteral) return parseNumberLiteral((c.NumberLiteral[0] as IToken).image);
	if (c.BooleanLiteral) return parseBooleanLiteral((c.BooleanLiteral[0] as IToken).image);
	if (c.pathExpr) {
		const r = extractPathExpr(c.pathExpr[0] as CstNode);
		if ("error" in r) return { ok: false, error: r.error };
		if (r.ref.kind === "bare" && r.ref.segment.quoted) {
			return { ok: true, value: { kind: "string", s: r.ref.segment.id } };
		}
		return { ok: true, value: { kind: "path", ref: r.ref } };
	}
	return { ok: false, error: "value: no alternative matched" };
}

function extractAddCommand(node: CstNode): { command: UiCommand } | { error: string } {
	const clauseNodes = (node.children.addClause ?? []) as CstNode[];
	if (clauseNodes.length === 0) return { error: "add: no clauses" };
	const clauses: { componentType: string; alias: string; parent?: PathRef }[] = [];
	for (const clNode of clauseNodes) {
		const cl = clNode.children;
		const componentType = extractTypeRef(cl.componentType![0] as CstNode);
		const aliasRes = parseQuotedString((cl.alias![0] as IToken).image);
		if (!aliasRes.ok || aliasRes.value.kind !== "string") return { error: "add: invalid alias" };
		let parent: PathRef | undefined;
		if (cl.parent) {
			const p = extractPathExpr(cl.parent[0] as CstNode);
			if ("error" in p) return { error: p.error };
			parent = p.ref;
		}
		clauses.push({ componentType, alias: aliasRes.value.s, parent });
	}
	if (clauses.length === 1) {
		const c = clauses[0];
		return { command: { type: "add", componentType: c.componentType, alias: c.alias, parent: c.parent } };
	}
	for (const c of clauses) {
		if (c.parent) return { error: "`to` clause is forbidden in chained `add` — chained adds use cwd only" };
	}
	return {
		command: {
			type: "addChain",
			clauses: clauses.map((c) => ({ componentType: c.componentType, alias: c.alias })),
		},
	};
}

function extractRemoveCommand(node: CstNode): { command: UiRemoveCommand } | { error: string } {
	const targets: PathRef[] = [];
	for (const t of (node.children.target ?? []) as import("chevrotain").CstElement[]) {
		const r = extractPathExpr(t as CstNode);
		if ("error" in r) return { error: r.error };
		targets.push(r.ref);
	}
	if (targets.length === 0) return { error: "remove: no targets" };
	return { command: { type: "remove", targets } };
}

function extractRenameCommand(node: CstNode): { command: UiRenameCommand } | { error: string } {
	const target = extractPathExpr(node.children.target![0] as CstNode);
	if ("error" in target) return { error: target.error };
	const nameRes = parseQuotedString((node.children.name![0] as IToken).image);
	if (!nameRes.ok || nameRes.value.kind !== "string") return { error: "rename: invalid name" };
	return { command: { type: "rename", target: target.ref, name: nameRes.value.s } };
}

function extractSetCommand(node: CstNode): { command: UiSetCommand } | { error: string } {
	const clauseNodes = (node.children.setClause ?? []) as CstNode[];
	if (clauseNodes.length === 0) return { error: "set: no clauses" };
	const clauses: UiSetClause[] = [];
	for (const clNode of clauseNodes) {
		const c = clNode.children;
		const path = extractPathExpr(c.path![0] as CstNode);
		if ("error" in path) return { error: path.error };
		if (pathRefSegmentCount(path.ref) < 2) {
			return { error: "set: path must have at least 2 segments (use `set <target>.<field> <value>`)" };
		}
		const value = extractValue(c.value![0] as CstNode);
		if (!value.ok) return { error: value.error };
		clauses.push({ path: path.ref, value: value.value });
	}
	return { command: { type: "set", clauses } };
}

function extractGetCommand(node: CstNode): { command: UiGetCommand } | { error: string } {
	const paths: PathRef[] = [];
	for (const p of (node.children.path ?? []) as import("chevrotain").CstElement[]) {
		const r = extractPathExpr(p as CstNode);
		if ("error" in r) return { error: r.error };
		if (pathRefSegmentCount(r.ref) < 2) {
			return { error: "get: path must have at least 2 segments (use `get <target>.<field>`)" };
		}
		paths.push(r.ref);
	}
	if (paths.length === 0) return { error: "get: no paths" };
	return { command: { type: "get", paths } };
}

function extractConnectCommand(node: CstNode): { command: UiConnectCommand } | { error: string } {
	const component = extractPathExpr(node.children.component![0] as CstNode);
	if ("error" in component) return { error: component.error };
	const target = extractPathExpr(node.children.target![0] as CstNode);
	if ("error" in target) return { error: target.error };
	if (pathRefSegmentCount(target.ref) < 2) {
		return { error: "connect: target must be <processor>.<parameter>" };
	}
	let matched = false;
	if (node.children.matched) {
		const token = node.children.matched[0] as IToken;
		if (token.image.toLowerCase() !== "matched") {
			return { error: `connect: unknown option "${token.image}"` };
		}
		matched = true;
	}
	return { command: { type: "connect", component: component.ref, target: target.ref, matched } };
}

function extractShowCommand(node: CstNode): { command: UiShowCommand } | { error: string } {
	const c = node.children;
	if (c.noun_tree) {
		let filter: string | undefined;
		if (c.filterQuoted) {
			const r = parseQuotedString((c.filterQuoted[0] as IToken).image);
			if (!r.ok || r.value.kind !== "string") return { error: "show: invalid filter" };
			filter = r.value.s;
		} else if (c.filterBare) {
			filter = (c.filterBare[0] as IToken).image;
		}
		return { command: { type: "show", kind: "tree", filter } };
	}
	const target = extractPathExpr(c.target![0] as CstNode);
	if ("error" in target) return { error: target.error };
	return { command: { type: "show", kind: "target", target: target.ref } };
}

function extractCdCommand(node: CstNode): { command: UiCdCommand } | { error: string } {
	const target = extractPathExpr(node.children.target![0] as CstNode);
	if ("error" in target) return { error: target.error };
	return { command: { type: "cd", target: target.ref } };
}

function extractCommand(cst: CstNode): { command: UiCommand } | { error: string } {
	const c = cst.children;
	if (c.addCommand) return extractAddCommand(c.addCommand[0] as CstNode);
	if (c.removeCommand) return extractRemoveCommand(c.removeCommand[0] as CstNode);
	if (c.renameCommand) return extractRenameCommand(c.renameCommand[0] as CstNode);
	if (c.setCommand) return extractSetCommand(c.setCommand[0] as CstNode);
	if (c.getCommand) return extractGetCommand(c.getCommand[0] as CstNode);
	if (c.connectCommand) return extractConnectCommand(c.connectCommand[0] as CstNode);
	if (c.showCommand) return extractShowCommand(c.showCommand[0] as CstNode);
	if (c.cdCommand) return extractCdCommand(c.cdCommand[0] as CstNode);
	if (c.lsCommand) return { command: { type: "ls" } };
	if (c.pwdCommand) return { command: { type: "pwd" } };
	if (c.resetCommand) return { command: { type: "reset" } };
	return { error: "Unknown command structure" };
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

// ── Parse functions ──────────────────────────────────────────────

export function parseSingleUiCommand(input: string): { command: UiCommand } | { error: string } {
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
 * Parse UI input and split chainable statements into individual
 * commands so the dispatcher can execute and report each one.
 */
export function parseUiInput(input: string): { commands: UiCommand[] } | { error: string } {
	const result = parseSingleUiCommand(input);
	if ("error" in result) return result;
	const cmd = result.command;
	if (cmd.type === "set") {
		return { commands: cmd.clauses.map((cl): UiCommand => ({ type: "set", clauses: [cl] })) };
	}
	if (cmd.type === "get") {
		return { commands: cmd.paths.map((p): UiCommand => ({ type: "get", paths: [p] })) };
	}
	if (cmd.type === "remove") {
		return { commands: cmd.targets.map((t): UiCommand => ({ type: "remove", targets: [t] })) };
	}
	return { commands: [cmd] };
}

export { findLastUnquotedComma } from "../string-utils.js";

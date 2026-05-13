// ── Builder Chevrotain CST parser + command types ────────────────────
//
// Grammar surface per docs/CLI_GRAMMAR.md §128-202 / §330-408.
// Comma chaining is native (Chevrotain MANY_SEP); no string pre-processor.

import { CstParser, type CstNode, type IToken } from "chevrotain";
import {
	Add,
	As,
	Cd,
	Clone,
	Comma,
	Dot,
	DoubleDot,
	Get,
	HexLiteral,
	Identifier,
	LBracket,
	Ls,
	NumberLiteral,
	PercentLiteral,
	Pwd,
	QuotedString,
	RBracket,
	Remove,
	Rename,
	Reset,
	Set,
	Show,
	BooleanLiteral,
	To,
	Tree,
	Type,
	Types,
	builderLexer,
	BUILDER_TOKENS,
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

// ── Parsed command types ──────────────────────────────────────────

export interface AddCommand {
	type: "add";
	moduleType: string;
	alias: string;
	parent?: PathRef;
}

export interface AddChainCommand {
	type: "addChain";
	clauses: { moduleType: string; alias: string }[];
}

export interface RemoveCommand {
	type: "remove";
	targets: PathRef[];
}

export interface RenameCommand {
	type: "rename";
	target: PathRef;
	name: string;
}

export interface CloneCommand {
	type: "clone";
	target: PathRef;
	count: number;
}

export interface SetClause {
	path: PathRef;
	value: Value;
}

export interface SetCommand {
	type: "set";
	clauses: SetClause[];
}

export interface GetCommand {
	type: "get";
	paths: PathRef[];
}

export type ShowCommand =
	| { type: "show"; kind: "tree" }
	| { type: "show"; kind: "target"; target: PathRef };

export interface CdCommand { type: "cd"; target: PathRef }
export interface LsCommand { type: "ls" }
export interface PwdCommand { type: "pwd" }
export interface ResetCommand { type: "reset" }

export type BuilderCommand =
	| AddCommand
	| AddChainCommand
	| RemoveCommand
	| RenameCommand
	| CloneCommand
	| SetCommand
	| GetCommand
	| ShowCommand
	| CdCommand
	| LsCommand
	| PwdCommand
	| ResetCommand;

// ── Chevrotain CST Parser ─────────────────────────────────────────

class BuilderParser extends CstParser {
	constructor() {
		super(BUILDER_TOKENS);
		this.performSelfAnalysis();
	}

	// PathExpr := DoubleDot | pathSegment ('.' pathSegment)*
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
			{ ALT: () => this.CONSUME(Type) },
			{ ALT: () => this.CONSUME(QuotedString) },
		]);
	});

	// TypeRef := QuotedString | Identifier+      ; joined-by-space form supports
	//                                              HISE pretty names like
	//                                              `Sine Wave Generator`
	public typeRef = this.RULE("typeRef", () => {
		this.OR([
			{ ALT: () => this.CONSUME(QuotedString) },
			{ ALT: () => this.AT_LEAST_ONE(() => this.CONSUME(Identifier)) },
		]);
	});

	// Array := '[' Number (',' Number)* ']'
	public arrayValue = this.RULE("arrayValue", () => {
		this.CONSUME(LBracket);
		this.AT_LEAST_ONE_SEP({
			SEP: Comma,
			DEF: () => this.CONSUME(NumberLiteral),
		});
		this.CONSUME(RBracket);
	});

	// Value := QuotedString | Number | Percent | Boolean | HexLiteral | Array | PathExpr
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

	// AddClause := TypeRef 'as' QuotedString ['to' PathExpr]
	public addClause = this.RULE("addClause", () => {
		this.SUBRULE(this.typeRef, { LABEL: "moduleType" });
		this.CONSUME(As);
		this.CONSUME(QuotedString, { LABEL: "alias" });
		this.OPTION(() => {
			this.CONSUME(To);
			this.SUBRULE(this.pathExpr, { LABEL: "parent" });
		});
	});

	// AddStmt := 'add' AddClause (',' AddClause)*
	public addCommand = this.RULE("addCommand", () => {
		this.CONSUME(Add);
		this.AT_LEAST_ONE_SEP({
			SEP: Comma,
			DEF: () => this.SUBRULE(this.addClause),
		});
	});

	// RemoveStmt := 'remove' PathExpr (',' PathExpr)*
	public removeCommand = this.RULE("removeCommand", () => {
		this.CONSUME(Remove);
		this.AT_LEAST_ONE_SEP({
			SEP: Comma,
			DEF: () => this.SUBRULE(this.pathExpr, { LABEL: "target" }),
		});
	});

	// RenameStmt := 'rename' PathExpr 'as' QuotedString
	public renameCommand = this.RULE("renameCommand", () => {
		this.CONSUME(Rename);
		this.SUBRULE(this.pathExpr, { LABEL: "target" });
		this.CONSUME(As);
		this.CONSUME(QuotedString, { LABEL: "name" });
	});

	// CloneStmt := 'clone' PathExpr Number
	public cloneCommand = this.RULE("cloneCommand", () => {
		this.CONSUME(Clone);
		this.SUBRULE(this.pathExpr, { LABEL: "target" });
		this.CONSUME(NumberLiteral, { LABEL: "count" });
	});

	// SetClause := PathExpr Value (PathExpr must have ≥2 segments — validated post-parse)
	public setClause = this.RULE("setClause", () => {
		this.SUBRULE(this.pathExpr, { LABEL: "path" });
		this.SUBRULE(this.value, { LABEL: "value" });
	});

	// SetStmt := 'set' SetClause (',' SetClause)*
	public setCommand = this.RULE("setCommand", () => {
		this.CONSUME(Set);
		this.AT_LEAST_ONE_SEP({
			SEP: Comma,
			DEF: () => this.SUBRULE(this.setClause),
		});
	});

	// GetStmt := 'get' DottedPath (',' DottedPath)*
	public getCommand = this.RULE("getCommand", () => {
		this.CONSUME(Get);
		this.AT_LEAST_ONE_SEP({
			SEP: Comma,
			DEF: () => this.SUBRULE(this.pathExpr, { LABEL: "path" }),
		});
	});

	// ShowStmt := 'show' (Tree | Types [Filter] | PathExpr)
	public showCommand = this.RULE("showCommand", () => {
		this.CONSUME(Show);
		this.OR([
			{ ALT: () => this.CONSUME(Tree, { LABEL: "noun_tree" }) },
			{ ALT: () => this.SUBRULE(this.pathExpr, { LABEL: "target" }) },
		]);
	});

	// CdStmt := 'cd' PathExpr
	public cdCommand = this.RULE("cdCommand", () => {
		this.CONSUME(Cd);
		this.SUBRULE(this.pathExpr, { LABEL: "target" });
	});

	public lsCommand = this.RULE("lsCommand", () => {
		this.CONSUME(Ls);
	});

	public pwdCommand = this.RULE("pwdCommand", () => {
		this.CONSUME(Pwd);
	});

	public resetCommand = this.RULE("resetCommand", () => {
		this.CONSUME(Reset);
	});

	// Top-level entry: dispatches to sub-rules
	public command = this.RULE("command", () => {
		this.OR([
			{ ALT: () => this.SUBRULE(this.addCommand) },
			{ ALT: () => this.SUBRULE(this.removeCommand) },
			{ ALT: () => this.SUBRULE(this.renameCommand) },
			{ ALT: () => this.SUBRULE(this.cloneCommand) },
			{ ALT: () => this.SUBRULE(this.setCommand) },
			{ ALT: () => this.SUBRULE(this.getCommand) },
			{ ALT: () => this.SUBRULE(this.showCommand) },
			{ ALT: () => this.SUBRULE(this.cdCommand) },
			{ ALT: () => this.SUBRULE(this.lsCommand) },
			{ ALT: () => this.SUBRULE(this.pwdCommand) },
			{ ALT: () => this.SUBRULE(this.resetCommand) },
		]);
	});
}

const parser = new BuilderParser();

// ── CST extractors ────────────────────────────────────────────────

const asNode = (el: import("chevrotain").CstElement): CstNode => el as CstNode;
const asToken = (el: import("chevrotain").CstElement): IToken => el as IToken;

function extractPathSegmentImage(node: CstNode): string {
	const c = node.children;
	if (c.Identifier) return (c.Identifier[0] as IToken).image;
	if (c.Type) return (c.Type[0] as IToken).image;
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
	if (c.Identifier) return (c.Identifier as IToken[]).map((t) => t.image).join(" ");
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
		// A solo quoted segment is a string value, not a path.
		if (r.ref.kind === "bare" && r.ref.segment.quoted) {
			return { ok: true, value: { kind: "string", s: r.ref.segment.id } };
		}
		return { ok: true, value: { kind: "path", ref: r.ref } };
	}
	return { ok: false, error: "value: no alternative matched" };
}

function extractAddCommand(node: CstNode): { command: BuilderCommand } | { error: string } {
	const clauseNodes = (node.children.addClause ?? []) as CstNode[];
	if (clauseNodes.length === 0) return { error: "add: no clauses" };
	const clauses: { moduleType: string; alias: string; parent?: PathRef }[] = [];
	for (const clNode of clauseNodes) {
		const cl = clNode.children;
		const moduleType = extractTypeRef(cl.moduleType![0] as CstNode);
		const aliasResult = parseQuotedString((cl.alias![0] as IToken).image);
		if (!aliasResult.ok || aliasResult.value.kind !== "string") {
			return { error: "add: invalid alias" };
		}
		const alias = aliasResult.value.s;
		let parent: PathRef | undefined;
		if (cl.parent) {
			const p = extractPathExpr(cl.parent[0] as CstNode);
			if ("error" in p) return { error: p.error };
			parent = p.ref;
		}
		clauses.push({ moduleType, alias, parent });
	}

	if (clauses.length === 1) {
		const c = clauses[0];
		return { command: { type: "add", moduleType: c.moduleType, alias: c.alias, parent: c.parent } };
	}
	for (const c of clauses) {
		if (c.parent) {
			return { error: "`to` clause is forbidden in chained `add` — chained adds use cwd only" };
		}
	}
	return {
		command: {
			type: "addChain",
			clauses: clauses.map((c) => ({ moduleType: c.moduleType, alias: c.alias })),
		},
	};
}

function extractRemoveCommand(node: CstNode): { command: RemoveCommand } | { error: string } {
	const targets: PathRef[] = [];
	for (const t of (node.children.target ?? []) as import("chevrotain").CstElement[]) {
		const r = extractPathExpr(t as CstNode);
		if ("error" in r) return { error: r.error };
		targets.push(r.ref);
	}
	if (targets.length === 0) return { error: "remove: no targets" };
	return { command: { type: "remove", targets } };
}

function extractRenameCommand(node: CstNode): { command: RenameCommand } | { error: string } {
	const target = extractPathExpr(node.children.target![0] as CstNode);
	if ("error" in target) return { error: target.error };
	const nameResult = parseQuotedString((node.children.name![0] as IToken).image);
	if (!nameResult.ok || nameResult.value.kind !== "string") {
		return { error: "rename: invalid name" };
	}
	return { command: { type: "rename", target: target.ref, name: nameResult.value.s } };
}

function extractCloneCommand(node: CstNode): { command: CloneCommand } | { error: string } {
	const target = extractPathExpr(node.children.target![0] as CstNode);
	if ("error" in target) return { error: target.error };
	const countResult = parseNumberLiteral((node.children.count![0] as IToken).image);
	if (!countResult.ok) return { error: countResult.error };
	const count = (countResult.value as { kind: "number"; n: number }).n;
	if (!Number.isInteger(count) || count < 1) {
		return { error: `clone count must be a positive integer (got ${count})` };
	}
	return { command: { type: "clone", target: target.ref, count } };
}

function extractSetCommand(node: CstNode): { command: SetCommand } | { error: string } {
	const clauseNodes = (node.children.setClause ?? []) as CstNode[];
	if (clauseNodes.length === 0) return { error: "set: no clauses" };
	const clauses: SetClause[] = [];
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

function extractGetCommand(node: CstNode): { command: GetCommand } | { error: string } {
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

function extractShowCommand(node: CstNode): { command: ShowCommand } | { error: string } {
	const c = node.children;
	if (c.noun_tree) {
		return { command: { type: "show", kind: "tree" } };
	}
	const target = extractPathExpr(c.target![0] as CstNode);
	if ("error" in target) return { error: target.error };
	return { command: { type: "show", kind: "target", target: target.ref } };
}

function extractCdCommand(node: CstNode): { command: CdCommand } | { error: string } {
	const target = extractPathExpr(node.children.target![0] as CstNode);
	if ("error" in target) return { error: target.error };
	return { command: { type: "cd", target: target.ref } };
}

function extractCommand(cst: CstNode): { command: BuilderCommand } | { error: string } {
	const c = cst.children;
	if (c.addCommand) return extractAddCommand(c.addCommand[0] as CstNode);
	if (c.removeCommand) return extractRemoveCommand(c.removeCommand[0] as CstNode);
	if (c.renameCommand) return extractRenameCommand(c.renameCommand[0] as CstNode);
	if (c.cloneCommand) return extractCloneCommand(c.cloneCommand[0] as CstNode);
	if (c.setCommand) return extractSetCommand(c.setCommand[0] as CstNode);
	if (c.getCommand) return extractGetCommand(c.getCommand[0] as CstNode);
	if (c.showCommand) return extractShowCommand(c.showCommand[0] as CstNode);
	if (c.cdCommand) return extractCdCommand(c.cdCommand[0] as CstNode);
	if (c.lsCommand) return { command: { type: "ls" } };
	if (c.pwdCommand) return { command: { type: "pwd" } };
	if (c.resetCommand) return { command: { type: "reset" } };
	return { error: "Unknown command structure" };
}

// ── Parse functions ───────────────────────────────────────────────

/**
 * Parse a single command string through the Chevrotain parser.
 * Comma chaining is handled inside individual statement rules.
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
 * Parse builder input and split chainable statements into individual
 * commands so the dispatcher can execute and report each one.
 *
 * Today only `set`, `get`, `add`, `remove` are chainable (per CLI_GRAMMAR
 * §299-313). Their parser rules already capture the clause list; this
 * function fans the clauses out into separate command records so the
 * existing dispatch loop in builder.ts works clause-by-clause.
 */
export function parseBuilderInput(
	input: string,
): { commands: BuilderCommand[] } | { error: string } {
	const result = parseSingleCommand(input);
	if ("error" in result) return result;

	const cmd = result.command;
	if (cmd.type === "set") {
		return { commands: cmd.clauses.map((cl): BuilderCommand => ({ type: "set", clauses: [cl] })) };
	}
	if (cmd.type === "get") {
		return { commands: cmd.paths.map((p): BuilderCommand => ({ type: "get", paths: [p] })) };
	}
	if (cmd.type === "remove") {
		return { commands: cmd.targets.map((t): BuilderCommand => ({ type: "remove", targets: [t] })) };
	}
	return { commands: [cmd] };
}

// ── Helper re-exports (kept for external callers like UI/DSP completion) ──

export { findLastUnquotedComma } from "../string-utils.js";

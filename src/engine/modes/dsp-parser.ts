// ── DSP Chevrotain CST parser + command types ────────────────────────
//
// Grammar surface per docs/CLI_GRAMMAR.md §225-288 and §330-408.
// Native MANY_SEP comma chaining for set/get/add/remove/connect/disconnect.

import { CstParser, type CstNode, type IToken } from "chevrotain";
import {
	Add,
	As,
	BooleanLiteral,
	Cd,
	Comma,
	Connect,
	Connections,
	CreateParameter,
	Disconnect,
	Dot,
	DoubleDot,
	DSP_TOKENS,
	File,
	Get,
	HexLiteral,
	Identifier,
	LBracket,
	List,
	Ls,
	Modules,
	Networks,
	NumberLiteral,
	PercentLiteral,
	Pwd,
	QuotedString,
	RBracket,
	Remove,
	Rename,
	Reset,
	Save,
	Scale,
	Screenshot,
	Set,
	Show,
	To,
	Tree,
	Types,
	dspLexer,
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

// ── Command types ─────────────────────────────────────────────────

export interface AddCommand {
	type: "add";
	factory: string;
	node: string;
	alias: string;
	parent?: PathRef;
}

export interface AddChainCommand {
	type: "addChain";
	clauses: { factory: string; node: string; alias: string }[];
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

export interface ConnectClause {
	source: PathRef;
	target: PathRef;
	matched: boolean;
}

export interface ConnectCommand {
	type: "connect";
	clauses: ConnectClause[];
}

export interface DisconnectCommand {
	type: "disconnect";
	targets: PathRef[];
}

export interface CreateParameterCommand {
	type: "createParameter";
	container: PathRef;
	paramName: string;
	range: [number, number];
	defaultValue?: number;
	stepSize?: number;
	middlePosition?: number;
	skewFactor?: number;
}

export interface ScreenshotCommand {
	type: "screenshot";
	scale: number;
	file: string;
}

export interface ShowCommand {
	type: "show";
	target: PathRef;
}

export interface ListCommand {
	type: "list";
	noun: "networks" | "modules" | "connections" | "tree";
	filter?: string;
}

export interface CdCommand { type: "cd"; target: PathRef }
export interface LsCommand { type: "ls" }
export interface PwdCommand { type: "pwd" }
export interface ResetCommand { type: "reset" }
export interface SaveCommand { type: "save" }

export type DspCommand =
	| AddCommand
	| AddChainCommand
	| RemoveCommand
	| RenameCommand
	| SetCommand
	| GetCommand
	| ConnectCommand
	| DisconnectCommand
	| CreateParameterCommand
	| ScreenshotCommand
	| ShowCommand
	| ListCommand
	| CdCommand
	| LsCommand
	| PwdCommand
	| ResetCommand
	| SaveCommand;

// ── Chevrotain CST parser ─────────────────────────────────────────

class DspParser extends CstParser {
	constructor() {
		super(DSP_TOKENS);
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
			{ ALT: () => this.CONSUME(NumberLiteral) },
			{ ALT: () => this.CONSUME(QuotedString) },
		]);
	});

	// factory.node — DSP type ref is always 2-segment.
	public factoryRef = this.RULE("factoryRef", () => {
		this.CONSUME(Identifier, { LABEL: "factory" });
		this.CONSUME(Dot);
		this.SUBRULE(this.pathSegment, { LABEL: "node" });
	});

	public arrayValue = this.RULE("arrayValue", () => {
		this.CONSUME(LBracket);
		this.AT_LEAST_ONE_SEP({
			SEP: Comma,
			DEF: () => this.CONSUME(NumberLiteral),
		});
		this.CONSUME(RBracket);
	});

	// Note: NumberLiteral handled implicitly via pathExpr (pathSegment
	// accepts NumberLiteral so `xfader1.0` and `set X.p 0.5` both parse).
	// The extractor converts a bare-numeric segment back to a number.
	public value = this.RULE("value", () => {
		this.OR([
			{ ALT: () => this.SUBRULE(this.arrayValue) },
			{ ALT: () => this.CONSUME(HexLiteral) },
			{ ALT: () => this.CONSUME(PercentLiteral) },
			{ ALT: () => this.CONSUME(BooleanLiteral) },
			{ ALT: () => this.SUBRULE(this.pathExpr) },
		]);
	});

	public addClause = this.RULE("addClause", () => {
		this.SUBRULE(this.factoryRef, { LABEL: "factory" });
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

	// connect <pathExpr> to <pathExpr> [Identifier 'matched']
	public connectClause = this.RULE("connectClause", () => {
		this.SUBRULE(this.pathExpr, { LABEL: "source" });
		this.CONSUME(To);
		this.SUBRULE2(this.pathExpr, { LABEL: "target" });
		this.OPTION(() => {
			this.CONSUME(Identifier, { LABEL: "matchedFlag" });
		});
	});

	public connectCommand = this.RULE("connectCommand", () => {
		this.CONSUME(Connect);
		this.AT_LEAST_ONE_SEP({
			SEP: Comma,
			DEF: () => this.SUBRULE(this.connectClause),
		});
	});

	public disconnectCommand = this.RULE("disconnectCommand", () => {
		this.CONSUME(Disconnect);
		this.AT_LEAST_ONE_SEP({
			SEP: Comma,
			DEF: () => this.SUBRULE(this.pathExpr, { LABEL: "target" }),
		});
	});

	// create_parameter <DottedPath> <Array2> [Identifier <NumberLiteral>]*
	// The optional clauses are post-validated as one of:
	//   default | stepSize | middlePosition | skewFactor
	public createParamClause = this.RULE("createParamClause", () => {
		this.CONSUME(Identifier, { LABEL: "name" });
		this.CONSUME(NumberLiteral, { LABEL: "value" });
	});

	public createParameterCommand = this.RULE("createParameterCommand", () => {
		this.CONSUME(CreateParameter);
		this.SUBRULE(this.pathExpr, { LABEL: "path" });
		this.SUBRULE(this.arrayValue, { LABEL: "range" });
		this.MANY(() => {
			this.SUBRULE(this.createParamClause);
		});
	});

	// screenshot scale <ScalarValue> file <QuotedString>
	public screenshotCommand = this.RULE("screenshotCommand", () => {
		this.CONSUME(Screenshot);
		this.CONSUME(Scale);
		this.OR([
			{ ALT: () => this.CONSUME(NumberLiteral, { LABEL: "scaleNum" }) },
			{ ALT: () => this.CONSUME(PercentLiteral, { LABEL: "scalePct" }) },
		]);
		this.CONSUME(File);
		this.CONSUME(QuotedString, { LABEL: "file" });
	});

	public showCommand = this.RULE("showCommand", () => {
		this.CONSUME(Show);
		this.SUBRULE(this.pathExpr, { LABEL: "target" });
	});

	public listCommand = this.RULE("listCommand", () => {
		this.CONSUME(List);
		this.OR([
			{ ALT: () => this.CONSUME(Networks, { LABEL: "noun_networks" }) },
			{ ALT: () => this.CONSUME(Modules, { LABEL: "noun_modules" }) },
			{ ALT: () => this.CONSUME(Connections, { LABEL: "noun_connections" }) },
			{ ALT: () => this.CONSUME(Tree, { LABEL: "noun_tree" }) },
		]);
		this.OPTION(() => {
			this.OR2([
				{ ALT: () => this.CONSUME(QuotedString, { LABEL: "filterQuoted" }) },
				{ ALT: () => this.CONSUME(Identifier, { LABEL: "filterBare" }) },
			]);
		});
	});

	public cdCommand = this.RULE("cdCommand", () => {
		this.CONSUME(Cd);
		this.SUBRULE(this.pathExpr, { LABEL: "target" });
	});

	public lsCommand = this.RULE("lsCommand", () => { this.CONSUME(Ls); });
	public pwdCommand = this.RULE("pwdCommand", () => { this.CONSUME(Pwd); });
	public resetCommand = this.RULE("resetCommand", () => { this.CONSUME(Reset); });
	public saveCommand = this.RULE("saveCommand", () => { this.CONSUME(Save); });

	public command = this.RULE("command", () => {
		this.OR([
			{ ALT: () => this.SUBRULE(this.addCommand) },
			{ ALT: () => this.SUBRULE(this.removeCommand) },
			{ ALT: () => this.SUBRULE(this.renameCommand) },
			{ ALT: () => this.SUBRULE(this.setCommand) },
			{ ALT: () => this.SUBRULE(this.getCommand) },
			{ ALT: () => this.SUBRULE(this.connectCommand) },
			{ ALT: () => this.SUBRULE(this.disconnectCommand) },
			{ ALT: () => this.SUBRULE(this.createParameterCommand) },
			{ ALT: () => this.SUBRULE(this.screenshotCommand) },
			{ ALT: () => this.SUBRULE(this.showCommand) },
			{ ALT: () => this.SUBRULE(this.listCommand) },
			{ ALT: () => this.SUBRULE(this.cdCommand) },
			{ ALT: () => this.SUBRULE(this.lsCommand) },
			{ ALT: () => this.SUBRULE(this.pwdCommand) },
			{ ALT: () => this.SUBRULE(this.resetCommand) },
			{ ALT: () => this.SUBRULE(this.saveCommand) },
		]);
		// Suppress "unused token" complaints for tokens kept solely for the
		// shared lexer (inherited from the BUILDER/UI section).
		void Types;
	});
}

const parser = new DspParser();

// ── CST extractors ────────────────────────────────────────────────

function extractPathSegmentImage(node: CstNode): string {
	const c = node.children;
	if (c.Identifier) return (c.Identifier[0] as IToken).image;
	if (c.QuotedString) return (c.QuotedString[0] as IToken).image;
	if (c.NumberLiteral) return (c.NumberLiteral[0] as IToken).image;
	throw new Error("pathSegment: no Identifier / QuotedString / NumberLiteral");
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

function extractFactoryRef(node: CstNode): { factory: string; node: string } | { error: string } {
	const c = node.children;
	const factory = (c.factory![0] as IToken).image;
	const nodeNode = c.node![0] as CstNode;
	const nodeImage = extractPathSegmentImage(nodeNode);
	// Strip quotes if quoted
	const nodeName = nodeImage.startsWith('"')
		? (() => {
			const r = parseQuotedString(nodeImage);
			if (!r.ok || r.value.kind !== "string") return null;
			return r.value.s;
		})()
		: nodeImage;
	if (nodeName === null) return { error: `invalid node segment: ${nodeImage}` };
	return { factory, node: nodeName };
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
	if (c.BooleanLiteral) return parseBooleanLiteral((c.BooleanLiteral[0] as IToken).image);
	if (c.pathExpr) {
		const r = extractPathExpr(c.pathExpr[0] as CstNode);
		if ("error" in r) return { ok: false, error: r.error };
		if (r.ref.kind === "bare" && r.ref.segment.quoted) {
			return { ok: true, value: { kind: "string", s: r.ref.segment.id } };
		}
		// A bare unquoted segment whose image is purely numeric is a
		// scalar literal (the parser routes numbers via pathExpr to keep
		// `xfader1.0` parseable; see comment on the `value` rule).
		if (r.ref.kind === "bare" && !r.ref.segment.quoted && /^-?\d+(\.\d+)?$/.test(r.ref.segment.id)) {
			return parseNumberLiteral(r.ref.segment.id);
		}
		return { ok: true, value: { kind: "path", ref: r.ref } };
	}
	return { ok: false, error: "value: no alternative matched" };
}

function extractAddCommand(node: CstNode): { command: DspCommand } | { error: string } {
	const clauseNodes = (node.children.addClause ?? []) as CstNode[];
	if (clauseNodes.length === 0) return { error: "add: no clauses" };
	const clauses: { factory: string; node: string; alias: string; parent?: PathRef }[] = [];
	for (const clNode of clauseNodes) {
		const cl = clNode.children;
		const fr = extractFactoryRef(cl.factory![0] as CstNode);
		if ("error" in fr) return { error: fr.error };
		const aliasRes = parseQuotedString((cl.alias![0] as IToken).image);
		if (!aliasRes.ok || aliasRes.value.kind !== "string") return { error: "add: invalid alias" };
		let parent: PathRef | undefined;
		if (cl.parent) {
			const p = extractPathExpr(cl.parent[0] as CstNode);
			if ("error" in p) return { error: p.error };
			parent = p.ref;
		}
		clauses.push({ factory: fr.factory, node: fr.node, alias: aliasRes.value.s, parent });
	}
	if (clauses.length === 1) {
		const c = clauses[0];
		return { command: { type: "add", factory: c.factory, node: c.node, alias: c.alias, parent: c.parent } };
	}
	for (const c of clauses) {
		if (c.parent) return { error: "`to` clause is forbidden in chained `add` — chained adds use cwd only" };
	}
	return {
		command: {
			type: "addChain",
			clauses: clauses.map((c) => ({ factory: c.factory, node: c.node, alias: c.alias })),
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
	const nameRes = parseQuotedString((node.children.name![0] as IToken).image);
	if (!nameRes.ok || nameRes.value.kind !== "string") return { error: "rename: invalid name" };
	return { command: { type: "rename", target: target.ref, name: nameRes.value.s } };
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
			return { error: "set: path must have at least 2 segments (use `set <node>.<field> <value>`)" };
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
			return { error: "get: path must have at least 2 segments (use `get <node>.<field>`)" };
		}
		paths.push(r.ref);
	}
	if (paths.length === 0) return { error: "get: no paths" };
	return { command: { type: "get", paths } };
}

function extractConnectCommand(node: CstNode): { command: ConnectCommand } | { error: string } {
	const clauseNodes = (node.children.connectClause ?? []) as CstNode[];
	if (clauseNodes.length === 0) return { error: "connect: no clauses" };
	const clauses: ConnectClause[] = [];
	for (const clNode of clauseNodes) {
		const cl = clNode.children;
		const src = extractPathExpr(cl.source![0] as CstNode);
		if ("error" in src) return { error: src.error };
		const tgt = extractPathExpr(cl.target![0] as CstNode);
		if ("error" in tgt) return { error: tgt.error };
		let matched = false;
		if (cl.matchedFlag) {
			const image = (cl.matchedFlag[0] as IToken).image.toLowerCase();
			if (image !== "matched") {
				return { error: `connect: unexpected trailing token "${image}" — expected "matched" or end-of-statement` };
			}
			matched = true;
		}
		clauses.push({ source: src.ref, target: tgt.ref, matched });
	}
	return { command: { type: "connect", clauses } };
}

function extractDisconnectCommand(node: CstNode): { command: DisconnectCommand } | { error: string } {
	const targets: PathRef[] = [];
	for (const t of (node.children.target ?? []) as import("chevrotain").CstElement[]) {
		const r = extractPathExpr(t as CstNode);
		if ("error" in r) return { error: r.error };
		if (pathRefSegmentCount(r.ref) < 2) {
			return { error: "disconnect: path must have at least 2 segments (use `disconnect <node>.<param>`)" };
		}
		targets.push(r.ref);
	}
	if (targets.length === 0) return { error: "disconnect: no targets" };
	return { command: { type: "disconnect", targets } };
}

const VALID_CREATE_PARAM_KEYS = new globalThis.Set(["default", "stepsize", "middleposition", "skewfactor"]);

function extractCreateParameterCommand(node: CstNode): { command: CreateParameterCommand } | { error: string } {
	const path = extractPathExpr(node.children.path![0] as CstNode);
	if ("error" in path) return { error: path.error };
	if (pathRefSegmentCount(path.ref) < 2) {
		return { error: "create_parameter: path must have at least 2 segments (use `create_parameter <container>.<name>`)" };
	}
	// Strip the last segment as the new parameter name; resolve container from prefix.
	if (path.ref.kind !== "dotted") return { error: "create_parameter: path must be a dotted path" };
	const segs = path.ref.segments;
	const paramName = segs[segs.length - 1].id;
	const container: PathRef = segs.length === 2
		? { kind: "bare", segment: segs[0] }
		: { kind: "dotted", segments: segs.slice(0, -1) };

	const rangeVal = extractArrayValue(node.children.range![0] as CstNode);
	if (!rangeVal.ok) return { error: rangeVal.error };
	const arr = rangeVal.value;
	if (arr.kind !== "arrayN") return { error: "create_parameter: range must be a numeric array" };
	if (arr.n.length !== 2) {
		return { error: `create_parameter: range must be 2 elements [min, max] (got ${arr.n.length})` };
	}
	const range: [number, number] = [arr.n[0], arr.n[1]];

	const cmd: CreateParameterCommand = {
		type: "createParameter",
		container,
		paramName,
		range,
	};

	const clauseNodes = (node.children.createParamClause ?? []) as CstNode[];
	for (const clNode of clauseNodes) {
		const c = clNode.children;
		const name = (c.name![0] as IToken).image;
		const lowerName = name.toLowerCase();
		if (!VALID_CREATE_PARAM_KEYS.has(lowerName)) {
			return { error: `create_parameter: unknown clause "${name}" (expected default, stepSize, middlePosition, or skewFactor)` };
		}
		const valueRes = parseNumberLiteral((c.value![0] as IToken).image);
		if (!valueRes.ok) return { error: valueRes.error };
		if (valueRes.value.kind !== "number") return { error: "create_parameter: clause value must be numeric" };
		const n = valueRes.value.n;
		switch (lowerName) {
			case "default": cmd.defaultValue = n; break;
			case "stepsize": cmd.stepSize = n; break;
			case "middleposition": cmd.middlePosition = n; break;
			case "skewfactor": cmd.skewFactor = n; break;
		}
	}
	return { command: cmd };
}

function extractScreenshotCommand(node: CstNode): { command: ScreenshotCommand } | { error: string } {
	const c = node.children;
	let scale: number;
	if (c.scaleNum) {
		const r = parseNumberLiteral((c.scaleNum[0] as IToken).image);
		if (!r.ok || r.value.kind !== "number") return { error: "screenshot: invalid scale" };
		scale = r.value.n;
	} else {
		const r = parsePercentLiteral((c.scalePct![0] as IToken).image);
		if (!r.ok || r.value.kind !== "number") return { error: "screenshot: invalid scale" };
		scale = r.value.n;
	}
	const fileRes = parseQuotedString((c.file![0] as IToken).image);
	if (!fileRes.ok || fileRes.value.kind !== "string") return { error: "screenshot: invalid file" };
	return { command: { type: "screenshot", scale, file: fileRes.value.s } };
}

function extractShowCommand(node: CstNode): { command: ShowCommand } | { error: string } {
	const target = extractPathExpr(node.children.target![0] as CstNode);
	if ("error" in target) return { error: target.error };
	return { command: { type: "show", target: target.ref } };
}

function extractListCommand(node: CstNode): { command: ListCommand } | { error: string } {
	const c = node.children;
	const noun: ListCommand["noun"] = c.noun_networks
		? "networks"
		: c.noun_modules
			? "modules"
			: c.noun_connections
				? "connections"
				: "tree";
	let filter: string | undefined;
	if (c.filterQuoted) {
		const r = parseQuotedString((c.filterQuoted[0] as IToken).image);
		if (!r.ok || r.value.kind !== "string") return { error: "list: invalid filter" };
		filter = r.value.s;
	} else if (c.filterBare) {
		filter = (c.filterBare[0] as IToken).image;
	}
	return { command: { type: "list", noun, filter } };
}

function extractCdCommand(node: CstNode): { command: CdCommand } | { error: string } {
	const target = extractPathExpr(node.children.target![0] as CstNode);
	if ("error" in target) return { error: target.error };
	return { command: { type: "cd", target: target.ref } };
}

function extractCommand(cst: CstNode): { command: DspCommand } | { error: string } {
	const c = cst.children;
	if (c.addCommand) return extractAddCommand(c.addCommand[0] as CstNode);
	if (c.removeCommand) return extractRemoveCommand(c.removeCommand[0] as CstNode);
	if (c.renameCommand) return extractRenameCommand(c.renameCommand[0] as CstNode);
	if (c.setCommand) return extractSetCommand(c.setCommand[0] as CstNode);
	if (c.getCommand) return extractGetCommand(c.getCommand[0] as CstNode);
	if (c.connectCommand) return extractConnectCommand(c.connectCommand[0] as CstNode);
	if (c.disconnectCommand) return extractDisconnectCommand(c.disconnectCommand[0] as CstNode);
	if (c.createParameterCommand) return extractCreateParameterCommand(c.createParameterCommand[0] as CstNode);
	if (c.screenshotCommand) return extractScreenshotCommand(c.screenshotCommand[0] as CstNode);
	if (c.showCommand) return extractShowCommand(c.showCommand[0] as CstNode);
	if (c.listCommand) return extractListCommand(c.listCommand[0] as CstNode);
	if (c.cdCommand) return extractCdCommand(c.cdCommand[0] as CstNode);
	if (c.lsCommand) return { command: { type: "ls" } };
	if (c.pwdCommand) return { command: { type: "pwd" } };
	if (c.resetCommand) return { command: { type: "reset" } };
	if (c.saveCommand) return { command: { type: "save" } };
	return { error: "Unknown command structure" };
}

// ── Parse functions ───────────────────────────────────────────────

export function parseSingleDspCommand(input: string): { command: DspCommand } | { error: string } {
	const lexResult = dspLexer.tokenize(input);
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
 * Parse DSP input and split chainable statements into individual
 * commands so the dispatcher can execute and report each one.
 */
export function parseDspInput(input: string): { commands: DspCommand[] } | { error: string } {
	const result = parseSingleDspCommand(input);
	if ("error" in result) return result;
	const cmd = result.command;
	if (cmd.type === "set") {
		return { commands: cmd.clauses.map((cl): DspCommand => ({ type: "set", clauses: [cl] })) };
	}
	if (cmd.type === "get") {
		return { commands: cmd.paths.map((p): DspCommand => ({ type: "get", paths: [p] })) };
	}
	if (cmd.type === "remove") {
		return { commands: cmd.targets.map((t): DspCommand => ({ type: "remove", targets: [t] })) };
	}
	if (cmd.type === "connect") {
		return { commands: cmd.clauses.map((cl): DspCommand => ({ type: "connect", clauses: [cl] })) };
	}
	if (cmd.type === "disconnect") {
		return { commands: cmd.targets.map((t): DspCommand => ({ type: "disconnect", targets: [t] })) };
	}
	return { commands: [cmd] };
}

export { findLastUnquotedComma } from "../string-utils.js";

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
	SetComplexData,
	Set,
	Show,
	To,
	Tree,
	Trace,
	Type,
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

export interface SetComplexDataClause {
	path: PathRef;
	dataIndex: number;
}

export interface SetComplexDataCommand {
	type: "setComplexData";
	clauses: SetComplexDataClause[];
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

export interface TraceCommand {
	type: "trace";
	container?: PathRef;
	signalType?: "silence" | "dirac" | "noise" | "dc";
	gain?: number;
	seed?: number;
	injectBefore?: string;
	probeAfter?: string;
	delayMs?: number;
	recursive: boolean;
	changedParameters: boolean;
	compact: boolean;
	noSpecs: boolean;
	noSignal: boolean;
	injectParams: Array<{ path: PathRef; value: Value }>;
	probeParams: PathRef[];
}

export type ShowCommand =
	| { type: "show"; kind: "networks" | "modules" | "connections" | "tree"; filter?: string }
	| { type: "show"; kind: "status"; autofix?: boolean }
	| { type: "show"; kind: "target"; target: PathRef };

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
	| SetComplexDataCommand
	| GetCommand
	| ConnectCommand
	| DisconnectCommand
	| CreateParameterCommand
	| ScreenshotCommand
	| TraceCommand
	| ShowCommand
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
			{ ALT: () => this.CONSUME(Add) },
			{ ALT: () => this.CONSUME(Type) },
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

	public setComplexDataClause = this.RULE("setComplexDataClause", () => {
		this.SUBRULE(this.pathExpr, { LABEL: "path" });
		this.CONSUME(Identifier, { LABEL: "indexKeyword" });
		this.CONSUME(NumberLiteral, { LABEL: "indexValue" });
	});

	public setComplexDataCommand = this.RULE("setComplexDataCommand", () => {
		this.CONSUME(SetComplexData);
		this.AT_LEAST_ONE_SEP({
			SEP: Comma,
			DEF: () => this.SUBRULE(this.setComplexDataClause),
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

	public traceToken = this.RULE("traceToken", () => {
		this.OR([
			{ ALT: () => this.CONSUME(QuotedString) },
			{ ALT: () => this.CONSUME(HexLiteral) },
			{ ALT: () => this.CONSUME(PercentLiteral) },
			{ ALT: () => this.CONSUME(NumberLiteral) },
			{ ALT: () => this.CONSUME(BooleanLiteral) },
			{ ALT: () => this.CONSUME(Add) },
			{ ALT: () => this.CONSUME(Remove) },
			{ ALT: () => this.CONSUME(Rename) },
			{ ALT: () => this.CONSUME(Show) },
			{ ALT: () => this.CONSUME(Set) },
			{ ALT: () => this.CONSUME(Get) },
			{ ALT: () => this.CONSUME(Connect) },
			{ ALT: () => this.CONSUME(Disconnect) },
			{ ALT: () => this.CONSUME(CreateParameter) },
			{ ALT: () => this.CONSUME(SetComplexData) },
			{ ALT: () => this.CONSUME(Screenshot) },
			{ ALT: () => this.CONSUME(Trace) },
			{ ALT: () => this.CONSUME(Cd) },
			{ ALT: () => this.CONSUME(Ls) },
			{ ALT: () => this.CONSUME(Pwd) },
			{ ALT: () => this.CONSUME(Reset) },
			{ ALT: () => this.CONSUME(Save) },
			{ ALT: () => this.CONSUME(To) },
			{ ALT: () => this.CONSUME(As) },
			{ ALT: () => this.CONSUME(Tree) },
			{ ALT: () => this.CONSUME(Types) },
			{ ALT: () => this.CONSUME(Scale) },
			{ ALT: () => this.CONSUME(File) },
			{ ALT: () => this.CONSUME(Networks) },
			{ ALT: () => this.CONSUME(Modules) },
			{ ALT: () => this.CONSUME(Connections) },
			{ ALT: () => this.CONSUME(Identifier) },
			{ ALT: () => this.CONSUME(Type) },
			{ ALT: () => this.CONSUME(DoubleDot) },
			{ ALT: () => this.CONSUME(Dot) },
		]);
	});

	public traceCommand = this.RULE("traceCommand", () => {
		this.CONSUME(Trace);
		this.MANY(() => {
			this.SUBRULE(this.traceToken);
		});
	});

	public showCommand = this.RULE("showCommand", () => {
		this.CONSUME(Show);
		this.OR([
			{
				ALT: () => {
					this.OR2([
						{ ALT: () => this.CONSUME(Networks, { LABEL: "noun_networks" }) },
						{ ALT: () => this.CONSUME(Modules, { LABEL: "noun_modules" }) },
						{ ALT: () => this.CONSUME(Connections, { LABEL: "noun_connections" }) },
						{ ALT: () => this.CONSUME(Tree, { LABEL: "noun_tree" }) },
					]);
					this.OPTION(() => {
						this.OR3([
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
	public saveCommand = this.RULE("saveCommand", () => { this.CONSUME(Save); });

	public command = this.RULE("command", () => {
		this.OR([
			{ ALT: () => this.SUBRULE(this.addCommand) },
			{ ALT: () => this.SUBRULE(this.removeCommand) },
			{ ALT: () => this.SUBRULE(this.renameCommand) },
			{ ALT: () => this.SUBRULE(this.setCommand) },
			{ ALT: () => this.SUBRULE(this.setComplexDataCommand) },
			{ ALT: () => this.SUBRULE(this.getCommand) },
			{ ALT: () => this.SUBRULE(this.connectCommand) },
			{ ALT: () => this.SUBRULE(this.disconnectCommand) },
			{ ALT: () => this.SUBRULE(this.createParameterCommand) },
			{ ALT: () => this.SUBRULE(this.screenshotCommand) },
			{ ALT: () => this.SUBRULE(this.traceCommand) },
			{ ALT: () => this.SUBRULE(this.showCommand) },
			{ ALT: () => this.SUBRULE(this.cdCommand) },
			{ ALT: () => this.SUBRULE(this.lsCommand) },
			{ ALT: () => this.SUBRULE(this.pwdCommand) },
			{ ALT: () => this.SUBRULE(this.resetCommand) },
			{ ALT: () => this.SUBRULE(this.saveCommand) },
		]);
		// Suppress "unused token" complaints for tokens kept solely for the
		// shared lexer (inherited from the BUILDER/UI section).
		void 0;
	});
}

const parser = new DspParser();

// ── CST extractors ────────────────────────────────────────────────

function extractPathSegmentImage(node: CstNode): string {
	const c = node.children;
	if (c.Identifier) return (c.Identifier[0] as IToken).image;
	if (c.Add) return (c.Add[0] as IToken).image;
	if (c.Type) return (c.Type[0] as IToken).image;
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

function extractSetComplexDataCommand(node: CstNode): { command: SetComplexDataCommand } | { error: string } {
	const clauses: SetComplexDataClause[] = [];
	for (const clauseNode of (node.children.setComplexDataClause ?? []) as CstNode[]) {
		const c = clauseNode.children;
		const path = extractPathExpr(c.path![0] as CstNode);
		if ("error" in path) return { error: path.error };
		const count = pathRefSegmentCount(path.ref);
		if (count !== 2 && count !== 3) {
			return { error: "set_complex_data: path must be <node>.<dataType>[.<slot>]" };
		}
		const keyword = (c.indexKeyword![0] as IToken).image;
		if (keyword.toLowerCase() !== "index") {
			return { error: `set_complex_data: expected index, got "${keyword}"` };
		}
		const value = parseNumberLiteral((c.indexValue![0] as IToken).image);
		if (!value.ok || value.value.kind !== "number" || !Number.isInteger(value.value.n)) {
			return { error: "set_complex_data: index must be an integer" };
		}
		clauses.push({ path: path.ref, dataIndex: value.value.n });
	}
	return { command: { type: "setComplexData", clauses } };
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

function extractTraceTokenImages(node: CstNode): string[] {
	const out: string[] = [];
	for (const child of (node.children.traceToken ?? []) as CstNode[]) {
		const c = child.children;
		for (const key of ["QuotedString", "HexLiteral", "PercentLiteral", "NumberLiteral", "BooleanLiteral", "Add", "Remove", "Rename", "Show", "Set", "Get", "Connect", "Disconnect", "CreateParameter", "Screenshot", "Trace", "Cd", "Ls", "Pwd", "Reset", "Save", "To", "As", "Tree", "Types", "Scale", "File", "Networks", "Modules", "Connections", "Identifier", "Type", "DoubleDot", "Dot"] as const) {
			const tokens = c[key] as IToken[] | undefined;
			if (tokens?.[0]) out.push(tokens[0].image);
		}
	}
	return out;
}

const TRACE_CLAUSE_START = new globalThis.Set(["inject", "probe", "delay", "compact", "no_specs", "no_signal"]);
const TRACE_SIGNALS = new globalThis.Set(["silence", "dirac", "noise", "dc"]);

function isTraceClauseStart(image: string | undefined): boolean {
	return image !== undefined && TRACE_CLAUSE_START.has(image.toLowerCase());
}

function parseTraceNumber(image: string | undefined, label: string): { value: number } | { error: string } {
	if (!image) return { error: `trace: ${label} requires a number` };
	const r = parseNumberLiteral(image);
	if (!r.ok || r.value.kind !== "number") return { error: `trace: invalid ${label}` };
	return { value: r.value.n };
}

function parseTraceValue(image: string | undefined): { value: Value } | { error: string } {
	if (!image) return { error: "trace: parameter injection requires a value" };
	if (image.startsWith("\"")) {
		const r = parseQuotedString(image);
		if (!r.ok) return { error: r.error };
		return { value: r.value };
	}
	if (/^(true|false)$/i.test(image)) {
		const r = parseBooleanLiteral(image);
		if (!r.ok) return { error: r.error };
		return { value: r.value };
	}
	if (image.endsWith("%")) {
		const r = parsePercentLiteral(image);
		if (!r.ok) return { error: r.error };
		return { value: r.value };
	}
	if (image.startsWith("0x")) {
		const r = parseHexLiteral(image);
		if (!r.ok) return { error: r.error };
		return { value: r.value };
	}
	const n = parseNumberLiteral(image);
	if (n.ok) return { value: n.value };
	const p = buildPathFromSegments([image]);
	if (!p.ok) return { error: p.error };
	return { value: { kind: "path", ref: p.ref } };
}

function readTracePath(tokens: string[], start: number): { ref: PathRef; next: number } | { error: string } {
	if (tokens[start] === "..") return { ref: { kind: "parent" }, next: start + 1 };
	const segments: string[] = [];
	let i = start;
	if (!tokens[i] || tokens[i] === ".") return { error: "trace: expected path" };
	segments.push(tokens[i]!);
	i++;
	while (tokens[i] === ".") {
		const next = tokens[i + 1];
		if (!next || next === ".") return { error: "trace: invalid dotted path" };
		segments.push(next);
		i += 2;
	}
	const r = buildPathFromSegments(segments);
	if (!r.ok) return { error: r.error };
	return { ref: r.ref, next: i };
}

function parseTraceQuotedId(image: string | undefined, clause: string): { id: string } | { error: string } {
	if (!image?.startsWith("\"")) return { error: `trace: ${clause} requires a quoted node id` };
	const r = parseQuotedString(image);
	if (!r.ok || r.value.kind !== "string") return { error: `trace: invalid quoted node id for ${clause}` };
	return { id: r.value.s };
}

function extractTraceCommand(node: CstNode): { command: TraceCommand } | { error: string } {
	const tokens = extractTraceTokenImages(node);
	const cmd: TraceCommand = {
		type: "trace",
		recursive: false,
		changedParameters: false,
		compact: false,
		noSpecs: false,
		noSignal: false,
		injectParams: [],
		probeParams: [],
	};
	let i = 0;
	if (tokens[i] && !isTraceClauseStart(tokens[i])) {
		const container = readTracePath(tokens, i);
		if ("error" in container) return container;
		cmd.container = container.ref;
		i = container.next;
	}
	while (i < tokens.length) {
		const clause = tokens[i]?.toLowerCase();
		if (clause === "delay") {
			const delay = parseTraceNumber(tokens[i + 1], "delay");
			if ("error" in delay) return delay;
			cmd.delayMs = delay.value;
			i += 2;
			continue;
		}
		if (clause === "compact") { cmd.compact = true; i++; continue; }
		if (clause === "no_specs") { cmd.noSpecs = true; i++; continue; }
		if (clause === "no_signal") { cmd.noSignal = true; i++; continue; }
		if (clause === "inject") {
			const kind = tokens[i + 1]?.toLowerCase();
			if (kind === "param") {
				const path = readTracePath(tokens, i + 2);
				if ("error" in path) return path;
				if (pathRefSegmentCount(path.ref) < 2) return { error: "trace: inject param path must be dotted" };
				const value = parseTraceValue(tokens[path.next]);
				if ("error" in value) return value;
				cmd.injectParams.push({ path: path.ref, value: value.value });
				i = path.next + 1;
				continue;
			}
			if (!kind || !TRACE_SIGNALS.has(kind)) return { error: "trace: inject requires silence, dirac, noise, dc, or param" };
			cmd.signalType = kind as TraceCommand["signalType"];
			i += 2;
			while (i < tokens.length && !isTraceClauseStart(tokens[i])) {
				const option = tokens[i]?.toLowerCase();
				if (option === "gain") {
					const gain = parseTraceNumber(tokens[i + 1], "gain");
					if ("error" in gain) return gain;
					cmd.gain = gain.value;
					i += 2;
					continue;
				}
				if (option === "seed") {
					const seed = parseTraceNumber(tokens[i + 1], "seed");
					if ("error" in seed) return seed;
					cmd.seed = seed.value;
					i += 2;
					continue;
				}
				if (option === "before") {
					const id = parseTraceQuotedId(tokens[i + 1], "before");
					if ("error" in id) return id;
					cmd.injectBefore = id.id;
					i += 2;
					continue;
				}
				return { error: `trace: unexpected inject option "${tokens[i]}"` };
			}
			continue;
		}
		if (clause === "probe") {
			const kind = tokens[i + 1]?.toLowerCase();
			if (kind === "recursive") { cmd.recursive = true; i += 2; continue; }
			if (kind === "changed_parameters") { cmd.changedParameters = true; i += 2; continue; }
			if (kind === "after") {
				const id = parseTraceQuotedId(tokens[i + 2], "after");
				if ("error" in id) return id;
				cmd.probeAfter = id.id;
				i += 3;
				continue;
			}
			if (kind === "param") {
				const path = readTracePath(tokens, i + 2);
				if ("error" in path) return path;
				if (pathRefSegmentCount(path.ref) < 2) return { error: "trace: probe param path must be dotted" };
				cmd.probeParams.push(path.ref);
				i = path.next;
				continue;
			}
			return { error: "trace: probe requires recursive, changed_parameters, after, or param" };
		}
		return { error: `trace: unexpected clause "${tokens[i]}"` };
	}
	if (cmd.changedParameters && cmd.probeParams.length > 0) {
		return { error: "trace: probe changed_parameters and probe param are mutually exclusive" };
	}
	return { command: cmd };
}

function extractShowCommand(node: CstNode): { command: ShowCommand } | { error: string } {
	const c = node.children;
	const kind = c.noun_networks
		? "networks" as const
		: c.noun_modules
			? "modules" as const
			: c.noun_connections
				? "connections" as const
				: c.noun_tree
					? "tree" as const
					: null;
	if (kind !== null) {
		let filter: string | undefined;
		if (c.filterQuoted) {
			const r = parseQuotedString((c.filterQuoted[0] as IToken).image);
			if (!r.ok || r.value.kind !== "string") return { error: "show: invalid filter" };
			filter = r.value.s;
		} else if (c.filterBare) {
			filter = (c.filterBare[0] as IToken).image;
		}
		return { command: { type: "show", kind, filter } };
	}
	const target = extractPathExpr(c.target![0] as CstNode);
	if ("error" in target) return { error: target.error };
	if (target.ref.kind === "bare" && !target.ref.segment.quoted && target.ref.segment.id.toLowerCase() === "status") {
		return { command: { type: "show", kind: "status" } };
	}
	return { command: { type: "show", kind: "target", target: target.ref } };
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
	if (c.setComplexDataCommand) return extractSetComplexDataCommand(c.setComplexDataCommand[0] as CstNode);
	if (c.getCommand) return extractGetCommand(c.getCommand[0] as CstNode);
	if (c.connectCommand) return extractConnectCommand(c.connectCommand[0] as CstNode);
	if (c.disconnectCommand) return extractDisconnectCommand(c.disconnectCommand[0] as CstNode);
	if (c.createParameterCommand) return extractCreateParameterCommand(c.createParameterCommand[0] as CstNode);
	if (c.screenshotCommand) return extractScreenshotCommand(c.screenshotCommand[0] as CstNode);
	if (c.traceCommand) return extractTraceCommand(c.traceCommand[0] as CstNode);
	if (c.showCommand) return extractShowCommand(c.showCommand[0] as CstNode);
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
	const status = input.trim().match(/^show\s+status(?:\s+(autofix))?$/i);
	if (status) return { commands: [{ type: "show", kind: "status", autofix: Boolean(status[1]) }] };
	const result = parseSingleDspCommand(input);
	if ("error" in result) return result;
	const cmd = result.command;
	if (cmd.type === "set") {
		return { commands: cmd.clauses.map((cl): DspCommand => ({ type: "set", clauses: [cl] })) };
	}
	if (cmd.type === "setComplexData") {
		return { commands: cmd.clauses.map((cl): DspCommand => ({ type: "setComplexData", clauses: [cl] })) };
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

// ── Shared Chevrotain token types ───────────────────────────────────

// Reused by builder, DSP, and sampler mode grammars. Each grammar
// extends this base set with mode-specific keywords.

import { createToken, Lexer } from "chevrotain";

// ── Whitespace (skipped) ────────────────────────────────────────────
export const WhiteSpace = createToken({
	name: "WhiteSpace",
	pattern: /\s+/,
	group: Lexer.SKIPPED,
});

// ── Literals ────────────────────────────────────────────────────────
export const QuotedString = createToken({
	name: "QuotedString",
	pattern: /"(?:[^"\\]|\\.)*"/,
});

// Strict 8-digit AARRGGBB. Shorter (`0xFFAA00`) or longer hex strings
// fail to lex; the value-parser enforces the 8-digit invariant for
// colour fields. Pattern accepts only exactly 8 hex digits so the
// token boundary is unambiguous.
export const HexLiteral = createToken({
	name: "HexLiteral",
	pattern: /0x[0-9a-fA-F]{8}/,
});

// Percent literal — consumed before NumberLiteral so the trailing `%`
// is captured. value-parser normalizes to `n / 100`.
export const PercentLiteral = createToken({
	name: "PercentLiteral",
	pattern: /[+-]?(\d+\.\d*|\.\d+|\d+)%/,
});

export const NumberLiteral = createToken({
	name: "NumberLiteral",
	pattern: /-?\d+(\.\d+)?/,
});

// ── Identifiers ─────────────────────────────────────────────────────
export const DotPath = createToken({
	name: "DotPath",
	pattern: /[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)+ /,
	longer_alt: undefined, // resolved below
});

export const Identifier = createToken({
	name: "Identifier",
	pattern: /[a-zA-Z_][a-zA-Z0-9_]*/,
});

// DotPath must be tried before Identifier (longer match wins)
// but since DotPath has a trailing space requirement we handle
// this differently in the builder grammar.

// ── Builder keywords ────────────────────────────────────────────────
export const Add = createToken({
	name: "Add",
	pattern: /add/i,
	longer_alt: Identifier,
});

export const Clone = createToken({
	name: "Clone",
	pattern: /clone/i,
	longer_alt: Identifier,
});

export const Remove = createToken({
	name: "Remove",
	pattern: /remove/i,
	longer_alt: Identifier,
});

export const Rename = createToken({
	name: "Rename",
	pattern: /rename/i,
	longer_alt: Identifier,
});

export const Show = createToken({
	name: "Show",
	pattern: /show/i,
	longer_alt: Identifier,
});

export const Set = createToken({
	name: "Set",
	pattern: /set/i,
	longer_alt: Identifier,
});

export const Get = createToken({
	name: "Get",
	pattern: /get/i,
	longer_alt: Identifier,
});

export const To = createToken({
	name: "To",
	pattern: /to/i,
	longer_alt: Identifier,
});

export const As = createToken({
	name: "As",
	pattern: /as/i,
	longer_alt: Identifier,
});

export const Tree = createToken({
	name: "Tree",
	pattern: /tree/i,
	longer_alt: Identifier,
});

export const Types = createToken({
	name: "Types",
	pattern: /types/i,
	longer_alt: Identifier,
});

// Navigation verbs (builder, UI, DSP all gain cd/ls/pwd).
export const Cd = createToken({
	name: "Cd",
	pattern: /cd/i,
	longer_alt: Identifier,
});

export const Ls = createToken({
	name: "Ls",
	pattern: /ls/i,
	longer_alt: Identifier,
});

export const Pwd = createToken({
	name: "Pwd",
	pattern: /pwd/i,
	longer_alt: Identifier,
});

export const Reset = createToken({
	name: "Reset",
	pattern: /reset/i,
	longer_alt: Identifier,
});

// `..` parent path expression. Distinct token so the parser can match
// the full PathExpr alternative without parsing two adjacent dots.
export const DoubleDot = createToken({
	name: "DoubleDot",
	pattern: /\.\./,
});

// Booleans alias 1/0; receiving field's type spec decides whether
// the value lands as bool, int, or float.
export const BooleanLiteral = createToken({
	name: "BooleanLiteral",
	pattern: /(true|false)/i,
	longer_alt: Identifier,
});

// `screenshot scale 50% file "patch.png"` clauses (DSP).
export const Scale = createToken({
	name: "Scale",
	pattern: /scale/i,
	longer_alt: Identifier,
});

export const File = createToken({
	name: "File",
	pattern: /file/i,
	longer_alt: Identifier,
});

// ── UI keywords ────────────────────────────────────────────────────
export const At = createToken({
	name: "At",
	pattern: /at/i,
	longer_alt: Identifier,
});

// ── Punctuation ─────────────────────────────────────────────────────
export const Dot = createToken({
	name: "Dot",
	pattern: /\./,
});

export const Comma = createToken({
	name: "Comma",
	pattern: /,/,
});

// Array literals `[a, b, c, d]`. Whitelisted arities enforced in the
// value-parser, not the lexer.
export const LBracket = createToken({
	name: "LBracket",
	pattern: /\[/,
});

export const RBracket = createToken({
	name: "RBracket",
	pattern: /\]/,
});

// Line comment — `#` and `//` accepted, end-of-line terminated. Skipped
// at lex time so parser rules never see the tokens.
export const Comment = createToken({
	name: "Comment",
	pattern: /(#|\/\/)[^\n]*/,
	group: Lexer.SKIPPED,
});

// ── Token order for the builder lexer ───────────────────────────────
// Keywords must come before Identifier so they match first.
// PercentLiteral must precede NumberLiteral so the trailing `%` is captured.
// HexLiteral must precede NumberLiteral so `0x...` doesn't lex as `0`.
// BooleanLiteral must precede Identifier so `true`/`false` lex as bool.
// DoubleDot must precede Dot so `..` doesn't lex as two dots.

export const BUILDER_TOKENS = [
	WhiteSpace,
	Comment,
	QuotedString,
	HexLiteral,
	PercentLiteral,
	NumberLiteral,
	Add,
	Clone,
	Remove,
	Rename,
	Show,
	Set,
	Get,
	Cd,
	Ls,
	Pwd,
	Reset,
	To,
	As,
	Tree,
	Types,
	BooleanLiteral,
	Comma,
	DoubleDot,
	Dot,
	LBracket,
	RBracket,
	Identifier,
];

// ── Verb keywords (chainable verbs) ────────────────────────────────
const _Set = globalThis.Set;
export const VERB_KEYWORDS: ReadonlySet<string> = new _Set([
	"set", "get", "add", "remove",
]);

export const builderLexer = new Lexer(BUILDER_TOKENS);

// ── UI mode token order ─────────────────────────────────────────────
// Same shape as BUILDER_TOKENS minus builder-specific tokens.

export const UI_TOKENS = [
	WhiteSpace,
	Comment,
	QuotedString,
	HexLiteral,
	PercentLiteral,
	NumberLiteral,
	Add,
	Remove,
	Rename,
	Show,
	Set,
	Get,
	Cd,
	Ls,
	Pwd,
	Reset,
	To,
	As,
	Tree,
	Types,
	BooleanLiteral,
	Comma,
	DoubleDot,
	Dot,
	LBracket,
	RBracket,
	Identifier,
];

export const UI_VERB_KEYWORDS: ReadonlySet<string> = new _Set([
	"set", "get", "add", "remove",
]);

export const uiLexer = new Lexer(UI_TOKENS);

// ── DSP keywords ────────────────────────────────────────────────────

export const Save = createToken({
	name: "Save",
	pattern: /save/i,
	longer_alt: Identifier,
});

export const Connections = createToken({
	name: "Connections",
	pattern: /connections/i,
	longer_alt: Identifier,
});

export const Connect = createToken({
	name: "Connect",
	pattern: /connect/i,
	longer_alt: Identifier,
});

export const Disconnect = createToken({
	name: "Disconnect",
	pattern: /disconnect/i,
	longer_alt: Identifier,
});

export const CreateParameter = createToken({
	name: "CreateParameter",
	pattern: /create_parameter/i,
	longer_alt: Identifier,
});

export const Networks = createToken({
	name: "Networks",
	pattern: /networks/i,
	longer_alt: Identifier,
});

export const Modules = createToken({
	name: "Modules",
	pattern: /modules/i,
	longer_alt: Identifier,
});

export const Screenshot = createToken({
	name: "Screenshot",
	pattern: /screenshot/i,
	longer_alt: Identifier,
});

// DSP token order — keywords before Identifier. CreateParameter must
// come before Connect to avoid prefix conflicts: lexer tries tokens
// in array order, so the longer multi-char keyword wins on inputs
// like `create_parameter`.
export const DSP_TOKENS = [
	WhiteSpace,
	Comment,
	QuotedString,
	HexLiteral,
	PercentLiteral,
	NumberLiteral,
	CreateParameter,
	Disconnect,
	Connections,
	Connect,
	Networks,
	Modules,
	Screenshot,
	Add,
	Remove,
	Rename,
	Show,
	Set,
	Get,
	Cd,
	Ls,
	Pwd,
	Reset,
	Save,
	To,
	As,
	Tree,
	Types,
	Scale,
	File,
	BooleanLiteral,
	Comma,
	DoubleDot,
	Dot,
	LBracket,
	RBracket,
	Identifier,
];

export const DSP_VERB_KEYWORDS: ReadonlySet<string> = new _Set([
	"set", "get", "add", "remove", "connect", "disconnect",
]);

export const dspLexer = new Lexer(DSP_TOKENS);

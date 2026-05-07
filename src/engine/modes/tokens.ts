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

// Multiplier token: x4, x10, etc. Must come before Identifier.
export const XCount = createToken({
	name: "XCount",
	pattern: /x\d+/i,
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

export const Move = createToken({
	name: "Move",
	pattern: /move/i,
	longer_alt: Identifier,
});

export const Rename = createToken({
	name: "Rename",
	pattern: /rename/i,
	longer_alt: Identifier,
});

export const Load = createToken({
	name: "Load",
	pattern: /load/i,
	longer_alt: Identifier,
});

export const Into = createToken({
	name: "Into",
	pattern: /into/i,
	longer_alt: Identifier,
});

export const Bypass = createToken({
	name: "Bypass",
	pattern: /bypass/i,
	longer_alt: Identifier,
});

export const Enable = createToken({
	name: "Enable",
	pattern: /enable/i,
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

export const List = createToken({
	name: "List",
	pattern: /list/i,
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
// XCount must come before Identifier (x4 should not lex as Identifier).

export const BUILDER_TOKENS = [
	WhiteSpace,
	QuotedString,
	NumberLiteral,
	XCount,
	Add,
	Clone,
	Remove,
	Move,
	Rename,
	Load,
	Into,
	Bypass,
	Enable,
	Show,
	Set,
	Get,
	To,
	As,
	Tree,
	Types,
	Comma,
	Dot,
	Identifier,
];

// ── Verb keywords (for comma pre-processor) ────────────────────────
const _Set = globalThis.Set;
export const VERB_KEYWORDS: ReadonlySet<string> = new _Set([
	"add", "clone", "remove", "move", "rename",
	"load", "set", "get", "show", "bypass", "enable",
]);

export const builderLexer = new Lexer(BUILDER_TOKENS);

// ── UI mode token order ─────────────────────────────────────────────
// Shares most tokens with builder but adds At, drops builder-only tokens.

export const UI_TOKENS = [
	WhiteSpace,
	QuotedString,
	NumberLiteral,
	Add,
	Remove,
	Move,
	Rename,
	Into,
	Show,
	Set,
	Get,
	To,
	As,
	At,
	Tree,
	Comma,
	Dot,
	Identifier,
];

export const UI_VERB_KEYWORDS: ReadonlySet<string> = new _Set([
	"add", "remove", "move", "rename", "set", "get", "show",
]);

export const uiLexer = new Lexer(UI_TOKENS);

// ── DSP keywords ────────────────────────────────────────────────────

export const From = createToken({
	name: "From",
	pattern: /from/i,
	longer_alt: Identifier,
});

export const Of = createToken({
	name: "Of",
	pattern: /of/i,
	longer_alt: Identifier,
});

export const Use = createToken({
	name: "Use",
	pattern: /use/i,
	longer_alt: Identifier,
});

export const Init = createToken({
	name: "Init",
	pattern: /init/i,
	longer_alt: Identifier,
});

export const Create = createToken({
	name: "Create",
	pattern: /create/i,
	longer_alt: Identifier,
});

export const Save = createToken({
	name: "Save",
	pattern: /save/i,
	longer_alt: Identifier,
});

export const Reset = createToken({
	name: "Reset",
	pattern: /reset/i,
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

export const Source = createToken({
	name: "Source",
	pattern: /source/i,
	longer_alt: Identifier,
});

export const Parent = createToken({
	name: "Parent",
	pattern: /parent/i,
	longer_alt: Identifier,
});

export const Default = createToken({
	name: "Default",
	pattern: /default/i,
	longer_alt: Identifier,
});

export const Step = createToken({
	name: "Step",
	// Broadened to accept range-write field aliases. `stepSize` and
	// `interval` lex as the same token as `step`. Longer alternatives
	// listed first so they win the regex match.
	pattern: /(stepSize|interval|step)/i,
	longer_alt: Identifier,
});

export const Mid = createToken({
	name: "Mid",
	pattern: /(middlePosition|mid)/i,
	longer_alt: Identifier,
});

export const Skew = createToken({
	name: "Skew",
	pattern: /(skewFactor|skew)/i,
	longer_alt: Identifier,
});

export const Min = createToken({
	name: "Min",
	pattern: /min/i,
	longer_alt: Identifier,
});

export const Max = createToken({
	name: "Max",
	pattern: /max/i,
	longer_alt: Identifier,
});

export const Range = createToken({
	name: "Range",
	pattern: /range/i,
	longer_alt: Identifier,
});

export const Matched = createToken({
	name: "Matched",
	pattern: /(matched|normalize)/i,
	longer_alt: Identifier,
});

// DSP token order — keywords before Identifier. CreateParameter must
// come before Create/Connect to avoid prefix conflicts: lexer tries
// tokens in array order, so the longer multi-char keyword wins on
// inputs like `create_parameter`.
export const DSP_TOKENS = [
	WhiteSpace,
	QuotedString,
	HexLiteral,
	NumberLiteral,
	CreateParameter,
	Disconnect,
	Connections,
	Connect,
	Networks,
	Modules,
	Add,
	Remove,
	Move,
	Bypass,
	Enable,
	Show,
	Set,
	Get,
	Use,
	Init,
	Load,
	Create,
	Save,
	Reset,
	Source,
	Parent,
	Default,
	Range,
	Matched,
	Mid,
	Skew,
	Step,
	Min,
	Max,
	From,
	Of,
	Into,
	To,
	As,
	At,
	Tree,
	Comma,
	Dot,
	Identifier,
];

export const DSP_VERB_KEYWORDS: ReadonlySet<string> = new _Set([
	"add", "remove", "move", "set", "get",
	"bypass", "enable", "connect", "disconnect",
]);

export const dspLexer = new Lexer(DSP_TOKENS);

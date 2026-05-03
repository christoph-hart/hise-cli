// ── Token types and color mapping for syntax highlighting ───────────

// Hardcoded syntax-highlighting colors matching the HISE C++ editor.
// Mode token types use MODE_ACCENTS from mode.ts as their colors.

import { MODE_ACCENTS } from "./constants.js";

export type TokenType =
	// Language tokens
	| "keyword"
	| "identifier"
	| "scopedStatement"
	| "integer"
	| "float"
	| "string"
	| "comment"
	| "operator"
	| "bracket"
	| "punctuation"
	| "plain"
	// Slash command tokens
	| "command"      // generic slash commands (/help, /exit, etc.)
	// Mode-colored tokens (slash commands that enter modes)
	| "builder"
	| "script"
	| "dsp"
	| "sampler"
	| "inspect"
	| "project"
	| "export"
	| "compile"
	| "undo"
	| "ui"
	| "sequence"
	| "hise"
	| "analyse";

export const TOKEN_COLORS: Record<TokenType, string> = {
	// Language tokens
	keyword: "#bbbbff",
	identifier: "#DDDDFF",
	scopedStatement: "#88bec5",
	integer: "#DDAADD",
	float: "#EEAA00",
	string: "#DDAAAA",
	// Bumped from #666666 → on 256-color terminals chalk maps both #272822
	// (code-block bg) and #666666 to the cube cell (95,95,95). #909090 has
	// R==G==B so chalk picks the grayscale ramp (idx 245 ≈ rgb 138), well
	// above the cube cell. Truecolor still reads as muted vs identifier text.
	comment: "#909090",
	operator: "#CCCCCC",
	bracket: "#FFFFFF",
	punctuation: "#CCCCCC",
	plain: "#DDDDFF",
	// Slash command tokens
	command: "#FFFFFF",
	// Mode-colored tokens — accent colors from MODE_ACCENTS
	builder: MODE_ACCENTS.builder,
	script: MODE_ACCENTS.script,
	dsp: MODE_ACCENTS.dsp,
	sampler: MODE_ACCENTS.sampler,
	inspect: MODE_ACCENTS.inspect,
	project: MODE_ACCENTS.project,
	export: MODE_ACCENTS.compile,
	compile: MODE_ACCENTS.compile,
	undo: MODE_ACCENTS.undo,
	ui: MODE_ACCENTS.ui,
	sequence: MODE_ACCENTS.sequence,
	hise: MODE_ACCENTS.hise,
	analyse: MODE_ACCENTS.analyse,
} as const;

export interface TokenSpan {
	text: string;
	token: TokenType;
	/** Optional direct color override (hex string). When present, takes
	 *  precedence over TOKEN_COLORS mapping. Used for theme-aware colors
	 *  like table cell separators. */
	color?: string;
	/** When true, render this span in bold. */
	bold?: boolean;
}

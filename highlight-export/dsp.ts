// ── DSP mode tokenizer ──────────────────────────────────────────────

import type { TokenSpan, TokenType } from "./tokens.js";
import { tokenizeSlash } from "./slash.js";

const DSP_KEYWORDS = new Set([
	"show", "networks", "modules", "connections", "tree",
	"use", "init", "load", "create", "save", "reset",
	"add", "remove", "move", "connect", "disconnect",
	"set", "set_complex_data", "get", "bypass", "enable",
	"create_parameter",
	"source", "parent", "of", "from", "to", "as", "at",
	"default", "step", "into",
	"cd", "ls", "dir", "pwd", "help",
]);

const ARG_RULES: Array<{ pattern: RegExp; token: TokenType }> = [
	{ pattern: /^"(?:[^"\\]|\\.)*"/, token: "string" },
	{ pattern: /^'(?:[^'\\]|\\.)*'/, token: "string" },
	{ pattern: /^\d+\.\d+(?:[eE][+-]?\d+)?/, token: "float" },
	{ pattern: /^0x[0-9a-fA-F]+/, token: "integer" },
	{ pattern: /^-?\d+/, token: "integer" },
	{ pattern: /^,/, token: "punctuation" },
	{ pattern: /^\./, token: "punctuation" },
	{ pattern: /^[a-zA-Z_$][a-zA-Z0-9_$]*/, token: "identifier" },
	{ pattern: /^\s+/, token: "plain" },
];

export function tokenizeDsp(source: string): TokenSpan[] {
	if (source.startsWith("/")) return tokenizeSlash(source);

	const spans: TokenSpan[] = [];
	let pos = 0;
	while (pos < source.length) {
		let matched = false;
		for (const rule of ARG_RULES) {
			const match = source.slice(pos).match(rule.pattern);
			if (match) {
				let token = rule.token;
				const text = match[0];
				if (token === "identifier" && DSP_KEYWORDS.has(text.toLowerCase())) {
					token = "keyword";
				}
				spans.push({ text, token });
				pos += text.length;
				matched = true;
				break;
			}
		}
		if (!matched) {
			spans.push({ text: source[pos]!, token: "plain" });
			pos++;
		}
	}
	return mergeAdjacentSpans(spans);
}

function mergeAdjacentSpans(spans: TokenSpan[]): TokenSpan[] {
	if (spans.length === 0) return [];
	const merged: TokenSpan[] = [{ ...spans[0]! }];
	for (let i = 1; i < spans.length; i++) {
		const prev = merged[merged.length - 1]!;
		const curr = spans[i]!;
		if (prev.token === curr.token) prev.text += curr.text;
		else merged.push({ ...curr });
	}
	return merged;
}

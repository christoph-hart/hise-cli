// ── Builder mode tokenizer ───────────────────────────────────────────

// Lighter than HiseScript — keywords for builder grammar, module type
// names as scopedStatement, plus strings, numbers, identifiers.

import type { TokenSpan, TokenType } from "./tokens.js";
import { tokenizeSlash } from "./slash.js";

const BUILDER_KEYWORDS = new Set([
	"add", "clone", "remove", "rename", "set", "get", "show", "reset",
	"to", "as", "tree", "types",
	"cd", "ls", "pwd",
]);

const ARG_RULES: Array<{ pattern: RegExp; token: TokenType }> = [
	{ pattern: /^"(?:[^"\\]|\\.)*"/, token: "string" },
	{ pattern: /^'(?:[^'\\]|\\.)*'/, token: "string" },
	{ pattern: /^(?:true|false)\b/i, token: "boolean" },
	{ pattern: /^-?\d+(?:\.\d+)?%/, token: "percent" },
	{ pattern: /^-?\d+\.\d+(?:[eE][+-]?\d+)?/, token: "float" },
	{ pattern: /^0x[0-9a-fA-F]{8}\b/, token: "integer" },
	{ pattern: /^-?\d+/, token: "integer" },
	{ pattern: /^[\[\]]/, token: "bracket" },
	{ pattern: /^,/, token: "punctuation" },
	{ pattern: /^\./, token: "punctuation" },
	{ pattern: /^[a-zA-Z_$][a-zA-Z0-9_$]*/, token: "identifier" },
	{ pattern: /^\s+/, token: "plain" },
];

/**
 * Tokenize builder mode input.
 * "add SineGenerator as \"osc\" to Master.pitch" →
 *   [add=keyword, " "=plain, SineGenerator=identifier, ...]
 *
 * Delegates to tokenizeSlash for "/" prefixed input.
 */
export function tokenizeBuilder(source: string): TokenSpan[] {
	if (source.startsWith("/")) {
		return tokenizeSlash(source);
	}

	const spans: TokenSpan[] = [];
	let pos = 0;

	while (pos < source.length) {
		let matched = false;

		for (const rule of ARG_RULES) {
			const match = source.slice(pos).match(rule.pattern);
			if (match) {
				let token = rule.token;
				const text = match[0];

				// Classify identifiers as keywords or leave as identifier
				if (token === "identifier" && BUILDER_KEYWORDS.has(text.toLowerCase())) {
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

// Merge consecutive spans of the same token type
function mergeAdjacentSpans(spans: TokenSpan[]): TokenSpan[] {
	if (spans.length === 0) return [];

	const merged: TokenSpan[] = [{ ...spans[0] }];
	for (let i = 1; i < spans.length; i++) {
		const prev = merged[merged.length - 1]!;
		const curr = spans[i]!;
		if (prev.token === curr.token) {
			prev.text += curr.text;
		} else {
			merged.push({ ...curr });
		}
	}
	return merged;
}

// ── Shared value parser ──────────────────────────────────────────────
//
// Pure literal parsers consumed by every mode's CST extraction layer.
// Token images come in (already lexed); typed Values come out. Arity
// validation for arrays lives here so all three modes get the same
// error messages for invalid shapes.
//
// See docs/CLI_GRAMMAR.md §99-127 (numeric arrays / percent / boolean)
// and §375-385 (BNF Value production).

import type { PathRef } from "./path-parser.js";

export type Value =
	| { kind: "number"; n: number }
	| { kind: "string"; s: string }
	| { kind: "boolean"; b: boolean }
	| { kind: "hex"; n: number }
	| { kind: "array2"; n: [number, number] }
	| { kind: "array4"; n: [number, number, number, number] }
	| { kind: "arrayN"; n: number[] }
	| { kind: "path"; ref: PathRef };

export type ValueResult =
	| { ok: true; value: Value }
	| { ok: false; error: string };

export type ArrayArity = 2 | 4 | "N";

// ── Scalar literal parsers ──────────────────────────────────────────

export function parseNumberLiteral(image: string): ValueResult {
	const n = Number(image);
	if (Number.isNaN(n)) return { ok: false, error: `invalid number: "${image}"` };
	return { ok: true, value: { kind: "number", n } };
}

export function parsePercentLiteral(image: string): ValueResult {
	if (!image.endsWith("%")) {
		return { ok: false, error: `percent literal missing "%": "${image}"` };
	}
	const numPart = image.slice(0, -1);
	const n = Number(numPart);
	if (Number.isNaN(n)) return { ok: false, error: `invalid percent: "${image}"` };
	return { ok: true, value: { kind: "number", n: n / 100 } };
}

// Strict 8-digit AARRGGBB. Shorter forms (`0xFFAA00`) are rejected so
// LLMs cannot silently omit the alpha channel.
export function parseHexLiteral(image: string): ValueResult {
	const m = /^0x([0-9a-fA-F]+)$/.exec(image);
	if (!m) return { ok: false, error: `invalid hex literal: "${image}"` };
	const digits = m[1];
	if (digits.length !== 8) {
		return {
			ok: false,
			error: `hex literal must be exactly 8 digits (0xAARRGGBB); got ${digits.length} in "${image}". Include alpha — e.g. 0xFF${digits.padStart(6, "0").slice(-6)} for fully opaque.`,
		};
	}
	const n = parseInt(digits, 16);
	return { ok: true, value: { kind: "hex", n } };
}

export function parseBooleanLiteral(image: string): ValueResult {
	const lower = image.toLowerCase();
	if (lower === "true") return { ok: true, value: { kind: "boolean", b: true } };
	if (lower === "false") return { ok: true, value: { kind: "boolean", b: false } };
	return { ok: false, error: `invalid boolean: "${image}"` };
}

export function parseQuotedString(image: string): ValueResult {
	if (image.length < 2 || image[0] !== '"' || image[image.length - 1] !== '"') {
		return { ok: false, error: `not a quoted string: "${image}"` };
	}
	const inner = image.slice(1, -1);
	const unescaped = inner.replace(/\\(["\\nrt])/g, (_, ch: string) => {
		switch (ch) {
			case "n": return "\n";
			case "r": return "\r";
			case "t": return "\t";
			default: return ch;
		}
	});
	return { ok: true, value: { kind: "string", s: unescaped } };
}

// ── Array parsing ────────────────────────────────────────────────────

// Accepts already-parsed numeric elements and validates against the
// expected arity. Hex elements coerce to integer; non-numeric elements
// are an error since arrays in CLI_GRAMMAR are numeric-only.
export function parseNumericArray(elements: Value[], arity: ArrayArity): ValueResult {
	const numbers: number[] = [];
	for (let i = 0; i < elements.length; i++) {
		const el = elements[i];
		if (el.kind === "number") {
			numbers.push(el.n);
		} else if (el.kind === "hex") {
			numbers.push(el.n);
		} else {
			return {
				ok: false,
				error: `array element ${i} is not numeric (kind: ${el.kind})`,
			};
		}
	}

	if (arity === 2) {
		if (numbers.length !== 2) {
			return {
				ok: false,
				error: `expected 2-element array, got ${numbers.length}`,
			};
		}
		return { ok: true, value: { kind: "array2", n: [numbers[0], numbers[1]] } };
	}

	if (arity === 4) {
		if (numbers.length !== 4) {
			return {
				ok: false,
				error: `expected 4-element array, got ${numbers.length}`,
			};
		}
		return {
			ok: true,
			value: { kind: "array4", n: [numbers[0], numbers[1], numbers[2], numbers[3]] },
		};
	}

	// arity === "N" — used by routing fields. Length 1..NUM_MAX_CHANNELS;
	// the upper bound is enforced by the field-level validator (depends
	// on HISE channel count), not here.
	if (numbers.length === 0) {
		return { ok: false, error: "array must contain at least one element" };
	}
	return { ok: true, value: { kind: "arrayN", n: numbers } };
}

// ── Convenience: string-form value dispatcher ────────────────────────
//
// Tests and engine helpers occasionally have a raw user-input substring
// without going through Chevrotain. Inspect the first char to dispatch.
// Returns null when input doesn't match any literal form (caller handles
// path/identifier interpretation).

export function tryParseScalarFromImage(image: string): ValueResult | null {
	if (image.length === 0) return null;
	const trimmed = image.trim();
	if (trimmed.length === 0) return null;

	if (trimmed.startsWith('"')) return parseQuotedString(trimmed);
	if (/^0x/i.test(trimmed)) return parseHexLiteral(trimmed);
	if (/^[+-]?(\d+\.?\d*|\.\d+)%$/.test(trimmed)) return parsePercentLiteral(trimmed);
	if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
		return parseNumberLiteral(trimmed);
	}
	const lower = trimmed.toLowerCase();
	if (lower === "true" || lower === "false") return parseBooleanLiteral(trimmed);
	return null;
}

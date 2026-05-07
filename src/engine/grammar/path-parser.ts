// ── Shared path expression parser ────────────────────────────────────
//
// PathExpr per CLI_GRAMMAR §371-373:
//   PathExpr := DottedPath | BarePath | '..'
//   DottedPath := Identifier ('.' Identifier)+      ; ≥2 segments
//   BarePath   := Identifier
//
// Quoted segments inside a path bypass keyword recognition for that
// segment (§285). The `quoted` flag on each PathSegment is preserved
// so the resolver can decide.

import { parseQuotedString } from "./value-parser.js";

export interface PathSegment {
	id: string;
	quoted: boolean;
}

export type PathRef =
	| { kind: "bare"; segment: PathSegment }
	| { kind: "dotted"; segments: PathSegment[] }
	| { kind: "parent" };

export type PathResult =
	| { ok: true; ref: PathRef }
	| { ok: false; error: string };

// Parses a list of segment images (already split by Chevrotain on `.`).
// Each image is either a bare identifier (no quotes) or a quoted string
// (`"..."`). Empty list is an error.
export function buildPathFromSegments(images: string[]): PathResult {
	if (images.length === 0) return { ok: false, error: "empty path" };

	const segments: PathSegment[] = [];
	for (let i = 0; i < images.length; i++) {
		const img = images[i];
		if (img.length === 0) {
			return { ok: false, error: `empty path segment at index ${i}` };
		}
		if (img[0] === '"') {
			const r = parseQuotedString(img);
			if (!r.ok) return { ok: false, error: r.error };
			if (r.value.kind !== "string") {
				return { ok: false, error: "quoted segment did not parse as string" };
			}
			segments.push({ id: r.value.s, quoted: true });
		} else {
			segments.push({ id: img, quoted: false });
		}
	}

	if (segments.length === 1) {
		return { ok: true, ref: { kind: "bare", segment: segments[0] } };
	}
	return { ok: true, ref: { kind: "dotted", segments } };
}

export function parentRef(): PathRef {
	return { kind: "parent" };
}

// ── Convenience: parse a raw dotted path string ──────────────────────
//
// Tests and helpers occasionally have a complete `A.B.C` source string.
// Splits on unquoted dots, respects quoted segments. Engine code that
// works through Chevrotain CSTs should NOT use this — they have already
// tokenized segments.

export function parseDottedPathString(raw: string): PathResult {
	const trimmed = raw.trim();
	if (trimmed === "..") return { ok: true, ref: { kind: "parent" } };
	if (trimmed.length === 0) return { ok: false, error: "empty path" };

	const segments: string[] = [];
	let buf = "";
	let inQuotes = false;
	let escaped = false;

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (escaped) {
			buf += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && inQuotes) {
			buf += ch;
			escaped = true;
			continue;
		}
		if (ch === '"') {
			buf += ch;
			inQuotes = !inQuotes;
			continue;
		}
		if (ch === "." && !inQuotes) {
			if (buf.length === 0) {
				return { ok: false, error: `empty segment at position ${i} in "${raw}"` };
			}
			segments.push(buf);
			buf = "";
			continue;
		}
		buf += ch;
	}
	if (inQuotes) return { ok: false, error: `unterminated quoted segment in "${raw}"` };
	if (buf.length === 0) {
		return { ok: false, error: `trailing dot in "${raw}"` };
	}
	segments.push(buf);

	return buildPathFromSegments(segments);
}

// ── Helpers ──────────────────────────────────────────────────────────

export function pathRefToString(ref: PathRef): string {
	if (ref.kind === "parent") return "..";
	if (ref.kind === "bare") return formatSegment(ref.segment);
	return ref.segments.map(formatSegment).join(".");
}

function formatSegment(seg: PathSegment): string {
	return seg.quoted ? `"${seg.id}"` : seg.id;
}

export function pathRefSegments(ref: PathRef): PathSegment[] {
	if (ref.kind === "parent") return [];
	if (ref.kind === "bare") return [ref.segment];
	return ref.segments;
}

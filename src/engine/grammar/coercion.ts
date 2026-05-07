// ── Value coercion against field-type specs ──────────────────────────
//
// The CLI grammar accepts uniform Value forms; receiving fields decide
// how to interpret them. `set X.bypassed 1` writes a boolean; `set
// X.Volume 1` writes a float. Booleans alias 1/0 and percent
// pre-normalizes to a float, so most cases collapse to numeric coercion.

import type { Value } from "./value-parser.js";

export type CoerceResult<T> = { ok: true; out: T } | { ok: false; error: string };

export function coerceBoolean(value: Value): CoerceResult<boolean> {
	if (value.kind === "boolean") return { ok: true, out: value.b };
	if (value.kind === "number") {
		if (value.n === 1) return { ok: true, out: true };
		if (value.n === 0) return { ok: true, out: false };
		return { ok: false, error: `cannot coerce ${value.n} to boolean (expected 0 or 1)` };
	}
	return { ok: false, error: `cannot coerce ${value.kind} to boolean` };
}

export function coerceInt(value: Value): CoerceResult<number> {
	if (value.kind === "number") {
		if (!Number.isInteger(value.n)) {
			return { ok: false, error: `expected integer, got ${value.n}` };
		}
		return { ok: true, out: value.n };
	}
	if (value.kind === "hex") return { ok: true, out: value.n };
	if (value.kind === "boolean") return { ok: true, out: value.b ? 1 : 0 };
	return { ok: false, error: `cannot coerce ${value.kind} to integer` };
}

export function coerceFloat(value: Value): CoerceResult<number> {
	if (value.kind === "number") return { ok: true, out: value.n };
	if (value.kind === "hex") return { ok: true, out: value.n };
	if (value.kind === "boolean") return { ok: true, out: value.b ? 1 : 0 };
	return { ok: false, error: `cannot coerce ${value.kind} to number` };
}

export function coerceString(value: Value): CoerceResult<string> {
	if (value.kind === "string") return { ok: true, out: value.s };
	return { ok: false, error: `cannot coerce ${value.kind} to string` };
}

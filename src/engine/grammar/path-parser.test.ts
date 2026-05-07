import { describe, it, expect } from "vitest";
import {
	buildPathFromSegments,
	parseDottedPathString,
	pathRefToString,
	pathRefSegments,
} from "./path-parser.js";

describe("buildPathFromSegments", () => {
	it("returns bare for single segment", () => {
		const r = buildPathFromSegments(["Compressor"]);
		expect(r).toEqual({
			ok: true,
			ref: { kind: "bare", segment: { id: "Compressor", quoted: false } },
		});
	});

	it("returns dotted for multiple segments", () => {
		const r = buildPathFromSegments(["Master", "Lead", "Volume"]);
		expect(r.ok).toBe(true);
		if (r.ok && r.ref.kind === "dotted") {
			expect(r.ref.segments.map((s) => s.id)).toEqual(["Master", "Lead", "Volume"]);
		}
	});

	it("preserves quoted-segment marker", () => {
		const r = buildPathFromSegments(['"to"', "bypassed"]);
		expect(r.ok).toBe(true);
		if (r.ok && r.ref.kind === "dotted") {
			expect(r.ref.segments).toEqual([
				{ id: "to", quoted: true },
				{ id: "bypassed", quoted: false },
			]);
		}
	});

	it("errors on empty list", () => {
		expect(buildPathFromSegments([]).ok).toBe(false);
	});
});

describe("parseDottedPathString", () => {
	it("recognizes ..", () => {
		expect(parseDottedPathString("..")).toEqual({ ok: true, ref: { kind: "parent" } });
	});

	it("parses bare", () => {
		expect(parseDottedPathString("Master")).toEqual({
			ok: true,
			ref: { kind: "bare", segment: { id: "Master", quoted: false } },
		});
	});

	it("parses dotted", () => {
		const r = parseDottedPathString("Master.Lead.Volume");
		if (r.ok && r.ref.kind === "dotted") {
			expect(r.ref.segments.length).toBe(3);
			expect(r.ref.segments[0].id).toBe("Master");
		} else expect.fail();
	});

	it("respects quoted segments containing dots", () => {
		const r = parseDottedPathString('Master."My.Synth".Volume');
		expect(r.ok).toBe(true);
		if (r.ok && r.ref.kind === "dotted") {
			expect(r.ref.segments.map((s) => s.id)).toEqual(["Master", "My.Synth", "Volume"]);
			expect(r.ref.segments[1].quoted).toBe(true);
		}
	});

	it("errors on trailing dot", () => {
		expect(parseDottedPathString("Master.Lead.").ok).toBe(false);
	});

	it("errors on empty", () => {
		expect(parseDottedPathString("").ok).toBe(false);
	});

	it("errors on unterminated quote", () => {
		expect(parseDottedPathString('Master."Lead').ok).toBe(false);
	});

	it("errors on consecutive dots", () => {
		expect(parseDottedPathString("Master..Lead").ok).toBe(false);
	});
});

describe("pathRefToString / pathRefSegments", () => {
	it("round-trips bare", () => {
		const r = parseDottedPathString("Compressor");
		if (!r.ok) return expect.fail();
		expect(pathRefToString(r.ref)).toBe("Compressor");
		expect(pathRefSegments(r.ref).map((s) => s.id)).toEqual(["Compressor"]);
	});

	it("round-trips dotted", () => {
		const r = parseDottedPathString("Master.Lead.Volume");
		if (!r.ok) return expect.fail();
		expect(pathRefToString(r.ref)).toBe("Master.Lead.Volume");
	});

	it("preserves quoting in toString", () => {
		const r = parseDottedPathString('Master."to".bypassed');
		if (!r.ok) return expect.fail();
		expect(pathRefToString(r.ref)).toBe('Master."to".bypassed');
	});

	it("formats parent", () => {
		expect(pathRefToString({ kind: "parent" })).toBe("..");
		expect(pathRefSegments({ kind: "parent" })).toEqual([]);
	});
});

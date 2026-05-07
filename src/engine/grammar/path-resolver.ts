// ── Shared path resolver ─────────────────────────────────────────────
//
// Resolves PathRefs against a TreeNode according to CLI_GRAMMAR §42-58:
//
//   - `cd` mode: try cwd-relative first, then unique-project lookup.
//   - `lookup` mode: project-wide unique lookup only (every other verb).
//
// Identifier matching is case-insensitive (§24-30). When two entities
// differ only in case, the resolver returns an "ambiguous" error with
// both candidates listed.

import type { TreeNode } from "../result.js";
import type { PathRef, PathSegment } from "./path-parser.js";

export type ResolveMode = "cd" | "lookup";

export type ResolveResult =
	| { ok: true; node: TreeNode; fullPath: string[] }
	| { ok: false; error: "not_found" | "ambiguous"; message: string; candidates?: string[][] };

export function resolvePath(
	tree: TreeNode | null,
	cwd: string[],
	ref: PathRef,
	mode: ResolveMode,
): ResolveResult {
	if (!tree) return notFound(ref);

	if (ref.kind === "parent") {
		// `..` — only meaningful for navigation. Walk up one level from cwd.
		if (cwd.length === 0) {
			return {
				ok: false,
				error: "not_found",
				message: "already at root; cannot go up",
			};
		}
		const parentPath = cwd.slice(0, -1);
		const node = walkExact(tree, parentPath);
		if (!node) return notFound(ref);
		return { ok: true, node, fullPath: parentPath };
	}

	const segments = ref.kind === "bare" ? [ref.segment] : ref.segments;

	if (mode === "cd") {
		// Try cwd-relative: walk from cwd-resolved node down through segments.
		const cwdNode = walkExact(tree, cwd);
		if (cwdNode) {
			const rel = walkSegments(cwdNode, segments, [...cwd]);
			if (rel.ok) return rel;
			if (rel.error === "ambiguous") return rel;
			// fall through to project-wide
		}
	}

	// Project-wide unique lookup.
	const matches = findAllByPath(tree, segments);
	if (matches.length === 0) return notFound(ref);
	if (matches.length > 1) {
		return {
			ok: false,
			error: "ambiguous",
			message: `ambiguous path; ${matches.length} matches`,
			candidates: matches.map((m) => m.fullPath),
		};
	}
	return { ok: true, node: matches[0].node, fullPath: matches[0].fullPath };
}

// ── Internal walkers ─────────────────────────────────────────────────

function walkExact(tree: TreeNode | null, path: string[]): TreeNode | null {
	if (!tree) return null;
	if (path.length === 0) return tree;
	let current: TreeNode = tree;
	let start = 0;
	// If path[0] names the root itself, consume it so subsequent segments
	// match children. Lets callers pass full paths like ["Master", "Lead"]
	// regardless of whether they include the root.
	if ((tree.id ?? "").toLowerCase() === path[0].toLowerCase()) start = 1;
	for (let i = start; i < path.length; i++) {
		const child = caseInsensitiveChild(current, path[i]);
		if (!child) return null;
		current = child;
	}
	return current;
}

// Walk a list of segments from a starting node. Tracks ambiguous case
// folds (two children that differ only in case match the same lowered
// segment id).
function walkSegments(
	from: TreeNode,
	segments: PathSegment[],
	prefix: string[],
): ResolveResult {
	let current: TreeNode = from;
	const collected: string[] = [...prefix];
	for (const seg of segments) {
		const matches = caseInsensitiveChildMatches(current, seg.id);
		if (matches.length === 0) {
			return notFoundString(segments.map((s) => s.id).join("."));
		}
		if (matches.length > 1) {
			return {
				ok: false,
				error: "ambiguous",
				message: `case-fold ambiguity on segment "${seg.id}"`,
				candidates: matches.map((m) => [...collected, m.id ?? seg.id]),
			};
		}
		current = matches[0];
		collected.push(current.id ?? seg.id);
	}
	return { ok: true, node: current, fullPath: collected };
}

function caseInsensitiveChild(node: TreeNode, segId: string): TreeNode | null {
	if (!node.children) return null;
	const lower = segId.toLowerCase();
	for (const child of node.children) {
		if ((child.id ?? "").toLowerCase() === lower) return child;
	}
	return null;
}

function caseInsensitiveChildMatches(node: TreeNode, segId: string): TreeNode[] {
	if (!node.children) return [];
	const lower = segId.toLowerCase();
	return node.children.filter((c) => (c.id ?? "").toLowerCase() === lower);
}

// Project-wide: walk the entire tree, collecting nodes whose subtree
// position matches the segment chain. The first segment may match any
// node anywhere; subsequent segments are children-of-prior.
function findAllByPath(
	tree: TreeNode,
	segments: PathSegment[],
): { node: TreeNode; fullPath: string[] }[] {
	if (segments.length === 0) return [];

	const matches: { node: TreeNode; fullPath: string[] }[] = [];
	const firstId = segments[0].id.toLowerCase();

	const visit = (node: TreeNode, ancestry: string[]): void => {
		const here = node.id ?? "";
		if (here.toLowerCase() === firstId) {
			// Walk the remaining segments from this node.
			const rest = segments.slice(1);
			let cur: TreeNode = node;
			let fullPath = [...ancestry, here];
			let ok = true;
			for (const seg of rest) {
				const ms = caseInsensitiveChildMatches(cur, seg.id);
				if (ms.length === 0) { ok = false; break; }
				if (ms.length > 1) {
					// Record each ambiguous branch as a separate candidate.
					for (const m of ms) {
						matches.push({
							node: m,
							fullPath: [...fullPath, m.id ?? seg.id],
						});
					}
					ok = false;
					break;
				}
				cur = ms[0];
				fullPath = [...fullPath, cur.id ?? seg.id];
			}
			if (ok) matches.push({ node: cur, fullPath });
		}
		if (node.children) {
			const nextAncestry = [...ancestry, here];
			for (const child of node.children) visit(child, nextAncestry);
		}
	};

	// The root itself participates in matching (e.g. `Master`).
	visit(tree, []);
	return matches;
}

function notFound(ref: PathRef): ResolveResult {
	const label = ref.kind === "parent"
		? ".."
		: ref.kind === "bare"
			? ref.segment.id
			: ref.segments.map((s) => s.id).join(".");
	return notFoundString(label);
}

function notFoundString(label: string): ResolveResult {
	return { ok: false, error: "not_found", message: `path not found: ${label}` };
}

import type { TreeNode } from "../result.js";

export interface DuplicateCandidate {
	id: string;
	path: string;
}

export function duplicateIdCandidates(tree: TreeNode | null, id: string): string[] {
	if (!tree) return [];
	const lower = id.toLowerCase();
	return collectTreeIds(tree).filter((entry) => entry.id.toLowerCase() === lower).map((entry) => entry.path);
}

export function duplicateAliasesInRequest(aliases: string[]): string | null {
	const seen = new Set<string>();
	for (const alias of aliases) {
		const lower = alias.toLowerCase();
		if (seen.has(lower)) return alias;
		seen.add(lower);
	}
	return null;
}

function collectTreeIds(root: TreeNode): DuplicateCandidate[] {
	const out: DuplicateCandidate[] = [];
	const visit = (node: TreeNode, path: string[]): void => {
		const id = node.id ?? node.label;
		const nextPath = [...path, id];
		out.push({ id, path: nextPath.join(".") });
		for (const child of node.children ?? []) visit(child, nextPath);
	};
	visit(root, []);
	return out;
}

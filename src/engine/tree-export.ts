import type { TreeNode } from "./result.js";

export interface CleanTreeNode {
	id: string;
	type?: string;
	nodeKind?: "module" | "chain";
	chainConstrainer?: string;
	children?: CleanTreeNode[];
}

export function cleanTreeNode(n: TreeNode): CleanTreeNode {
	const out: CleanTreeNode = { id: n.id ?? n.label };
	if (n.type) out.type = n.type;
	if (n.nodeKind) out.nodeKind = n.nodeKind;
	if (n.chainConstrainer) out.chainConstrainer = n.chainConstrainer;
	if (n.children && n.children.length > 0) {
		out.children = n.children.map(cleanTreeNode);
	}
	return out;
}

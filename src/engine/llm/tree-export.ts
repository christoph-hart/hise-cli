import type { TreeNode } from "../result.js";
import type { ModuleList } from "../data.js";
import type { ComponentPropertyMap } from "../modes/ui-parser.js";

export interface CleanTreeNode {
	id: string;
	type?: string;
	nodeKind?: "module" | "chain";
	chainConstrainer?: string;
	/** Available parameter / property names for this node's type. Populated when
	 *  the corresponding dataset is provided. Builder uses moduleList; UI uses
	 *  componentProperties. Absent for chain nodes. */
	params?: string[];
	children?: CleanTreeNode[];
}

export interface TreeExportOptions {
	moduleList?: ModuleList;
	componentProperties?: ComponentPropertyMap;
}

/** Display labels HISE returns for builder chain nodes mapped to the canonical
 *  chain keys the parser accepts. Live trees expose labels like "FX Chain",
 *  "Pitch Modulation"; the parser only tokenises single-word chain keys.
 *  Without this normalisation, the LLM copies the label and produces
 *  `add Foo to Synth.FX Chain` which fails to parse. */
const CHAIN_LABEL_TO_KEY: Record<string, string> = {
	"FX Chain": "fx",
	"MIDI Processor": "midi",
	"MIDI": "midi",
	"Gain Modulation": "gain",
	"Pitch Modulation": "pitch",
	"Children": "children",
};

function canonicalChainKey(label: string): string {
	if (CHAIN_LABEL_TO_KEY[label]) return CHAIN_LABEL_TO_KEY[label];
	// Custom/wavesynth chains (e.g. "Osc2 Pitch Modulation"). Strip spaces,
	// lowercase — matches the alias path resolveChainIndex already accepts.
	return label.toLowerCase().replace(/\s+/g, "");
}

/** Strip presentation-only fields from an internal TreeNode for LLM consumption.
 *  Drops: colour, filledDot, dimmed, diff, topMargin, badge.
 *  Keeps: id, label (as id fallback), type, nodeKind, chainConstrainer, children.
 *  Canonicalises chain-node ids so the model emits parser-friendly chain keys.
 *  When `options.moduleList` is provided, each module node also carries its
 *  available `params` list — eliminates a class of model errors where the LLM
 *  invents parameter names. */
export function treeNodeToLlmJson(n: TreeNode | null, options: TreeExportOptions = {}): CleanTreeNode | null {
	if (!n) return null;
	const paramsByType = buildParamIndex(options);
	return cleanNode(n, paramsByType);
}

function buildParamIndex(options: TreeExportOptions): Map<string, string[]> | null {
	const idx = new Map<string, string[]>();
	if (options.moduleList) {
		for (const m of options.moduleList.modules) {
			const params = m.parameters?.map((p) => p.id).filter(Boolean) ?? [];
			if (params.length > 0) idx.set(m.id, params);
		}
	}
	if (options.componentProperties) {
		for (const [componentType, propsMap] of Object.entries(options.componentProperties)) {
			const props = Object.keys(propsMap);
			if (props.length > 0) idx.set(componentType, props);
		}
	}
	return idx.size > 0 ? idx : null;
}

function cleanNode(n: TreeNode, paramsByType: Map<string, string[]> | null): CleanTreeNode {
	const isChain = n.nodeKind === "chain";
	const rawId = n.id ?? n.label;
	const out: CleanTreeNode = { id: isChain ? canonicalChainKey(rawId) : rawId };
	if (n.type) out.type = n.type;
	if (n.nodeKind) out.nodeKind = n.nodeKind;
	if (n.chainConstrainer) out.chainConstrainer = n.chainConstrainer;
	if (!isChain && paramsByType && n.type) {
		const params = paramsByType.get(n.type);
		if (params && params.length > 0) out.params = params;
	}
	if (n.children && n.children.length > 0) {
		out.children = n.children.map((c) => cleanNode(c, paramsByType));
	}
	return out;
}

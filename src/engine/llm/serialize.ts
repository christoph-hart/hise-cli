import type { LlmMode } from "./types.js";

export interface StructuredCommand {
	kind: string;
	[key: string]: unknown;
}

export interface StructuredResponse {
	commands: StructuredCommand[];
}

/** Convert a structured JSON response from the LLM back into a CLI command
 *  string for the given mode. Mirrors the parser's expected input shape. */
export function serializeStructuredResponse(mode: LlmMode, response: StructuredResponse): string {
	if (!response.commands || response.commands.length === 0) {
		throw new Error("structured response has no commands");
	}
	const parts = response.commands.map((c) => serializeOne(mode, c));
	return parts.join(", ");
}

function serializeOne(mode: LlmMode, c: StructuredCommand): string {
	// JSON-mode fallback shape: when Ollama's schema enforcement is partial
	// or the model bypassed the discriminator, accept a `command` string.
	const fallbackCmd = (c as unknown as { command?: unknown }).command;
	if (typeof fallbackCmd === "string" && !c.kind) {
		return fallbackCmd.trim();
	}
	if (mode === "builder") return serializeBuilder(c);
	if (mode === "ui") return serializeUi(c);
	throw new Error(`structured serializer not implemented for mode "${mode}"`);
}

function serializeBuilder(c: StructuredCommand): string {
	switch (c.kind) {
		case "add": {
			const moduleType = requireString(c, "moduleType");
			const alias = optionalString(c, "alias");
			const parent = optionalString(c, "parent");
			const chain = optionalString(c, "chain");
			let s = `add ${moduleType}`;
			if (alias) s += ` as "${alias}"`;
			if (parent) {
				s += parentNeedsQuotes(parent) ? ` to "${parent}"` : ` to ${parent}`;
				if (chain) s += `.${chain}`;
			}
			return s;
		}
		case "remove":
		case "bypass":
		case "enable": {
			const target = requireString(c, "target");
			return `${c.kind} ${target}`;
		}
		case "clone": {
			const target = requireString(c, "target");
			const count = c.count;
			const suffix = typeof count === "number" && count > 1 ? ` x${count}` : "";
			return `clone ${target}${suffix}`;
		}
		case "rename": {
			const target = requireString(c, "target");
			const name = requireString(c, "name");
			return `rename ${target} to "${name}"`;
		}
		case "set": {
			const target = requireString(c, "target");
			const param = requireString(c, "param");
			const value = c.value;
			const valueStr = formatValue(value);
			return `set ${target}.${param} to ${valueStr}`;
		}
		case "load": {
			const source = requireString(c, "source");
			const target = requireString(c, "target");
			return `load "${source}" into ${target}`;
		}
		case "show": {
			const what = requireString(c, "what");
			if (what === "tree") return "show tree";
			if (what === "types") {
				const filter = optionalString(c, "filter");
				return filter ? `show types ${filter}` : "show types";
			}
			if (what === "target") {
				const target = requireString(c, "target");
				return `show ${target}`;
			}
			throw new Error(`unknown show.what: ${what}`);
		}
		case "cd": {
			const path = requireString(c, "path");
			return `cd ${path}`;
		}
		case "pwd":
		case "ls":
		case "reset":
			return c.kind;
		default:
			throw new Error(`unknown builder command kind: ${c.kind}`);
	}
}

function serializeUi(c: StructuredCommand): string {
	switch (c.kind) {
		case "add": {
			const componentType = requireString(c, "componentType");
			const name = optionalString(c, "name");
			const x = c.x;
			const y = c.y;
			const w = c.width;
			const h = c.height;
			let s = `add ${componentType}`;
			if (name) s += ` "${name}"`;
			if (typeof x === "number" && typeof y === "number" && typeof w === "number" && typeof h === "number") {
				s += ` at ${x} ${y} ${w} ${h}`;
			}
			return s;
		}
		case "remove": {
			const target = requireString(c, "target");
			return `remove ${target}`;
		}
		case "set": {
			const target = requireString(c, "target");
			const prop = requireString(c, "prop");
			const value = c.value;
			return `set ${target}.${prop} to ${formatValue(value)}`;
		}
		case "move": {
			const target = requireString(c, "target");
			const parent = requireString(c, "parent");
			const index = c.index;
			let s = `move ${target} to ${parent}`;
			if (typeof index === "number") s += ` at ${index}`;
			return s;
		}
		case "rename": {
			const target = requireString(c, "target");
			const newName = requireString(c, "newName");
			return `rename ${target} to "${newName}"`;
		}
		case "show": {
			const what = requireString(c, "what");
			if (what === "tree") return "show tree";
			if (what === "target") {
				const target = requireString(c, "target");
				return `show ${target}`;
			}
			throw new Error(`unknown ui show.what: ${what}`);
		}
		default:
			throw new Error(`unknown ui command kind: ${c.kind}`);
	}
}

function requireString(c: StructuredCommand, field: string): string {
	const v = c[field];
	if (typeof v !== "string" || v.length === 0) {
		throw new Error(`missing required string field "${field}" on ${c.kind} command`);
	}
	return v;
}

function optionalString(c: StructuredCommand, field: string): string | undefined {
	const v = c[field];
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "string") return undefined;
	if (v.length === 0) return undefined;
	return v;
}

function parentNeedsQuotes(parent: string): boolean {
	// Multi-word IDs like "Master Chain" need to be enclosed because the parser
	// treats space as a separator unless the value is quoted.
	return /\s/.test(parent);
}

function formatValue(v: unknown): string {
	if (typeof v === "number") return String(v);
	if (typeof v === "boolean") return String(v);
	if (typeof v === "string") {
		// Numeric strings pass through unquoted; everything else gets quotes.
		if (/^-?\d+(\.\d+)?$/.test(v)) return v;
		return `"${v}"`;
	}
	throw new Error(`cannot serialise value: ${JSON.stringify(v)}`);
}

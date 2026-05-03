// ── API mode — HiseScript API doc browser ───────────────────────────

import type { ApiClass, ApiMethod, ApiParameter, ScriptingApi } from "../data.js";
import type { CommandResult } from "../result.js";
import { errorResult, markdownResult } from "../result.js";
import type { CompletionItem, CompletionResult, Mode, SessionContext } from "./mode.js";
import { MODE_ACCENTS } from "./mode.js";

interface ApiQuery {
	className: string;
	methodName?: string;
}

function parseApiQuery(input: string): ApiQuery | null {
	const trimmed = input.trim().replace(/\(\)$/, "");
	if (!trimmed) return null;
	const dot = trimmed.indexOf(".");
	if (dot < 0) return { className: trimmed };
	return {
		className: trimmed.slice(0, dot),
		methodName: trimmed.slice(dot + 1),
	};
}

function findClass(api: ScriptingApi, name: string): { key: string; cls: ApiClass } | null {
	const direct = api.classes[name];
	if (direct) return { key: name, cls: direct };
	const lower = name.toLowerCase();
	for (const key of Object.keys(api.classes)) {
		if (key.toLowerCase() === lower) return { key, cls: api.classes[key] };
	}
	return null;
}

function findMethod(cls: ApiClass, name: string): ApiMethod | null {
	const direct = cls.methods.find((m) => m.name === name);
	if (direct) return direct;
	const lower = name.toLowerCase();
	return cls.methods.find((m) => m.name.toLowerCase() === lower) ?? null;
}

function suggestClass(api: ScriptingApi, name: string): string | null {
	const lower = name.toLowerCase();
	for (const key of Object.keys(api.classes)) {
		if (key.toLowerCase().startsWith(lower)) return key;
	}
	for (const key of Object.keys(api.classes)) {
		if (key.toLowerCase().includes(lower)) return key;
	}
	return null;
}

function formatSignature(className: string, method: ApiMethod): string {
	const params = (method.parameters ?? [])
		.map((p) => `${p.name}: ${p.type}`)
		.join(", ");
	return `${className}.${method.name}(${params}) → ${method.returnType}`;
}

function formatParamSummary(method: ApiMethod): string {
	const params = method.parameters ?? [];
	if (params.length === 0) return "()";
	return `(${params.map((p) => p.name).join(", ")})`;
}

function renderIndex(api: ScriptingApi): string {
	const groups: Record<string, string[]> = {};
	for (const [name, cls] of Object.entries(api.classes)) {
		const cat = cls.category ?? "object";
		(groups[cat] ??= []).push(name);
	}
	const order = ["namespace", "object", "scriptnode", "component"];
	const lines: string[] = ["# HiseScript API", "", "Usage: `Console` for class docs, `Console.print()` for method docs.", ""];
	for (const cat of order) {
		const names = groups[cat];
		if (!names || names.length === 0) continue;
		lines.push(`## ${cat}`);
		lines.push("");
		for (const name of names.sort()) {
			lines.push(`- \`${name}\``);
		}
		lines.push("");
	}
	return lines.join("\n");
}

function renderClass(name: string, cls: ApiClass, forLlm: boolean): string {
	const lines: string[] = [`# ${name}`, ""];
	if (forLlm && cls.llmRef) {
		lines.push("```");
		lines.push(cls.llmRef);
		lines.push("```");
		lines.push("");
	} else if (cls.description) {
		lines.push(`> ${cls.description}`);
		lines.push("");
	}
	if (cls.obtainedVia) {
		lines.push(`*Obtained via:* ${cls.obtainedVia}`);
		lines.push("");
	}
	if (forLlm && cls.commonMistakes && cls.commonMistakes.length > 0) {
		lines.push("## Common mistakes");
		lines.push("");
		for (const m of cls.commonMistakes) {
			lines.push(`- ❌ \`${m.wrong}\``);
			lines.push(`  ✅ \`${m.right}\``);
			lines.push(`  ${m.explanation}`);
		}
		lines.push("");
	}
	if (cls.methods.length > 0) {
		lines.push("## Methods");
		lines.push("");
		for (const method of cls.methods) {
			const sig = formatParamSummary(method);
			const summary = oneLine(method.description);
			lines.push(`- \`${method.name}${sig}\` → ${method.returnType}${summary ? ` — ${summary}` : ""}`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function oneLine(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= 120) return collapsed;
	return `${collapsed.slice(0, 117)}...`;
}

function renderMethod(className: string, method: ApiMethod, forLlm: boolean): string {
	const lines: string[] = [`# ${className}.${method.name}`, ""];
	lines.push("```");
	lines.push(formatSignature(className, method));
	lines.push("```");
	lines.push("");
	if (method.callScope) {
		lines.push(`*${method.callScope}*`);
		lines.push("");
	}
	if (forLlm && method.llmRef) {
		lines.push("```");
		lines.push(method.llmRef);
		lines.push("```");
		lines.push("");
	} else if (method.description) {
		lines.push(method.description);
		lines.push("");
	}
	const params = method.parameters ?? [];
	if (params.length > 0) {
		lines.push("## Parameters");
		lines.push("");
		for (const p of params) {
			lines.push(formatParameter(p));
		}
		lines.push("");
	}
	const examples = method.examples ?? [];
	if (examples.length > 0) {
		lines.push("## Examples");
		lines.push("");
		for (const ex of examples) {
			if (ex.title) {
				lines.push(`### ${ex.title}`);
				lines.push("");
			}
			lines.push("```hisescript");
			lines.push(ex.code);
			lines.push("```");
			lines.push("");
		}
	}
	if (method.pitfalls && method.pitfalls.length > 0) {
		lines.push("## Pitfalls");
		lines.push("");
		for (const p of method.pitfalls) lines.push(`- ${p}`);
		lines.push("");
	}
	if (method.crossReferences && method.crossReferences.length > 0) {
		lines.push("## See also");
		lines.push("");
		for (const ref of method.crossReferences) lines.push(`- \`${ref}\``);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function formatParameter(p: ApiParameter): string {
	const head = `- **${p.name}** (\`${p.type}\`)`;
	if (p.description) return `${head} — ${p.description}`;
	return head;
}

export interface ApiModeOptions {
	/** When true (CLI/LLM route), render `llmRef` instead of `description`
	 *  and surface `commonMistakes`. TUI keeps the terse human view. */
	forLlm?: boolean;
}

export class ApiMode implements Mode {
	readonly id: Mode["id"] = "api";
	readonly name = "API";
	readonly accent = MODE_ACCENTS.api;
	readonly prompt = "[api] > ";
	private readonly api: ScriptingApi | null;
	private readonly forLlm: boolean;

	constructor(api?: ScriptingApi, options: ApiModeOptions = {}) {
		this.api = api ?? null;
		this.forLlm = options.forLlm ?? false;
	}

	async parse(input: string, _session: SessionContext): Promise<CommandResult> {
		if (!this.api) {
			return errorResult("API data unavailable. scripting_api.json failed to load.");
		}
		const trimmed = input.trim();
		if (!trimmed || trimmed === "help") {
			return markdownResult(renderIndex(this.api));
		}
		const query = parseApiQuery(trimmed);
		if (!query) return markdownResult(renderIndex(this.api));

		const found = findClass(this.api, query.className);
		if (!found) {
			const hint = suggestClass(this.api, query.className);
			const detail = hint ? `Did you mean \`${hint}\`?` : undefined;
			return errorResult(`Unknown class: "${query.className}"`, detail);
		}

		if (!query.methodName) {
			return markdownResult(renderClass(found.key, found.cls, this.forLlm));
		}

		const method = findMethod(found.cls, query.methodName);
		if (!method) {
			const available = found.cls.methods.map((m) => m.name).sort().join(", ");
			return errorResult(
				`Unknown method: "${found.key}.${query.methodName}"`,
				available ? `Available: ${available}` : undefined,
			);
		}
		return markdownResult(renderMethod(found.key, method, this.forLlm));
	}

	complete(input: string, _cursor: number): CompletionResult {
		if (!this.api) return { items: [], from: 0, to: input.length };
		const trimmed = input.trimStart();
		const leading = input.length - trimmed.length;
		const dot = trimmed.indexOf(".");
		if (dot < 0) {
			const prefix = trimmed.toLowerCase();
			const items: CompletionItem[] = Object.entries(this.api.classes)
				.filter(([name]) => !prefix || name.toLowerCase().startsWith(prefix))
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, cls]) => ({
					label: name,
					detail: cls.category,
					insertText: name,
				}));
			return { items, from: leading, to: input.length, label: "API classes" };
		}
		const className = trimmed.slice(0, dot);
		const methodPrefix = trimmed.slice(dot + 1).replace(/\(\)$/, "").toLowerCase();
		const found = findClass(this.api, className);
		if (!found) return { items: [], from: leading, to: input.length };
		const items: CompletionItem[] = found.cls.methods
			.filter((m) => !methodPrefix || m.name.toLowerCase().startsWith(methodPrefix))
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((m) => ({
				label: `${m.name}${formatParamSummary(m)}`,
				detail: m.returnType,
				insertText: `${found.key}.${m.name}()`,
			}));
		return { items, from: leading, to: input.length, label: `${found.key} methods` };
	}
}

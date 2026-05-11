import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";

const sourceDir = "docs/agent-context";
const sourceNames = readdirSync(sourceDir)
	.filter((name) => name.endsWith(".yaml"))
	.sort();
const sources = sourceNames
	.filter((name) => !name.startsWith("_"))
	.sort()
	.map((name) => join(sourceDir, name).replace(/\\/g, "/"));
const commonSource = sourceNames.includes("_common.yaml") ? join(sourceDir, "_common.yaml").replace(/\\/g, "/") : null;
const outFile = "src/cli/generated-agent-context.ts";

function quoteArg(arg) {
	if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg) || /^<[^>]+>$/.test(arg)) return arg;
	return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function display(argv) {
	return argv.map((arg) => quoteArg(String(arg))).join(" ");
}

function assertArray(value, name) {
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
}

function assertString(value, name) {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
}

function normalizeCommand(command, path) {
	if (!command || typeof command !== "object") throw new Error(`${path}.command must be an object`);
	assertArray(command.argv, `${path}.command.argv`);
	const argv = command.argv.map((arg) => String(arg));
	return { argv, display: display(argv) };
}

function normalizeRecipe(recipe, path) {
	assertString(recipe.title, `${path}.title`);
	assertArray(recipe.argv, `${path}.argv`);
	const argv = recipe.argv.map((arg) => String(arg));
	const normalized = { title: recipe.title, argv, display: display(argv) };
	if (typeof recipe.stdin === "string") normalized.stdin = recipe.stdin;
	return normalized;
}

function normalizeCapability(capability, sourceFile, index) {
	const path = `${sourceFile}.capabilities[${index}]`;
	assertString(capability.id, `${path}.id`);
	assertString(capability.title, `${path}.title`);
	assertString(capability.purpose, `${path}.purpose`);
	assertArray(capability.tags, `${path}.tags`);
	assertArray(capability.aliases, `${path}.aliases`);
	const normalized = {
		id: capability.id,
		title: capability.title,
		purpose: capability.purpose,
		command: normalizeCommand(capability.command, path),
		tags: capability.tags.map((tag) => String(tag)),
		aliases: capability.aliases.map((alias) => String(alias)),
		help: {
			visibility: capability.help?.visibility ?? "common",
			order: Number(capability.help?.order ?? index),
		},
	};
	if (capability.examples) {
		assertArray(capability.examples, `${path}.examples`);
		normalized.examples = capability.examples.map((example, exampleIndex) => normalizeRecipe(example, `${path}.examples[${exampleIndex}]`));
	}
	if (capability.notes) {
		assertArray(capability.notes, `${path}.notes`);
		normalized.notes = capability.notes.map((note) => String(note));
	}
	return normalized;
}

function normalizeStringArray(value, path) {
	if (value === undefined) return [];
	assertArray(value, path);
	return value.map((item) => String(item));
}

function normalizeHelp(help, index) {
	return {
		visibility: help?.visibility ?? "common",
		order: Number(help?.order ?? index),
	};
}

function normalizeCommandEntry(command, sourceFile, index) {
	const path = `${sourceFile}.commands[${index}]`;
	assertString(command.id, `${path}.id`);
	assertString(command.title, `${path}.title`);
	assertString(command.purpose, `${path}.purpose`);
	assertString(command.syntax, `${path}.syntax`);
	const normalized = {
		id: command.id,
		title: command.title,
		purpose: command.purpose,
		syntax: command.syntax,
		command: normalizeCommand(command.command, path),
		tags: normalizeStringArray(command.tags, `${path}.tags`),
		aliases: normalizeStringArray(command.aliases, `${path}.aliases`),
		contexts: normalizeStringArray(command.contexts, `${path}.contexts`),
		agentRelevance: command.agentRelevance ? String(command.agentRelevance) : "medium",
		danger: Boolean(command.danger),
		help: normalizeHelp(command.help, index),
	};
	if (command.examples) {
		assertArray(command.examples, `${path}.examples`);
		normalized.examples = command.examples.map((example, exampleIndex) => normalizeRecipe(example, `${path}.examples[${exampleIndex}]`));
	}
	if (command.notes) normalized.notes = normalizeStringArray(command.notes, `${path}.notes`);
	return normalized;
}

function normalizeQuickStart(value, sourceFile) {
	if (!value) return [];
	assertArray(value, `${sourceFile}.quickStart`);
	return value.map((recipe, index) => normalizeRecipe(recipe, `${sourceFile}.quickStart[${index}]`));
}

function normalizeConcepts(value, sourceFile) {
	if (!value) return [];
	assertArray(value, `${sourceFile}.concepts`);
	return value.map((concept, index) => {
		const path = `${sourceFile}.concepts[${index}]`;
		assertString(concept.id, `${path}.id`);
		assertString(concept.title, `${path}.title`);
		return {
			id: concept.id,
			title: concept.title,
			body: normalizeStringArray(concept.body, `${path}.body`),
		};
	});
}

function capabilityToCommand(capability, sourceFile, index) {
	const normalized = normalizeCapability(capability, sourceFile, index);
	return {
		...normalized,
		syntax: normalized.command.display,
		contexts: ["cli"],
		agentRelevance: "high",
		danger: false,
	};
}

function normalizeMode(doc, sourceFile) {
	if (!doc || typeof doc !== "object") throw new Error(`${sourceFile} must contain an object`);
	if (doc.schemaVersion !== 1 && doc.schemaVersion !== 2) throw new Error(`${sourceFile}.schemaVersion must be 1 or 2`);
	const mode = doc.mode;
	if (!mode || typeof mode !== "object") throw new Error(`${sourceFile}.mode must be an object`);
	assertString(mode.id, `${sourceFile}.mode.id`);
	assertString(mode.title, `${sourceFile}.mode.title`);
	assertString(mode.summary, `${sourceFile}.mode.summary`);
	if (doc.schemaVersion === 1) assertArray(doc.capabilities, `${sourceFile}.capabilities`);
	if (doc.schemaVersion === 2) assertArray(doc.commands, `${sourceFile}.commands`);
	return {
		id: mode.id,
		title: mode.title,
		summary: mode.summary,
		invocation: (mode.invocation ?? []).map((recipe, index) => normalizeRecipe({ title: `Invocation ${index + 1}`, ...recipe }, `${sourceFile}.mode.invocation[${index}]`)),
		notes: (mode.notes ?? []).map((note) => String(note)),
		antiPatterns: (mode.antiPatterns ?? []).map((item) => ({ avoid: String(item.avoid), prefer: String(item.prefer) })),
		quickStart: normalizeQuickStart(doc.quickStart, sourceFile),
		concepts: normalizeConcepts(doc.concepts, sourceFile),
		commands: doc.schemaVersion === 1
			? doc.capabilities.map((capability, index) => capabilityToCommand(capability, sourceFile, index))
			: doc.commands.map((command, index) => normalizeCommandEntry(command, sourceFile, index)),
		types: doc.types && typeof doc.types === "object" ? doc.types : {},
	};
}

function normalizeCommon(sourceFile) {
	if (!sourceFile) return { syntax: [], grammar: {}, inputPatterns: [], output: [] };
	const doc = YAML.parse(readFileSync(sourceFile, "utf8"));
	if (!doc || typeof doc !== "object") throw new Error(`${sourceFile} must contain an object`);
	if (doc.schemaVersion !== 2) throw new Error(`${sourceFile}.schemaVersion must be 2`);
	if (!doc.common || typeof doc.common !== "object") throw new Error(`${sourceFile}.common must be an object`);
	return doc.common;
}

const modes = sources.map((sourceFile) => normalizeMode(YAML.parse(readFileSync(sourceFile, "utf8")), sourceFile));
const ids = new Set();
for (const mode of modes) {
	for (const command of mode.commands) {
		if (ids.has(command.id)) throw new Error(`Duplicate command id: ${command.id}`);
		ids.add(command.id);
	}
}

const common = normalizeCommon(commonSource);

const generated = `// Generated by scripts/generate-agent-context.mjs. Do not edit manually.\n\n`
	+ `import type { AgentContextData } from "./agentContextTypes.js";\n\n`
	+ `export const GENERATED_AGENT_CONTEXT = ${JSON.stringify({ schemaVersion: 2, common, modes }, null, "\t")} as const satisfies AgentContextData;\n`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, generated, "utf8");

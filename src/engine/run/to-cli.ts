import { parseBuilderInput, type BuilderCommand } from "../modes/builder-parser.js";
import { parseUiInput, type UiCommand } from "../modes/ui-parser.js";
import { parseDspInput, type DspCommand } from "../modes/dsp-parser.js";
import { pathRefSegments, type PathRef, type PathSegment } from "../grammar/path-parser.js";
import type { Value } from "../grammar/value-parser.js";

export interface HscToCliDiagnostic {
	line: number;
	content: string;
	reason: string;
}

export interface HscToCliResult {
	lines: string[];
	diagnostics: HscToCliDiagnostic[];
}

type Mode = "root" | "builder" | "ui" | "dsp" | "unsupported";

interface TranslationContext {
	mode: Mode;
	builderParent: string | null;
	uiParent: string | null;
	dspHost: string | null;
	dspParent: string | null;
	awaitingDspHost: boolean;
}

const ROOT_PARENT = new Set(["/", "root", "Master", "Interface"]);

export function translateHscToCli(source: string): HscToCliResult {
	const rawLines = source.split(/\r?\n/);
	const lines: string[] = [];
	const diagnostics: HscToCliDiagnostic[] = [];
	const ctx: TranslationContext = {
		mode: "root",
		builderParent: null,
		uiParent: null,
		dspHost: null,
		dspParent: null,
		awaitingDspHost: false,
	};

	for (let i = 0; i < rawLines.length; i++) {
		const raw = rawLines[i]!;
		const lineNumber = i + 1;
		const trimmed = raw.trim();
		if (lineNumber === 1 && trimmed === "#!/usr/bin/env hise-cli run") {
			lines.push("#!/usr/bin/env bash");
			continue;
		}
		if (trimmed === "") {
			lines.push("");
			continue;
		}
		if (trimmed.startsWith("#")) {
			lines.push(raw);
			continue;
		}
		if (trimmed.startsWith("//")) {
			lines.push(`#${raw.slice(raw.indexOf("//") + 2)}`);
			continue;
		}

		const content = stripInlineComment(trimmed);
		if (content === "") {
			lines.push("");
			continue;
		}

		if (content.startsWith("/")) {
			lines.push(handleSlashLine(content, ctx, lineNumber, diagnostics));
			continue;
		}

		const translated = translateCommandLine(content, ctx, lineNumber, diagnostics);
		lines.push(...translated);
	}

	return { lines, diagnostics };
}

function handleSlashLine(
	content: string,
	ctx: TranslationContext,
	line: number,
	diagnostics: HscToCliDiagnostic[],
): string {
	if (content === "/builder") {
		ctx.mode = "builder";
		ctx.builderParent = null;
		return contextComment(content);
	}
	if (content === "/ui" || content.startsWith("/ui ")) {
		ctx.mode = "ui";
		ctx.uiParent = null;
		return contextComment(content);
	}
	if (content === "/dsp") {
		ctx.mode = "dsp";
		ctx.dspHost = null;
		ctx.dspParent = null;
		ctx.awaitingDspHost = true;
		return contextComment(content);
	}
	if (content === "/exit") {
		ctx.mode = "root";
		ctx.awaitingDspHost = false;
		ctx.dspHost = null;
		ctx.dspParent = null;
		return contextComment(content);
	}
	diagnostics.push({ line, content, reason: "unsupported slash command" });
	ctx.mode = "unsupported";
	return hscOnlyComment(content);
}

function translateCommandLine(
	content: string,
	ctx: TranslationContext,
	line: number,
	diagnostics: HscToCliDiagnostic[],
): string[] {
	if (ctx.mode === "root") {
		diagnostics.push({ line, content, reason: "command outside a supported mode" });
		return [hscOnlyComment(content)];
	}
	if (ctx.mode === "unsupported") {
		diagnostics.push({ line, content, reason: "command inside unsupported mode" });
		return [hscOnlyComment(content)];
	}

	if (ctx.mode === "builder") {
		const result = parseBuilderInput(content);
		if ("error" in result) return parseError(content, line, result.error, diagnostics);
		const out: string[] = [];
		for (const command of result.commands) {
			if (command.type === "cd") {
				ctx.builderParent = normalizeParent(command.target);
				out.push(contextComment(content));
				continue;
			}
			const rendered = serializeBuilderCommand(command, ctx);
			out.push(...rendered.map(renderCommand));
		}
		return out;
	}

	if (ctx.mode === "ui") {
		const result = parseUiInput(content);
		if ("error" in result) return parseError(content, line, result.error, diagnostics);
		const out: string[] = [];
		for (const command of result.commands) {
			if (command.type === "cd") {
				ctx.uiParent = normalizeParent(command.target);
				out.push(contextComment(content));
				continue;
			}
			const rendered = serializeUiCommand(command, ctx);
			out.push(...rendered.map(renderCommand));
		}
		return out;
	}

	const result = parseDspInput(content);
	if ("error" in result) return parseError(content, line, result.error, diagnostics);
	const out: string[] = [];
	for (const command of result.commands) {
		if (command.type === "cd") {
			const target = pathToArg(command.target);
			if (ctx.awaitingDspHost) {
				ctx.dspHost = target;
				ctx.dspParent = null;
				ctx.awaitingDspHost = false;
			} else {
				ctx.dspParent = normalizeParent(command.target);
			}
			out.push(contextComment(content));
			continue;
		}
		if (!ctx.dspHost) {
			diagnostics.push({ line, content, reason: "dsp command before cd <module-id>" });
			out.push(`# hsc-error: ${content}`);
			continue;
		}
		const rendered = serializeDspCommand(command, ctx);
		out.push(...rendered.map(renderCommand));
	}
	return out;
}

function serializeBuilderCommand(command: BuilderCommand, ctx: TranslationContext): string[][] {
	switch (command.type) {
		case "reset": return [["builder", "reset"]];
		case "ls": return [["builder", "tree"]];
		case "pwd": return [];
		case "add": return [["builder", "add", "--type", command.moduleType, "--id", command.alias, ...parentFlags(command.parent, ctx.builderParent)]];
		case "addChain": return command.clauses.map((clause) => ["builder", "add", "--type", clause.moduleType, "--id", clause.alias, ...storedParentFlags(ctx.builderParent)]);
		case "remove": return command.targets.map((target) => ["builder", "remove", "--module", pathToArg(target)]);
		case "rename": return [["builder", "rename", "--module", pathToArg(command.target), "--id", command.name]];
		case "clone": return [["builder", "clone", "--module", pathToArg(command.target), "--count", String(command.count)]];
		case "get": return command.paths.map((path) => {
			const split = splitTargetField(path);
			return ["builder", "get", "--module", split.target, "--param", split.field];
		});
		case "show": {
			if (command.kind === "tree") return [["builder", "tree"]];
			const split = splitOptionalTargetField(command.target);
			return [["builder", "show", "--module", split.target, ...(split.field ? ["--param", split.field] : [])]];
		}
		case "set": return command.clauses.map((clause) => serializeBuilderSet(clause.path, clause.value));
		case "cd": return [];
	}
}

function serializeBuilderSet(path: PathRef, value: Value): string[] {
	const split = splitTargetField(path);
	const valueArg = valueToArg(value);
	if (split.field === "bypassed") return ["builder", "set", "--module", split.target, "--bypassed", valueArg];
	if (split.field === "routing") return ["builder", "set", "--module", split.target, "--routing", valueArg];
	if (split.field === "routing.send") return ["builder", "set", "--module", split.target, "--routing-send", valueArg];
	if (split.field === "network") return ["builder", "set", "--module", split.target, "--network", valueArg];
	if (split.field === "samplemap") return ["builder", "set", "--module", split.target, "--samplemap", valueArg];
	if (split.field === "effect") return ["builder", "set", "--module", split.target, "--effect", valueArg];
	if (split.field === "parent") return ["builder", "move", "--module", split.target, "--parent", valueArg];
	if (split.field === "index") return ["builder", "move", "--module", split.target, "--index", valueArg];
	return ["builder", "set", "--module", split.target, "--param", split.field, "--value", valueArg];
}

function serializeUiCommand(command: UiCommand, ctx: TranslationContext): string[][] {
	switch (command.type) {
		case "reset": return [];
		case "ls": return [["ui", "tree"]];
		case "pwd": return [];
		case "add": return [["ui", "add", "--type", command.componentType, "--id", command.alias, ...parentFlags(command.parent, ctx.uiParent)]];
		case "addChain": return command.clauses.map((clause) => ["ui", "add", "--type", clause.componentType, "--id", clause.alias, ...storedParentFlags(ctx.uiParent)]);
		case "remove": return command.targets.map((target) => ["ui", "remove", "--component", pathToArg(target)]);
		case "rename": return [["ui", "rename", "--component", pathToArg(command.target), "--id", command.name]];
		case "get": return command.paths.map((path) => {
			const split = splitTargetField(path);
			return ["ui", "get", "--component", split.target, "--property", split.field];
		});
		case "show": {
			if (command.kind === "tree") return [["ui", "tree"]];
			const split = splitOptionalTargetField(command.target);
			return [["ui", "show", "--component", split.target, ...(split.field ? ["--property", split.field] : [])]];
		}
		case "connect": {
			const target = splitTargetField(command.target);
			return [["ui", "connect", "--source", pathToArg(command.component), "--target", target.target, "--param", target.field, ...(command.matched ? ["--matched"] : [])]];
		}
		case "set": return command.clauses.map((clause) => {
			const split = splitTargetField(clause.path);
			return ["ui", "set", "--component", split.target, `--${split.field}`, valueToArg(clause.value)];
		});
		case "cd": return [];
	}
}

function serializeDspCommand(command: DspCommand, ctx: TranslationContext): string[][] {
	const moduleFlag = ["--module", ctx.dspHost!];
	switch (command.type) {
		case "reset": return [["dsp", "reset", ...moduleFlag]];
		case "save": return [["dsp", "save", ...moduleFlag]];
		case "ls": return [["dsp", "tree", ...moduleFlag]];
		case "pwd": return [];
		case "add": return [["dsp", "add", ...moduleFlag, "--type", `${command.factory}.${command.node}`, "--id", command.alias, ...parentFlags(command.parent, ctx.dspParent)]];
		case "addChain": return command.clauses.map((clause) => ["dsp", "add", ...moduleFlag, "--type", `${clause.factory}.${clause.node}`, "--id", clause.alias, ...storedParentFlags(ctx.dspParent)]);
		case "remove": return command.targets.map((target) => ["dsp", "remove", ...moduleFlag, "--node", pathToArg(target)]);
		case "rename": return [["dsp", "rename", ...moduleFlag, "--node", pathToArg(command.target), "--id", command.name]];
		case "get": return command.paths.map((path) => {
			const split = splitFirstField(path);
			return ["dsp", "get", ...moduleFlag, "--node", split.target, "--param", split.field];
		});
		case "show": {
			if (command.kind !== "target") {
				return [["dsp", command.kind, ...moduleFlag]];
			}
			const split = splitOptionalTargetField(command.target);
			return [["dsp", "show", ...moduleFlag, "--node", split.target, ...(split.field ? ["--param", split.field] : [])]];
		}
		case "set": return command.clauses.map((clause) => {
			const split = splitFirstField(clause.path);
			return ["dsp", "set", ...moduleFlag, "--node", split.target, "--param", split.field, "--value", valueToArg(clause.value)];
		});
		case "connect": return command.clauses.map((clause) => {
			const source = splitOptionalTargetField(clause.source);
			const target = splitOptionalTargetField(clause.target);
			return [
				"dsp", "connect", ...moduleFlag,
				"--source", source.target,
				...(source.field ? ["--source-param", source.field] : []),
				"--target", target.target,
				...(target.field ? ["--param", target.field] : []),
				...(clause.matched ? ["--matched"] : []),
			];
		});
		case "disconnect": return command.targets.map((target) => ["dsp", "disconnect", ...moduleFlag, "--target", pathToArg(target)]);
		case "createParameter": return [[
			"dsp", "create_parameter", ...moduleFlag,
			"--container", pathToArg(command.container),
			"--id", command.paramName,
			"--range", command.range.join(","),
			...(command.defaultValue !== undefined ? ["--default", String(command.defaultValue)] : []),
			...(command.stepSize !== undefined ? ["--stepSize", String(command.stepSize)] : []),
			...(command.middlePosition !== undefined ? ["--middlePosition", String(command.middlePosition)] : []),
			...(command.skewFactor !== undefined ? ["--skewFactor", String(command.skewFactor)] : []),
		]];
		case "screenshot": return [["dsp", "screenshot", ...moduleFlag, "--scale", String(command.scale), "--output", command.file]];
		case "trace": return [[
			"dsp", "trace", ...moduleFlag,
			...(command.container ? ["--container", pathToArg(command.container)] : []),
			...(command.signalType ? ["--inject", command.signalType] : []),
			...(command.gain !== undefined ? ["--gain", String(command.gain)] : []),
			...(command.seed !== undefined ? ["--seed", String(command.seed)] : []),
			...(command.injectBefore ? ["--inject-before", command.injectBefore] : []),
			...command.injectParams.flatMap((p) => ["--inject-param", `${pathToArg(p.path)}=${valueToArg(p.value)}`]),
			...(command.recursive ? ["--probe-recursive"] : []),
			...(command.changedParameters ? ["--probe-changed-parameters"] : []),
			...command.probeParams.flatMap((p) => ["--probe-param", pathToArg(p)]),
			...(command.probeAfter ? ["--probe-after", command.probeAfter] : []),
			...(command.delayMs !== undefined ? ["--delay-ms", String(command.delayMs)] : []),
			...(command.compact ? ["--trace-compact"] : []),
			...(command.noSpecs ? ["--no-specs"] : []),
			...(command.noSignal ? ["--no-signal"] : []),
		]];
		case "cd": return [];
	}
}

function splitTargetField(ref: PathRef): { target: string; field: string } {
	const segments = pathRefSegments(ref).map(segmentToArg);
	return { target: segments.slice(0, -1).join("."), field: segments[segments.length - 1]! };
}

function splitFirstField(ref: PathRef): { target: string; field: string } {
	const segments = pathRefSegments(ref).map(segmentToArg);
	return { target: segments[0]!, field: segments.slice(1).join(".") };
}

function splitOptionalTargetField(ref: PathRef): { target: string; field?: string } {
	const segments = pathRefSegments(ref).map(segmentToArg);
	if (segments.length <= 1) return { target: segments[0] ?? pathToArg(ref) };
	return { target: segments.slice(0, -1).join("."), field: segments[segments.length - 1] };
}

function parentFlags(explicitParent: PathRef | undefined, storedParent: string | null): string[] {
	if (explicitParent) return ["--parent", pathToArg(explicitParent)];
	return storedParentFlags(storedParent);
}

function storedParentFlags(storedParent: string | null): string[] {
	return storedParent && !ROOT_PARENT.has(storedParent) ? ["--parent", storedParent] : [];
}

function normalizeParent(ref: PathRef): string | null {
	const parent = pathToArg(ref);
	return ROOT_PARENT.has(parent) || parent === ".." ? null : parent;
}

function pathToArg(ref: PathRef): string {
	if (ref.kind === "parent") return "..";
	return pathRefSegments(ref).map(segmentToArg).join(".");
}

function segmentToArg(segment: PathSegment): string {
	return segment.id;
}

function valueToArg(value: Value): string {
	switch (value.kind) {
		case "number": return String(value.n);
		case "string": return value.s;
		case "boolean": return value.b ? "true" : "false";
		case "hex": return `0x${value.n.toString(16).toUpperCase().padStart(8, "0")}`;
		case "array2": return value.n.join(",");
		case "array4": return value.n.join(",");
		case "arrayN": return value.n.join(",");
		case "path": return pathToArg(value.ref);
	}
}

function renderCommand(args: string[]): string {
	return ["hise-cli", ...args].map(shellQuote).join(" ");
}

function shellQuote(arg: string): string {
	if (arg === "") return "''";
	if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg)) return arg;
	return `"${arg.replace(/"/g, '\\"')}"`;
}

function contextComment(content: string): string {
	return `# hsc-context: ${content}`;
}

function hscOnlyComment(content: string): string {
	return `# hsc-only: ${content}`;
}

function parseError(
	content: string,
	line: number,
	reason: string,
	diagnostics: HscToCliDiagnostic[],
): string[] {
	diagnostics.push({ line, content, reason });
	return [`# hsc-error: ${content}`];
}

function stripInlineComment(content: string): string {
	let inDouble = false;
	let inSingle = false;
	for (let i = 0; i < content.length; i++) {
		const ch = content[i]!;
		if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
		if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
		if (inDouble || inSingle) continue;
		if (ch === "#" || (ch === "/" && content[i + 1] === "/")) {
			return content.slice(0, i).trimEnd();
		}
	}
	return content;
}

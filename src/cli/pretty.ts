// ── Pretty CLI output — render CliOutputPayload as ANSI/plain text ───
//
// Default output mode for one-shot CLI commands. JSON is opt-in via
// `--json`. Two render paths:
//
//   TTY    → ANSI colors, marked-terminal box-drawing, chalk bold/gray.
//   Piped  → raw markdown / plain text, ANSI stripped, value payloads as
//            key:value list. Optimized for LLM agents and pipelines.

import chalk from "chalk";
import type { CommandResult } from "../engine/result.js";
import { formatRunReport } from "../engine/run/executor.js";
import { renderMarkdown } from "../tui/markdown.js";
import { defaultScheme } from "../tui/theme.js";
import type { CliOutputPayload } from "./output.js";

interface PayloadWithResult { ok: boolean; result: CommandResult }
interface PayloadWithError { ok: false; error: string }
interface PayloadWithValue { ok: true; logs?: string[]; value?: unknown }

function hasResult(p: CliOutputPayload): p is PayloadWithResult {
	return typeof p === "object" && p !== null && "result" in p;
}

function hasError(p: CliOutputPayload): p is PayloadWithError {
	return typeof p === "object" && p !== null && "error" in p && (p as { ok?: boolean }).ok === false;
}

function hasValue(p: CliOutputPayload): p is PayloadWithValue {
	return typeof p === "object" && p !== null && !("result" in p) && !("error" in p);
}

const TERM_WIDTH = (process.stdout.columns && process.stdout.columns > 0) ? process.stdout.columns : 80;
const IS_TTY = process.stdout.isTTY === true;

const ANSI_REGEX = /\x1B\[[0-9;]*[A-Za-z]/g;

function stripAnsi(s: string): string {
	return s.replace(ANSI_REGEX, "");
}

export function renderPretty(payload: CliOutputPayload): string {
	if (hasResult(payload)) {
		return renderResult(payload.result).replace(/\n+$/, "");
	}
	if (hasError(payload)) {
		return chalk.red(payload.error);
	}
	if (hasValue(payload)) {
		const parts: string[] = [];
		if (payload.logs && payload.logs.length > 0) {
			parts.push(payload.logs.join("\n"));
		}
		if (payload.value !== undefined) {
			parts.push(renderValue(payload.value));
		}
		return parts.join("\n");
	}
	return JSON.stringify(payload, null, 2);
}

function renderValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object") return String(value);
	if (IS_TTY) return JSON.stringify(value, null, 2);
	return formatKeyValue(value as Record<string, unknown>);
}

function formatKeyValue(obj: Record<string, unknown>, indent = 0): string {
	const pad = "  ".repeat(indent);
	const lines: string[] = [];
	for (const [k, v] of Object.entries(obj)) {
		if (v === null || v === undefined) {
			lines.push(`${pad}${k}: ${v === null ? "null" : ""}`);
		} else if (Array.isArray(v)) {
			lines.push(`${pad}${k}: ${JSON.stringify(v)}`);
		} else if (typeof v === "object") {
			lines.push(`${pad}${k}:`);
			lines.push(formatKeyValue(v as Record<string, unknown>, indent + 1));
		} else {
			lines.push(`${pad}${k}: ${String(v)}`);
		}
	}
	return lines.join("\n");
}

function renderResult(result: CommandResult): string {
	switch (result.type) {
		case "text":
			return IS_TTY ? result.content : stripAnsi(result.content);
		case "error":
			return result.detail
				? `${chalk.red(result.message)}\n${chalk.gray(result.detail)}`
				: chalk.red(result.message);
		case "code":
			return IS_TTY ? result.content : stripAnsi(result.content);
		case "markdown":
			if (!IS_TTY) return markdownToPlain(result.content);
			return renderMarkdown(result.content, {
				scheme: defaultScheme,
				accent: result.accent,
				width: TERM_WIDTH,
			});
		case "preformatted":
			return IS_TTY ? result.content : stripAnsi(result.content);
		case "table":
			return IS_TTY ? renderTable(result.headers, result.rows) : renderPlainTable(result.headers, result.rows);
		case "wizard":
			return chalk.yellow(`Wizard: ${result.definition.header ?? result.definition.id} (interactive — run via TUI or use /wizard run)`);
		case "run-report":
			return formatRunReport(result.runResult, result.verbosity);
		case "empty":
			return "";
	}
}

function renderTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? "").length)));
	const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
	const lines = [chalk.bold(fmt(headers)), chalk.gray(widths.map(w => "─".repeat(w)).join("  "))];
	for (const row of rows) lines.push(fmt(row));
	return lines.join("\n");
}

function markdownToPlain(md: string): string {
	const lines = md.split("\n");
	const out: string[] = [];
	let i = 0;
	let inFence = false;

	while (i < lines.length) {
		const line = lines[i]!;

		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			i++;
			continue;
		}
		if (inFence) {
			out.push(line);
			i++;
			continue;
		}

		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			const text = stripInline(heading[2]!);
			out.push(text);
			out.push("─".repeat(Math.max(text.length, 3)));
			i++;
			continue;
		}

		if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*-{3,}/.test(lines[i + 1]!)) {
			const tableLines: string[] = [];
			while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
				tableLines.push(lines[i]!);
				i++;
			}
			out.push(formatPlainTable(tableLines));
			continue;
		}

		out.push(stripInline(line));
		i++;
	}

	return out.join("\n");
}

function stripInline(s: string): string {
	return s
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/__(.+?)__/g, "$1")
		.replace(/(?<!\*)\*(?!\*)([^*]+?)\*(?!\*)/g, "$1")
		.replace(/(?<!_)_(?!_)([^_]+?)_(?!_)/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
		.replace(/^>\s?/, "");
}

function formatPlainTable(tableLines: string[]): string {
	const splitRow = (l: string): string[] =>
		l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => stripInline(c.trim()));

	const headers = splitRow(tableLines[0]!);
	const rows = tableLines.slice(2).map(splitRow);
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
	const fmt = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ");
	const lines = [fmt(headers), widths.map((w) => "─".repeat(w)).join("  ")];
	for (const row of rows) lines.push(fmt(row));
	return lines.join("\n");
}

function renderPlainTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
	const fmt = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ");
	const lines = [fmt(headers), widths.map((w) => "─".repeat(w)).join("  ")];
	for (const row of rows) lines.push(fmt(row));
	return lines.join("\n");
}

// ── Pre-renderer — convert blocks to ANSI line arrays ───────────────
//
// Pure functions that convert CommandResult and echo data into
// pre-rendered ANSI string lines. These lines are stored in the
// Output component's line buffer and sliced for viewport display,
// avoiding React reconciliation and Yoga layout on scroll.

import type { ColorScheme } from "./theme.js";
import { brand, darkenHex } from "./theme.js";
import type { TokenSpan } from "../engine/highlight/tokens.js";
import { TOKEN_COLORS } from "../engine/highlight/tokens.js";
import type { CommandResult } from "../engine/result.js";
import { fgHex, bgHex, RESET } from "../engine/ansi.js";
import { renderMarkdown } from "./markdown.js";

export { fgHex, bgHex, RESET };

// ── Types ───────────────────────────────────────────────────────────

/** A block of pre-rendered ANSI lines ready for viewport slicing. */
export interface PrerenderedBlock {
	/** ANSI-styled lines (one string per terminal row) */
	lines: string[];
	/** Number of lines (same as lines.length, cached for convenience) */
	height: number;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Convert a table (headers + rows) to a markdown table string. */
function tableToMarkdown(headers: string[], rows: string[][]): string {
	const headerRow = "| " + headers.join(" | ") + " |";
	const divider = "| " + headers.map(h => "-".repeat(Math.max(h.length, 3))).join(" | ") + " |";
	const dataRows = rows.map(row => "| " + row.join(" | ") + " |");
	return [headerRow, divider, ...dataRows].join("\n");
}

/** Wrap code content in a fenced code block. */
function codeToMarkdown(content: string, language?: string): string {
	const lang = language || "hisescript";
	return "```" + lang + "\n" + content + "\n```";
}

// ── ANSI helpers ────────────────────────────────────────────────────
// fgHex/bgHex/RESET come from engine/ansi.ts; re-exported above for
// existing tui imports that pull them from prerender.

/** Truncate an ANSI-styled line to a maximum visible width.
 *  Escape sequences are preserved but don't count towards the width. */
export function truncateAnsi(line: string, maxVisibleWidth: number): string {
	let visible = 0;
	let i = 0;
	while (i < line.length && visible < maxVisibleWidth) {
		if (line[i] === "\x1b") {
			const end = line.indexOf("m", i);
			i = end !== -1 ? end + 1 : i + 1;
		} else {
			visible++;
			i++;
		}
	}
	// Preserve any trailing escape sequences (e.g. RESET) right after the cut point
	while (i < line.length && line[i] === "\x1b") {
		const end = line.indexOf("m", i);
		i = end !== -1 ? end + 1 : i + 1;
	}
	return line.slice(0, i) + RESET;
}

/** Wrap an ANSI-styled line into multiple lines at a given visible width.
 *  Preserves active color state across line breaks. */
export function wrapAnsi(line: string, maxWidth: number): string[] {
	if (maxWidth <= 0) return [line];
	const lines: string[] = [];
	let visible = 0;
	let current = "";
	let activeEsc = ""; // accumulated ANSI escapes for carry-over

	let i = 0;
	while (i < line.length) {
		if (line[i] === "\x1b") {
			const end = line.indexOf("m", i);
			if (end === -1) { current += line[i]; i++; continue; }
			const seq = line.slice(i, end + 1);
			current += seq;
			if (seq === RESET) {
				activeEsc = "";
			} else {
				activeEsc += seq;
			}
			i = end + 1;
		} else {
			current += line[i];
			visible++;
			i++;
			if (visible >= maxWidth && i < line.length) {
				lines.push(current + RESET);
				current = activeEsc;
				visible = 0;
			}
		}
	}
	if (current) lines.push(current);
	if (lines.length === 0) lines.push("");
	return lines;
}

// ── Echo renderer ───────────────────────────────────────────────────

/** Render a command echo block to ANSI lines. */
export function renderEcho(
	input: string,
	accent: string,
	darkerBg: string,
	contentWidth: number,
	spans?: TokenSpan[],
	options?: { prefix?: string; prefixColor?: string },
): PrerenderedBlock {
	const border = "\u258E "; // ▎ + space
	const bg = bgHex(darkerBg);
	const fg = fgHex(accent);
	const prefix = options?.prefix ?? "";
	const prefixColor = options?.prefixColor ? fgHex(options.prefixColor) : "";

	// Top/bottom border lines
	const padBorder = bg + fg + border + RESET + bg + " ".repeat(Math.max(0, contentWidth - 2)) + RESET;

	// Check for multiline input
	const inputLines = input.split("\n");

	if (inputLines.length === 1) {
		// Single-line: original rendering with "> " prefix and optional spans
		const paddedContent = bg + fg + border + "> " +
			(prefix ? prefixColor + prefix : "") +
			(spans && spans.length > 0
				? spans.map(span => {
					const c = span.color || TOKEN_COLORS[span.token];
					return fgHex(c) + span.text;
				}).join("")
				: input
			) + " ".repeat(Math.max(0, contentWidth - 2 - 2 - prefix.length - input.length)) + RESET;

		return { lines: [padBorder, paddedContent, padBorder], height: 3 };
	}

	// Multiline: render each line with border + padding, no "> " prefix
	const contentLines = inputLines.map((line) => {
		const pad = " ".repeat(Math.max(0, contentWidth - 2 - line.length));
		return bg + fg + border + RESET + bg + fgHex(accent) + line + pad + RESET;
	});

	const lines = [padBorder, ...contentLines, padBorder];
	return { lines, height: lines.length };
}

// ── Plain-text wrap helper ──────────────────────────────────────────

/** Wrap plain text (no ANSI) at a fixed character width. */
function wrapPlain(text: string, width: number): string[] {
	if (width <= 0 || text.length <= width) return [text];
	const result: string[] = [];
	for (let i = 0; i < text.length; i += width) {
		result.push(text.slice(i, i + width));
	}
	return result;
}

// ── Error renderer ──────────────────────────────────────────────────

/** Render an error block to ANSI lines. */
export function renderError(
	message: string,
	detail: string | undefined,
	mutedColor: string,
	width?: number,
): PrerenderedBlock {
	const errorFg = fgHex(brand.error);
	const mutedFg = fgHex(mutedColor);
	const lines: string[] = [];
	const w = width ?? Infinity;
	// Split message by embedded newlines, then wrap each line
	const msgLines = message.split("\n");
	for (let i = 0; i < msgLines.length; i++) {
		const pre = i === 0 ? "\u2717 " : "  ";
		for (const part of wrapPlain(pre + msgLines[i]!, w)) {
			lines.push(errorFg + part + RESET);
		}
	}
	if (detail) {
		for (const raw of detail.split("\n")) {
			for (const part of wrapPlain(raw, w)) {
				lines.push(mutedFg + part + RESET);
			}
		}
	}
	return { lines, height: lines.length };
}

// ── Preformatted renderer (analyse mode output) ────────────────────

/** Visible width of a string, ignoring ANSI escape codes. */
function visibleLength(s: string): number {
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Render pre-formatted content (braille waveforms, spectrograms) with a darker background
 *  and an accent-colored left border (matching the echo box style). */
function renderPreformatted(
	content: string,
	scheme: ColorScheme,
	width: number,
	accent?: string,
	plain?: boolean,
): PrerenderedBlock {
	if (plain) {
		const rawLines = content.split("\n");
		return { lines: rawLines, height: rawLines.length };
	}
	const bg = bgHex(darkenHex(scheme.backgrounds.standard, 0.85));
	const border = "\u258E "; // ▎ + space (same as echo box)
	const borderFg = accent ? fgHex(accent) : "";
	const fgReset = "\x1b[39m"; // reset foreground only, preserve background
	const borderStr = borderFg + border + fgReset;
	const borderWidth = 2; // ▎ + space
	const indent = " "; // 1 char after border
	const contentWidth = width - borderWidth - 1;

	const rawLines = content.split("\n");
	const lines: string[] = [];

	// Top padding line
	lines.push(bg + borderStr + " ".repeat(Math.max(0, width - borderWidth)) + RESET);

	for (const raw of rawLines) {
		const vis = visibleLength(raw);
		const pad = Math.max(0, contentWidth - vis);
		lines.push(bg + borderStr + indent + raw + " ".repeat(pad) + RESET);
	}

	// Bottom padding line
	lines.push(bg + borderStr + " ".repeat(Math.max(0, width - borderWidth)) + RESET);

	return { lines, height: lines.length };
}

// ── Result renderer ─────────────────────────────────────────────────

/** Render a CommandResult to pre-rendered ANSI lines. */
export function renderResult(
	result: CommandResult,
	scheme: ColorScheme,
	width: number,
): PrerenderedBlock | null {
	let source: string;

	switch (result.type) {
		case "empty":
			return null;

		case "text":
			source = result.content;
			break;

		case "error":
			return renderError(result.message, result.detail, scheme.foreground.muted, width);

		case "code":
			source = codeToMarkdown(result.content, result.language);
			break;

		case "preformatted":
			return renderPreformatted(result.content, scheme, width, result.accent, result.plain);

		case "json":
			source = codeToMarkdown(
				result.fallbackText ?? JSON.stringify(result.value, null, 2),
				"json",
			);
			break;

		case "table":
			source = tableToMarkdown(result.headers, result.rows);
			break;

		case "markdown":
			source = result.content;
			break;

		default:
			return null;
	}

	const rendered = renderMarkdown(source, {
		scheme,
		accent: result.accent,
		width,
	});
	const lines = rendered.split("\n");
	return { lines, height: lines.length };
}

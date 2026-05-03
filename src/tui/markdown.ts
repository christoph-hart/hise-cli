// ── Markdown — themed terminal markdown renderer (pure function) ────

import type { TerminalRendererOptions } from "marked-terminal";
import chalk from "chalk";
import { highlight as highlightCli } from "cli-highlight";
import type { ColorScheme } from "./theme.js";
import { darkenHex, lerpHex } from "./theme.js";
import { TOKEN_COLORS } from "../engine/highlight/tokens.js";
import { tokenize as tokenizeHiseScript } from "../engine/highlight/hisescript.js";
import { bgHex as engineBgHex } from "../engine/ansi.js";

import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

const highlightTheme = {
	keyword: chalk.hex(TOKEN_COLORS.keyword),
	built_in: chalk.hex(TOKEN_COLORS.scopedStatement),
	type: chalk.hex(TOKEN_COLORS.scopedStatement),
	literal: chalk.hex(TOKEN_COLORS.keyword),
	number: chalk.hex(TOKEN_COLORS.integer),
	regexp: chalk.hex(TOKEN_COLORS.string),
	string: chalk.hex(TOKEN_COLORS.string),
	symbol: chalk.hex(TOKEN_COLORS.identifier),
	class: chalk.hex(TOKEN_COLORS.scopedStatement),
	function: chalk.hex(TOKEN_COLORS.identifier),
	title: chalk.hex(TOKEN_COLORS.identifier),
	params: chalk.hex(TOKEN_COLORS.plain),
	comment: chalk.hex(TOKEN_COLORS.comment),
	doctag: chalk.hex(TOKEN_COLORS.comment),
	meta: chalk.hex(TOKEN_COLORS.comment),
	tag: chalk.hex(TOKEN_COLORS.keyword),
	name: chalk.hex(TOKEN_COLORS.keyword),
	attr: chalk.hex(TOKEN_COLORS.scopedStatement),
	attribute: chalk.hex(TOKEN_COLORS.scopedStatement),
	variable: chalk.hex(TOKEN_COLORS.identifier),
	default: chalk.hex(TOKEN_COLORS.plain),
};

function buildOptions(
	scheme: ColorScheme,
	accent?: string,
	width?: number,
): TerminalRendererOptions {
	const inlineCodeColor = accent
		? lerpHex(scheme.foreground.default, accent, 0.4)
		: scheme.foreground.bright;
	const headingColor = accent || scheme.foreground.bright;

	return {
		code: chalk.hex(scheme.foreground.bright),
		blockquote: chalk.hex(scheme.foreground.muted).italic,
		html: chalk.hex(scheme.foreground.muted),
		heading: chalk.hex(headingColor).bold,
		firstHeading: chalk.hex(headingColor).bold,
		hr: chalk.hex(scheme.foreground.muted),
		listitem: chalk.hex(scheme.foreground.default),
		table: chalk.hex(scheme.foreground.default),
		paragraph: chalk.hex(scheme.foreground.default),
		strong: chalk.hex(scheme.foreground.default).bold,
		em: chalk.hex(scheme.foreground.default).italic,
		codespan: chalk.hex(inlineCodeColor),
		del: chalk.hex(scheme.foreground.muted).strikethrough,
		link: chalk.hex(scheme.foreground.default),
		href: chalk.hex(accent || scheme.foreground.bright).underline,

		showSectionPrefix: false,
		reflowText: true,
		width: width || 80,
		unescape: true,
		emoji: true,
		tab: 2,

		tableOptions: {
			style: { head: ["white", "bold"], border: ["dim"] },
		},
	};
}

export interface RenderMarkdownOptions {
	scheme: ColorScheme;
	accent?: string;
	width?: number;
}

/** Render markdown to an ANSI-styled string. */
export function renderMarkdown(source: string, opts: RenderMarkdownOptions): string {
	const { scheme, accent, width } = opts;
	const options = buildOptions(scheme, accent, width);

	const baseBg = scheme.backgrounds.standard;
	const codeBg = darkenHex(baseBg, 0.85);
	// engineBgHex routes through rgbTo256 which checks the grayscale ramp
	// for low-saturation colors. chalk.bgHex picks cube cell (95,95,95) for
	// any dark hex in the 13–47 range, making the bg look 50% gray on
	// 256-color terminals. Engine helper picks ramp idx 234 (rgb 28, ~11%).
	const codeBgOpen = engineBgHex(codeBg);
	const codeBgClose = "\x1b[49m";
	const wrapCodeBg = (s: string) => `${codeBgOpen}${s}${codeBgClose}`;
	const codeIndent = "  ";

	const localMarked = new Marked();
	localMarked.use(markedTerminal(options, { theme: highlightTheme } as any) as any);

	const codeBlockWidth = width || 80;

	localMarked.use({
		renderer: {
			code({ text, lang }: { text: string; lang?: string }) {
				let highlighted: string;
				if (lang === "hisescript" || lang === "hise") {
					const spans = tokenizeHiseScript(text);
					highlighted = spans.map(span => {
						const color = span.color || TOKEN_COLORS[span.token];
						return chalk.hex(color)(span.text);
					}).join("");
				} else {
					try {
						highlighted = highlightCli(text, {
							language: lang || "",
							theme: highlightTheme,
						});
					} catch {
						highlighted = chalk.hex(scheme.foreground.bright)(text);
					}
				}

				const lines = highlighted.split("\n");
				const withBg = lines.map(line => {
					const visible = line.replace(/\x1b\[[0-9;]*m/g, "");
					const padding = Math.max(0, codeBlockWidth - codeIndent.length - visible.length);
					return wrapCodeBg(codeIndent + line + " ".repeat(padding));
				}).join("\n");

				const padLine = wrapCodeBg(" ".repeat(codeBlockWidth));
				return "\n" + padLine + "\n" + withBg + "\n" + padLine + "\n\n";
			},
		},
	});

	let result = localMarked.parse(source, { async: false }) as string;
	result = result.replace(/\*\*(.+?)\*\*/g, (_, text) => chalk.bold(text));
	result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, text) => chalk.italic(text));

	return result.trim();
}

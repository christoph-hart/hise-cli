import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args.js";
import { commandSurface, type CommandSurfaceMode } from "./command-surface.js";
import { listCliCommands } from "./commands.js";
import { parseSingleCommand } from "../engine/modes/builder-parser.js";
import { parseSingleUiCommand } from "../engine/modes/ui-parser.js";
import { parseSingleDspCommand } from "../engine/modes/dsp-parser.js";
import { createSession } from "../session-bootstrap.js";

function getCliCommands() {
	return listCliCommands(createSession({ connection: null }).session.allCommands());
}

function parseModeCommand(mode: CommandSurfaceMode, input: string): { ok: true } | { ok: false; error: string } {
	const result = mode === "builder"
		? parseSingleCommand(input)
		: mode === "ui"
			? parseSingleUiCommand(input)
			: parseSingleDspCommand(input);
	if ("error" in result) return { ok: false, error: result.error };
	return { ok: true };
}

function yamlCommandIds(mode: CommandSurfaceMode): Set<string> {
	const url = new URL(`../../docs/agent-context/${mode}.yaml`, import.meta.url);
	const data = parse(readFileSync(url, "utf8")) as { commands?: Array<{ id?: unknown }> };
	return new Set((data.commands ?? []).map((command) => command.id).filter((id): id is string => typeof id === "string"));
}

describe("mode command surface parity", () => {
	it("keeps parser examples valid for every parser-backed inventory entry", () => {
		const failures: string[] = [];
		for (const entry of commandSurface) {
			if (!entry.parserExample) continue;
			const parsed = parseModeCommand(entry.mode, entry.parserExample);
			if (!parsed.ok) failures.push(`${entry.id}: ${parsed.error}`);
		}
		expect(failures).toEqual([]);
	});

	it("keeps direct flag CLI mappings in sync with the inventory", () => {
		const failures: string[] = [];
		for (const entry of commandSurface) {
			if (!entry.directCli) continue;
			const result = parseCliArgs(["node", "hise-cli", ...entry.directCli.argv], getCliCommands());
			if (result.kind !== "execute") {
				failures.push(`${entry.id}: expected execute, got ${result.kind}${result.kind === "error" ? ` (${result.message})` : ""}`);
				continue;
			}
			if (result.canonicalCommand !== entry.directCli.canonical) {
				failures.push(`${entry.id}: expected ${entry.directCli.canonical}, got ${result.canonicalCommand}`);
			}
		}
		expect(failures).toEqual([]);
	});

	it("keeps YAML agent-context command entries in sync with the inventory", () => {
		const idsByMode = {
			builder: yamlCommandIds("builder"),
			ui: yamlCommandIds("ui"),
			dsp: yamlCommandIds("dsp"),
		};
		const failures: string[] = [];
		for (const entry of commandSurface) {
			if (!entry.yamlId) continue;
			if (!idsByMode[entry.mode].has(entry.yamlId)) {
				failures.push(`${entry.id}: missing YAML command id ${entry.yamlId}`);
			}
		}
		expect(failures).toEqual([]);
	});

	it("documents every direct/YAML omission with an explicit exception reason", () => {
		const failures = commandSurface
			.filter((entry) => !entry.directCli && !entry.yamlId && !entry.exceptionReason)
			.map((entry) => entry.id);
		expect(failures).toEqual([]);
	});
});

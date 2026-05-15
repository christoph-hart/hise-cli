#!/usr/bin/env node

import chalk from "chalk";
import { existsSync, unlinkSync } from "node:fs";
import { HttpHiseConnection } from "./engine/hise.js";
import { createSession } from "./session-bootstrap.js";
import { executeCliCommand } from "./cli/run.js";
import { renderCliHelp } from "./cli/help.js";
import { listCliCommands } from "./cli/commands.js";
import { createDefaultMockRuntime } from "./mock/runtime.js";
import { registerUpdateHandlers } from "./tui/wizard-handlers/index.js";
import { bootstrapNodeRuntime, type NodeRuntime } from "./bootstrap-runtime.js";
import { cliError, exitCodeForPayload } from "./cli/errors.js";

// ── Runtime singleton ───────────────────────────────────────────────

const runtime: NodeRuntime = bootstrapNodeRuntime();

// ── Windows: clean up post-update sidecar ──────────────────────────
//
// `hise-cli update` on Windows renames the running .exe to .exe.old and
// writes the new .exe at the original path. The .old file lingers
// because Windows can't unlink a running executable. On the next launch
// (a fresh process), we silently delete it.
if (process.platform === "win32") {
	try {
		const oldExe = `${process.execPath}.old`;
		if (existsSync(oldExe)) unlinkSync(oldExe);
	} catch {
		// best-effort; ignore failures (e.g. file in use, permissions)
	}
}

// ── Launch ──────────────────────────────────────────────────────────

async function launchRepl(args: string[]): Promise<void> {
	const { launchInlineRepl } = await import("./tui/launch.js");
	const connection = args.includes("--mock")
		? createDefaultMockRuntime().connection
		: new HttpHiseConnection();
	registerUpdateHandlers(runtime.handlerRegistry, {
		executor: runtime.phaseExecutor,
		connection,
		launcher: runtime.hiseLauncher,
	});
	await launchInlineRepl(connection, runtime);
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	// Web frontend: hise-cli --web [--mock] [--no-open] [--port=N]
	if (process.argv.includes("--web")) {
		const { launchWeb } = await import("./web/server.js");
		const args = process.argv.slice(2);
		await launchWeb({
			runtime,
			useMock: args.includes("--mock"),
			openBrowser: !args.includes("--no-open"),
			port: parsePortFlag(args),
		});
		return;
	}

	// Fast-path: diagnose subcommand (no session bootstrap needed)
	if (process.argv[2] === "diagnose") {
		const args = process.argv.slice(3);
		if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
			console.log(renderCliHelp([], "diagnose"));
			process.exit(0);
		}
		const { executeDiagnose, parseDiagnoseFlags, formatDiagnoseOutput } = await import("./cli/diagnose.js");
		const { filePath, flags } = parseDiagnoseFlags(args);
		if (!filePath) {
			console.error("diagnose requires a file path argument");
			process.exit(1);
		}
		const connection = new HttpHiseConnection();
		const result = await executeDiagnose(filePath, connection);
		connection.destroy();

		if (flags.format === "pretty") {
			const output = formatDiagnoseOutput(result, flags);
			if (output) {
				process.stderr.write(output + "\n");
			}
			// Exit 2 = hook "block" signal (shows stderr to Claude), 0 = clean
			process.exitCode = result.ok ? 0 : 2;
			return;
		}

		console.log(JSON.stringify(result));
		process.exitCode = result.ok ? 0 : 1;
		return;
	}

	const bootstrap = createSession({ connection: null });
	const cliCommands = listCliCommands(bootstrap.session.allCommands());
	const cliResult = await executeCliCommand(process.argv, cliCommands, runtime.dataLoader, { handlerRegistry: runtime.handlerRegistry, launcher: runtime.hiseLauncher });

	if (cliResult.kind === "help") {
		console.log(renderCliHelp(cliCommands, cliResult.scope));
		return;
	}

	if (cliResult.kind === "error") {
		const payload = cliError("usage_error", cliResult.message);
		if (wantsJsonOutput(process.argv)) {
			console.log(JSON.stringify(payload));
		} else {
			console.error(chalk.red(cliResult.message));
		}
		process.exitCode = exitCodeForPayload(payload);
		return;
	}

	if (cliResult.kind === "json") {
		if (cliResult.output.json) {
			console.log(JSON.stringify(cliResult.payload, null, cliResult.output.pretty ? "\t" : undefined));
		} else {
			const { renderPretty } = await import("./cli/pretty.js");
			const text = renderPretty(cliResult.payload);
			if (text) console.log(text);
		}
		process.exitCode = exitCodeForPayload(cliResult.payload);
		return;
	}

	if (cliResult.kind === "text") {
		if (cliResult.text) console.log(cliResult.text);
		return;
	}

	if (cliResult.kind === "diagnose") {
		// Should not reach here — handled by fast-path above
		console.error("diagnose must be handled before session bootstrap");
		process.exit(1);
	}

	if (cliResult.kind === "update") {
		const { executeUpdateCommand } = await import("./cli/update.js");
		process.exitCode = await executeUpdateCommand({ check: cliResult.check });
		return;
	}

	await launchRepl(cliResult.args);
}

function parsePortFlag(args: string[]): number | undefined {
	for (const arg of args) {
		if (arg.startsWith("--port=")) {
			const n = Number(arg.slice("--port=".length));
			if (Number.isFinite(n) && n > 0 && n < 65536) return n;
		}
	}
	return undefined;
}

function wantsJsonOutput(argv: string[]): boolean {
	return argv.includes("--json")
		|| argv.includes("--agent")
		|| argv.includes("--select")
		|| argv.some((arg) => arg.startsWith("--select="));
}

void main();

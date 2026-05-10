import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args.js";
import { createSession } from "../session-bootstrap.js";
import { listCliCommands } from "./commands.js";

function getCliCommands() {
	return listCliCommands(createSession({ connection: null }).session.allCommands());
}

describe("parseCliArgs", () => {
	it("parses one-shot script invocation", () => {
		const result = parseCliArgs(["node", "hise-cli", "-script", "Console.print(234)"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/script Console.print(234)");
			expect(result.mode).toBe("script");
			expect(result.stdin).toBe(false);
		}
	});

	it("parses target path for mode commands", () => {
		const result = parseCliArgs(["node", "hise-cli", "-builder", "--target:SineGenerator", "add", "LFO"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/builder.SineGenerator add LFO");
		}
	});

	it("parses separated target values for mode commands", () => {
		const result = parseCliArgs(["node", "hise-cli", "-dsp", "--target", "Script FX1", "show", "tree"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe('/dsp."Script FX1" show tree');
		}
	});

	it("rejects target without a path", () => {
		const result = parseCliArgs(["node", "hise-cli", "-dsp", "show", "tree", "--target"], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "--target requires a path value" });
	});

	it("rejects missing one-shot tail for mode commands", () => {
		const result = parseCliArgs(["node", "hise-cli", "-script"], getCliCommands());
		expect(result).toEqual({
			kind: "error",
			message: "-script requires a one-shot command or expression",
		});
	});

	it("parses one-shot mode command from --stdin", () => {
		const result = parseCliArgs(["node", "hise-cli", "-builder", "--stdin"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/builder");
			expect(result.mode).toBe("builder");
			expect(result.stdin).toBe(true);
		}
	});

	it("parses global agent output flags", () => {
		const result = parseCliArgs(["node", "hise-cli", "-status", "--agent"], getCliCommands());
		expect(result.kind).toBe("status");
		if (result.kind === "status") {
			expect(result.output).toEqual({ json: true, agent: true, compact: true });
		}
	});

	it("parses agent-context as JSON output", () => {
		const result = parseCliArgs(["node", "hise-cli", "agent-context", "--pretty"], getCliCommands());
		expect(result.kind).toBe("agent-context");
		if (result.kind === "agent-context") {
			expect(result.query).toEqual({ type: "manifest" });
			expect(result.output).toEqual({ json: true, agent: false, compact: false, pretty: true });
		}
	});

	it("parses scoped agent-context mode queries", () => {
		const result = parseCliArgs(["node", "hise-cli", "agent-context", "script"], getCliCommands());
		expect(result.kind).toBe("agent-context");
		if (result.kind === "agent-context") {
			expect(result.query).toEqual({ type: "mode", modeId: "script" });
			expect(result.output.json).toBe(true);
		}
	});

	it("parses scoped agent-context capability queries", () => {
		const result = parseCliArgs(["node", "hise-cli", "agent-context", "--capability", "script.compile"], getCliCommands());
		expect(result.kind).toBe("agent-context");
		if (result.kind === "agent-context") {
			expect(result.query).toEqual({ type: "capability", id: "script.compile" });
		}
	});

	it("parses scoped agent-context capability equals queries", () => {
		const result = parseCliArgs(["node", "hise-cli", "agent-context", "--capability=script.compile"], getCliCommands());
		expect(result.kind).toBe("agent-context");
		if (result.kind === "agent-context") {
			expect(result.query).toEqual({ type: "capability", id: "script.compile" });
		}
	});

	it("parses agent-context capability index queries", () => {
		const result = parseCliArgs(["node", "hise-cli", "agent-context", "--list-capabilities"], getCliCommands());
		expect(result.kind).toBe("agent-context");
		if (result.kind === "agent-context") {
			expect(result.query).toEqual({ type: "capability-index" });
		}
	});

	it("rejects ambiguous agent-context queries", () => {
		const result = parseCliArgs(["node", "hise-cli", "agent-context", "script", "--capability", "script.compile"], getCliCommands());
		expect(result).toEqual({
			kind: "error",
			message: "agent-context accepts only one query: <mode>, --capability <id>, or --list-capabilities",
		});
	});

	it("rejects missing agent-context capability ids", () => {
		const result = parseCliArgs(["node", "hise-cli", "agent-context", "--capability"], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "--capability requires an id" });
	});

	it("rejects unknown agent-context flags", () => {
		const result = parseCliArgs(["node", "hise-cli", "agent-context", "--unknown"], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "Unexpected argument for agent-context: --unknown" });
	});

	it("parses which queries as JSON output", () => {
		const result = parseCliArgs(["node", "hise-cli", "which", "edit", "onInit", "from", "file", "--limit", "1"], getCliCommands());
		expect(result.kind).toBe("which");
		if (result.kind === "which") {
			expect(result.query).toBe("edit onInit from file");
			expect(result.limit).toBe(1);
			expect(result.output.json).toBe(true);
		}
	});

	it("parses select as JSON output", () => {
		const result = parseCliArgs(["node", "hise-cli", "-status", "--select", "value.connected"], getCliCommands());
		expect(result.kind).toBe("status");
		if (result.kind === "status") {
			expect(result.output).toEqual({ json: true, agent: false, compact: false, select: "value.connected" });
		}
	});

	it("rejects select without a path", () => {
		const result = parseCliArgs(["node", "hise-cli", "-status", "--select"], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "--select requires a path value" });
	});

	it("parses one-shot mode command from dash shorthand", () => {
		const result = parseCliArgs(["node", "hise-cli", "-builder", "-"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/builder");
			expect(result.stdin).toBe(true);
		}
	});

	it("rejects --stdin combined with inline mode command", () => {
		const result = parseCliArgs(["node", "hise-cli", "-builder", "--stdin", "show", "tree"], getCliCommands());
		expect(result).toEqual({
			kind: "error",
			message: "-builder --stdin cannot be combined with an inline one-shot command",
		});
	});

	it("reserves --help for native CLI help", () => {
		const result = parseCliArgs(["node", "hise-cli", "--help"], getCliCommands());
		expect(result).toEqual({ kind: "help" });
	});

	it("supports root commands", () => {
		const result = parseCliArgs(["node", "hise-cli", "-modes"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/modes");
			expect(result.mode).toBe("root");
		}
	});

	it("preserves TUI-only flags when launching repl", () => {
		const result = parseCliArgs(["node", "hise-cli", "--no-animation"], getCliCommands());
		expect(result).toEqual({ kind: "tui", args: ["--no-animation"] });
	});

	it("passes multi-word verb args through without re-quoting", () => {
		const result = parseCliArgs(["node", "hise-cli", "-builder", "show tree"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/builder show tree");
		}
	});

	it("strips matching outer double quotes from a tail arg (Git Bash on Windows)", () => {
		const result = parseCliArgs(["node", "hise-cli", "-builder", '"show tree"'], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/builder show tree");
		}
	});

	it("strips matching outer single quotes from a tail arg", () => {
		const result = parseCliArgs(["node", "hise-cli", "-builder", "'show tree'"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/builder show tree");
		}
	});

	it("preserves internal quotes inside an arg (e.g. quoted identifiers)", () => {
		const result = parseCliArgs(["node", "hise-cli", "-builder", 'add "MyGain"'], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe('/builder add "MyGain"');
		}
	});
});

describe("parseCliArgs --run verbosity", () => {
	it("defaults to summary verbosity", () => {
		const result = parseCliArgs(["node", "hise-cli", "--run", "foo.hsc"], getCliCommands());
		expect(result.kind).toBe("run");
		if (result.kind === "run") {
			expect(result.verbosity).toBe("summary");
			expect(result.source).toEqual({ type: "file", path: "foo.hsc" });
		}
	});

	it("--verbose alias sets verbose", () => {
		const result = parseCliArgs(["node", "hise-cli", "--run", "foo.hsc", "--verbose"], getCliCommands());
		expect(result.kind).toBe("run");
		if (result.kind === "run") expect(result.verbosity).toBe("verbose");
	});

	it("--quiet alias sets quiet", () => {
		const result = parseCliArgs(["node", "hise-cli", "--run", "foo.hsc", "--quiet"], getCliCommands());
		expect(result.kind).toBe("run");
		if (result.kind === "run") expect(result.verbosity).toBe("quiet");
	});

	it("--verbosity=<level> wins over alias", () => {
		const result = parseCliArgs(
			["node", "hise-cli", "--run", "foo.hsc", "--quiet", "--verbosity=summary"],
			getCliCommands(),
		);
		expect(result.kind).toBe("run");
		if (result.kind === "run") expect(result.verbosity).toBe("summary");
	});

	it("rejects unknown --verbosity value", () => {
		const result = parseCliArgs(
			["node", "hise-cli", "--run", "foo.hsc", "--verbosity=bogus"],
			getCliCommands(),
		);
		expect(result.kind).toBe("error");
		if (result.kind === "error") expect(result.message).toContain("Invalid --verbosity");
	});

	it("strips verbosity flags from positional path", () => {
		const result = parseCliArgs(
			["node", "hise-cli", "--run", "--quiet", "foo.hsc"],
			getCliCommands(),
		);
		expect(result.kind).toBe("run");
		if (result.kind === "run") {
			expect(result.source).toEqual({ type: "file", path: "foo.hsc" });
			expect(result.verbosity).toBe("quiet");
		}
	});
});

describe("script direct subcommands", () => {
	it("parses script repl from stdin", () => {
		const result = parseCliArgs(["node", "hise-cli", "script", "repl", "--module-id", "Interface", "--stdin"], getCliCommands());
		expect(result.kind).toBe("script-api");
		if (result.kind === "script-api") {
			expect(result.command).toEqual({ action: "repl", moduleId: "Interface", source: { type: "stdin" } });
		}
	});

	it("parses script get with callback", () => {
		const result = parseCliArgs(["node", "hise-cli", "script", "get", "--callback", "onInit"], getCliCommands());
		expect(result.kind).toBe("script-api");
		if (result.kind === "script-api") {
			expect(result.command).toEqual({ action: "get", moduleId: "Interface", callback: "onInit" });
		}
	});

	it("parses script set stdin with compile default", () => {
		const result = parseCliArgs(["node", "hise-cli", "script", "set", "--callback", "onInit", "--stdin"], getCliCommands());
		expect(result.kind).toBe("script-api");
		if (result.kind === "script-api" && result.command.action === "set") {
			expect(result.command.compile).toBe(true);
			expect(result.command.source).toEqual({ type: "stdin" });
		}
	});

	it("parses script set file with --no-compile", () => {
		const result = parseCliArgs(["node", "hise-cli", "script", "set", "--callback", "onInit", "--file", "onInit.js", "--no-compile"], getCliCommands());
		expect(result.kind).toBe("script-api");
		if (result.kind === "script-api" && result.command.action === "set") {
			expect(result.command.compile).toBe(false);
			expect(result.command.source).toEqual({ type: "file", path: "onInit.js" });
		}
	});

	it("parses script diagnose", () => {
		const result = parseCliArgs(["node", "hise-cli", "script", "diagnose", "--module-id", "Interface", "--file-path", "Scripts/UI.js", "--async"], getCliCommands());
		expect(result.kind).toBe("script-api");
		if (result.kind === "script-api") {
			expect(result.command).toEqual({ action: "diagnose", moduleId: "Interface", filePath: "Scripts/UI.js", async: true });
		}
	});

	it("parses script show tree filters", () => {
		const result = parseCliArgs(["node", "hise-cli", "script", "show", "tree", "Knob", "--symbols-only", "--format", "flat", "--limit", "20"], getCliCommands());
		expect(result.kind).toBe("script-api");
		if (result.kind === "script-api") {
			expect(result.command).toEqual({ action: "show", moduleId: "Interface", target: "tree", filters: { symbolsOnly: true, search: "Knob", format: "flat", limit: 20 } });
		}
	});

	it("rejects script show tree positional and explicit search", () => {
		const result = parseCliArgs(["node", "hise-cli", "script", "show", "tree", "Knob", "--search", "Slider"], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "script show tree accepts either a positional search or --search, not both" });
	});

	it("rejects script set without exactly one source", () => {
		const result = parseCliArgs(["node", "hise-cli", "script", "set", "--callback", "onInit"], getCliCommands());
		expect(result).toEqual({
			kind: "error",
			message: "script set requires exactly one source: --stdin, --file <path>, or --callbacks-json <path>",
		});
	});

	it("rejects script set stdin without callback", () => {
		const result = parseCliArgs(["node", "hise-cli", "script", "set", "--stdin"], getCliCommands());
		expect(result).toEqual({
			kind: "error",
			message: "script set with --stdin or --file requires --callback <name>",
		});
	});

	it("rejects unexpected direct script args", () => {
		const result = parseCliArgs(["node", "hise-cli", "script", "compile", "--callback", "onInit"], getCliCommands());
		expect(result).toEqual({
			kind: "error",
			message: "Unexpected argument for script compile: --callback",
		});
	});
});

describe("-wizard mode flag", () => {
	it("parses -wizard list", () => {
		const result = parseCliArgs(["node", "hise-cli", "-wizard", "list"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/wizard list");
			expect(result.mode).toBe("root");
		}
	});

	it("parses -wizard get <id>", () => {
		const result = parseCliArgs(["node", "hise-cli", "-wizard", "get", "compile_networks"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/wizard get compile_networks");
		}
	});

	it("parses -wizard run <id>", () => {
		const result = parseCliArgs(["node", "hise-cli", "-wizard", "run", "compile_networks"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/wizard run compile_networks");
		}
	});

	it("parses -wizard run <id> with K=V", () => {
		const result = parseCliArgs(
			["node", "hise-cli", "-wizard", "run", "compile_networks", "with", "Configuration=Release"],
			getCliCommands(),
		);
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/wizard run compile_networks with Configuration=Release");
		}
	});

	it("parses -wizard run <id> with K=V, K2=V2", () => {
		const result = parseCliArgs(
			["node", "hise-cli", "-wizard", "run", "plugin_export", "with", "Format=VST3,", "ExportType=Plugin"],
			getCliCommands(),
		);
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/wizard run plugin_export with Format=VST3, ExportType=Plugin");
		}
	});

	it("supports --mock flag", () => {
		const result = parseCliArgs(
			["node", "hise-cli", "-wizard", "run", "recompile", "--mock"],
			getCliCommands(),
		);
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.useMock).toBe(true);
			expect(result.canonicalCommand).toBe("/wizard run recompile");
		}
	});
});

describe("--run subcommand", () => {
	it("parses --run with file path", () => {
		const result = parseCliArgs(["node", "hise-cli", "--run", "test.hsc"], getCliCommands());
		expect(result.kind).toBe("run");
		if (result.kind === "run") {
			expect(result.source).toEqual({ type: "file", path: "test.hsc" });
			expect(result.dryRun).toBe(false);
			expect(result.useMock).toBe(false);
		}
	});

	it("parses --run with stdin", () => {
		const result = parseCliArgs(["node", "hise-cli", "--run", "-"], getCliCommands());
		expect(result.kind).toBe("run");
		if (result.kind === "run") {
			expect(result.source).toEqual({ type: "stdin" });
		}
	});

	it("parses --run with --inline", () => {
		const script = "/builder\nadd SineSynth\n/script\n/expect Engine.getSampleRate() is 44100";
		const result = parseCliArgs(["node", "hise-cli", "--run", "--inline", script], getCliCommands());
		expect(result.kind).toBe("run");
		if (result.kind === "run") {
			expect(result.source).toEqual({ type: "inline", content: script });
		}
	});

	it("supports --mock flag", () => {
		const result = parseCliArgs(["node", "hise-cli", "--run", "test.hsc", "--mock"], getCliCommands());
		expect(result.kind).toBe("run");
		if (result.kind === "run") {
			expect(result.useMock).toBe(true);
		}
	});

	it("supports --dry-run flag", () => {
		const result = parseCliArgs(["node", "hise-cli", "--run", "test.hsc", "--dry-run"], getCliCommands());
		expect(result.kind).toBe("run");
		if (result.kind === "run") {
			expect(result.dryRun).toBe(true);
		}
	});

	it("errors on --inline without content", () => {
		const result = parseCliArgs(["node", "hise-cli", "--run", "--inline"], getCliCommands());
		expect(result.kind).toBe("error");
	});

	it("errors on --run with no source", () => {
		const result = parseCliArgs(["node", "hise-cli", "--run"], getCliCommands());
		expect(result.kind).toBe("error");
	});

	it("accepts bare run (no dashes)", () => {
		const result = parseCliArgs(["node", "hise-cli", "run", "test.hsc"], getCliCommands());
		expect(result.kind).toBe("run");
	});

	it("demangles MSYS path conversion in --inline", () => {
		// Git-bash converts /script to C:/Program Files/Git/script
		const mangled = "C:/Program Files/Git/script\n/expect Engine.getSampleRate() is 44100";
		const result = parseCliArgs(["node", "hise-cli", "--run", "--inline", mangled], getCliCommands());
		expect(result.kind).toBe("run");
		if (result.kind === "run" && result.source.type === "inline") {
			expect(result.source.content).toBe("/script\n/expect Engine.getSampleRate() is 44100");
		}
	});
});

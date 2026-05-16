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

	it("parses direct builder add commands", () => {
		const result = parseCliArgs(["node", "hise-cli", "builder", "add", "--type", "LFO", "--id", "Shape", "--parent", "SineGenerator", "--chain", "Gain Modulation"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe('/builder add LFO as "Shape" to SineGenerator."Gain Modulation"');
		}
	});

	it("parses direct builder docs commands", () => {
		const result = parseCliArgs(["node", "hise-cli", "builder", "docs", "AHDSR.Attack"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/builder docs AHDSR.Attack");
		}
	});

	it("parses builder docs catalog commands", () => {
		const types = parseCliArgs(["node", "hise-cli", "builder", "docs"], getCliCommands());
		expect(types.kind).toBe("execute");
		if (types.kind === "execute") expect(types.canonicalCommand).toBe("/builder docs");
	});

	it("parses direct UI docs and live property commands", () => {
		const docs = parseCliArgs(["node", "hise-cli", "ui", "docs", "ScriptSlider.mode"], getCliCommands());
		expect(docs.kind).toBe("execute");
		if (docs.kind === "execute") expect(docs.canonicalCommand).toBe("/ui docs ScriptSlider.mode");

		const live = parseCliArgs(["node", "hise-cli", "ui", "show", "--component", "Cutoff", "--property", "mode"], getCliCommands());
		expect(live.kind).toBe("execute");
		if (live.kind === "execute") expect(live.canonicalCommand).toBe("/ui show Cutoff.mode");
	});

	it("parses UI docs catalog commands", () => {
		const types = parseCliArgs(["node", "hise-cli", "ui", "docs"], getCliCommands());
		expect(types.kind).toBe("execute");
		if (types.kind === "execute") expect(types.canonicalCommand).toBe("/ui docs");
	});

	it("parses direct DSP tree commands", () => {
		const result = parseCliArgs(["node", "hise-cli", "dsp", "tree", "--module", "Script FX1"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe('/dsp."Script FX1" show tree');
		}
	});

	it("parses direct DSP add commands with keyword node types", () => {
		const result = parseCliArgs(["node", "hise-cli", "dsp", "add", "--module", "GateModMathTest", "--type", "math.add", "--id", "InputLevel", "--agent"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe('/dsp.GateModMathTest add math.add as "InputLevel"');
			expect(result.output).toEqual({ json: true, agent: true, compact: true });
		}
	});

	it("parses direct DSP docs commands", () => {
		const result = parseCliArgs(["node", "hise-cli", "dsp", "docs", "filters.svf.Frequency"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/dsp docs filters.svf.Frequency");
		}
	});

	it("parses DSP docs catalog commands", () => {
		const types = parseCliArgs(["node", "hise-cli", "dsp", "docs"], getCliCommands());
		expect(types.kind).toBe("execute");
		if (types.kind === "execute") expect(types.canonicalCommand).toBe("/dsp docs");
	});

	it("parses leading DSP module flag before command", () => {
		const result = parseCliArgs(["node", "hise-cli", "dsp", "--module", "Interface", "docs", "filters.svf"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") expect(result.canonicalCommand).toBe("/dsp docs filters.svf");
	});

	it("parses direct script API and LAF docs commands", () => {
		const api = parseCliArgs(["node", "hise-cli", "script", "docs", "api", "Console.print"], getCliCommands());
		expect(api.kind).toBe("script-api");
		if (api.kind === "script-api" && api.command.action === "show") expect(api.command.raw).toBe("docs api Console.print");

		const laf = parseCliArgs(["node", "hise-cli", "script", "docs", "laf", "--component", "ScriptButton"], getCliCommands());
		expect(laf.kind).toBe("script-api");
		if (laf.kind === "script-api" && laf.command.action === "show") expect(laf.command.raw).toBe("docs laf --component ScriptButton");
	});

	it("rejects target on direct mode commands", () => {
		const result = parseCliArgs(["node", "hise-cli", "-dsp", "show", "tree", "--target"], getCliCommands());
		expect(result.kind).toBe("error");
		if (result.kind === "error") expect(result.message).toContain("dsp docs");
	});

	it("rejects missing one-shot tail for mode commands", () => {
		const result = parseCliArgs(["node", "hise-cli", "-script"], getCliCommands());
		expect(result).toEqual({
			kind: "error",
			message: "-script requires a one-shot command or expression",
		});
	});

	it("rejects direct builder stdin", () => {
		const result = parseCliArgs(["node", "hise-cli", "-builder", "--stdin"], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "builder direct commands do not support --stdin" });
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
			expect(result.query).toEqual({ type: "mode", modeId: "script", full: false });
			expect(result.output.json).toBe(true);
		}
	});

	it("parses full scoped agent-context mode queries", () => {
		const result = parseCliArgs(["node", "hise-cli", "agent-context", "script", "--full"], getCliCommands());
		expect(result.kind).toBe("agent-context");
		if (result.kind === "agent-context") {
			expect(result.query).toEqual({ type: "mode", modeId: "script", full: true });
		}
	});

	it("parses scoped agent-context command queries", () => {
		const result = parseCliArgs(["node", "hise-cli", "agent-context", "--command", "script.compile"], getCliCommands());
		expect(result.kind).toBe("agent-context");
		if (result.kind === "agent-context") {
			expect(result.query).toEqual({ type: "command", id: "script.compile" });
		}
	});

	it("parses scoped agent-context command equals queries", () => {
		const result = parseCliArgs(["node", "hise-cli", "agent-context", "--command=script.compile"], getCliCommands());
		expect(result.kind).toBe("agent-context");
		if (result.kind === "agent-context") {
			expect(result.query).toEqual({ type: "command", id: "script.compile" });
		}
	});

	it("parses agent-context command index queries", () => {
		const result = parseCliArgs(["node", "hise-cli", "agent-context", "--list-commands"], getCliCommands());
		expect(result.kind).toBe("agent-context");
		if (result.kind === "agent-context") {
			expect(result.query).toEqual({ type: "command-index" });
		}
	});

	it("rejects ambiguous agent-context queries", () => {
		const result = parseCliArgs(["node", "hise-cli", "agent-context", "script", "--command", "script.compile"], getCliCommands());
		expect(result).toEqual({
			kind: "error",
			message: "agent-context accepts only one query: <mode>, --command <id>, or --list-commands",
		});
	});

	it("rejects missing agent-context command ids", () => {
		const result = parseCliArgs(["node", "hise-cli", "agent-context", "--command"], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "--command requires an id" });
	});

	it("rejects unknown agent-context flags", () => {
		const result = parseCliArgs(["node", "hise-cli", "agent-context", "--unknown"], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "Unexpected argument for agent-context: --unknown" });
	});

	it("rejects full agent-context without mode", () => {
		const result = parseCliArgs(["node", "hise-cli", "agent-context", "--full"], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "agent-context --full requires a mode" });
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

	it("parses mcp tool calls with field flags", () => {
		const result = parseCliArgs(["node", "hise-cli", "mcp", "search_hise", "--query", "Content.addKnob", "--domain", "api", "--limit", "3", "--agent"], getCliCommands());
		expect(result.kind).toBe("mcp");
		if (result.kind === "mcp") {
			expect(result.command).toEqual({
				target: "search_hise",
				mode: "tool",
				argsSource: { type: "fields", fields: [
					{ key: "query", value: "Content.addKnob" },
					{ key: "domain", value: "api" },
					{ key: "limit", value: "3" },
				] },
			});
			expect(result.output).toEqual({ json: true, agent: true, compact: true });
		}
	});

	it("parses mcp raw methods with url and timeout", () => {
		const result = parseCliArgs(["node", "hise-cli", "mcp", "resources/read", "--uri", "hise://style-guides/hisescript-style", "--url", "http://localhost:4406/mcp", "--timeout", "180"], getCliCommands());
		expect(result.kind).toBe("mcp");
		if (result.kind === "mcp") {
			expect(result.command.mode).toBe("method");
			expect(result.command.url).toBe("http://localhost:4406/mcp");
			expect(result.command.timeoutMs).toBe(180000);
		}
	});

	it("parses mcp exact JSON args", () => {
		const result = parseCliArgs(["node", "hise-cli", "mcp", "explore_hise", "--args", '{"query":"sampler"}'], getCliCommands());
		expect(result.kind).toBe("mcp");
		if (result.kind === "mcp") {
			expect(result.command.argsSource).toEqual({ type: "inline", json: '{"query":"sampler"}' });
		}
	});

	it("rejects mixed mcp field and JSON args", () => {
		const result = parseCliArgs(["node", "hise-cli", "mcp", "explore_hise", "--query", "sampler", "--args", '{"query":"sampler"}'], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "mcp field flags cannot be combined with --args, --args-file, or --args-stdin" });
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

	it("parses direct builder dash namespace alias", () => {
		const result = parseCliArgs(["node", "hise-cli", "-builder", "tree"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/builder show tree");
			expect(result.stdin).toBe(false);
		}
	});

	it("parses dry-run for direct builder commands", () => {
		const result = parseCliArgs(["node", "hise-cli", "builder", "tree", "--dry-run"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/builder show tree");
			expect(result.dryRun).toBe(true);
		}
	});

	it("rejects direct builder stdin with command", () => {
		const result = parseCliArgs(["node", "hise-cli", "-builder", "--stdin", "show", "tree"], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "builder direct commands do not support --stdin" });
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

	it("rejects retired quoted builder DSL route", () => {
		const result = parseCliArgs(["node", "hise-cli", "-builder", "show tree"], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "Unknown builder command: show tree" });
	});

	it("rejects retired quoted builder DSL route preserved by Git Bash", () => {
		const result = parseCliArgs(["node", "hise-cli", "-builder", '"show tree"'], getCliCommands());
		expect(result).toEqual({ kind: "error", message: 'Unknown builder command: "show tree"' });
	});

	it("parses direct builder show parameter", () => {
		const result = parseCliArgs(["node", "hise-cli", "builder", "show", "--module", "Drive", "--param", "Gain"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/builder show Drive.Gain");
		}
	});

	it("parses direct builder dynamic set flags", () => {
		const result = parseCliArgs(["node", "hise-cli", "builder", "set", "--module", "Drive", "--Gain", "-6", "--Balance", "50"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/builder set Drive.Gain -6, Drive.Balance 50");
		}
	});

	it("parses direct UI connect component alias", () => {
		const result = parseCliArgs(["node", "hise-cli", "ui", "connect", "--component", "Cutoff", "--target", "MainFilter", "--param", "Frequency", "--matched"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/ui connect Cutoff to MainFilter.Frequency matched");
		}
	});

	it("parses direct UI screenshot flags", () => {
		const result = parseCliArgs(["node", "hise-cli", "ui", "screenshot", "--module", "Interface", "--component", "Cutoff", "--scale", "0.5", "--output", "images/cutoff.png"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe('/ui screenshot module Interface component Cutoff scale 0.5 output "images/cutoff.png"');
		}
	});

	it("parses direct UI dynamic property flags exactly", () => {
		const result = parseCliArgs(["node", "hise-cli", "ui", "set", "--component", "Knob", "--itemColour", "0xFFFFFFFF", "--fontSize", "14"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/ui set Knob.itemColour 0xFFFFFFFF, Knob.fontSize 14");
		}
	});

	it("parses direct UI parent and index property flags", () => {
		const parent = parseCliArgs(["node", "hise-cli", "ui", "set", "--component", "Cutoff", "--parent", "ControlsPanel"], getCliCommands());
		expect(parent.kind).toBe("execute");
		if (parent.kind === "execute") {
			expect(parent.canonicalCommand).toBe("/ui set Cutoff.parent ControlsPanel");
		}
		const parentComponent = parseCliArgs(["node", "hise-cli", "ui", "set", "--component", "Cutoff", "--parentComponent", "ControlsPanel"], getCliCommands());
		expect(parentComponent.kind).toBe("execute");
		if (parentComponent.kind === "execute") {
			expect(parentComponent.canonicalCommand).toBe("/ui set Cutoff.parent ControlsPanel");
		}
		const rootParent = parseCliArgs(["node", "hise-cli", "ui", "set", "--component", "Cutoff", "--parentComponent", "Content"], getCliCommands());
		expect(rootParent.kind).toBe("execute");
		if (rootParent.kind === "execute") {
			expect(rootParent.canonicalCommand).toBe('/ui set Cutoff.parent ""');
		}
		const namedRootParent = parseCliArgs(["node", "hise-cli", "ui", "set", "--component", "Cutoff", "--parentComponent", "root"], getCliCommands());
		expect(namedRootParent.kind).toBe("execute");
		if (namedRootParent.kind === "execute") {
			expect(namedRootParent.canonicalCommand).toBe('/ui set Cutoff.parent ""');
		}
		const index = parseCliArgs(["node", "hise-cli", "ui", "set", "--component", "Cutoff", "--index", "0"], getCliCommands());
		expect(index.kind).toBe("execute");
		if (index.kind === "execute") {
			expect(index.canonicalCommand).toBe("/ui set Cutoff.index 0");
		}
	});

	it("preserves kebab-case dynamic UI flags literally", () => {
		const result = parseCliArgs(["node", "hise-cli", "ui", "set", "--component", "Knob", "--item-colour", "0xFFFFFFFF"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/ui set Knob.item-colour 0xFFFFFFFF");
		}
	});

	it("parses direct DSP source parameter connect", () => {
		const result = parseCliArgs(["node", "hise-cli", "dsp", "connect", "--module", "Script FX1", "--source", "Root", "--source-param", "Cutoff", "--target", "F1", "--param", "Frequency"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe('/dsp."Script FX1" connect Root.Cutoff to F1.Frequency');
		}
	});

	it("parses direct DSP routing connect without parameter", () => {
		const result = parseCliArgs(["node", "hise-cli", "dsp", "connect", "--module", "Script FX1", "--source", "SEND", "--target", "RCV"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe('/dsp."Script FX1" connect SEND to RCV');
		}
	});

	it("parses direct DSP dynamic parameter flags exactly", () => {
		const result = parseCliArgs(["node", "hise-cli", "dsp", "set", "--module", "Script FX1", "--node", "F1", "--skewFactor", "0.3", "--middlePosition", "1000"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe('/dsp."Script FX1" set F1.skewFactor 0.3, F1.middlePosition 1000');
		}
	});

	it("parses direct DSP trace flags", () => {
		const result = parseCliArgs(["node", "hise-cli", "dsp", "trace", "--module", "Script FX1", "--container", "root", "--inject", "dirac", "--gain", "0.25", "--inject-before", "gain", "--probe-after", "delay", "--agent"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe('/dsp."Script FX1" trace root inject dirac gain 0.25 before "gain" probe after "delay"');
		}
	});

	it("parses direct DSP trace parameter probes", () => {
		const result = parseCliArgs(["node", "hise-cli", "dsp", "trace", "--module", "Script FX1", "--inject-param", "Root.Value=0.5", "--probe-param", "add.Value", "--probe-param", "mul.Value", "--trace-compact", "--no-specs"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe('/dsp."Script FX1" trace inject param Root.Value 0.5 probe param add.Value probe param mul.Value compact no_specs');
		}
	});

	it("rejects mutually exclusive direct DSP trace parameter probes", () => {
		const result = parseCliArgs(["node", "hise-cli", "dsp", "trace", "--module", "Script FX1", "--probe-changed-parameters", "--probe-param", "add.Value"], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "dsp trace accepts --probe-changed-parameters or --probe-param, not both" });
	});

	it("parses direct DSP parameter range metadata flags", () => {
		const range = parseCliArgs(["node", "hise-cli", "dsp", "set", "--module", "Script FX1", "--node", "F1", "--param", "Frequency", "--range", "20,20000"], getCliCommands());
		expect(range.kind).toBe("execute");
		if (range.kind === "execute") {
			expect(range.canonicalCommand).toBe('/dsp."Script FX1" set F1.Frequency.range [20,20000]');
		}

		const bracketed = parseCliArgs(["node", "hise-cli", "dsp", "set", "--module", "Script FX1", "--node", "F1", "--param", "Frequency", "--range", "[20,20000]"], getCliCommands());
		expect(bracketed.kind).toBe("execute");
		if (bracketed.kind === "execute") {
			expect(bracketed.canonicalCommand).toBe('/dsp."Script FX1" set F1.Frequency.range [20,20000]');
		}
	});

	it("parses combined direct DSP parameter metadata flags", () => {
		const result = parseCliArgs(["node", "hise-cli", "dsp", "set", "--module", "Script FX1", "--node", "F1", "--param", "Frequency", "--range", "20,20000", "--default", "1000", "--skewFactor", "0.3"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe('/dsp."Script FX1" set F1.Frequency.range [20,20000], F1.Frequency.default 1000, F1.Frequency.skewFactor 0.3');
		}
	});

	it("rejects invalid direct DSP parameter metadata flags", () => {
		const missingParam = parseCliArgs(["node", "hise-cli", "dsp", "set", "--module", "Script FX1", "--node", "F1", "--range", "20,20000"], getCliCommands());
		expect(missingParam).toEqual({ kind: "error", message: "dsp set parameter metadata flags require --param" });

		const exclusive = parseCliArgs(["node", "hise-cli", "dsp", "set", "--module", "Script FX1", "--node", "F1", "--param", "Frequency", "--middlePosition", "1000", "--skewFactor", "0.3"], getCliCommands());
		expect(exclusive).toEqual({ kind: "error", message: "dsp set accepts --middlePosition or --skewFactor, not both" });
	});

	it("rejects mutually exclusive DSP source qualifiers", () => {
		const result = parseCliArgs(["node", "hise-cli", "dsp", "connect", "--module", "Script FX1", "--source", "Root", "--source-param", "Cutoff", "--source-output", "0", "--target", "F1", "--param", "Frequency"], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "dsp connect accepts --source-param or --source-output, not both" });
	});

	it("rejects mutually exclusive UI source flags", () => {
		const result = parseCliArgs(["node", "hise-cli", "ui", "connect", "--source", "Cutoff", "--component", "Cutoff", "--target", "MainFilter", "--param", "Frequency"], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "ui connect accepts --source or --component, not both" });
	});

	it("parses direct builder remove repeats", () => {
		const result = parseCliArgs(["node", "hise-cli", "builder", "remove", "--module", "Drive2", "--module", "Drive3"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe("/builder remove Drive2, Drive3");
		}
	});

	it("parses direct builder routing and network commands", () => {
		const routing = parseCliArgs(["node", "hise-cli", "builder", "set", "--module", "Synth1", "--routing", "stereo", "--routing-send", "0,1"], getCliCommands());
		expect(routing.kind).toBe("execute");
		if (routing.kind === "execute") {
			expect(routing.canonicalCommand).toBe('/builder set Synth1.routing "stereo", Synth1.routing.send [0,1]');
		}
		const network = parseCliArgs(["node", "hise-cli", "builder", "set", "--module", "Script FX1", "--network", "my_dsp.xml"], getCliCommands());
		expect(network.kind).toBe("execute");
		if (network.kind === "execute") {
			expect(network.canonicalCommand).toBe('/builder set "Script FX1".network "my_dsp.xml"');
		}
		const bareNetwork = parseCliArgs(["node", "hise-cli", "builder", "set", "--module", "CabMicSelector", "--network", "cab_mic_selector"], getCliCommands());
		expect(bareNetwork.kind).toBe("execute");
		if (bareNetwork.kind === "execute") {
			expect(bareNetwork.canonicalCommand).toBe('/builder set CabMicSelector.network "cab_mic_selector"');
		}
	});

	it("parses direct builder move clone rename and reset commands", () => {
		const moveParent = parseCliArgs(["node", "hise-cli", "builder", "move", "--module", "Drive", "--parent", "Master Chain", "--chain", "fx"], getCliCommands());
		expect(moveParent.kind).toBe("execute");
		if (moveParent.kind === "execute") expect(moveParent.canonicalCommand).toBe('/builder set Drive.parent "Master Chain".fx');
		const moveIndex = parseCliArgs(["node", "hise-cli", "builder", "move", "--module", "Drive", "--index", "0"], getCliCommands());
		expect(moveIndex.kind).toBe("execute");
		if (moveIndex.kind === "execute") expect(moveIndex.canonicalCommand).toBe("/builder set Drive.index 0");
		const clone = parseCliArgs(["node", "hise-cli", "builder", "clone", "--module", "Drive", "--count", "2"], getCliCommands());
		expect(clone.kind).toBe("execute");
		if (clone.kind === "execute") expect(clone.canonicalCommand).toBe("/builder clone Drive 2");
		const rename = parseCliArgs(["node", "hise-cli", "builder", "rename", "--module", "Drive", "--id", "Drive2"], getCliCommands());
		expect(rename.kind).toBe("execute");
		if (rename.kind === "execute") expect(rename.canonicalCommand).toBe('/builder rename Drive as "Drive2"');
		const reset = parseCliArgs(["node", "hise-cli", "builder", "reset"], getCliCommands());
		expect(reset.kind).toBe("execute");
		if (reset.kind === "execute") expect(reset.canonicalCommand).toBe("/builder reset");
	});

	it("parses direct UI show add rename and remove commands", () => {
		const show = parseCliArgs(["node", "hise-cli", "ui", "show", "--component", "Cutoff"], getCliCommands());
		expect(show.kind).toBe("execute");
		if (show.kind === "execute") expect(show.canonicalCommand).toBe("/ui show Cutoff");
		const add = parseCliArgs(["node", "hise-cli", "ui", "add", "--type", "ScriptSlider", "--id", "Cutoff", "--parent", "ControlsPanel"], getCliCommands());
		expect(add.kind).toBe("execute");
		if (add.kind === "execute") expect(add.canonicalCommand).toBe('/ui add ScriptSlider as "Cutoff" to ControlsPanel');
		const rootAdd = parseCliArgs(["node", "hise-cli", "ui", "add", "--type", "ScriptSlider", "--id", "Cutoff", "--parent", "Content"], getCliCommands());
		expect(rootAdd.kind).toBe("execute");
		if (rootAdd.kind === "execute") expect(rootAdd.canonicalCommand).toBe('/ui add ScriptSlider as "Cutoff"');
		const namedRootAdd = parseCliArgs(["node", "hise-cli", "ui", "add", "--type", "ScriptSlider", "--id", "Cutoff", "--parent", "root"], getCliCommands());
		expect(namedRootAdd.kind).toBe("execute");
		if (namedRootAdd.kind === "execute") expect(namedRootAdd.canonicalCommand).toBe('/ui add ScriptSlider as "Cutoff"');
		const rename = parseCliArgs(["node", "hise-cli", "ui", "rename", "--component", "Cutoff", "--id", "CutoffSlider"], getCliCommands());
		expect(rename.kind).toBe("execute");
		if (rename.kind === "execute") expect(rename.canonicalCommand).toBe('/ui rename Cutoff as "CutoffSlider"');
		const remove = parseCliArgs(["node", "hise-cli", "ui", "remove", "--component", "A", "--component", "B"], getCliCommands());
		expect(remove.kind).toBe("execute");
		if (remove.kind === "execute") expect(remove.canonicalCommand).toBe("/ui remove A, B");
	});

	it("parses direct DSP types show add source-output rename remove and save commands", () => {
		const types = parseCliArgs(["node", "hise-cli", "dsp", "docs", "filter"], getCliCommands());
		expect(types.kind).toBe("execute");
		if (types.kind === "execute") expect(types.canonicalCommand).toBe("/dsp docs filter");
		const show = parseCliArgs(["node", "hise-cli", "dsp", "show", "--module", "Script FX1", "--node", "F1"], getCliCommands());
		expect(show.kind).toBe("execute");
		if (show.kind === "execute") expect(show.canonicalCommand).toBe('/dsp."Script FX1" show F1');
		const add = parseCliArgs(["node", "hise-cli", "dsp", "add", "--module", "Script FX1", "--type", "core.filter", "--id", "F1", "--parent", "root"], getCliCommands());
		expect(add.kind).toBe("execute");
		if (add.kind === "execute") expect(add.canonicalCommand).toBe('/dsp."Script FX1" add core.filter as "F1" to root');
		const connect = parseCliArgs(["node", "hise-cli", "dsp", "connect", "--module", "Script FX1", "--source", "MultiOut", "--source-output", "0", "--target", "F1", "--param", "Frequency", "--matched"], getCliCommands());
		expect(connect.kind).toBe("execute");
		if (connect.kind === "execute") expect(connect.canonicalCommand).toBe('/dsp."Script FX1" connect MultiOut.0 to F1.Frequency matched');
		const rename = parseCliArgs(["node", "hise-cli", "dsp", "rename", "--module", "Script FX1", "--node", "F1", "--id", "Filter1"], getCliCommands());
		expect(rename.kind).toBe("execute");
		if (rename.kind === "execute") expect(rename.canonicalCommand).toBe('/dsp."Script FX1" rename F1 as "Filter1"');
		const remove = parseCliArgs(["node", "hise-cli", "dsp", "remove", "--module", "Script FX1", "--node", "F1", "--node", "F2"], getCliCommands());
		expect(remove.kind).toBe("execute");
		if (remove.kind === "execute") expect(remove.canonicalCommand).toBe('/dsp."Script FX1" remove F1, F2');
		const save = parseCliArgs(["node", "hise-cli", "dsp", "save", "--module", "Script FX1"], getCliCommands());
		expect(save.kind).toBe("execute");
		if (save.kind === "execute") expect(save.canonicalCommand).toBe('/dsp."Script FX1" save');
	});

	it("rejects missing direct builder flags", () => {
		const result = parseCliArgs(["node", "hise-cli", "builder", "add", "--type", "SimpleGain"], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "--id is required" });
	});

	it("parses direct UI bounds shorthand", () => {
		const result = parseCliArgs(["node", "hise-cli", "ui", "set", "--component", "Cutoff", "--bounds", "0,0,128,32", "--text", "My Cutoff"], getCliCommands());
		expect(result.kind).toBe("execute");
		if (result.kind === "execute") {
			expect(result.canonicalCommand).toBe('/ui set Cutoff.bounds [0,0,128,32], Cutoff.text "My Cutoff"');
		}
	});

	it("rejects missing direct DSP module", () => {
		const result = parseCliArgs(["node", "hise-cli", "dsp", "tree"], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "--module is required" });
	});

	it("rejects retired single-quoted builder DSL route", () => {
		const result = parseCliArgs(["node", "hise-cli", "-builder", "'show tree'"], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "Unknown builder command: 'show tree'" });
	});

	it("rejects retired freeform builder DSL route", () => {
		const result = parseCliArgs(["node", "hise-cli", "-builder", 'add "MyGain"'], getCliCommands());
		expect(result).toEqual({ kind: "error", message: 'Unknown builder command: add "MyGain"' });
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
			expect(result.command.rollback).toBe(true);
			expect(result.command.source).toEqual({ type: "stdin" });
		}
	});

	it("parses script set file with --no-compile", () => {
		const result = parseCliArgs(["node", "hise-cli", "script", "set", "--callback", "onInit", "--file", "onInit.js", "--no-compile"], getCliCommands());
		expect(result.kind).toBe("script-api");
		if (result.kind === "script-api" && result.command.action === "set") {
			expect(result.command.compile).toBe(false);
			expect(result.command.rollback).toBe(false);
			expect(result.command.source).toEqual({ type: "file", path: "onInit.js" });
		}
	});

	it("parses script set with --no-rollback", () => {
		const result = parseCliArgs(["node", "hise-cli", "script", "set", "--callback", "onInit", "--stdin", "--no-rollback"], getCliCommands());
		expect(result.kind).toBe("script-api");
		if (result.kind === "script-api" && result.command.action === "set") {
			expect(result.command.compile).toBe(true);
			expect(result.command.rollback).toBe(false);
		}
	});

	it("parses script diagnose", () => {
		const result = parseCliArgs(["node", "hise-cli", "script", "diagnose", "--module-id", "Interface", "--file-path", "Scripts/UI.js", "--async"], getCliCommands());
		expect(result.kind).toBe("script-api");
		if (result.kind === "script-api") {
			expect(result.command).toEqual({ action: "diagnose", moduleId: "Interface", filePath: "Scripts/UI.js", async: true });
		}
	});

	it("parses script add-file", () => {
		const result = parseCliArgs(["node", "hise-cli", "script", "add-file", "relativePath/MyFile.js", "--module-id", "Interface"], getCliCommands());
		expect(result.kind).toBe("script-api");
		if (result.kind === "script-api") {
			expect(result.command).toEqual({ action: "add-file", moduleId: "Interface", relativePath: "relativePath/MyFile.js" });
		}
	});

	it("rejects script add-file without one path", () => {
		const result = parseCliArgs(["node", "hise-cli", "script", "add-file"], getCliCommands());
		expect(result).toEqual({ kind: "error", message: "script add-file requires exactly one relative path" });
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

	it("supports --to-cli flag", () => {
		const result = parseCliArgs(["node", "hise-cli", "run", "--to-cli", "test.hsc"], getCliCommands());
		expect(result.kind).toBe("run");
		if (result.kind === "run") {
			expect(result.source).toEqual({ type: "file", path: "test.hsc" });
			expect(result.toCli).toBe(true);
		}
	});

	it("rejects --to-cli with runtime flags", () => {
		expect(parseCliArgs(["node", "hise-cli", "run", "--to-cli", "test.hsc", "--watch"], getCliCommands())).toEqual({ kind: "error", message: "--to-cli cannot be used with --watch" });
		expect(parseCliArgs(["node", "hise-cli", "run", "--to-cli", "test.hsc", "--dry-run"], getCliCommands())).toEqual({ kind: "error", message: "--to-cli cannot be used with --dry-run" });
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

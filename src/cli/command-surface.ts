export type CommandSurfaceMode = "builder" | "ui" | "dsp";

export interface CommandSurfaceEntry {
	readonly mode: CommandSurfaceMode;
	readonly id: string;
	readonly verb: string;
	readonly variant?: string;
	readonly parserExample?: string;
	readonly directCli?: {
		readonly argv: readonly string[];
		readonly canonical: string;
	};
	readonly yamlId?: string;
	readonly exceptionReason?: string;
}

export const commandSurface: readonly CommandSurfaceEntry[] = [
	// Builder direct command surface.
	{ mode: "builder", id: "builder.show.tree", verb: "show", variant: "tree", parserExample: "show tree", directCli: { argv: ["builder", "tree"], canonical: "/builder show tree" }, yamlId: "builder.show.tree" },
	{ mode: "builder", id: "builder.docs.catalog", verb: "docs", variant: "catalog", directCli: { argv: ["builder", "docs"], canonical: "/builder docs" }, yamlId: "builder.show.types" },
	{ mode: "builder", id: "builder.docs.type", verb: "docs", variant: "type", directCli: { argv: ["builder", "docs", "AHDSR.Attack"], canonical: "/builder docs AHDSR.Attack" }, yamlId: "builder.show.type" },
	{ mode: "builder", id: "builder.show.module", verb: "show", variant: "module", parserExample: "show Drive", directCli: { argv: ["builder", "show", "--module", "Drive"], canonical: "/builder show Drive" }, yamlId: "builder.show.module" },
	{ mode: "builder", id: "builder.show.parameter", verb: "show", variant: "parameter", parserExample: "show Drive.Gain", directCli: { argv: ["builder", "show", "--module", "Drive", "--param", "Gain"], canonical: "/builder show Drive.Gain" }, yamlId: "builder.show.parameter" },
	{ mode: "builder", id: "builder.add.module", verb: "add", parserExample: "add SimpleGain as \"Drive\"", directCli: { argv: ["builder", "add", "--type", "SimpleGain", "--id", "Drive"], canonical: "/builder add SimpleGain as \"Drive\"" }, yamlId: "builder.add.module" },
	{ mode: "builder", id: "builder.set.parameter", verb: "set", variant: "parameter", parserExample: "set Drive.Gain -6", directCli: { argv: ["builder", "set", "--module", "Drive", "--param", "Gain", "--value", "-6"], canonical: "/builder set Drive.Gain -6" }, yamlId: "builder.set.parameter" },
	{ mode: "builder", id: "builder.set.bypassed", verb: "set", variant: "bypassed", parserExample: "set Drive.bypassed true", directCli: { argv: ["builder", "set", "--module", "Drive", "--bypassed", "true"], canonical: "/builder set Drive.bypassed true" }, yamlId: "builder.set.bypassed" },
	{ mode: "builder", id: "builder.set.routing", verb: "set", variant: "routing", parserExample: "set Synth1.routing [0, 1, -1, -1]", directCli: { argv: ["builder", "set", "--module", "Synth1", "--routing", "[0,1,-1,-1]"], canonical: "/builder set Synth1.routing [0,1,-1,-1]" }, yamlId: "builder.set.routing" },
	{ mode: "builder", id: "builder.set.network", verb: "set", variant: "network", parserExample: "set \"Script FX1\".network \"my_dsp\"", directCli: { argv: ["builder", "set", "--module", "Script FX1", "--network", "my_dsp"], canonical: "/builder set \"Script FX1\".network \"my_dsp\"" }, yamlId: "builder.set.network" },
	{ mode: "builder", id: "builder.move.parent", verb: "set", variant: "parent", parserExample: "set Drive.parent \"Master Chain\".fx", directCli: { argv: ["builder", "move", "--module", "Drive", "--parent", "Master Chain", "--chain", "fx"], canonical: "/builder set Drive.parent \"Master Chain\".fx" }, yamlId: "builder.move.parent" },
	{ mode: "builder", id: "builder.move.index", verb: "set", variant: "index", parserExample: "set Drive.index 0", directCli: { argv: ["builder", "move", "--module", "Drive", "--index", "0"], canonical: "/builder set Drive.index 0" }, yamlId: "builder.move.index" },
	{ mode: "builder", id: "builder.get.parameter", verb: "get", parserExample: "get Drive.Gain", directCli: { argv: ["builder", "get", "--module", "Drive", "--param", "Gain"], canonical: "/builder get Drive.Gain" }, yamlId: "builder.get.parameter" },
	{ mode: "builder", id: "builder.clone.module", verb: "clone", parserExample: "clone Drive 2", directCli: { argv: ["builder", "clone", "--module", "Drive", "--count", "2"], canonical: "/builder clone Drive 2" }, yamlId: "builder.clone.module" },
	{ mode: "builder", id: "builder.rename.module", verb: "rename", parserExample: "rename Drive as \"Drive2\"", directCli: { argv: ["builder", "rename", "--module", "Drive", "--id", "Drive2"], canonical: "/builder rename Drive as \"Drive2\"" }, yamlId: "builder.rename.module" },
	{ mode: "builder", id: "builder.remove.module", verb: "remove", parserExample: "remove Drive", directCli: { argv: ["builder", "remove", "--module", "Drive"], canonical: "/builder remove Drive" }, yamlId: "builder.remove.module" },
	{ mode: "builder", id: "builder.reset", verb: "reset", parserExample: "reset", directCli: { argv: ["builder", "reset"], canonical: "/builder reset" }, yamlId: "builder.reset" },
	{ mode: "builder", id: "builder.cd", verb: "cd", parserExample: "cd Drive", exceptionReason: "modal navigation only" },
	{ mode: "builder", id: "builder.ls", verb: "ls", parserExample: "ls", exceptionReason: "modal navigation only" },
	{ mode: "builder", id: "builder.pwd", verb: "pwd", parserExample: "pwd", exceptionReason: "modal navigation only" },

	// UI direct command surface.
	{ mode: "ui", id: "ui.show.tree", verb: "show", variant: "tree", parserExample: "show tree", directCli: { argv: ["ui", "tree"], canonical: "/ui show tree" }, yamlId: "ui.show.tree" },
	{ mode: "ui", id: "ui.show.component", verb: "show", variant: "component", parserExample: "show Cutoff", directCli: { argv: ["ui", "show", "--component", "Cutoff"], canonical: "/ui show Cutoff" }, yamlId: "ui.show.component" },
	{ mode: "ui", id: "ui.docs.catalog", verb: "docs", variant: "catalog", directCli: { argv: ["ui", "docs"], canonical: "/ui docs" }, yamlId: "ui.show.types" },
	{ mode: "ui", id: "ui.docs.type", verb: "docs", variant: "type", directCli: { argv: ["ui", "docs", "ScriptSlider.mode"], canonical: "/ui docs ScriptSlider.mode" }, yamlId: "ui.show.type" },
	{ mode: "ui", id: "ui.add.component", verb: "add", parserExample: "add ScriptSlider as \"Cutoff\"", directCli: { argv: ["ui", "add", "--type", "ScriptSlider", "--id", "Cutoff"], canonical: "/ui add ScriptSlider as \"Cutoff\"" }, yamlId: "ui.add.component" },
	{ mode: "ui", id: "ui.set.properties", verb: "set", parserExample: "set Cutoff.text Cutoff", directCli: { argv: ["ui", "set", "--component", "Cutoff", "--text", "Cutoff"], canonical: "/ui set Cutoff.text Cutoff" }, yamlId: "ui.set.properties" },
	{ mode: "ui", id: "ui.get.property", verb: "get", parserExample: "get Cutoff.text", directCli: { argv: ["ui", "get", "--component", "Cutoff", "--property", "text"], canonical: "/ui get Cutoff.text" }, yamlId: "ui.get.property" },
	{ mode: "ui", id: "ui.connect.control", verb: "connect", parserExample: "connect Cutoff to MainFilter.Frequency matched", directCli: { argv: ["ui", "connect", "--source", "Cutoff", "--target", "MainFilter", "--param", "Frequency", "--matched"], canonical: "/ui connect Cutoff to MainFilter.Frequency matched" }, yamlId: "ui.connect.control" },
	{ mode: "ui", id: "ui.screenshot", verb: "screenshot", directCli: { argv: ["ui", "screenshot", "--component", "Cutoff", "--scale", "0.5", "--output", "images/cutoff.png"], canonical: "/ui screenshot component Cutoff scale 0.5 output \"images/cutoff.png\"" }, yamlId: "ui.screenshot" },
	{ mode: "ui", id: "ui.rename.component", verb: "rename", parserExample: "rename Cutoff as \"CutoffSlider\"", directCli: { argv: ["ui", "rename", "--component", "Cutoff", "--id", "CutoffSlider"], canonical: "/ui rename Cutoff as \"CutoffSlider\"" }, yamlId: "ui.rename.component" },
	{ mode: "ui", id: "ui.remove.component", verb: "remove", parserExample: "remove Cutoff", directCli: { argv: ["ui", "remove", "--component", "Cutoff"], canonical: "/ui remove Cutoff" }, yamlId: "ui.remove.component" },
	{ mode: "ui", id: "ui.reset", verb: "reset", parserExample: "reset", exceptionReason: "destructive modal command intentionally hidden from direct CLI and YAML" },
	{ mode: "ui", id: "ui.cd", verb: "cd", parserExample: "cd Panel", exceptionReason: "modal navigation only" },
	{ mode: "ui", id: "ui.ls", verb: "ls", parserExample: "ls", exceptionReason: "modal navigation only" },
	{ mode: "ui", id: "ui.pwd", verb: "pwd", parserExample: "pwd", exceptionReason: "modal navigation only" },

	// DSP direct command surface.
	{ mode: "dsp", id: "dsp.show.tree", verb: "show", variant: "tree", parserExample: "show tree", directCli: { argv: ["dsp", "tree", "--module", "Script FX1"], canonical: "/dsp.\"Script FX1\" show tree" }, yamlId: "dsp.show.tree" },
	{ mode: "dsp", id: "dsp.show.node", verb: "show", variant: "node", parserExample: "show g1", directCli: { argv: ["dsp", "show", "--module", "Script FX1", "--node", "g1"], canonical: "/dsp.\"Script FX1\" show g1" }, yamlId: "dsp.show.node" },
	{ mode: "dsp", id: "dsp.show.networks", verb: "show", variant: "networks", parserExample: "show networks", directCli: { argv: ["dsp", "networks", "--module", "Script FX1"], canonical: "/dsp.\"Script FX1\" show networks" }, yamlId: "dsp.show.networks" },
	{ mode: "dsp", id: "dsp.show.modules", verb: "show", variant: "modules", parserExample: "show modules", directCli: { argv: ["dsp", "modules", "--module", "Script FX1"], canonical: "/dsp.\"Script FX1\" show modules" }, yamlId: "dsp.show.modules" },
	{ mode: "dsp", id: "dsp.show.connections", verb: "show", variant: "connections", parserExample: "show connections", directCli: { argv: ["dsp", "connections", "--module", "Script FX1"], canonical: "/dsp.\"Script FX1\" show connections" }, yamlId: "dsp.show.connections" },
	{ mode: "dsp", id: "dsp.docs.catalog", verb: "docs", variant: "catalog", directCli: { argv: ["dsp", "docs"], canonical: "/dsp docs" }, yamlId: "dsp.show.types" },
	{ mode: "dsp", id: "dsp.docs.type", verb: "docs", variant: "type", directCli: { argv: ["dsp", "docs", "filters.svf.Frequency"], canonical: "/dsp docs filters.svf.Frequency" }, yamlId: "dsp.show.type" },
	{ mode: "dsp", id: "dsp.add.node", verb: "add", parserExample: "add core.gain as \"g1\"", directCli: { argv: ["dsp", "add", "--module", "Script FX1", "--type", "core.gain", "--id", "g1"], canonical: "/dsp.\"Script FX1\" add core.gain as \"g1\"" }, yamlId: "dsp.add.node" },
	{ mode: "dsp", id: "dsp.set.parameter", verb: "set", parserExample: "set g1.Gain 1", directCli: { argv: ["dsp", "set", "--module", "Script FX1", "--node", "g1", "--param", "Gain", "--value", "1"], canonical: "/dsp.\"Script FX1\" set g1.Gain 1" }, yamlId: "dsp.set.parameter" },
	{ mode: "dsp", id: "dsp.set.parameterRange", verb: "set", variant: "parameter-range", parserExample: "set g1.Gain.range [0, 2]", directCli: { argv: ["dsp", "set", "--module", "Script FX1", "--node", "g1", "--param", "Gain", "--range", "0,2"], canonical: "/dsp.\"Script FX1\" set g1.Gain.range [0,2]" }, yamlId: "dsp.set.parameterRange" },
	{ mode: "dsp", id: "dsp.move.parent", verb: "set", variant: "parent", parserExample: "set g1.parent root", directCli: { argv: ["dsp", "set", "--module", "Script FX1", "--node", "g1", "--parent", "root"], canonical: "/dsp.\"Script FX1\" set g1.parent root" }, yamlId: "dsp.move.parent" },
	{ mode: "dsp", id: "dsp.move.index", verb: "set", variant: "index", parserExample: "set g1.index 0", directCli: { argv: ["dsp", "set", "--module", "Script FX1", "--node", "g1", "--index", "0"], canonical: "/dsp.\"Script FX1\" set g1.index 0" }, yamlId: "dsp.move.index" },
	{ mode: "dsp", id: "dsp.get.parameter", verb: "get", parserExample: "get g1.Gain", directCli: { argv: ["dsp", "get", "--module", "Script FX1", "--node", "g1", "--param", "Gain"], canonical: "/dsp.\"Script FX1\" get g1.Gain" }, yamlId: "dsp.get.parameter" },
	{ mode: "dsp", id: "dsp.connect.node", verb: "connect", parserExample: "connect lfo1 to g1.Gain matched", directCli: { argv: ["dsp", "connect", "--module", "Script FX1", "--source", "lfo1", "--target", "g1", "--param", "Gain", "--matched"], canonical: "/dsp.\"Script FX1\" connect lfo1 to g1.Gain matched" }, yamlId: "dsp.connect.node" },
	{ mode: "dsp", id: "dsp.disconnect.node", verb: "disconnect", parserExample: "disconnect g1.Gain", directCli: { argv: ["dsp", "disconnect", "--module", "Script FX1", "--target", "g1.Gain"], canonical: "/dsp.\"Script FX1\" disconnect g1.Gain" }, yamlId: "dsp.disconnect.node" },
	{ mode: "dsp", id: "dsp.create_parameter", verb: "create_parameter", parserExample: "create_parameter root.Cutoff [20, 20000] default 1000 skewFactor 0.3", directCli: { argv: ["dsp", "create_parameter", "--module", "Script FX1", "--container", "root", "--id", "Cutoff", "--range", "20,20000", "--default", "1000", "--skewFactor", "0.3"], canonical: "/dsp.\"Script FX1\" create_parameter root.Cutoff [20,20000] default 1000 skewFactor 0.3" }, yamlId: "dsp.create_parameter" },
	{ mode: "dsp", id: "dsp.screenshot", verb: "screenshot", parserExample: "screenshot scale 50% file \"patch.png\"", directCli: { argv: ["dsp", "screenshot", "--module", "Script FX1", "--scale", "50%", "--output", "patch.png"], canonical: "/dsp.\"Script FX1\" screenshot scale 50% file \"patch.png\"" }, yamlId: "dsp.screenshot" },
	{ mode: "dsp", id: "dsp.rename.node", verb: "rename", parserExample: "rename g1 as \"Gain1\"", directCli: { argv: ["dsp", "rename", "--module", "Script FX1", "--node", "g1", "--id", "Gain1"], canonical: "/dsp.\"Script FX1\" rename g1 as \"Gain1\"" }, yamlId: "dsp.rename.node" },
	{ mode: "dsp", id: "dsp.remove.node", verb: "remove", parserExample: "remove g1", directCli: { argv: ["dsp", "remove", "--module", "Script FX1", "--node", "g1"], canonical: "/dsp.\"Script FX1\" remove g1" }, yamlId: "dsp.remove.node" },
	{ mode: "dsp", id: "dsp.save.network", verb: "save", parserExample: "save", directCli: { argv: ["dsp", "save", "--module", "Script FX1"], canonical: "/dsp.\"Script FX1\" save" }, yamlId: "dsp.save.network" },
	{ mode: "dsp", id: "dsp.reset", verb: "reset", parserExample: "reset", directCli: { argv: ["dsp", "reset", "--module", "Script FX1"], canonical: "/dsp.\"Script FX1\" reset" }, yamlId: "dsp.reset" },
	{ mode: "dsp", id: "dsp.cd", verb: "cd", parserExample: "cd g1", exceptionReason: "modal navigation only" },
	{ mode: "dsp", id: "dsp.ls", verb: "ls", parserExample: "ls", exceptionReason: "modal navigation only" },
	{ mode: "dsp", id: "dsp.pwd", verb: "pwd", parserExample: "pwd", exceptionReason: "modal navigation only" },
] as const;

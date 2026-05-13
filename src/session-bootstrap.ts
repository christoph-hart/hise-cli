import type { DataLoader, ModuleList, PreprocessorList, ScriptingApi, ScriptnodeList } from "./engine/data.js";
import type { HiseConnection } from "./engine/hise.js";
import { CompletionEngine } from "./engine/completion/engine.js";
import { Session } from "./engine/session.js";
import { BuilderMode } from "./engine/modes/builder.js";
import { DspMode } from "./engine/modes/dsp.js";
import { InspectMode } from "./engine/modes/inspect.js";
import { ProjectMode } from "./engine/modes/project.js";
import { ScriptMode } from "./engine/modes/script.js";
import { UndoMode } from "./engine/modes/undo.js";
import { UiMode, type ComponentPropertyMap } from "./engine/modes/ui.js";
import { SequenceMode } from "./engine/modes/sequence.js";
import { HiseMode, type HiseLauncher } from "./engine/modes/hise.js";
import { AnalyseMode } from "./engine/modes/analyse.js";
import { PublishMode } from "./engine/modes/publish.js";
import { AssetsMode } from "./engine/modes/assets.js";
import { ApiMode } from "./engine/modes/api.js";
import { McpMode } from "./engine/modes/mcp.js";
import type { McpClient } from "./engine/mcp/types.js";
import type { AssetEnvironment } from "./engine/assets/environment.js";
import { WizardRegistry } from "./engine/wizard/registry.js";
import type { WizardHandlerRegistry } from "./engine/wizard/handler-registry.js";
import { registerWizardAliases } from "./engine/commands/slash.js";
import { createProvider } from "./engine/llm/index.js";
import { renderCliHelp } from "./cli/help.js";

export const SUPPORTED_MODE_IDS = ["script", "inspect", "builder", "dsp", "project", "undo", "ui", "sequence", "hise", "analyse", "publish", "assets", "api", "mcp"] as const;

export interface CreateSessionOptions {
	connection: HiseConnection | null;
	completionEngine?: CompletionEngine;
	getModuleList?: () => ModuleList | undefined;
	getScriptnodeList?: () => ScriptnodeList | undefined;
	getComponentProperties?: () => ComponentPropertyMap | undefined;
	getPreprocessorList?: () => PreprocessorList | undefined;
	getScriptingApi?: () => ScriptingApi | undefined;
	/** When true, the session is treated as an LLM/CLI consumer:
	 *  - `/api` mode renders `llmRef` instead of the terse human description
	 *  - `show tree` (builder/ui/dsp) returns the raw HISE JSON instead of an
	 *    ASCII tree
	 *  CLI/agent route sets this. */
	forLlm?: boolean;
	handlerRegistry?: WizardHandlerRegistry;
	launcher?: HiseLauncher;
	/** Asset environment for the `/assets` mode. Optional — when absent, the
	 *  mode reports unavailability. Wired by node platform glue (Phase 4). */
	assetEnvironment?: AssetEnvironment;
	mcpClient?: McpClient;
	/** Host process working directory. Used by `/project switch ./` etc.
	 *  Defaults to `process.cwd()` when running on Node. */
	cwd?: string;
	/** When true (default), wires `session.llmProvider` (Ollama qwen3.5:9b) and
	 *  `session.getHelpText` so `?<NL>` script lines and the TUI ?-prefix can
	 *  resolve via the LLM intent pipeline. Set false to opt out (e.g.,
	 *  unit tests that never need AI). */
	enableLlm?: boolean;
}

export function createSession({
	connection,
	completionEngine = new CompletionEngine(),
	getModuleList,
	getScriptnodeList,
	getComponentProperties,
	getPreprocessorList,
	getScriptingApi,
	forLlm,
	handlerRegistry,
	launcher,
	assetEnvironment,
	mcpClient,
	cwd,
	enableLlm,
}: CreateSessionOptions): { session: Session; completionEngine: CompletionEngine } {
	const session = new Session(connection, completionEngine);
	session.mcpClient = mcpClient ?? null;
	if (handlerRegistry) session.handlerRegistry = handlerRegistry;
	session.forLlm = forLlm ?? false;
	session.cwd = cwd ?? (typeof process !== "undefined" && typeof process.cwd === "function" ? process.cwd() : null);
	if (getModuleList) session.getModuleList = getModuleList;
	if (getComponentProperties) session.getComponentProperties = getComponentProperties;
	session.registerMode("script", (ctx) => new ScriptMode(ctx, completionEngine, getScriptingApi?.() ?? null));
	session.registerMode("inspect", () => new InspectMode(completionEngine));
	session.registerMode(
		"project",
		() => new ProjectMode(completionEngine, getPreprocessorList?.() ?? null),
	);
	session.registerMode(
		"builder",
		(ctx) => new BuilderMode(getModuleList?.(), completionEngine, ctx),
	);
	session.registerMode(
		"dsp",
		(ctx) => new DspMode(getScriptnodeList?.(), completionEngine, ctx),
	);
	session.registerMode("undo", () => new UndoMode(completionEngine));
	session.registerMode(
		"ui",
		(ctx) => new UiMode(completionEngine, ctx, getComponentProperties?.()),
	);
	session.registerMode("sequence", () => new SequenceMode(completionEngine));
	session.registerMode("hise", () => new HiseMode(launcher ?? null, completionEngine));
	session.registerMode("analyse", () => new AnalyseMode(completionEngine));
	session.registerMode("publish", () => new PublishMode());
	session.registerMode("assets", () => new AssetsMode(assetEnvironment ?? null, completionEngine));
	session.registerMode("api", () => new ApiMode(getScriptingApi?.(), { forLlm: forLlm ?? false }));
	session.registerMode("mcp", () => new McpMode(mcpClient ?? null));

	if (enableLlm !== false) {
		session.llmProvider = createProvider({ kind: "ollama", model: "qwen3.5:9b", think: false });
		session.getHelpText = (scope: string) => renderCliHelp([], scope);
	}

	return { session, completionEngine };
}

export interface SessionDatasets {
	moduleList?: ModuleList;
	scriptnodeList?: ScriptnodeList;
	componentProperties?: ComponentPropertyMap;
	preprocessorList?: PreprocessorList;
	scriptingApi?: ScriptingApi;
}

export async function loadSessionDatasets(
	dataLoader: DataLoader | null | undefined,
	completionEngine: CompletionEngine,
	session?: Session,
): Promise<SessionDatasets> {
	if (!dataLoader) return {};
	await completionEngine.init(dataLoader);

	// Load wizard definitions from YAML
	if (session) {
		try {
			const wizardDefs = await dataLoader.loadWizardDefinitions();
			session.wizardRegistry = WizardRegistry.fromDefinitions(wizardDefs);
			registerWizardAliases(session.registry, session.wizardRegistry);
			// Refresh completion engine with newly registered alias commands
			if (completionEngine) {
				completionEngine.setSlashCommands(session.registry.all());
			}
		} catch (err) {
			console.error(`[wizard] Failed to load wizard definitions: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const result: SessionDatasets = {};

	try {
		result.moduleList = await dataLoader.loadModuleList();
	} catch {
		// moduleList not available
	}

	try {
		result.scriptnodeList = await dataLoader.loadScriptnodeList();
	} catch {
		// scriptnodeList not available
	}

	try {
		result.componentProperties = await dataLoader.loadComponentProperties();
	} catch {
		// component properties not available
	}

	try {
		result.preprocessorList = await dataLoader.loadPreprocessorDefinitions();
	} catch {
		// preprocessor definitions not available
	}

	try {
		result.scriptingApi = await dataLoader.loadScriptingApi();
	} catch {
		// scripting api not available
	}

	return result;
}

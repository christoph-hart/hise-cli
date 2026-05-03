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
import type { AssetEnvironment } from "./engine/assets/environment.js";
import { WizardRegistry } from "./engine/wizard/registry.js";
import type { WizardHandlerRegistry } from "./engine/wizard/handler-registry.js";
import { registerWizardAliases } from "./engine/commands/slash.js";

export const SUPPORTED_MODE_IDS = ["script", "inspect", "builder", "dsp", "project", "undo", "ui", "sequence", "hise", "analyse", "publish", "assets", "api"] as const;

export interface CreateSessionOptions {
	connection: HiseConnection | null;
	completionEngine?: CompletionEngine;
	getModuleList?: () => ModuleList | undefined;
	getScriptnodeList?: () => ScriptnodeList | undefined;
	getComponentProperties?: () => ComponentPropertyMap | undefined;
	getPreprocessorList?: () => PreprocessorList | undefined;
	getScriptingApi?: () => ScriptingApi | undefined;
	/** When true, the `/api` mode renders `llmRef` instead of the terse
	 *  human description. CLI/agent route sets this. */
	apiForLlm?: boolean;
	handlerRegistry?: WizardHandlerRegistry;
	launcher?: HiseLauncher;
	/** Asset environment for the `/assets` mode. Optional — when absent, the
	 *  mode reports unavailability. Wired by node platform glue (Phase 4). */
	assetEnvironment?: AssetEnvironment;
	/** Host process working directory. Used by `/project switch ./` etc.
	 *  Defaults to `process.cwd()` when running on Node. */
	cwd?: string;
}

export function createSession({
	connection,
	completionEngine = new CompletionEngine(),
	getModuleList,
	getScriptnodeList,
	getComponentProperties,
	getPreprocessorList,
	getScriptingApi,
	apiForLlm,
	handlerRegistry,
	launcher,
	assetEnvironment,
	cwd,
}: CreateSessionOptions): { session: Session; completionEngine: CompletionEngine } {
	const session = new Session(connection, completionEngine);
	if (handlerRegistry) session.handlerRegistry = handlerRegistry;
	session.cwd = cwd ?? (typeof process !== "undefined" ? process.cwd() : null);
	session.registerMode("script", (ctx) => new ScriptMode(ctx, completionEngine));
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
	session.registerMode("api", () => new ApiMode(getScriptingApi?.(), { forLlm: apiForLlm ?? false }));
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

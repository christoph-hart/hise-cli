// ── Shared Node.js runtime bootstrap ────────────────────────────────
//
// Lifts the top-level wiring previously in src/index.ts so both the TUI
// and the web frontend can share it. Owns the singleton phase executor,
// wizard handler registry (with setup + compile handlers pre-registered),
// HISE launcher, and bundled data loader.
//
// Update wizard handlers depend on a live HiseConnection + launcher and
// are registered per-launch (in launchTui / launchWeb), not here.

import type { DataLoader } from "./engine/data.js";
import type { PhaseExecutor } from "./engine/wizard/phase-executor.js";
import { WizardHandlerRegistry } from "./engine/wizard/handler-registry.js";
import type { HiseLauncher } from "./engine/modes/hise.js";
import { createNodePhaseExecutor } from "./tui/nodePhaseExecutor.js";
import { createNodeHiseLauncher } from "./tui/nodeHiseLauncher.js";
import { createBundledDataLoader } from "./tui/bundledDataLoader.js";
import {
	registerSetupHandlers,
	registerCompileHandlers,
	registerPublishHandlers,
} from "./tui/wizard-handlers/index.js";
import { defaultResolveProjectFolder } from "./tui/wizard-handlers/publish-detect.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export interface NodeRuntime {
	phaseExecutor: PhaseExecutor;
	handlerRegistry: WizardHandlerRegistry;
	hiseLauncher: HiseLauncher;
	dataLoader: DataLoader;
}

export interface BootstrapNodeRuntimeOptions {
	readonly allowInteractive?: boolean;
}

export function bootstrapNodeRuntime(options: BootstrapNodeRuntimeOptions = {}): NodeRuntime {
	const phaseExecutor = createNodePhaseExecutor({ allowInteractive: options.allowInteractive });
	const handlerRegistry = new WizardHandlerRegistry();
	registerSetupHandlers(handlerRegistry, phaseExecutor);
	registerCompileHandlers(handlerRegistry, phaseExecutor);
	registerPublishHandlers(handlerRegistry, {
		executor: phaseExecutor,
		issTemplatePath: resolveIssTemplatePath(),
		resolveProjectFolder: defaultResolveProjectFolder(),
	});

	const hiseLauncher = createNodeHiseLauncher();
	const dataLoader = createBundledDataLoader();

	return { phaseExecutor, handlerRegistry, hiseLauncher, dataLoader };
}

/** Resolve `installer/build_installer.iss` relative to the running bundle.
 *  For `npm run dev` (esbuild → dist/index.js) the file lives at
 *  `<repo>/installer/build_installer.iss`. For the bun-compiled binary
 *  the path needs adjustment in a follow-up (embed via DataLoader). */
function resolveIssTemplatePath(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	// dist/index.js (esbuild bundle) → ../installer/build_installer.iss
	// src/bootstrap-runtime.ts (ts-node / vitest) → ../installer/build_installer.iss
	return resolve(here, "..", "installer", "build_installer.iss");
}

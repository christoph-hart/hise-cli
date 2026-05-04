// ── Wizard handler registration ─────────────────────────────────────

import type { HiseConnection } from "../../engine/hise.js";
import type { HiseLauncher } from "../../engine/modes/hise.js";
import type { WizardHandlerRegistry } from "../../engine/wizard/handler-registry.js";
import type { PhaseExecutor } from "../../engine/wizard/phase-executor.js";
import { createSetupDetectHandler } from "./setup-detect.js";
import {
	createSetupGitInstallHandler,
	createSetupCloneRepoHandler,
	createSetupBuildDepsHandler,
	createSetupFaustInstallHandler,
	createSetupExtractSdksHandler,
	createSetupCompilerInstallHandler,
	createSetupIppInstallHandler,
	createSetupAdaptVsVersionHandler,
	createSetupCompileHandler,
	createSetupVerifyHandler,
	createSetupTestHandler,
} from "./setup-tasks.js";
import {
	createCompileProjectHandler,
	createCompileNetworksHandler,
} from "./compile-tasks.js";
import { createUpdateDetectHandler } from "./update-detect.js";
import {
	createUpdateShutdownHandler,
	createUpdateCheckoutHandler,
	createUpdateCleanBuildsHandler,
	createUpdateCompileHandler,
	createUpdateLaunchHandler,
	createUpdateVerifyHandler,
} from "./update-tasks.js";
import {
	createPublishDetectHandler,
	type PublishDetectDeps,
} from "./publish-detect.js";
import {
	createInstallPackageMakerInitHandler,
	createInstallPackageMakerWriteHandler,
} from "./install-package-maker.js";
import type { AssetEnvironment } from "../../engine/assets/environment.js";
import {
	createAssertReadyHandler,
	createStagePayloadHandler,
	createSignBinariesHandler,
	createEnsureAaxKeyfileHandler,
	createSignAaxHandler,
	createBuildInstallerHandler,
	createSignInstallerHandler,
	createNotarizeHandler,
} from "./publish-tasks.js";

/** Register all setup wizard handlers (init + tasks). */
export function registerSetupHandlers(
	registry: WizardHandlerRegistry,
	executor: PhaseExecutor,
): void {
	// Init handler — environment detection
	registry.registerInit("setupDetectEnvironment", createSetupDetectHandler(executor));

	// Task handlers
	registry.registerTask("setupGitInstall", createSetupGitInstallHandler(executor));
	registry.registerTask("setupCloneRepo", createSetupCloneRepoHandler(executor));
	registry.registerTask("setupBuildDeps", createSetupBuildDepsHandler(executor));
	registry.registerTask("setupFaustInstall", createSetupFaustInstallHandler(executor));
	registry.registerTask("setupExtractSdks", createSetupExtractSdksHandler(executor));
	registry.registerTask("setupCompilerInstall", createSetupCompilerInstallHandler(executor));
	registry.registerTask("setupIppInstall", createSetupIppInstallHandler(executor));
	registry.registerTask("setupAdaptVsVersion", createSetupAdaptVsVersionHandler(executor));
	registry.registerTask("setupCompile", createSetupCompileHandler(executor));
	registry.registerTask("setupVerify", createSetupVerifyHandler(executor));
	registry.registerTask("setupTest", createSetupTestHandler(executor));
}

/** Register compile handlers for plugin export + network compile wizards. */
export function registerCompileHandlers(
	registry: WizardHandlerRegistry,
	executor: PhaseExecutor,
): void {
	registry.registerTask("compileProject", createCompileProjectHandler(executor));
	registry.registerTask("compileNetworks", createCompileNetworksHandler(executor));
}

/** Register publish wizard handlers (build_installer init + tasks). */
export function registerPublishHandlers(
	registry: WizardHandlerRegistry,
	deps: PublishDetectDeps & { issTemplatePath: string },
): void {
	registry.registerInit(
		"publishDetectEnvironment",
		createPublishDetectHandler(deps),
	);
	registry.registerTask("publishAssertReady", createAssertReadyHandler());
	registry.registerTask("publishStagePayload", createStagePayloadHandler());
	registry.registerTask(
		"publishSignBinaries",
		createSignBinariesHandler(deps.executor),
	);
	registry.registerTask(
		"publishEnsureAaxKeyfile",
		createEnsureAaxKeyfileHandler(deps.executor),
	);
	registry.registerTask("publishSignAax", createSignAaxHandler(deps.executor));
	registry.registerTask(
		"publishBuildInstaller",
		createBuildInstallerHandler({
			executor: deps.executor,
			issTemplatePath: deps.issTemplatePath,
		}),
	);
	registry.registerTask(
		"publishSignInstaller",
		createSignInstallerHandler(deps.executor),
	);
	registry.registerTask("publishNotarize", createNotarizeHandler(deps.executor));
}

/** Register install_package_maker wizard handlers. Needs the asset
 *  environment (HISE connection + filesystem + app-data paths). */
export function registerAssetsWizardHandlers(
	registry: WizardHandlerRegistry,
	assetEnvironment: AssetEnvironment,
): void {
	registry.registerInit(
		"installPackageMakerDetect",
		createInstallPackageMakerInitHandler(assetEnvironment),
	);
	registry.registerTask(
		"installPackageMakerWrite",
		createInstallPackageMakerWriteHandler(assetEnvironment),
	);
}

/** Register update wizard handlers. Unlike the setup/compile wizards these
 *  need a live HISE connection (for shutdown + verify) and a launcher (for
 *  relaunch), so they must be registered per-session once those are known. */
export function registerUpdateHandlers(
	registry: WizardHandlerRegistry,
	deps: {
		executor: PhaseExecutor;
		connection: HiseConnection;
		launcher: HiseLauncher;
	},
): void {
	registry.registerInit(
		"updateDetectEnvironment",
		createUpdateDetectHandler({ executor: deps.executor, connection: deps.connection }),
	);
	registry.registerTask("updateShutdown", createUpdateShutdownHandler(deps));
	registry.registerTask("updateCheckout", createUpdateCheckoutHandler(deps));
	registry.registerTask("updateCleanBuilds", createUpdateCleanBuildsHandler(deps));
	registry.registerTask("updateCompile", createUpdateCompileHandler(deps));
	registry.registerTask("updateLaunch", createUpdateLaunchHandler(deps));
	registry.registerTask("updateVerify", createUpdateVerifyHandler(deps));
}

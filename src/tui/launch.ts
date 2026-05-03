// ── launchInlineRepl — entry for the inline (non-fullscreen) shell ──
//
// Boots a Session, loads bundled datasets, wires file/clipboard ops,
// then mounts the InlineApp Ink shell. No alt-screen.

import { render } from "ink";
import React from "react";
import type { HiseConnection } from "../engine/hise.js";
import { CompletionEngine } from "../engine/completion/engine.js";
import { createSession, loadSessionDatasets } from "../session-bootstrap.js";
import { BuilderMode } from "../engine/modes/builder.js";
import { registerAssetsWizardHandlers, registerUpdateHandlers } from "./wizard-handlers/index.js";
import type { NodeRuntime } from "../bootstrap-runtime.js";
import { wireScriptFileOps, wireExtendedFileOps } from "../node-io.js";
import { createNodeAssetEnvironment } from "./nodeAssetIo.js";
import { InlineApp } from "./InlineApp.js";
import { renderInlineBanner } from "./banner.js";

export async function launchInlineRepl(
	connection: HiseConnection,
	runtime: NodeRuntime,
): Promise<void> {
	registerUpdateHandlers(runtime.handlerRegistry, {
		executor: runtime.phaseExecutor,
		connection,
		launcher: runtime.hiseLauncher,
	});

	// Asset environment created below — register asset wizard handlers using it.

	const completionEngine = new CompletionEngine();
	const moduleListRef: { current?: import("../engine/data.js").ModuleList } = {};
	const scriptnodeListRef: { current?: import("../engine/data.js").ScriptnodeList } = {};
	const componentPropsRef: { current?: import("../engine/modes/ui.js").ComponentPropertyMap } = {};
	const preprocessorListRef: { current?: import("../engine/data.js").PreprocessorList } = {};
	const scriptingApiRef: { current?: import("../engine/data.js").ScriptingApi } = {};

	const copyToClipboard = (text: string) => {
		process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
	};

	const assetEnvironment = createNodeAssetEnvironment({
		hise: connection,
		clipboard: { write: copyToClipboard },
	});
	registerAssetsWizardHandlers(runtime.handlerRegistry, assetEnvironment);

	const { session } = createSession({
		connection,
		completionEngine,
		getModuleList: () => moduleListRef.current,
		getScriptnodeList: () => scriptnodeListRef.current,
		getComponentProperties: () => componentPropsRef.current,
		getPreprocessorList: () => preprocessorListRef.current,
		getScriptingApi: () => scriptingApiRef.current,
		handlerRegistry: runtime.handlerRegistry,
		launcher: runtime.hiseLauncher,
		assetEnvironment,
	});

	wireScriptFileOps(session);
	wireExtendedFileOps(session);

	session.copyToClipboard = copyToClipboard;
	session.resolveHiseProjectFolder = async () => {
		const { readFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { homedir } = await import("node:os");
		const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
		const xmlPath = join(appData, "HISE", "projects.xml");
		try {
			const xml = await readFile(xmlPath, "utf-8");
			const match = xml.match(/current="([^"]+)"/);
			return match?.[1] ?? null;
		} catch {
			return null;
		}
	};

	try {
		const datasets = await loadSessionDatasets(runtime.dataLoader, completionEngine, session);
		moduleListRef.current = datasets.moduleList;
		scriptnodeListRef.current = datasets.scriptnodeList;
		componentPropsRef.current = datasets.componentProperties;
		preprocessorListRef.current = datasets.preprocessorList;
		scriptingApiRef.current = datasets.scriptingApi;
		if (datasets.moduleList) {
			for (const mode of session.modeStack) {
				if (mode instanceof BuilderMode) {
					mode.setModuleList(datasets.moduleList);
				}
			}
		}
	} catch {
		// datasets optional — completion + validation degrade gracefully
	}

	const version = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
	// Race the update check against a tight timeout so a slow network never
	// stalls the banner. Failure / timeout silently drops the badge.
	const { checkLatest } = await import("../cli/update.js");
	const info = await Promise.race([
		checkLatest(),
		new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
	]);
	const updateLatest = info?.hasUpdate ? info.latest : null;
	process.stdout.write(renderInlineBanner(version, updateLatest));

	const instance = render(
		React.createElement(InlineApp, { session, connection }),
		{
			exitOnCtrlC: false,
			patchConsole: false,
		},
	);

	// Resize: Ink's internal eraseLines miscounts when terminal columns
	// change between frames (lines wrap differently → orphan rows committed
	// to scrollback). Use prependListener so our handler fires before Ink's,
	// clear Ink's tracked frame, then write \x1b[J to wipe everything from
	// cursor to end of screen (catches orphans Ink missed).
	let resizeTimer: NodeJS.Timeout | null = null;
	const onResize = () => {
		instance.clear();
		process.stdout.write("\x1b[J");
		if (resizeTimer) clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => {
			instance.clear();
			process.stdout.write("\x1b[J");
			resizeTimer = null;
		}, 100);
	};
	process.stdout.prependListener("resize", onResize);

	try {
		await instance.waitUntilExit();
	} finally {
		process.stdout.off("resize", onResize);
		if (resizeTimer) clearTimeout(resizeTimer);
	}
}

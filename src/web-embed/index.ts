// ── Web Embed — browser-bundled engine for HISE docs site ───────────
//
// Public API: createEmbedSession + re-exports of the script-run pipeline.
// Visitors of the HISE docs site click "Run" on a .hsc snippet, this
// bundle is dynamically imported, a session is created, the snippet runs
// against the visitor's local HISE on http://localhost:1900, and the
// session is disposed.
//
// Constraints (vs. Node CLI):
//   • No filesystem (no wireScriptFileOps / wireExtendedFileOps)
//   • No shell spawn (no PhaseExecutor, no wizard handlers from tui/)
//   • No HISE binary launcher
//   • Datasets fetched over HTTP via BrowserDataLoader

import { HttpHiseConnection } from "../engine/hise.js";
import {
	createSession,
	loadSessionDatasets,
	type SessionDatasets,
} from "../session-bootstrap.js";
import type { Session } from "../engine/session.js";
import type { CompletionEngine } from "../engine/completion/engine.js";
import type { DataLoader } from "../engine/data.js";

export const VERSION =
	typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

export { createBrowserDataLoader } from "./browserDataLoader.js";
export type { BrowserDataLoaderOptions } from "./browserDataLoader.js";

export {
	parseScript,
} from "../engine/run/parser.js";
export {
	validateScript,
	formatValidationReport,
} from "../engine/run/validator.js";
export {
	executeScript,
	dryRunScript,
	formatRunReport,
} from "../engine/run/executor.js";
export {
	analyzeScriptForEmbed,
	MODE_EMBED_BLOCKLIST,
} from "../engine/run/embed-check.js";
export type { EmbedRunnability } from "../engine/run/embed-check.js";

export type {
	ParsedScript,
	ScriptLine,
	ParseError,
	ValidationResult,
	RunResult,
	ExpectResult,
	CommandOutput,
	ScriptProgressEvent,
} from "../engine/run/types.js";

export type { Session } from "../engine/session.js";
export type { SessionDatasets } from "../session-bootstrap.js";
export { HttpHiseConnection } from "../engine/hise.js";
export type { HiseConnection } from "../engine/hise.js";

export interface EmbedSessionOptions {
	/** HISE base URL. Defaults to http://localhost:1900. */
	hiseUrl?: string;
	/** Pre-loaded datasets. If omitted, the session starts dataset-less
	 *  (execution still works; validation against module/scriptnode lists
	 *  is skipped). Use `createBrowserDataLoader` + `loadSessionDatasets`
	 *  to populate, or pass a hand-built object. */
	datasets?: SessionDatasets;
}

export interface EmbedSession {
	readonly session: Session;
	readonly completionEngine: CompletionEngine;
	/** Abort any in-flight HISE requests and detach. */
	close(): void;
}

/**
 * Create a session wired for browser execution against a local HISE.
 *
 * Mirrors the CLI `--run` shape: the caller drives parseScript →
 * validateScript → executeScript and disposes via close(). No persistent
 * state across invocations — create a new session per snippet.
 */
export function createEmbedSession(
	options: EmbedSessionOptions = {},
): EmbedSession {
	const hiseUrl = options.hiseUrl ?? "http://localhost:1900";
	const url = new URL(hiseUrl);
	const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
	const connection = new HttpHiseConnection(url.hostname, port);

	const datasets = options.datasets ?? {};
	const { session, completionEngine } = createSession({
		connection,
		getModuleList: () => datasets.moduleList,
		getScriptnodeList: () => datasets.scriptnodeList,
		getComponentProperties: () => datasets.componentProperties,
	});

	return {
		session,
		completionEngine,
		close() {
			connection.destroy();
		},
	};
}

/**
 * Convenience: build a DataLoader from a base URL and load datasets.
 * Intended for callers that want one-line bootstrap before the first
 * snippet executes. Caches the result on the caller side.
 */
export async function fetchEmbedDatasets(
	baseUrl: string,
): Promise<SessionDatasets> {
	const { createBrowserDataLoader } = await import("./browserDataLoader.js");
	const loader: DataLoader = createBrowserDataLoader({ baseUrl });
	const result: SessionDatasets = {};
	try {
		result.moduleList = await loader.loadModuleList();
	} catch { /* optional */ }
	try {
		result.scriptnodeList = await loader.loadScriptnodeList();
	} catch { /* optional */ }
	try {
		result.componentProperties = await loader.loadComponentProperties();
	} catch { /* optional */ }
	return result;
}

// Re-export loadSessionDatasets for callers that want full control
// (e.g. progress UI, custom completion engine).
export { loadSessionDatasets };

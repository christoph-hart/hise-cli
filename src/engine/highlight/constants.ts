// ── Shared constants for highlighter and mode system ────────────────

// Single source of truth for mode accent colors and slash-command mode
// IDs. Owned by the highlighter so the `src/engine/highlight/` directory
// is self-contained (zero imports outside itself) and can be exported
// verbatim to external consumers (e.g. docs website).
//
// `src/engine/modes/mode.ts` re-exports these for existing callers.

// Mode accent colors — hardcoded per-mode identity.
export const MODE_ACCENTS = {
	root: "", // uses foreground.default
	builder: "#fd971f",
	script: "#C65638",
	dsp: "#3a6666",
	sampler: "#a6e22e",
	inspect: "#ae81ff",
	project: "#e6db74",
	compile: "#f92672",
	undo: "#66d9ef",
	wizard: "#e8a060",
	ui: "#66d9ef",
	sequence: "#56b6c2",
	hise: "#90FFB1",
	analyse: "#e6a040",
	publish: "#ff79c6",
	assets: "#a6c8e6",
	api: "#7dcfff",
} as const;

/** Mode names that can be entered via slash commands (e.g. /builder, /script).
 *  Includes "export" as an alias for "compile". Single source of truth —
 *  used by validator, mode-map, optimizer, and slash highlighter. */
export const SLASH_MODE_IDS = new Set<string>([
	"builder", "script", "dsp", "sampler", "inspect",
	"project", "export", "undo", "ui", "sequence", "hise", "analyse",
	"publish", "assets", "api",
]);

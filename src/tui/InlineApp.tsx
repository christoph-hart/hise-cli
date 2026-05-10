// ── InlineApp — sticky-bottom REPL Ink shell ────────────────────────
//
// No alt-screen, no full-screen layout. Output blocks committed via
// Ink's <Static> (appended to scrollback, never re-rendered). Below
// Static: status line + completion popup (when active) + input.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { MouseProvider } from "@ink-tools/ink-mouse";
import type { Session } from "../engine/session.js";
import type { HiseConnection } from "../engine/hise.js";
import type { CommandResult } from "../engine/result.js";
import type { CompletionItem, CompletionResult } from "../engine/modes/mode.js";
import { MODE_ACCENTS } from "../engine/modes/mode.js";
import { startObserverServer, type ObserverEvent } from "./observer.js";
import type { TreeNode } from "../engine/result.js";
import { renderTreeBox } from "../engine/modes/builder-ops.js";
import { resolveNodeByPath } from "../engine/tree-utils.js";
import { Input, type InputHandle, buildVisualRowMap, offsetToLineCol, lineColToOffset } from "./Input.js";
import { formatScriptLog } from "./script-log.js";
import { buildModeMap } from "../engine/run/mode-map.js";
import { CompletionPopup } from "./CompletionPopup.js";
import {
	brand,
	defaultScheme,
	statusColor,
	type ColorScheme,
	type ConnectionStatus,
} from "./theme.js";

const HORIZONTAL_PAD = 2;
const COMPLETION_MAX_VISIBLE = 8;
const COMPACT = {
	horizontalPad: HORIZONTAL_PAD,
	completionMaxVisible: COMPLETION_MAX_VISIBLE,
} as const;
import {
	renderEcho,
	renderError,
	renderResult,
	fgHex,
	RESET,
	wrapAnsi,
	type PrerenderedBlock,
} from "./prerender.js";
import {
	renderWizardBlock,
	createInitialFormState,
	type WizardFormState,
} from "./wizard-render.js";
import { handleWizardKey } from "./wizard-keys.js";
import {
	WizardExecutor,
	WizardInitAbortError,
} from "../engine/wizard/executor.js";
import { mergeInitDefaults } from "../engine/wizard/types.js";
import { formatWithClause } from "../engine/commands/slash.js";
import { listPathCompletions } from "./wizard-files.js";
import {
	getProviderLabel,
	isAiCapableMode,
	runAiPrediction,
} from "./ai-prompt.js";
import type { IntentOutcome } from "../engine/llm/index.js";

interface CommittedBlock {
	id: number;
	text: string;
}

interface AiPreviewState {
	nl: string;
	pending: boolean;
	outcome?: IntentOutcome;
	preludeError?: string;
}

export interface InlineAppProps {
	session: Session;
	connection: HiseConnection | null;
}

export function InlineApp(props: InlineAppProps): React.ReactElement {
	return (
		<MouseProvider autoEnable={false}>
			<InlineAppInner {...props} scheme={defaultScheme} />
		</MouseProvider>
	);
}

interface InnerProps extends InlineAppProps {
	scheme: ColorScheme;
}

function InlineAppInner({ session, connection, scheme }: InnerProps): React.ReactElement {
	const { exit } = useApp();
	const { stdout } = useStdout();

	const [columns, setColumns] = useState<number>(stdout?.columns ?? 80);
	const [terminalRows, setTerminalRows] = useState<number>(stdout?.rows ?? 24);

	useEffect(() => {
		if (!stdout) return;
		let timer: NodeJS.Timeout | null = null;
		const handler = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				setColumns(stdout.columns ?? 80);
				setTerminalRows(stdout.rows ?? 24);
				timer = null;
			}, 300);
		};
		stdout.on("resize", handler);
		return () => {
			stdout.off("resize", handler);
			if (timer) clearTimeout(timer);
		};
	}, [stdout]);

	const innerW = Math.max(20, columns - 2 * COMPACT.horizontalPad);

	const [committed, setCommitted] = useState<CommittedBlock[]>([]);
	const blockIdRef = useRef(0);

	const [disabled, setDisabled] = useState(false);
	const disabledRef = useRef(false);

	const [completionState, setCompletionState] = useState<{
		result: CompletionResult;
		selectedIndex: number;
	} | null>(null);

	// Hold the popup row count after Enter dismissal so the reserved
	// region's height stays constant until the next keystroke. Prevents
	// input from jumping up when popup hides on submit.
	const [frozenPopupRows, setFrozenPopupRows] = useState(0);

	const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
		connection ? "warning" : "error",
	);

	const [treePanelVisible, setTreePanelVisible] = useState(false);

	const [terminalFocused, setTerminalFocused] = useState(true);
	const focusSeqTimestampRef = useRef(0);

	// Graceful exit: switch border to dimmed before unmount so the final
	// frame visually signals "not focused" (otherwise looks like hise-cli
	// is still active).
	const gracefulExit = useCallback(() => {
		setTerminalFocused(false);
		setTimeout(() => exit(), 50);
	}, [exit]);
	useEffect(() => {
		// DECSET 1004: focus reporting. Terminal emits \x1b[I on focus-in,
		// \x1b[O on focus-out. Used to colorize sticky borders + prompt.
		process.stdout.write("\x1b[?1004h");
		const onData = (data: Buffer) => {
			const s = data.toString("utf8");
			if (s.includes("\x1b[I")) {
				focusSeqTimestampRef.current = Date.now();
				setTerminalFocused(true);
			}
			if (s.includes("\x1b[O")) {
				focusSeqTimestampRef.current = Date.now();
				setTerminalFocused(false);
			}
		};
		process.stdin.on("data", onData);
		return () => {
			process.stdin.off("data", onData);
			process.stdout.write("\x1b[?1004l");
		};
	}, []);

	// F5/F7 detection: Ink's useInput cannot reliably distinguish these
	// across terminals, so we attach a raw stdin listener that parses the
	// escape sequences and flips a ref. The multiline useInput branch
	// checks the refs and fires the corresponding action.
	const f5PressedRef = useRef(false);
	const f7PressedRef = useRef(false);
	// Ink maps both Delete (\x1b[3~) and Backspace (\x7f) to key.delete/backspace,
	// so we sniff the raw sequence to distinguish forward-delete.
	const deleteForwardRef = useRef(false);
	useEffect(() => {
		const onData = (data: Buffer) => {
			const str = data.toString();
			if (str === "\x1b[15~" || str === "\x1b[[E") f5PressedRef.current = true;
			if (str === "\x1b[18~") f7PressedRef.current = true;
			if (str === "\x1b[3~") deleteForwardRef.current = true;
		};
		process.stdin.on("data", onData);
		return () => { process.stdin.off("data", onData); };
	}, []);

	const inputHandleRef = useRef<InputHandle | null>(null);

	const [modeRenderTick, forceModeRender] = useState(0);
	const bumpModeRender = useCallback(() => forceModeRender(v => v + 1), []);

	const [wizardForm, setWizardForm] = useState<WizardFormState | null>(null);
	const wizardFormRef = useRef<WizardFormState | null>(null);
	wizardFormRef.current = wizardForm;

	// Re-render the status bar when the active wizard changes (set in
	// session.setActiveWizard / clearActiveWizard).
	const [activeWizardTick, setActiveWizardTick] = useState(0);
	const activeWizard = session.activeWizard ?? null;
	useEffect(() => {
		// Poll the session-level tick (cheap) instead of plumbing a subscription.
		const id = setInterval(() => {
			if ((session.activeWizardTick ?? 0) !== activeWizardTick) {
				setActiveWizardTick(session.activeWizardTick ?? 0);
			}
		}, 80);
		return () => clearInterval(id);
	}, [session, activeWizardTick]);

	// Spinner frame counter — advances while a wizard is active.
	const [spinnerFrame, setSpinnerFrame] = useState(0);
	useEffect(() => {
		if (!activeWizard) return;
		const id = setInterval(() => setSpinnerFrame(f => (f + 1) % 10), 80);
		return () => clearInterval(id);
	}, [activeWizard]);

	const [multilineMode, setMultilineMode] = useState(false);
	const multilineModeRef = useRef(false);
	multilineModeRef.current = multilineMode;
	const [editorFilePath, setEditorFilePath] = useState<string | null>(null);
	const [editorErrorLines, setEditorErrorLines] = useState<number[] | undefined>(undefined);
	const singleLineContentRef = useRef("");
	const editorContentRef = useRef("");
	const escTimestampRef = useRef(0);
	// Bumped on every editor value change so editorMaxLines memo recomputes.
	const [editorValueVersion, setEditorValueVersion] = useState(0);

	// AI prompt (?-prefix) state. When set, displays a confirmation block
	// above the input prompt; Enter executes, Esc cancels, R retries.
	const [aiPreview, setAiPreview] = useState<AiPreviewState | null>(null);
	const aiPreviewRef = useRef<AiPreviewState | null>(null);
	aiPreviewRef.current = aiPreview;
	const aiAbortRef = useRef<AbortController | null>(null);

	const MIN_EDITOR_LINES = 4;
	const editorMaxLines = useMemo(() => {
		if (!multilineMode) return 1;
		const value = inputHandleRef.current?.getValue() ?? "";
		const lines = value.split("\n");
		const lineCount = Math.max(lines.length, MIN_EDITOR_LINES);
		const lineNumberWidth = String(lineCount).length;
		const gutterChars = COMPACT.horizontalPad + lineNumberWidth + 1 + 1;
		const bodyWidth = Math.max(1, columns - gutterChars - 1 - COMPACT.horizontalPad);
		const vrMap = buildVisualRowMap(lines, bodyWidth);
		return Math.max(MIN_EDITOR_LINES, vrMap.length);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [multilineMode, columns, editorValueVersion]);

	const currentMode = session.currentMode();
	const wizardActive = activeWizard !== null;
	const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	const modeLabel = wizardActive
		? `${spinnerFrames[spinnerFrame]} Running ${activeWizard}`
		: currentMode.name ?? "root";
	const modeAccent = wizardActive
		? "#e8a060"
		: currentMode.accent || scheme.foreground.muted;
	const contextLabel = wizardActive ? undefined : currentMode.contextLabel;

	const modeTokenizer = useMemo(() => {
		const inner = currentMode.tokenizeInput
			? (v: string) => currentMode.tokenizeInput!(v)
			: undefined;
		// Wrap to special-case ?-prefix (AI prompt): bypass mode highlight,
		// render `?` in signal color and rest as plain text.
		return (v: string) => {
			if (v.trimStart().startsWith("?")) {
				const leading = v.length - v.trimStart().length;
				const out = [];
				if (leading > 0) out.push({ token: "plain" as const, text: v.slice(0, leading) });
				out.push({ token: "aiPrefix" as const, text: "?", bold: true });
				const rest = v.slice(leading + 1);
				if (rest.length > 0) out.push({ token: "plain" as const, text: rest });
				return out;
			}
			return inner ? inner(v) : [{ token: "plain" as const, text: v }];
		};
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [currentMode]);

	const appendBlock = useCallback((block: PrerenderedBlock, indent = true, compact = false) => {
		const id = blockIdRef.current++;
		const prefix = indent ? "  " : "";
		const padded = block.lines.map(l => prefix + l).join("\n");
		// Default: surround with blank lines (wide spacing between command outputs).
		// Compact: no extra padding — Ink's <Text> already terminates each block
		// with a newline, so adjacent compact blocks stack as consecutive rows
		// with no blank line between, suitable for streaming progress.
		const text = compact ? padded : "\n" + padded + "\n";
		setCommitted(prev => [...prev, { id, text }]);
	}, []);

	// Observer: HTTP server receives async events from the CLI runner
	// (LLM-triggered commands) and commits annotated blocks to scrollback.
	const observerCtxRef = useRef({ scheme, innerW, treePanelVisible });
	observerCtxRef.current = { scheme, innerW, treePanelVisible };

	const handleObserverEvent = useCallback((event: ObserverEvent) => {
		const { scheme: s, innerW: w, treePanelVisible: panelOpen } = observerCtxRef.current;

		if (event.type === "command.start") {
			const accent = MODE_ACCENTS[event.mode as keyof typeof MODE_ACCENTS] || s.foreground.default;
			appendBlock(
				renderEcho(event.command, accent, s.backgrounds.raised, w, undefined, {
					prefix: "[LLM] ",
					prefixColor: s.foreground.muted,
				}),
				false,
			);
			return;
		}

		if (event.type === "command.progress") {
			const parts = [event.phase, event.percent !== undefined ? `${event.percent}%` : undefined, event.message]
				.filter(Boolean)
				.join(" ");
			if (parts) {
				const block = renderResult({ type: "text", content: parts }, s, w);
				if (block) appendBlock(block);
			}
			return;
		}

		const block = renderResult(event.result, s, w);
		if (block) appendBlock(block);

		// command.end — external CLI call mutated HISE state. Invalidate
		// every cached tree so the panel and `show tree` reflect changes.
		// If the panel is open, eagerly refetch the active mode's tree.
		if (event.type === "command.end") {
			session.invalidateAllTrees();
			if (panelOpen) {
				const active = session.currentMode();
				if (active.onEnter) {
					void active.onEnter(session).then(() => bumpModeRender()).catch(() => { /* best-effort */ });
				} else {
					bumpModeRender();
				}
			} else {
				bumpModeRender();
			}
		}
	}, [appendBlock, session, bumpModeRender]);

	useEffect(() => {
		const server = startObserverServer(handleObserverEvent);
		return () => {
			server.close();
		};
	}, [handleObserverEvent]);

	useEffect(() => {
		if (!connection) {
			setConnectionStatus("error");
			return;
		}
		let cancelled = false;
		const probe = async () => {
			try {
				const alive = await connection.probe();
				if (cancelled) return;
				setConnectionStatus(alive ? "connected" : "error");
				if (alive && !session.projectFolder) {
					try {
						const resp = await connection.get("/api/status");
						const data = resp as unknown as Record<string, unknown>;
						if (data.success && data.project && typeof data.project === "object") {
							const proj = data.project as Record<string, unknown>;
							const name = typeof proj.name === "string" ? proj.name : undefined;
							const folder = typeof proj.projectFolder === "string" ? proj.projectFolder : undefined;
							if (name) session.projectName = name;
							if (folder) {
								session.projectFolder = folder;
								void session.refreshScriptFileCache();
							}
							if (typeof data.activeIsSnippetBrowser === "boolean") {
								session.playgroundActive = data.activeIsSnippetBrowser;
							}
							if (!cancelled) bumpModeRender();
						}
					} catch { /* project info optional */ }
				}
				if (!alive && !session.projectFolder && session.resolveHiseProjectFolder) {
					try {
						const folder = await session.resolveHiseProjectFolder();
						if (folder && !cancelled) {
							session.projectFolder = folder;
							void session.refreshScriptFileCache();
							bumpModeRender();
						}
					} catch { /* ignore */ }
				}
			} catch {
				if (!cancelled) setConnectionStatus("error");
			}
		};
		void probe();
		const id = setInterval(probe, 5000);
		return () => { cancelled = true; clearInterval(id); };
	}, [connection, session, bumpModeRender]);

	const acceptCompletion = useCallback((item: CompletionItem, result: CompletionResult) => {
		const handle = inputHandleRef.current;
		if (!handle) return;
		const current = handle.getValue();
		const insertText = item.insertText ?? item.label;
		const newValue = current.slice(0, result.from) + insertText + current.slice(result.to);
		handle.setValue(newValue);
		handle.setCursorAt(result.from + insertText.length);
		setCompletionState(null);
	}, []);

	const handleInputValueChange = useCallback((value: string, cursorPos: number) => {
		if (value.length < 1) {
			setCompletionState(null);
			return;
		}

		// AI prefix `?<request>` — suppress completion entirely.
		if (!multilineModeRef.current && value.trimStart().startsWith("?")) {
			setCompletionState(null);
			return;
		}

		let result: CompletionResult;
		if (multilineModeRef.current) {
			const { line: lineIdx, col } = offsetToLineCol(value, cursorPos);
			const lines = value.split("\n");
			const lineText = lines[lineIdx] ?? "";
			const trimmed = lineText.trim();
			if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("//")) {
				setCompletionState(null);
				return;
			}
			if (col < lineText.length) {
				setCompletionState(null);
				return;
			}
			let lineResult: CompletionResult;
			if (lineText.startsWith("/")) {
				lineResult = session.complete(lineText, col);
			} else {
				const modeMap = buildModeMap(lines);
				const entry = modeMap[lineIdx];
				if (entry && entry.modeId !== "root") {
					try {
						const mode = session.getOrCreateMode(entry.modeId);
						if (mode.complete) {
							lineResult = mode.complete(lineText, col);
						} else {
							setCompletionState(null);
							return;
						}
					} catch {
						setCompletionState(null);
						return;
					}
				} else {
					lineResult = session.complete(lineText, col);
				}
			}
			const lineStart = lineColToOffset(value, lineIdx, 0);
			result = {
				...lineResult,
				from: lineResult.from + lineStart,
				to: lineResult.to + lineStart,
			};
		} else {
			if (cursorPos < value.length) {
				setCompletionState(null);
				return;
			}
			result = session.complete(value, cursorPos);
		}

		if (result.items.length > 0) {
			const token = value.slice(result.from);
			if (token.length > 0 && result.items.some(item => (item.insertText ?? item.label) === token)) {
				setCompletionState(null);
				return;
			}
			setCompletionState({ result, selectedIndex: 0 });
		} else {
			setCompletionState(null);
		}
	}, [session]);

	const handleTab = useCallback(() => {
		if (!completionState) {
			const value = inputHandleRef.current?.getValue() ?? "";
			if (value.length === 0) return;
			const result = session.complete(value, value.length);
			if (result.items.length === 1) {
				acceptCompletion(result.items[0]!, result);
			} else if (result.items.length > 1) {
				setCompletionState({ result, selectedIndex: 0 });
			}
			return;
		}
		const item = completionState.result.items[completionState.selectedIndex];
		if (item) acceptCompletion(item, completionState.result);
	}, [completionState, session, acceptCompletion]);

	const handleEscape = useCallback(() => {
		if (completionState) {
			setCompletionState(null);
			return;
		}
		const handle = inputHandleRef.current;
		if (!handle) return;
		const value = handle.getValue();
		const cursorPos = handle.getCursorPos();
		const query = (value.length === 0 && session.currentModeId === "root") ? "/" : value;
		const qCursor = (value.length === 0 && session.currentModeId === "root") ? 1 : cursorPos;
		const result = session.complete(query, qCursor);
		if (result.items.length > 0) {
			setCompletionState({ result, selectedIndex: 0 });
		}
	}, [completionState, session]);

	// Wizard progress: render each event as a one-line scrollback block.
	// Wired once into session.onWizardProgress below — this is the sole sink
	// for wizard streaming output in the TUI (CLI uses stderr).
	useEffect(() => {
		const dim = fgHex(scheme.foreground.muted);
		const warn = fgHex("#FFBA00");
		const err = fgHex("#BB3434");
		const ok = fgHex("#4E8E35");
		const accent = fgHex(scheme.foreground.default);
		const bold = "\x1b[1m";

		const pushLine = (line: string) => {
			const wrapped = wrapAnsi(line, innerW);
			// compact=true: single newline between progress lines, no leading/trailing
			// blank that the default block padding inserts.
			appendBlock({ lines: wrapped, height: wrapped.length }, true, true);
		};

		session.onWizardProgress = (progress) => {
			if (progress.message?.startsWith("__heading__")) {
				const heading = progress.message.slice("__heading__".length);
				pushLine(`${bold}${accent}${heading}${RESET}`);
				return;
			}
			if (!progress.message) return;
			const msg = progress.message;
			let line: string;
			if (msg.startsWith("✗ ")) line = `${err}✗ ${msg.slice(2)}${RESET}`;
			else if (msg.startsWith("⚠ ")) line = `${warn}⚠ ${msg.slice(2)}${RESET}`;
			else if (msg.startsWith("✓ ")) line = `${ok}✓ ${msg.slice(2)}${RESET}`;
			else line = `${dim}${msg}${RESET}`;
			pushLine(line);
		};
		return () => { session.onWizardProgress = undefined; };
	}, [session, scheme, innerW, appendBlock]);

	const handleEditCommand = useCallback(async (raw: string): Promise<boolean> => {
		const trimmed = raw.trim();
		if (trimmed !== "/edit" && !trimmed.startsWith("/edit ")) return false;
		let arg = trimmed.slice("/edit".length).trim();
		if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
			arg = arg.slice(1, -1);
		}
		const handle = inputHandleRef.current;
		if (arg && session.loadScriptFile) {
			try {
				const content = await session.loadScriptFile(arg);
				if (handle) singleLineContentRef.current = handle.getValue();
				setEditorFilePath(arg);
				setMultilineMode(true);
				if (handle) handle.setValue(content.replace(/\r\n/g, "\n").trimEnd());
				setEditorValueVersion(v => v + 1);
			} catch (err: unknown) {
				const errCode = (err as { code?: string })?.code;
				if (errCode === "ENOENT" && session.saveScriptFile) {
					try {
						await session.saveScriptFile(arg, "");
						if (handle) singleLineContentRef.current = handle.getValue();
						setEditorFilePath(arg);
						setMultilineMode(true);
						if (handle) handle.setValue("");
						setEditorValueVersion(v => v + 1);
					} catch (saveErr) {
						appendBlock(renderError(
							`Failed to create "${arg}": ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`,
							undefined, scheme.foreground.muted, innerW,
						));
					}
				} else {
					appendBlock(renderError(
						`Failed to load "${arg}": ${err instanceof Error ? err.message : String(err)}`,
						undefined, scheme.foreground.muted, innerW,
					));
				}
			}
		} else {
			if (handle) singleLineContentRef.current = handle.getValue();
			setMultilineMode(true);
			if (handle) handle.setValue(editorContentRef.current);
			setEditorValueVersion(v => v + 1);
		}
		return true;
	}, [session, scheme, innerW, appendBlock]);

	const submitScript = useCallback(async (source: string) => {
		disabledRef.current = true;
		setDisabled(true);
		try {
			const { parseScript } = await import("../engine/run/parser.js");
			const { validateScript, formatValidationReport } = await import("../engine/run/validator.js");
			const { executeScript } = await import("../engine/run/executor.js");

			setEditorErrorLines(undefined);

			if (editorFilePath && session.saveScriptFile) {
				try {
					await session.saveScriptFile(editorFilePath, source);
				} catch (err) {
					appendBlock(renderError(
						`Save failed: ${err instanceof Error ? err.message : String(err)}`,
						undefined, scheme.foreground.muted, innerW,
					));
					return;
				}
			}

			const script = parseScript(source);
			const validation = validateScript(script, session);
			if (!validation.ok) {
				if (validation.errors.length > 0) {
					setEditorErrorLines(validation.errors.map(e => e.line));
				}
				appendBlock(renderError(
					formatValidationReport(validation),
					undefined, scheme.foreground.muted, innerW,
				));
				return;
			}

			const echoText = editorFilePath
				? `Execute script "${editorFilePath.split(/[\\/]/).pop()}"`
				: source;
			const echoBlock = renderEcho(echoText, scheme.foreground.muted, scheme.backgrounds.raised, innerW);
			appendBlock(echoBlock, false);

			const result = await executeScript(script, session);
			if (result.error) {
				setEditorErrorLines([result.error.line]);
			}
			appendBlock(formatScriptLog(source, result, scheme));
			const hr = fgHex(scheme.foreground.muted) + "─".repeat(columns) + RESET;
			appendBlock({ lines: [hr], height: 1 }, false);

			// Script may have mutated module/component/dsp state — invalidate
			// every cached tree so cross-mode panels (or `show tree`) refetch
			// on next access.
			session.invalidateAllTrees();
			if (treePanelVisible) {
				const active = session.currentMode();
				if (active.onEnter) {
					try { await active.onEnter(session); } catch { /* refetch best-effort */ }
				}
			}
			bumpModeRender();
		} catch (err) {
			appendBlock(renderError(
				`Script error: ${err instanceof Error ? err.message : String(err)}`,
				undefined, scheme.foreground.muted, innerW,
			));
		} finally {
			disabledRef.current = false;
			setDisabled(false);
		}
	}, [session, scheme, innerW, columns, appendBlock, editorFilePath, treePanelVisible, bumpModeRender]);

	const validateAndSaveScript = useCallback(async (source: string) => {
		const { parseScript } = await import("../engine/run/parser.js");
		const { validateScript, formatValidationReport } = await import("../engine/run/validator.js");
		const { dryRunScript } = await import("../engine/run/executor.js");

		setEditorErrorLines(undefined);

		const script = parseScript(source);
		const staticResult = validateScript(script, session);
		if (!staticResult.ok) {
			setEditorErrorLines(staticResult.errors.map(e => e.line));
			const block = renderResult({ type: "error", message: formatValidationReport(staticResult) }, scheme, innerW);
			if (block) appendBlock(block);
			return;
		}

		if (session.connection) {
			const liveResult = await dryRunScript(script, session);
			if (!liveResult.ok) {
				setEditorErrorLines(liveResult.errors.map(e => e.line));
				const block = renderResult({ type: "error", message: formatValidationReport(liveResult) }, scheme, innerW);
				if (block) appendBlock(block);
				return;
			}
		}

		if (editorFilePath && session.saveScriptFile) {
			try {
				await session.saveScriptFile(editorFilePath, source);
				const block = renderResult({ type: "text", content: `Validation passed — saved "${editorFilePath.split(/[\\/]/).pop()}"` }, scheme, innerW);
				if (block) appendBlock(block);
			} catch (err) {
				appendBlock(renderError(
					`Save failed: ${err instanceof Error ? err.message : String(err)}`,
					undefined, scheme.foreground.muted, innerW,
				));
			}
		} else {
			const block = renderResult({ type: "text", content: "Validation passed — no errors found." }, scheme, innerW);
			if (block) appendBlock(block);
		}
	}, [session, scheme, innerW, appendBlock, editorFilePath]);

	const runAiPredict = useCallback(async (nl: string) => {
		const mode = session.currentMode();
		if (!isAiCapableMode(mode.id)) {
			setAiPreview({
				nl,
				pending: false,
				preludeError: `AI prediction available in builder/ui/dsp modes only (current: ${mode.id || "root"}).`,
			});
			disabledRef.current = true;
			setDisabled(true);
			return;
		}
		aiAbortRef.current?.abort();
		const ctl = new AbortController();
		aiAbortRef.current = ctl;
		setAiPreview({ nl, pending: true });
		disabledRef.current = true;
		setDisabled(true);
		try {
			const tree = mode.getTree?.() ?? null;
			const moduleList = session.getModuleList?.();
			const componentProperties = session.getComponentProperties?.();
			const outcome = await runAiPrediction({
				mode: mode.id,
				tree,
				nl,
				signal: ctl.signal,
				moduleList,
				componentProperties,
			});
			if (ctl.signal.aborted) return;
			setAiPreview({ nl, pending: false, outcome });
		} catch (e) {
			if (ctl.signal.aborted) return;
			setAiPreview({
				nl,
				pending: false,
				preludeError: e instanceof Error ? e.message : String(e),
			});
		}
	}, [session]);

	const handleSubmit = useCallback(async (input: string) => {
		if (input.trim().length === 0) return;
		setCompletionState(null);

		// AI prefix `?<request>` — run intent pipeline, show confirmation block
		if (!multilineModeRef.current && input.trim().startsWith("?")) {
			const nl = input.trim().slice(1).trim();
			if (nl.length === 0) return;
			await runAiPredict(nl);
			return;
		}

		// Multiline submit → execute script (no /edit detection here)
		if (multilineModeRef.current) {
			await submitScript(input);
			return;
		}

		// /edit toggles multiline
		if (await handleEditCommand(input)) return;

		const mode = session.currentMode();
		const currentAccent = mode.accent;
		const echoSpans = mode.tokenizeInput?.(input);

		disabledRef.current = true;
		setDisabled(true);

		try {
			const result: CommandResult = await session.handleInput(input);
			const accent = result.accent || currentAccent || scheme.foreground.default;

			const echoBlock = renderEcho(input, accent, scheme.backgrounds.raised, innerW, echoSpans);

			if (result.type === "wizard") {
				if (session.pendingWizard) session.clearPendingWizard();
				// Show wizard immediately with stub state so ephemeral live
				// region transitions away from the input box BEFORE init
				// awaits — prevents Ink from leaking stale input + status
				// rows into scrollback during the await gap.
				const stubState = createInitialFormState(result.definition, result.prefill);
				setWizardForm(stubState);
				appendBlock(echoBlock, false);
				const executor = new WizardExecutor({
					connection: session.connection,
					handlerRegistry: session.handlerRegistry,
				});
				let initDefaults: import("../engine/wizard/types.js").InitDefaultsResult;
				try {
					initDefaults = await executor.initialize(result.definition);
				} catch (e: unknown) {
					if (e instanceof WizardInitAbortError) {
						setWizardForm(null);
						appendBlock(renderError(e.message, undefined, scheme.foreground.muted, innerW));
						return;
					}
					throw e;
				}
				const mergedDef = mergeInitDefaults(result.definition, initDefaults);
				const formState = createInitialFormState(mergedDef, result.prefill);
				setWizardForm(formState);
			} else if (result.type === "run-report") {
				appendBlock(echoBlock, false);
				const { formatRunReport } = await import("../engine/run/executor.js");
				const summary = formatRunReport(result.runResult, result.verbosity);
				const rendered = renderResult({ type: "text", content: summary }, scheme, innerW);
				if (rendered) appendBlock(rendered);
			} else if (result.type === "empty" && input.trim() === "/clear") {
				setCommitted([]);
			} else if (result.type !== "empty") {
				appendBlock(echoBlock, false);
				const rendered = renderResult(result, scheme, innerW);
				if (rendered) appendBlock(rendered);
			} else {
				appendBlock(echoBlock, false);
			}

			if (session.shouldQuit) {
				gracefulExit();
				return;
			}

			// Cross-mode mutations (e.g. /script setting Component visibility)
			// invalidate every cached tree. If the tree panel is open, eagerly
			// refetch the active mode's tree so the panel renders fresh data
			// on the next paint. Otherwise fetch lazily on next parse.
			session.invalidateAllTrees();
			if (treePanelVisible) {
				const active = session.currentMode();
				if (active.onEnter) {
					try { await active.onEnter(session); } catch { /* refetch best-effort */ }
				}
			}
			bumpModeRender();
		} catch (err) {
			appendBlock(renderError(
				`Error: ${err instanceof Error ? err.message : String(err)}`,
				undefined, scheme.foreground.muted, innerW,
			));
		} finally {
			disabledRef.current = false;
			setDisabled(false);
		}
	}, [session, scheme, innerW, appendBlock, exit, bumpModeRender, treePanelVisible]);

	useInput((input, key) => {
		// DECSET 1004 focus reports: terminal emits \x1b[I / \x1b[O.
		// Stdin listener (in focus effect above) stamps timestamp; we
		// swallow the corresponding ESC + "[I"/"[O" events here.
		if (input === "[I" || input === "[O") return;
		if (key.escape && Date.now() - focusSeqTimestampRef.current < 50) return;

		// Stable bottom region: capture popup height on Enter, clear on
		// any other keystroke. Single-line mode only; multiline editor's
		// Enter inserts newline so it doesn't dismiss popup.
		if (!multilineModeRef.current && !wizardFormRef.current && !wizardActive) {
			if (key.return && completionState) {
				const itemRows = Math.min(completionState.result.items.length, COMPACT.completionMaxVisible);
				const headerRows = completionState.result.label ? 1 : 0;
				setFrozenPopupRows(itemRows + headerRows);
			} else if (frozenPopupRows > 0) {
				setFrozenPopupRows(0);
			}
		}

		// Wizard active: Esc aborts the run via the session-tracked controller.
		if (session.activeWizard) {
			if (key.escape) session.activeWizardAbort?.abort();
			return;
		}

		// Wizard form active — route to wizard key handler
		if (wizardFormRef.current) {
			const result = handleWizardKey(wizardFormRef.current, input, key);
			if (!result) return;
			if (result.action === "cancel") {
				const form = wizardFormRef.current;
				const deactivated = { ...form, active: false };
				appendBlock(renderWizardBlock(deactivated, scheme, innerW, { flat: true }));
				appendBlock({ lines: [`${fgHex(scheme.foreground.muted)}Wizard cancelled.${RESET}`], height: 1 });
				setWizardForm(null);
				return;
			}
			if (result.action === "submit") {
				const form = wizardFormRef.current;
				const deactivated = { ...form, active: false };
				appendBlock(renderWizardBlock(deactivated, scheme, innerW, { flat: true }));
				setWizardForm(null);
				// Dispatch through the same path as a typed `/wizard run <id> with K=V`
				// so progress streaming and result handling go through the unified pipe.
				const withClause = formatWithClause(result.answers);
				const command = withClause
					? `/wizard run ${form.definition.id} with ${withClause}`
					: `/wizard run ${form.definition.id}`;
				void session.handleInput(command).then((res) => {
					if (res.type === "empty") return;
					const rendered = renderResult(res, scheme, innerW);
					if (rendered) appendBlock(rendered);
				});
				return;
			}
			let newState = result.state;
			if (result.recomputeCompletions) {
				const def = newState.definition;
				const tab = def.tabs[newState.activeTab];
				const field = tab?.fields[newState.activeField];
				if (field?.type === "file") {
					const value = newState.answers[field.id] ?? "";
					const completions = listPathCompletions(value, {
						directory: field.directory,
						wildcard: field.wildcard,
					});
					newState = { ...newState, completions, completionIndex: 0 };
				}
			}
			setWizardForm(newState);
			return;
		}

		// AI preview block active — capture confirm/cancel/retry keys
		// before the disabled-gate (preview always disables Input).
		if (aiPreviewRef.current) {
			const preview = aiPreviewRef.current;
			if (preview.pending) {
				if (key.escape) {
					aiAbortRef.current?.abort();
					setAiPreview(null);
					disabledRef.current = false;
					setDisabled(false);
				}
				return;
			}
			if (key.return) {
				const cmd = preview.outcome?.ok ? preview.outcome.result.command : null;
				setAiPreview(null);
				disabledRef.current = false;
				setDisabled(false);
				if (cmd) void handleSubmit(cmd);
				return;
			}
			if (key.escape) {
				setAiPreview(null);
				disabledRef.current = false;
				setDisabled(false);
				return;
			}
			if (input === "r" || input === "R") {
				void runAiPredict(preview.nl);
				return;
			}
			return;
		}

		if (disabledRef.current) return;

		// Ctrl+B — toggle live tree panel above input
		if (key.ctrl && input === "b") {
			setTreePanelVisible(v => !v);
			return;
		}

		if (completionState) {
			if (key.tab || key.return) {
				const item = completionState.result.items[completionState.selectedIndex];
				if (item) acceptCompletion(item, completionState.result);
				return;
			} else if (input === " " && !key.ctrl && !key.meta) {
				setCompletionState(null);
				// Fall through so space inserts as printable char
			} else if (key.upArrow) {
				const next = completionState.selectedIndex > 0
					? completionState.selectedIndex - 1
					: completionState.result.items.length - 1;
				setCompletionState({ ...completionState, selectedIndex: next });
				return;
			} else if (key.downArrow) {
				const next = completionState.selectedIndex < completionState.result.items.length - 1
					? completionState.selectedIndex + 1
					: 0;
				setCompletionState({ ...completionState, selectedIndex: next });
				return;
			} else if (key.escape) {
				setCompletionState(null);
				// In multiline, fall through so the editor's Esc-Esc
				// timestamp tracker still sees this keystroke. Single-line
				// consumes (popup-close is the only effect).
				if (!multilineModeRef.current) return;
			}
		}

		const handle = inputHandleRef.current;
		if (!handle) return;

		// ── Multiline-specific dispatch ─────────────────────────
		if (multilineModeRef.current) {
			// F5 — run script (HISE compile shortcut)
			if (f5PressedRef.current) {
				f5PressedRef.current = false;
				setCompletionState(null);
				handle.submit();
				return;
			}
			// F7 — validate + dry-run + save (no execution)
			if (f7PressedRef.current) {
				f7PressedRef.current = false;
				setCompletionState(null);
				const value = handle.getValue();
				void validateAndSaveScript(value);
				return;
			}
			// Ctrl+Enter → submit
			if (key.ctrl && key.return) {
				setCompletionState(null);
				handle.submit();
				return;
			}
			// Plain Enter → newline
			if (key.return) {
				setCompletionState(null);
				handle.insertChar("\n");
				setEditorValueVersion(v => v + 1);
				return;
			}
			// Esc Esc within 500ms → exit multiline
			if (key.escape) {
				const now = Date.now();
				if (escTimestampRef.current > 0 && (now - escTimestampRef.current) < 500) {
					escTimestampRef.current = 0;
					setCompletionState(null);
					editorContentRef.current = handle.getValue();
					setMultilineMode(false);
					setEditorErrorLines(undefined);
					handle.setValue("");
					setEditorValueVersion(v => v + 1);
					void session.refreshScriptFileCache();
				} else {
					escTimestampRef.current = now;
					handleEscape();
				}
				return;
			}
			// Up/Down navigate cursor by line
			if (key.upArrow) { handle.moveCursor("up", key.shift); return; }
			if (key.downArrow) { handle.moveCursor("down", key.shift); return; }
			// Home/End → line-level
			if (key.home) { handle.moveCursor("lineHome", key.shift); return; }
			if (key.end) { handle.moveCursor("lineEnd", key.shift); return; }
			// Cursor left/right
			if (key.leftArrow) { handle.moveCursor("left", key.shift); return; }
			if (key.rightArrow) { handle.moveCursor("right", key.shift); return; }
			// Backspace / Delete (forward)
			if (key.backspace || key.delete) {
				if (deleteForwardRef.current) {
					deleteForwardRef.current = false;
					handle.deleteForward();
				} else {
					handle.deleteBackward();
				}
				setEditorValueVersion(v => v + 1);
				return;
			}
			// Ctrl+A / Ctrl+Z / Ctrl+Y / Ctrl+C / Ctrl+D — same as single-line
			if (key.ctrl && input === "a") { handle.selectAll(); return; }
			if (key.ctrl && input === "z") { handle.undo(); setEditorValueVersion(v => v + 1); return; }
			if (key.ctrl && input === "y") { handle.redo(); setEditorValueVersion(v => v + 1); return; }
			if (key.ctrl && input === "c") {
				const sel = handle.getSelection();
				if (sel) process.stdout.write(`\x1b]52;c;${Buffer.from(sel.text).toString("base64")}\x07`);
				return;
			}
			if (key.tab) { handleTab(); return; }
			// Printable
			if (input && !key.ctrl && !key.meta) {
				if (input.charCodeAt(0) < 0x20 && input !== "\n") return;
				const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
				const cleaned = normalized.replace(/[^\n\x20-\x7e\x80-￿]/g, "");
				if (cleaned) {
					handle.insertChar(cleaned);
					setEditorValueVersion(v => v + 1);
				}
				return;
			}
			return;
		}

		if (key.return) {
			setCompletionState(null);
			handle.submit();
			return;
		}
		if (key.escape) {
			handleEscape();
			return;
		}
		if (key.ctrl && input === "a") { handle.selectAll(); return; }
		if (key.ctrl && input === "c") {
			const sel = handle.getSelection();
			if (sel) {
				process.stdout.write(`\x1b]52;c;${Buffer.from(sel.text).toString("base64")}\x07`);
			} else if (handle.getValue().length === 0) {
				gracefulExit();
			} else {
				handle.setValue("");
			}
			return;
		}
		if (key.ctrl && input === "d") {
			if (handle.getValue().length === 0) { gracefulExit(); return; }
			handle.deleteForward();
			return;
		}
		if (key.ctrl && input === "z") { handle.undo(); return; }
		if (key.ctrl && input === "y") { handle.redo(); return; }
		if (key.ctrl && input === "e") { handle.moveCursor("end"); return; }
		if (key.meta && key.leftArrow) { handle.moveCursor("home", key.shift); return; }
		if (key.meta && key.rightArrow) { handle.moveCursor("end", key.shift); return; }
		if (key.meta && input === "b") { handle.moveCursor("wordLeft"); return; }
		if (key.meta && input === "f") { handle.moveCursor("wordRight"); return; }
		if (key.home) { handle.moveCursor("home", key.shift); return; }
		if (key.end) { handle.moveCursor("end", key.shift); return; }
		if (key.upArrow) { handle.historyUp(); return; }
		if (key.downArrow) { handle.historyDown(); return; }
		if (key.leftArrow) { handle.moveCursor("left", key.shift); return; }
		if (key.rightArrow) { handle.moveCursor("right", key.shift); return; }
		if (key.backspace || key.delete) {
			if (deleteForwardRef.current) {
				deleteForwardRef.current = false;
				handle.deleteForward();
			} else {
				handle.deleteBackward();
			}
			return;
		}
		if (key.tab) { handleTab(); return; }
		if (input && !key.ctrl && !key.meta) {
			const code = input.charCodeAt(0);
			if (code < 0x20 || code === 0x7f) return;
			handle.insertChar(input);
		}
	});

	const treePanelText = useMemo<string | null>(() => {
		if (!treePanelVisible) return null;
		const mode = session.currentMode();
		if (!mode.getTree) return null;
		const tree = mode.getTree();
		if (!tree) return null;

		const path = mode.getSelectedPath?.() ?? [];
		const root: TreeNode = path.length > 0 ? (resolveNodeByPath(tree, path) ?? tree) : tree;
		const maxRows = Math.max(6, Math.floor(terminalRows / 2));
		const compact = (mode as { compactView?: boolean }).compactView === true;
		// Panel is rooted at PWD, so its first row IS the PWD — skip the
		// signal-colour highlight inside the tree (kept for `show tree`
		// command which renders the full tree). Only the breadcrumb's last
		// segment carries the PWD highlight here.
		const opts = { mutedColor: scheme.foreground.muted, compact };

		// Breadcrumb (always visible, prefixed with mode-specific tree
		// context label). Walks tree root → PWD; muted segments + signal
		// final segment.
		const dim = fgHex(scheme.foreground.muted);
		const sig = fgHex(brand.signal);
		const sep = `${dim} / ${RESET}`;
		const segs: string[] = [];
		segs.push((path.length === 0 ? sig : dim) + tree.label + RESET);
		let cur: TreeNode = tree;
		for (let i = 0; i < path.length; i++) {
			if (!cur.children) break;
			const lower = path[i]!.toLowerCase();
			const child = cur.children.find((c) => c.id?.toLowerCase() === lower);
			if (!child) break;
			const isLast = i === path.length - 1;
			segs.push((isLast ? sig : dim) + child.label + RESET);
			cur = child;
		}
		let prefix: string;
		if (mode.id === "builder") {
			prefix = "Module-Tree";
		} else if (mode.id === "ui") {
			prefix = `Component-Tree (${tree.label})`;
		} else if (mode.id === "dsp") {
			const ctxLabel = mode.contextLabel ?? "";
			const moduleId = ctxLabel.split("/")[0] ?? "";
			prefix = `DspNetwork Tree (${moduleId}.${tree.label})`;
		} else if (mode.id === "script") {
			prefix = `Script Symbol Tree (${tree.label})`;
		} else {
			prefix = "Tree";
		}
		const breadcrumb = `${dim}${prefix}: ${RESET}` + segs.join(sep);

		let lines = renderTreeBox(root, opts).split("\n");
		if (lines.length > maxRows) {
			lines = renderTreeBox(root, { ...opts, maxDepth: 1 }).split("\n");
		}
		if (lines.length > maxRows) {
			lines = [
				...lines.slice(0, maxRows - 1),
				`${dim}… +${lines.length - maxRows + 1} more rows${RESET}`,
			];
		}
		return [breadcrumb, "", ...lines].join("\n");
		// modeRenderTick: re-runs after every command (bumpModeRender fires post-submit).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [treePanelVisible, modeRenderTick, columns, terminalRows, scheme, session]);

	const popupLeftOffset = useMemo(() => {
		if (!completionState) return 0;
		if (multilineMode) {
			// Multiline editor: gutter = horizontalPad + lineNumberWidth + indicator + space.
			// result.from is absolute; need column within the current line.
			const val = inputHandleRef.current?.getValue() ?? "";
			const lines = val.split("\n");
			const maxLineNum = Math.max(lines.length, editorMaxLines);
			const lineNumberWidth = String(maxLineNum).length;
			const gutterW = COMPACT.horizontalPad + lineNumberWidth + 2;
			const { line: lineIdx } = offsetToLineCol(val, completionState.result.from);
			const lineStart = lineColToOffset(val, lineIdx, 0);
			const lineRelFrom = completionState.result.from - lineStart;
			return Math.min(columns - 4, gutterW + lineRelFrom);
		}
		// Flat single-line prompt: "> " = 2 chars, no left pad
		const promptW = 2;
		const lineRel = completionState.result.from;
		return Math.min(columns - 4, promptW + lineRel);
	}, [completionState, columns, multilineMode, editorMaxLines]);

	const wizardBlockText = useMemo(() => {
		if (!wizardForm) return null;
		return renderWizardBlock(wizardForm, scheme, columns - 4, { flat: true }).lines.join("\n");
	}, [wizardForm, scheme, columns]);

	return (
		<>
			<Static items={committed}>
				{(block) => <Text key={block.id}>{block.text}</Text>}
			</Static>
			<Box flexDirection="column" width={columns} overflow="hidden">
				{wizardBlockText && (
					<Box
						flexDirection="column"
						width={columns}
						borderStyle="single"
						borderColor={terminalFocused ? brand.signal : scheme.foreground.muted}
						paddingX={1}
					>
						<Text>{wizardBlockText}</Text>
					</Box>
				)}
				{!wizardForm && !wizardActive && treePanelText && (
					<>
						<Text color={scheme.foreground.muted} wrap="truncate-end">{"─".repeat(columns)}</Text>
						<Text wrap="truncate-end">{treePanelText}</Text>
					</>
				)}
				{!wizardForm && !wizardActive && aiPreview && (
					<Box
						flexDirection="column"
						width={columns}
						borderStyle="single"
						borderColor={brand.signal}
						paddingX={1}
					>
						<Text color={scheme.foreground.muted}>{"? "}<Text color={scheme.foreground.default}>{aiPreview.nl}</Text></Text>
						{aiPreview.pending ? (
							<Text color={brand.signal}>{spinnerFrames[spinnerFrame]} thinking via {getProviderLabel()}…  <Text color={scheme.foreground.muted}>(esc cancel)</Text></Text>
						) : aiPreview.preludeError ? (
							<>
								<Text color={brand.error}>{aiPreview.preludeError}</Text>
								<Text color={scheme.foreground.muted}>esc dismiss</Text>
							</>
						) : aiPreview.outcome?.ok ? (
							<>
								<Text color={scheme.foreground.bright}>{"→ "}{aiPreview.outcome.result.command}</Text>
								<Text color={scheme.foreground.muted}>↵ execute   esc cancel   r retry   <Text color={scheme.foreground.muted}>({aiPreview.outcome.result.durationMs}ms via {getProviderLabel()})</Text></Text>
							</>
						) : aiPreview.outcome ? (
							<>
								<Text color={brand.error}>error: {aiPreview.outcome.error}</Text>
								<Text color={scheme.foreground.muted}>esc dismiss   r retry</Text>
							</>
						) : null}
					</Box>
				)}
				{!wizardForm && !wizardActive && (
					<Input
						modeLabel={multilineMode ? (editorFilePath?.split(/[\\/]/).pop() ?? "scratch") : "root"}
						modeAccent={modeAccent}
						contextLabel={multilineMode ? (editorFilePath ?? undefined) : undefined}
						columns={columns}
						disabled={disabled}
						focused={terminalFocused && !aiPreview}
						flat={!multilineMode}
						multiline={multilineMode}
						maxLines={editorMaxLines}
						errorLines={multilineMode ? editorErrorLines : undefined}
						onSubmit={(v) => { void handleSubmit(v); }}
						onValueChange={(value, cursorPos) => {
							if (multilineModeRef.current) {
								setEditorValueVersion(v => v + 1);
								if (editorErrorLines !== undefined) setEditorErrorLines(undefined);
							}
							handleInputValueChange(value, cursorPos);
						}}
						inputRef={inputHandleRef}
						tokenize={modeTokenizer}
					/>
				)}
				{(() => {
					if (wizardForm || wizardActive || multilineMode) return null;
					const popupScheme: ColorScheme = {
						...scheme,
						backgrounds: { ...scheme.backgrounds, overlay: undefined as unknown as string },
					};
					const dim = terminalFocused ? brand.signal : scheme.foreground.muted;
					const blank = " ".repeat(Math.max(1, columns));
					return (
						<Box flexDirection="column" width={columns}>
							{completionState ? (
								<CompletionPopup
									items={completionState.result.items}
									selectedIndex={completionState.selectedIndex}
									onSelect={(i) => setCompletionState((p) => p ? { ...p, selectedIndex: i } : null)}
									onAccept={(item) => acceptCompletion(item, completionState.result)}
									onDismiss={() => setCompletionState(null)}
									scheme={popupScheme}
									leftOffset={popupLeftOffset}
									label={completionState.result.label}
									maxVisible={COMPACT.completionMaxVisible}
									columns={columns}
								/>
							) : frozenPopupRows > 0 ? (
								Array.from({ length: frozenPopupRows }).map((_, i) => (
									<Text key={`frozen-${i}`}>{blank}</Text>
								))
							) : null}
							<Text>{" "}</Text>
							<StatusLine
								modeLabel={modeLabel}
								modeAccent={modeAccent}
								contextLabel={contextLabel}
								connectionStatus={connectionStatus}
								columns={columns}
								scheme={scheme}
								projectName={session.projectName}
								projectFolder={session.projectFolder}
							/>
							<Text color={dim} wrap="truncate-end">{"─".repeat(columns)}</Text>
						</Box>
					);
				})()}
				{!wizardForm && !wizardActive && multilineMode && (
					<>
						{completionState && (
							<CompletionPopup
								items={completionState.result.items}
								selectedIndex={completionState.selectedIndex}
								onSelect={(i) => setCompletionState((p) => p ? { ...p, selectedIndex: i } : null)}
								onAccept={(item) => acceptCompletion(item, completionState.result)}
								onDismiss={() => setCompletionState(null)}
								scheme={scheme}
								leftOffset={popupLeftOffset}
								label={completionState.result.label}
								maxVisible={COMPACT.completionMaxVisible}
								columns={columns}
							/>
						)}
						<StatusLine
							modeLabel={modeLabel}
							modeAccent={modeAccent}
							contextLabel={contextLabel}
							connectionStatus={connectionStatus}
							columns={columns}
							scheme={scheme}
						/>
					</>
				)}
				{(wizardForm || wizardActive) && (
					<StatusLine
						modeLabel={modeLabel}
						modeAccent={modeAccent}
						contextLabel={contextLabel}
						connectionStatus={connectionStatus}
						columns={columns}
						scheme={scheme}
					/>
				)}
			</Box>
		</>
	);
}

const POPUP_RESERVED_ROWS = COMPACT.completionMaxVisible + 2;

interface StatusLineProps {
	modeLabel: string;
	modeAccent: string;
	contextLabel?: string;
	connectionStatus: ConnectionStatus;
	columns: number;
	scheme: ColorScheme;
	projectName?: string | null;
	projectFolder?: string | null;
}

function StatusLine({ modeLabel, modeAccent, contextLabel, connectionStatus, columns, scheme, projectName, projectFolder }: StatusLineProps): React.ReactElement {
	const dotColor = statusColor(connectionStatus);
	const connLabel = connectionStatus === "connected" ? "HISE" : connectionStatus === "warning" ? "…" : "offline";
	const padW = COMPACT.horizontalPad;
	const muted = scheme.foreground.muted;
	const def = scheme.foreground.default;

	// Plain text segments for length math
	let leftPlain = modeLabel;
	if (contextLabel) leftPlain += ` · ${contextLabel}`;
	if (projectName) leftPlain += ` · ${projectName}`;
	if (projectFolder) leftPlain += ` | ${projectFolder}`;
	const connPlain = `● ${connLabel}`;

	const inner = Math.max(0, columns - padW * 2);
	const minGap = 2;
	const maxLeft = Math.max(0, inner - connPlain.length - minGap);
	let leftText = leftPlain;
	if (leftPlain.length > maxLeft) {
		leftText = leftPlain.slice(0, Math.max(0, maxLeft - 1)) + "…";
	}
	const filler = Math.max(minGap, inner - leftText.length - connPlain.length);

	// Build a single ANSI-colored string. Reconstruct colored segments
	// while reusing leftText for total width.
	let leftColored = "";
	if (leftText === leftPlain) {
		leftColored = `${fgHex(modeAccent)}\x1b[1m${modeLabel}${RESET}`;
		if (contextLabel) leftColored += `${fgHex(muted)} · ${RESET}${fgHex(def)}${contextLabel}${RESET}`;
		if (projectName) leftColored += `${fgHex(muted)} · ${RESET}${fgHex(def)}${projectName}${RESET}`;
		if (projectFolder) leftColored += `${fgHex(muted)} | ${fgHex(muted)}${projectFolder}${RESET}`;
	} else {
		// Fallback: render truncated plain string (no per-segment color)
		leftColored = `${fgHex(modeAccent)}${leftText}${RESET}`;
	}
	const connColored = `${fgHex(dotColor)}● ${RESET}${fgHex(muted)}${connLabel}${RESET}`;
	const padStr = " ".repeat(padW);
	const fullLine = `${padStr}${leftColored}${" ".repeat(filler)}${connColored}${padStr}`;

	return (
		<Box width={columns}>
			<Text wrap="truncate-end">{fullLine}</Text>
		</Box>
	);
}

// ── Undo mode — history navigation, TUI plan groups ──────────────────
//
// Phase 4.3: Top-level /undo mode providing undo/redo, plan groups
// (push_group/pop_group), and history visualization in the sidebar.
// Supports inline one-shot calls from other modes (/undo back).

import type { CommandResult, TreeNode } from "../result.js";
import {
	errorResult,
	tableResult,
	textResult,
} from "../result.js";
import type { TokenSpan } from "../highlight/tokens.js";
import { tokenizeUndo } from "../highlight/undo.js";
import type { CompletionResult, Mode, SessionContext } from "./mode.js";
import { MODE_ACCENTS } from "./mode.js";
import type { CompletionEngine } from "../completion/engine.js";
import {
	isErrorResponse,
	isEnvelopeResponse,
} from "../hise.js";
import {
	normalizeUndoHistoryResponse,
	normalizeUndoDiffResponse,
	buildHistoryTree,
	historySelectedPath,
	type UndoHistoryResponse,
	type UndoDiffEntry,
} from "../../mock/contracts/undo.js";

export class UndoMode implements Mode {
	readonly id: Mode["id"] = "undo";
	readonly name = "Undo";
	readonly accent = MODE_ACCENTS.undo;

	private inPlan = false;
	private planName = "";
	private historyData: UndoHistoryResponse | null = null;
	private planDiff: UndoDiffEntry[] | null = null;
	private historyFetched = false;

	private readonly completionEngine: CompletionEngine | null;

	constructor(completionEngine?: CompletionEngine) {
		this.completionEngine = completionEngine ?? null;
	}

	/** Reset local plan tracking state. Called when HISE discards groups externally (e.g. builder reset). */
	resetPlanState(): void {
		this.inPlan = false;
		this.planName = "";
		this.planDiff = null;
	}

	get prompt(): string {
		return this.inPlan ? `[plan:${this.planName}] > ` : "[undo] > ";
	}

	tokenizeInput(value: string): TokenSpan[] {
		return tokenizeUndo(value);
	}

	// ── Tree sidebar support ────────────────────────────────────

	getTree(): TreeNode | null {
		return buildHistoryTree(
			this.historyData ?? { scope: "group", groupName: "root", cursor: -1, history: [] },
			this.inPlan ? this.planDiff : null,
			this.inPlan ? this.planName : null,
		);
	}

	getSelectedPath(): string[] {
		if (!this.historyData) return [];
		return historySelectedPath(this.historyData.cursor);
	}

	selectNode(_path: string[]): void {
		// History nodes are read-only; no navigation needed
	}

	// ── Completion ──────────────────────────────────────────────

	complete(input: string, _cursor: number): CompletionResult {
		if (!this.completionEngine) {
			return { items: [], from: 0, to: input.length };
		}

		const trimmed = input.trimStart();
		const leadingSpaces = input.length - trimmed.length;
		const items = this.completionEngine.completeUndo(trimmed, this.inPlan);
		return { items, from: leadingSpaces, to: input.length, label: "Undo commands" };
	}

	// ── Parse entry point ───────────────────────────────────────

	async parse(
		input: string,
		session: SessionContext,
	): Promise<CommandResult> {
		const trimmed = input.trim();
		const parts = trimmed.split(/\s+/);
		const keyword = parts[0]?.toLowerCase();

		if (!session.connection) {
			return errorResult("Undo mode requires a HISE connection.");
		}

		const conn = session.connection;
		await this.ensureHistory(conn);
		await this.syncPlanState(conn);

		const cliPlanCommands = new Set(["plan", "apply", "discard", "diff"]);
		if (session.forLlm && cliPlanCommands.has(keyword ?? "")) {
			return errorResult(
				`Undo plan groups are only available in the interactive TUI. ` +
				`CLI automation should run direct commands or use .hsc scripts. ` +
				`Available CLI undo commands: back, forward, clear, history`,
			);
		}

		// Commands that mutate state — invalidate all mode trees after
		const MUTATING = new Set(["back", "forward", "clear", "apply", "discard"]);

		let result: CommandResult;
		switch (keyword) {
			case "back":
				result = await this.handleBack(conn);
				break;

			case "forward":
				result = await this.handleForward(conn);
				break;

			case "clear":
				result = await this.handleClear(conn);
				break;

			case "plan": {
				if (this.inPlan) return errorResult("Already in a plan group.");
				const name = extractQuotedArg(trimmed.slice(4).trim()) || "Plan";
				result = await this.handlePlan(conn, name);
				break;
			}

			case "apply":
				if (!this.inPlan) return errorResult("Not in a plan group.");
				result = await this.handleApply(conn);
				break;

			case "discard":
				if (!this.inPlan) return errorResult("Not in a plan group.");
				result = await this.handleDiscard(conn);
				break;

			case "diff":
				return this.handleDiff(conn);

			case "history":
				return this.handleHistory(conn);

			default:
				return errorResult(
					`Unknown undo command: "${keyword ?? ""}". ` +
					(session.forLlm
						? `Available: back, forward, clear, history`
						: `Available: back, forward, clear, plan, apply, discard, diff, history`),
				);
		}

		// After mutating undo operations, invalidate all mode trees
		// so builder/ui/etc re-fetch their state on next access
		if (MUTATING.has(keyword!) && result.type !== "error") {
			session.invalidateAllTrees?.();
		}

		return result;
	}

	// ── Command handlers ────────────────────────────────────────

	private async handleBack(
		conn: import("../hise.js").HiseConnection,
	): Promise<CommandResult> {
		const response = await conn.post("/api/undo/back", {});
		if (isErrorResponse(response)) return errorResult(response.message);
		if (!isEnvelopeResponse(response) || !response.success) {
			const msg = response.errors?.[0]?.errorMessage ?? "Nothing to undo";
			return errorResult(msg);
		}
		await this.refreshHistory(conn);
		const diff = normalizeUndoDiffResponse(response);
		const summary = diff?.diff.length
			? diff.diff.map((d) => `${d.action} ${d.target}`).join(", ")
			: "Undone";
		return textResult(`← ${summary}`);
	}

	private async handleForward(
		conn: import("../hise.js").HiseConnection,
	): Promise<CommandResult> {
		const response = await conn.post("/api/undo/forward", {});
		if (isErrorResponse(response)) return errorResult(response.message);
		if (!isEnvelopeResponse(response) || !response.success) {
			const msg = response.errors?.[0]?.errorMessage ?? "Nothing to redo";
			return errorResult(msg);
		}
		await this.refreshHistory(conn);
		const diff = normalizeUndoDiffResponse(response);
		const summary = diff?.diff.length
			? diff.diff.map((d) => `${d.action} ${d.target}`).join(", ")
			: "Redone";
		return textResult(`→ ${summary}`);
	}

	private async handleClear(
		conn: import("../hise.js").HiseConnection,
	): Promise<CommandResult> {
		await conn.post("/api/undo/clear", {});
		this.inPlan = false;
		this.planName = "";
		this.planDiff = null;
		this.historyData = { scope: "group", groupName: "root", cursor: -1, history: [] };
		return textResult("Undo history cleared.");
	}

	private async handlePlan(
		conn: import("../hise.js").HiseConnection,
		name: string,
	): Promise<CommandResult> {
		const response = await conn.post("/api/undo/push_group", { name });
		if (isErrorResponse(response)) return errorResult(response.message);
		if (isEnvelopeResponse(response) && !response.success) {
			const msg = response.errors?.[0]?.errorMessage ?? "Failed to start plan group";
			return errorResult(msg);
		}
		this.inPlan = true;
		this.planName = name;
		this.planDiff = [];
		await this.refreshHistory(conn);
		const result = textResult(`Started plan "${name}". Use apply/discard to finish.`);
		result.accent = this.accent;
		return result;
	}

	private async handleApply(
		conn: import("../hise.js").HiseConnection,
	): Promise<CommandResult> {
		const response = await conn.post("/api/undo/pop_group", { cancel: false });
		if (isErrorResponse(response)) return errorResult(response.message);
		this.inPlan = false;
		const appliedName = this.planName;
		this.planName = "";
		this.planDiff = null;
		await this.refreshHistory(conn);
		const diff = normalizeUndoDiffResponse(response);
		const count = diff?.diff.length ?? 0;
		return textResult(`Applied "${appliedName}" (${count} change${count !== 1 ? "s" : ""}).`);
	}

	private async handleDiscard(
		conn: import("../hise.js").HiseConnection,
	): Promise<CommandResult> {
		const response = await conn.post("/api/undo/pop_group", { cancel: true });
		if (isErrorResponse(response)) return errorResult(response.message);
		const discardedName = this.planName;
		this.inPlan = false;
		this.planName = "";
		this.planDiff = null;
		await this.refreshHistory(conn);
		return textResult(`Discarded "${discardedName}".`);
	}

	private async handleDiff(
		conn: import("../hise.js").HiseConnection,
	): Promise<CommandResult> {
		const response = await conn.get("/api/undo/diff?scope=group&flatten=true");
		if (isErrorResponse(response)) return errorResult(response.message);
		if (!isEnvelopeResponse(response) || !response.success) {
			return errorResult("Failed to fetch diff.");
		}
		const diff = normalizeUndoDiffResponse(response);
		if (!diff || diff.diff.length === 0) {
			return textResult("No changes.");
		}
		return tableResult(
			["Action", "Target", "Domain"],
			diff.diff.map((d) => [d.action, d.target, d.domain]),
		);
	}

	private async handleHistory(
		conn: import("../hise.js").HiseConnection,
	): Promise<CommandResult> {
		await this.refreshHistory(conn);
		if (!this.historyData || this.historyData.history.length === 0) {
			return textResult("No undo history.");
		}
		return tableResult(
			["#", "Name", "Actions", ""],
			this.historyData.history.map((e) => [
				String(e.index),
				e.name || "(unnamed)",
				String(e.count),
				e.index === this.historyData!.cursor ? "←" : "",
			]),
		);
	}

	// ── Internal helpers ────────────────────────────────────────

	/** Sync local plan state with HISE's actual undo group state.
	 *  Needed for CLI one-shot mode where each invocation gets a fresh instance. */
	private async syncPlanState(
		conn: import("../hise.js").HiseConnection,
	): Promise<void> {
		if (this.inPlan) return; // already tracking locally (TUI session)
		const resp = await conn.get("/api/undo/diff?scope=group");
		if (!isEnvelopeResponse(resp) || !resp.success) return;
		const groupName = resp.groupName as string | undefined;
		if (typeof groupName === "string" && groupName !== "root") {
			this.inPlan = true;
			this.planName = groupName;
		}
	}

	/** Fetch history on mode entry so the sidebar shows content immediately. */
	async onEnter(session: SessionContext): Promise<void> {
		if (session.connection) {
			await this.refreshHistory(session.connection);
			this.historyFetched = true;
		}
	}

	/** Lazily fetch history on first parse if not yet fetched. */
	private async ensureHistory(
		conn: import("../hise.js").HiseConnection,
	): Promise<void> {
		if (!this.historyFetched) {
			this.historyFetched = true;
			await this.refreshHistory(conn);
		}
	}

	/** Mark history as stale so it re-fetches on next parse. */
	invalidateTree(): void {
		this.historyFetched = false;
	}

	private async refreshHistory(
		conn: import("../hise.js").HiseConnection,
	): Promise<void> {
		const response = await conn.get("/api/undo/history");
		if (isEnvelopeResponse(response) && response.success) {
			this.historyData = normalizeUndoHistoryResponse(response);
		}

		// Also refresh plan diff if in a plan
		if (this.inPlan) {
			const diffResp = await conn.get("/api/undo/diff?scope=group&flatten=true");
			if (isEnvelopeResponse(diffResp) && diffResp.success) {
				const diff = normalizeUndoDiffResponse(diffResp);
				this.planDiff = diff?.diff ?? [];
			}
		}
	}
}

/** Extract a quoted string argument, or return the raw string. */
function extractQuotedArg(s: string): string {
	const match = s.match(/^"([^"]*)"/) ?? s.match(/^'([^']*)'/);
	return match ? match[1]! : s;
}

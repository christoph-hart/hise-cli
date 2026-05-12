// ── HISE control mode — launch, shutdown, screenshot, profile ───────

import {
	isErrorResponse,
	isEnvelopeResponse,
	isSuccessResponse,
	type HiseResponse,
} from "../hise.js";
import type { CommandResult } from "../result.js";
import { errorResult, markdownResult, textResult } from "../result.js";
import type { CompletionResult, Mode, SessionContext } from "./mode.js";
import { MODE_ACCENTS } from "./mode.js";
import type { CompletionEngine } from "../completion/engine.js";

// ── HiseLauncher — platform abstraction for spawning HISE ──────────

/** Fire-and-forget process launcher (zero node: imports). */
export interface HiseLauncher {
	/** Spawn a detached process. Resolves once confirmed started; rejects on ENOENT. */
	spawnDetached(command: string, args: string[]): Promise<void>;
}

// ── Thread name normalisation ──────────────────────────────────────

const THREAD_ALIASES: Record<string, string> = {
	audio: "Audio Thread",
	ui: "UI Thread",
	scripting: "Scripting Thread",
	script: "Scripting Thread",
};

function normalizeThreadName(raw: string): string | null {
	const lower = raw.toLowerCase();
	if (THREAD_ALIASES[lower]) return THREAD_ALIASES[lower];
	// Already a full name like "Audio Thread"?
	const full = Object.values(THREAD_ALIASES);
	if (full.some((t) => t.toLowerCase() === lower)) {
		return full.find((t) => t.toLowerCase() === lower)!;
	}
	return null;
}

// ── Screenshot clause parsing ──────────────────────────────────────

interface ScreenshotOptions {
	id?: string;
	scale?: number;
	outputPath?: string;
}

function parseScreenshotClauses(args: string): ScreenshotOptions {
	const opts: ScreenshotOptions = {};

	// "of <id>"
	const ofMatch = args.match(/\bof\s+(\S+)/i);
	if (ofMatch) opts.id = ofMatch[1];

	// "at <N>%" or "at <0.N>"
	const atPercentMatch = args.match(/\bat\s+(\d+)%/i);
	if (atPercentMatch) {
		opts.scale = parseInt(atPercentMatch[1], 10) / 100;
	} else {
		const atDecimalMatch = args.match(/\bat\s+(0?\.\d+|\d+\.\d+)/i);
		if (atDecimalMatch) opts.scale = parseFloat(atDecimalMatch[1]);
	}

	// "to <path>"
	const toMatch = args.match(/\bto\s+(\S+)/i);
	if (toMatch) opts.outputPath = toMatch[1];

	return opts;
}

// ── Profile clause parsing ─────────────────────────────────────────

interface ProfileOptions {
	threadFilter?: string[];
	durationMs: number;
}

function parseProfileClauses(args: string): ProfileOptions | string {
	const opts: ProfileOptions = { durationMs: 1000 };

	// "thread <name>"
	const threadMatch = args.match(/\bthread\s+(\S+)/i);
	if (threadMatch) {
		const name = normalizeThreadName(threadMatch[1]);
		if (!name) return `Unknown thread "${threadMatch[1]}". Valid: audio, ui, scripting`;
		opts.threadFilter = [name];
	}

	// "for <N>ms"
	const forMatch = args.match(/\bfor\s+(\d+)\s*ms/i);
	if (forMatch) {
		opts.durationMs = parseInt(forMatch[1], 10);
		if (opts.durationMs < 100 || opts.durationMs > 5000) {
			return "Duration must be between 100ms and 5000ms";
		}
	}

	return opts;
}

// ── Subcommand definitions ─────────────────────────────────────────

const HISE_COMMANDS = new Map<string, string>([
	["status", "Show connection status and project info"],
	["launch", "Launch HISE and wait for connection"],
	["shutdown", "Gracefully quit HISE"],
	["screenshot", "Capture interface screenshot"],
	["profile", "Record and display a performance profile"],
	["playground", "Snippet browser control (open/close/enable/disable)"],
	["help", "Show available commands"],
]);

const PLAYGROUND_ACTIONS: Record<string, string> = {
	open: "launch",
	close: "shutdown",
	enable: "enable",
	disable: "disable",
};

// ── Delay utility ──────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── HiseMode class ─────────────────────────────────────────────────

export class HiseMode implements Mode {
	readonly id: Mode["id"] = "hise";
	readonly name = "HISE";
	readonly accent = MODE_ACCENTS.hise;
	readonly prompt = "hise";
	private readonly launcher: HiseLauncher | null;
	private readonly completionEngine: CompletionEngine | null;

	constructor(
		launcher: HiseLauncher | null,
		completionEngine?: CompletionEngine,
	) {
		this.launcher = launcher;
		this.completionEngine = completionEngine ?? null;
	}

	complete(input: string, _cursor: number): CompletionResult {
		const trimmed = input.trimStart();
		const leadingSpaces = input.length - trimmed.length;
		const parts = trimmed.split(/\s+/);
		const cmd = parts[0]?.toLowerCase() ?? "";

		// Complete subcommand name
		if (parts.length <= 1) {
			const items = [...HISE_COMMANDS.entries()]
				.filter(([name]) => name.startsWith(cmd))
				.map(([name, desc]) => ({ label: name, detail: desc }));
			return { items, from: leadingSpaces, to: input.length, label: "HISE commands" };
		}

		// Keyword completions per subcommand
		const tail = parts.slice(1).join(" ");
		const tailFrom = leadingSpaces + parts[0].length + 1;

		if (cmd === "status") {
			const fields = [
				{ label: "project", detail: "Project name" },
				{ label: "folder", detail: "Project folder path" },
				{ label: "online", detail: "Connection status (true/false)" },
			];
			const items = fields.filter((f) => f.label.startsWith(tail.toLowerCase()));
			return { items, from: tailFrom, to: input.length };
		}

		if (cmd === "launch") {
			const items = ["debug"]
				.filter((k) => k.startsWith(tail.toLowerCase()))
				.map((k) => ({ label: k, detail: "Launch HISE Debug build" }));
			return { items, from: tailFrom, to: input.length };
		}

		if (cmd === "playground") {
			const details: Record<string, string> = {
				open: "Open snippet browser",
				close: "Close snippet browser",
				enable: "Switch to snippet browser",
				disable: "Switch back to main project",
			};
			const items = Object.keys(PLAYGROUND_ACTIONS)
				.filter((k) => k.startsWith(tail.toLowerCase()))
				.map((k) => ({ label: k, detail: details[k] }));
			return { items, from: tailFrom, to: input.length };
		}

		if (cmd === "screenshot") {
			const keywords = ["of", "at", "to"];
			const lastWord = parts[parts.length - 1].toLowerCase();
			const wordFrom = input.length - parts[parts.length - 1].length;
			const items = keywords
				.filter((k) => k.startsWith(lastWord) && !tail.toLowerCase().includes(k + " "))
				.map((k) => ({ label: k }));
			return { items, from: wordFrom, to: input.length };
		}

		if (cmd === "profile") {
			const lastWord = parts[parts.length - 1].toLowerCase();
			const wordFrom = input.length - parts[parts.length - 1].length;
			const prevWord = parts.length >= 3 ? parts[parts.length - 2].toLowerCase() : "";

			if (prevWord === "thread") {
				const threads = ["audio", "ui", "scripting"];
				const items = threads
					.filter((t) => t.startsWith(lastWord))
					.map((t) => ({ label: t, detail: THREAD_ALIASES[t] }));
				return { items, from: wordFrom, to: input.length };
			}

			const keywords = ["thread", "for"];
			const items = keywords
				.filter((k) => k.startsWith(lastWord) && !tail.toLowerCase().includes(k + " "))
				.map((k) => ({ label: k }));
			return { items, from: wordFrom, to: input.length };
		}

		return { items: [], from: input.length, to: input.length };
	}

	async parse(input: string, session: SessionContext): Promise<CommandResult> {
		const trimmed = input.trim();
		const spaceIdx = trimmed.indexOf(" ");
		const command = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
		const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

		if (!command || command === "help") {
			return this.showHelp();
		}

		if (!HISE_COMMANDS.has(command)) {
			return errorResult(`Unknown command: "${command}". Type "help" for available commands.`);
		}

		switch (command) {
			case "status":
				return this.handleStatus(args, session);
			case "launch":
				return this.handleLaunch(args, session);
			case "shutdown":
				return this.handleShutdown(session);
			case "screenshot":
				return this.handleScreenshot(args, session);
			case "profile":
				return this.handleProfile(args, session);
			case "playground":
				return this.handlePlayground(args, session);
			default:
				return errorResult(`Unhandled command: ${command}`);
		}
	}

	// ── status ────────────────────────────────────────────────────

	private async handleStatus(args: string, session: SessionContext): Promise<CommandResult> {
		const field = args.trim().toLowerCase();

		// Always fetch fresh status from HISE
		let online = false;
		let name = "unknown";
		let folder = "unknown";

		if (session.connection) {
			try {
				const resp = await session.connection.get("/api/status");
				if (isSuccessResponse(resp)) {
					online = true;
					const project = extractProjectFromStatus(resp);
					if (project) {
						name = project.name;
						folder = project.folder;
						session.projectName = name;
						session.projectFolder = folder;
					}
					session.playgroundActive = extractSnippetBrowserActive(resp);
				}
			} catch {
				online = false;
			}
		}

		if (field === "project") return textResult(name);
		if (field === "folder") return textResult(folder);
		if (field === "online") return textResult(String(online));

		if (!online) {
			return textResult("HISE offline.");
		}

		const suffix = session.playgroundActive === true ? " (snippet browser active)" : "";
		return textResult(`HISE online. Project: "${name}" at ${folder}${suffix}`);
	}

	// ── launch ────────────────────────────────────────────────────

	private async handleLaunch(args: string, session: SessionContext): Promise<CommandResult> {
		if (!this.launcher) {
			return errorResult("Launch not available in this environment.");
		}

		// If HISE is already running and reachable, skip spawning
		if (session.connection) {
			const alive = await session.connection.probe();
			if (alive) {
				return textResult("HISE is already running.");
			}
		}

		const isDebug = /^debug$/i.test(args.trim());
		const binary = isDebug ? "HISE Debug" : "HISE";

		try {
			await this.launcher.spawnDetached(binary, ["start_server"]);
		} catch {
			return errorResult(`"${binary}" not found on PATH. Make sure HISE is installed and accessible.`);
		}

		// Poll /api/status until HISE responds (10s timeout, 500ms interval)
		if (!session.connection) {
			return errorResult("No connection configured. Cannot poll for HISE startup.");
		}

		const maxAttempts = 20;
		for (let i = 0; i < maxAttempts; i++) {
			await delay(500);
			const alive = await session.connection.probe();
			if (alive) {
				return this.fetchStatusAfterLaunch(session);
			}
		}

		return errorResult(`${binary} started but did not respond within 10 seconds.`);
	}

	private async fetchStatusAfterLaunch(session: SessionContext): Promise<CommandResult> {
		const resp = await session.connection!.get("/api/status");
		if (isErrorResponse(resp)) {
			return textResult("HISE is running.");
		}
		if (isSuccessResponse(resp)) {
			session.playgroundActive = extractSnippetBrowserActive(resp);
			const project = extractProjectFromStatus(resp);
			if (project) {
				session.projectName = project.name;
				session.projectFolder = project.folder;
				return textResult(`Connected to "${project.name}" at ${project.folder}`);
			}
		}
		return textResult("HISE is running.");
	}

	// ── shutdown ──────────────────────────────────────────────────

	private async handleShutdown(session: SessionContext): Promise<CommandResult> {
		if (!session.connection) {
			return errorResult("No HISE connection.");
		}

		let response: HiseResponse;
		try {
			response = await session.connection.post("/api/shutdown", {});
		} catch {
			// Connection dropped — expected during shutdown
			return textResult("HISE shut down.");
		}

		// If we got a response, HISE accepted the shutdown request
		if (isErrorResponse(response) && /fetch|ECONNREFUSED|socket/i.test(response.message)) {
			return textResult("HISE shut down.");
		}

		if (isErrorResponse(response)) {
			return errorResult(response.message);
		}

		return textResult("HISE shut down.");
	}

	// ── playground ────────────────────────────────────────────────

	private async handlePlayground(args: string, session: SessionContext): Promise<CommandResult> {
		if (!session.connection) {
			return errorResult("No HISE connection.");
		}

		const sub = args.trim().toLowerCase();
		if (!sub || !(sub in PLAYGROUND_ACTIONS)) {
			return errorResult("Usage: playground open|close|enable|disable");
		}

		const response = await session.connection.post("/api/snippet_browser", {
			action: PLAYGROUND_ACTIONS[sub],
		});

		if (isErrorResponse(response)) {
			return errorResult(response.message);
		}
		if (isEnvelopeResponse(response) && !response.success) {
			const msg = response.errors?.[0]?.errorMessage ?? "Snippet browser request failed.";
			return errorResult(msg);
		}

		const data = response as unknown as Record<string, unknown>;
		const active = typeof data.active === "string" ? data.active : null;
		if (active === "snippet") session.playgroundActive = true;
		else if (active === "main") session.playgroundActive = false;

		const verbs: Record<string, string> = {
			open: "Snippet browser opened",
			close: "Snippet browser closed",
			enable: "Snippet browser active",
			disable: "Main project active",
		};
		return textResult(verbs[sub] + ".");
	}

	// ── screenshot ────────────────────────────────────────────────

	private async handleScreenshot(args: string, session: SessionContext): Promise<CommandResult> {
		if (!session.connection) {
			return errorResult("No HISE connection.");
		}

		const projectFolder = session.projectFolder ?? null;
		if (!projectFolder) {
			return errorResult("No project folder available. Is HISE connected?");
		}

		const opts = parseScreenshotClauses(args);

		// Resolve output path relative to project folder
		const outputPath = opts.outputPath
			? (session.resolvePath?.(opts.outputPath) ?? projectFolder + "/" + opts.outputPath)
			: projectFolder + "/screenshot.png";

		// Build query string
		const params = new URLSearchParams();
		params.set("moduleId", "Interface");
		params.set("outputPath", outputPath);
		if (opts.id) params.set("id", opts.id);
		if (opts.scale !== undefined) params.set("scale", String(opts.scale));

		const response = await session.connection.get(`/api/testing/screenshot?${params.toString()}`);
		if (isErrorResponse(response)) {
			return errorResult(response.message);
		}
		if (!isSuccessResponse(response)) {
			const msg = isEnvelopeResponse(response)
				? response.errors?.[0]?.errorMessage ?? "Screenshot failed"
				: "Screenshot failed";
			return errorResult(msg);
		}

		const data = response as unknown as Record<string, unknown>;
		const width = data.width ?? "?";
		const height = data.height ?? "?";
		const componentInfo = opts.id ? ` of ${opts.id}` : "";
		return textResult(`Screenshot${componentInfo} saved to ${outputPath} (${width}x${height})`);
	}

	// ── profile ───────────────────────────────────────────────────

	private async handleProfile(args: string, session: SessionContext): Promise<CommandResult> {
		if (!session.connection) {
			return errorResult("No HISE connection.");
		}

		const parsed = parseProfileClauses(args);
		if (typeof parsed === "string") {
			return errorResult(parsed);
		}

		// Start recording
		const recordBody: Record<string, unknown> = {
			mode: "record",
			durationMs: parsed.durationMs,
		};
		if (parsed.threadFilter) recordBody.threadFilter = parsed.threadFilter;

		const recordResp = await session.connection.post("/api/testing/profile", recordBody);
		if (isErrorResponse(recordResp)) {
			return errorResult(recordResp.message);
		}
		if (isEnvelopeResponse(recordResp) && !recordResp.success) {
			const msg = recordResp.errors?.[0]?.errorMessage ?? "Failed to start profiling";
			return errorResult(msg);
		}

		// Wait for recording to complete
		await delay(parsed.durationMs + 200);

		// Fetch results
		const getResp = await session.connection.post("/api/testing/profile", {
			mode: "get",
			summary: true,
		});
		if (isErrorResponse(getResp)) {
			return errorResult(getResp.message);
		}
		if (!isSuccessResponse(getResp)) {
			const msg = isEnvelopeResponse(getResp)
				? getResp.errors?.[0]?.errorMessage ?? "Failed to retrieve profile"
				: "Failed to retrieve profile";
			return errorResult(msg);
		}

		return formatProfileResult(getResp.result ?? null, parsed);
	}

	// ── help ──────────────────────────────────────────────────────

	private showHelp(): CommandResult {
		const rows = [...HISE_COMMANDS.entries()]
			.filter(([name]) => name !== "help")
			.map(([cmd, desc]) => `| \`${cmd}\` | ${desc} |`);
		return markdownResult(`## HISE Commands

| Command | Description |
|---------|-------------|
${rows.join("\n")}

### Syntax

- \`status [project|folder|online]\` — show connection status and project info
- \`launch [debug]\` — start HISE (or HISE Debug) and wait for connection
- \`shutdown\` — gracefully quit HISE
- \`screenshot [of <id>] [at <scale>] [to <path>]\` — capture interface
- \`profile [thread audio|ui|scripting] [for <N>ms]\` — performance profile
- \`playground open|close|enable|disable\` — drive the snippet browser (a second HISE instance for auditioning snippets)`);
	}
}

// ── Helpers ────────────────────────────────────────────────────────

function extractSnippetBrowserActive(response: Record<string, unknown>): boolean | null {
	const v = response.activeIsSnippetBrowser;
	return typeof v === "boolean" ? v : null;
}

function extractProjectFromStatus(
	response: Record<string, unknown>,
): { name: string; folder: string } | null {
	const project = response.project as Record<string, unknown> | undefined;
	if (!project) return null;
	const name = typeof project.name === "string" ? project.name : null;
	const folder = typeof project.projectFolder === "string" ? project.projectFolder : null;
	if (name && folder) return { name, folder };
	return null;
}

interface ProfileSummaryEntry {
	name: string;
	count: number;
	median: number;
	peak: number;
	min: number;
	total: number;
}

function formatProfileResult(
	result: string | object | null,
	opts: ProfileOptions,
): CommandResult {
	const data = result as Record<string, unknown> | null;
	if (!data) return textResult("Profile completed — no data returned.");

	// Summary mode returns a "results" array
	const results = data.results as ProfileSummaryEntry[] | undefined;
	if (!results || results.length === 0) {
		const threadInfo = opts.threadFilter ? ` on ${opts.threadFilter.join(", ")}` : "";
		return textResult(`Profile completed${threadInfo} — no events recorded.`);
	}

	// Sort by peak descending
	const sorted = [...results].sort((a, b) => b.peak - a.peak);

	const threadInfo = opts.threadFilter ? ` (${opts.threadFilter.join(", ")})` : "";
	const header = `## Profile Results${threadInfo} — ${opts.durationMs}ms\n`;

	const table = [
		"| Event | Count | Median | Peak | Min | Total |",
		"|-------|------:|-------:|-----:|----:|------:|",
		...sorted.map((e) =>
			`| ${e.name} | ${e.count} | ${fmt(e.median)} | ${fmt(e.peak)} | ${fmt(e.min)} | ${fmt(e.total)} |`,
		),
	].join("\n");

	return markdownResult(header + "\n" + table);
}

function fmt(ms: number): string {
	if (ms >= 1) return ms.toFixed(2) + "ms";
	return (ms * 1000).toFixed(0) + "us";
}

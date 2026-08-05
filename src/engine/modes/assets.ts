// ── Assets mode — package manager driven by hise-cli's own runtime ──
//
// Subcommand surface lives in `assets-parser.ts`; pure ops live in
// `engine/assets/operations`. This module is glue: parses input, runs ops
// against the AssetEnvironment, and renders the result as a CommandResult.

import type { AssetEnvironment } from "../assets/environment.js";
import {
	addLocalFolder,
	cleanup,
	describeLocalFolder,
	info,
	install,
	listInstalled,
	listLocal,
	listStore,
	login,
	logout,
	readInstallLog,
	readLocalFolders,
	removeLocalFolder,
	uninstall,
	type InstallResult,
	type StoreEntry,
	type InstalledEntrySummary,
	type LocalFolderInfo,
	type PackageInfo,
} from "../assets/operations/index.js";
import { getProjectFolder } from "../assets/hiseAdapter.js";
import type { CompletionEngine } from "../completion/engine.js";
import { tokenizeAssets } from "../highlight/assets.js";
import type { TokenSpan } from "../highlight/tokens.js";
import type { CommandResult } from "../result.js";
import { errorResult, markdownResult, wizardResult } from "../result.js";
import { parseAssetsCommand, type AssetsCommand } from "./assets-parser.js";
import { MODE_ACCENTS } from "./mode.js";
import type { CompletionResult, Mode, SessionContext } from "./mode.js";

const HELP_MARKDOWN = `## Assets Commands

| Command | Description |
|---------|-------------|
| \`list [installed\\|uninstalled\\|local\\|store]\` | Show packages by category |
| \`info <name>\` | Show details for a package |
| \`install <name> [version=X.Y.Z] [--dry-run]\` | Install or update a package |
| \`uninstall <name>\` | Remove an installed package |
| \`cleanup <name>\` | Finish removing files from a previous uninstall |
| \`local add <path>\` | Add a HISE project to your asset library |
| \`local remove <name\\|path>\` | Remove an entry from your asset library |
| \`login [token=<t>]\` | Sign in to the HISE store |
| \`logout\` | Sign out of the HISE store |
| \`create\` | Open the package-author wizard for the current project |
| \`help\` | Show this list |

When you run \`install <name>\`, the CLI looks in your asset library first and
then falls back to the HISE store. Use \`--dry-run\` to preview the changes
without writing anything.`;

interface CompletionCache {
	installedNames: string[];
	localNames: string[];
	needsCleanupNames: string[];
}

const EMPTY_CACHE: CompletionCache = {
	installedNames: [],
	localNames: [],
	needsCleanupNames: [],
};

const MUTATING_COMMANDS = new Set([
	"install", "uninstall", "cleanup", "localAdd", "localRemove",
]);

export class AssetsMode implements Mode {
	readonly id: Mode["id"] = "assets";
	readonly name = "Assets";
	readonly accent = MODE_ACCENTS.assets;
	readonly prompt = "[assets] > ";

	private readonly env: AssetEnvironment | null;
	private readonly completionEngine: CompletionEngine | null;
	private cache: CompletionCache = EMPTY_CACHE;

	constructor(env: AssetEnvironment | null, completionEngine?: CompletionEngine) {
		this.env = env;
		this.completionEngine = completionEngine ?? null;
	}

	tokenizeInput(value: string): TokenSpan[] {
		return tokenizeAssets(value);
	}

	complete(input: string, _cursor: number): CompletionResult {
		if (!this.completionEngine) return { items: [], from: 0, to: input.length };
		const trimmed = input.trimStart();
		const leadingSpaces = input.length - trimmed.length;
		const items = this.completionEngine.completeAssets(trimmed, this.cache);
		// Replace only the trailing token, not the whole input.
		const lastSpace = input.lastIndexOf(" ");
		const from = lastSpace === -1 ? leadingSpaces : lastSpace + 1;
		return { items, from, to: input.length, label: "Assets commands" };
	}

	async onEnter(_session: SessionContext): Promise<void> {
		await this.refreshCache();
	}

	async parse(input: string, session: SessionContext): Promise<CommandResult> {
		const command = parseAssetsCommand(input);
		if (command.type === "help") return markdownResult(HELP_MARKDOWN);
		if (command.type === "error") return errorResult(command.message);

		if (command.type === "create") {
			const def = session.wizardRegistry?.get("install_package_maker");
			if (!def) {
				return errorResult(
					"install_package_maker wizard is not registered.",
					"Wizard definitions failed to load — check the bundled `data/wizards/` directory.",
				);
			}
			return wizardResult(def);
		}

		if (!this.env) {
			return errorResult(
				"The assets mode is not available in this build.",
				"This frontend doesn't have the local file / network access the asset commands need.",
			);
		}

		try {
			const result = await dispatch(this.env, command);
			if (MUTATING_COMMANDS.has(command.type)) {
				await this.refreshCache();
			}
			return result;
		} catch (err) {
			return errorResult(`Asset command failed: ${(err as Error).message}`);
		}
	}

	private async refreshCache(): Promise<void> {
		if (!this.env) return;
		const next: CompletionCache = {
			installedNames: [],
			localNames: [],
			needsCleanupNames: [],
		};
		try {
			const projectFolder = await getProjectFolder(this.env.hise);
			const log = await readInstallLog(this.env, projectFolder);
			next.installedNames = log.map((e) => e.name);
			next.needsCleanupNames = log
				.filter((e) => e.kind === "needsCleanup")
				.map((e) => e.name);
		} catch { /* HISE offline or log corrupt — leave list empty */ }
		try {
			const local = await listLocal(this.env);
			next.localNames = local
				.map((l) => l.name)
				.filter((n): n is string => typeof n === "string" && n.length > 0);
		} catch { /* keep empty */ }
		this.cache = next;
	}
}

async function dispatch(env: AssetEnvironment, cmd: AssetsCommand): Promise<CommandResult> {
	if (cmd.type === "help" || cmd.type === "error" || cmd.type === "create") {
		return errorResult("internal: should be handled before dispatch");
	}
	switch (cmd.type) {
		case "list":              return runList(env, cmd.filter);
		case "info":              return formatInfo(await info(env, cmd.name));
		case "install":           return formatInstall(await runInstall(env, cmd));
		case "uninstall":         return formatUninstall(await uninstall(env, cmd.name));
		case "cleanup":           return formatCleanup(await cleanup(env, cmd.name));
		case "localAdd":          return formatLocalAdd(await addLocalFolder(env, cmd.path));
		case "localRemove":       return formatLocalRemove(await removeLocalFolder(env, cmd.query));
		case "login": {
			const token = cmd.token;
			if (!token) {
				return errorResult(
					"login needs a token (`token=<t>`).",
					"Generate one at https://store.hise.dev/account/settings/ and paste it here.",
				);
			}
			const r = await login(env, token);
			return formatLogin(r);
		}
		case "logout":            await logout(env); return markdownResult("Signed out of the HISE store.");
		default:                  return errorResult("Internal: unhandled command kind");
	}
}

async function runInstall(env: AssetEnvironment, cmd: Extract<AssetsCommand, { type: "install" }>): Promise<InstallResult> {
	// Resolve <name> against local folders first; fall through to the store
	// when no local folder claims that package name. Use `local add <path>`
	// to register a folder before installing from it.
	const localFolder = await findLocalFolderByName(env, cmd.name);
	if (localFolder) {
		return install(env, {
			source: { kind: "local", folder: localFolder },
			dryRun: cmd.dryRun,
		});
	}
	return install(env, {
		source: { kind: "store", packageName: cmd.name, version: cmd.version },
		dryRun: cmd.dryRun,
	});
}

async function findLocalFolderByName(env: AssetEnvironment, name: string): Promise<string | null> {
	let folders: string[];
	try {
		folders = await readLocalFolders(env);
	} catch {
		return null;
	}
	for (const folder of folders) {
		try {
			const info = await describeLocalFolder(env, folder);
			if (info.name === name) return folder;
		} catch {
			// Skip folders that fail to parse rather than aborting the resolve.
			continue;
		}
	}
	return null;
}

// ── Formatters ────────────────────────────────────────────────────

async function runList(env: AssetEnvironment, filter: string): Promise<CommandResult> {
	if (filter === "installed") return formatInstalled(await listInstalled(env));
	if (filter === "local")     return formatLocal(await listLocal(env));
	if (filter === "store")     return formatStore(await listStore(env));
	if (filter === "uninstalled") {
		const [installed, local, store] = await Promise.all([
			listInstalled(env),
			listLocal(env),
			listStore(env).catch(() => [] as StoreEntry[]),
		]);
		const installedNames = new Set(installed.map((e) => e.name));
		const out: string[] = [];
		for (const l of local) if (l.name && !installedNames.has(l.name)) out.push(`local: ${l.name}@${l.version ?? "?"}`);
		for (const s of store) if (!installedNames.has(s.repoId)) out.push(`store: ${s.repoId} (${s.productName})`);
		if (out.length === 0) return markdownResult("All known packages are installed.");
		return markdownResult(`### Uninstalled\n\n${out.map((l) => `- ${l}`).join("\n")}`);
	}
	// "all"
	const [installed, local] = await Promise.all([
		listInstalled(env),
		listLocal(env),
	]);
	const sections: string[] = [];
	sections.push(formatInstalledMd(installed));
	sections.push(formatLocalMd(local));
	return markdownResult(sections.join("\n\n"));
}

function formatInstalled(rows: InstalledEntrySummary[]): CommandResult {
	return markdownResult(formatInstalledMd(rows));
}

function formatInstalledMd(rows: InstalledEntrySummary[]): string {
	if (rows.length === 0) return "### Installed\n\n_None._";
	const body = rows.map((r) => {
		const flag = r.needsCleanup ? " ⚠ NeedsCleanup" : "";
		return `| \`${r.name}\` | ${r.version} | ${r.mode}${flag} |`;
	}).join("\n");
	return `### Installed\n\n| Name | Version | Mode |\n|------|---------|------|\n${body}`;
}

function formatLocal(rows: LocalFolderInfo[]): CommandResult {
	return markdownResult(formatLocalMd(rows));
}

function formatLocalMd(rows: LocalFolderInfo[]): string {
	if (rows.length === 0) return "### Local Folders\n\n_None registered._";
	const body = rows.map((r) =>
		`| \`${r.name ?? "(unknown)"}\` | ${r.version ?? "?"} | ${r.company ?? ""} | \`${r.folder}\` |`).join("\n");
	return `### Local Folders\n\n| Name | Version | Company | Path |\n|------|---------|---------|------|\n${body}`;
}

function formatStore(rows: StoreEntry[]): CommandResult {
	if (rows.length === 0) return markdownResult("### Store\n\n_Empty catalog._");
	const body = rows.map((r) => {
		const owned = r.owned === null ? "?" : r.owned ? "✓" : "—";
		return `| \`${r.repoId}\` | ${r.productName} | ${r.vendor} | ${owned} |`;
	}).join("\n");
	return markdownResult(
		`### Store\n\n| ID | Product | Vendor | Owned |\n|----|---------|--------|-------|\n${body}`,
	);
}

function formatInfo(p: PackageInfo): CommandResult {
	const lines: string[] = [`# ${p.name}`, ""];
	lines.push(`**State**: \`${p.state}\``);
	if (p.installed) {
		lines.push("", "## Installed",
			`- Version: ${p.installed.version}`,
			`- Company: ${p.installed.company}`,
			`- Mode: ${p.installed.mode}`,
			`- Date: ${p.installed.date}`,
		);
		if (p.installed.needsCleanup) lines.push("- ⚠ NeedsCleanup");
	}
	if (p.local) {
		lines.push("", "## Local Source",
			`- Folder: \`${p.local.folder}\``,
			`- Version: ${p.local.version ?? "?"}`,
			`- Company: ${p.local.company ?? "?"}`,
		);
	}
	return markdownResult(lines.join("\n"));
}

function formatInstall(r: InstallResult): CommandResult {
	switch (r.kind) {
		case "ok": {
			const files = r.entry.steps
				.filter((s): s is Extract<typeof s, { type: "File" }> => s.type === "File")
				.map((s) => s.target);
			const sourceLabel = r.entry.mode === "LocalFolder"
				? "from your asset library"
				: r.entry.mode === "StoreDownload"
					? "from the HISE store"
					: "";
			const lines = [
				`Installed **${r.entry.name}** ${r.entry.version}${sourceLabel ? " " + sourceLabel : ""}.`,
				"",
				`### Files (${files.length})`,
			];
			const FILE_CAP = 50;
			lines.push(...files.slice(0, FILE_CAP).map((f) => `- \`${f}\``));
			if (files.length > FILE_CAP) {
				lines.push(`- _… ${files.length - FILE_CAP} more_`);
			}
			if (r.sharedFilesReused.length > 0) {
				lines.push("", `### Shared Files Reused (${r.sharedFilesReused.length})`);
				lines.push(...r.sharedFilesReused.slice(0, FILE_CAP).map((f) => `- \`${f}\``));
				if (r.sharedFilesReused.length > FILE_CAP) {
					lines.push(`- _… ${r.sharedFilesReused.length - FILE_CAP} more_`);
				}
			}
			if (r.warnings.length > 0) {
				lines.push("", "_Warnings:_", ...r.warnings.map((w) => `- ${w}`));
			}
			if (r.infoText.length > 0) lines.push("", r.infoText);
			if (r.clipboardWritten) lines.push("", "_Clipboard updated._");
			return markdownResult(lines.join("\n"));
		}
		case "alreadyInstalled":
			return markdownResult(`**${r.existingVersion}** is already installed.`);
		case "fileConflict":
			return errorResult(
				"Cannot install: some files in your project would be overwritten by this package.",
				`${r.collisions.map((p) => `- ${p}`).join("\n")}\n\nShared files can only be installed when every package marks them as shared and the file contents are identical.`,
			);
		case "updateConflict":
			return errorResult(
				"Cannot update this package because it changes shared files that are also used by another package.",
				`${r.collisions.map((p) => `- ${p}`).join("\n")}\n\nShared files must stay identical across all installed assets. Uninstall all affected packs first, then install compatible versions.`,
			);
		case "invalidPackage":
			return errorResult(`Invalid package: ${r.message}`);
		case "corruptedLog":
			return errorResult(
				"The package install record for this project is unreadable.",
				r.message,
			);
		case "transportError":
			return errorResult(`Connection error: ${r.message}`);
		case "needsCleanupFirst":
			return errorResult(
				`Cannot install: a previous uninstall of **${r.package}** left files behind that you've modified.`,
				`Run \`cleanup ${r.package}\` to delete those files, then retry.`,
			);
		case "missingToken":
			return errorResult(
				"You need to be signed in to the HISE store to install this package.",
				"Run `login token=<t>` first.",
			);
		case "dryRun": {
			const p = r.preview;
			const lines = [`# Dry-run: ${p.packageName}@${p.packageVersion}`, ""];
			lines.push(`### Files (${p.files.length})`);
			lines.push(...p.files.slice(0, 50).map((f) => `- ${f}`));
			if (p.files.length > 50) lines.push(`- ... ${p.files.length - 50} more`);
			if (Object.keys(p.preprocessors).length > 0) {
				lines.push("", "### Preprocessors");
				for (const [k, [oldV, newV]] of Object.entries(p.preprocessors)) {
					lines.push(`- ${k}: ${oldV ?? "(unset)"} → ${newV}`);
				}
			}
			if (Object.keys(p.settings).length > 0) {
				lines.push("", "### Settings");
				for (const [k, [oldV, newV]] of Object.entries(p.settings)) {
					lines.push(`- ${k}: ${oldV} → ${newV}`);
				}
			}
			if (p.infoText.length > 0) lines.push("", "### Info", p.infoText);
			if (p.clipboardContent.length > 0) lines.push("", "### Clipboard", "```", p.clipboardContent, "```");
			if (p.warnings.length > 0) lines.push("", "### Warnings", ...p.warnings.map((w) => `- ${w}`));
			return markdownResult(lines.join("\n"));
		}
	}
}

function formatUninstall(r: Awaited<ReturnType<typeof uninstall>>): CommandResult {
	switch (r.kind) {
		case "ok": {
			const lines = [`Uninstalled — removed ${r.deleted.length} file(s)${r.skipped.length > 0 ? `, kept ${r.skipped.length} that you've modified` : ""}${r.keptOwned.length > 0 ? `, kept ${r.keptOwned.length} owned by another package` : ""}.`];
			if (r.needsCleanup) {
				lines.push("", "Some files were skipped because you've modified them. Run `cleanup <name>` when you're ready to delete them too.");
				lines.push(...r.skipped.slice(0, 10).map((p) => `- ${p}`));
				if (r.skipped.length > 10) lines.push(`- ... ${r.skipped.length - 10} more`);
			}
			if (r.keptOwned.length > 0) {
				lines.push("", "### Kept Because Another Package Owns Them");
				lines.push(...r.keptOwned.slice(0, 10).map((p) => `- ${p}`));
				if (r.keptOwned.length > 10) lines.push(`- ... ${r.keptOwned.length - 10} more`);
			}
			return markdownResult(lines.join("\n"));
		}
		case "notFound":           return errorResult(`**${r.package}** is not installed.`);
		case "alreadyNeedsCleanup":return errorResult(`**${r.package}** has a previous uninstall waiting to be cleaned up. Run \`cleanup ${r.package}\` instead.`);
		case "transportError":     return errorResult(`Connection error: ${r.message}`);
	}
}

function formatCleanup(r: Awaited<ReturnType<typeof cleanup>>): CommandResult {
	switch (r.kind) {
		case "ok": {
			const lines = [`Cleaned up — deleted ${r.deleted.length} file(s)${r.remaining.length > 0 ? `, ${r.remaining.length} could not be deleted` : ""}.`];
			if (r.remaining.length > 0) lines.push("", "_These files could not be deleted (try closing them in HISE first):_", ...r.remaining.map((p) => `- ${p}`));
			return markdownResult(lines.join("\n"));
		}
		case "notFound":          return errorResult(`**${r.package}** is not installed in this project.`);
		case "notNeedsCleanup":   return errorResult(`**${r.package}** has no leftover files to clean up.`);
	}
}

function formatLocalAdd(r: Awaited<ReturnType<typeof addLocalFolder>>): CommandResult {
	if (r.kind === "ok") {
		const name = r.info.name ?? "?";
		const version = r.info.version ?? "?";
		return markdownResult(`Added **${name}** ${version} to your asset library.\n\n_Source:_ \`${r.folder}\``);
	}
	if (r.kind === "duplicate") return errorResult(`This project is already in your asset library: ${r.folder}`);
	return errorResult(`That folder doesn't look like a HISE project (no project_info.xml): ${r.folder}`);
}

function formatLocalRemove(r: Awaited<ReturnType<typeof removeLocalFolder>>): CommandResult {
	if (r.kind === "ok") return markdownResult(`Removed \`${r.folder}\` from your asset library.`);
	return errorResult(`No entry matched **${r.query}** in your asset library.`);
}

function formatLogin(r: Awaited<ReturnType<typeof login>>): CommandResult {
	if (r.kind === "ok") return markdownResult(`Signed in as **${r.user.displayName}**.`);
	if (r.kind === "invalidToken") return errorResult(r.message);
	return errorResult(`Could not reach the HISE store: ${r.message}`);
}


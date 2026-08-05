// Asset manager file filter — four gates run in order.
// Gate 1: subdirectory restriction (FileTypes)
// Gate 2: excluded ancestors (Binaries/)
// Gate 3: reserved filenames
// Gate 4: positive then negative wildcards
//
// Path semantics: relPath is the source-relative path with forward slashes.

export const ASSET_DIRECTORY_IDS = [
	"Scripts",
	"AdditionalSourceCode",
	"Samples",
	"Images",
	"AudioFiles",
	"SampleMaps",
	"MidiFiles",
	"DspNetworks",
	"Presets",
] as const;

export type AssetDirectoryId = typeof ASSET_DIRECTORY_IDS[number];

export const RESERVED_BASENAMES = new Set<string>([
	".gitignore",
	".DS_Store",
	"expansion_info.xml",
	"project_info.xml",
	"user_info.xml",
	"RSA.xml",
	"package_install.json",
	"install_packages_log.json",
	"Readme.md",
]);

export interface CandidateFile {
	relPath: string; // forward-slash, source-relative
	name: string;    // basename
}

export interface FilterConfig {
	fileTypes: string[];
	positivePatterns: string[];
	negativePatterns: string[];
}

export function normalizeRelPath(p: string): string {
	return p.replaceAll("\\", "/").replace(/^\/+/, "");
}

// Glob -> regex covering JUCE WildcardFileFilter semantics:
// `*` = any chars (incl. across slashes when applied to filename, but JUCE only
// matches against the basename so this rarely matters).
// `?` = single char.
function globToRegex(pattern: string): RegExp {
	let body = "";
	for (const ch of pattern) {
		if (ch === "*") body += ".*";
		else if (ch === "?") body += ".";
		else body += escapeRegex(ch);
	}
	return new RegExp(`^${body}$`);
}

function escapeRegex(s: string): string {
	return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function matchesWildcard(pattern: string, file: CandidateFile): boolean {
	if (pattern.includes("*") || pattern.includes("?")) {
		return globToRegex(pattern).test(pattern.includes("/") ? file.relPath : file.name);
	}
	// Substring match against full relative path (forward-slash normalized).
	return file.relPath.includes(pattern);
}

// Gate 1: subdirectory restriction.
// Returns true if the file is in-scope per FileTypes (or FileTypes is empty/default).
export function passesGate1(file: CandidateFile, fileTypes: string[]): boolean {
	const segments = file.relPath.split("/");
	// Files directly in source root (no leading directory) are allowed.
	if (segments.length <= 1) return true;
	const top = segments[0];
	const allowed = fileTypes.length === 0 ? ASSET_DIRECTORY_IDS as readonly string[] : fileTypes;
	return allowed.includes(top);
}

// Gate 2: reject any file whose path contains a 'Binaries' segment.
export function passesGate2(file: CandidateFile): boolean {
	return !file.relPath.split("/").includes("Binaries");
}

// Gate 3: reject reserved basenames.
export function passesGate3(file: CandidateFile): boolean {
	return !RESERVED_BASENAMES.has(file.name);
}

// Gate 4: positive then negative wildcard match.
export function passesGate4(file: CandidateFile, positive: string[], negative: string[]): boolean {
	let include = positive.length === 0;
	for (const p of positive) {
		if (matchesWildcard(p, file)) {
			include = true;
			break;
		}
	}
	if (!include) return false;
	for (const n of negative) {
		if (matchesWildcard(n, file)) return false;
	}
	return true;
}

export function shouldIncludeFile(file: CandidateFile, cfg: FilterConfig): boolean {
	return (
		passesGate1(file, cfg.fileTypes)
		&& passesGate2(file)
		&& passesGate3(file)
		&& passesGate4(file, cfg.positivePatterns, cfg.negativePatterns)
	);
}

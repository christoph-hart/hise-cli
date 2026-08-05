// Contract for `package_install.json` — package authoring config.
// Lives in the source package root. CLI reads only; never writes.
// Spec §3.6.

import { ASSET_DIRECTORY_IDS, type AssetDirectoryId } from "../../../engine/assets/wildcard.js";

export interface PackageInstallManifest {
	fileTypes: string[];
	positiveWildcard: string[];
	negativeWildcard: string[];
	sharedWildcard: string[];
	preprocessors: string[];
	infoText: string;
	clipboardContent: string;
}

export function normalizePackageInstall(value: unknown): PackageInstallManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("package_install.json must be a JSON object");
	}
	const data = value as Record<string, unknown>;

	const useFileTypeFilter = data.UseFileTypeFilter === true;
	const fileTypes = data.FileTypes !== undefined
		? optionalStringArray(data.FileTypes, "FileTypes")
		: useFileTypeFilter
			? optionalStringArray(data.FileTypeFilter, "FileTypeFilter")
			: [];
	for (const ft of fileTypes) {
		if (!(ASSET_DIRECTORY_IDS as readonly string[]).includes(ft)) {
			throw new Error(`FileTypes contains unknown directory id: "${ft}"`);
		}
	}

	const positive = optionalStringArray(data.PositiveWildcard, "PositiveWildcard");
	const negative = optionalStringArray(data.NegativeWildcard, "NegativeWildcard");
	const shared = optionalStringArray(data.SharedWildcard, "SharedWildcard");
	const preprocessors = optionalStringArray(data.Preprocessors, "Preprocessors");

	return {
		fileTypes,
		positiveWildcard: positive.length === 0 ? ["*"] : positive,
		negativeWildcard: negative,
		sharedWildcard: shared,
		preprocessors,
		infoText: optionalString(data.InfoText, "InfoText") ?? "",
		clipboardContent: optionalString(data.ClipboardContent, "ClipboardContent") ?? "",
	};
}

export function isValidAssetDirectoryId(id: string): id is AssetDirectoryId {
	return (ASSET_DIRECTORY_IDS as readonly string[]).includes(id);
}

function optionalStringArray(value: unknown, label: string): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new Error(`${label} must be a string array`);
	return value.map((item, i) => {
		if (typeof item !== "string") {
			throw new Error(`${label}[${i}] must be a string, got ${typeof item}`);
		}
		return item;
	});
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value;
}

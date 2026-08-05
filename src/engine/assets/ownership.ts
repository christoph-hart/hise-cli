import type { InstallLogEntry } from "../../mock/contracts/assets/installLog.js";
import { normalizeRelPath } from "./wildcard.js";

export interface FileOwner {
	packageId: string;
	name: string;
	company: string;
	version: string;
	target: string;
	shared: boolean;
	hash: bigint | null;
	hasHashField: boolean;
}

export type OwnershipMap = Map<string, FileOwner[]>;

export function packageId(company: string, name: string): string {
	return `${company}::${name}`;
}

export function matchesPackageIdentity(
	entry: { name: string; company: string },
	pkg: { name: string; company: string },
): boolean {
	if (entry.company.length === 0 || pkg.company.length === 0) return entry.name === pkg.name;
	return packageId(entry.company, entry.name) === packageId(pkg.company, pkg.name);
}

export function buildOwnershipMap(entries: InstallLogEntry[]): OwnershipMap {
	const out: OwnershipMap = new Map();
	for (const entry of entries) {
		if (entry.kind !== "active") continue;
		for (const step of entry.steps) {
			if (step.type !== "File") continue;
			const key = normalizeRelPath(step.target);
			const owners = out.get(key) ?? [];
			owners.push({
				packageId: packageId(entry.company, entry.name),
				name: entry.name,
				company: entry.company,
				version: entry.version,
				target: key,
				shared: step.shared,
				hash: step.hash,
				hasHashField: step.hasHashField,
			});
			out.set(key, owners);
		}
	}
	return out;
}

export function otherOwners(
	owners: readonly FileOwner[] | undefined,
	pkg: { name: string; company: string },
): FileOwner[] {
	if (!owners) return [];
	return owners.filter((owner) => !matchesPackageIdentity(owner, pkg));
}

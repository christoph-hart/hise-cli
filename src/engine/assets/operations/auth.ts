// `login` / `logout` / token reading. Spec §13.

import { normalizeGiteaUser, type GiteaUser } from "../../../mock/contracts/assets/giteaUser.js";
import type { AssetEnvironment } from "../environment.js";
import { joinPath } from "../io.js";

export const TOKEN_BASENAME = "storeToken.dat";

export function tokenFilePath(env: AssetEnvironment): string {
	return joinPath(env.appData.hiseDir(), TOKEN_BASENAME);
}

export async function readStoredToken(env: AssetEnvironment): Promise<string | null> {
	const path = tokenFilePath(env);
	if (!await env.fs.exists(path)) return null;
	const raw = await env.fs.readText(path);
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export type AuthLoginResult =
	| { kind: "ok"; user: GiteaUser }
	| { kind: "invalidToken"; message: string }
	| { kind: "networkError"; message: string };

export async function login(env: AssetEnvironment, token: string): Promise<AuthLoginResult> {
	const trimmed = token.trim();
	if (trimmed.length === 0) {
		return { kind: "invalidToken", message: "Token is empty" };
	}
	let res;
	try {
		res = await env.http.request({
			method: "GET",
			url: "https://git.hise.dev/api/v1/user",
			headers: { Authorization: `Bearer ${trimmed}` },
		});
	} catch (err) {
		return { kind: "networkError", message: String(err) };
	}
	if (res.status === 401) {
		return { kind: "invalidToken", message: "Invalid token" };
	}
	if (res.status !== 200) {
		return { kind: "networkError", message: `HTTP ${res.status}` };
	}
	let userRaw: unknown;
	try {
		userRaw = await res.json();
	} catch (err) {
		return { kind: "networkError", message: `gitea returned non-JSON body: ${(err as Error).message}` };
	}
	let user: GiteaUser;
	try {
		user = normalizeGiteaUser(userRaw);
	} catch (err) {
		return { kind: "networkError", message: (err as Error).message };
	}
	await env.fs.writeText(tokenFilePath(env), trimmed);
	return { kind: "ok", user };
}

export async function logout(env: AssetEnvironment): Promise<void> {
	const path = tokenFilePath(env);
	if (await env.fs.exists(path)) {
		await env.fs.delete(path);
	}
}

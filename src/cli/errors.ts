import type { CliOutputPayload } from "./output.js";

export type CliErrorCode =
	| "usage_error"
	| "select_not_found"
	| "hise_unavailable"
	| "hise_api_error"
	| "validation_error"
	| "execution_error"
	| "expectation_failed";

export interface CliErrorPayload {
	ok: false;
	error: string;
	code?: CliErrorCode;
}

export function cliError(code: CliErrorCode, error: string): CliErrorPayload {
	return { ok: false, code, error };
}

export function exitCodeForPayload(payload: CliOutputPayload): number {
	if (payload.ok) return 0;
	const code = "code" in payload ? payload.code : undefined;
	switch (code) {
		case "usage_error":
		case "select_not_found":
			return 2;
		case "hise_unavailable":
			return 3;
		case "hise_api_error":
			return 4;
		case "validation_error":
			return 5;
		case "expectation_failed":
			return 6;
		case "execution_error":
		default:
			return 1;
	}
}

export function classifyTransportError(message: string): CliErrorCode {
	return /^(GET|POST)\s+\/api\//.test(message) ? "hise_unavailable" : "hise_api_error";
}

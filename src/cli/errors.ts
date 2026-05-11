import type { CliOutputPayload } from "./output.js";

export type CliErrorCode =
	| "usage_error"
	| "select_not_found"
	| "hise_unavailable"
	| "hise_api_error"
	| "validation_error"
	| "execution_error"
	| "duplicate_id"
	| "ambiguous_path"
	| "expectation_failed";

export interface CliErrorPayload {
	ok: false;
	error: string;
	code?: CliErrorCode;
	value?: unknown;
	candidates?: string[];
	logs?: string[];
}

export const CLI_ERROR_EXIT_CODES = {
	execution_error: 1,
	duplicate_id: 2,
	ambiguous_path: 2,
	usage_error: 2,
	select_not_found: 2,
	hise_unavailable: 3,
	hise_api_error: 4,
	validation_error: 5,
	expectation_failed: 6,
} as const satisfies Record<CliErrorCode, number>;

export function cliError(code: CliErrorCode, error: string): CliErrorPayload {
	return { ok: false, code, error };
}

export function exitCodeForPayload(payload: CliOutputPayload): number {
	if (payload.ok) return 0;
	const code = "code" in payload ? payload.code : undefined;
	switch (code) {
		case "duplicate_id":
		case "ambiguous_path":
			return CLI_ERROR_EXIT_CODES[code];
		case "usage_error":
		case "select_not_found":
			return CLI_ERROR_EXIT_CODES[code];
		case "hise_unavailable":
			return CLI_ERROR_EXIT_CODES[code];
		case "hise_api_error":
			return CLI_ERROR_EXIT_CODES[code];
		case "validation_error":
			return CLI_ERROR_EXIT_CODES[code];
		case "expectation_failed":
			return CLI_ERROR_EXIT_CODES[code];
		case "execution_error":
			return CLI_ERROR_EXIT_CODES[code];
		default:
			return 1;
	}
}

export function classifyTransportError(message: string): CliErrorCode {
	return /^(GET|POST)\s+\/api\//.test(message) ? "hise_unavailable" : "hise_api_error";
}

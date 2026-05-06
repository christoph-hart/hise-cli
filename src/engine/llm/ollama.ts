import type { CompleteRequest, LlmProvider } from "./types.js";

export interface OllamaConfig {
	endpoint?: string;
	model: string;
	think?: boolean;
	temperature?: number;
	timeoutMs?: number;
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:11434";

export function createOllamaProvider(config: OllamaConfig): LlmProvider {
	const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
	const model = config.model;
	const think = config.think ?? false;
	const temperature = config.temperature ?? 0;
	const timeoutMs = config.timeoutMs ?? 60_000;

	return {
		name: `ollama/${model}`,
		model,
		async complete(req: CompleteRequest): Promise<string> {
			const ctl = new AbortController();
			const timer = setTimeout(() => ctl.abort(), timeoutMs);
			const signal = mergeSignals(req.signal, ctl.signal);
			try {
				const res = await fetch(`${endpoint}/api/chat`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					signal,
					body: JSON.stringify({
						model,
						stream: false,
						think,
						...(req.format ? { format: req.format } : {}),
						options: { temperature, num_predict: req.maxTokens ?? 200 },
						messages: [
							{ role: "system", content: req.system },
							{ role: "user", content: req.user },
						],
					}),
				});
				const data = (await res.json()) as { message?: { content: string }; error?: string };
				if (!res.ok) {
					throw new Error(`Ollama ${res.status}: ${data.error ?? JSON.stringify(data)}`);
				}
				return data.message?.content ?? "";
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

export interface OllamaProbeResult {
	ok: boolean;
	models: string[];
	reason?: string;
}

export async function probeOllamaDaemon(endpoint: string = DEFAULT_ENDPOINT, timeoutMs = 5_000): Promise<OllamaProbeResult> {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const res = await fetch(`${endpoint}/api/tags`, { method: "GET", signal: ctl.signal });
		if (!res.ok) return { ok: false, models: [], reason: `daemon returned ${res.status}` };
		const data = (await res.json()) as { models?: Array<{ name: string }> };
		const models = (data.models ?? []).map((m) => m.name);
		return { ok: true, models };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, models: [], reason: `daemon unreachable: ${msg}` };
	} finally {
		clearTimeout(timer);
	}
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
	if (!a) return b;
	const ctl = new AbortController();
	if (a.aborted) ctl.abort();
	else a.addEventListener("abort", () => ctl.abort(), { once: true });
	b.addEventListener("abort", () => ctl.abort(), { once: true });
	return ctl.signal;
}

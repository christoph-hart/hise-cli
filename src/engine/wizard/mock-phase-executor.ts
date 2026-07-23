// ── Mock PhaseExecutor for testing ───────────────────────────────────

import type { PhaseExecutor, SpawnResult, SpawnOptions } from "./phase-executor.js";

export class MockPhaseExecutor implements PhaseExecutor {
	readonly calls: Array<{ command: string; args: string[]; env?: Record<string, string>; interactive?: boolean }> = [];
	private readonly results = new Map<string, SpawnResult>();
	private readonly resultSequences = new Map<string, SpawnResult[]>();

	constructor(readonly supportsInteractive = false) {}

	onSpawn(command: string, result: SpawnResult): this {
		this.results.set(command, result);
		return this;
	}

	onSpawnSequence(command: string, results: SpawnResult[]): this {
		this.resultSequences.set(command, [...results]);
		return this;
	}

	async spawn(command: string, args: string[], options: SpawnOptions): Promise<SpawnResult> {
		this.calls.push({ command, args, env: options.env, interactive: options.interactive });
		const sequence = this.resultSequences.get(command);
		if (sequence?.length) return sequence.shift()!;
		return this.results.get(command) ?? { exitCode: 0, stdout: "", stderr: "" };
	}
}

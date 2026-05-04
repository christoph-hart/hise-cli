import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PhaseExecutor, SpawnResult } from "../../engine/wizard/phase-executor.js";
import {
	createAssertReadyHandler,
	createStagePayloadHandler,
	createSignBinariesHandler,
	createSignAaxHandler,
	createBuildInstallerHandler,
	createSignInstallerHandler,
	createNotarizeHandler,
} from "./publish-tasks.js";

interface SpawnCall {
	readonly cmd: string;
	readonly args: string[];
}

function makeExecutor(handler: (cmd: string, args: string[]) => Partial<SpawnResult>): {
	executor: PhaseExecutor;
	calls: SpawnCall[];
} {
	const calls: SpawnCall[] = [];
	const executor: PhaseExecutor = {
		spawn: async (cmd, args, _opts): Promise<SpawnResult> => {
			calls.push({ cmd, args });
			const result = handler(cmd, args);
			return {
				exitCode: result.exitCode ?? 0,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
			};
		},
	};
	return { executor, calls };
}

function makeProject(): { folder: string; cleanup: () => void } {
	const folder = mkdtempSync(join(tmpdir(), "hise-publish-test-"));
	const vst3 = join(folder, "MyPlugin.vst3");
	mkdirSync(vst3);
	writeFileSync(join(vst3, "manifest.txt"), "fixture");
	const aax = join(folder, "MyPlugin.aaxplugin");
	mkdirSync(aax);
	writeFileSync(join(aax, "manifest.txt"), "fixture");
	const standalone = join(folder, "MyPlugin.exe");
	writeFileSync(standalone, "fixture");
	return {
		folder,
		cleanup: () => rmSync(folder, { recursive: true, force: true }),
	};
}

const noProgress = () => {};

describe("publishAssertReady", () => {
	it("fails when payload is empty", async () => {
		const handler = createAssertReadyHandler();
		const result = await handler(
			{ projectFolder: "/tmp", version: "1.0.0", payload: "" },
			noProgress,
		);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/empty|Allowed/i);
	});

	it("fails when projectFolder is missing", async () => {
		const handler = createAssertReadyHandler();
		const result = await handler(
			{ version: "1.0.0", payload: "VST3" },
			noProgress,
		);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/project folder/i);
	});

	it("fails when version is missing", async () => {
		const handler = createAssertReadyHandler();
		const result = await handler(
			{ projectFolder: "/tmp", payload: "VST3" },
			noProgress,
		);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/version/i);
	});

	it("fails when selected target source path is missing on disk", async () => {
		const handler = createAssertReadyHandler();
		const result = await handler(
			{
				projectFolder: "/tmp",
				version: "1.0.0",
				payload: "VST3",
				vst3Path: "/nonexistent/path.vst3",
			},
			noProgress,
		);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/missing|VST3/);
	});

	it("succeeds with valid inputs and emits stagingDir + outputDir", async () => {
		const project = makeProject();
		try {
			const handler = createAssertReadyHandler();
			const result = await handler(
				{
					projectFolder: project.folder,
					version: "1.0.0",
					payload: "VST3,AAX",
					vst3Path: join(project.folder, "MyPlugin.vst3"),
					aaxPath: join(project.folder, "MyPlugin.aaxplugin"),
				},
				noProgress,
			);
			expect(result.success).toBe(true);
			expect(result.data?.stagingDir).toBe(
				join(project.folder, "dist", "payload"),
			);
			expect(result.data?.outputDir).toBe(join(project.folder, "dist"));
			expect(result.data?.payloadCsv).toBe("VST3,AAX");
		} finally {
			project.cleanup();
		}
	});
});

describe("publishStagePayload", () => {
	it("copies bundles into staging and reports staged paths", async () => {
		const project = makeProject();
		try {
			const handler = createStagePayloadHandler();
			const stagingDir = join(project.folder, "dist", "payload");
			const outputDir = join(project.folder, "dist");
			const result = await handler(
				{
					projectFolder: project.folder,
					payload: "VST3,Standalone",
					vst3Path: join(project.folder, "MyPlugin.vst3"),
					standalonePath: join(project.folder, "MyPlugin.exe"),
				},
				noProgress,
				undefined,
				{ stagingDir, outputDir },
			);
			expect(result.success).toBe(true);
			expect(existsSync(join(stagingDir, "MyPlugin.vst3", "manifest.txt"))).toBe(true);
			expect(existsSync(join(stagingDir, "MyPlugin.exe"))).toBe(true);
			expect(result.data?.stagedVst3).toBe(join(stagingDir, "MyPlugin.vst3"));
			expect(result.data?.stagedStandalone).toBe(join(stagingDir, "MyPlugin.exe"));
		} finally {
			project.cleanup();
		}
	});

	it("fails when context is missing stagingDir", async () => {
		const handler = createStagePayloadHandler();
		const result = await handler(
			{ payload: "VST3" },
			noProgress,
			undefined,
			{},
		);
		expect(result.success).toBe(false);
	});
});

describe("publishSignBinaries (PR4 stub)", () => {
	it("returns skipped when codesign toggle is off", async () => {
		const { executor, calls } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createSignBinariesHandler(executor);
		const result = await handler({ codesign: "0" }, noProgress);
		expect(result.success).toBe(true);
		expect(result.message).toMatch(/skipped/i);
		expect(calls).toEqual([]);
	});
});

describe("publishSignAax (PR4 stub)", () => {
	it("returns skipped when AAX is not in payload", async () => {
		const { executor } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createSignAaxHandler(executor);
		const result = await handler({ payload: "VST3" }, noProgress);
		expect(result.success).toBe(true);
		expect(result.message).toMatch(/skipped/i);
	});
});

describe("publishBuildInstaller (Windows)", () => {
	const issPath = "C:\\fake\\installer\\build_installer.iss";

	it("emits the right /D switches when VST3 + AAX are in payload", async () => {
		if (process.platform !== "win32") return;
		const { executor, calls } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createBuildInstallerHandler({
			executor,
			issTemplatePath: issPath,
		});
		const result = await handler(
			{
				projectName: "MyPlugin",
				version: "1.2.3",
				payload: "VST3,AAX",
			},
			noProgress,
			undefined,
			{
				stagingDir: "C:\\proj\\dist\\payload",
				outputDir: "C:\\proj\\dist",
				stagedVst3: "C:\\proj\\dist\\payload\\MyPlugin.vst3",
				stagedAax: "C:\\proj\\dist\\payload\\MyPlugin.aaxplugin",
			},
		);
		expect(result.success).toBe(true);
		expect(calls.length).toBe(1);
		expect(calls[0]!.cmd).toBe("iscc");
		const argString = calls[0]!.args.join(" ");
		expect(argString).toContain("/DAppName=MyPlugin");
		expect(argString).toContain("/DAppVersion=1.2.3");
		expect(argString).toContain("/DVst3Source=");
		expect(argString).toContain("MyPlugin.vst3");
		expect(argString).toContain("/DAaxSource=");
		expect(argString).toContain("MyPlugin.aaxplugin");
		expect(argString).toContain("/DStandaloneSource=");
		expect(argString).toContain(issPath);
	});

	it("emits empty /DStandaloneSource when Standalone not in payload", async () => {
		if (process.platform !== "win32") return;
		const { executor, calls } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createBuildInstallerHandler({
			executor,
			issTemplatePath: issPath,
		});
		await handler(
			{
				projectName: "MyPlugin",
				version: "1.0.0",
				payload: "VST3",
			},
			noProgress,
			undefined,
			{
				stagingDir: "C:\\proj\\dist\\payload",
				outputDir: "C:\\proj\\dist",
				stagedVst3: "C:\\proj\\dist\\payload\\MyPlugin.vst3",
			},
		);
		const argString = calls[0]!.args.join(" ");
		expect(argString).toContain("/DStandaloneSource=");
		// The empty value yields just `/DStandaloneSource=` with no path after.
		expect(argString).toMatch(/\/DStandaloneSource=(\s|$)/);
	});

	it("quotes /D values containing spaces so iscc parses them as one token", async () => {
		if (process.platform !== "win32") return;
		const { executor, calls } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createBuildInstallerHandler({
			executor,
			issTemplatePath: issPath,
		});
		await handler(
			{
				projectName: "Demo Project",
				version: "1.0.0",
				payload: "VST3",
			},
			noProgress,
			undefined,
			{
				stagingDir: "D:\\HISE modules\\demo\\dist\\payload",
				outputDir: "D:\\HISE modules\\demo\\dist",
				stagedVst3: "Demo Project.vst3",
			},
		);
		const args = calls[0]!.args;
		expect(args).toContain('/DAppName="Demo Project"');
		expect(args.some((a) => a.startsWith('/DVst3Source="') && a.endsWith('"'))).toBe(true);
		expect(args.some((a) => a.startsWith('/DOutputDir="') && a.endsWith('"'))).toBe(true);
		// AppVersion has no spaces — must remain unquoted.
		expect(args).toContain("/DAppVersion=1.0.0");
	});

	it("returns failure on non-zero iscc exit", async () => {
		if (process.platform !== "win32") return;
		const { executor } = makeExecutor(() => ({
			exitCode: 1,
			stderr: "Inno Setup syntax error",
		}));
		const handler = createBuildInstallerHandler({
			executor,
			issTemplatePath: issPath,
		});
		const result = await handler(
			{
				projectName: "MyPlugin",
				version: "1.0.0",
				payload: "VST3",
			},
			noProgress,
			undefined,
			{
				stagingDir: "C:\\proj\\dist\\payload",
				outputDir: "C:\\proj\\dist",
				stagedVst3: "C:\\proj\\dist\\payload\\MyPlugin.vst3",
			},
		);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/exit/i);
	});

	it("returns skipped on macOS (PR4 lands pkgbuild)", async () => {
		if (process.platform !== "darwin") return;
		const { executor } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createBuildInstallerHandler({
			executor,
			issTemplatePath: "/tmp/x.iss",
		});
		const result = await handler(
			{
				projectName: "MyPlugin",
				version: "1.0.0",
				payload: "VST3",
			},
			noProgress,
			undefined,
			{
				stagingDir: "/tmp/staging",
				outputDir: "/tmp/dist",
			},
		);
		expect(result.success).toBe(true);
		expect(result.message).toMatch(/skipped/i);
	});
});

describe("publishSignInstaller (PR4 stub)", () => {
	it("returns skipped when codesign toggle is off", async () => {
		const { executor } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createSignInstallerHandler(executor);
		const result = await handler({ codesign: "0" }, noProgress);
		expect(result.success).toBe(true);
		expect(result.message).toMatch(/skipped/i);
	});
});

describe("publishNotarize (PR4 stub)", () => {
	it("returns skipped when notarize is off", async () => {
		const { executor } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createNotarizeHandler(executor);
		const result = await handler({ notarize: "0" }, noProgress);
		expect(result.success).toBe(true);
		expect(result.message).toMatch(/skipped/i);
	});

	it("fails with setup instructions when notarize is on but profile is missing", async () => {
		if (process.platform !== "darwin") return;
		const { executor } = makeExecutor((cmd, args) => {
			if (cmd === "xcrun" && args[0] === "notarytool") {
				return {
					exitCode: 1,
					stderr: "Error: No Keychain password item found for profile: notarize",
				};
			}
			return { exitCode: 0 };
		});
		const handler = createNotarizeHandler(executor);
		const result = await handler({ notarize: "1" }, noProgress);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/notarize.*keychain profile is not.*registered/i);
		expect(result.message).toMatch(/xcrun notarytool store-credentials notarize/);
		expect(result.message).toMatch(/--apple-id/);
		expect(result.message).toMatch(/--team-id/);
	});

	it("fails with network message when notarize is on but Apple is unreachable", async () => {
		if (process.platform !== "darwin") return;
		const { executor } = makeExecutor((cmd, args) => {
			if (cmd === "xcrun" && args[0] === "notarytool") {
				return {
					exitCode: 1,
					stderr: "Error: Could not connect to Apple's notary service.",
				};
			}
			return { exitCode: 0 };
		});
		const handler = createNotarizeHandler(executor);
		const result = await handler({ notarize: "1" }, noProgress);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/could not reach Apple/i);
	});
});

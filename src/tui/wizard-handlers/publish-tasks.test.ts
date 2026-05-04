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

describe("publishSignBinaries", () => {
	it("returns skipped when codesign toggle is off", async () => {
		const { executor, calls } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createSignBinariesHandler(executor);
		const result = await handler({ codesign: "0" }, noProgress);
		expect(result.success).toBe(true);
		expect(result.message).toMatch(/skipped/i);
		expect(calls).toEqual([]);
	});

	it("emits codesign argv per staged bundle on macOS", async () => {
		if (process.platform !== "darwin") return;
		const { executor, calls } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createSignBinariesHandler(executor);
		const result = await handler(
			{
				codesign: "1",
				signingIdentity: "Developer ID Application: Acme Co. (ABCDE12345)",
				payload: "VST3,AU",
			},
			noProgress,
			undefined,
			{
				stagedVst3: "/tmp/payload/MyPlugin.vst3",
				stagedAu: "/tmp/payload/MyPlugin.component",
			},
		);
		expect(result.success).toBe(true);
		expect(calls.length).toBe(2);
		for (const call of calls) {
			expect(call.cmd).toBe("codesign");
			expect(call.args).toContain("--force");
			expect(call.args).toContain("--timestamp");
			expect(call.args).toContain("--deep");
			expect(call.args).toContain("--options");
			expect(call.args[call.args.indexOf("--options") + 1]).toBe("runtime");
			expect(call.args).toContain("--sign");
			expect(call.args[call.args.indexOf("--sign") + 1]).toBe(
				"Developer ID Application: Acme Co. (ABCDE12345)",
			);
		}
		expect(calls[0]!.args[calls[0]!.args.length - 1]).toBe("/tmp/payload/MyPlugin.vst3");
		expect(calls[1]!.args[calls[1]!.args.length - 1]).toBe("/tmp/payload/MyPlugin.component");
	});

	it("fails on macOS when signingIdentity is missing", async () => {
		if (process.platform !== "darwin") return;
		const { executor } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createSignBinariesHandler(executor);
		const result = await handler(
			{ codesign: "1", payload: "VST3" },
			noProgress,
			undefined,
			{ stagedVst3: "/tmp/payload/MyPlugin.vst3" },
		);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/signingIdentity|Developer ID Application/);
	});

	it("propagates codesign failure with stderr", async () => {
		if (process.platform !== "darwin") return;
		const { executor } = makeExecutor(() => ({
			exitCode: 1,
			stderr: "errSecInternalComponent",
		}));
		const handler = createSignBinariesHandler(executor);
		const result = await handler(
			{
				codesign: "1",
				signingIdentity: "Developer ID Application: Acme Co. (ABCDE12345)",
				payload: "VST3",
			},
			noProgress,
			undefined,
			{ stagedVst3: "/tmp/payload/MyPlugin.vst3" },
		);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/codesign|VST3/);
	});

	it("emits signtool argv for non-AAX targets on Windows and skips AAX", async () => {
		if (process.platform !== "win32") return;
		const { executor, calls } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createSignBinariesHandler(executor);
		const result = await handler(
			{
				codesign: "1",
				codesignThumbprint: "DEADBEEF",
				payload: "VST3,AAX,Standalone",
			},
			noProgress,
			undefined,
			{
				stagedVst3: "C:\\proj\\dist\\payload\\MyPlugin.vst3",
				stagedAax: "C:\\proj\\dist\\payload\\MyPlugin.aaxplugin",
				stagedStandalone: "C:\\proj\\dist\\payload\\MyPlugin.exe",
			},
		);
		expect(result.success).toBe(true);
		expect(calls.length).toBe(2); // VST3 + Standalone, AAX skipped
		for (const call of calls) {
			expect(call.cmd).toBe("signtool");
			expect(call.args[0]).toBe("sign");
			expect(call.args).toContain("/sha1");
			expect(call.args[call.args.indexOf("/sha1") + 1]).toBe("DEADBEEF");
			expect(call.args).toContain("/fd");
			expect(call.args).toContain("SHA256");
			expect(call.args).toContain("/tr");
		}
		const lastArgs = calls.map((c) => c.args[c.args.length - 1]);
		expect(lastArgs).toContain("C:\\proj\\dist\\payload\\MyPlugin.vst3");
		expect(lastArgs).toContain("C:\\proj\\dist\\payload\\MyPlugin.exe");
		expect(lastArgs).not.toContain("C:\\proj\\dist\\payload\\MyPlugin.aaxplugin");
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

});

describe("publishBuildInstaller (macOS)", () => {
	function makeMacProject(): { folder: string; cleanup: () => void } {
		const folder = mkdtempSync(join(tmpdir(), "hise-publish-pkgbuild-"));
		const stagingDir = join(folder, "dist", "payload");
		mkdirSync(stagingDir, { recursive: true });
		const vst3 = join(stagingDir, "MyPlugin.vst3");
		mkdirSync(vst3);
		writeFileSync(join(vst3, "Info.plist"), "<plist/>");
		const au = join(stagingDir, "MyPlugin.component");
		mkdirSync(au);
		writeFileSync(join(au, "Info.plist"), "<plist/>");
		return {
			folder,
			cleanup: () => rmSync(folder, { recursive: true, force: true }),
		};
	}

	it("emits pkgbuild argv with --install-location / and --sign when identity provided", async () => {
		if (process.platform !== "darwin") return;
		const project = makeMacProject();
		try {
			const stagingDir = join(project.folder, "dist", "payload");
			const outputDir = join(project.folder, "dist");
			const { executor, calls } = makeExecutor(() => ({ exitCode: 0 }));
			const handler = createBuildInstallerHandler({
				executor,
				issTemplatePath: "/unused.iss",
			});
			const result = await handler(
				{
					projectName: "MyPlugin",
					version: "1.2.3",
					bundleIdentifier: "com.example.MyPlugin",
					codesign: "1",
					installerIdentity: "Developer ID Installer: Acme Co. (ABCDE12345)",
					payload: "VST3,AU",
				},
				noProgress,
				undefined,
				{
					stagingDir,
					outputDir,
					stagedVst3: join(stagingDir, "MyPlugin.vst3"),
					stagedAu: join(stagingDir, "MyPlugin.component"),
				},
			);
			expect(result.success).toBe(true);
			expect(calls.length).toBe(1);
			const call = calls[0]!;
			expect(call.cmd).toBe("pkgbuild");
			expect(call.args).toContain("--root");
			expect(call.args).toContain("--identifier");
			expect(call.args[call.args.indexOf("--identifier") + 1]).toBe(
				"com.example.MyPlugin.installer",
			);
			expect(call.args).toContain("--version");
			expect(call.args[call.args.indexOf("--version") + 1]).toBe("1.2.3");
			expect(call.args).toContain("--install-location");
			expect(call.args[call.args.indexOf("--install-location") + 1]).toBe("/");
			expect(call.args).toContain("--sign");
			expect(call.args[call.args.indexOf("--sign") + 1]).toBe(
				"Developer ID Installer: Acme Co. (ABCDE12345)",
			);
			// Final arg is the .pkg path.
			expect(call.args[call.args.length - 1]).toBe(
				join(outputDir, "MyPlugin-1.2.3.pkg"),
			);
			// install-root mirrors absolute install paths.
			const installRoot = join(outputDir, "install-root");
			expect(existsSync(join(installRoot, "Library/Audio/Plug-Ins/VST3/MyPlugin.vst3"))).toBe(true);
			expect(existsSync(join(installRoot, "Library/Audio/Plug-Ins/Components/MyPlugin.component"))).toBe(true);
			expect(result.data?.installerPath).toBe(join(outputDir, "MyPlugin-1.2.3.pkg"));
		} finally {
			project.cleanup();
		}
	});

	it("omits --sign when codesign is off (unsigned pkg)", async () => {
		if (process.platform !== "darwin") return;
		const project = makeMacProject();
		try {
			const stagingDir = join(project.folder, "dist", "payload");
			const outputDir = join(project.folder, "dist");
			const { executor, calls } = makeExecutor(() => ({ exitCode: 0 }));
			const handler = createBuildInstallerHandler({
				executor,
				issTemplatePath: "/unused.iss",
			});
			const result = await handler(
				{
					projectName: "MyPlugin",
					version: "1.0.0",
					codesign: "0",
					payload: "VST3",
				},
				noProgress,
				undefined,
				{
					stagingDir,
					outputDir,
					stagedVst3: join(stagingDir, "MyPlugin.vst3"),
				},
			);
			expect(result.success).toBe(true);
			expect(calls[0]!.args).not.toContain("--sign");
			expect(result.message).toMatch(/unsigned/i);
		} finally {
			project.cleanup();
		}
	});

	it("places AAX under /Library/Application Support/Avid/Audio/Plug-Ins", async () => {
		if (process.platform !== "darwin") return;
		const folder = mkdtempSync(join(tmpdir(), "hise-publish-aax-"));
		try {
			const stagingDir = join(folder, "dist", "payload");
			const outputDir = join(folder, "dist");
			mkdirSync(stagingDir, { recursive: true });
			const aax = join(stagingDir, "MyPlugin.aaxplugin");
			mkdirSync(aax);
			writeFileSync(join(aax, "Info.plist"), "<plist/>");
			const { executor } = makeExecutor(() => ({ exitCode: 0 }));
			const handler = createBuildInstallerHandler({
				executor,
				issTemplatePath: "/unused.iss",
			});
			const result = await handler(
				{
					projectName: "MyPlugin",
					version: "1.0.0",
					codesign: "0",
					payload: "AAX",
				},
				noProgress,
				undefined,
				{
					stagingDir,
					outputDir,
					stagedAax: aax,
				},
			);
			expect(result.success).toBe(true);
			const installRoot = join(outputDir, "install-root");
			expect(
				existsSync(
					join(
						installRoot,
						"Library/Application Support/Avid/Audio/Plug-Ins/MyPlugin.aaxplugin",
					),
				),
			).toBe(true);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});
});

describe("publishSignInstaller", () => {
	it("returns skipped when codesign toggle is off", async () => {
		const { executor } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createSignInstallerHandler(executor);
		const result = await handler({ codesign: "0" }, noProgress);
		expect(result.success).toBe(true);
		expect(result.message).toMatch(/skipped/i);
	});

	it("returns skipped on macOS — pkgbuild --sign already covered the .pkg", async () => {
		if (process.platform !== "darwin") return;
		const { executor, calls } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createSignInstallerHandler(executor);
		const result = await handler(
			{ codesign: "1" },
			noProgress,
			undefined,
			{ installerPath: "/tmp/dist/MyPlugin-1.0.0.pkg" },
		);
		expect(result.success).toBe(true);
		expect(result.message).toMatch(/skipped/i);
		expect(calls).toEqual([]);
	});

	it("emits signtool argv for the installer .exe on Windows", async () => {
		if (process.platform !== "win32") return;
		const { executor, calls } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createSignInstallerHandler(executor);
		const result = await handler(
			{ codesign: "1", codesignThumbprint: "DEADBEEF" },
			noProgress,
			undefined,
			{ installerPath: "C:\\proj\\dist\\MyPlugin-1.0.0-setup.exe" },
		);
		expect(result.success).toBe(true);
		expect(calls.length).toBe(1);
		expect(calls[0]!.cmd).toBe("signtool");
		expect(calls[0]!.args[0]).toBe("sign");
		expect(calls[0]!.args).toContain("/sha1");
		expect(calls[0]!.args[calls[0]!.args.indexOf("/sha1") + 1]).toBe("DEADBEEF");
		expect(calls[0]!.args[calls[0]!.args.length - 1]).toBe(
			"C:\\proj\\dist\\MyPlugin-1.0.0-setup.exe",
		);
	});

	it("fails when installerPath is missing from context", async () => {
		const { executor } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createSignInstallerHandler(executor);
		const result = await handler({ codesign: "1" }, noProgress, undefined, {});
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/installerPath|buildInstaller/i);
	});
});

describe("publishNotarize", () => {
	const ctx = { installerPath: "/tmp/dist/MyPlugin-1.0.0.pkg" };

	it("returns skipped when notarize is off", async () => {
		const { executor } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createNotarizeHandler(executor);
		const result = await handler({ notarize: "0" }, noProgress, undefined, ctx);
		expect(result.success).toBe(true);
		expect(result.message).toMatch(/skipped/i);
	});

	it("fails with setup instructions when notarize is on but profile is missing", async () => {
		if (process.platform !== "darwin") return;
		const { executor } = makeExecutor((cmd, args) => {
			if (cmd === "xcrun" && args[0] === "notarytool" && args[1] === "history") {
				return {
					exitCode: 1,
					stderr: "Error: No Keychain password item found for profile: notarize",
				};
			}
			return { exitCode: 0 };
		});
		const handler = createNotarizeHandler(executor);
		const result = await handler({ notarize: "1" }, noProgress, undefined, ctx);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/notarize.*keychain profile is not.*registered/i);
		expect(result.message).toMatch(/xcrun notarytool store-credentials notarize/);
		expect(result.message).toMatch(/--apple-id/);
		expect(result.message).toMatch(/--team-id/);
	});

	it("fails with network message when notarize is on but Apple is unreachable", async () => {
		if (process.platform !== "darwin") return;
		const { executor } = makeExecutor((cmd, args) => {
			if (cmd === "xcrun" && args[0] === "notarytool" && args[1] === "history") {
				return {
					exitCode: 1,
					stderr: "Error: Could not connect to Apple's notary service.",
				};
			}
			return { exitCode: 0 };
		});
		const handler = createNotarizeHandler(executor);
		const result = await handler({ notarize: "1" }, noProgress, undefined, ctx);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/could not reach Apple/i);
	});

	it("emits notarytool submit + stapler staple argv when profile is valid", async () => {
		if (process.platform !== "darwin") return;
		const { executor, calls } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createNotarizeHandler(executor);
		const result = await handler(
			{ notarize: "1", notarizeProfile: "notarize" },
			noProgress,
			undefined,
			ctx,
		);
		expect(result.success).toBe(true);
		// 1: probe (history), 2: submit, 3: staple
		expect(calls.length).toBe(3);
		const submit = calls[1]!;
		expect(submit.cmd).toBe("xcrun");
		expect(submit.args[0]).toBe("notarytool");
		expect(submit.args[1]).toBe("submit");
		expect(submit.args[2]).toBe(ctx.installerPath);
		expect(submit.args).toContain("--keychain-profile");
		expect(submit.args[submit.args.indexOf("--keychain-profile") + 1]).toBe("notarize");
		expect(submit.args).toContain("--wait");
		const staple = calls[2]!;
		expect(staple.cmd).toBe("xcrun");
		expect(staple.args).toEqual(["stapler", "staple", ctx.installerPath]);
	});
});

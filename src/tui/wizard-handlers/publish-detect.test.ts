import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PhaseExecutor, SpawnResult } from "../../engine/wizard/phase-executor.js";
import { WizardInitAbortError } from "../../engine/wizard/executor.js";
import {
	createPublishDetectHandler,
	defaultResolveProjectFolder,
} from "./publish-detect.js";

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

const PROJECT_INFO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ProjectSettings>
  <Name value="MyPlugin"/>
  <Version value="1.2.3"/>
  <Description value=""/>
  <BundleIdentifier value="com.example.MyPlugin"/>
  <PluginCode value="MyPg"/>
</ProjectSettings>
`;

function makeFixtureProject(opts: {
	withBinaries: boolean;
	binaryPlatform?: "Windows" | "macOS";
}): { folder: string; cleanup: () => void } {
	const folder = mkdtempSync(join(tmpdir(), "hise-pdetect-"));
	writeFileSync(join(folder, "project_info.xml"), PROJECT_INFO_XML);

	if (opts.withBinaries) {
		if (opts.binaryPlatform === "Windows" || (!opts.binaryPlatform && process.platform === "win32")) {
			const vst3Dir = join(folder, "Binaries", "Compiled", "VST3");
			mkdirSync(vst3Dir, { recursive: true });
			mkdirSync(join(vst3Dir, "MyPlugin.vst3"));
			writeFileSync(join(vst3Dir, "MyPlugin.vst3", "manifest.txt"), "x");
		} else {
			const releaseDir = join(folder, "Binaries", "Builds", "MacOSXMakefile", "build", "Release");
			mkdirSync(releaseDir, { recursive: true });
			mkdirSync(join(releaseDir, "MyPlugin.vst3"));
		}
	}
	return {
		folder,
		cleanup: () => rmSync(folder, { recursive: true, force: true }),
	};
}

describe("publishDetectEnvironment", () => {
	let originalEnv: string | undefined;

	beforeEach(() => {
		originalEnv = process.env.HISE_PROJECT_FOLDER;
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env.HISE_PROJECT_FOLDER;
		else process.env.HISE_PROJECT_FOLDER = originalEnv;
	});

	it("aborts when no project folder is resolvable", async () => {
		delete process.env.HISE_PROJECT_FOLDER;
		const empty = mkdtempSync(join(tmpdir(), "hise-pdetect-emptycwd-"));
		try {
			const { executor } = makeExecutor(() => ({ exitCode: 0 }));
			const handler = createPublishDetectHandler({
				executor,
				resolveProjectFolder: async () => null,
			});
			void empty;
			await expect(handler("build_installer")).rejects.toBeInstanceOf(
				WizardInitAbortError,
			);
			await expect(handler("build_installer")).rejects.toThrow(
				/No HISE project folder/,
			);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it("aborts when project_info.xml is missing", async () => {
		const folder = mkdtempSync(join(tmpdir(), "hise-pdetect-empty-"));
		try {
			const { executor } = makeExecutor(() => ({ exitCode: 0 }));
			const handler = createPublishDetectHandler({
				executor,
				resolveProjectFolder: async () => folder,
			});
			await expect(handler("build_installer")).rejects.toThrow(
				/project_info\.xml/,
			);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("aborts when no binaries are discovered", async () => {
		const project = makeFixtureProject({ withBinaries: false });
		try {
			// On Windows, iscc must be present or that abort fires first; mock iscc as found.
			const { executor } = makeExecutor((cmd) =>
				cmd === "where" ? { exitCode: 0 } :
				cmd === "which" ? { exitCode: 0 } : { exitCode: 0 },
			);
			const handler = createPublishDetectHandler({
				executor,
				resolveProjectFolder: async () => project.folder,
			});
			await expect(handler("build_installer")).rejects.toThrow(
				/No plugin binaries discovered/,
			);
		} finally {
			project.cleanup();
		}
	});

	it("aborts on Windows when iscc is missing", async () => {
		if (process.platform !== "win32") return;
		const project = makeFixtureProject({ withBinaries: true, binaryPlatform: "Windows" });
		try {
			const { executor } = makeExecutor((cmd, args) => {
				if (cmd === "where" && args[0] === "iscc") return { exitCode: 1 };
				return { exitCode: 0 };
			});
			const handler = createPublishDetectHandler({
				executor,
				resolveProjectFolder: async () => project.folder,
			});
			await expect(handler("build_installer")).rejects.toThrow(/Inno Setup/);
		} finally {
			project.cleanup();
		}
	});

	it("returns defaults including project metadata + payload csv", async () => {
		const project = makeFixtureProject({ withBinaries: true });
		try {
			// Mock everything as present so all critical checks pass.
			const { executor } = makeExecutor((cmd, _args) => {
				if (cmd === "powershell") {
					return {
						exitCode: 0,
						stdout: '{"Thumbprint":"DEADBEEF","Subject":"CN=Acme"}',
					};
				}
				if (cmd === "security") {
					return {
						exitCode: 0,
						stdout:
							'  1) ABC123 "Developer ID Application: Acme Co. (ABCDE12345)"\n' +
							'  2) DEF456 "Developer ID Installer: Acme Co. (ABCDE12345)"',
					};
				}
				return { exitCode: 0 };
			});
			const handler = createPublishDetectHandler({
				executor,
				resolveProjectFolder: async () => project.folder,
			});
			const defaults = await handler("build_installer") as Record<string, string>;
			expect(defaults.version).toBe("1.2.3");
			expect(defaults.projectName).toBe("MyPlugin");
			expect(defaults.bundleIdentifier).toBe("com.example.MyPlugin");
			expect(defaults.projectFolder).toBe(project.folder);
			expect(defaults.payload).toContain("VST3");
			expect(defaults.discoveredBinaries).toContain("VST3");
			if (process.platform === "win32") {
				expect(defaults.platform).toBe("Windows");
				expect(defaults.hasIscc).toBe("1");
				expect(defaults.codesignThumbprint).toBe("DEADBEEF");
			} else if (process.platform === "darwin") {
				expect(defaults.platform).toBe("macOS");
				expect(defaults.hasPkgbuild).toBe("1");
				expect(defaults.signingIdentity).toContain("Developer ID Application");
				expect(defaults.installerIdentity).toContain("Developer ID Installer");
				expect(defaults.hasInstallerIdentity).toBe("1");
				// codesign auto-enables only when BOTH identities are present.
				expect(defaults.codesign).toBe("1");
			}
		} finally {
			project.cleanup();
		}
	});

	it("aborts on macOS when notary probe fails with a non-setup error (network down)", async () => {
		if (process.platform !== "darwin") return;
		const project = makeFixtureProject({ withBinaries: true, binaryPlatform: "macOS" });
		try {
			const { executor } = makeExecutor((cmd, args) => {
				if (cmd === "security") {
					return {
						exitCode: 0,
						stdout:
							'  1) ABC123 "Developer ID Application: Acme Co. (ABCDE12345)"\n' +
							'  2) DEF456 "Developer ID Installer: Acme Co. (ABCDE12345)"',
					};
				}
				if (cmd === "xcrun" && args[0] === "notarytool") {
					return {
						exitCode: 1,
						stderr: "Error: Could not connect to Apple's notary service.",
					};
				}
				return { exitCode: 0 };
			});
			const handler = createPublishDetectHandler({
				executor,
				resolveProjectFolder: async () => project.folder,
			});
			await expect(handler("build_installer")).rejects.toThrow(
				/Could not reach Apple's notary service/,
			);
		} finally {
			project.cleanup();
		}
	});

	it("does NOT abort on macOS when notary profile is missing — just disables the toggle", async () => {
		if (process.platform !== "darwin") return;
		const project = makeFixtureProject({ withBinaries: true, binaryPlatform: "macOS" });
		try {
			const { executor } = makeExecutor((cmd, args) => {
				if (cmd === "security") {
					return {
						exitCode: 0,
						stdout:
							'  1) ABC123 "Developer ID Application: Acme Co. (ABCDE12345)"\n' +
							'  2) DEF456 "Developer ID Installer: Acme Co. (ABCDE12345)"',
					};
				}
				if (cmd === "xcrun" && args[0] === "notarytool") {
					return {
						exitCode: 1,
						stderr:
							"Error: No Keychain password item found for profile: notarize",
					};
				}
				return { exitCode: 0 };
			});
			const handler = createPublishDetectHandler({
				executor,
				resolveProjectFolder: async () => project.folder,
			});
			const defaults = await handler("build_installer") as Record<string, string>;
			expect(defaults.hasNotaryProfile).toBe("0");
			expect(defaults.notarize).toBe("0");
		} finally {
			project.cleanup();
		}
	});

	it("aborts on Linux", async () => {
		if (process.platform !== "linux") return;
		const { executor } = makeExecutor(() => ({ exitCode: 0 }));
		const handler = createPublishDetectHandler({
			executor,
			resolveProjectFolder: async () => "/tmp",
		});
		await expect(handler("build_installer")).rejects.toThrow(/Linux/);
	});

	it("default resolver picks up HISE_PROJECT_FOLDER env var", async () => {
		const project = makeFixtureProject({ withBinaries: true });
		try {
			process.env.HISE_PROJECT_FOLDER = project.folder;
			const { executor } = makeExecutor(() => ({ exitCode: 0 }));
			const handler = createPublishDetectHandler({
				executor,
				resolveProjectFolder: defaultResolveProjectFolder(),
			});
			const defaults = await handler("build_installer") as Record<string, string>;
			expect(defaults.projectFolder).toBe(project.folder);
		} finally {
			project.cleanup();
		}
	});
});

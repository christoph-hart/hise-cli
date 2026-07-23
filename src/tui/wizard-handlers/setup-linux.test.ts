import { describe, expect, it } from "vitest";
import { MockPhaseExecutor } from "../../engine/wizard/mock-phase-executor.js";
import { detectFaust, detectFftw, installAptPackages, runApt } from "./setup-linux.js";

describe("Linux setup dependencies", () => {
	it("runs apt directly when already root", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("apt-get", { exitCode: 0, stdout: "apt 2.8", stderr: "" });
		executor.onSpawn("id", { exitCode: 0, stdout: "0\n", stderr: "" });
		const result = await installAptPackages(executor, ["git"]);
		expect(result.exitCode).toBe(0);
		expect(executor.calls.some((call) => call.command === "sudo")).toBe(false);
		expect(executor.calls.some((call) => call.command === "apt-get" && call.args.includes("install"))).toBe(true);
	});

	it("uses sudo for a non-root apt installation", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("apt-get", { exitCode: 0, stdout: "apt 2.8", stderr: "" });
		executor.onSpawn("id", { exitCode: 0, stdout: "1000\n", stderr: "" });
		executor.onSpawn("sudo", { exitCode: 0, stdout: "", stderr: "" });
		const result = await installAptPackages(executor, ["git"]);
		expect(result.exitCode).toBe(0);
		expect(executor.calls.some((call) => call.command === "sudo" && call.args.includes("install"))).toBe(true);
	});

	it("prompts interactively when sudo credentials are not cached", async () => {
		const executor = new MockPhaseExecutor(true);
		executor.onSpawn("apt-get", { exitCode: 0, stdout: "apt 2.8", stderr: "" });
		executor.onSpawn("id", { exitCode: 0, stdout: "1000\n", stderr: "" });
		executor.onSpawnSequence("sudo", [
			{ exitCode: 1, stdout: "", stderr: "password required" },
			{ exitCode: 0, stdout: "", stderr: "" },
			{ exitCode: 0, stdout: "", stderr: "" },
		]);
		const result = await runApt(executor, ["install", "-y", "git"]);
		expect(result.exitCode).toBe(0);
		expect(executor.calls).toContainEqual(expect.objectContaining({
			command: "sudo",
			args: ["-v"],
			interactive: true,
		}));
		expect(executor.calls.at(-1)?.args).toEqual(["-n", "apt-get", "install", "-y", "git"]);
	});

	it("fails immediately with resume instructions without an interactive terminal", async () => {
		const executor = new MockPhaseExecutor(false);
		executor.onSpawn("apt-get", { exitCode: 0, stdout: "apt 2.8", stderr: "" });
		executor.onSpawn("id", { exitCode: 0, stdout: "1000\n", stderr: "" });
		executor.onSpawn("sudo", { exitCode: 1, stdout: "", stderr: "password required" });
		const result = await runApt(executor, ["install", "-y", "git"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("sudo -v");
		expect(result.stderr).toContain("/resume");
		expect(executor.calls.some((call) => call.args.includes("apt-get"))).toBe(false);
	});

	it("fails clearly when apt is unavailable", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("apt-get", { exitCode: 127, stdout: "", stderr: "not found" });
		const result = await installAptPackages(executor, ["git"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Debian/Ubuntu");
	});

	it("requires a complete Faust 2.54+ installation on Linux", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("faust", { exitCode: 0, stdout: "FAUST Version 2.81.2", stderr: "" });
		executor.onSpawn("test", { exitCode: 0, stdout: "", stderr: "" });
		executor.onSpawn("/sbin/ldconfig", { exitCode: 0, stdout: "libfaust.so (libc6,x86-64)", stderr: "" });
		expect(await detectFaust(executor, "Linux", "/HISE")).toBe(true);
	});

	it("rejects an old system Faust version", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("faust", { exitCode: 0, stdout: "FAUST Version 2.37.3", stderr: "" });
		executor.onSpawn("test", { exitCode: 1, stdout: "", stderr: "" });
		expect(await detectFaust(executor, "Linux", "/HISE")).toBe(false);
	});

	it("detects the single-precision FFTW pkg-config entry", async () => {
		const executor = new MockPhaseExecutor();
		executor.onSpawn("pkg-config", { exitCode: 0, stdout: "", stderr: "" });
		expect(await detectFftw(executor, "Linux")).toBe(true);
		expect(executor.calls[0]?.args).toEqual(["--exists", "fftw3f"]);
	});
});

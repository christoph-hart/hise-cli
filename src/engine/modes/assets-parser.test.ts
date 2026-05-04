import { describe, expect, it } from "vitest";
import { parseAssetsCommand } from "./assets-parser.js";

describe("parseAssetsCommand", () => {
	it("empty input -> help", () => {
		expect(parseAssetsCommand("")).toEqual({ type: "help" });
		expect(parseAssetsCommand("  ")).toEqual({ type: "help" });
		expect(parseAssetsCommand("help")).toEqual({ type: "help" });
	});

	it("list with no filter -> all", () => {
		expect(parseAssetsCommand("list")).toEqual({ type: "list", filter: "all" });
	});

	it("list filters", () => {
		for (const f of ["installed", "uninstalled", "local", "store"] as const) {
			expect(parseAssetsCommand(`list ${f}`)).toEqual({ type: "list", filter: f });
		}
	});

	it("list with bogus filter -> error", () => {
		const r = parseAssetsCommand("list bogus");
		expect(r.type).toBe("error");
	});

	it("info requires name", () => {
		expect(parseAssetsCommand("info")).toMatchObject({ type: "error" });
		expect(parseAssetsCommand("info pkg")).toEqual({ type: "info", name: "pkg" });
	});

	it("install with name only -> dryRun false, no flags", () => {
		expect(parseAssetsCommand("install pkg")).toEqual({
			type: "install", name: "pkg", dryRun: false,
		});
	});

	it("install --dry-run flag", () => {
		expect(parseAssetsCommand("install pkg --dry-run")).toEqual({
			type: "install", name: "pkg", dryRun: true,
		});
	});

	it("install version=1.2.0", () => {
		expect(parseAssetsCommand("install pkg version=1.2.0"))
			.toEqual({
				type: "install", name: "pkg", dryRun: false,
				version: "1.2.0",
			});
	});

	it("install ignores stray flags (not in surface)", () => {
		const r = parseAssetsCommand("install pkg token=abc local=/p");
		expect(r).toMatchObject({ type: "install", name: "pkg" });
		expect(r as object).not.toHaveProperty("token");
		expect(r as object).not.toHaveProperty("local");
	});

	it("install requires name", () => {
		expect(parseAssetsCommand("install")).toMatchObject({ type: "error" });
	});

	it("uninstall + cleanup require name", () => {
		expect(parseAssetsCommand("uninstall pkg")).toEqual({ type: "uninstall", name: "pkg" });
		expect(parseAssetsCommand("cleanup pkg")).toEqual({ type: "cleanup", name: "pkg" });
		expect(parseAssetsCommand("uninstall")).toMatchObject({ type: "error" });
		expect(parseAssetsCommand("cleanup")).toMatchObject({ type: "error" });
	});

	it("local add / remove", () => {
		expect(parseAssetsCommand("local add /path")).toEqual({ type: "localAdd", path: "/path" });
		expect(parseAssetsCommand("local remove name")).toEqual({ type: "localRemove", query: "name" });
		expect(parseAssetsCommand("local")).toMatchObject({ type: "error" });
		expect(parseAssetsCommand("local add")).toMatchObject({ type: "error" });
	});

	it("login / logout", () => {
		expect(parseAssetsCommand("login")).toEqual({ type: "login" });
		expect(parseAssetsCommand("login token=abc"))
			.toEqual({ type: "login", token: "abc" });
		expect(parseAssetsCommand("logout")).toEqual({ type: "logout" });
		expect(parseAssetsCommand("auth")).toMatchObject({ type: "error" });
	});

	it("create verb -> wizard launch command", () => {
		expect(parseAssetsCommand("create")).toEqual({ type: "create" });
	});

	it("unknown verb -> error", () => {
		expect(parseAssetsCommand("explode pkg")).toMatchObject({ type: "error" });
	});

	it("supports quoted paths with spaces", () => {
		const r = parseAssetsCommand('local add "/a path/with spaces"');
		expect(r).toEqual({ type: "localAdd", path: "/a path/with spaces" });
	});
});

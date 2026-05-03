import { describe, expect, it } from "vitest";
import { parseSingleUiCommand } from "./ui-parser.js";
import type { UiAddCommand, UiCommand, UiRenameCommand } from "./ui-parser.js";

function parseOk(input: string): UiCommand {
	const result = parseSingleUiCommand(input);
	if ("error" in result) throw new Error(result.error);
	return result.command;
}

describe("ui parser — rename", () => {
	it("parses rename with quoted name", () => {
		const cmd = parseOk('rename Btn1 to "My Button"') as UiRenameCommand;
		expect(cmd.target).toBe("Btn1");
		expect(cmd.newName).toBe("My Button");
	});

	it("parses rename with bare identifier name", () => {
		const cmd = parseOk("rename Btn1 to MyButton") as UiRenameCommand;
		expect(cmd.target).toBe("Btn1");
		expect(cmd.newName).toBe("MyButton");
	});

	it("parses rename with multi-word bare name", () => {
		const cmd = parseOk("rename Btn1 to My Button") as UiRenameCommand;
		expect(cmd.target).toBe("Btn1");
		expect(cmd.newName).toBe("My Button");
	});
});

describe("ui parser — add", () => {
	it("parses add with quoted name (no as)", () => {
		const cmd = parseOk('add ScriptButton "PlayButton"') as UiAddCommand;
		expect(cmd.componentType).toBe("ScriptButton");
		expect(cmd.name).toBe("PlayButton");
	});

	it("parses add with as + quoted name", () => {
		const cmd = parseOk('add ScriptButton as "PlayButton"') as UiAddCommand;
		expect(cmd.componentType).toBe("ScriptButton");
		expect(cmd.name).toBe("PlayButton");
	});

	it("parses add with as + bare identifier", () => {
		const cmd = parseOk("add ScriptButton as PlayButton") as UiAddCommand;
		expect(cmd.componentType).toBe("ScriptButton");
		expect(cmd.name).toBe("PlayButton");
	});

	it("parses add with as + bare ID + at coords", () => {
		const cmd = parseOk("add ScriptButton as PlayButton at 10 20 100 30") as UiAddCommand;
		expect(cmd.name).toBe("PlayButton");
		expect(cmd.x).toBe(10);
		expect(cmd.y).toBe(20);
		expect(cmd.width).toBe(100);
		expect(cmd.height).toBe(30);
	});

	it("parses add without name", () => {
		const cmd = parseOk("add ScriptButton") as UiAddCommand;
		expect(cmd.componentType).toBe("ScriptButton");
		expect(cmd.name).toBeUndefined();
	});
});

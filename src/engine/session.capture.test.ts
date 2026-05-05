import { describe, expect, it } from "vitest";
import { Session } from "./session.js";

describe("Session /capture buffer", () => {
	it("starts inactive", () => {
		const s = new Session(null);
		expect(s.isCapturing("Interface")).toBe(false);
		expect(s.getCaptureBuffer("Interface")).toEqual([]);
	});

	it("startCapture activates the buffer for a processor", () => {
		const s = new Session(null);
		s.startCapture("Interface");
		expect(s.isCapturing("Interface")).toBe(true);
		expect(s.isCapturing("Other")).toBe(false);
	});

	it("appendCaptureLine accumulates lines", () => {
		const s = new Session(null);
		s.startCapture("Interface");
		expect(s.appendCaptureLine("Interface", "var x = 1;")).toBe(true);
		expect(s.appendCaptureLine("Interface", "Console.print(x);")).toBe(true);
		expect(s.getCaptureBuffer("Interface")).toEqual([
			"var x = 1;",
			"Console.print(x);",
		]);
	});

	it("appendCaptureLine returns false when not capturing", () => {
		const s = new Session(null);
		expect(s.appendCaptureLine("Interface", "x")).toBe(false);
	});

	it("clearCapture removes the buffer", () => {
		const s = new Session(null);
		s.startCapture("Interface");
		s.appendCaptureLine("Interface", "x");
		s.clearCapture("Interface");
		expect(s.isCapturing("Interface")).toBe(false);
	});

	it("startCapture resets an existing buffer", () => {
		const s = new Session(null);
		s.startCapture("Interface");
		s.appendCaptureLine("Interface", "old");
		s.startCapture("Interface");
		expect(s.getCaptureBuffer("Interface")).toEqual([]);
	});

	it("clearAllCaptureBuffers resets every processor", () => {
		const s = new Session(null);
		s.startCapture("Interface");
		s.startCapture("FX1");
		s.clearAllCaptureBuffers();
		expect(s.isCapturing("Interface")).toBe(false);
		expect(s.isCapturing("FX1")).toBe(false);
	});
});

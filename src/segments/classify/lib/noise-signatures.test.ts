import { describe, expect, it } from "bun:test";
import { detectNoiseSignature } from "./noise-signatures.js";

describe("detectNoiseSignature", () => {
	it("matches literal null", () => {
		expect(detectNoiseSignature(null)).toBe("null-literal");
	});

	it("matches empty string", () => {
		expect(detectNoiseSignature("")).toBe("empty-string");
	});

	it("matches whitespace-only strings (spaces, tabs, newlines)", () => {
		expect(detectNoiseSignature("   ")).toBe("whitespace-only");
		expect(detectNoiseSignature("\t\n")).toBe("whitespace-only");
	});

	it("matches case-insensitive null/undefined/N/A/(no data)", () => {
		expect(detectNoiseSignature("null")).toBe("null-string");
		expect(detectNoiseSignature("NULL")).toBe("null-string");
		expect(detectNoiseSignature("undefined")).toBe("undefined-string");
		expect(detectNoiseSignature("Undefined")).toBe("undefined-string");
		expect(detectNoiseSignature("N/A")).toBe("na-string");
		expect(detectNoiseSignature("n/a")).toBe("na-string");
		expect(detectNoiseSignature("(no data)")).toBe("no-data-string");
		expect(detectNoiseSignature("(No Data)")).toBe("no-data-string");
	});

	it("trims whitespace around token signatures", () => {
		expect(detectNoiseSignature("  null  ")).toBe("null-string");
		expect(detectNoiseSignature("\tN/A\n")).toBe("na-string");
	});

	it("does not match substantive strings", () => {
		expect(detectNoiseSignature("Hello")).toBeNull();
		expect(detectNoiseSignature("nullish")).toBeNull();
		expect(detectNoiseSignature("undefined behaviour")).toBeNull();
		expect(detectNoiseSignature("n/a_suffix")).toBeNull();
	});

	it("does not match non-string, non-null values", () => {
		expect(detectNoiseSignature(0)).toBeNull();
		expect(detectNoiseSignature(false)).toBeNull();
		expect(detectNoiseSignature([])).toBeNull();
		expect(detectNoiseSignature({})).toBeNull();
		expect(detectNoiseSignature(undefined)).toBeNull();
	});
});

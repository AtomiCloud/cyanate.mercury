import { describe, expect, it } from "bun:test";
import { extractJsonArray, extractJsonObject } from "./json-extract.js";

describe("extractJsonObject", () => {
	it("extracts a clean JSON object", () => {
		const result = extractJsonObject('{"key": "value", "num": 42}');
		expect(result).toEqual({ key: "value", num: 42 });
	});

	it("extracts object wrapped in explanation text", () => {
		const text = `Here is the result:\n{"name": "test"}\nDone.`;
		expect(extractJsonObject(text)).toEqual({ name: "test" });
	});

	it("handles nested objects", () => {
		const text = `Output:\n{"a": {"b": [1, 2]}, "c": true}\nEnd`;
		expect(extractJsonObject(text)).toEqual({ a: { b: [1, 2] }, c: true });
	});

	it("skips invalid prefix and finds the real object", () => {
		const text = `{broken\n\nHere:\n{"valid": true}`;
		expect(extractJsonObject(text)).toEqual({ valid: true });
	});

	it("handles brackets inside JSON strings", () => {
		const text = `{"msg": "use {braces} and [brackets]"}`;
		expect(extractJsonObject(text)).toEqual({
			msg: "use {braces} and [brackets]",
		});
	});

	it("handles escaped quotes in strings", () => {
		const text = `{"msg": "he said \\"hello\\""}`;
		expect(extractJsonObject(text)).toEqual({ msg: 'he said "hello"' });
	});

	it("returns null for no JSON", () => {
		expect(extractJsonObject("no json here")).toBeNull();
	});

	it("returns null for empty input", () => {
		expect(extractJsonObject("")).toBeNull();
	});

	it("ignores greedy trap: text with brackets after JSON", () => {
		const text = `{"id": 1}\n\nSee [docs] for more {info}`;
		expect(extractJsonObject(text)).toEqual({ id: 1 });
	});
});

describe("extractJsonArray", () => {
	it("extracts a clean JSON array", () => {
		const result = extractJsonArray('[{"a": 1}, {"a": 2}]');
		expect(result).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it("extracts array wrapped in explanation text", () => {
		const text = `Here are the results:\n[{"type": "blog"}]\nDone.`;
		expect(extractJsonArray(text)).toEqual([{ type: "blog" }]);
	});

	it("skips brackets in surrounding text (greedy regex trap)", () => {
		const text = `Note: see [above]\n\n[{"valid": true}]\n\nAlso [check] this.`;
		// The greedy regex /\[[\s\S]*\]/ would capture from "[above]" to "[check]"
		// Our function should find the valid JSON array
		expect(extractJsonArray(text)).toEqual([{ valid: true }]);
	});

	it("handles nested arrays", () => {
		const text = `[[1, 2], [3, 4]]`;
		expect(extractJsonArray(text)).toEqual([
			[1, 2],
			[3, 4],
		]);
	});

	it("returns null for no array", () => {
		expect(extractJsonArray('{"key": "value"}')).toBeNull();
	});

	it("returns null for empty input", () => {
		expect(extractJsonArray("")).toBeNull();
	});

	it("handles the scout-reference failure case", () => {
		// Agent output with brackets in explanation text after the JSON
		const text = `Here are the mappings I found:
[
  { "sourceType": "about", "referenceUrl": "/about", "confidence": 0.9 }
]

The best matches for your pages...
[see notes above for details]`;
		const result = extractJsonArray(text);
		expect(result).toEqual([
			{
				sourceType: "about",
				referenceUrl: "/about",
				confidence: 0.9,
			},
		]);
	});
});

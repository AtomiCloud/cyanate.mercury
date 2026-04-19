import { describe, expect, test } from "bun:test";
import { __test, deterministicNormalize } from "./deterministic-normalize.js";

const { classifyLeaf } = __test;

describe("classifyLeaf — tautological cases", () => {
	test("native number → number", () => {
		expect(classifyLeaf(42)).toEqual({
			original: 42,
			normalized: 42,
			type: "number",
		});
	});

	test("native boolean → boolean", () => {
		expect(classifyLeaf(true)).toEqual({
			original: true,
			normalized: true,
			type: "boolean",
		});
	});

	test("null → null", () => {
		expect(classifyLeaf(null)).toEqual({
			original: null,
			normalized: null,
			type: "null",
		});
	});

	test("ISO 8601 date string → datetime", () => {
		expect(classifyLeaf("2026-04-17T15:46:52Z")).toEqual({
			original: "2026-04-17T15:46:52Z",
			normalized: "2026-04-17T15:46:52Z",
			type: "datetime",
		});
	});

	test("ISO date-only → datetime", () => {
		expect(classifyLeaf("2026-04-17")).toEqual({
			original: "2026-04-17",
			normalized: "2026-04-17",
			type: "datetime",
		});
	});

	test('"5" → number 5', () => {
		expect(classifyLeaf("5")).toEqual({
			original: "5",
			normalized: 5,
			type: "number",
		});
	});

	test('"3.14" → number 3.14', () => {
		expect(classifyLeaf("3.14")).toEqual({
			original: "3.14",
			normalized: 3.14,
			type: "number",
		});
	});

	test('"true" → boolean true', () => {
		expect(classifyLeaf("true")).toEqual({
			original: "true",
			normalized: true,
			type: "boolean",
		});
	});

	test('"yes" → boolean true (case-insensitive)', () => {
		expect(classifyLeaf("Yes")).toEqual({
			original: "Yes",
			normalized: true,
			type: "boolean",
		});
	});

	test('"no" → boolean false', () => {
		expect(classifyLeaf("no")).toEqual({
			original: "no",
			normalized: false,
			type: "boolean",
		});
	});

	test('"$49.99" → currency 49.99', () => {
		expect(classifyLeaf("$49.99")).toEqual({
			original: "$49.99",
			normalized: 49.99,
			type: "currency",
		});
	});

	test("empty array → array", () => {
		expect(classifyLeaf([])).toEqual({
			original: [],
			normalized: [],
			type: "array",
		});
	});

	test("empty object → object", () => {
		expect(classifyLeaf({})).toEqual({
			original: {},
			normalized: {},
			type: "object",
		});
	});

	test("empty string → string unchanged", () => {
		expect(classifyLeaf("")).toEqual({
			original: "",
			normalized: "",
			type: "string",
		});
	});
});

describe("classifyLeaf — conservative bail-outs", () => {
	test('"2 days ago" → ambiguous (date-ish, not ISO)', () => {
		expect(classifyLeaf("2 days ago")).toBe("ambiguous");
	});

	test('"Feb 2, 2026" → ambiguous (natural-language date)', () => {
		expect(classifyLeaf("Feb 2, 2026")).toBe("ambiguous");
	});

	test('"Rochester, NY" → ambiguous (comma with 2-letter state)', () => {
		expect(classifyLeaf("Rochester, NY")).toBe("ambiguous");
	});

	test('"We offer services, including X." → ambiguous (comma with sentence)', () => {
		expect(classifyLeaf("We offer services, including X.")).toBe("ambiguous");
	});

	test('"1,299" → ambiguous (number-ish with comma)', () => {
		expect(classifyLeaf("1,299")).toBe("ambiguous");
	});

	test('"cardiology, internal medicine" → ambiguous (likely string[] but not sure)', () => {
		expect(classifyLeaf("cardiology, internal medicine")).toBe("ambiguous");
	});
});

describe("classifyLeaf — plain strings fall through to unchanged", () => {
	test("plain title → unchanged", () => {
		expect(classifyLeaf("Premier Healthcare Clinic")).toEqual({
			original: "Premier Healthcare Clinic",
			normalized: "Premier Healthcare Clinic",
			type: "unchanged",
		});
	});

	test("slug-ish string → unchanged", () => {
		expect(classifyLeaf("hero-section")).toEqual({
			original: "hero-section",
			normalized: "hero-section",
			type: "unchanged",
		});
	});
});

describe("deterministicNormalize — walks full content", () => {
	test("resolves obvious leaves, defers ambiguous", () => {
		const content = {
			title: "Premier Clinic",
			rating: 5,
			published: "2026-01-15",
			publishedRelative: "2 days ago",
			price: "$49.99",
			empty: [],
			featured: true,
			specialties: "cardiology, internal medicine",
		};
		const result = deterministicNormalize(content);

		expect(result.resolved.title).toEqual({
			original: "Premier Clinic",
			normalized: "Premier Clinic",
			type: "unchanged",
		});
		expect(result.resolved.rating).toEqual({
			original: 5,
			normalized: 5,
			type: "number",
		});
		expect(result.resolved.published).toEqual({
			original: "2026-01-15",
			normalized: "2026-01-15",
			type: "datetime",
		});
		expect(result.resolved.price).toEqual({
			original: "$49.99",
			normalized: 49.99,
			type: "currency",
		});
		expect(result.resolved.featured).toEqual({
			original: true,
			normalized: true,
			type: "boolean",
		});

		const ambigPaths = result.ambiguous.map((a) => a.path).sort();
		expect(ambigPaths).toEqual(["publishedRelative", "specialties"]);
	});

	test("nested paths use dot + bracket notation", () => {
		const content = {
			hero: { title: "X", rating: 5 },
			items: [{ name: "a" }, { name: "b" }],
		};
		const result = deterministicNormalize(content);
		expect(Object.keys(result.resolved).sort()).toEqual([
			"hero.rating",
			"hero.title",
			"items[0].name",
			"items[1].name",
		]);
		expect(result.ambiguous).toEqual([]);
	});

	test("empty content → empty result", () => {
		const result = deterministicNormalize({});
		expect(result.resolved).toEqual({});
		expect(result.ambiguous).toEqual([]);
	});
});

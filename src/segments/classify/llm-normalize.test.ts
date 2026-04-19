import { describe, expect, test } from "bun:test";
import type { PreparedPage } from "../prepare/ingest.js";
import type { AmbiguousLeaf } from "./deterministic-normalize.js";
import {
	__test,
	buildBatchPrompt,
	parseBatchResponse,
} from "./llm-normalize.js";

const { collectSiblings, parentPath, chunkLeaves, validateEntry } = __test;

const samplePage: PreparedPage = {
	url: "https://example.com/clinic",
	pagetype: "landing",
	content: {
		hero: {
			title: "Premier Clinic",
			subtitle: "cardiology, internal medicine",
			tagline: "Care that heals.",
		},
		posts: [
			{ title: "First", publishedAt: "2 days ago" },
			{ title: "Second", publishedAt: "2026-01-01" },
		],
		price: "$49.99",
	},
	schema: {},
};

const sampleLeaves: AmbiguousLeaf[] = [
	{ path: "hero.subtitle", original: "cardiology, internal medicine" },
	{ path: "posts[0].publishedAt", original: "2 days ago" },
	{ path: "price", original: "$49.99" },
];

describe("parentPath", () => {
	test("dot-path → parent is dot-prefix", () => {
		expect(parentPath("hero.subtitle")).toBe("hero");
	});

	test("bracket-path → parent is base", () => {
		expect(parentPath("posts[0].title")).toBe("posts[0]");
	});

	test("top-level key → empty parent", () => {
		expect(parentPath("hero")).toBe("");
	});

	test("array index alone → empty parent", () => {
		expect(parentPath("[0]")).toBe("");
	});
});

describe("collectSiblings", () => {
	test("primitive siblings of hero.subtitle include hero.title and hero.tagline", () => {
		const siblings = collectSiblings(samplePage.content, "hero.subtitle");
		const paths = siblings.map((s) => s.path);
		expect(paths).toContain("hero.title");
		expect(paths).toContain("hero.tagline");
		expect(paths).not.toContain("hero.subtitle");
		expect(siblings.length).toBeLessThanOrEqual(3);
	});

	test("siblings within an array item", () => {
		const siblings = collectSiblings(
			samplePage.content,
			"posts[0].publishedAt",
		);
		const paths = siblings.map((s) => s.path);
		expect(paths).toEqual(["posts[0].title"]);
	});

	test("skips non-primitive siblings (objects, non-empty arrays)", () => {
		const content = {
			root: {
				leaf: "abc",
				childObj: { deep: "x" },
				childArr: [1, 2, 3],
				other: "def",
			},
		};
		const siblings = collectSiblings(content, "root.leaf");
		const paths = siblings.map((s) => s.path);
		expect(paths).toContain("root.other");
		expect(paths).not.toContain("root.childObj");
		expect(paths).not.toContain("root.childArr");
	});

	test("top-level leaf returns top-level primitive siblings", () => {
		const content = { a: 1, b: "hello", nested: { deep: "x" } };
		const siblings = collectSiblings(content, "a");
		const paths = siblings.map((s) => s.path);
		expect(paths).toContain("b");
		expect(paths).not.toContain("nested");
	});

	test("no parent found → empty array", () => {
		const siblings = collectSiblings(samplePage.content, "missing.path");
		expect(siblings).toEqual([]);
	});
});

describe("chunkLeaves", () => {
	test("chunks into batches of requested size", () => {
		const leaves = Array.from({ length: 25 }, (_, i) => ({
			path: `field${i}`,
			original: i,
		}));
		const batches = chunkLeaves(leaves, 10);
		expect(batches).toHaveLength(3);
		expect(batches[0]).toHaveLength(10);
		expect(batches[1]).toHaveLength(10);
		expect(batches[2]).toHaveLength(5);
	});

	test("empty input → empty batches", () => {
		expect(chunkLeaves([], 10)).toEqual([]);
	});

	test("exactly divisible input", () => {
		const leaves = Array.from({ length: 20 }, (_, i) => ({
			path: `f${i}`,
			original: i,
		}));
		const batches = chunkLeaves(leaves, 10);
		expect(batches).toHaveLength(2);
		expect(batches[0]).toHaveLength(10);
		expect(batches[1]).toHaveLength(10);
	});
});

describe("buildBatchPrompt", () => {
	test("includes page URL and pagetype", () => {
		const prompt = buildBatchPrompt(
			samplePage,
			sampleLeaves,
			samplePage.content,
		);
		expect(prompt).toContain("https://example.com/clinic");
		expect(prompt).toContain("landing");
	});

	test("includes each leaf path and value", () => {
		const prompt = buildBatchPrompt(
			samplePage,
			sampleLeaves,
			samplePage.content,
		);
		for (const leaf of sampleLeaves) {
			expect(prompt).toContain(leaf.path);
		}
		expect(prompt).toContain('"cardiology, internal medicine"');
		expect(prompt).toContain('"$49.99"');
	});

	test("lists leaf count", () => {
		const prompt = buildBatchPrompt(
			samplePage,
			sampleLeaves,
			samplePage.content,
		);
		expect(prompt).toContain(`LEAVES (${sampleLeaves.length})`);
	});

	test("siblings are included for each leaf", () => {
		const prompt = buildBatchPrompt(
			samplePage,
			[sampleLeaves[0] as AmbiguousLeaf],
			samplePage.content,
		);
		expect(prompt).toContain("hero.title");
		expect(prompt).toContain("hero.tagline");
	});

	test("rejection context appended when provided", () => {
		const prompt = buildBatchPrompt(
			samplePage,
			sampleLeaves,
			samplePage.content,
			'- price: type "foo" is invalid',
		);
		expect(prompt).toContain("PREVIOUS ATTEMPT REJECTED");
		expect(prompt).toContain('type "foo" is invalid');
	});

	test("no rejection context by default", () => {
		const prompt = buildBatchPrompt(
			samplePage,
			sampleLeaves,
			samplePage.content,
		);
		expect(prompt).not.toContain("PREVIOUS ATTEMPT REJECTED");
	});

	test("output instruction requests JSON array with path key", () => {
		const prompt = buildBatchPrompt(
			samplePage,
			sampleLeaves,
			samplePage.content,
		);
		expect(prompt).toContain('"path"');
		expect(prompt).toContain('"type"');
		expect(prompt).toContain('"normalized"');
	});

	test("prompt explains noise detection rules and isNoise/reason schema", () => {
		const prompt = buildBatchPrompt(
			samplePage,
			sampleLeaves,
			samplePage.content,
		);
		expect(prompt).toContain("scraper artifact");
		expect(prompt).toContain("breadcrumb");
		expect(prompt).toContain("isNoise");
		expect(prompt).toContain("reason");
	});
});

describe("parseBatchResponse", () => {
	test("all entries valid → all resolved, none unresolved", () => {
		const out = JSON.stringify([
			{
				path: "hero.subtitle",
				type: "string[]",
				normalized: ["cardiology", "internal medicine"],
			},
			{
				path: "posts[0].publishedAt",
				type: "datetime",
				normalized: "2026-02-02T00:00:00Z",
			},
			{ path: "price", type: "currency", normalized: 49.99 },
		]);
		const result = parseBatchResponse(out, sampleLeaves);
		expect(Object.keys(result.resolved)).toHaveLength(3);
		expect(result.unresolved).toEqual([]);
		expect(result.resolved.price).toEqual({
			original: "$49.99",
			normalized: 49.99,
			type: "currency",
		});
	});

	test("one invalid entry → that path is unresolved, others resolved", () => {
		const out = JSON.stringify([
			{
				path: "hero.subtitle",
				type: "string[]",
				normalized: ["cardiology"],
			},
			{
				path: "posts[0].publishedAt",
				type: "datetime",
				normalized: "not a date",
			},
			{ path: "price", type: "currency", normalized: 49.99 },
		]);
		const result = parseBatchResponse(out, sampleLeaves);
		expect(Object.keys(result.resolved)).toHaveLength(2);
		expect(result.unresolved).toHaveLength(1);
		expect(result.unresolved[0]?.path).toBe("posts[0].publishedAt");
	});

	test("missing path in response → marked unresolved", () => {
		const out = JSON.stringify([
			{
				path: "hero.subtitle",
				type: "string[]",
				normalized: ["cardiology"],
			},
			{ path: "price", type: "currency", normalized: 49.99 },
		]);
		const result = parseBatchResponse(out, sampleLeaves);
		expect(result.unresolved).toHaveLength(1);
		expect(result.unresolved[0]?.path).toBe("posts[0].publishedAt");
		expect(result.unresolved[0]?.reason).toMatch(/missing/);
	});

	test("non-array response → all unresolved", () => {
		const result = parseBatchResponse("hello world", sampleLeaves);
		expect(Object.keys(result.resolved)).toHaveLength(0);
		expect(result.unresolved).toHaveLength(sampleLeaves.length);
	});

	test("extracts array wrapped in prose", () => {
		const out = `Here you go:
[{"path": "price", "type": "currency", "normalized": 49.99}]`;
		const result = parseBatchResponse(out, [
			{ path: "price", original: "$49.99" },
		]);
		expect(result.resolved.price).toBeDefined();
	});

	test("entry missing required keys is skipped → marked unresolved", () => {
		const out = JSON.stringify([
			{ path: "price", type: "currency" },
			{ path: "hero.subtitle" },
		]);
		const result = parseBatchResponse(out, sampleLeaves);
		expect(result.resolved).toEqual({});
		expect(result.unresolved.map((u) => u.path)).toEqual(
			expect.arrayContaining(["price", "hero.subtitle"]),
		);
	});

	test("isNoise=true flows through to resolved entry with noise mark", () => {
		const leaves: AmbiguousLeaf[] = [
			{ path: "hero.breadcrumb", original: "Home > About > Team" },
			{ path: "price", original: "$49.99" },
		];
		const out = JSON.stringify([
			{
				path: "hero.breadcrumb",
				type: "unchanged",
				normalized: "Home > About > Team",
				isNoise: true,
				reason: "leaked breadcrumb chrome",
			},
			{
				path: "price",
				type: "currency",
				normalized: 49.99,
				isNoise: false,
			},
		]);
		const result = parseBatchResponse(out, leaves);
		expect(result.unresolved).toEqual([]);
		expect(result.resolved["hero.breadcrumb"]).toEqual({
			original: "Home > About > Team",
			normalized: "Home > About > Team",
			type: "unchanged",
			noise: { signature: "llm", reason: "leaked breadcrumb chrome" },
		});
		expect(result.resolved.price).toEqual({
			original: "$49.99",
			normalized: 49.99,
			type: "currency",
		});
	});

	test("isNoise=true without reason → entry unresolved", () => {
		const out = JSON.stringify([
			{
				path: "price",
				type: "currency",
				normalized: 49.99,
				isNoise: true,
			},
		]);
		const result = parseBatchResponse(out, [
			{ path: "price", original: "$49.99" },
		]);
		expect(result.resolved).toEqual({});
		expect(result.unresolved[0]?.path).toBe("price");
		expect(result.unresolved[0]?.reason).toMatch(/reason/);
	});
});

describe("validateEntry", () => {
	test("valid number", () => {
		expect(validateEntry({ type: "number", normalized: 5 }, "5")).toEqual({
			original: "5",
			normalized: 5,
			type: "number",
		});
	});

	test("number with string normalized → error", () => {
		const r = validateEntry({ type: "number", normalized: "five" }, "five");
		expect(typeof r).toBe("string");
	});

	test("boolean with non-boolean → error", () => {
		const r = validateEntry({ type: "boolean", normalized: "true" }, "true");
		expect(typeof r).toBe("string");
	});

	test("string[] with non-array → error", () => {
		const r = validateEntry({ type: "string[]", normalized: "a,b" }, "a, b");
		expect(typeof r).toBe("string");
	});

	test("datetime unparseable → error", () => {
		const r = validateEntry(
			{ type: "datetime", normalized: "not a date" },
			"x",
		);
		expect(typeof r).toBe("string");
	});

	test("invalid type name → error", () => {
		const r = validateEntry({ type: "wibble", normalized: "x" }, "x");
		expect(typeof r).toBe("string");
	});

	test("null accepted for numeric", () => {
		expect(validateEntry({ type: "number", normalized: null }, "")).toEqual({
			original: "",
			normalized: null,
			type: "number",
		});
	});

	test("isNoise=true with reason attaches noise mark", () => {
		const r = validateEntry(
			{
				type: "unchanged",
				normalized: "Home > Blog > Post",
				isNoise: true,
				reason: "leaked breadcrumb",
			},
			"Home > Blog > Post",
		);
		expect(r).toEqual({
			original: "Home > Blog > Post",
			normalized: "Home > Blog > Post",
			type: "unchanged",
			noise: { signature: "llm", reason: "leaked breadcrumb" },
		});
	});

	test("isNoise=true without reason → error", () => {
		const r = validateEntry(
			{ type: "unchanged", normalized: "x", isNoise: true },
			"x",
		);
		expect(typeof r).toBe("string");
		expect(r).toMatch(/reason/);
	});

	test("isNoise=true with empty reason → error", () => {
		const r = validateEntry(
			{ type: "unchanged", normalized: "x", isNoise: true, reason: "   " },
			"x",
		);
		expect(typeof r).toBe("string");
		expect(r).toMatch(/reason/);
	});

	test("isNoise=false (or omitted) → no noise mark", () => {
		expect(
			validateEntry(
				{ type: "unchanged", normalized: "Premier Clinic", isNoise: false },
				"Premier Clinic",
			),
		).toEqual({
			original: "Premier Clinic",
			normalized: "Premier Clinic",
			type: "unchanged",
		});
	});

	test("isNoise with non-boolean → error", () => {
		const r = validateEntry(
			{ type: "unchanged", normalized: "x", isNoise: "maybe" },
			"x",
		);
		expect(typeof r).toBe("string");
	});

	test("reason is trimmed on the noise mark", () => {
		const r = validateEntry(
			{
				type: "unchanged",
				normalized: "x",
				isNoise: true,
				reason: "  leaked breadcrumb  ",
			},
			"x",
		);
		expect(r).toEqual({
			original: "x",
			normalized: "x",
			type: "unchanged",
			noise: { signature: "llm", reason: "leaked breadcrumb" },
		});
	});
});

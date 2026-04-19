import { describe, expect, it } from "bun:test";
import type { PreparedPage } from "../prepare/ingest.js";
import {
	applyAllNormalizations,
	checkNormalization,
	classifyUnitHash,
	findMissingNormalization,
	getClassifyUnits,
	type PageNormalization,
	parseNormalizationFromAgent,
} from "./per-page-classify.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function page(
	url: string,
	pagetype: string,
	content: Record<string, unknown>,
): PreparedPage {
	return { url, pagetype, content, schema: {} };
}

// ---------------------------------------------------------------------------
// classifyUnitHash
// ---------------------------------------------------------------------------

describe("classifyUnitHash", () => {
	it("returns a 12-char hex string", () => {
		const hash = classifyUnitHash("/about/");
		expect(hash).toHaveLength(12);
		expect(hash).toMatch(/^[0-9a-f]+$/);
	});

	it("is deterministic", () => {
		expect(classifyUnitHash("/about/")).toBe(classifyUnitHash("/about/"));
	});

	it("differs for different URLs", () => {
		expect(classifyUnitHash("/about/")).not.toBe(classifyUnitHash("/contact/"));
	});
});

// ---------------------------------------------------------------------------
// getClassifyUnits
// ---------------------------------------------------------------------------

describe("getClassifyUnits", () => {
	it("creates one unit per page", () => {
		const pages = [page("/a/", "a", {}), page("/b/", "b", {})];
		const units = getClassifyUnits(pages);
		expect(units).toHaveLength(2);
		expect(units[0].page.url).toBe("/a/");
		expect(units[1].page.url).toBe("/b/");
	});

	it("sets id from URL hash", () => {
		const units = getClassifyUnits([page("/about/", "about", {})]);
		expect(units[0].id).toBe(classifyUnitHash("/about/"));
	});
});

// ---------------------------------------------------------------------------
// parseNormalizationFromAgent
// ---------------------------------------------------------------------------

describe("parseNormalizationFromAgent", () => {
	const p = page("/test/", "test", { title: "Hello" });

	it("parses valid JSON with entries", () => {
		const output = JSON.stringify({
			entries: {
				title: { original: "Hello", normalized: "Hello", type: "unchanged" },
			},
		});
		const result = parseNormalizationFromAgent(output, p);
		expect(result).not.toBeNull();
		expect(result?.url).toBe("/test/");
		expect(result?.entries.title.type).toBe("unchanged");
	});

	it("parses markdown-fenced JSON", () => {
		const output = `Here are the normalizations:\n\`\`\`json\n${JSON.stringify({
			entries: {
				title: { original: "Hello", normalized: "Hello", type: "unchanged" },
			},
		})}\n\`\`\``;
		const result = parseNormalizationFromAgent(output, p);
		expect(result).not.toBeNull();
	});

	it("returns null for non-JSON output", () => {
		expect(parseNormalizationFromAgent("no json here", p)).toBeNull();
	});

	it("returns null when entries is missing", () => {
		expect(
			parseNormalizationFromAgent(JSON.stringify({ foo: "bar" }), p),
		).toBeNull();
	});

	it("returns null when entries is an array", () => {
		expect(
			parseNormalizationFromAgent(JSON.stringify({ entries: [] }), p),
		).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// parseNormalizationFromAgent — malformed entry structure
// ---------------------------------------------------------------------------

describe("parseNormalizationFromAgent — entry validation", () => {
	const p = page("/test/", "test", { title: "Hello", count: "5" });

	it("rejects entries that are strings instead of objects", () => {
		const output = JSON.stringify({
			entries: {
				title: "just a string",
				count: { original: "5", normalized: 5, type: "number" },
			},
		});
		const result = parseNormalizationFromAgent(output, p);
		expect(result).not.toBeNull();
		expect(result?.entries.title).toBeUndefined();
		expect(result?.entries.count).toBeDefined();
		expect(result?.entries.count.type).toBe("number");
	});

	it("rejects entries missing 'original' field", () => {
		const output = JSON.stringify({
			entries: {
				title: { normalized: "Hello", type: "unchanged" },
			},
		});
		const result = parseNormalizationFromAgent(output, p);
		expect(result).toBeNull();
	});

	it("rejects entries missing 'type' field", () => {
		const output = JSON.stringify({
			entries: {
				title: { original: "Hello", normalized: "Hello" },
			},
		});
		const result = parseNormalizationFromAgent(output, p);
		expect(result).toBeNull();
	});

	it("rejects entries where 'type' is not a string", () => {
		const output = JSON.stringify({
			entries: {
				title: { original: "Hello", normalized: "Hello", type: 42 },
			},
		});
		const result = parseNormalizationFromAgent(output, p);
		expect(result).toBeNull();
	});

	it("returns null when all entries are malformed", () => {
		const output = JSON.stringify({
			entries: {
				title: "bad",
				count: null,
				foo: [1, 2, 3],
			},
		});
		const result = parseNormalizationFromAgent(output, p);
		expect(result).toBeNull();
	});

	it("keeps valid entries and drops invalid ones", () => {
		const output = JSON.stringify({
			entries: {
				title: { original: "Hello", normalized: "Hello", type: "unchanged" },
				bad1: "just a string",
				bad2: { normalized: "x", type: "string" },
				count: { original: "5", normalized: 5, type: "number" },
			},
		});
		const result = parseNormalizationFromAgent(output, p);
		expect(result).not.toBeNull();
		expect(Object.keys(result?.entries ?? {})).toHaveLength(2);
		expect(result?.entries.title).toBeDefined();
		expect(result?.entries.count).toBeDefined();
		expect(result?.entries.bad1).toBeUndefined();
		expect(result?.entries.bad2).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// checkNormalization — type-shape errors
// ---------------------------------------------------------------------------

describe("checkNormalization — type errors", () => {
	const content = { title: "Hello", count: "5" };

	it("passes for valid normalization with full coverage", () => {
		const norm: PageNormalization = {
			url: "/test/",
			pagetype: "test",
			entries: {
				title: { original: "Hello", normalized: "Hello", type: "unchanged" },
				count: { original: "5", normalized: 5, type: "number" },
			},
		};
		const result = checkNormalization(norm, content);
		expect(result.valid).toBe(true);
		expect(result.typeErrors).toEqual([]);
	});

	it("rejects invalid type", () => {
		const norm: PageNormalization = {
			url: "/test/",
			pagetype: "test",
			entries: {
				title: {
					original: "Hello",
					normalized: "Hello",
					type: "badtype" as never,
				},
				count: { original: "5", normalized: 5, type: "number" },
			},
		};
		const result = checkNormalization(norm, content);
		expect(result.valid).toBe(false);
		expect(result.typeErrors.some((e) => e.includes("invalid type"))).toBe(
			true,
		);
	});

	it("rejects number type with string normalized value", () => {
		const norm: PageNormalization = {
			url: "/test/",
			pagetype: "test",
			entries: {
				title: { original: "Hello", normalized: "Hello", type: "unchanged" },
				count: { original: "5", normalized: "five", type: "number" },
			},
		};
		const result = checkNormalization(norm, content);
		expect(result.valid).toBe(false);
		expect(result.typeErrors.some((e) => e.includes("number"))).toBe(true);
	});

	it("rejects boolean type with non-boolean normalized value", () => {
		const content2 = { active: "yes" };
		const norm: PageNormalization = {
			url: "/test/",
			pagetype: "test",
			entries: {
				active: { original: "yes", normalized: "yes", type: "boolean" },
			},
		};
		const result = checkNormalization(norm, content2);
		expect(result.valid).toBe(false);
		expect(result.typeErrors.some((e) => e.includes("boolean"))).toBe(true);
	});

	it("rejects string[] type with non-array normalized value", () => {
		const content2 = { tags: "a, b" };
		const norm: PageNormalization = {
			url: "/test/",
			pagetype: "test",
			entries: {
				tags: { original: "a, b", normalized: "a, b", type: "string[]" },
			},
		};
		const result = checkNormalization(norm, content2);
		expect(result.valid).toBe(false);
		expect(result.typeErrors.some((e) => e.includes("string[]"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// checkNormalization — exhaustive coverage + round-trip diagnostics
// ---------------------------------------------------------------------------

describe("checkNormalization", () => {
	it("is valid for a complete, matching normalization", () => {
		const content = {
			hero: { title: "Hi" },
			footer: { copyright: "2024" },
		};
		const norm: PageNormalization = {
			url: "/x/",
			pagetype: "x",
			entries: {
				"hero.title": {
					original: "Hi",
					normalized: "Hi",
					type: "unchanged",
				},
				"footer.copyright": {
					original: "2024",
					normalized: "2024",
					type: "unchanged",
				},
			},
		};
		const result = checkNormalization(norm, content);
		expect(result.valid).toBe(true);
		expect(result.missing).toEqual([]);
		expect(result.extra).toEqual([]);
		expect(result.typeErrors).toEqual([]);
		expect(result.roundTripErrors).toEqual([]);
	});

	it("reports missing leaf paths when coverage is incomplete", () => {
		const content = { hero: { title: "Hi" }, footer: { copy: "c" } };
		const norm: PageNormalization = {
			url: "/x/",
			pagetype: "x",
			entries: {
				"hero.title": {
					original: "Hi",
					normalized: "Hi",
					type: "unchanged",
				},
			},
		};
		const result = checkNormalization(norm, content);
		expect(result.valid).toBe(false);
		expect(result.missing).toContain("footer.copy");
	});

	it("reports extra paths not present in content", () => {
		const content = { hero: { title: "Hi" } };
		const norm: PageNormalization = {
			url: "/x/",
			pagetype: "x",
			entries: {
				"hero.title": {
					original: "Hi",
					normalized: "Hi",
					type: "unchanged",
				},
				"content.hero.title": {
					original: "Hi",
					normalized: "Hi",
					type: "unchanged",
				},
			},
		};
		const result = checkNormalization(norm, content);
		expect(result.valid).toBe(false);
		expect(result.extra).toContain("content.hero.title");
	});

	it("reports round-trip mismatches when original disagrees with content", () => {
		const content = { hero: { title: "Real Title" } };
		const norm: PageNormalization = {
			url: "/x/",
			pagetype: "x",
			entries: {
				"hero.title": {
					original: "Wrong",
					normalized: "Wrong",
					type: "unchanged",
				},
			},
		};
		const result = checkNormalization(norm, content);
		expect(result.valid).toBe(false);
		expect(result.roundTripErrors.length).toBeGreaterThan(0);
		expect(result.roundTripErrors[0]).toContain("hero.title");
	});
});

// ---------------------------------------------------------------------------
// applyAllNormalizations
// ---------------------------------------------------------------------------

describe("applyAllNormalizations", () => {
	it("applies non-trivial normalizations, skips unchanged/object/array/null", () => {
		const content = {
			title: "Hello",
			price: "$49.99",
			tags: "alpha, beta",
			count: "5",
			wrapper: { child: 1 },
			list: [1, 2],
			missing: null,
		};
		const norm: PageNormalization = {
			url: "/x/",
			pagetype: "x",
			entries: {
				title: { original: "Hello", normalized: "Hello", type: "unchanged" },
				price: { original: "$49.99", normalized: 49.99, type: "currency" },
				tags: {
					original: "alpha, beta",
					normalized: ["alpha", "beta"],
					type: "string[]",
				},
				count: { original: "5", normalized: 5, type: "number" },
				wrapper: { original: { child: 1 }, normalized: null, type: "object" },
				list: { original: [1, 2], normalized: null, type: "array" },
				missing: { original: null, normalized: null, type: "null" },
			},
		};
		const result = applyAllNormalizations(content, norm);
		expect(result.title).toBe("Hello");
		expect(result.price).toBe(49.99);
		expect(result.tags).toEqual(["alpha", "beta"]);
		expect(result.count).toBe(5);
		expect(result.wrapper).toEqual({ child: 1 });
		expect(result.list).toEqual([1, 2]);
		expect(result.missing).toBeNull();
	});

	it("does not mutate the input content", () => {
		const content = { price: "$10" };
		const norm: PageNormalization = {
			url: "/x/",
			pagetype: "x",
			entries: {
				price: { original: "$10", normalized: 10, type: "currency" },
			},
		};
		const result = applyAllNormalizations(content, norm);
		expect(content.price).toBe("$10");
		expect(result.price).toBe(10);
	});

	it("handles array-indexed paths", () => {
		const content = {
			items: [{ price: "$1" }, { price: "$2" }],
		};
		const norm: PageNormalization = {
			url: "/x/",
			pagetype: "x",
			entries: {
				"items[0].price": { original: "$1", normalized: 1, type: "currency" },
				"items[1].price": { original: "$2", normalized: 2, type: "currency" },
			},
		};
		const result = applyAllNormalizations(content, norm) as {
			items: Array<{ price: unknown }>;
		};
		expect(result.items[0].price).toBe(1);
		expect(result.items[1].price).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// findMissingNormalization
// ---------------------------------------------------------------------------

describe("findMissingNormalization", () => {
	it("returns empty when every unit has a result", () => {
		const units = getClassifyUnits([page("/a/", "a", {})]);
		const results = new Map<string, PageNormalization>([
			[units[0].id, { url: "/a/", pagetype: "a", entries: {} }],
		]);
		const missing = findMissingNormalization(results, units, new Map());
		expect(missing).toHaveLength(0);
	});

	it("reports units with no result using generic fallback context", () => {
		const units = getClassifyUnits([page("/a/", "a", {})]);
		const missing = findMissingNormalization(
			new Map<string, PageNormalization>(),
			units,
			new Map(),
		);
		expect(missing).toHaveLength(1);
		expect(missing[0].rejectionContext).toContain("No result returned");
		expect(missing[0].rejectionContext).toContain("/a/");
	});

	it("surfaces specific unitErrors as rejection context", () => {
		const units = getClassifyUnits([page("/a/", "a", {})]);
		const unitErrors = new Map<string, string>([
			[units[0].id, "Agent did not write normalization.json"],
		]);
		const missing = findMissingNormalization(
			new Map<string, PageNormalization>(),
			units,
			unitErrors,
		);
		expect(missing).toHaveLength(1);
		expect(missing[0].rejectionContext).toBe(
			"Agent did not write normalization.json",
		);
	});
});

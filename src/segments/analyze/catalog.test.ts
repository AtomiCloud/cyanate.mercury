import { describe, expect, it } from "bun:test";
import type { StructureData } from "../../types.js";
import type { ScoutResult } from "./catalog.js";
import {
	buildCatalog,
	extractPageTypes,
	filterByConfidence,
} from "./catalog.js";

// ---------------------------------------------------------------------------
// extractPageTypes
// ---------------------------------------------------------------------------

describe("extractPageTypes", () => {
	it("extracts unique page types and sorts alphabetically", () => {
		const structure: StructureData = {
			site_url: "https://example.com",
			pages: [
				{ id: "1", url: "/", pagetype: "landing", title: "Home" },
				{ id: "2", url: "/about", pagetype: "about", title: "About" },
				{ id: "3", url: "/blog", pagetype: "blog", title: "Blog" },
				{ id: "4", url: "/blog/post-1", pagetype: "blog", title: "Post 1" },
			],
		};

		const result = extractPageTypes(structure);
		expect(result).toEqual(["about", "blog", "landing"]);
	});

	it("handles empty pages", () => {
		const structure: StructureData = {
			pages: [],
		};
		expect(extractPageTypes(structure)).toEqual([]);
	});

	it("ignores pages without pagetype", () => {
		const structure = {
			pages: [{ id: "1", url: "/", title: "No type" }],
		} as unknown as StructureData;
		expect(extractPageTypes(structure)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// filterByConfidence
// ---------------------------------------------------------------------------

describe("filterByConfidence", () => {
	const mappings: ScoutResult["mappings"] = [
		{ sourceType: "landing", referenceUrl: "/home", confidence: 0.9 },
		{ sourceType: "about", referenceUrl: "/about-us", confidence: 0.55 },
		{ sourceType: "blog", referenceUrl: "/blog-index", confidence: 0.3 },
		{ sourceType: "contact", referenceUrl: "/contact", confidence: 0.7 },
	];

	it("buckets correctly at 0.4/0.7 thresholds", () => {
		const { matched, lowConfidence, skipped } = filterByConfidence(mappings);

		expect(matched.map((m) => m.sourceType)).toEqual(["landing", "contact"]);
		expect(lowConfidence.map((m) => m.sourceType)).toEqual(["about"]);
		expect(skipped.map((m) => m.sourceType)).toEqual(["blog"]);
	});

	it("all matched with high confidence", () => {
		const allHigh = mappings.map((m) => ({ ...m, confidence: 0.95 }));
		const { matched, lowConfidence, skipped } = filterByConfidence(allHigh);

		expect(matched).toHaveLength(4);
		expect(lowConfidence).toHaveLength(0);
		expect(skipped).toHaveLength(0);
	});

	it("all skipped with very low confidence", () => {
		const allLow = mappings.map((m) => ({ ...m, confidence: 0.1 }));
		const { matched, lowConfidence, skipped } = filterByConfidence(allLow);

		expect(matched).toHaveLength(0);
		expect(lowConfidence).toHaveLength(0);
		expect(skipped).toHaveLength(4);
	});

	it("handles empty mappings", () => {
		const { matched, lowConfidence, skipped } = filterByConfidence([]);

		expect(matched).toEqual([]);
		expect(lowConfidence).toEqual([]);
		expect(skipped).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// buildCatalog
// ---------------------------------------------------------------------------

describe("buildCatalog", () => {
	it("integrates extraction + filtering", () => {
		const pageTypes = ["landing", "about", "blog", "contact", "pricing"];
		const scoutResult: ScoutResult = {
			mappings: [
				{ sourceType: "landing", referenceUrl: "/home", confidence: 0.9 },
				{ sourceType: "about", referenceUrl: "/about", confidence: 0.55 },
				{ sourceType: "blog", referenceUrl: "/blog", confidence: 0.3 },
				{ sourceType: "contact", referenceUrl: "/contact", confidence: 0.7 },
			],
		};

		const catalog = buildCatalog(pageTypes, scoutResult);

		expect(catalog.matched.map((m) => m.sourceType)).toEqual([
			"landing",
			"contact",
		]);
		expect(catalog.lowConfidence).toEqual(["about"]);
		expect(catalog.skipped).toEqual(["blog"]);
		// pricing has no mapping → unmatched
		expect(catalog.unmatched).toEqual(["pricing"]);
	});

	it("handles empty scout result", () => {
		const pageTypes = ["landing", "about"];
		const catalog = buildCatalog(pageTypes, { mappings: [] });

		expect(catalog.matched).toEqual([]);
		expect(catalog.lowConfidence).toEqual([]);
		expect(catalog.skipped).toEqual([]);
		expect(catalog.unmatched).toEqual(["about", "landing"]);
		expect(catalog.generic).toEqual([]);
	});

	it("handles all-skipped", () => {
		const pageTypes = ["a", "b"];
		const catalog = buildCatalog(pageTypes, {
			mappings: [
				{ sourceType: "a", referenceUrl: "/a", confidence: 0.1 },
				{ sourceType: "b", referenceUrl: "/b", confidence: 0.2 },
			],
		});

		expect(catalog.matched).toEqual([]);
		expect(catalog.lowConfidence).toEqual([]);
		expect(catalog.skipped).toEqual(["a", "b"]);
		expect(catalog.unmatched).toEqual([]);
	});
});

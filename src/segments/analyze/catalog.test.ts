import { describe, expect, it } from "bun:test";
import type { StructureData } from "../../types.js";
import type { Catalog, ScoutResult } from "./catalog.js";
import {
	buildCatalog,
	extractPageTypes,
	filterByConfidence,
	selectDesignPages,
} from "./catalog.js";

// ---------------------------------------------------------------------------
// extractPageTypes
// ---------------------------------------------------------------------------

describe("extractPageTypes", () => {
	it("extracts unique page types and sorts alphabetically", () => {
		const structure: StructureData = {
			site_url: "https://example.com",
			page_types: [
				{
					name: "landing",
					url_pattern: "/",
					description: "Landing page",
					sample_urls: ["/"],
					urls: ["/"],
				},
				{
					name: "about",
					url_pattern: "/about",
					description: "About page",
					sample_urls: ["/about"],
					urls: ["/about"],
				},
				{
					name: "blog",
					url_pattern: "/blog/{slug}",
					description: "Blog posts",
					sample_urls: ["/blog/post-1"],
					urls: ["/blog", "/blog/post-1"],
				},
			],
		};

		const result = extractPageTypes(structure);
		expect(result).toEqual(["about", "blog", "landing"]);
	});

	it("handles empty page_types", () => {
		const structure: StructureData = {
			page_types: [],
		};
		expect(extractPageTypes(structure)).toEqual([]);
	});

	it("ignores page types without name", () => {
		const structure = {
			page_types: [{ url_pattern: "/", description: "No name" }],
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

// ---------------------------------------------------------------------------
// selectDesignPages
// ---------------------------------------------------------------------------

function makeCatalog(
	matched: Array<{
		sourceType: string;
		referenceUrl: string;
		confidence: number;
	}>,
): Catalog {
	return {
		matched,
		unmatched: [],
		generic: [],
		lowConfidence: [],
		skipped: [],
	};
}

describe("selectDesignPages", () => {
	it("returns all matched when ≤ 3", () => {
		const catalog = makeCatalog([
			{ sourceType: "landing", referenceUrl: "/", confidence: 0.9 },
			{ sourceType: "about", referenceUrl: "/about", confidence: 0.8 },
		]);
		const result = selectDesignPages(catalog);
		expect(result.designPages).toHaveLength(2);
		expect(result.componentPages).toHaveLength(2);
	});

	it("returns single matched page", () => {
		const catalog = makeCatalog([
			{ sourceType: "home", referenceUrl: "/", confidence: 0.95 },
		]);
		const result = selectDesignPages(catalog);
		expect(result.designPages).toHaveLength(1);
		expect(result.designPages[0].sourceType).toBe("home");
	});

	it("returns empty for no matched pages", () => {
		const catalog = makeCatalog([]);
		const result = selectDesignPages(catalog);
		expect(result.designPages).toEqual([]);
		expect(result.componentPages).toEqual([]);
	});

	it("selects 3 diverse pages from 6 matched", () => {
		const catalog = makeCatalog([
			{ sourceType: "landing", referenceUrl: "/", confidence: 0.95 },
			{ sourceType: "blog", referenceUrl: "/blog", confidence: 0.9 },
			{ sourceType: "pricing", referenceUrl: "/pricing", confidence: 0.85 },
			{ sourceType: "contact", referenceUrl: "/contact", confidence: 0.8 },
			{ sourceType: "features", referenceUrl: "/features", confidence: 0.75 },
			{ sourceType: "docs", referenceUrl: "/docs", confidence: 0.7 },
		]);
		const result = selectDesignPages(catalog);

		expect(result.designPages).toHaveLength(3);
		// Should pick one from each tier: landing (tier 0), blog (tier 1), pricing (tier 2)
		const types = result.designPages.map((d) => d.sourceType);
		expect(types).toContain("landing");
		expect(types).toContain("blog");
		expect(types).toContain("pricing");

		// componentPages should include ALL matched
		expect(result.componentPages).toHaveLength(6);
	});

	it("fills remaining slots from highest confidence when tiers overlap", () => {
		const catalog = makeCatalog([
			{ sourceType: "home", referenceUrl: "/", confidence: 0.95 },
			{ sourceType: "index", referenceUrl: "/index", confidence: 0.9 },
			{ sourceType: "main", referenceUrl: "/main", confidence: 0.85 },
			{ sourceType: "gallery", referenceUrl: "/gallery", confidence: 0.8 },
		]);
		const result = selectDesignPages(catalog);

		expect(result.designPages).toHaveLength(3);
		// home (tier 0), gallery (tier 3/uncategorized), then index (tier 0, fill pass)
		const types = result.designPages.map((d) => d.sourceType);
		expect(types).toContain("home");
		expect(types).toContain("gallery");
	});

	it("preserves original catalog fields in output", () => {
		const catalog: Catalog = {
			matched: [{ sourceType: "landing", referenceUrl: "/", confidence: 0.9 }],
			unmatched: ["orphan"],
			generic: ["/extra"],
			lowConfidence: ["maybe"],
			skipped: ["nope"],
		};
		const result = selectDesignPages(catalog);
		expect(result.unmatched).toEqual(["orphan"]);
		expect(result.generic).toEqual(["/extra"]);
		expect(result.lowConfidence).toEqual(["maybe"]);
		expect(result.skipped).toEqual(["nope"]);
	});
});

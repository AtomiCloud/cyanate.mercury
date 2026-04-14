/**
 * Pure: catalog builder.
 *
 * Extracts page types from structure data, filters by confidence,
 * and builds an extraction catalog for the analyze segment.
 */

import type { StructureData } from "../../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScoutResult {
	mappings: Array<{
		sourceType: string;
		referenceUrl: string;
		confidence: number;
	}>;
}

export interface CatalogEntry {
	sourceType: string;
	referenceUrl: string;
	confidence: number;
}

export interface Catalog {
	matched: CatalogEntry[];
	unmatched: string[];
	generic: string[];
	lowConfidence: string[];
	skipped: string[];
}

export interface CatalogWithSelection extends Catalog {
	designPages: Array<{ sourceType: string; referenceUrl: string }>;
	componentPages: Array<{ sourceType: string; referenceUrl: string }>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS = {
	full: 0.7,
	low: 0.4,
} as const;

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Extract unique page types from structure data.
 * Returns sorted, deduplicated list.
 */
export function extractPageTypes(structure: StructureData): string[] {
	const types = new Set<string>();
	for (const pt of structure.page_types) {
		if (pt.name) {
			types.add(pt.name);
		}
	}
	return [...types].sort();
}

/**
 * Filter catalog entries by confidence thresholds.
 *
 * - >= full threshold → matched
 * - low..full → lowConfidence
 * - < low → skipped
 */
export function filterByConfidence(
	mappings: ScoutResult["mappings"],
	thresholds: { full: number; low: number } = DEFAULT_THRESHOLDS,
): {
	matched: typeof mappings;
	lowConfidence: typeof mappings;
	skipped: typeof mappings;
} {
	const matched: typeof mappings = [];
	const lowConfidence: typeof mappings = [];
	const skipped: typeof mappings = [];

	for (const m of mappings) {
		if (m.confidence >= thresholds.full) {
			matched.push(m);
		} else if (m.confidence >= thresholds.low) {
			lowConfidence.push(m);
		} else {
			skipped.push(m);
		}
	}

	return { matched, lowConfidence, skipped };
}

/**
 * Build extraction catalog from page types and scout result.
 *
 * - matched: high-confidence source→reference mappings
 * - unmatched: source types with no reference match at all
 * - generic: reference URLs not tied to any source type
 * - lowConfidence: source types in 0.4–0.7 range
 * - skipped: source types below 0.4 confidence
 */
export function buildCatalog(
	pageTypes: string[],
	scoutResult: ScoutResult,
): Catalog {
	const { matched, lowConfidence, skipped } = filterByConfidence(
		scoutResult.mappings,
	);

	const matchedTypes = new Set(matched.map((m) => m.sourceType));
	const lowTypes = new Set(lowConfidence.map((m) => m.sourceType));
	const skippedTypes = new Set(skipped.map((m) => m.sourceType));

	// Unmatched: page types that appear in pageTypes but not in any mapping
	const allMappedTypes = new Set([
		...matchedTypes,
		...lowTypes,
		...skippedTypes,
	]);
	const unmatched = pageTypes.filter((t) => !allMappedTypes.has(t));

	// Generic: reference URLs that appear in matched but whose sourceType is not in pageTypes
	const pageTypeSet = new Set(pageTypes);
	const generic = matched
		.filter((m) => !pageTypeSet.has(m.sourceType))
		.map((m) => m.referenceUrl);

	return {
		matched,
		unmatched: unmatched.sort(),
		generic,
		lowConfidence: lowConfidence.map((m) => m.sourceType).sort(),
		skipped: skippedTypes.size > 0 ? [...skippedTypes].sort() : [],
	};
}

// ---------------------------------------------------------------------------
// Design page selection
// ---------------------------------------------------------------------------

/**
 * Tier keywords for diversity heuristic.
 * We pick at most one from each tier to maximize page-type variety.
 */
const TIER_PATTERNS: RegExp[] = [
	/^(home|landing|index|main)$/i,
	/^(blog|post|article|product|detail|case.?study)$/i,
	/^(pricing|contact|about|faq|docs|team|careers|features)$/i,
];

function tierOf(sourceType: string): number {
	for (let i = 0; i < TIER_PATTERNS.length; i++) {
		if (TIER_PATTERNS[i].test(sourceType)) return i;
	}
	return TIER_PATTERNS.length; // uncategorized
}

/**
 * Select up to 3 diverse pages for design-language extraction and
 * all matched pages for component discovery.
 *
 * Diversity heuristic:
 *   1. Sort matched entries by confidence (descending)
 *   2. Pick highest-confidence entry from each tier
 *   3. Fill remaining slots from unused entries
 */
export function selectDesignPages(catalog: Catalog): CatalogWithSelection {
	const MAX_DESIGN_PAGES = 3;

	const componentPages = catalog.matched.map(
		({ sourceType, referenceUrl }) => ({
			sourceType,
			referenceUrl,
		}),
	);

	if (catalog.matched.length <= MAX_DESIGN_PAGES) {
		return {
			...catalog,
			designPages: componentPages,
			componentPages,
		};
	}

	// Sort by confidence descending for tie-breaking within tiers
	const sorted = [...catalog.matched].sort(
		(a, b) => b.confidence - a.confidence,
	);

	const usedTiers = new Set<number>();
	const designPages: Array<{ sourceType: string; referenceUrl: string }> = [];

	// First pass: one entry per tier
	for (const entry of sorted) {
		if (designPages.length >= MAX_DESIGN_PAGES) break;
		const tier = tierOf(entry.sourceType);
		if (!usedTiers.has(tier)) {
			usedTiers.add(tier);
			designPages.push({
				sourceType: entry.sourceType,
				referenceUrl: entry.referenceUrl,
			});
		}
	}

	// Second pass: fill remaining slots from unused entries
	for (const entry of sorted) {
		if (designPages.length >= MAX_DESIGN_PAGES) break;
		if (!designPages.some((d) => d.sourceType === entry.sourceType)) {
			designPages.push({
				sourceType: entry.sourceType,
				referenceUrl: entry.referenceUrl,
			});
		}
	}

	return {
		...catalog,
		designPages,
		componentPages,
	};
}

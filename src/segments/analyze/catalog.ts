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

export interface Catalog {
	matched: Array<{
		sourceType: string;
		referenceUrl: string;
		confidence: number;
	}>;
	unmatched: string[];
	generic: string[];
	lowConfidence: string[];
	skipped: string[];
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
	for (const page of structure.pages) {
		if (page.pagetype) {
			types.add(page.pagetype);
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

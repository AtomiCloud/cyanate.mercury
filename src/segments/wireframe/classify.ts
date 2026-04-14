/**
 * Pure: classify logic — registry validation, component manifest building.
 *
 * All functions are pure (data in → errors/reports out). No IO.
 */

import type { Registry } from "../../types.js";
import type { ClassifiedPageType } from "./content-model.js";

// ---------------------------------------------------------------------------
// Classification types (produced by registry builder, consumed by seed)
// ---------------------------------------------------------------------------

/** Full content model output (after registry assembly). */
export interface ContentModelOutput {
	collections: Record<
		string,
		{
			source_pagetype: string;
			slug_field: string;
			listable_by: string[];
		}
	>;
	/** Per-page-type field classifications with richtext composition specs. */
	classified_page_types?: ClassifiedPageType[];
	/** Singleton page types that get seeded as src/content/<pagetype>/default.json. */
	singletons?: Array<{ pagetype: string; route: string }>;
}

/** Component manifest output (after merge). */
export interface ComponentManifestOutput {
	components: Record<
		string,
		{
			file: string;
			collections: string[];
		}
	>;
}

// ---------------------------------------------------------------------------
// validateRoutePatterns
// ---------------------------------------------------------------------------

/**
 * Validate route patterns don't conflict.
 * E.g., `/blog/[slug]` and `/blog/[id]` would conflict.
 */
export function validateRoutePatterns(
	routes: Array<{ pattern: string; pageType: string }>,
): {
	valid: boolean;
	conflicts: Array<{ a: string; b: string; reason: string }>;
} {
	const conflicts: Array<{ a: string; b: string; reason: string }> = [];

	for (let i = 0; i < routes.length; i++) {
		for (let j = i + 1; j < routes.length; j++) {
			const a = routes[i];
			const b = routes[j];

			const conflictReason = checkRouteConflict(a.pattern, b.pattern);
			if (conflictReason) {
				conflicts.push({ a: a.pattern, b: b.pattern, reason: conflictReason });
			}
		}
	}

	return { valid: conflicts.length === 0, conflicts };
}

/**
 * Check if two route patterns conflict.
 *
 * Two routes conflict if they could resolve to the same URL. This happens when:
 * 1. Same pattern (duplicates)
 * 2. Different dynamic names in the same position (e.g., [slug] vs [id])
 * 3. One static and one dynamic in the same position (e.g., [slug] vs "archive")
 *    because the dynamic segment can match the static value
 * 4. A rest parameter ([...slug]) can match paths of any depth, so it conflicts
 *    with any static route whose prefix matches the rest route's non-rest segments
 */
function checkRouteConflict(a: string, b: string): string | null {
	const segA = a.split("/").filter(Boolean);
	const segB = b.split("/").filter(Boolean);

	if (a === b) {
		return `Duplicate route pattern: "${a}"`;
	}

	const aRestIdx = segA.findIndex((s) => s.startsWith("[..."));
	const bRestIdx = segB.findIndex((s) => s.startsWith("[..."));

	if (aRestIdx !== -1 || bRestIdx !== -1) {
		return checkRestParamConflict(a, b, segA, segB, aRestIdx, bRestIdx);
	}

	if (segA.length !== segB.length) return null;

	const result = compareSegments(
		segA,
		segB,
		(i, sa, sb) =>
			`Both routes have dynamic segment at position ${i}: "${sa}" vs "${sb}"`,
	);
	return result.conflict;
}

/** Compare two segment arrays position-by-position for routing conflicts.
 *  Returns { conflict: string | null, diverged: boolean }.
 *  - conflict: set if a conflict was found
 *  - diverged: true if segments definitively differ (static mismatch), meaning no conflict possible
 */
function compareSegments(
	segA: string[],
	segB: string[],
	dynamicConflictMsg: (i: number, a: string, b: string) => string,
): { conflict: string | null; diverged: boolean } {
	for (let i = 0; i < segA.length; i++) {
		const aDyn = segA[i].startsWith("[");
		const bDyn = segB[i].startsWith("[");

		if (aDyn && bDyn && segA[i] !== segB[i])
			return {
				conflict: dynamicConflictMsg(i, segA[i], segB[i]),
				diverged: false,
			};
		if (aDyn !== bDyn) {
			// Static routes take priority over dynamic routes in Astro —
			// /about and /[slug] coexist without conflict.
			return { conflict: null, diverged: true };
		}
		if (!aDyn && segA[i] !== segB[i]) return { conflict: null, diverged: true };
	}
	return { conflict: null, diverged: false };
}

/**
 * Check conflict involving rest parameters.
 *
 * A rest parameter like `[...slug]` at position i means "match zero or more
 * additional segments". So `/docs/[...slug]` matches `/docs`, `/docs/a`,
 * `/docs/a/b`, etc. It conflicts with any route that shares the same prefix
 * up to the rest position and has >= that many segments.
 */
function checkRestParamConflict(
	a: string,
	b: string,
	segA: string[],
	segB: string[],
	aRestIdx: number,
	bRestIdx: number,
): string | null {
	if (aRestIdx !== -1 && bRestIdx !== -1) {
		const minLen = Math.min(aRestIdx, bRestIdx);
		const prefixA = segA.slice(0, minLen);
		const prefixB = segB.slice(0, minLen);
		const result = compareSegments(
			prefixA,
			prefixB,
			(i, sa, sb) =>
				`Rest routes have conflicting dynamic segment at position ${i}: "${sa}" vs "${sb}"`,
		);
		return result.diverged ? null : result.conflict;
	}

	const restRoute = aRestIdx !== -1 ? a : b;
	const restSegs = aRestIdx !== -1 ? segA : segB;
	const restIdx = aRestIdx !== -1 ? aRestIdx : bRestIdx;
	const otherSegs = aRestIdx !== -1 ? segB : segA;

	if (otherSegs.length < restIdx) return null;

	const prefix = restSegs.slice(0, restIdx);
	const otherPrefix = otherSegs.slice(0, restIdx);
	const segResult = compareSegments(
		prefix,
		otherPrefix,
		(i, sa, sb) =>
			`Rest route "${restRoute}" has conflicting dynamic segment at position ${i}: "${sa}" vs "${sb}"`,
	);
	if (segResult.diverged) return null;
	if (segResult.conflict) return segResult.conflict;

	return `Rest parameter in "${restRoute}" matches all routes with prefix "${restSegs.slice(0, restIdx).join("/")}/"`;
}

// ---------------------------------------------------------------------------
// validateRegistryCompleteness
// ---------------------------------------------------------------------------

/**
 * Validate registry completeness: every page type is accounted for
 * either as a static page or via a collection.
 */
export function validateRegistryCompleteness(
	registry: Registry,
	knownPageTypes: string[],
): { covered: string[]; missing: string[] } {
	const covered = new Set<string>();

	for (const sp of registry.static_pages) {
		covered.add(sp.pagetype);
	}
	for (const coll of Object.values(registry.collections)) {
		covered.add(coll.source_pagetype);
	}
	for (const listingName of Object.keys(registry.listings)) {
		covered.add(listingName);
	}

	const missing: string[] = [];
	for (const pt of knownPageTypes) {
		if (!covered.has(pt)) {
			missing.push(pt);
		}
	}

	return { covered: [...covered], missing };
}

// ---------------------------------------------------------------------------
// validateContentModelRefs
// ---------------------------------------------------------------------------

/**
 * Validate content model references: all collections/listings
 * reference valid entities.
 */
export function validateContentModelRefs(
	contentModel: ContentModelOutput,
	registry: Registry,
): { valid: boolean; orphans: string[] } {
	const orphans: string[] = [];
	const knownPageTypes = new Set(
		Object.values(registry.collections).map((c) => c.source_pagetype),
	);

	validateCollectionRefs(contentModel, registry, knownPageTypes, orphans);
	validateListingRefs(registry, knownPageTypes, orphans);

	return { valid: orphans.length === 0, orphans };
}

function validateCollectionRefs(
	contentModel: ContentModelOutput,
	registry: Registry,
	knownPageTypes: Set<string>,
	orphans: string[],
) {
	for (const [collName, coll] of Object.entries(contentModel.collections)) {
		if (!knownPageTypes.has(coll.source_pagetype)) {
			orphans.push(
				`Collection "${collName}" references unknown source_pagetype "${coll.source_pagetype}"`,
			);
		}
		if (coll.listable_by) {
			for (const ref of coll.listable_by) {
				if (!(ref in registry.listings)) {
					orphans.push(
						`Collection "${collName}" references listable_by "${ref}" which is not a registered listing`,
					);
				}
			}
		}
	}
}

function validateListingQuery(
	listingName: string,
	query: Registry["listings"][string]["queries"][number],
	registry: Registry,
	knownPageTypes: Set<string>,
	orphans: string[],
) {
	if (query.collection && !(query.collection in registry.collections)) {
		orphans.push(
			`Listing "${listingName}" references unknown collection "${query.collection}"`,
		);
	}
	if (
		"pagetype" in query &&
		typeof query.pagetype === "string" &&
		!knownPageTypes.has(query.pagetype)
	) {
		orphans.push(
			`Listing "${listingName}" references unknown pagetype "${query.pagetype}"`,
		);
	}
}

function validateListingRefs(
	registry: Registry,
	knownPageTypes: Set<string>,
	orphans: string[],
) {
	for (const [listingName, listing] of Object.entries(registry.listings)) {
		if (!Array.isArray(listing.queries)) continue;
		for (const query of listing.queries) {
			if (typeof query !== "object" || query === null) continue;
			validateListingQuery(
				listingName,
				query,
				registry,
				knownPageTypes,
				orphans,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// validateComponentManifestRefs
// ---------------------------------------------------------------------------

/**
 * Validate component manifest references:
 * all component collection references point to valid collections.
 */
export function validateComponentManifestRefs(
	manifest: ComponentManifestOutput,
	registry: Registry,
	contentModel: ContentModelOutput,
): { valid: boolean; orphans: string[] } {
	const orphans: string[] = [];

	for (const [compName, comp] of Object.entries(manifest.components)) {
		for (const coll of comp.collections) {
			if (!(coll in registry.collections)) {
				orphans.push(
					`Component "${compName}" references collection "${coll}" which is not registered`,
				);
			} else if (!(coll in contentModel.collections)) {
				orphans.push(
					`Component "${compName}" references collection "${coll}" which is not in content model`,
				);
			}
		}
	}

	return { valid: orphans.length === 0, orphans };
}

// ---------------------------------------------------------------------------
// buildComponentManifestFromFiles
// ---------------------------------------------------------------------------

/**
 * Build a ComponentManifestOutput by scanning generated .astro component files
 * for `getCollection("...")` calls. Each file that references a collection
 * becomes an entry in the manifest.
 */
export function buildComponentManifestFromFiles(
	componentFileContents: Record<string, string>,
): ComponentManifestOutput {
	const components: ComponentManifestOutput["components"] = {};

	for (const [filePath, content] of Object.entries(componentFileContents)) {
		// Match getCollection("collectionName") patterns
		const collectionRefs = content.matchAll(
			/getCollection\s*\(\s*["']([^"']+)["']\s*\)/g,
		);
		const collections: string[] = [];
		for (const match of collectionRefs) {
			const collectionName = match[1];
			if (!collections.includes(collectionName)) {
				collections.push(collectionName);
			}
		}
		if (collections.length > 0) {
			components[filePath] = { file: filePath, collections };
		}
	}

	return { components };
}

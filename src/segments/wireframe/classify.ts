/**
 * Pure: classify logic — cross-validation, conflict detection, merge logic.
 *
 * All functions are pure (data in → errors/reports out). No IO.
 */

import type { Registry } from "../../types.js";

// ---------------------------------------------------------------------------
// Classification types (produced by AI classifiers, consumed by validation)
// ---------------------------------------------------------------------------

/** Architecture classifier output: layouts and routing. */
export interface ArchitectureClassification {
	layouts: Record<
		string,
		{
			description: string;
			page_types: string[];
		}
	>;
	routes: Array<{ pattern: string; pageType: string }>;
}

/** Content model classifier output: collections and listings. */
export interface ContentModelClassification {
	collections: Record<
		string,
		{
			source_pagetype: string;
			slug_field: string;
		}
	>;
	listings: Record<
		string,
		{
			route: string;
			paginated: boolean;
		}
	>;
}

/** Interaction classifier output: interactive patterns. */
export interface InteractionClassification {
	patterns: Array<{
		id: string;
		type: string;
		pageType?: string;
		description: string;
	}>;
}

/** Full content model output (after merge). */
export interface ContentModelOutput {
	collections: Record<
		string,
		{
			source_pagetype: string;
			slug_field: string;
			listable_by: string[];
		}
	>;
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
// crossValidateClassifiers
// ---------------------------------------------------------------------------

/**
 * Collect all page types referenced by a classifier output.
 */
function collectClassifierTypes(
	architecture: ArchitectureClassification,
	contentModel: ContentModelClassification,
	interaction: InteractionClassification,
): Set<string> {
	const types = new Set<string>();
	for (const layout of Object.values(architecture.layouts)) {
		for (const pt of layout.page_types) {
			types.add(pt);
		}
	}
	for (const coll of Object.values(contentModel.collections)) {
		types.add(coll.source_pagetype);
	}
	for (const pattern of interaction.patterns) {
		if (pattern.pageType) types.add(pattern.pageType);
	}
	return types;
}

/** Collect page types split by source for cross-validation. */
function collectClassifierTypesSplit(
	architecture: ArchitectureClassification,
	contentModel: ContentModelClassification,
	interaction: InteractionClassification,
): { archTypes: Set<string>; cmTypes: Set<string>; intTypes: Set<string> } {
	const archTypes = new Set<string>();
	for (const layout of Object.values(architecture.layouts)) {
		for (const pt of layout.page_types) {
			archTypes.add(pt);
		}
	}
	const cmTypes = new Set<string>();
	for (const coll of Object.values(contentModel.collections)) {
		cmTypes.add(coll.source_pagetype);
	}
	const intTypes = new Set<string>();
	for (const pattern of interaction.patterns) {
		if (pattern.pageType) intTypes.add(pattern.pageType);
	}
	return { archTypes, cmTypes, intTypes };
}

/**
 * Validate that content model collections reference valid page types.
 * Collections are checked against the union of all OTHER classifiers' types.
 */
function validateContentModelTypes(
	contentModel: ContentModelClassification,
	archTypes: Set<string>,
	intTypes: Set<string>,
	knownPageTypes: string[],
): string[] {
	const errors: string[] = [];
	const cmValidTypes = new Set([...knownPageTypes, ...archTypes, ...intTypes]);

	for (const [collName, coll] of Object.entries(contentModel.collections)) {
		if (!cmValidTypes.has(coll.source_pagetype)) {
			errors.push(
				`Content model collection "${collName}" references unknown page type "${coll.source_pagetype}"`,
			);
		}
	}

	return errors;
}

/**
 * Validate that content model listings reference architecture routes.
 */
function validateListingRoutes(
	contentModel: ContentModelClassification,
	architecture: ArchitectureClassification,
): string[] {
	const errors: string[] = [];

	for (const [listingName, listing] of Object.entries(contentModel.listings)) {
		if (!listing.route) continue;
		const hasMatchingRoute = architecture.routes.some(
			(r) => r.pattern === listing.route,
		);
		if (!hasMatchingRoute) {
			errors.push(
				`Content model listing "${listingName}" references route "${listing.route}" with no matching architecture route`,
			);
		}
	}

	return errors;
}

/**
 * Validate that interaction patterns reference valid page types.
 * Interaction types are checked against the union of all OTHER classifiers' types.
 */
function validateInteractionTypes(
	interaction: InteractionClassification,
	archTypes: Set<string>,
	cmTypes: Set<string>,
	knownPageTypes: string[],
): string[] {
	const errors: string[] = [];
	const intValidTypes = new Set([...knownPageTypes, ...archTypes, ...cmTypes]);

	for (const pattern of interaction.patterns) {
		if (pattern.pageType && !intValidTypes.has(pattern.pageType)) {
			errors.push(
				`Interaction pattern "${pattern.id}" references unknown page type "${pattern.pageType}"`,
			);
		}
	}

	return errors;
}

/**
 * Validate that all classifier relationships resolve to valid page types.
 * Each classifier's references are validated against the union of all OTHER classifiers
 * (not its own types) to catch self-referencing orphans.
 */
function validateRelationships(
	contentModel: ContentModelClassification,
	interaction: InteractionClassification,
	architecture: ArchitectureClassification,
	knownPageTypes: string[],
): string[] {
	const { archTypes, cmTypes, intTypes } = collectClassifierTypesSplit(
		architecture,
		contentModel,
		interaction,
	);

	return [
		...validateContentModelTypes(
			contentModel,
			archTypes,
			intTypes,
			knownPageTypes,
		),
		...validateListingRoutes(contentModel, architecture),
		...validateInteractionTypes(
			interaction,
			archTypes,
			cmTypes,
			knownPageTypes,
		),
	];
}

/**
 * Cross-validate classifier outputs:
 * - All page types from knownPageTypes appear in at least one classifier
 * - Relationships resolve (collections reference valid page types)
 */
export function crossValidateClassifiers(
	architecture: ArchitectureClassification,
	contentModel: ContentModelClassification,
	interaction: InteractionClassification,
	knownPageTypes: string[],
): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	const allClassifierTypes = collectClassifierTypes(
		architecture,
		contentModel,
		interaction,
	);

	// Check all known types are covered somewhere
	for (const pt of knownPageTypes) {
		if (!allClassifierTypes.has(pt)) {
			errors.push(
				`Page type "${pt}" not found in any classifier output (architecture, content model, or interaction)`,
			);
		}
	}

	// Check relationships resolve
	errors.push(
		...validateRelationships(
			contentModel,
			interaction,
			architecture,
			knownPageTypes,
		),
	);

	return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// detectConflicts
// ---------------------------------------------------------------------------

export interface ConflictReport {
	conflicts: Array<{
		type: string;
		description: string;
		details: Record<string, unknown>;
	}>;
}

/**
 * Detect conflicts between classifier outputs.
 * E.g., same page type assigned to different layouts.
 */
export function detectConflicts(
	architecture: ArchitectureClassification,
	contentModel: ContentModelClassification,
): ConflictReport {
	const conflicts: ConflictReport["conflicts"] = [];

	// Check: page type appears in multiple layouts
	const typeToLayouts = new Map<string, string[]>();
	for (const [layoutName, layout] of Object.entries(architecture.layouts)) {
		for (const pt of layout.page_types) {
			const list = typeToLayouts.get(pt) ?? [];
			list.push(layoutName);
			typeToLayouts.set(pt, list);
		}
	}

	for (const [pt, layouts] of typeToLayouts) {
		if (layouts.length > 1) {
			conflicts.push({
				type: "layout_conflict",
				description: `Page type "${pt}" assigned to multiple layouts: ${layouts.join(", ")}`,
				details: { pageType: pt, layouts },
			});
		}
	}

	// Check: collection source_pagetype has a matching route in architecture
	const routePatterns = new Set(architecture.routes.map((r) => r.pageType));
	for (const [collName, coll] of Object.entries(contentModel.collections)) {
		if (!routePatterns.has(coll.source_pagetype)) {
			conflicts.push({
				type: "missing_route",
				description: `Collection "${collName}" references page type "${coll.source_pagetype}" with no route in architecture`,
				details: { collection: collName, pageType: coll.source_pagetype },
			});
		}
	}

	return { conflicts };
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
			return {
				conflict: `Static segment conflicts with dynamic segment at position ${i}: "${segA[i]}" vs "${segB[i]}"`,
				diverged: false,
			};
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

function validateListingRefs(
	registry: Registry,
	knownPageTypes: Set<string>,
	orphans: string[],
) {
	for (const [listingName, listing] of Object.entries(registry.listings)) {
		for (const query of listing.queries) {
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

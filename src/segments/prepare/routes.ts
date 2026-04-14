/**
 * Pure: Phase 3 (resolve-routes) logic.
 *
 * Fully heuristic route conflict resolution. Given a site's scraped URL
 * patterns and concrete URLs, produce:
 *   - An internal url-map (originalUrl → finalUrl) for content rewriting
 *   - An updated PageTypeMeta[] with final urlPatterns and urls
 *
 * Three cases:
 *   1. Already prefixed    /post/{slug}/   → keep
 *   2. Root-level singleton /about/         → keep
 *   3. Root-level dynamic conflict /{slug}/ + /{service}/ → prefix each
 *
 * All functions are pure (data in → data out). No IO.
 */

import type { StructureData } from "../../types.js";
import type { PageTypeMeta } from "./ingest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PatternMapEntry {
	pageType: string;
	originalPattern: string;
	finalPattern: string;
	rewritten: boolean;
}

export interface InternalUrlMap {
	urlMap: Record<string, string>;
	patternMap: Record<string, PatternMapEntry>;
}

type PageTypeKind = "singleton" | "prefixed_dynamic" | "root_dynamic";

// ---------------------------------------------------------------------------
// classifyPattern
// ---------------------------------------------------------------------------

/**
 * Classify a url_pattern into one of three kinds.
 *
 *   "/"             → singleton   (no dynamic segments)
 *   "/about-us/"    → singleton
 *   "/{slug}/"      → root_dynamic (single root-level dynamic segment)
 *   "/{service}/"   → root_dynamic
 *   "/post/{slug}/" → prefixed_dynamic (dynamic with static prefix)
 *   "/team/{id}/"   → prefixed_dynamic
 */
export function classifyPattern(urlPattern: string): PageTypeKind {
	const segments = urlPattern.split("/").filter(Boolean);
	if (segments.length === 0) return "singleton";
	const hasDynamic = segments.some((s) => /^\{(\w+)\}$/.test(s));
	if (!hasDynamic) return "singleton";
	if (segments.length === 1 && /^\{(\w+)\}$/.test(segments[0]))
		return "root_dynamic";
	return "prefixed_dynamic";
}

export function isRootLevelDynamic(urlPattern: string): boolean {
	return classifyPattern(urlPattern) === "root_dynamic";
}

// ---------------------------------------------------------------------------
// pageTypeToPrefix
// ---------------------------------------------------------------------------

/**
 * Convert a page type name into a URL prefix segment.
 * Deterministic — just kebab-cases the name.
 *
 *   "service"    → "service"
 *   "blog_post"  → "blog-post"
 *   "team_member" → "team-member"
 */
export function pageTypeToPrefix(name: string): string {
	return name.replace(/_/g, "-");
}

// ---------------------------------------------------------------------------
// extractSlugFromUrl
// ---------------------------------------------------------------------------

/**
 * Extract the slug value from a concrete URL given its pattern.
 *
 *   url "/home-physiotherapy/", pattern "/{service}/"   → "home-physiotherapy"
 *   url "/post/knee-pain/",     pattern "/post/{slug}/" → "knee-pain"
 *   url "/about/",              pattern "/about/"       → undefined
 */
export function extractSlugFromUrl(
	url: string,
	pattern: string,
): string | undefined {
	const urlSegs = url.split("/").filter(Boolean);
	const patternSegs = pattern.split("/").filter(Boolean);

	if (urlSegs.length !== patternSegs.length) return undefined;

	for (let i = 0; i < patternSegs.length; i++) {
		if (/^\{(\w+)\}$/.test(patternSegs[i])) {
			return urlSegs[i];
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// resolveAllRoutes
// ---------------------------------------------------------------------------

/**
 * Core Phase 3 algorithm.
 *
 * Produces the internal url-map and pattern-map used by Phase 4 to rewrite
 * content and by Phase 3 itself to update page-type-meta.
 */
export function resolveAllRoutes(structure: StructureData): InternalUrlMap {
	const patternMap: Record<string, PatternMapEntry> = {};
	const urlMap: Record<string, string> = {};

	// Step A: identify root-level dynamic page types
	const rootDynamics = structure.page_types.filter((pt) =>
		isRootLevelDynamic(pt.url_pattern),
	);
	const conflict = rootDynamics.length >= 2;

	// Step B: build patternMap + urlMap per page type
	for (const pt of structure.page_types) {
		const kind = classifyPattern(pt.url_pattern);
		const isConflicting = conflict && kind === "root_dynamic";

		if (isConflicting) {
			const prefix = pageTypeToPrefix(pt.name);
			const finalPattern = `/${prefix}/{slug}/`;

			patternMap[pt.name] = {
				pageType: pt.name,
				originalPattern: pt.url_pattern,
				finalPattern,
				rewritten: true,
			};

			for (const url of pt.urls) {
				const slug = extractSlugFromUrl(url, pt.url_pattern);
				if (slug === undefined) {
					// URL doesn't match pattern — identity fallback
					urlMap[url] = url;
					continue;
				}
				urlMap[url] = `/${prefix}/${slug}/`;
			}
		} else {
			patternMap[pt.name] = {
				pageType: pt.name,
				originalPattern: pt.url_pattern,
				finalPattern: pt.url_pattern,
				rewritten: false,
			};

			for (const url of pt.urls) {
				urlMap[url] = url;
			}
		}
	}

	return { urlMap, patternMap };
}

// ---------------------------------------------------------------------------
// updatePageTypeMeta
// ---------------------------------------------------------------------------

/**
 * Apply the url-map/pattern-map to PageTypeMeta[], producing updated meta
 * that reflects final routes.
 */
export function updatePageTypeMeta(
	meta: PageTypeMeta[],
	resolved: InternalUrlMap,
): PageTypeMeta[] {
	return meta.map((m) => {
		const entry = resolved.patternMap[m.pagetype];
		if (!entry) return m;

		return {
			...m,
			urlPattern: entry.finalPattern,
			urls: m.urls.map((u) => resolved.urlMap[u] ?? u),
		};
	});
}

// ---------------------------------------------------------------------------
// validateRoutePatterns (duplicated from wireframe/classify.ts)
// ---------------------------------------------------------------------------

/**
 * Validate route patterns don't conflict.
 * E.g., `/blog/[slug]` and `/blog/[id]` would conflict.
 *
 * Input patterns should be in Astro form (`[param]`, `[...rest]`).
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
			return { conflict: null, diverged: true };
		}
		if (!aDyn && segA[i] !== segB[i]) return { conflict: null, diverged: true };
	}
	return { conflict: null, diverged: false };
}

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
// isValidAstroRoutePattern
// ---------------------------------------------------------------------------

/**
 * Validate that a pattern is a legal Astro file-based route.
 * Expects scraper-form patterns: "/{param}/" or "/static/".
 *
 * Each path segment must be either a literal (letters/digits/-/_), a single
 * dynamic placeholder `{param}`, or empty. No mixed static+dynamic segments
 * like `/post-{slug}/`.
 */
export function isValidAstroRoutePattern(pattern: string): boolean {
	if (pattern === "/") return true;
	if (!pattern.startsWith("/")) return false;
	const segments = pattern.split("/").filter(Boolean);
	for (const seg of segments) {
		const isDynamic = /^\{\w+\}$/.test(seg);
		const isStatic = /^[A-Za-z0-9_-]+$/.test(seg);
		if (!isDynamic && !isStatic) return false;
	}
	return true;
}

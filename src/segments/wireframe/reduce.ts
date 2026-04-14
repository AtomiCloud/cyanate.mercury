/**
 * Pure: reduce logic — asset manifest, link rewriting, reduced tree building.
 *
 * All functions are pure (data in → data out). No IO.
 */

import { createHash } from "node:crypto";
import type { PageContent, ReducedMeta, StructureData } from "../../types.js";
import { convertUrlPattern, extractSlugParam } from "./adapter.js";

// ---------------------------------------------------------------------------
// contentAddressedName
// ---------------------------------------------------------------------------

/**
 * Build a content-addressed filename from a URL using SHA256.
 * Produces a stable, deterministic name given the same URL.
 */
export function contentAddressedName(url: string, ext: string): string {
	const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
	return `${hash}.${ext}`;
}

// ---------------------------------------------------------------------------
// buildAssetManifest
// ---------------------------------------------------------------------------

/**
 * Build an asset manifest mapping original URLs to local content-addressed filenames.
 * Scans content for image URLs and deduplicates.
 */
export function buildAssetManifest(
	pages: PageContent[],
	imageUrls: string[] = [],
): Record<string, string> {
	const seen = new Set<string>();
	const manifest: Record<string, string> = {};

	// Collect image URLs from content pages
	const allUrls = [...imageUrls];
	for (const page of pages) {
		collectImageUrls(page.content, allUrls);
	}

	// Deduplicate and build manifest
	for (const url of allUrls) {
		if (seen.has(url)) continue;
		seen.add(url);

		const ext = inferExtension(url);
		manifest[url] = contentAddressedName(url, ext);
	}

	return manifest;
}

/** Recursively collect image URLs from nested content objects. */
function collectImageUrls(obj: unknown, accumulator: string[]): void {
	if (!obj || typeof obj !== "object") return;

	if (Array.isArray(obj)) {
		for (const item of obj) {
			collectImageUrls(item, accumulator);
		}
		return;
	}

	const record = obj as Record<string, unknown>;
	for (const [key, value] of Object.entries(record)) {
		if (
			typeof value === "string" &&
			looksLikeUrl(value) &&
			(isImageKey(key) || looksLikeImageUrl(value))
		) {
			accumulator.push(value);
		} else {
			collectImageUrls(value, accumulator);
		}
	}
}

function looksLikeUrl(value: string): boolean {
	return (
		value.startsWith("http://") ||
		value.startsWith("https://") ||
		value.startsWith("//") ||
		value.startsWith("/")
	);
}

function isImageKey(key: string): boolean {
	return [
		"src",
		"image",
		"icon",
		"background",
		"logo",
		"photo",
		"avatar",
	].includes(key.toLowerCase());
}

function looksLikeImageUrl(value: string): boolean {
	return /\.(png|jpe?g|gif|svg|webp|avif|ico)(\?.*)?$/i.test(value);
}

function inferExtension(url: string): string {
	const match = url.match(/\.(png|jpe?g|gif|svg|webp|avif|ico)(\?.*)?$/i);
	return match ? match[1].toLowerCase() : "png";
}

// ---------------------------------------------------------------------------
// rewriteInternalLinks
// ---------------------------------------------------------------------------

/**
 * Rewrite internal links in content to relative Astro routes.
 * Internal links start with the site URL; external links are preserved.
 * Handles nested objects and arrays.
 */
export function rewriteInternalLinks(
	content: Record<string, unknown>,
	siteUrl: string,
	routeMap: Map<string, string>,
): Record<string, unknown> {
	const origin = (() => {
		try {
			return new URL(siteUrl).origin;
		} catch {
			return siteUrl;
		}
	})();

	return rewriteValue(content, origin, routeMap) as Record<string, unknown>;
}

function rewriteValue(
	value: unknown,
	origin: string,
	routeMap: Map<string, string>,
): unknown {
	if (typeof value === "string") {
		if (value.startsWith(origin)) {
			const path = value.slice(origin.length);
			const route = routeMap.get(path) ?? path;
			return route;
		}
		return value;
	}

	if (Array.isArray(value)) {
		return value.map((item) => rewriteValue(item, origin, routeMap));
	}

	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			result[k] = rewriteValue(v, origin, routeMap);
		}
		return result;
	}

	return value;
}

// ---------------------------------------------------------------------------
// classifyUrls
// ---------------------------------------------------------------------------

/**
 * Classify URLs into internal, external, and CMS-specific buckets.
 */
export function classifyUrls(
	urls: string[],
	siteUrl: string,
	cmsPatterns: string[] = ["/wp-content/", "/wp-admin/", "/wp-json/", "/cms/"],
): { internal: string[]; external: string[]; cms: string[] } {
	const origin = (() => {
		try {
			return new URL(siteUrl).origin;
		} catch {
			return siteUrl;
		}
	})();

	const internal: string[] = [];
	const external: string[] = [];
	const cms: string[] = [];

	for (const url of urls) {
		if (cmsPatterns.some((p) => url.includes(p))) {
			cms.push(url);
		} else if (url.startsWith(origin)) {
			internal.push(url);
		} else {
			external.push(url);
		}
	}

	return { internal, external, cms };
}

// ---------------------------------------------------------------------------
// buildReducedTree
// ---------------------------------------------------------------------------

/**
 * Build a virtual file tree from samples, rewritten content, and asset manifest.
 * Returns an array of { path, content } — no disk IO.
 */
export function buildReducedTree(
	samples: Map<string, { richest: PageContent; simplest: PageContent }>,
	rewrittenContent: Map<string, Record<string, unknown>>,
	assetManifest: Record<string, string>,
): Array<{ path: string; content: string }> {
	const files: Array<{ path: string; content: string }> = [];

	// Write sample files per page type
	for (const [pagetype, { richest, simplest }] of samples) {
		const richestContent = rewrittenContent.get(richest.url) ?? richest.content;
		const simplestContent =
			rewrittenContent.get(simplest.url) ?? simplest.content;

		files.push({
			path: `reduced/${pagetype}/richest.json`,
			content: JSON.stringify(richestContent, null, 2),
		});
		files.push({
			path: `reduced/${pagetype}/simplest.json`,
			content: JSON.stringify(simplestContent, null, 2),
		});
	}

	// Write asset manifest
	if (Object.keys(assetManifest).length > 0) {
		files.push({
			path: "asset-manifest.json",
			content: JSON.stringify(assetManifest, null, 2),
		});
	}

	return files;
}

// ---------------------------------------------------------------------------
// selectSamplesFromUrls
// ---------------------------------------------------------------------------

/**
 * Select richest + simplest sample content entries from sample_urls.
 *
 * For each page type, looks up the content for the declared sample_urls
 * and picks the richest (most content keys) and simplest (fewest content keys).
 * If only one sample exists, it serves as both richest and simplest.
 */
export function selectSamplesFromUrls(
	structure: StructureData,
	pages: PageContent[],
): Map<string, { richest: PageContent; simplest: PageContent }> {
	const samples = new Map<
		string,
		{ richest: PageContent; simplest: PageContent }
	>();

	for (const pt of structure.page_types) {
		const samplePages = collectSamplePages(pt, pages);
		if (samplePages.length === 0) continue;

		const { richest, simplest } = pickRichestAndSimplest(samplePages);
		samples.set(pt.name, { richest, simplest });
	}

	return samples;
}

/** Collect pages matching sample_urls for a page type, with fallback. */
function collectSamplePages(
	pt: StructureData["page_types"][number],
	pages: PageContent[],
): PageContent[] {
	const samplePages: PageContent[] = [];
	for (const sampleUrl of pt.sample_urls) {
		const match = pages.find(
			(p) =>
				p.pagetype === pt.name &&
				normalizeUrl(p.url) === normalizeUrl(sampleUrl),
		);
		if (match) samplePages.push(match);
	}

	// Fallback: if no sample_urls matched, use any page of this type
	if (samplePages.length === 0) {
		const fallback = pages.find((p) => p.pagetype === pt.name);
		if (fallback) samplePages.push(fallback);
	}

	return samplePages;
}

/** Pick the richest (most content keys) and simplest (fewest) from a list of pages. */
function pickRichestAndSimplest(pages: PageContent[]): {
	richest: PageContent;
	simplest: PageContent;
} {
	let richest = pages[0];
	let simplest = pages[0];
	for (const page of pages) {
		const keyCount = Object.keys(page.content).length;
		if (keyCount > Object.keys(richest.content).length) richest = page;
		if (keyCount < Object.keys(simplest.content).length) simplest = page;
	}
	return { richest, simplest };
}

/** Normalize URLs for comparison: strip trailing slash, lowercase. */
function normalizeUrl(url: string): string {
	const stripped = url.length > 1 && url.endsWith("/") ? url.slice(0, -1) : url;
	return stripped.toLowerCase();
}

// ---------------------------------------------------------------------------
// buildReducedMeta
// ---------------------------------------------------------------------------

/**
 * Build a ReducedMeta object from the new StructureData format.
 *
 * Most fields are derived directly from structure.page_types rather than
 * computed from raw page data.
 */
export function buildReducedMeta(
	structure: StructureData,
	pages: PageContent[],
	resolvedSchema: Record<
		string,
		{ type: string; properties: Record<string, unknown> }
	>,
): ReducedMeta {
	const pageTypes = structure.page_types.map((pt) => {
		const schemaKeys = extractSchemaKeys(resolvedSchema, pt.name);
		const ownKeys = extractOwnKeys(pt.name, pages);
		const route = convertUrlPattern(pt.url_pattern);
		return {
			pagetype: pt.name,
			route,
			count: pt.urls.length,
			multi: pt.urls.length > 1,
			has_pagination: pt.urls.length >= 3,
			slug_param: extractSlugParam(pt.url_pattern),
			schema_keys: schemaKeys,
			own_keys: ownKeys,
		};
	});

	const globalKeys = extractGlobalKeys(pages);

	const totalPages = structure.page_types.reduce(
		(sum, pt) => sum + pt.urls.length,
		0,
	);

	const paginationCandidates = pageTypes
		.filter((pt) => pt.has_pagination)
		.map((pt) => ({
			pagetype: pt.pagetype,
			evidence: `${pt.count} instances meet threshold of 3`,
		}));

	return {
		source: {
			total_pages: totalPages,
			page_types: structure.page_types.length,
			scraped_at: structure.scraped_at ?? new Date().toISOString(),
			site_url: structure.site_url ?? "",
		},
		global_keys: globalKeys,
		page_types: pageTypes,
		pagination_candidates: paginationCandidates,
	};
}

/** Extract top-level property names from a page type's resolved schema. */
function extractSchemaKeys(
	resolvedSchema: Record<
		string,
		{ type: string; properties: Record<string, unknown> }
	>,
	pagetype: string,
): string[] {
	const typeSchema = resolvedSchema[pagetype];
	if (!typeSchema?.properties) return [];
	return Object.keys(typeSchema.properties);
}

/**
 * Extract content keys unique to pages of a given type (not present in all pages).
 */
function extractOwnKeys(pagetype: string, allPages: PageContent[]): string[] {
	if (allPages.length === 0) return [];

	const typePages = allPages.filter((p) => p.pagetype === pagetype);
	if (typePages.length === 0) return [];

	// Keys present in ALL pages globally
	const allKeyCounts = new Map<string, number>();
	for (const page of allPages) {
		for (const key of Object.keys(page.content)) {
			allKeyCounts.set(key, (allKeyCounts.get(key) ?? 0) + 1);
		}
	}
	const globalKeys = new Set(
		[...allKeyCounts.entries()]
			.filter(([, count]) => count === allPages.length)
			.map(([key]) => key),
	);

	// Keys present in ALL pages of this type but NOT global = own keys
	const typeKeyCounts = new Map<string, number>();
	for (const page of typePages) {
		for (const key of Object.keys(page.content)) {
			typeKeyCounts.set(key, (typeKeyCounts.get(key) ?? 0) + 1);
		}
	}

	return [...typeKeyCounts.entries()]
		.filter(
			([key, count]) => count === typePages.length && !globalKeys.has(key),
		)
		.map(([key]) => key)
		.sort();
}

/** Extract keys that appear in every page across all types (global content keys). */
function extractGlobalKeys(pages: PageContent[]): string[] {
	if (pages.length === 0) return [];

	const keyCounts = new Map<string, number>();
	for (const page of pages) {
		for (const key of Object.keys(page.content)) {
			keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
		}
	}

	return [...keyCounts.entries()]
		.filter(([, count]) => count === pages.length)
		.map(([key]) => key)
		.sort();
}

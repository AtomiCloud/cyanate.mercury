/**
 * Pure: reduce logic — grouping, sampling, link rewriting, manifest building.
 *
 * All functions are pure (data in → data out). No IO.
 */

import { createHash } from "node:crypto";
import type {
	PageContent,
	PageStructure,
	ReducedMeta,
	SchemaData,
} from "../../types.js";

// ---------------------------------------------------------------------------
// groupByPageType
// ---------------------------------------------------------------------------

/**
 * Group pages by their pagetype field.
 * Returns a Map from pagetype → array of PageStructure.
 */
export function groupByPageType(
	pages: PageStructure[],
): Map<string, PageStructure[]> {
	const grouped = new Map<string, PageStructure[]>();
	for (const page of pages) {
		const list = grouped.get(page.pagetype);
		if (list) {
			list.push(page);
		} else {
			grouped.set(page.pagetype, [page]);
		}
	}
	return grouped;
}

// ---------------------------------------------------------------------------
// selectSamples
// ---------------------------------------------------------------------------

/**
 * For each page type, select the richest page (most content keys)
 * and the simplest page (fewest content keys).
 * Tie-breaking is deterministic: by page id (numeric or string sort).
 */
export function selectSamples(
	grouped: Map<string, PageStructure[]>,
	contentByPageId: Map<string, PageContent>,
): Map<string, { richest: PageContent; simplest: PageContent }> {
	const samples = new Map<
		string,
		{ richest: PageContent; simplest: PageContent }
	>();

	for (const [pagetype, pages] of grouped) {
		let richest: PageContent | null = null;
		let richestKeyCount = -1;
		let simplest: PageContent | null = null;
		let simplestKeyCount = Number.POSITIVE_INFINITY;

		// Sort by id for deterministic tie-breaking
		const sorted = [...pages].sort((a, b) => {
			const na = Number(a.id);
			const nb = Number(b.id);
			if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
			return String(a.id).localeCompare(String(b.id));
		});

		for (const page of sorted) {
			// Match by url since PageContent.id may differ
			const content = findContentByUrl(contentByPageId, page.url);
			if (!content) continue;

			const keyCount = Object.keys(content.content).length;

			if (keyCount > richestKeyCount) {
				richest = content;
				richestKeyCount = keyCount;
			}
			if (keyCount < simplestKeyCount) {
				simplest = content;
				simplestKeyCount = keyCount;
			}
		}

		if (richest && simplest) {
			samples.set(pagetype, { richest, simplest });
		}
	}

	return samples;
}

/** Find a PageContent entry by matching on url. */
function findContentByUrl(
	contentByPageId: Map<string, PageContent>,
	url: string,
): PageContent | undefined {
	for (const content of contentByPageId.values()) {
		if (content.url === url) return content;
	}
	return undefined;
}

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
			(isImageKey(key) || looksLikeImageUrl(value))
		) {
			accumulator.push(value);
		} else {
			collectImageUrls(value, accumulator);
		}
	}
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
// buildReducedMeta
// ---------------------------------------------------------------------------

/**
 * Build a ReducedMeta object conforming to the ReducedMeta type contract.
 *
 * @param grouped — Pages grouped by pagetype (from groupByPageType)
 * @param pages — All page content (for global key extraction)
 * @param schema — Schema data per page type (for schema_keys extraction)
 * @param siteUrl — The source site URL
 * @param scrapedAt — Timestamp when the site was scraped
 */
export function buildReducedMeta(
	grouped: Map<string, PageStructure[]>,
	pages: PageContent[],
	schema: SchemaData,
	siteUrl: string,
	scrapedAt: string,
): ReducedMeta {
	const pageTypes = [...grouped.entries()].map(([pagetype, items]) => {
		const schemaKeys = extractSchemaKeys(schema, pagetype);
		const ownKeys = extractOwnKeys(items, pages);
		const route = deriveRoute(items, pagetype);
		return {
			pagetype,
			route,
			count: items.length,
			multi: items.length > 1,
			has_pagination: items.length > 10,
			slug_param: deriveSlugParam(route),
			schema_keys: schemaKeys,
			own_keys: ownKeys,
		};
	});

	const globalKeys = extractGlobalKeys(pages);

	const paginationCandidates = pageTypes
		.filter((pt) => pt.has_pagination)
		.map((pt) => ({
			pagetype: pt.pagetype,
			evidence: `${pt.count} instances exceed threshold of 10`,
		}));

	return {
		source: {
			total_pages: pages.length,
			page_types: grouped.size,
			scraped_at: scrapedAt,
			site_url: siteUrl,
		},
		global_keys: globalKeys,
		page_types: pageTypes,
		pagination_candidates: paginationCandidates,
	};
}

/** Extract top-level property names from a page type's schema. */
function extractSchemaKeys(schema: SchemaData, pagetype: string): string[] {
	const typeSchema = schema[pagetype];
	if (!typeSchema?.properties) return [];
	return Object.keys(typeSchema.properties);
}

/** Extract content keys unique to pages of a given type (not present in all pages). */
function extractOwnKeys(
	items: PageStructure[],
	allPages: PageContent[],
): string[] {
	if (items.length === 0 || allPages.length === 0) return [];

	const typePages = allPages.filter((p) => items.some((i) => i.url === p.url));
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

/** Derive a route pattern from page URLs for a given page type. */
function deriveRoute(items: PageStructure[], pagetype: string): string {
	if (items.length === 0) return `/${pagetype}`;

	const url = items[0].url;
	try {
		const pathname = new URL(url, "https://fallback.com").pathname;
		if (items.length > 1) {
			const segments = pathname.split("/").filter(Boolean);
			if (segments.length > 0) {
				segments[segments.length - 1] = "[slug]";
				return `/${segments.join("/")}`;
			}
		}
		return pathname;
	} catch {
		return `/${pagetype}`;
	}
}

/** Derive slug parameter name from a dynamic route. */
function deriveSlugParam(route: string): string | undefined {
	const match = /\[([^\]]+)\]/.exec(route);
	return match ? match[1] : undefined;
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

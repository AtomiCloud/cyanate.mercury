/**
 * Pure: Phase 4 (apply-rewrites) logic.
 *
 * Rewrites all internal links (using url-map from Phase 3) and all image URLs
 * (using asset-manifest from Phase 2) in content. Collects external links.
 * Also updates page URLs in PreparedPage[] to final URLs.
 *
 * All functions are pure (data in → data out). No IO.
 */

import type { PreparedPage } from "./ingest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExternalLink {
	url: string;
	pageType: string;
	fieldPath: string;
	type: "external" | "external-media";
}

interface UnresolvedInternalLink {
	path: string;
	pageType: string;
	fieldPath: string;
}

interface PreparedContent {
	pages: PreparedPage[];
	externalLinks: ExternalLink[];
	unresolvedInternalLinks: UnresolvedInternalLink[];
}

// ---------------------------------------------------------------------------
// URL classification helpers
// ---------------------------------------------------------------------------

const MEDIA_HOSTS = [
	"youtube.com",
	"www.youtube.com",
	"youtu.be",
	"vimeo.com",
	"player.vimeo.com",
];

/**
 * Classify a URL as external-media or plain external.
 * YouTube and Vimeo URLs are tagged as "external-media".
 */
export function classifyExternalUrl(
	url: string,
): "external-media" | "external" {
	try {
		const host = new URL(url).hostname;
		return MEDIA_HOSTS.includes(host) ? "external-media" : "external";
	} catch {
		return "external";
	}
}

// ---------------------------------------------------------------------------
// rewriteInternalLinks (duplicated from wireframe/reduce.ts)
// ---------------------------------------------------------------------------

/**
 * Rewrite internal links in content: strip the site origin and map via urlMap.
 * External URLs are left untouched.
 */
export function rewriteInternalLinks(
	content: Record<string, unknown>,
	siteUrl: string,
	urlMap: Record<string, string>,
): Record<string, unknown> {
	const origin = parseOrigin(siteUrl);
	return rewriteValue(content, origin, urlMap) as Record<string, unknown>;
}

function parseOrigin(siteUrl: string): string {
	try {
		return new URL(siteUrl).origin;
	} catch {
		return siteUrl;
	}
}

function rewriteValue(
	value: unknown,
	origin: string,
	urlMap: Record<string, string>,
): unknown {
	if (typeof value === "string") {
		// Absolute site URL: strip origin, then look up.
		if (origin && value.startsWith(origin)) {
			return lookupPath(value.slice(origin.length), urlMap);
		}
		// Protocol-relative or external absolute URL: leave alone.
		if (
			value.startsWith("//") ||
			value.startsWith("http://") ||
			value.startsWith("https://")
		) {
			return value;
		}
		// Relative internal path (starts with "/"): look up.
		// Skip local image paths (those are handled by the image rewriter).
		if (value.startsWith("/")) {
			return lookupPath(value, urlMap);
		}
		return value;
	}

	if (Array.isArray(value)) {
		return value.map((item) => rewriteValue(item, origin, urlMap));
	}

	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			result[k] = rewriteValue(v, origin, urlMap);
		}
		return result;
	}

	return value;
}

/**
 * Look up a path in the urlMap, tolerating trailing-slash mismatches.
 * Tries exact, then +"/", then without trailing "/". Returns the path
 * unchanged if no variant matches.
 */
function lookupPath(path: string, urlMap: Record<string, string>): string {
	if (path in urlMap) return urlMap[path];
	if (!path.endsWith("/") && `${path}/` in urlMap) return urlMap[`${path}/`];
	if (path.endsWith("/") && path.length > 1) {
		const stripped = path.slice(0, -1);
		if (stripped in urlMap) return urlMap[stripped];
	}
	return path;
}

// ---------------------------------------------------------------------------
// rewriteImageUrls
// ---------------------------------------------------------------------------

/**
 * Rewrite image URLs in content using the asset lookup (originalUrl → localPath).
 * Produces a copy with all known image URLs replaced by `images/{localPath}`.
 */
export function rewriteImageUrls(
	content: Record<string, unknown>,
	assetLookup: Record<string, string>,
): Record<string, unknown> {
	return rewriteImageValue(content, assetLookup) as Record<string, unknown>;
}

function rewriteImageValue(
	value: unknown,
	assetLookup: Record<string, string>,
): unknown {
	if (typeof value === "string") {
		const localPath = assetLookup[value];
		if (localPath) return `images/${localPath}`;
		return value;
	}

	if (Array.isArray(value)) {
		return value.map((item) => rewriteImageValue(item, assetLookup));
	}

	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			result[k] = rewriteImageValue(v, assetLookup);
		}
		return result;
	}

	return value;
}

// ---------------------------------------------------------------------------
// collectExternalLinks
// ---------------------------------------------------------------------------

/**
 * Walk content recursively and collect all external links.
 * An external link is any URL that starts with http/https and is NOT
 * in the urlMap or assetLookup (i.e., not an internal link or image).
 */
export function collectExternalLinks(
	content: Record<string, unknown>,
	pageType: string,
	siteOrigin: string,
	urlMap: Record<string, string>,
	assetLookup: Record<string, string>,
): ExternalLink[] {
	const links: ExternalLink[] = [];
	walkForExternalLinks(
		content,
		pageType,
		siteOrigin,
		urlMap,
		assetLookup,
		"",
		links,
	);
	return links;
}

function walkForExternalLinks(
	value: unknown,
	pageType: string,
	siteOrigin: string,
	urlMap: Record<string, string>,
	assetLookup: Record<string, string>,
	path: string,
	accumulator: ExternalLink[],
): void {
	if (typeof value === "string") {
		if (
			(value.startsWith("http://") || value.startsWith("https://")) &&
			!value.startsWith(siteOrigin) &&
			!(value in assetLookup)
		) {
			accumulator.push({
				url: value,
				pageType,
				fieldPath: path,
				type: classifyExternalUrl(value),
			});
		}
		return;
	}

	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			walkForExternalLinks(
				value[i],
				pageType,
				siteOrigin,
				urlMap,
				assetLookup,
				`${path}[${i}]`,
				accumulator,
			);
		}
		return;
	}

	if (value !== null && typeof value === "object") {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			walkForExternalLinks(
				v,
				pageType,
				siteOrigin,
				urlMap,
				assetLookup,
				path ? `${path}.${k}` : k,
				accumulator,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// collectUnresolvedInternalLinks
// ---------------------------------------------------------------------------

/**
 * Walk rewritten content and collect all internal paths that don't correspond
 * to an actual page in the final dataset.
 *
 * These are typically form-action targets (e.g. `/search`) or links to pages
 * the scraper listed in structure.json but didn't actually scrape content for.
 * Callers use this list to exclude them from referential-completeness assertions.
 */
export function collectUnresolvedInternalLinks(
	content: Record<string, unknown>,
	pageType: string,
	knownPageUrls: ReadonlySet<string>,
): UnresolvedInternalLink[] {
	const links: UnresolvedInternalLink[] = [];
	walkForUnresolvedInternal(content, pageType, knownPageUrls, "", links);
	return links;
}

function walkForUnresolvedInternal(
	value: unknown,
	pageType: string,
	knownFinalUrls: ReadonlySet<string>,
	path: string,
	accumulator: UnresolvedInternalLink[],
): void {
	if (typeof value === "string") {
		if (
			value.startsWith("/") &&
			!value.startsWith("//") &&
			!value.startsWith("images/") &&
			value !== "/" &&
			!knownFinalUrls.has(value)
		) {
			accumulator.push({ path: value, pageType, fieldPath: path });
		}
		return;
	}

	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			walkForUnresolvedInternal(
				value[i],
				pageType,
				knownFinalUrls,
				`${path}[${i}]`,
				accumulator,
			);
		}
		return;
	}

	if (value !== null && typeof value === "object") {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			walkForUnresolvedInternal(
				v,
				pageType,
				knownFinalUrls,
				path ? `${path}.${k}` : k,
				accumulator,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// updatePageUrls
// ---------------------------------------------------------------------------

/**
 * Update the `url` field of each PreparedPage to the final URL.
 */
export function updatePageUrls(
	pages: PreparedPage[],
	urlMap: Record<string, string>,
): PreparedPage[] {
	return pages.map((page) => ({
		...page,
		url: urlMap[page.url] ?? page.url,
	}));
}

// ---------------------------------------------------------------------------
// rewriteAllContent
// ---------------------------------------------------------------------------

/**
 * Core Phase 4 algorithm: rewrite all content (links + images) across all pages.
 * Produces the full PreparedContent output artifact.
 */
export function rewriteAllContent(
	pages: PreparedPage[],
	siteUrl: string,
	urlMap: Record<string, string>,
	assetLookup: Record<string, string>,
): PreparedContent {
	const origin = parseOrigin(siteUrl);
	const allExternalLinks: ExternalLink[] = [];
	const rewrittenPages: PreparedPage[] = [];

	// Pass 1: rewrite all pages, collect external links
	for (const page of pages) {
		const externals = collectExternalLinks(
			page.content,
			page.pagetype,
			origin,
			urlMap,
			assetLookup,
		);
		allExternalLinks.push(...externals);

		const afterLinks = rewriteInternalLinks(page.content, siteUrl, urlMap);
		const afterImages = rewriteImageUrls(afterLinks, assetLookup);

		rewrittenPages.push({
			...page,
			url: urlMap[page.url] ?? page.url,
			content: afterImages,
		});
	}

	// Pass 2: collect unresolved internal paths using the final set of page URLs.
	// A path is unresolved if no actual page exists at that URL.
	const knownPageUrls = new Set(rewrittenPages.map((p) => p.url));
	const allUnresolved: UnresolvedInternalLink[] = [];
	for (const page of rewrittenPages) {
		const unresolved = collectUnresolvedInternalLinks(
			page.content as Record<string, unknown>,
			page.pagetype,
			knownPageUrls,
		);
		allUnresolved.push(...unresolved);
	}

	return {
		pages: rewrittenPages,
		externalLinks: allExternalLinks,
		unresolvedInternalLinks: allUnresolved,
	};
}

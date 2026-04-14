/**
 * Pure: Phase 6 (validate-dataset) logic.
 *
 * 15 hard assertions that verify the prepare segment's output is self-contained
 * and referentially complete. Any failure = bug in phases 1-5.
 *
 * All functions are pure (data in → data out). No IO.
 * (Assertion 6 — image files on disk — is the one check the IO shell performs.)
 */

import type { AssetEntry } from "./download.js";
import type { Heuristics, StructureMap } from "./heuristics.js";
import type { PageTypeMeta, PreparedPage } from "./ingest.js";
import { convertUrlPattern } from "./ingest.js";
import { isValidAstroRoutePattern, validateRoutePatterns } from "./routes.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ValidationFailure {
	assertion: number;
	description: string;
	details: string[];
}

interface DatasetValidation {
	valid: boolean;
	failures: ValidationFailure[];
}

// ---------------------------------------------------------------------------
// validateDataset
// ---------------------------------------------------------------------------

/**
 * Run all 15 assertions on the prepare output.
 *
 * Assertion 6 (downloaded files exist on disk) requires a set of filenames
 * that actually exist — the IO shell builds this set and passes it in.
 *
 * Assertions 10, 11 require optional artefacts (urlMap, heuristics,
 * structureMaps). When omitted, those assertions are skipped — useful for
 * unit tests that exercise a minimal baseline dataset.
 */
export function validateDataset(opts: {
	pages: PreparedPage[];
	pageTypeMeta: PageTypeMeta[];
	assetEntries: AssetEntry[];
	siteUrl: string;
	existingImageFiles: Set<string>;
	unresolvedInternalPaths?: Set<string>;
	urlMap?: Record<string, string>;
	heuristics?: Heuristics;
	structureMaps?: StructureMap[];
}): DatasetValidation {
	const unresolved = opts.unresolvedInternalPaths ?? new Set<string>();

	const checks: Array<() => ValidationFailure | null> = [
		() => assertImageUrlsInManifest(opts.pages, opts.assetEntries),
		() =>
			assertInternalLinksResolvable(opts.pages, opts.pageTypeMeta, unresolved),
		() => assertNoUnresolvedRefs(opts.pages),
		() => assertEveryTypeHasPages(opts.pages, opts.pageTypeMeta),
		() => assertNoSiteOriginUrls(opts.pages, opts.siteUrl),
		() =>
			assertDownloadedFilesExist(opts.assetEntries, opts.existingImageFiles),
		() => assertNoRouteConflicts(opts.pageTypeMeta),
		() => assertValidAstroPatterns(opts.pageTypeMeta),
		() => assertPageMetaBijection(opts.pages, opts.pageTypeMeta),
		() => (opts.urlMap ? assertUrlMapInjective(opts.urlMap) : null),
		() =>
			opts.heuristics || opts.structureMaps
				? assertHeuristicsConsistent(
						opts.pages,
						opts.heuristics,
						opts.structureMaps,
					)
				: null,
		() => assertManifestUnique(opts.assetEntries),
		() => assertFlatFilenames(opts.assetEntries),
		() => assertPageStructuralIntegrity(opts.pages),
		() =>
			unresolved.size > 0
				? assertUnresolvedPathsNotStale(opts.pages, unresolved)
				: null,
	];

	const failures: ValidationFailure[] = [];
	for (const check of checks) {
		const r = check();
		if (r) failures.push(r);
	}

	return { valid: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Assertion 1: Every image URL in content → entry in asset-manifest
//             AND that entry has downloaded: true
// ---------------------------------------------------------------------------

function assertImageUrlsInManifest(
	pages: PreparedPage[],
	assetEntries: AssetEntry[],
): ValidationFailure | null {
	const downloaded = new Set<string>();
	for (const e of assetEntries) {
		if (!e.downloaded) continue;
		downloaded.add(e.localPath);
		downloaded.add(`images/${e.localPath}`);
	}

	const orphaned: string[] = [];
	for (const page of pages) {
		walkStrings(page.content, (value) => {
			if (isLocalImageRef(value) && !downloaded.has(value)) {
				orphaned.push(`${page.url}: ${value}`);
			}
		});
	}

	if (orphaned.length === 0) return null;
	return {
		assertion: 1,
		description:
			"Image URL in content not in asset-manifest as downloaded: true",
		details: orphaned.slice(0, 10),
	};
}

function isLocalImageRef(value: string): boolean {
	return value.startsWith("images/");
}

// ---------------------------------------------------------------------------
// Assertion 2: Every internal link → known final URL in page-type-meta
// ---------------------------------------------------------------------------

function assertInternalLinksResolvable(
	pages: PreparedPage[],
	pageTypeMeta: PageTypeMeta[],
	unresolvedInternalPaths: ReadonlySet<string>,
): ValidationFailure | null {
	const allKnownUrls = new Set<string>();
	for (const meta of pageTypeMeta) {
		for (const url of meta.urls) {
			allKnownUrls.add(url);
		}
	}
	// Root is always valid
	allKnownUrls.add("/");

	const broken: string[] = [];
	for (const page of pages) {
		walkStrings(page.content, (value) => {
			// An internal link starts with / and is not an image path
			if (
				value.startsWith("/") &&
				!value.startsWith("images/") &&
				value !== "/" &&
				!allKnownUrls.has(value) &&
				!unresolvedInternalPaths.has(value)
			) {
				broken.push(`${page.url}: ${value}`);
			}
		});
	}

	if (broken.length === 0) return null;
	return {
		assertion: 2,
		description: "Internal link not found in page-type-meta URLs",
		details: broken.slice(0, 10),
	};
}

// ---------------------------------------------------------------------------
// Assertion 3: No unresolved $ref in any page's schema
// ---------------------------------------------------------------------------

function assertNoUnresolvedRefs(
	pages: PreparedPage[],
): ValidationFailure | null {
	const danglingRefs: string[] = [];
	for (const page of pages) {
		walkForRef(page.schema, (refValue) => {
			danglingRefs.push(`${page.url} schema: ${refValue}`);
		});
	}

	if (danglingRefs.length === 0) return null;
	return {
		assertion: 3,
		description: "Unresolved $ref in page schema",
		details: danglingRefs.slice(0, 10),
	};
}

function walkForRef(obj: unknown, onRef: (ref: string) => void): void {
	if (!obj || typeof obj !== "object") return;
	if (Array.isArray(obj)) {
		for (const item of obj) walkForRef(item, onRef);
		return;
	}
	const record = obj as Record<string, unknown>;
	if (typeof record.$ref === "string") {
		onRef(record.$ref);
	}
	for (const v of Object.values(record)) {
		walkForRef(v, onRef);
	}
}

// ---------------------------------------------------------------------------
// Assertion 4: Every page type in meta has >= 1 content page
// ---------------------------------------------------------------------------

function assertEveryTypeHasPages(
	pages: PreparedPage[],
	pageTypeMeta: PageTypeMeta[],
): ValidationFailure | null {
	const pagetypeSet = new Set(pages.map((p) => p.pagetype));
	const empty: string[] = [];
	for (const meta of pageTypeMeta) {
		if (!pagetypeSet.has(meta.pagetype)) {
			empty.push(meta.pagetype);
		}
	}

	if (empty.length === 0) return null;
	return {
		assertion: 4,
		description: "Page type in meta has no content pages",
		details: empty,
	};
}

// ---------------------------------------------------------------------------
// Assertion 5: No siteUrl origin URLs remain in content
// ---------------------------------------------------------------------------

function assertNoSiteOriginUrls(
	pages: PreparedPage[],
	siteUrl: string,
): ValidationFailure | null {
	let origin: string;
	try {
		origin = new URL(siteUrl).origin;
	} catch {
		origin = siteUrl;
	}

	const leaked: string[] = [];
	for (const page of pages) {
		walkStrings(page.content, (value) => {
			if (value.startsWith(origin)) {
				leaked.push(`${page.url}: ${value}`);
			}
		});
	}

	if (leaked.length === 0) return null;
	return {
		assertion: 5,
		description: "Original site URL still present in content",
		details: leaked.slice(0, 10),
	};
}

// ---------------------------------------------------------------------------
// Assertion 6: Every downloaded: true asset → file exists on disk
// ---------------------------------------------------------------------------

function assertDownloadedFilesExist(
	assetEntries: AssetEntry[],
	existingFiles: Set<string>,
): ValidationFailure | null {
	const missing: string[] = [];
	for (const entry of assetEntries) {
		if (entry.downloaded && !existingFiles.has(entry.localPath)) {
			missing.push(entry.localPath);
		}
	}

	if (missing.length === 0) return null;
	return {
		assertion: 6,
		description: "Downloaded asset file not found on disk",
		details: missing.slice(0, 10),
	};
}

// ---------------------------------------------------------------------------
// Assertion 7: validateRoutePatterns(finalPatterns).valid === true
// ---------------------------------------------------------------------------

function assertNoRouteConflicts(
	pageTypeMeta: PageTypeMeta[],
): ValidationFailure | null {
	const routes = pageTypeMeta.map((m) => ({
		pattern: convertUrlPattern(m.urlPattern),
		pageType: m.pagetype,
	}));
	const result = validateRoutePatterns(routes);
	if (result.valid) return null;

	return {
		assertion: 7,
		description: "Route pattern conflict detected",
		details: result.conflicts.map((c) => `${c.a} <-> ${c.b}: ${c.reason}`),
	};
}

// ---------------------------------------------------------------------------
// Assertion 8: Every final urlPattern → valid Astro file-based route
// ---------------------------------------------------------------------------

function assertValidAstroPatterns(
	pageTypeMeta: PageTypeMeta[],
): ValidationFailure | null {
	const invalid: string[] = [];
	for (const meta of pageTypeMeta) {
		if (!isValidAstroRoutePattern(meta.urlPattern)) {
			invalid.push(`${meta.pagetype}: ${meta.urlPattern}`);
		}
	}

	if (invalid.length === 0) return null;
	return {
		assertion: 8,
		description: "Invalid Astro route pattern",
		details: invalid,
	};
}

// ---------------------------------------------------------------------------
// Assertion 9: page ↔ pageTypeMeta bijection
// ---------------------------------------------------------------------------

function assertPageMetaBijection(
	pages: PreparedPage[],
	pageTypeMeta: PageTypeMeta[],
): ValidationFailure | null {
	const pageSet = new Set<string>();
	for (const p of pages) {
		pageSet.add(`${p.pagetype}|${p.url}`);
	}

	const metaSet = new Set<string>();
	for (const m of pageTypeMeta) {
		for (const url of m.urls) {
			metaSet.add(`${m.pagetype}|${url}`);
		}
	}

	const details: string[] = [];

	// Pages without meta entry
	for (const key of pageSet) {
		if (!metaSet.has(key)) {
			const [pt, url] = key.split("|");
			details.push(`page without meta entry: ${pt} ${url}`);
		}
	}
	// Meta urls without page
	for (const key of metaSet) {
		if (!pageSet.has(key)) {
			const [pt, url] = key.split("|");
			details.push(`meta url without page: ${pt} ${url}`);
		}
	}
	// count / urls.length mismatch
	for (const m of pageTypeMeta) {
		if (m.count !== m.urls.length) {
			details.push(
				`${m.pagetype}: count=${m.count} but urls.length=${m.urls.length}`,
			);
		}
	}

	if (details.length === 0) return null;
	return {
		assertion: 9,
		description: "Page/pageTypeMeta mismatch",
		details: details.slice(0, 20),
	};
}

// ---------------------------------------------------------------------------
// Assertion 10: urlMap injectivity (no two keys map to same value)
// ---------------------------------------------------------------------------

function assertUrlMapInjective(
	urlMap: Record<string, string>,
): ValidationFailure | null {
	const valueToKeys: Record<string, string[]> = {};
	for (const [k, v] of Object.entries(urlMap)) {
		if (!valueToKeys[v]) valueToKeys[v] = [];
		valueToKeys[v].push(k);
	}

	const collisions: string[] = [];
	for (const [v, keys] of Object.entries(valueToKeys)) {
		if (keys.length > 1) {
			collisions.push(`${v} ← ${keys.join(", ")}`);
		}
	}

	if (collisions.length === 0) return null;
	return {
		assertion: 10,
		description: "urlMap maps distinct origins to same final URL",
		details: collisions.slice(0, 10),
	};
}

// ---------------------------------------------------------------------------
// Assertion 11: heuristics consistency with pages
// ---------------------------------------------------------------------------

function assertHeuristicsConsistent(
	pages: PreparedPage[],
	heuristics: Heuristics | undefined,
	structureMaps: StructureMap[] | undefined,
): ValidationFailure | null {
	const details: string[] = [];
	const pageUrlSet = new Set(pages.map((p) => p.url));

	if (heuristics) {
		checkHeuristicsTotals(heuristics, pages, details);
		checkHeuristicsPerType(heuristics, pages, pageUrlSet, details);
	}

	if (structureMaps) {
		checkStructureMapUrls(structureMaps, pageUrlSet, details);
	}

	if (details.length === 0) return null;
	return {
		assertion: 11,
		description: "Heuristics/structureMap inconsistent with pages",
		details: details.slice(0, 20),
	};
}

function checkHeuristicsTotals(
	heuristics: Heuristics,
	pages: PreparedPage[],
	details: string[],
): void {
	if (heuristics.totalPages !== pages.length) {
		details.push(
			`heuristics.totalPages=${heuristics.totalPages} but pages.length=${pages.length}`,
		);
	}
	const uniqueTypes = new Set(pages.map((p) => p.pagetype)).size;
	if (heuristics.totalPageTypes !== uniqueTypes) {
		details.push(
			`heuristics.totalPageTypes=${heuristics.totalPageTypes} but unique pagetypes=${uniqueTypes}`,
		);
	}
}

function checkHeuristicsPerType(
	heuristics: Heuristics,
	pages: PreparedPage[],
	pageUrlSet: ReadonlySet<string>,
	details: string[],
): void {
	const typeCount: Record<string, number> = {};
	for (const p of pages) {
		typeCount[p.pagetype] = (typeCount[p.pagetype] ?? 0) + 1;
	}
	for (const pt of heuristics.pageTypes) {
		const actual = typeCount[pt.pagetype] ?? 0;
		if (pt.pageCount !== actual) {
			details.push(
				`${pt.pagetype}: heuristics pageCount=${pt.pageCount} but actual=${actual}`,
			);
		}
		if (pt.richestSampleUrl && !pageUrlSet.has(pt.richestSampleUrl)) {
			details.push(
				`${pt.pagetype}: richestSampleUrl ${pt.richestSampleUrl} not in pages`,
			);
		}
		if (pt.simplestSampleUrl && !pageUrlSet.has(pt.simplestSampleUrl)) {
			details.push(
				`${pt.pagetype}: simplestSampleUrl ${pt.simplestSampleUrl} not in pages`,
			);
		}
	}
}

function checkStructureMapUrls(
	structureMaps: StructureMap[],
	pageUrlSet: ReadonlySet<string>,
	details: string[],
): void {
	for (const sm of structureMaps) {
		if (!pageUrlSet.has(sm.sampleUrl)) {
			details.push(
				`structureMap ${sm.pagetype}: sampleUrl ${sm.sampleUrl} not in pages`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Assertion 12: manifest entry uniqueness (originalUrl + localPath)
// ---------------------------------------------------------------------------

function assertManifestUnique(
	assetEntries: AssetEntry[],
): ValidationFailure | null {
	const urlCounts: Record<string, number> = {};
	const pathCounts: Record<string, number> = {};
	for (const e of assetEntries) {
		urlCounts[e.originalUrl] = (urlCounts[e.originalUrl] ?? 0) + 1;
		pathCounts[e.localPath] = (pathCounts[e.localPath] ?? 0) + 1;
	}

	const details: string[] = [];
	for (const [url, n] of Object.entries(urlCounts)) {
		if (n > 1) details.push(`duplicate originalUrl (${n}×): ${url}`);
	}
	for (const [path, n] of Object.entries(pathCounts)) {
		if (n > 1) details.push(`duplicate localPath (${n}×): ${path}`);
	}

	if (details.length === 0) return null;
	return {
		assertion: 12,
		description: "Duplicate entries in asset manifest",
		details: details.slice(0, 10),
	};
}

// ---------------------------------------------------------------------------
// Assertion 13: flat-filename invariant (localPath contains no slash)
// ---------------------------------------------------------------------------

function assertFlatFilenames(
	assetEntries: AssetEntry[],
): ValidationFailure | null {
	const offenders: string[] = [];
	for (const e of assetEntries) {
		if (e.localPath.includes("/")) {
			offenders.push(e.localPath);
		}
	}

	if (offenders.length === 0) return null;
	return {
		assertion: 13,
		description: "Asset localPath contains slash (must be flat filename)",
		details: offenders.slice(0, 10),
	};
}

// ---------------------------------------------------------------------------
// Assertion 14: page structural integrity (non-empty url/pagetype, url starts with /)
// ---------------------------------------------------------------------------

function assertPageStructuralIntegrity(
	pages: PreparedPage[],
): ValidationFailure | null {
	const details: string[] = [];
	for (const p of pages) {
		if (typeof p.url !== "string" || p.url.length === 0) {
			details.push(`page with empty url (pagetype=${p.pagetype})`);
			continue;
		}
		if (!p.url.startsWith("/")) {
			details.push(`page url does not start with /: ${p.url}`);
		}
		if (typeof p.pagetype !== "string" || p.pagetype.length === 0) {
			details.push(`page with empty pagetype (url=${p.url})`);
		}
	}

	if (details.length === 0) return null;
	return {
		assertion: 14,
		description: "Page structural integrity violation",
		details: details.slice(0, 10),
	};
}

// ---------------------------------------------------------------------------
// Assertion 15: unresolvedInternalPaths entries must appear in content
// ---------------------------------------------------------------------------

function assertUnresolvedPathsNotStale(
	pages: PreparedPage[],
	unresolvedInternalPaths: ReadonlySet<string>,
): ValidationFailure | null {
	const seen = new Set<string>();
	for (const page of pages) {
		walkStrings(page.content, (value) => {
			if (unresolvedInternalPaths.has(value)) {
				seen.add(value);
			}
		});
	}

	const stale: string[] = [];
	for (const path of unresolvedInternalPaths) {
		if (!seen.has(path)) {
			stale.push(path);
		}
	}

	if (stale.length === 0) return null;
	return {
		assertion: 15,
		description:
			"unresolvedInternalPaths entries not found in any page content",
		details: stale.slice(0, 10),
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Walk all string values in a nested structure. */
function walkStrings(obj: unknown, fn: (value: string) => void): void {
	if (typeof obj === "string") {
		fn(obj);
		return;
	}
	if (Array.isArray(obj)) {
		for (const item of obj) walkStrings(item, fn);
		return;
	}
	if (obj !== null && typeof obj === "object") {
		for (const v of Object.values(obj as Record<string, unknown>)) {
			walkStrings(v, fn);
		}
	}
}

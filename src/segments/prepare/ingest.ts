/**
 * Pure: Phase 1 (ingest) logic.
 *
 * Parses scraper output, resolves JSON Schema $ref pointers, validates content
 * against schemas, and produces flat PreparedPage[] + PageTypeMeta[].
 *
 * All functions are pure (data in → data out). No IO.
 */

import type {
	ContentData,
	PageContent,
	SchemaData,
	StructureData,
} from "../../types.js";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface PreparedPage {
	url: string;
	pagetype: string;
	content: Record<string, unknown>;
	schema: Record<string, unknown>;
}

export interface PageTypeMeta {
	pagetype: string;
	urlPattern: string;
	count: number;
	urls: string[];
	hasPagination: boolean;
}

interface ResolvedSchema {
	type: string;
	properties: Record<string, unknown>;
	required?: string[];
}

// ---------------------------------------------------------------------------
// flattenContent
// ---------------------------------------------------------------------------

/**
 * Flatten the grouped content format into a flat PageContent[] array.
 *
 * Input shape:  { page_types: { landing: { entries: [{url, content}] }, ... } }
 * Output shape: PageContent[] with synthesized id and pagetype from parent key.
 */
export function flattenContent(data: ContentData): PageContent[] {
	const pages: PageContent[] = [];

	for (const [pagetype, group] of Object.entries(data.page_types)) {
		for (let i = 0; i < group.entries.length; i++) {
			const entry = group.entries[i];
			pages.push({
				id: `${pagetype}-${i}`,
				url: entry.url,
				pagetype,
				content: entry.content,
			});
		}
	}

	return pages;
}

// ---------------------------------------------------------------------------
// resolveSchemaPages
// ---------------------------------------------------------------------------

/**
 * Extract per-page-type schemas, resolving top-level $ref pointers inline.
 *
 * Input shape:  { pages: { landing: { properties: { header: { "$ref": "#/definitions/header" } } } }, definitions: { header: {...} } }
 * Output shape: Record<pagetype, { type, properties, required? }> with $ref inlined.
 */
export function resolveSchemaPages(
	schema: SchemaData,
): Record<string, ResolvedSchema> {
	const resolved: Record<string, ResolvedSchema> = {};

	for (const [pagetype, pageSchema] of Object.entries(schema.pages)) {
		const properties: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(pageSchema.properties)) {
			properties[key] = resolveRefValue(value, schema.definitions);
		}

		resolved[pagetype] = {
			type: pageSchema.type,
			properties,
			required: pageSchema.required,
		};
	}

	return resolved;
}

/**
 * Fully recursive $ref resolution.
 *
 * Walks the entire value tree: inlines any `$ref` pointer encountered, and
 * continues walking into the inlined definition so nested refs also resolve.
 * Circular refs are guarded by a per-path visited set — if the same ref name
 * appears twice in a resolution chain, it's left as-is (caller sees it as
 * dangling via assertion 3).
 */
function resolveRefValue(
	value: unknown,
	definitions: Record<string, unknown> | undefined,
	visited: ReadonlySet<string> = new Set(),
): unknown {
	if (isRef(value)) {
		if (!definitions) return value;
		const refName = extractRefName(value.$ref);
		if (visited.has(refName)) return value;
		const definition = definitions[refName];
		if (definition === undefined) return value;
		const nextVisited = new Set(visited).add(refName);
		return resolveRefValue(definition, definitions, nextVisited);
	}

	if (Array.isArray(value)) {
		return value.map((v) => resolveRefValue(v, definitions, visited));
	}

	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			result[k] = resolveRefValue(v, definitions, visited);
		}
		return result;
	}

	return value;
}

/** Check if a value is a $ref object. */
function isRef(value: unknown): value is { $ref: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"$ref" in value &&
		typeof (value as Record<string, unknown>).$ref === "string"
	);
}

/** Extract definition name from a $ref string like "#/definitions/header". */
function extractRefName(ref: string): string {
	const parts = ref.split("/");
	return parts[parts.length - 1];
}

// ---------------------------------------------------------------------------
// normalizeStructurePatterns
// ---------------------------------------------------------------------------

/**
 * Normalize scraper-emitted placeholder names so they are identifier-safe.
 *
 * The scraper may emit placeholders containing hyphens (e.g. `/{service-path}/`,
 * `/{legal-page}/`). Hyphens are illegal inside JS identifiers and would force
 * bracket-notation access on `Astro.params` downstream, so we fold them to
 * underscores at the ingest boundary. After normalization, every `{...}`
 * placeholder is guaranteed to match `/^\{\w+\}$/`.
 *
 *   "/{service-path}/" → "/{service_path}/"
 *   "/{legal-page}/"   → "/{legal_page}/"
 *   "/team/{slug}/"    → "/team/{slug}/"   (unchanged)
 */
export function normalizePlaceholderName(pattern: string): string {
	return pattern.replace(/\{([^}]+)\}/g, (_, name: string) => {
		return `{${name.replace(/-/g, "_")}}`;
	});
}

export function normalizeStructurePatterns(
	structure: StructureData,
): StructureData {
	return {
		...structure,
		page_types: structure.page_types.map((pt) => ({
			...pt,
			url_pattern: normalizePlaceholderName(pt.url_pattern),
		})),
	};
}

// ---------------------------------------------------------------------------
// convertUrlPattern
// ---------------------------------------------------------------------------

/**
 * Convert a scraper url_pattern to an Astro route pattern.
 * Replaces `{param}` with `[param]` for Astro's file-based routing.
 *
 *   "/team/{slug}/" → "/team/[slug]"
 *   "/{service}/"   → "/[service]"
 *   "/"             → "/"
 */
export function convertUrlPattern(pattern: string): string {
	const converted = pattern.replace(/\{(\w+)\}/g, "[$1]");
	if (converted.length > 1 && converted.endsWith("/")) {
		return converted.slice(0, -1);
	}
	return converted;
}

// ---------------------------------------------------------------------------
// buildPreparedPages
// ---------------------------------------------------------------------------

/**
 * Build the flat PreparedPage[] list with resolved schemas attached per page.
 *
 * The URL carried here is the ORIGINAL URL from the scraper. Phase 4 will
 * update these to final (post-route-resolution) URLs.
 */
export function buildPreparedPages(
	pages: PageContent[],
	resolvedSchemas: Record<string, ResolvedSchema>,
): PreparedPage[] {
	return pages.map((page) => ({
		url: page.url,
		pagetype: page.pagetype,
		content: page.content,
		schema: (resolvedSchemas[page.pagetype] ?? {}) as unknown as Record<
			string,
			unknown
		>,
	}));
}

// ---------------------------------------------------------------------------
// buildPageTypeMeta
// ---------------------------------------------------------------------------

/**
 * Build PageTypeMeta[] from the scraper structure.
 *
 * urlPattern and urls reflect the ORIGINAL (scraper-emitted) values. Phase 3
 * will update these to final (post-route-resolution) values.
 */
export function buildPageTypeMeta(structure: StructureData): PageTypeMeta[] {
	return structure.page_types.map((pt) => ({
		pagetype: pt.name,
		urlPattern: pt.url_pattern,
		count: pt.urls.length,
		urls: pt.urls,
		hasPagination: pt.urls.length >= 3,
	}));
}

// ---------------------------------------------------------------------------
// reconcileMetaWithPages
// ---------------------------------------------------------------------------

/**
 * Reconcile PageTypeMeta[] with the actual set of pages that have content.
 *
 * The scraper's structure.json may list URLs that content.json has no entry
 * for (e.g. the scraper discovered a URL but failed to fetch its body). The
 * meta.urls field must reflect only URLs that actually have content — otherwise
 * downstream segments will try to resolve sample URLs that don't exist.
 *
 * This function:
 *   - Filters meta.urls to only URLs that appear in `pages`.
 *   - Updates meta.count to match.
 *   - Drops page types that have zero pages after filtering.
 *
 * Page types whose patterns reference variables are *always* kept (the count
 * just shrinks). Only types with 0 remaining urls are dropped.
 */
export function reconcileMetaWithPages(
	meta: PageTypeMeta[],
	pages: PageContent[],
): PageTypeMeta[] {
	const urlsByType: Record<string, Set<string>> = {};
	for (const p of pages) {
		if (!urlsByType[p.pagetype]) urlsByType[p.pagetype] = new Set();
		urlsByType[p.pagetype].add(p.url);
	}

	const reconciled: PageTypeMeta[] = [];
	for (const m of meta) {
		const known = urlsByType[m.pagetype] ?? new Set<string>();
		const filteredUrls = m.urls.filter((u) => known.has(u));
		if (filteredUrls.length === 0) continue;
		reconciled.push({
			...m,
			urls: filteredUrls,
			count: filteredUrls.length,
			hasPagination: filteredUrls.length >= 3,
		});
	}
	return reconciled;
}

// ---------------------------------------------------------------------------
// validateContentAgainstSchema
// ---------------------------------------------------------------------------

interface ValidationWarning {
	pageType: string;
	url: string;
	missingField: string;
}

interface ContentValidation {
	valid: boolean;
	warnings: ValidationWarning[];
}

/**
 * Soft-validate that each page's content contains the required top-level
 * fields declared in its schema. Missing optional fields are not reported.
 *
 * Returns warnings rather than errors — content sometimes has legitimate
 * variation (optional sections may be absent). Classify/downstream can make
 * the judgment call on how to handle.
 */
export function validateContentAgainstSchema(
	pages: PageContent[],
	resolvedSchemas: Record<string, ResolvedSchema>,
): ContentValidation {
	const warnings: ValidationWarning[] = [];

	for (const page of pages) {
		const schema = resolvedSchemas[page.pagetype];
		if (!schema) continue;

		const required = schema.required ?? [];
		for (const field of required) {
			if (!(field in page.content)) {
				warnings.push({
					pageType: page.pagetype,
					url: page.url,
					missingField: field,
				});
			}
		}
	}

	return { valid: warnings.length === 0, warnings };
}

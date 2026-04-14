/**
 * Pure: adapter functions to normalize new scraper format into internal pipeline types.
 *
 * The scraper produces a richer grouped format (page_types keyed by name,
 * $ref-based schemas). These adapters convert that into the flat PageContent[]
 * and resolved schema format that downstream pipeline functions expect.
 */

import type { ContentData, PageContent, SchemaData } from "../../types.js";

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
 * Extract per-page-type schemas from the new format, resolving top-level $ref pointers.
 *
 * Input shape:  { pages: { landing: { properties: { header: { "$ref": "#/definitions/header" } } } }, definitions: { header: {...} } }
 * Output shape: Record<pagetype, { type, properties, required? }> with $ref inlined.
 *
 * Only resolves property-level $ref (one level deep) since downstream consumers
 * (extractSchemaKeys) only read Object.keys(properties).
 */
export function resolveSchemaPages(
	schema: SchemaData,
): Record<string, { type: string; properties: Record<string, unknown> }> {
	const resolved: Record<
		string,
		{ type: string; properties: Record<string, unknown> }
	> = {};

	for (const [pagetype, pageSchema] of Object.entries(schema.pages)) {
		const properties: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(pageSchema.properties)) {
			if (isRef(value) && schema.definitions) {
				const refName = extractRefName(value.$ref);
				const definition = schema.definitions[refName];
				properties[key] = definition ?? value;
			} else {
				properties[key] = value;
			}
		}

		resolved[pagetype] = {
			type: pageSchema.type,
			properties,
		};
	}

	return resolved;
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
// convertUrlPattern
// ---------------------------------------------------------------------------

/**
 * Convert a scraper url_pattern to an Astro route pattern.
 *
 * Replaces `{param}` with `[param]` for Astro's file-based routing.
 * Examples:
 *   "/team/{slug}/" → "/team/[slug]"
 *   "/{service}/"   → "/[service]"
 *   "/"             → "/"
 */
export function convertUrlPattern(pattern: string): string {
	// Replace {param} with [param]
	const converted = pattern.replace(/\{(\w+)\}/g, "[$1]");
	// Normalize: strip trailing slash (except for root "/")
	if (converted.length > 1 && converted.endsWith("/")) {
		return converted.slice(0, -1);
	}
	return converted;
}

// ---------------------------------------------------------------------------
// extractSlugParam
// ---------------------------------------------------------------------------

/**
 * Extract the slug parameter name from a url_pattern.
 *
 * Examples:
 *   "/team/{slug}/"    → "slug"
 *   "/{service}/"      → "service"
 *   "/post/{slug}/"    → "slug"
 *   "/"                → undefined
 *   "/about/"          → undefined
 */
export function extractSlugParam(urlPattern: string): string | undefined {
	const match = /\{(\w+)\}/.exec(urlPattern);
	return match ? match[1] : undefined;
}

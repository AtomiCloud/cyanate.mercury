/**
 * Pure: adapter functions to normalize new scraper format into internal pipeline types.
 *
 * The scraper produces a richer grouped format (page_types keyed by name,
 * $ref-based schemas). These adapters convert that into the flat PageContent[]
 * and resolved schema format that downstream pipeline functions expect.
 */

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

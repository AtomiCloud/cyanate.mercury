/**
 * Pure: seed logic — content collection generation, Zod schema codegen, route generation.
 *
 * All functions are pure (data in → file tree out). No IO.
 */

import type { PageContent, Registry } from "../../types.js";
import type { ContentModelOutput } from "./classify.js";

// ---------------------------------------------------------------------------
// generateCollectionEntries
// ---------------------------------------------------------------------------

/**
 * Generate content collection file entries from registry + content.
 * Returns an array of { path, content, format } for each page that
 * belongs to a registered collection.
 *
 * Markdown entries use YAML frontmatter (--- delimiters) per Astro spec.
 * JSON entries are used for content without a body field.
 */
export function generateCollectionEntries(
	registry: Registry,
	contentModel: ContentModelOutput,
	pageContents: PageContent[],
): Array<{ path: string; content: string; format: "md" | "json" }> {
	const entries: Array<{
		path: string;
		content: string;
		format: "md" | "json";
	}> = [];

	for (const [collName, coll] of Object.entries(registry.collections)) {
		const cmColl = contentModel.collections[collName];
		const pagesForType = pageContents.filter(
			(p) => p.pagetype === coll.source_pagetype,
		);

		// Data collections (slug_field: "") use file() loader which loads a
		// single JSON file. Aggregate all entries into one array file so the
		// file() loader creates one entry per array item (keyed by id).
		if (cmColl?.slug_field === "") {
			if (pagesForType.length > 0) {
				const items = pagesForType.map((page) =>
					buildFrontmatterObject(page, coll, collName),
				);
				entries.push({
					path: `src/data/${collName}.json`,
					content: formatJson(items),
					format: "json",
				});
			}
			continue;
		}

		for (const page of pagesForType) {
			const slug = extractSlug(page, cmColl);
			const frontmatter = buildFrontmatter(page, coll, collName);
			const body = extractBody(page);

			if (body) {
				// Markdown: YAML frontmatter + body
				entries.push({
					path: `src/content/${collName}/${slug}.md`,
					content: `---\n${frontmatter}\n---\n\n${body}`,
					format: "md",
				});
			} else {
				// JSON: valid JSON file for content without body
				const jsonData = buildFrontmatterObject(page, coll, collName);
				entries.push({
					path: `src/content/${collName}/${slug}.json`,
					content: JSON.stringify(jsonData, null, 2),
					format: "json",
				});
			}
		}
	}

	return entries;
}

function extractSlug(
	page: PageContent,
	cmColl: { slug_field?: string } | undefined,
): string {
	// Try content model slug field first
	if (cmColl?.slug_field) {
		const slugValue = getNestedValue(page.content, cmColl.slug_field);
		if (typeof slugValue === "string") {
			return slugify(slugValue);
		}
	}

	// Fallback: derive from URL
	try {
		const url = new URL(page.url, "https://fallback.com");
		const pathname = url.pathname;
		const lastSegment = pathname.split("/").filter(Boolean).pop() ?? "untitled";
		return slugify(lastSegment);
	} catch {
		return slugify(page.url);
	}
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\w\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.trim();
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
	const keys = path.split(".");
	let current: unknown = obj;
	for (const key of keys) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

/** Build frontmatter as a plain object (shared by YAML and JSON paths). */
function buildFrontmatterObject(
	page: PageContent,
	coll: Registry["collections"][string],
	collName: string,
): Record<string, unknown> {
	const frontmatter: Record<string, unknown> = {
		id: page.id,
		url: page.url,
		pagetype: page.pagetype,
		collection: collName,
	};

	// Add slug from content if available
	const cmFields = (coll as Record<string, unknown>).slug_field;
	if (typeof cmFields === "string") {
		const slugVal = getNestedValue(page.content, cmFields);
		if (typeof slugVal === "string") {
			frontmatter.slug = slugify(slugVal);
		}
	}

	// Add all top-level content keys as frontmatter (excluding deeply nested objects)
	for (const [key, value] of Object.entries(page.content)) {
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			frontmatter[key] = value;
		}
	}

	return frontmatter;
}

function buildFrontmatter(
	page: PageContent,
	coll: Registry["collections"][string],
	collName: string,
): string {
	return objectToYaml(buildFrontmatterObject(page, coll, collName));
}

/**
 * Format a JSON value for Biome compatibility.
 * Uses tab indentation, trailing newline, and inlines short arrays
 * (matching Biome's default behavior for arrays that fit on one line).
 */
function formatJson(obj: unknown): string {
	const raw = JSON.stringify(obj, null, "\t");
	// Inline single-element string arrays: ": [\n\t\t"item"\n\t]" → ': ["item"]'
	const inlined = raw.replace(/:\s*\[\n\t+"([^"]+)"\n\t+\]/g, ': ["$1"]');
	return `${inlined}\n`;
}

/** Convert a simple object to YAML string (no arrays or nested objects). */
function objectToYaml(obj: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(obj)) {
		if (value === undefined || value === null) {
			lines.push(`${key}:`);
		} else if (typeof value === "string") {
			// Escape strings that look like YAML special values
			if (
				value.includes(":") ||
				value.includes("#") ||
				value.includes("\n") ||
				value === "" ||
				value === "true" ||
				value === "false" ||
				value === "null" ||
				/^[0-9]+(?:\.[0-9]+)?$/.test(value)
			) {
				lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
			} else {
				lines.push(`${key}: ${value}`);
			}
		} else if (typeof value === "number" || typeof value === "boolean") {
			lines.push(`${key}: ${value}`);
		} else {
			lines.push(`${key}: ${JSON.stringify(value)}`);
		}
	}
	return lines.join("\n");
}

function extractBody(page: PageContent): string {
	// Look for common body-like fields
	for (const field of ["body", "content", "description", "text"]) {
		const val = page.content[field];
		if (typeof val === "string" && val.length > 0) return val;
	}
	return "";
}

// ---------------------------------------------------------------------------
// generateGlobals
// ---------------------------------------------------------------------------

/**
 * Generate singleton/global data files from content model and page contents.
 * Returns files for site-wide data (e.g., navigation, site metadata).
 *
 * Each global is wrapped in an array with `id: "default"` so the Astro
 * file() loader treats it as a single entry — preserving singleton semantics.
 * Access via: `getEntry('globals_navigation', 'default')`.
 */
export function generateGlobals(
	contentModel: ContentModelOutput,
	pageContents: PageContent[],
): Array<{ path: string; content: string }> {
	const files: Array<{ path: string; content: string }> = [];

	// Extract navigation from the first landing page if available
	const landingPage = pageContents.find((p) => p.pagetype === "landing");
	if (landingPage?.content.navigation) {
		const navData =
			typeof landingPage.content.navigation === "object" &&
			landingPage.content.navigation !== null
				? (landingPage.content.navigation as Record<string, unknown>)
				: {};
		files.push({
			path: "src/data/navigation.json",
			content: formatJson([{ id: "default", ...navData }]),
		});
	}

	// Extract header from first landing page
	if (landingPage?.content.header) {
		const headerData =
			typeof landingPage.content.header === "object" &&
			landingPage.content.header !== null
				? (landingPage.content.header as Record<string, unknown>)
				: {};
		files.push({
			path: "src/data/header.json",
			content: formatJson([{ id: "default", ...headerData }]),
		});
	}

	// Generate site metadata
	files.push({
		path: "src/data/site.json",
		content: formatJson([
			{
				id: "default",
				totalPages: pageContents.length,
				collections: Object.keys(contentModel.collections),
			},
		]),
	});

	return files;
}

// ---------------------------------------------------------------------------
// generateContentConfig
// ---------------------------------------------------------------------------

/**
 * Generate content.config.ts source code with Zod schemas and loaders.
 * Uses Astro v6 API: defineCollection, glob() and file() from astro/loaders,
 * z from astro/zod.
 *
 * Collections use glob() loader for multi-entry content directories.
 * Globals (navigation, header, site metadata) use file() loader for
 * singleton data files — each wrapped in a single-element array with
 * `id: "default"` so file() treats it as one entry.
 */
export function generateContentConfig(
	registry: Registry,
	contentModel: ContentModelOutput,
	generatedGlobals?: Array<{ path: string }>,
): string {
	const collectionDefs: string[] = [];

	// Collections: loader type determined by collection kind
	for (const [collName, _coll] of Object.entries(registry.collections)) {
		const cmColl = contentModel.collections[collName];
		const isDataColl = cmColl?.slug_field === "";

		if (isDataColl) {
			// Data collection: file() loader reads a single JSON array file.
			// Each array item becomes a separate entry keyed by its id field.
			// Uses passthrough schema since data shapes are arbitrary.
			collectionDefs.push(`\t${collName}: defineCollection({
\t\tloader: file("./src/data/${collName}.json"),
\t\tschema: z.object({ id: z.string() }).passthrough(),
\t}),`);
		} else {
			// Content collection: glob() loader for multi-entry content directories.
			// Always match both .md and .json because pages within the same
			// collection may have body fields (→ .md) or not (→ .json).
			const loader = `glob({ pattern: "**/*.{md,json}", base: "./src/content/${collName}" })`;

			const fields = buildZodFields(collName, cmColl, registry);

			collectionDefs.push(`\t${collName}: defineCollection({
\t\tloader: ${loader},
\t\tschema: z.object({
\t\t\tid: z.string(),
\t\t\turl: z.string().url(),
\t\t\tpagetype: z.string(),
\t\t\tcollection: z.string(),
\t\t\tslug: z.string().optional(),${fields}
\t\t}),
\t}),`);
		}
	}

	// Globals: use file() loader for singleton data files
	if (generatedGlobals) {
		for (const global of generatedGlobals) {
			const globalCollName = deriveGlobalCollectionName(global.path);
			collectionDefs.push(`\t${globalCollName}: defineCollection({
\t\tloader: file("./${global.path}"),
\t\tschema: z.object({ id: z.string() }).passthrough(),
\t}),`);
		}
	}

	// Check if any collection uses file() loader (data collections or globals)
	const hasDataColl = Object.entries(registry.collections).some(
		([collName]) => contentModel.collections[collName]?.slug_field === "",
	);
	const hasFile =
		hasDataColl || (generatedGlobals && generatedGlobals.length > 0);
	const loaderImport = hasFile
		? `import { file, glob } from "astro/loaders";`
		: `import { glob } from "astro/loaders";`;

	const collectionsSrc = `import { defineCollection } from "astro:content";
${loaderImport}
import { z } from "astro/zod";

export const collections = {
${collectionDefs.join("\n")}
};
`;
	return collectionsSrc;
}

/**
 * Derive a collection name from a global data file path.
 * e.g., "src/data/navigation.json" → "globals_navigation"
 */
function deriveGlobalCollectionName(filePath: string): string {
	const fileName = filePath.split("/").pop() ?? "";
	const stem = fileName.replace(/\.[^.]+$/, "");
	return `globals_${stem}`;
}

function buildZodFields(
	collName: string,
	cmColl: { slug_field?: string; listable_by?: string[] } | undefined,
	registry: Registry,
): string {
	// Collect all fields as { dottedPath: zodExpr }
	const fieldMap = new Map<string, string>();

	if (cmColl?.slug_field) {
		fieldMap.set(cmColl.slug_field, "z.string().optional()");
	}

	// Add listable_by reference fields
	if (cmColl?.listable_by) {
		for (const ref of cmColl.listable_by) {
			fieldMap.set(ref, "z.string().optional()");
		}
	}

	// Add filterable_by if present
	const coll = registry.collections[collName];
	if (coll?.filterable_by) {
		const filters = Array.isArray(coll.filterable_by)
			? coll.filterable_by
			: [coll.filterable_by];
		for (const f of filters) {
			if (typeof f === "string") {
				fieldMap.set(f, "z.string().optional()");
			}
		}
	}

	return buildNestedZodFields(fieldMap);
}

/**
 * Convert a flat map of dotted paths → zod expressions into
 * properly nested z.object() TypeScript code.
 *
 * "seo.slug" → z.string().optional()  becomes:
 *   seo: z.object({ slug: z.string().optional() }).optional(),
 *
 * "title" → z.string().optional()  becomes:
 *   title: z.string().optional(),
 */
function buildNestedZodFields(fieldMap: Map<string, string>): string {
	const lines: string[] = [];

	for (const [dottedPath, zodExpr] of fieldMap) {
		const parts = dottedPath.split(".");

		if (parts.length === 1) {
			// Simple field
			lines.push(`\n\t\t\t${parts[0]}: ${zodExpr},`);
		} else {
			// Nested path — use z.object() for the parent
			const parentKey = parts[0];
			const childKey = parts[1];
			lines.push(
				`\n\t\t\t${parentKey}: z.object({ ${childKey}: ${zodExpr} }).optional(),`,
			);
		}
	}

	return lines.join("");
}

// ---------------------------------------------------------------------------
// generateRouteFiles
// ---------------------------------------------------------------------------

/**
 * Generate route files (src/pages/*.astro) from registry.
 * Dynamic routes (e.g., /blog/[slug]) create `[slug].astro`.
 * Static routes create corresponding .astro files.
 * Also generates collection item routes for each collection.
 *
 * Collection-item routes are generated based on the collection's loader type:
 * - glob() loader → content collection → use `render(entry)` + `<Content />`
 * - file() loader → data collection → use `entry.data` directly
 */
export function generateRouteFiles(
	registry: Registry,
	contentModel?: ContentModelOutput,
): Array<{ path: string; content: string }> {
	const files: Array<{ path: string; content: string }> = [];

	// Generate routes from static_pages
	for (const sp of registry.static_pages) {
		const filePath = routeToFilePath(sp.route, sp.pagetype);
		const layout = sp.layout ?? getDefaultLayout(registry, sp.pagetype);
		const depth = filePath.split("/").length - 2; // pages/ is depth 0

		files.push({
			path: filePath,
			content: `---
import Layout from "${"../".repeat(depth)}layouts/${layout}.astro";
import { getCollection } from "astro:content";

const { pagetype } = Astro.params;
---

<Layout pagetype="${sp.pagetype}">
  <article>
    <p>Static page: ${sp.pagetype}</p>
  </article>
</Layout>
`,
		});
	}

	// Generate routes from listings
	for (const [listingName, listing] of Object.entries(registry.listings)) {
		const filePath = routeToFilePath(listing.route, listingName);
		const layout = getDefaultLayout(registry, listingName);
		const depth = filePath.split("/").length - 2;

		// Find the associated collection for this listing
		const collName = findCollectionForListing(listingName, listing, registry);

		if (collName) {
			files.push({
				path: filePath,
				content: `---
import Layout from "${"../".repeat(depth)}layouts/${layout}.astro";
import { getCollection } from "astro:content";

const entries = await getCollection("${collName}");
---

<Layout pagetype="${listingName}">
  <section>
    <ul>
      {entries.map((entry) => (
        <li><a href={\`${listing.route}/\${entry.id}\`}>{entry.id}</a></li>
      ))}
    </ul>
  </section>
</Layout>
`,
			});
		} else {
			// No collection could be determined — generate a static placeholder
			files.push({
				path: filePath,
				content: `---
import Layout from "${"../".repeat(depth)}layouts/${layout}.astro";
---

<Layout pagetype="${listingName}">
  <section>
    <p>Listing: ${listingName}</p>
  </section>
</Layout>
`,
			});
		}
	}

	// Generate collection item routes (e.g., /blog/[slug])
	for (const [collName, coll] of Object.entries(registry.collections)) {
		// Match listing to collection by:
		// 1. explicit queries[].collection field,
		// 2. collection's listable_by contains listing name,
		// 3. query pagetype matches source_pagetype.
		// Name-based guessing is intentionally omitted to avoid incorrect matches.
		const listingEntry = Object.entries(registry.listings).find(
			([listingName, l]) => {
				const explicitMatch = l.queries.some((q) => q.collection === collName);
				const listableByMatch =
					coll.listable_by?.includes(listingName) ?? false;
				const queryMatch = l.queries.some(
					(q) =>
						(q as Record<string, unknown>).pagetype ===
						(coll as Record<string, unknown>).source_pagetype,
				);
				return explicitMatch || listableByMatch || queryMatch;
			},
		);

		let routeBase: string;
		if (listingEntry) {
			const [, matchedListing] = listingEntry;
			routeBase = matchedListing.route;
		} else {
			// No listing found — derive route from collection name
			routeBase = `/${collName}`;
		}

		// Create dynamic route for collection items
		// For listing at /blog → collection items at /blog/[slug] → src/pages/blog/[slug].astro
		const routeSegments = routeBase.split("/").filter(Boolean);
		const lastSeg = routeSegments[routeSegments.length - 1];
		const param = lastSeg.startsWith("[") ? lastSeg.slice(1, -1) : "slug";
		// Use the full listing route segments as the directory path for the dynamic route
		const dirPath =
			routeSegments.length > 0 ? `${routeSegments.join("/")}/` : "";
		// Determine rendering approach from collection's loader type:
		// - slug_field: "" (empty) → file() loader → data collection → use getCollection() + entry.data
		// - slug_field: non-empty → glob() loader → content collection → use getCollection() + render()
		// If contentModel not provided, default to content (glob) rendering.
		const cmColl = contentModel?.collections[collName];
		const isDataCollection =
			contentModel !== undefined && cmColl?.slug_field === "";
		const useContentRenderer = !isDataCollection;

		const filePath = `src/pages/${dirPath}[${param}].astro`;
		const depth = filePath.split("/").length - 2;

		if (useContentRenderer) {
			files.push({
				path: filePath,
				content: `---
import Layout from "${"../".repeat(depth)}layouts/${getDefaultLayout(registry, coll.source_pagetype)}.astro";
import { getCollection, render } from "astro:content";

export async function getStaticPaths() {
  const entries = await getCollection("${collName}");
  return entries.map((entry) => ({
    params: { ${param}: entry.id },
    props: { entry },
  }));
}

const { ${param} } = Astro.params;
const { entry } = Astro.props;
const rendered = await render(entry);
const Content = rendered.Content;
---

<Layout pagetype="${collName}">
  <article>
    <Content />
  </article>
</Layout>
`,
			});
		} else {
			// file() loader — data collection, use entry.data directly.
			// Uses getCollection + getStaticPaths (not getEntry) because
			// file() with a JSON array creates multiple entries keyed by id.
			files.push({
				path: filePath,
				content: `---
import Layout from "${"../".repeat(depth)}layouts/${getDefaultLayout(registry, coll.source_pagetype)}.astro";
import { getCollection } from "astro:content";

export async function getStaticPaths() {
  const entries = await getCollection("${collName}");
  return entries.map((entry) => ({
    params: { ${param}: entry.id },
    props: { entry },
  }));
}

const { entry } = Astro.props;
---

<Layout pagetype="${collName}">
  <article>
    <dl>
      {Object.entries(entry.data).filter(([k]) => k !== "id" && k !== "collection").map(([key, value]) => (
        <div>
          <dt>{key}</dt>
          <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
        </div>
      ))}
    </dl>
  </article>
</Layout>
`,
			});
		}
	}

	return files;
}

function findCollectionForListing(
	listingName: string,
	listing: Registry["listings"][string],
	registry: Registry,
): string {
	// Priority 1: explicit collection reference in queries
	for (const query of listing.queries) {
		if (query.collection && query.collection in registry.collections) {
			return query.collection;
		}
	}
	// Priority 2: reverse lookup via collection's listable_by
	for (const [collName, coll] of Object.entries(registry.collections)) {
		if (coll.listable_by?.includes(listingName)) {
			return collName;
		}
	}
	// Priority 3: match by query pagetype → source_pagetype
	for (const [collName, coll] of Object.entries(registry.collections)) {
		const queryMatch = listing.queries.some(
			(q) => (q as Record<string, unknown>).pagetype === coll.source_pagetype,
		);
		if (queryMatch) return collName;
	}
	// No determinable collection — return empty to signal caller.
	// Name-based guessing is intentionally omitted: an unrelated listing
	// can incorrectly steal a collection route base solely because its name
	// happens to contain the collection name (e.g., "blog_index" matches "blog").
	return "";
}

function routeToFilePath(route: string, _fallback: string): string {
	const segments = route.split("/").filter(Boolean);
	if (segments.length === 0) return "src/pages/index.astro";

	const fileName = segments[segments.length - 1];
	const dir = segments.slice(0, -1);

	// Dynamic segment
	if (fileName.startsWith("[") && fileName.endsWith("]")) {
		const param = fileName.slice(1, -1);
		const dirPath = dir.length > 0 ? `${dir.join("/")}/` : "";
		return `src/pages/${dirPath}[${param}].astro`;
	}

	// Static route
	const dirPath = dir.length > 0 ? `${dir.join("/")}/` : "";
	return `src/pages/${dirPath}${fileName}.astro`;
}

function getDefaultLayout(registry: Registry, pagetype: string): string {
	for (const [layoutName, layout] of Object.entries(registry.layouts)) {
		if (layout.page_types.includes(pagetype)) return layoutName;
	}
	return "default";
}

// ---------------------------------------------------------------------------
// validateSeedCompleteness
// ---------------------------------------------------------------------------

/**
 * Validate seed completeness: every source page is accounted for
 * in the generated entries.
 */
export function validateSeedCompleteness(
	sourcePages: PageContent[],
	generatedEntries: Array<{ path: string }>,
): { complete: boolean; missing: string[] } {
	const generatedUrls = new Set<string>();

	for (const entry of generatedEntries) {
		// Skip non-page entries (globals, config) — only content/ and pages/ are page entries
		if (entry.path.startsWith("src/data/")) continue;

		for (const page of sourcePages) {
			if (entryMatchesPage(entry.path, page)) {
				generatedUrls.add(page.url);
			}
		}
	}

	const missing: string[] = [];
	for (const page of sourcePages) {
		if (!generatedUrls.has(page.url)) {
			missing.push(page.url);
		}
	}

	return { complete: missing.length === 0, missing };
}

function entryMatchesPage(entryPath: string, page: PageContent): boolean {
	const pathname = extractPathname(page.url);

	// Route-string path: Phase 5 passes route strings like "/", "/about", "/blog/[slug]"
	if (entryPath.startsWith("/") && !entryPath.includes(".")) {
		return routeMatchesPage(entryPath, pathname);
	}

	// src/pages/ route files → convert to route string for matching.
	// This handles both static routes (about.astro → /about) and dynamic
	// routes (blog/[slug].astro → /blog/[slug]) so that route files
	// contribute to seed completeness coverage.
	if (entryPath.startsWith("src/pages/") && entryPath.endsWith(".astro")) {
		let routeStr = `/${entryPath
			.replace("src/pages/", "")
			.replace(/\.astro$/, "")}`;
		// index files → parent directory (src/pages/about/index.astro → /about)
		if (routeStr.endsWith("/index")) routeStr = routeStr.slice(0, -6);
		if (!routeStr || routeStr === "/") routeStr = "/";
		return routeMatchesPage(routeStr, pathname);
	}

	// File-path path: content entries like "src/content/blog/first-post.md"
	const lastSegment = pathname.split("/").filter(Boolean).at(-1) ?? "";
	const slugified = slugify(lastSegment);

	// Extract entry filename stem (e.g., "first-post" from "...blog/first-post.md")
	const entryStem = extractEntryStem(entryPath);
	if (!entryStem) return false;

	// Root page matches index entries
	if (!slugified && entryPath.includes("index")) return true;

	// Exact stem equality only — no substring matching, no field-based guessing.
	// "post-1" must not match a path containing "post-10" or match via an
	// unrelated content field like "tag: post-1" on a different page.
	return slugified === entryStem;
}

/** Match a route string (e.g. "/", "/about", "/blog/[slug]") against a page pathname. */
function routeMatchesPage(route: string, pathname: string): boolean {
	const normRoute = route.replace(/\/$/, "") || "/";
	const normPath = pathname.replace(/\/$/, "") || "/";

	if (!normRoute.includes("[")) {
		// Exact match for static routes
		return normRoute === normPath;
	}

	// Dynamic route: split into segments and compare structure
	const routeSegs = normRoute.split("/").filter(Boolean);
	const pathSegs = normPath.split("/").filter(Boolean);

	if (routeSegs.length !== pathSegs.length) return false;

	for (let i = 0; i < routeSegs.length; i++) {
		if (routeSegs[i].startsWith("[")) continue; // dynamic segment matches anything
		if (routeSegs[i] !== pathSegs[i]) return false;
	}
	return true;
}

function extractEntryStem(entryPath: string): string {
	// Extract filename without extension from entry path
	const fileName = entryPath.split("/").pop() ?? "";
	const dotIdx = fileName.lastIndexOf(".");
	return dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
}

function extractPathname(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return url;
	}
}

/**
 * Pure: seed logic — content collection generation, Zod schema codegen, route generation.
 *
 * All functions are pure (data in → file tree out). No IO.
 */

import type { PageContent, Registry } from "../../types.js";
import type { ContentModelOutput } from "./classify.js";
import type {
	ClassifiedContentModel,
	ClassifiedPageType,
	FieldClassification,
} from "./content-model.js";
import {
	composeRichtext,
	getNestedValue,
	resolveImageUrl,
} from "./content-model.js";

// ---------------------------------------------------------------------------
// generateCollectionEntries
// ---------------------------------------------------------------------------

/**
 * Generate content collection file entries from registry + content.
 * Returns an array of { path, content, format } for each page that
 * belongs to a registered collection.
 *
 * All entries are JSON. Richtext-dominant page types (blog, article) get a
 * `body` field with composed HTML. Structured page types (landing, listing)
 * keep nested objects/repeaters as typed JSON fields.
 */
export function generateCollectionEntries(
	registry: Registry,
	contentModel: ContentModelOutput,
	pageContents: PageContent[],
	classifiedModel?: ClassifiedContentModel,
	assetManifest?: Record<string, string>,
): Array<{ path: string; content: string; format: "json" }> {
	const entries: Array<{
		path: string;
		content: string;
		format: "json";
	}> = [];

	for (const [collName, coll] of Object.entries(registry.collections)) {
		const cmColl = contentModel.collections[collName];
		const pagesForType = pageContents.filter(
			(p) => p.pagetype === coll.source_pagetype,
		);

		// Look up classification for this page type
		const classified = classifiedModel?.page_types.find(
			(c) => c.pagetype === coll.source_pagetype,
		);

		for (const page of pagesForType) {
			const slug = extractSlug(page, cmColl);
			const jsonData = buildEntryJson(
				page,
				coll,
				collName,
				classified,
				assetManifest,
			);

			entries.push({
				path: `src/content/${collName}/${slug}.json`,
				content: formatJson(jsonData),
				format: "json",
			});
		}
	}

	return entries;
}

/**
 * Build a CMS-friendly JSON entry for a page.
 *
 * For richtext-dominant types: composes HTML body + extracts scalar metadata.
 * For structured types: preserves nested objects/repeaters with resolved image URLs.
 */
function buildEntryJson(
	page: PageContent,
	coll: Registry["collections"][string],
	collName: string,
	classified: ClassifiedPageType | undefined,
	assetManifest?: Record<string, string>,
): Record<string, unknown> {
	const data = buildEntryBase(page, coll, collName);

	// Compose richtext body if spec is available
	if (classified?.body_compose) {
		const body = composeRichtext(
			page.content,
			classified.body_compose,
			assetManifest,
		);
		if (body) data.body = body;
	}

	if (!classified) {
		addTopLevelScalars(data, page.content, new Set(), new Set());
		return data;
	}

	const { excluded, skipped } = applyFieldClassifications(
		classified,
		page.content,
		data,
		assetManifest,
	);
	addTopLevelScalars(data, page.content, excluded, skipped);

	return data;
}

/** Build the base entry object with metadata fields. */
function buildEntryBase(
	page: PageContent,
	coll: Registry["collections"][string],
	collName: string,
): Record<string, unknown> {
	const data: Record<string, unknown> = {
		id: page.id,
		url: page.url,
		pagetype: page.pagetype,
		collection: collName,
	};

	const slugField = (coll as Record<string, unknown>).slug_field;
	if (typeof slugField === "string") {
		const slugVal = getNestedValue(page.content, slugField);
		if (typeof slugVal === "string") {
			data.slug = slugify(slugVal);
		}
	}

	return data;
}

/** Scalar field types that map directly to JSON values. */
const SCALAR_FIELD_TYPES = new Set([
	"string",
	"number",
	"boolean",
	"datetime",
	"select",
]);

/** Apply field classifications, returning sets of excluded/skipped top-level keys. */
function applyFieldClassifications(
	classified: ClassifiedPageType,
	content: Record<string, unknown>,
	data: Record<string, unknown>,
	assetManifest?: Record<string, string>,
): { excluded: Set<string>; skipped: Set<string> } {
	const excluded = new Set<string>();
	const skipped = new Set<string>();

	for (const fc of classified.field_classifications) {
		const topKey = fc.field_path.split(".")[0];

		if (fc.type === "richtext") {
			excluded.add(topKey);
		} else if (fc.type === "relationship") {
			skipped.add(topKey);
		} else if (fc.type === "image") {
			applyImageField(fc.field_path, content, data, assetManifest);
		} else if (fc.type === "object" || fc.type === "repeater") {
			applyStructuredField(fc.field_path, content, data, assetManifest);
		} else if (SCALAR_FIELD_TYPES.has(fc.type)) {
			applyScalarField(fc.field_path, content, data);
		}
	}

	return { excluded, skipped };
}

function applyImageField(
	fieldPath: string,
	content: Record<string, unknown>,
	data: Record<string, unknown>,
	assetManifest?: Record<string, string>,
): void {
	const value = getNestedValue(content, fieldPath);
	const resolved = resolveImageUrl(value, assetManifest);
	if (resolved) setNestedValue(data, fieldPath, resolved);
}

function applyStructuredField(
	fieldPath: string,
	content: Record<string, unknown>,
	data: Record<string, unknown>,
	assetManifest?: Record<string, string>,
): void {
	const value = getNestedValue(content, fieldPath);
	if (value !== undefined && value !== null) {
		setNestedValue(data, fieldPath, resolveImagesDeep(value, assetManifest));
	}
}

function applyScalarField(
	fieldPath: string,
	content: Record<string, unknown>,
	data: Record<string, unknown>,
): void {
	const value = getNestedValue(content, fieldPath);
	if (value !== undefined && value !== null && isScalar(value)) {
		setNestedValue(data, fieldPath, value);
	}
}

/** Add remaining top-level scalar fields not already handled by classification. */
function addTopLevelScalars(
	data: Record<string, unknown>,
	content: Record<string, unknown>,
	excluded: Set<string>,
	skipped: Set<string>,
): void {
	for (const [key, value] of Object.entries(content)) {
		if (data[key] !== undefined) continue;
		if (excluded.has(key) || skipped.has(key)) continue;
		if (isScalar(value)) data[key] = value;
	}
}

/** Set a value at a dot-separated path in an object, creating intermediates. */
function setNestedValue(
	obj: Record<string, unknown>,
	path: string,
	value: unknown,
): void {
	const keys = path.split(".");
	if (keys.length === 1) {
		obj[keys[0]] = value;
		return;
	}
	let current = obj;
	for (let i = 0; i < keys.length - 1; i++) {
		const key = keys[i];
		if (!current[key] || typeof current[key] !== "object") {
			current[key] = {};
		}
		current = current[key] as Record<string, unknown>;
	}
	current[keys[keys.length - 1]] = value;
}

/** Recursively resolve image URLs within nested objects/arrays. */
function resolveImagesDeep(
	value: unknown,
	assetManifest?: Record<string, string>,
): unknown {
	if (typeof value === "string") {
		// Check if it looks like an image URL
		if (assetManifest?.[value]) {
			return `/images/${assetManifest[value]}`;
		}
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item) => resolveImagesDeep(item, assetManifest));
	}
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		// If it looks like an image object ({src: "..."}) resolve it
		if (
			typeof obj.src === "string" ||
			typeof obj.url === "string" ||
			typeof obj.image === "string"
		) {
			const resolved = resolveImageUrl(obj, assetManifest);
			if (resolved) return resolved;
		}
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj)) {
			result[k] = resolveImagesDeep(v, assetManifest);
		}
		return result;
	}
	return value;
}

function isScalar(value: unknown): boolean {
	return (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	);
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

// ---------------------------------------------------------------------------
// generateGlobals
// ---------------------------------------------------------------------------

/**
 * Generate singleton/global data files from content model and page contents.
 * Returns files for site-wide data (e.g., navigation, site metadata).
 *
 * Each global is wrapped in an array with `id: "default"` so the Astro
 * file() loader treats it as a single entry — preserving singleton semantics.
 * Access via: `getEntry('navigation', 'default')`.
 */
export function generateGlobals(
	contentModel: ContentModelOutput,
	pageContents: PageContent[],
): Array<{ path: string; content: string }> {
	const files: Array<{ path: string; content: string }> = [];

	const landingPage = pageContents.find((p) => p.pagetype === "landing");
	extractHeaderAndNav(landingPage, files);

	// Generate site metadata
	files.push({
		path: "src/content/site/default.json",
		content: formatJson({
			totalPages: pageContents.length,
			collections: Object.keys(contentModel.collections),
		}),
	});

	return files;
}

/** Extract header + navigation globals from landing page content. */
function extractHeaderAndNav(
	landingPage: PageContent | undefined,
	files: Array<{ path: string; content: string }>,
): void {
	if (!landingPage) return;

	const headerObj = extractObject(landingPage.content.header);

	if (headerObj) {
		// Navigation nests inside header in new scraper format, or at top level
		const navSource = headerObj.navigation ?? landingPage.content.navigation;
		if (navSource) {
			files.push({
				path: "src/content/navigation/default.json",
				content: formatJson(normalizeNavData(navSource)),
			});
		}
		files.push({
			path: "src/content/header/default.json",
			content: formatJson(headerObj),
		});
	} else if (landingPage.content.navigation) {
		files.push({
			path: "src/content/navigation/default.json",
			content: formatJson(normalizeNavData(landingPage.content.navigation)),
		});
	}
}

/** Safely extract a value as a Record if it's a non-null object. */
function extractObject(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Normalize navigation data: arrays become { items: [...] }, objects pass through. */
function normalizeNavData(source: unknown): Record<string, unknown> {
	if (Array.isArray(source)) return { items: source };
	return extractObject(source) ?? {};
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
	generatedSingletons?: Array<{ path: string }>,
	classifiedModel?: ClassifiedContentModel,
): string {
	const collectionDefs: string[] = [];

	// All collections use glob() loader from src/content/{collName}
	for (const [collName, _coll] of Object.entries(registry.collections)) {
		const cmColl = contentModel.collections[collName];
		const loader = `glob({ pattern: "**/*.json", base: "./src/content/${collName}" })`;
		const fields = buildZodFields(collName, cmColl, registry, classifiedModel);

		collectionDefs.push(`\t${collName}: defineCollection({
\t\tloader: ${loader},
\t\tschema: z.object({
\t\t\tid: z.string(),
\t\t\turl: z.string(),
\t\t\tpagetype: z.string(),
\t\t\tcollection: z.string(),
\t\t\tslug: z.string().optional(),${fields}
\t\t}),
\t}),`);
	}

	// Singletons: glob() loader in src/content/{pagetype}/
	if (generatedSingletons) {
		for (const singleton of generatedSingletons) {
			const collName = deriveCollectionName(singleton.path);
			collectionDefs.push(`\t${collName}: defineCollection({
\t\tloader: glob({ pattern: "**/*.json", base: "./src/content/${collName}" }),
\t\tschema: z.object({ id: z.string(), body: z.string().optional() }).passthrough(),
\t}),`);
		}
	}

	// Globals: glob() loader in src/content/{name}/
	if (generatedGlobals) {
		for (const global of generatedGlobals) {
			const collName = deriveCollectionName(global.path);
			collectionDefs.push(`\t${collName}: defineCollection({
\t\tloader: glob({ pattern: "**/*.json", base: "./src/content/${collName}" }),
\t\tschema: z.object({ id: z.string() }).passthrough(),
\t}),`);
		}
	}

	const collectionsSrc = `import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

export const collections = {
${collectionDefs.join("\n")}
};
`;
	return collectionsSrc;
}

/**
 * Derive a collection name from a content file path.
 * e.g., "src/content/navigation/default.json" → "navigation"
 *       "src/content/landing/default.json"    → "landing"
 */
function deriveCollectionName(filePath: string): string {
	const parts = filePath.split("/");
	// Path format: src/content/{collName}/default.json — collection is the 3rd segment
	return parts[2] ?? filePath;
}

/** Fields already present in the hardcoded base schema of generateContentConfig. */
const BASE_SCHEMA_FIELDS = new Set([
	"id",
	"url",
	"pagetype",
	"collection",
	"slug",
]);

function buildZodFields(
	collName: string,
	cmColl: { slug_field?: string; listable_by?: string[] } | undefined,
	registry: Registry,
	classifiedModel?: ClassifiedContentModel,
): string {
	const fieldMap = new Map<string, string>();

	if (cmColl?.slug_field && !BASE_SCHEMA_FIELDS.has(cmColl.slug_field)) {
		fieldMap.set(cmColl.slug_field, "z.string().optional()");
	}
	addListableByFields(cmColl, fieldMap);
	addFilterableByFields(registry.collections[collName], fieldMap);

	// Add typed fields from content model classification
	const coll = registry.collections[collName];
	if (classifiedModel && coll) {
		const classified = classifiedModel.page_types.find(
			(c) => c.pagetype === coll.source_pagetype,
		);
		if (classified) addClassifiedFields(classified, fieldMap);
	}

	return buildNestedZodFields(fieldMap);
}

/** Add listable_by reference fields to the Zod field map. */
function addListableByFields(
	cmColl: { listable_by?: string[] } | undefined,
	fieldMap: Map<string, string>,
): void {
	if (!cmColl?.listable_by) return;
	for (const ref of cmColl.listable_by) {
		fieldMap.set(ref, "z.string().optional()");
	}
}

/** Add filterable_by fields to the Zod field map. */
function addFilterableByFields(
	coll: Registry["collections"][string] | undefined,
	fieldMap: Map<string, string>,
): void {
	if (!coll?.filterable_by) return;
	const filters = Array.isArray(coll.filterable_by)
		? coll.filterable_by
		: [coll.filterable_by];
	for (const f of filters) {
		if (typeof f === "string") {
			fieldMap.set(f, "z.string().optional()");
		}
	}
}

/** Add Zod field entries from classified field types. */
function addClassifiedFields(
	classified: ClassifiedPageType,
	fieldMap: Map<string, string>,
): void {
	for (const fc of classified.field_classifications) {
		// Skip fields already in the map (slug, listable_by, etc.)
		if (fieldMap.has(fc.field_path)) continue;

		// For dot-path children: only skip if parent has a real Zod expression
		// (not null/marker from object/repeater parents)
		if (fc.field_path.includes(".")) {
			const topLevel = fc.field_path.split(".")[0];
			const parentExpr = fieldMap.get(topLevel);
			if (parentExpr && parentExpr !== REPEATER_MARKER) continue;
		}

		const zodExpr = fieldTypeToZod(fc);
		if (zodExpr) fieldMap.set(fc.field_path, zodExpr);
	}
}

/** Marker for repeater parents — renderZodNode wraps children in z.array(). */
const REPEATER_MARKER = "__repeater__";

/** Map a field classification to a Zod expression string. */
function fieldTypeToZod(fc: FieldClassification): string | null {
	switch (fc.type) {
		case "string":
		case "datetime":
		case "select":
			return "z.string().optional()";
		case "number":
			return "z.number().optional()";
		case "boolean":
			return "z.boolean().optional()";
		case "richtext":
			return "z.string().optional()"; // richtext HTML stored as string
		case "image":
			return "z.string().optional()"; // resolved URL
		case "object":
			return null; // children populate via dot-paths in buildNestedZodFields
		case "repeater":
			return REPEATER_MARKER; // children populate, renderZodNode wraps in z.array()
		case "relationship":
			return "z.string().optional()"; // reference ID
		default:
			return null;
	}
}

/**
 * Convert a flat map of dotted paths → zod expressions into
 * properly nested z.object() TypeScript code.
 *
 * Groups siblings under the same parent and handles arbitrary depth:
 *
 * "title" → z.string().optional()
 *   becomes: title: z.string().optional(),
 *
 * "seo.title" + "seo.description" → z.string().optional()
 *   becomes: seo: z.object({ title: ..., description: ... }).optional(),
 *
 * "seo.og.title" → z.string().optional()
 *   becomes: seo: z.object({ og: z.object({ title: ... }).optional() }).optional(),
 */
function buildNestedZodFields(fieldMap: Map<string, string>): string {
	const root = new Map<string, NestedZodNode>();

	for (const [dottedPath, zodExpr] of fieldMap) {
		insertZodNode(root, dottedPath.split("."), zodExpr);
	}

	const lines: string[] = [];
	for (const [key, node] of root) {
		lines.push(`\n\t\t\t${key}: ${renderZodNode(node)},`);
	}
	return lines.join("");
}

interface NestedZodNode {
	zodExpr?: string;
	children?: Map<string, NestedZodNode>;
}

function insertZodNode(
	siblings: Map<string, NestedZodNode>,
	parts: string[],
	zodExpr: string,
): void {
	const key = parts[0];
	let node = siblings.get(key);
	if (!node) {
		node = {};
		siblings.set(key, node);
	}
	if (parts.length === 1) {
		node.zodExpr = zodExpr;
	} else {
		if (!node.children) node.children = new Map();
		insertZodNode(node.children, parts.slice(1), zodExpr);
	}
}

function renderZodNode(node: NestedZodNode): string {
	if (node.children && node.children.size > 0) {
		const fields: string[] = [];
		for (const [key, child] of node.children) {
			fields.push(`${key}: ${renderZodNode(child)}`);
		}
		const objExpr = `z.object({ ${fields.join(", ")} })`;
		// Repeater parents: wrap typed object in z.array()
		if (node.zodExpr === REPEATER_MARKER) {
			return `z.array(${objExpr}).optional()`;
		}
		return `${objExpr}.optional()`;
	}
	// Repeater without children: fallback to generic passthrough
	if (node.zodExpr === REPEATER_MARKER) {
		return "z.array(z.object({}).passthrough()).optional()";
	}
	return node.zodExpr ?? "z.unknown()";
}

// ---------------------------------------------------------------------------
// generateRouteFiles
// ---------------------------------------------------------------------------

/**
 * Generate route files (src/pages/*.astro) from registry.
 * Dynamic routes (e.g., /blog/[slug]) create `[slug].astro`.
 * Static routes create corresponding .astro files.
 * All collection routes use `render(entry)` + `<Content />`.
 */
export function generateRouteFiles(
	registry: Registry,
	classifiedModel?: ClassifiedContentModel,
): Array<{ path: string; content: string }> {
	// Build set of singleton page types for route generation
	const singletonPageTypes = new Set<string>();
	if (classifiedModel) {
		for (const cpt of classifiedModel.page_types) {
			if (cpt.is_singleton) singletonPageTypes.add(cpt.pagetype);
		}
	}

	return [
		...generateStaticPageRoutes(registry, singletonPageTypes),
		...generateListingRoutes(registry),
		...generateCollectionItemRoutes(registry),
	];
}

function generateStaticPageRoutes(
	registry: Registry,
	singletonPageTypes?: Set<string>,
): Array<{ path: string; content: string }> {
	const files: Array<{ path: string; content: string }> = [];

	for (const sp of registry.static_pages) {
		const filePath = routeToFilePath(sp.route, sp.pagetype);
		const layout = sp.layout ?? getDefaultLayout(registry, sp.pagetype);
		const depth = filePath.split("/").length - 2;
		const isSingleton = singletonPageTypes?.has(sp.pagetype) ?? false;

		if (isSingleton) {
			// Singleton: query data collection and render with set:html
			const collName = sp.pagetype;
			files.push({
				path: filePath,
				content: `---
import Layout from "${"../".repeat(depth)}layouts/${layout}.astro";
import { getEntry } from "astro:content";

const entry = await getEntry("${collName}", "default");
---

<Layout pagetype="${sp.pagetype}">
  <article>
    {entry?.data.body ? <div set:html={entry.data.body} /> : <p>${sp.pagetype}</p>}
  </article>
</Layout>
`,
			});
		} else {
			// Non-singleton static page: stub content (will be filled by generate phase)
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
	}

	return files;
}

function generateListingRoutes(
	registry: Registry,
): Array<{ path: string; content: string }> {
	const files: Array<{ path: string; content: string }> = [];

	for (const [listingName, listing] of Object.entries(registry.listings)) {
		const filePath = routeToFilePath(listing.route, listingName);
		const layout = getDefaultLayout(registry, listingName);
		const depth = filePath.split("/").length - 2;
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

		// Always generate pagination routes — UI hides controls when totalPages === 1
		files.push(
			...generatePaginationRoute(listingName, listing, layout, collName),
		);
	}

	return files;
}

function generatePaginationRoute(
	listingName: string,
	listing: Registry["listings"][string],
	layout: string,
	collName: string | undefined,
): Array<{ path: string; content: string }> {
	const baseRoute = listing.route.replace(/\/$/, "");
	const paginationRoute = `${baseRoute}/page/[page]`;
	const pagFilePath = routeToFilePath(paginationRoute, listingName);
	const pagDepth = pagFilePath.split("/").length - 2;

	if (collName) {
		return [
			{
				path: pagFilePath,
				content: `---
import Layout from "${"../".repeat(pagDepth)}layouts/${layout}.astro";
import { getCollection } from "astro:content";

export async function getStaticPaths() {
  const entries = await getCollection("${collName}");
  const pageSize = 10;
  const totalPages = Math.ceil(entries.length / pageSize);
  return Array.from({ length: totalPages }, (_, i) => ({
    params: { page: String(i + 1) },
    props: { page: i + 1, entries: entries.slice(i * pageSize, (i + 1) * pageSize) },
  }));
}

const { page, entries: pageEntries } = Astro.props;
---

<Layout pagetype="${listingName}">
  <section>
    <ul>
      {pageEntries.map((entry) => (
        <li><a href={\`${baseRoute}/\${entry.id}\`}>{entry.id}</a></li>
      ))}
    </ul>
    <nav>Page {page}</nav>
  </section>
</Layout>
`,
			},
		];
	}

	return [
		{
			path: pagFilePath,
			content: `---
import Layout from "${"../".repeat(pagDepth)}layouts/${layout}.astro";

export async function getStaticPaths() {
  return [{ params: { page: "1" } }];
}
---

<Layout pagetype="${listingName}">
  <section>
    <p>Listing: ${listingName} (page)</p>
  </section>
</Layout>
`,
		},
	];
}

function findListingForCollection(
	collName: string,
	coll: Registry["collections"][string],
	registry: Registry,
): Registry["listings"][string] | undefined {
	const entry = Object.entries(registry.listings).find(([listingName, l]) => {
		const explicitMatch = l.queries.some((q) => q.collection === collName);
		const listableByMatch = coll.listable_by?.includes(listingName) ?? false;
		const queryMatch = l.queries.some(
			(q) =>
				(q as Record<string, unknown>).pagetype ===
				(coll as Record<string, unknown>).source_pagetype,
		);
		return explicitMatch || listableByMatch || queryMatch;
	});
	return entry?.[1];
}

function generateCollectionItemRoutes(
	registry: Registry,
): Array<{ path: string; content: string }> {
	const files: Array<{ path: string; content: string }> = [];

	for (const [collName, coll] of Object.entries(registry.collections)) {
		const matchedListing = findListingForCollection(collName, coll, registry);
		const routeBase = matchedListing ? matchedListing.route : `/${collName}`;

		const routeSegments = routeBase.split("/").filter(Boolean);
		const lastSeg = routeSegments[routeSegments.length - 1];
		const param = lastSeg.startsWith("[") ? lastSeg.slice(1, -1) : "slug";
		const dirPath =
			routeSegments.length > 0 ? `${routeSegments.join("/")}/` : "";
		const filePath = `src/pages/${dirPath}[${param}].astro`;
		const depth = filePath.split("/").length - 2;

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
		// Skip non-page entries (config files, content.config.ts, etc.)
		if (
			!entry.path.startsWith("src/content/") &&
			!entry.path.startsWith("src/pages/") &&
			!entry.path.startsWith("/")
		)
			continue;

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

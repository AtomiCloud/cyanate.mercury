/**
 * Pure: content model classification types and richtext composition engine.
 *
 * All functions are pure (data in -> HTML/errors out). No IO.
 *
 * The composition engine walks nested JSON according to a declarative ComposeNode
 * tree spec (produced by LLM classification) and emits HTML. This turns structured
 * scraper output like article_content.sections[].subsections[] into proper HTML
 * with headings, paragraphs, lists, and images.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Render targets for ComposeNode — maps to HTML elements. */
export type RenderAs =
	| "p"
	| "h1"
	| "h2"
	| "h3"
	| "h4"
	| "img"
	| "a"
	| "li"
	| "ul"
	| "ol"
	| "blockquote"
	| "div"
	| "section"
	| "span"
	| "raw";

/**
 * Declarative tree spec for walking nested JSON and emitting HTML.
 *
 * Each node reads a field from the current JSON object, renders it as an
 * HTML element, and optionally recurses into children. Arrays are handled
 * via `is_array: true` — the engine iterates and applies children to each item.
 */
export interface ComposeNode {
	/** JSON field name to read from the current object */
	field: string;
	/** HTML element to emit for this field's value */
	render_as: RenderAs;
	/** If true, the field value is an array — iterate and apply children to each item */
	is_array?: boolean;
	/** Child nodes — walk deeper into the JSON structure */
	children?: ComposeNode[];
}

/** Field type classification — matches CMS adapter types from template/astro-project/cms/adapter.ts. */
export type FieldType =
	| "string"
	| "number"
	| "boolean"
	| "datetime"
	| "richtext"
	| "image"
	| "select"
	| "relationship"
	| "repeater"
	| "object";

/** Per-field classification within a page type. */
export interface FieldClassification {
	/** Dot-separated path from page content root (e.g., "article_content.sections") */
	field_path: string;
	/** Classified field type */
	type: FieldType;
	/** Composition spec — only present for richtext fields */
	compose_spec?: ComposeNode;
	/** Target collection name — only present for relationship fields */
	target_collection?: string;
}

/** Classified content model for a single page type. */
export interface ClassifiedPageType {
	pagetype: string;
	field_classifications: FieldClassification[];
	/** True for single-instance pages (landing, about, contact) */
	is_singleton: boolean;
	/** Main richtext composition spec — produces the page body HTML */
	body_compose?: ComposeNode;
}

/** Full classified content model output. */
export interface ClassifiedContentModel {
	page_types: ClassifiedPageType[];
}

// ---------------------------------------------------------------------------
// Dot-path traversal
// ---------------------------------------------------------------------------

/**
 * Traverse a nested object using a dot-separated path.
 * e.g., getNestedValue(obj, "article_content.sections") walks obj.article_content.sections.
 */
export function getNestedValue(
	obj: Record<string, unknown>,
	path: string,
): unknown {
	const keys = path.split(".");
	let current: unknown = obj;
	for (const key of keys) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

// ---------------------------------------------------------------------------
// Image URL resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an image URL from a value that may be:
 * - A bare string URL
 * - An object with `src` field
 * - An object with `url` field
 * - An object with `image` field
 *
 * Optionally rewrites to local path via asset manifest.
 */
export function resolveImageUrl(
	value: unknown,
	assetManifest?: Record<string, string>,
): string {
	let url = "";

	if (typeof value === "string") {
		url = value;
	} else if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		if (typeof obj.src === "string") url = obj.src;
		else if (typeof obj.url === "string") url = obj.url;
		else if (typeof obj.image === "string") url = obj.image;
	}

	if (!url) return "";

	// Rewrite via asset manifest if available
	if (assetManifest) {
		const local = assetManifest[url];
		if (local) return `/images/${local}`;
	}

	return url;
}

// ---------------------------------------------------------------------------
// Node rendering
// ---------------------------------------------------------------------------

/** Void elements that must not have closing tags. */
const VOID_ELEMENTS = new Set(["img"]);

/** List item containers — `li` nodes are wrapped in these. */
const LIST_CONTAINERS: Record<string, string> = {
	li: "ul",
};

/**
 * Render a single ComposeNode against a data value.
 *
 * - Container nodes (div, section) with children: recurse into children
 * - Leaf text nodes (p, h1-h4, span, blockquote): emit element with text content
 * - Image nodes: resolve URL and emit `<img>`
 * - Link nodes: emit `<a>` with href and text
 * - Raw nodes: emit value as-is (for pre-existing HTML)
 * - Array handling: if is_array, iterate items and render each
 */
export function renderNode(
	value: unknown,
	node: ComposeNode,
	assetManifest?: Record<string, string>,
): string {
	if (value === null || value === undefined) return "";

	if (node.is_array) {
		return Array.isArray(value)
			? renderArrayItems(value, node, assetManifest)
			: "";
	}

	if (node.render_as === "raw") {
		return typeof value === "string" ? value : "";
	}
	if (node.render_as === "img") {
		return renderImageNode(value, assetManifest);
	}
	if (node.render_as === "a") {
		return renderLinkNode(value);
	}
	if (node.children && node.children.length > 0) {
		return renderContainer(value, node, assetManifest);
	}

	return renderLeafNode(value, node.render_as);
}

/** Render an image node: resolve URL and emit `<img>`. */
function renderImageNode(
	value: unknown,
	assetManifest?: Record<string, string>,
): string {
	const src = resolveImageUrl(value, assetManifest);
	if (!src) return "";
	const alt =
		value && typeof value === "object"
			? (((value as Record<string, unknown>).alt as string) ?? "")
			: "";
	return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" />`;
}

/** Render a link node: emit `<a>` with href and text. */
function renderLinkNode(value: unknown): string {
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const href = extractStringField(obj, ["href", "url"]) ?? "#";
		const text = extractStringField(obj, ["label", "text"]) ?? href;
		return `<a href="${escapeAttr(href)}">${escapeHtml(text)}</a>`;
	}
	if (typeof value === "string") {
		return `<a href="${escapeAttr(value)}">${escapeHtml(value)}</a>`;
	}
	return "";
}

/** Extract the first string value found from a list of candidate keys. */
function extractStringField(
	obj: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		if (typeof obj[key] === "string") return obj[key] as string;
	}
	return undefined;
}

/** Render a leaf text/number/boolean node. */
function renderLeafNode(value: unknown, tag: string): string {
	if (typeof value === "string") {
		return `<${tag}>${escapeHtml(value)}</${tag}>`;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return `<${tag}>${String(value)}</${tag}>`;
	}
	return "";
}

/** Render array items, wrapping li elements in a list container. */
function renderArrayItems(
	items: unknown[],
	node: ComposeNode,
	assetManifest?: Record<string, string>,
): string {
	const childNode: ComposeNode = {
		...node,
		is_array: undefined,
	};

	const rendered = items
		.map((item) => renderNode(item, childNode, assetManifest))
		.filter(Boolean);

	if (rendered.length === 0) return "";

	// Wrap list items in a container
	const container = LIST_CONTAINERS[node.render_as];
	if (container) {
		return `<${container}>\n${rendered.join("\n")}\n</${container}>`;
	}

	return rendered.join("\n");
}

/** Render a container node with children. */
function renderContainer(
	value: unknown,
	node: ComposeNode,
	assetManifest?: Record<string, string>,
): string {
	if (!value || typeof value !== "object") return "";

	const obj = value as Record<string, unknown>;
	const inner = (node.children ?? [])
		.map((child) => {
			const childValue = obj[child.field];
			if (childValue === undefined || childValue === null) return "";
			return renderNode(childValue, child, assetManifest);
		})
		.filter(Boolean)
		.join("\n");

	if (!inner) return "";

	if (VOID_ELEMENTS.has(node.render_as)) return inner;

	return `<${node.render_as}>\n${inner}\n</${node.render_as}>`;
}

// ---------------------------------------------------------------------------
// Richtext composition
// ---------------------------------------------------------------------------

/**
 * Compose richtext HTML from nested JSON data using a ComposeNode spec.
 *
 * This is the main entry point. Reads the top-level field from data,
 * then recursively renders the tree.
 */
export function composeRichtext(
	data: unknown,
	spec: ComposeNode,
	assetManifest?: Record<string, string>,
): string {
	if (!data || typeof data !== "object") return "";

	const obj = data as Record<string, unknown>;
	const fieldValue = spec.field.includes(".")
		? getNestedValue(obj, spec.field)
		: obj[spec.field];

	if (fieldValue === undefined || fieldValue === null) return "";

	return renderNode(fieldValue, spec, assetManifest);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a classified content model against known page types.
 *
 * Checks:
 * - Every known page type has a classification
 * - Every richtext field has a compose_spec
 * - Every relationship field has a target_collection
 */
export function validateContentModelClassification(
	classified: ClassifiedContentModel,
	knownPageTypes: string[],
): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	const classifiedTypes = new Set(classified.page_types.map((c) => c.pagetype));

	// Every known page type should be classified
	for (const pt of knownPageTypes) {
		if (!classifiedTypes.has(pt)) {
			errors.push(`Page type "${pt}" is not classified`);
		}
	}

	// Validate field classifications
	for (const cpt of classified.page_types) {
		for (const fc of cpt.field_classifications) {
			if (fc.type === "richtext" && !fc.compose_spec) {
				errors.push(
					`Page type "${cpt.pagetype}" field "${fc.field_path}" is richtext but has no compose_spec`,
				);
			}
			if (fc.type === "relationship" && !fc.target_collection) {
				errors.push(
					`Page type "${cpt.pagetype}" field "${fc.field_path}" is relationship but has no target_collection`,
				);
			}
		}
	}

	return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Content completeness validation
// ---------------------------------------------------------------------------

/** Minimum string length to consider as meaningful content for validation. */
const MIN_LEAF_LENGTH = 3;

/** A leaf string value paired with its source path in the JSON tree. */
export interface LeafWithPath {
	value: string;
	path: string;
}

/**
 * Recursively extract all leaf string values from nested JSON.
 * Skips fields in `excludePaths` (dot-separated from root).
 * Returns deduplicated, trimmed strings that are at least MIN_LEAF_LENGTH chars.
 */
export function extractLeafStrings(
	data: unknown,
	excludePaths?: string[],
): string[] {
	const results: string[] = [];
	const excludeSet = new Set(excludePaths ?? []);
	walkLeaves(data, "", excludeSet, results);
	return [...new Set(results)];
}

/**
 * Extract leaf strings WITH their source paths for actionable error reporting.
 */
export function extractLeafStringsWithPaths(
	data: unknown,
	excludePaths?: string[],
): LeafWithPath[] {
	const results: LeafWithPath[] = [];
	const excludeSet = new Set(excludePaths ?? []);
	walkLeavesWithPaths(data, "", excludeSet, results);
	// Deduplicate by value, keeping first occurrence
	const seen = new Set<string>();
	return results.filter((r) => {
		if (seen.has(r.value)) return false;
		seen.add(r.value);
		return true;
	});
}

/** Walk nested data, collecting leaf values with paths. */
function walkLeavesWithPaths(
	value: unknown,
	currentPath: string,
	excludeSet: Set<string>,
	results: LeafWithPath[],
): void {
	if (excludeSet.has(currentPath)) return;

	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length >= MIN_LEAF_LENGTH)
			results.push({ value: trimmed, path: currentPath });
		return;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		results.push({ value: String(value), path: currentPath });
		return;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			walkLeavesWithPaths(
				value[i],
				`${currentPath}[${i}]`,
				excludeSet,
				results,
			);
		}
		return;
	}
	if (value && typeof value === "object") {
		for (const [key, val] of Object.entries(
			value as Record<string, unknown>,
		)) {
			const childPath = currentPath ? `${currentPath}.${key}` : key;
			walkLeavesWithPaths(val, childPath, excludeSet, results);
		}
	}
}

/** Walk nested data, collecting leaf string/number/boolean values. */
function walkLeaves(
	value: unknown,
	currentPath: string,
	excludeSet: Set<string>,
	results: string[],
): void {
	if (excludeSet.has(currentPath)) return;

	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length >= MIN_LEAF_LENGTH) results.push(trimmed);
		return;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		results.push(String(value));
		return;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			walkLeaves(value[i], `${currentPath}[${i}]`, excludeSet, results);
		}
		return;
	}
	if (value && typeof value === "object") {
		walkObjectLeaves(
			value as Record<string, unknown>,
			currentPath,
			excludeSet,
			results,
		);
	}
}

/** Walk object entries, building dot-separated paths. */
function walkObjectLeaves(
	obj: Record<string, unknown>,
	currentPath: string,
	excludeSet: Set<string>,
	results: string[],
): void {
	for (const [key, val] of Object.entries(obj)) {
		const childPath = currentPath ? `${currentPath}.${key}` : key;
		walkLeaves(val, childPath, excludeSet, results);
	}
}

/**
 * Strip HTML tags and decode common HTML entities.
 * Returns plain text suitable for content comparison.
 */
export function stripHtmlTags(html: string): string {
	return html
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Verify that all meaningful text from original content appears in the CMS JSON output.
 *
 * Extracts leaf strings from both original and CMS JSON, then checks
 * what fraction of original strings appear in the CMS output (either as
 * direct scalar values or embedded within richtext HTML strings).
 *
 * Pass threshold: 90% coverage.
 */
export interface ContentCompletenessResult {
	pass: boolean;
	coverage: number;
	missing: string[];
	/** Missing items grouped by top-level field path for actionable rejection context. */
	missingBySection: Record<string, string[]>;
}

export function verifyContentCompleteness(
	original: Record<string, unknown>,
	cmsJson: Record<string, unknown>,
	excludePaths: string[],
	manifestUrls?: Set<string>,
): ContentCompletenessResult {
	const originalLeaves = extractLeafStringsWithPaths(original, excludePaths);
	if (originalLeaves.length === 0) {
		return { pass: true, coverage: 1, missing: [], missingBySection: {} };
	}

	// Collect all text from CMS JSON — both direct values and text within HTML
	const cmsStrings = extractLeafStrings(cmsJson);
	const cmsPlainText = cmsStrings.map((s) =>
		s.includes("<") ? stripHtmlTags(s) : s,
	);
	const cmsTextBlob = cmsPlainText.join(" ");

	const missing: string[] = [];
	const missingBySection: Record<string, string[]> = {};
	let found = 0;

	for (const leaf of originalLeaves) {
		const normalizedOrig = leaf.value.replace(/\s+/g, " ").trim();
		if (normalizedOrig.length < MIN_LEAF_LENGTH) {
			found++;
			continue;
		}

		// Skip asset-manifest-managed image URLs (rewritten during seed transform)
		if (manifestUrls?.has(normalizedOrig)) {
			found++;
			continue;
		}

		// Check direct match in any CMS string
		const directMatch = cmsStrings.some((s) => s.includes(normalizedOrig));
		if (directMatch) {
			found++;
			continue;
		}

		// Check within stripped HTML text
		if (cmsTextBlob.includes(normalizedOrig)) {
			found++;
			continue;
		}

		missing.push(normalizedOrig);
		// Group by top-level section (first segment of the path)
		const section = leaf.path.split(".")[0].split("[")[0] || "(root)";
		if (!missingBySection[section]) missingBySection[section] = [];
		missingBySection[section].push(
			`${leaf.path}: ${normalizedOrig.slice(0, 60)}${normalizedOrig.length > 60 ? "..." : ""}`,
		);
	}

	const coverage = found / originalLeaves.length;
	return {
		pass: coverage >= 0.9,
		coverage,
		missing,
		missingBySection,
	};
}

// ---------------------------------------------------------------------------
// HTML escaping helpers
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

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

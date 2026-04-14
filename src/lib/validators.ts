/**
 * Zod output validators — schemas for all output contracts plus domain-specific validators.
 *
 * All validation functions are pure (data in → errors out). No IO.
 */

import { parse as culoriParse } from "culori";
import { z } from "zod";
import type { DesignTokensV2, PageContent } from "../types.js";

// ---------------------------------------------------------------------------
// Zod helpers
// ---------------------------------------------------------------------------

/** A string record that must contain at least one key. */
function nonEmptyStringRecord(
	valueSchema: z.ZodType<string, unknown>,
	fieldName = "record",
) {
	return z
		.record(z.string(), valueSchema)
		.refine((r) => Object.keys(r).length > 0, {
			message: `${fieldName} must be non-empty`,
		});
}

// ---------------------------------------------------------------------------
// Zod schemas for output contracts
// ---------------------------------------------------------------------------

/** Validates StyleFingerprint: 8 dimensions as numbers in [0,1], treatments as strings */
export const StyleFingerprintSchema = z.object({
	$schema: z.string(),
	style: z.object({
		primary: z.string(),
		secondary: z.array(z.string()),
		dimensions: z.object({
			ornament: z.number().min(0).max(1),
			playfulness: z.number().min(0).max(1),
			warmth: z.number().min(0).max(1),
			density: z.number().min(0).max(1),
			motion: z.number().min(0).max(1),
			depth: z.number().min(0).max(1),
			darkness: z.number().min(0).max(1),
			formality: z.number().min(0).max(1),
		}),
		treatments: z.object({
			surface: z.string(),
			corners: z.string(),
			shadows: z.string(),
			borders: z.string(),
			gradients: z.string(),
			blur: z.boolean(),
			transparency: z.boolean(),
			animation_style: z.string(),
		}),
	}),
	confidence: z.number().min(0).max(1),
});

/** Validates DesignTokensV2: 7 layers non-empty */
export const DesignTokensV2Schema = z.object({
	atomic: z.object({
		colors: nonEmptyStringRecord(z.string(), "atomic.colors"),
		typography: z.object({
			fontFamily: nonEmptyStringRecord(
				z.string(),
				"atomic.typography.fontFamily",
			),
			fontSize: nonEmptyStringRecord(z.string(), "atomic.typography.fontSize"),
			fontWeight: z.record(z.string(), z.number()),
		}),
		spacing: nonEmptyStringRecord(z.string(), "atomic.spacing"),
		borderRadius: z.record(z.string(), z.string()),
		shadows: z.record(z.string(), z.string()),
	}),
	gradients: z.record(
		z.string(),
		z.object({
			type: z.string(),
			angle: z.string().optional(),
			stops: z.array(
				z.object({
					color: z.string(),
					position: z.string().optional(),
				}),
			),
		}),
	),
	layout: z.object({
		grid: z.object({
			columns: z.record(z.string(), z.string()),
			gutter: z.record(z.string(), z.string()),
		}),
		container: z.object({
			maxWidth: z.record(z.string(), z.string()),
		}),
		breakpoints: z.record(z.string(), z.string()),
		sections: z.record(
			z.string(),
			z.object({ top: z.string(), bottom: z.string() }),
		),
		density: z.object({ mode: z.string() }),
		rhythm: z.object({
			baseUnit: z.string(),
			verticalRhythm: z.record(z.string(), z.string()),
		}),
	}),
	componentSpacing: z.record(z.string(), z.record(z.string(), z.string())),
	motion: z.object({
		duration: z.record(z.string(), z.string()),
		easing: z.record(z.string(), z.string()),
		state: z.object({
			hover: z.record(z.string(), z.unknown()),
			focus: z.record(z.string(), z.unknown()),
			active: z.record(z.string(), z.unknown()),
			disabled: z.record(z.string(), z.unknown()),
		}),
		scroll: z.record(z.string(), z.unknown()),
		skeleton: z.record(z.string(), z.unknown()),
	}),
	surfaces: z.object({
		glass: z.record(z.string(), z.record(z.string(), z.unknown())),
		texture: z.record(z.string(), z.record(z.string(), z.unknown())),
		imageTreatment: z.record(z.string(), z.record(z.string(), z.unknown())),
	}),
	visualIdentity: z.object({
		colorDistribution: z.object({
			dominant: z.record(z.string(), z.unknown()),
			secondary: z.record(z.string(), z.unknown()),
			accent: z.record(z.string(), z.unknown()),
		}),
		borders: z.record(z.string(), z.record(z.string(), z.unknown())),
	}),
});

/** Validates ComponentRecipes: each recipe has base + variants */
export const ComponentRecipesSchema = z.record(
	z.string(),
	z.object({
		base: z.record(z.string(), z.unknown()),
		variants: z.record(z.string(), z.record(z.string(), z.unknown())),
		states: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
	}),
);

/** Validates Registry: collections, listings, static_pages */
export const RegistrySchema = z.object({
	layouts: z.record(
		z.string(),
		z.object({
			description: z.string(),
			page_types: z.array(z.string()),
		}),
	),
	collections: z.record(
		z.string(),
		z.object({
			source_pagetype: z.string(),
			slug_field: z.string(),
			listable_by: z.array(z.string()),
			filterable_by: z
				.union([
					z.string(),
					z.array(z.string()),
					z.array(z.record(z.string(), z.unknown())),
				])
				.optional(),
			search_fields: z.array(z.string()).optional(),
			slug_pattern: z.string().optional(),
			slug_extract: z.union([z.number(), z.string()]).optional(),
			ordered: z.boolean().optional(),
		}),
	),
	listings: z.record(
		z.string(),
		z.object({
			route: z.string(),
			queries: z.array(z.record(z.string(), z.unknown())),
			paginated: z.boolean(),
			searchable: z.boolean().optional(),
			search_fields: z.array(z.string()).optional(),
		}),
	),
	static_pages: z.array(
		z.object({
			pagetype: z.string(),
			route: z.string(),
			layout: z.string().optional(),
		}),
	),
	navigation: z.record(z.string(), z.unknown()).optional(),
	interactive_patterns: z
		.array(
			z.object({
				id: z.string(),
				type: z.enum([
					"fragment",
					"modal",
					"accordion",
					"tabs",
					"search",
					"filter",
					"form",
					"popup",
					"other",
				]),
				trigger: z.string().optional(),
				target: z.string().optional(),
				pageType: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
				route: z.string().optional(),
				description: z.string(),
			}),
		)
		.optional(),
});

/** Validates ReducedMeta: page_types array present */
export const ReducedMetaSchema = z.object({
	source: z.object({
		total_pages: z.number(),
		page_types: z.number(),
		scraped_at: z.string(),
		site_url: z.string(),
	}),
	global_keys: z.array(z.string()),
	page_types: z.array(
		z.object({
			pagetype: z.string(),
			route: z.string(),
			count: z.number(),
			multi: z.boolean(),
			has_pagination: z.boolean(),
			slug_param: z.string().optional(),
			schema_keys: z.array(z.string()),
			own_keys: z.array(z.string()),
		}),
	),
	pagination_candidates: z.array(
		z.object({
			pagetype: z.string(),
			evidence: z.string(),
		}),
	),
});

/** Validates QualityScores: 7 dimensions, overall in [0,10] */
export const QualityScoresSchema = z.object({
	overall: z.number().min(0).max(10),
	dimensions: z.object({
		layoutConsistency: z.number().min(0).max(10),
		designTokenUsage: z.number().min(0).max(10),
		componentComposition: z.number().min(0).max(10),
		responsiveDesign: z.number().min(0).max(10),
		semanticHtml: z.number().min(0).max(10),
		visualAppeal: z.number().min(0).max(10),
		motionQuality: z.number().min(0).max(10),
	}),
});

/** Validates content model structure */
export const ContentModelSchema = z.object({
	pages: z.array(
		z.object({
			id: z.string(),
			url: z.string(),
			pagetype: z.string(),
			content: z.record(z.string(), z.unknown()),
		}),
	),
});

/** Validates component manifest */
export const ComponentManifestSchema = z.record(
	z.string(),
	z.object({
		file: z.string(),
		props: z.record(z.string(), z.unknown()).optional(),
		slots: z.array(z.string()).optional(),
	}),
);

/** Validates asset manifest: file → source mapping */
export const AssetManifestSchema = z.record(z.string(), z.string());

// ---------------------------------------------------------------------------
// Domain-specific validators
// ---------------------------------------------------------------------------

/** Check whether a CSS color string is valid OKLCH using culori. */
function isValidOklch(value: string): boolean {
	const parsed = culoriParse(value);
	return parsed != null && parsed.mode === "oklch";
}

/**
 * Check spacing scale has >= 4 steps.
 */
export function validateSpacingScale(tokens: DesignTokensV2): string[] {
	const errors: string[] = [];
	const spacingKeys = Object.keys(tokens.atomic.spacing);
	if (spacingKeys.length < 4) {
		errors.push(
			`Spacing scale has only ${spacingKeys.length} steps, expected at least 4.`,
		);
	}
	return errors;
}

/**
 * Check typography has >= 3 font sizes.
 */
export function validateTypographyScale(tokens: DesignTokensV2): string[] {
	const errors: string[] = [];
	const sizeKeys = Object.keys(tokens.atomic.typography.fontSize);
	if (sizeKeys.length < 3) {
		errors.push(
			`Typography has only ${sizeKeys.length} font sizes, expected at least 3.`,
		);
	}
	return errors;
}

/**
 * Check that all color values are valid OKLCH strings.
 * Rejects non-OKLCH values like hex, rgb, hsl, etc.
 */
export function validateOklchValues(tokens: DesignTokensV2): string[] {
	const errors: string[] = [];
	const colors = tokens.atomic.colors;

	for (const [name, value] of Object.entries(colors)) {
		if (isValidOklch(value)) continue;

		if (value.toLowerCase().startsWith("oklch")) {
			errors.push(`Color "${name}" has invalid OKLCH value: ${value}`);
		} else {
			errors.push(`Color "${name}" must be OKLCH, got "${value}"`);
		}
	}

	return errors;
}

/**
 * Convert a route pattern like "/blog/[slug]" into a regex.
 * "/blog/[slug]" → /^\/blog\/[^/]+$/
 * "/blog/[...slug]" → /^\/blog\/.*$/
 * "/" → /^\/$/
 */
function routePatternToRegex(pattern: string): RegExp | null {
	const segments = pattern.split("/").filter(Boolean);
	const parts: string[] = [];
	for (const seg of segments) {
		if (seg.startsWith("[") && seg.endsWith("]")) {
			const inner = seg.slice(1, -1);
			if (inner.startsWith("...")) {
				// Rest parameter — matches everything including /
				parts.push(".*");
			} else {
				// Dynamic segment — matches one path segment
				parts.push("[^/]+");
			}
		} else {
			parts.push(seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
		}
	}
	if (pattern === "/") return /^\/$/;
	return new RegExp(`^/${parts.join("/")}$`);
}

/**
 * Normalize a pathname by stripping trailing slash (except root "/").
 * Astro treats /about and /about/ equivalently, so the validator must too.
 */
function normalizePath(path: string): string {
	if (path === "/") return path;
	return path.endsWith("/") ? path.slice(0, -1) : path;
}

export function validateContentCoverage(
	sourcePages: PageContent[],
	generatedRoutes: string[],
): { covered: string[]; missing: string[] } {
	const covered: string[] = [];
	const missing: string[] = [];

	for (const page of sourcePages) {
		const pagePath = normalizePath(new URL(page.url).pathname);
		const matched = generatedRoutes.some((route) => {
			// Exact match (both normalized)
			if (normalizePath(route) === pagePath) return true;
			// Dynamic pattern match
			if (route.includes("[")) {
				const regex = routePatternToRegex(route);
				if (regex?.test(pagePath)) return true;
			}
			return false;
		});
		if (matched) {
			covered.push(page.url);
		} else {
			missing.push(page.url);
		}
	}

	return { covered, missing };
}

/**
 * Check asset integrity: every manifest entry has a file that exists.
 * Files are stored under public/images/, but manifest values are bare names.
 * Check both bare name and images/ prefixed variants.
 */
export function validateAssetIntegrity(
	manifest: Record<string, string>,
	existingFiles: string[],
): { valid: string[]; missing: string[] } {
	const fileSet = new Set(existingFiles);
	const valid: string[] = [];
	const missing: string[] = [];

	for (const [asset, source] of Object.entries(manifest)) {
		// Manifest value may be bare ("abc123.png") or already prefixed ("images/abc123.png")
		// existingFiles paths are relative to public/, always prefixed ("images/abc123.png")
		const hasSource =
			fileSet.has(source) ||
			fileSet.has(asset) ||
			fileSet.has(`images/${source}`) ||
			fileSet.has(`images/${asset}`);
		if (hasSource) {
			valid.push(asset);
		} else {
			missing.push(asset);
		}
	}

	return { valid, missing };
}

/** Check if a line is a comment and should be skipped. */
function isCommentLine(line: string): boolean {
	const trimmed = line.trim();
	return (
		trimmed.startsWith("//") ||
		trimmed.startsWith("*") ||
		trimmed.startsWith("#") ||
		trimmed.startsWith("<!--")
	);
}

/** Check a single line for leaked absolute URLs. */
function checkLineForLeakedUrl(
	line: string,
	file: string,
	lineNum: number,
	origin: string,
	urlRegex: RegExp,
): Array<{ file: string; line: number; url: string }> {
	if (!line.includes(origin)) return [];
	if (isCommentLine(line)) return [];
	const urlMatch = line.match(urlRegex);
	if (!urlMatch) return [];
	return [{ file, line: lineNum + 1, url: urlMatch[0] }];
}

/**
 * Check no absolute URLs from the original site leak into generated files.
 */
export function findLeakedAbsoluteUrls(
	fileContents: Record<string, string>,
	originalSiteUrl: string,
): Array<{ file: string; line: number; url: string }> {
	const origin = (() => {
		try {
			return new URL(originalSiteUrl).origin;
		} catch {
			return originalSiteUrl;
		}
	})();

	const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const urlRegex = new RegExp(`${escaped}[^"'\\s\\)]*`);

	const leaks: Array<{ file: string; line: number; url: string }> = [];
	for (const [file, content] of Object.entries(fileContents)) {
		const lines = content.split("\n");
		for (let lineNum = 0; lineNum < lines.length; lineNum++) {
			leaks.push(
				...checkLineForLeakedUrl(
					lines[lineNum],
					file,
					lineNum,
					origin,
					urlRegex,
				),
			);
		}
	}

	return leaks;
}

/** Check if a file is a component file (as opposed to CSS, config, etc). */
function isComponentFile(file: string): boolean {
	return (
		file.endsWith(".astro") || file.endsWith(".tsx") || file.endsWith(".jsx")
	);
}

/**
 * Known Tailwind utility category prefixes.
 * A class that starts with one of these prefixes (after stripping variant
 * prefixes) and matches the expected format is considered a Tailwind utility.
 * This is the definitive list — classes not starting with these are not flagged.
 */
const TW_PREFIXES = new Set([
	// Layout
	"block",
	"inline",
	"flex",
	"grid",
	"table",
	"static",
	"relative",
	"absolute",
	"fixed",
	"sticky",
	"float",
	"clear",
	"isolate",
	"isolation",
	"container",
	"columns",
	"break",
	"box",
	"z-",
	"order",
	// Flexbox
	"flex",
	"flex-",
	"shrink",
	"grow",
	"basis",
	"items",
	"justify",
	"self",
	// Grid
	"grid",
	"col",
	"row",
	"auto",
	"place",
	// Spacing
	"p",
	"px",
	"py",
	"pt",
	"pr",
	"pb",
	"pl",
	"ps",
	"pe",
	"m",
	"mx",
	"my",
	"mt",
	"mr",
	"mb",
	"ml",
	"ms",
	"me",
	"space",
	"gap",
	// Sizing
	"w",
	"h",
	"min-w",
	"min-h",
	"max-w",
	"max-h",
	// Typography
	"text",
	"font",
	"leading",
	"tracking",
	"antialiased",
	"subpixel",
	"whitespace",
	"truncate",
	"normal",
	"uppercase",
	"lowercase",
	"capitalize",
	"italic",
	"not-italic",
	"underline",
	"line-through",
	"decoration",
	"indent",
	"list",
	"placeholder",
	// Backgrounds
	"bg",
	"bg-",
	"from",
	"via",
	"to",
	"bg-gradient",
	"bg-clip",
	"bg-origin",
	"bg-repeat",
	"bg-position",
	"bg-size",
	"bg-attachment",
	"bg-blend",
	// Borders
	"border",
	"rounded",
	"ring",
	"ring-offset",
	"outline",
	"divide",
	// Effects
	"shadow",
	"blur",
	"drop-shadow",
	"opacity",
	"mix-blend",
	// Filters
	"brightness",
	"contrast",
	"grayscale",
	"invert",
	"saturate",
	"sepia",
	"backdrop",
	"hue-rotate",
	"saturate",
	"filter",
	// Transitions
	"transition",
	"duration",
	"ease",
	"delay",
	// Animations
	"animate",
	"transform",
	"scale",
	"rotate",
	"translate",
	"skew",
	"origin",
	// Interactivity
	"appearance",
	"cursor",
	"pointer-events",
	"resize",
	"select",
	"user-select",
	"scroll",
	"snap",
	"touch",
	"overflow",
	// SVG
	"fill",
	"stroke",
	// Accessibility
	"sr",
	"not-sr",
	// Tables
	"border-collapse",
	"border-separate",
	"table",
	// Positioning
	"top",
	"right",
	"bottom",
	"left",
	"inset",
	// Accent
	"accent",
	"caret",
	"color-scheme",
	// Content
	"content",
	"aspect",
	"prose",
	// Misc
	"visible",
	"invisible",
	"hidden",
	"overflow",
	"overscroll",
]);

/** Normalize a Tailwind class by stripping modifiers and values. */
function normalizeTailwindClass(cls: string): string {
	let normalized = cls;
	if (normalized.startsWith("-")) normalized = normalized.slice(1);

	// Strip variant prefixes (colon-separated, e.g., "md:flex" → "flex")
	while (normalized.includes(":")) {
		normalized = normalized.slice(normalized.indexOf(":") + 1);
	}

	// Strip opacity modifier (e.g., "bg-red-500/50" → "bg-red-500")
	const slashIdx = normalized.indexOf("/");
	if (slashIdx > 0 && /^\d{1,3}$/.test(normalized.slice(slashIdx + 1))) {
		normalized = normalized.slice(0, slashIdx);
	}

	// Strip arbitrary value (e.g., "w-[100px]" → "w-")
	const arbIdx = normalized.indexOf("[");
	if (arbIdx > 0) normalized = normalized.slice(0, arbIdx);

	return normalized;
}

/** Standalone Tailwind utilities (no suffix required). */
const STANDALONE_TW = new Set([
	"flex",
	"inline-flex",
	"grid",
	"inline-grid",
	"block",
	"inline-block",
	"inline",
	"table",
	"table-cell",
	"table-row",
	"table-column",
	"table-caption",
	"contents",
	"flow-root",
	"hidden",
	"visible",
	"none",
	"static",
	"relative",
	"absolute",
	"fixed",
	"sticky",
	"underline",
	"line-through",
	"no-underline",
	"truncate",
	"uppercase",
	"lowercase",
	"capitalize",
	"normal-case",
	"italic",
	"not-italic",
	"antialiased",
	"subpixel-antialiased",
	"border",
	"sr-only",
	"not-sr-only",
	"isolate",
	"isolation-auto",
	"scroll-smooth",
	"scroll-auto",
	"border-collapse",
	"border-separate",
	"appearance-none",
	"auto",
]);

/** Known semantic class names that are not Tailwind utilities. */
const TW_EXCLUSIONS = new Set(["container", "content"]);

/** Check if a normalized (modifier-stripped) utility starts with a known Tailwind prefix. */
function matchesTwPrefix(normalized: string): boolean {
	if (TW_EXCLUSIONS.has(normalized)) return false;
	if (STANDALONE_TW.has(normalized)) return true;

	for (const prefix of TW_PREFIXES) {
		if (
			normalized === prefix ||
			normalized.startsWith(`${prefix}-`) ||
			(prefix.endsWith("-") && normalized.startsWith(prefix))
		) {
			return true;
		}
	}

	return false;
}

/**
 * Check if a string is a Tailwind utility class.
 * Uses a prefix-based approach: strips variant prefixes, then checks
 * if the remaining utility starts with a known Tailwind category.
 */
function isTailwindClass(cls: string): boolean {
	if (!cls || cls.length < 2) return false;
	const normalized = normalizeTailwindClass(cls);
	return matchesTwPrefix(normalized);
}

/**
 * Extract class attribute values from source, handling multiline attributes.
 * Returns values paired with their starting line number.
 */
function extractClassValuesByLine(
	source: string,
): Array<{ line: number; value: string }> {
	const results: Array<{ line: number; value: string }> = [];
	const lines = source.split("\n");
	let inClassAttr = false;
	let classAttrQuote = "";
	let classAttrStartLine = 0;
	let currentClassValue = "";

	for (let lineNum = 0; lineNum < lines.length; lineNum++) {
		const line = lines[lineNum];

		if (inClassAttr) {
			currentClassValue += line;
			const closeIdx = currentClassValue.indexOf(classAttrQuote, 1);
			if (closeIdx !== -1) {
				results.push({
					line: classAttrStartLine,
					value: currentClassValue.slice(1, closeIdx),
				});
				inClassAttr = false;
				currentClassValue = "";
			}
			continue;
		}

		const attrStart = line.match(/(?:class|className)\s*=\s*(['"`])/);
		if (attrStart) {
			const quote = attrStart[1];
			const attrStr = line.slice(
				line.indexOf(attrStart[0]) + attrStart[0].length - 1,
			);
			const closeIdx = attrStr.indexOf(quote, 1);
			if (closeIdx !== -1) {
				results.push({ line: lineNum, value: attrStr.slice(1, closeIdx) });
			} else {
				inClassAttr = true;
				classAttrQuote = quote;
				classAttrStartLine = lineNum;
				currentClassValue = attrStr;
			}
		}
	}

	return results;
}

/** Filter and deduplicate Tailwind classes from a raw class string. */
function extractTailwindClasses(raw: string): string[] {
	const classes = raw.split(/\s+/).filter(Boolean).filter(isTailwindClass);
	return [...new Set(classes)];
}

/**
 * Check no Tailwind utility classes in component files.
 * Scans all component files (.astro, .tsx, .jsx) for class/className attributes.
 * Uses comprehensive prefix-based pattern matching with an allowlist of known
 * false positives. Handles multiline attributes and arbitrary values.
 */
export function findTailwindClasses(
	fileContents: Record<string, string>,
): Array<{ file: string; line: number; classes: string[] }> {
	const results: Array<{ file: string; line: number; classes: string[] }> = [];

	for (const [file, content] of Object.entries(fileContents)) {
		if (!isComponentFile(file)) continue;

		const entries = extractClassValuesByLine(content);
		for (const entry of entries) {
			const classes = extractTailwindClasses(entry.value);
			if (classes.length > 0) {
				results.push({ file, line: entry.line + 1, classes });
			}
		}
	}

	return results;
}

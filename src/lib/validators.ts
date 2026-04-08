/**
 * Zod output validators — schemas for all output contracts plus domain-specific validators.
 *
 * All validation functions are pure (data in → errors out). No IO.
 */

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
				pageType: z.string().optional(),
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

/** OKLCH regex pattern */
const OKLCH_REGEX = /^oklch\s*\(\s*[\d.]+\s+[\d.]+\s+[\d.]+/i;

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
		if (value.toLowerCase().startsWith("oklch")) {
			// Validate OKLCH format
			if (!OKLCH_REGEX.test(value)) {
				errors.push(`Color "${name}" has invalid OKLCH value: ${value}`);
			}
		} else {
			// Non-OKLCH values (hex, rgb, hsl, etc.) are not allowed
			errors.push(`Color "${name}" must be OKLCH, got "${value}"`);
		}
	}

	return errors;
}

/**
 * Check content coverage: every source page has a route in generated output.
 */
export function validateContentCoverage(
	sourcePages: PageContent[],
	generatedRoutes: string[],
): { covered: string[]; missing: string[] } {
	const routeSet = new Set(generatedRoutes);
	const covered: string[] = [];
	const missing: string[] = [];

	for (const page of sourcePages) {
		// Try to find a matching route for this page
		const pagePath = new URL(page.url).pathname;
		if (routeSet.has(pagePath)) {
			covered.push(page.url);
		} else {
			missing.push(page.url);
		}
	}

	return { covered, missing };
}

/**
 * Check asset integrity: every manifest entry has a file that exists.
 */
export function validateAssetIntegrity(
	manifest: Record<string, string>,
	existingFiles: string[],
): { valid: string[]; missing: string[] } {
	const fileSet = new Set(existingFiles);
	const valid: string[] = [];
	const missing: string[] = [];

	for (const [asset, source] of Object.entries(manifest)) {
		if (fileSet.has(asset) || fileSet.has(source)) {
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

/** Scan a single line for Tailwind class patterns. */
function scanLineForTailwindClasses(
	line: string,
	patterns: RegExp[],
): string[] {
	if (!line.includes("class=") && !line.includes("className=")) {
		return [];
	}
	const found: string[] = [];
	for (const pattern of patterns) {
		const matches = line.match(pattern);
		if (matches) found.push(...matches);
	}
	return [...new Set(found)];
}

/**
 * Check no Tailwind utility classes in component files.
 * Looks for common Tailwind class patterns in class attributes.
 */
export function findTailwindClasses(
	fileContents: Record<string, string>,
): Array<{ file: string; line: number; classes: string[] }> {
	const twPatterns = [
		/\b(flex|grid|block|inline|hidden|visible)\b/g,
		/\b(p-\d|px-\d|py-\d|pt-\d|pb-\d|pl-\d|pr-\d|m-\d|mx-\d|my-\d|mt-\d|mb-\d|ml-\d|mr-\d|space-[xy]-\d|gap-\d)/g,
		/\b(text-(sm|base|lg|xl|2xl|3xl|4xl|xs))\b/g,
		/\b(bg-(white|black|red|blue|green|yellow|gray|slate|zinc|neutral|stone)-\d{2,3})\b/g,
		/\b(rounded-(sm|md|lg|xl|2xl|full|none))\b/g,
		/\b(shadow-(sm|md|lg|xl|2xl|none))\b/g,
		/\b(w-\d|h-\d|min-w-|max-w-|min-h-|max-h-)\b/g,
		/\b(items-(center|start|end|stretch|baseline))\b/g,
		/\b(justify-(center|start|end|between|around|evenly))\b/g,
	];

	const results: Array<{ file: string; line: number; classes: string[] }> = [];

	for (const [file, content] of Object.entries(fileContents)) {
		if (!isComponentFile(file)) continue;

		const lines = content.split("\n");
		for (let lineNum = 0; lineNum < lines.length; lineNum++) {
			const classes = scanLineForTailwindClasses(lines[lineNum], twPatterns);
			if (classes.length > 0) {
				results.push({ file, line: lineNum + 1, classes });
			}
		}
	}

	return results;
}

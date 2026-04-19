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

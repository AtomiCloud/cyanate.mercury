import { describe, expect, it } from "bun:test";
import type { MeasurementData, PatternsManifest } from "./merge.js";
import {
	aggregateFingerprint,
	assembleDesignTokens,
	buildPatternsManifest,
	buildTypographyScale,
	clusterSpacing,
	deduplicateColors,
	deduplicateComponents,
} from "./merge.js";

// ---------------------------------------------------------------------------
// clusterSpacing
// ---------------------------------------------------------------------------

describe("clusterSpacing", () => {
	it("clusters raw px values to nearest scale anchor", () => {
		const measurements: MeasurementData[] = [
			{
				pageId: "1",
				pageType: "landing",
				spacing: [
					{ name: "xs", value: "4px" },
					{ name: "sm", value: "5px" },
					{ name: "md", value: "8px" },
					{ name: "lg", value: "15px" },
					{ name: "xl", value: "16px" },
					{ name: "2xl", value: "32px" },
				],
			},
		];

		const result = clusterSpacing(measurements);
		const values = Object.values(result);

		expect(values).toContain("4px");
		expect(values).toContain("8px");
		expect(values).toContain("16px");
		expect(values).toContain("32px");
		// 5px snaps to 4px, 15px snaps to 16px
		expect(result.sm).toBe("4px");
		expect(result.lg).toBe("16px");
	});

	it("returns empty record for no measurements", () => {
		expect(clusterSpacing([])).toEqual({});
	});

	it("ignores non-px values", () => {
		const measurements: MeasurementData[] = [
			{
				pageId: "1",
				pageType: "landing",
				spacing: [{ name: "rem", value: "1rem" }],
			},
		];
		expect(clusterSpacing(measurements)).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// deduplicateColors
// ---------------------------------------------------------------------------

describe("deduplicateColors", () => {
	it("merges similar OKLCH values within threshold", () => {
		const measurements: MeasurementData[] = [
			{
				pageId: "1",
				pageType: "landing",
				colors: [
					{ name: "primary", value: "oklch(0.2 0.15 250)" },
					{ name: "primary-hover", value: "oklch(0.21 0.14 250)" },
					{ name: "accent", value: "oklch(0.8 0.2 150)" },
				],
			},
		];

		const result = deduplicateColors(measurements);
		// primary-hover should be merged with primary (very similar)
		expect(result.primary).toBe("oklch(0.2 0.15 250)");
		expect(result.accent).toBe("oklch(0.8 0.2 150)");
		// primary-hover should not appear (merged into primary)
		expect(result["primary-hover"]).toBeUndefined();
	});

	it("preserves distinct OKLCH values", () => {
		const measurements: MeasurementData[] = [
			{
				pageId: "1",
				pageType: "landing",
				colors: [
					{ name: "dark", value: "oklch(0.1 0.1 250)" },
					{ name: "light", value: "oklch(0.9 0.05 250)" },
				],
			},
		];

		const result = deduplicateColors(measurements);
		expect(Object.keys(result)).toHaveLength(2);
	});

	it("returns empty for no measurements", () => {
		expect(deduplicateColors([])).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// buildTypographyScale
// ---------------------------------------------------------------------------

describe("buildTypographyScale", () => {
	it("extracts and deduplicates font sizes within tolerance", () => {
		const measurements: MeasurementData[] = [
			{
				pageId: "1",
				pageType: "landing",
				typography: [
					{ fontFamily: "Inter", fontSize: "16px", fontWeight: 400 },
					{ fontFamily: "Inter", fontSize: "15.5px", fontWeight: 400 },
					{ fontFamily: "Inter", fontSize: "32px", fontWeight: 700 },
					{ fontFamily: "Inter", fontSize: "14px", fontWeight: 400 },
				],
			},
		];

		const result = buildTypographyScale(measurements);
		// 15.5px should be deduped with 16px (within 1px tolerance)
		expect(Object.keys(result.fontSize).length).toBeLessThanOrEqual(3);
		expect(result.fontFamily.Inter).toBe("Inter");
	});

	it("returns empty for no measurements", () => {
		const result = buildTypographyScale([]);
		expect(result.fontFamily).toEqual({});
		expect(result.fontSize).toEqual({});
		expect(result.fontWeight).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// deduplicateComponents
// ---------------------------------------------------------------------------

describe("deduplicateComponents", () => {
	it("merges same structure across pages into single recipe", () => {
		const measurements: MeasurementData[] = [
			{
				pageId: "1",
				pageType: "landing",
				components: [
					{
						name: "Button",
						structure: "inline-flex",
						properties: { padding: "8px 16px", borderRadius: "8px" },
						variant: "primary",
					},
				],
			},
			{
				pageId: "2",
				pageType: "about",
				components: [
					{
						name: "Button",
						structure: "inline-flex",
						properties: { padding: "8px 16px", borderRadius: "8px" },
						variant: "secondary",
					},
				],
			},
		];

		const result = deduplicateComponents(measurements);
		expect(result.Button).toBeDefined();
		expect(result.Button.base).toEqual({
			padding: "8px 16px",
			borderRadius: "8px",
		});
		expect(result.Button.variants.primary).toBeDefined();
		expect(result.Button.variants.secondary).toBeDefined();
	});

	it("returns empty for no measurements", () => {
		expect(deduplicateComponents([])).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// aggregateFingerprint
// ---------------------------------------------------------------------------

describe("aggregateFingerprint", () => {
	it("single page returns passthrough", () => {
		const fps = [
			{
				dimensions: {
					ornament: 0.3,
					playfulness: 0.7,
					warmth: 0.5,
					density: 0.6,
					motion: 0.4,
					depth: 0.2,
					darkness: 0.8,
					formality: 0.1,
				},
				weight: 1,
			},
		];

		const result = aggregateFingerprint(fps);
		expect(result.ornament).toBe(0.3);
		expect(result.playfulness).toBe(0.7);
	});

	it("weighted average across multiple pages", () => {
		const fps = [
			{
				dimensions: {
					ornament: 0,
					playfulness: 0,
					warmth: 0,
					density: 0,
					motion: 0,
					depth: 0,
					darkness: 0,
					formality: 0,
				},
				weight: 1,
			},
			{
				dimensions: {
					ornament: 1,
					playfulness: 1,
					warmth: 1,
					density: 1,
					motion: 1,
					depth: 1,
					darkness: 1,
					formality: 1,
				},
				weight: 3,
			},
		];

		const result = aggregateFingerprint(fps);
		// Weighted average: (0*1 + 1*3) / 4 = 0.75
		expect(result.ornament).toBeCloseTo(0.75, 2);
		expect(result.playfulness).toBeCloseTo(0.75, 2);
	});

	it("empty input returns neutral defaults", () => {
		const result = aggregateFingerprint([]);
		expect(result.ornament).toBe(0.5);
		expect(result.formality).toBe(0.5);
	});
});

// ---------------------------------------------------------------------------
// assembleDesignTokens
// ---------------------------------------------------------------------------

describe("assembleDesignTokens", () => {
	it("assembles tokens with all required layers", () => {
		const tokens = assembleDesignTokens({
			colors: { primary: "oklch(0.2 0.1 250)" },
			typography: {
				fontFamily: { sans: "Inter" },
				fontSize: { base: "16px" },
				fontWeight: { regular: 400 },
			},
			spacing: { md: "16px", lg: "24px", sm: "8px", xl: "32px" },
		});

		expect(tokens.atomic.colors.primary).toBe("oklch(0.2 0.1 250)");
		expect(tokens.atomic.typography.fontFamily.sans).toBe("Inter");
		expect(tokens.atomic.spacing.md).toBe("16px");
		expect(tokens.layout.density.mode).toBe("comfortable");
		expect(tokens.motion.state.hover).toBeDefined();
		expect(tokens.surfaces.glass).toBeDefined();
		expect(tokens.visualIdentity.colorDistribution).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// buildPatternsManifest
// ---------------------------------------------------------------------------

describe("buildPatternsManifest", () => {
	it("groups extractions by page type", () => {
		const extractions = [
			{
				pageId: "1",
				pageType: "landing",
				visualMd: "# Landing",
				screenshotPaths: ["s1.png", "s2.png"],
			},
			{
				pageId: "2",
				pageType: "landing",
				visualMd: "# Landing 2",
				screenshotPaths: ["s3.png"],
			},
			{
				pageId: "3",
				pageType: "about",
				visualMd: "# About",
				screenshotPaths: ["s4.png"],
			},
		];

		const manifest: PatternsManifest = buildPatternsManifest(extractions);

		expect(Object.keys(manifest).sort()).toEqual(["about", "landing"]);
		expect(manifest.landing).toHaveLength(2);
		expect(manifest.about).toHaveLength(1);
	});

	it("sorts screenshot paths deterministically", () => {
		const extractions = [
			{
				pageId: "1",
				pageType: "landing",
				visualMd: "# L",
				screenshotPaths: ["z.png", "a.png"],
			},
		];

		const manifest: PatternsManifest = buildPatternsManifest(extractions);
		expect(manifest.landing[0].screenshots).toEqual(["a.png", "z.png"]);
	});

	it("returns empty for no extractions", () => {
		expect(buildPatternsManifest([])).toEqual({});
	});
});

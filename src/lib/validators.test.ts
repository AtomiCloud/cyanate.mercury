import { describe, expect, test } from "bun:test";
import type { DesignTokensV2 } from "../types.js";
import {
	AssetManifestSchema,
	ComponentManifestSchema,
	ComponentRecipesSchema,
	ContentModelSchema,
	DesignTokensV2Schema,
	findLeakedAbsoluteUrls,
	findTailwindClasses,
	QualityScoresSchema,
	ReducedMetaSchema,
	RegistrySchema,
	StyleFingerprintSchema,
	validateAssetIntegrity,
	validateContentCoverage,
	validateOklchValues,
	validateSpacingScale,
	validateTypographyScale,
} from "./validators.js";

// ---------------------------------------------------------------------------
// StyleFingerprintSchema
// ---------------------------------------------------------------------------

describe("StyleFingerprintSchema", () => {
	const validFingerprint = {
		$schema: "https://example.com/fingerprint.json",
		style: {
			primary: "modern",
			secondary: ["clean", "minimal"],
			dimensions: {
				ornament: 0.3,
				playfulness: 0.5,
				warmth: 0.7,
				density: 0.4,
				motion: 0.6,
				depth: 0.2,
				darkness: 0.1,
				formality: 0.8,
			},
			treatments: {
				surface: "glass",
				corners: "rounded",
				shadows: "soft",
				borders: "subtle",
				gradients: "linear",
				blur: true,
				transparency: true,
				animation_style: "smooth",
			},
		},
		confidence: 0.85,
	};

	test("valid fingerprint → passes", () => {
		const result = StyleFingerprintSchema.safeParse(validFingerprint);
		expect(result.success).toBe(true);
	});

	test("missing dimension → fails", () => {
		const invalid = {
			...validFingerprint,
			style: {
				...validFingerprint.style,
				dimensions: {
					ornament: 0.3,
					playfulness: 0.5,
					// missing warmth, density, etc.
				},
			},
		};
		const result = StyleFingerprintSchema.safeParse(invalid);
		expect(result.success).toBe(false);
	});

	test("dimension out of range → fails", () => {
		const invalid = {
			...validFingerprint,
			style: {
				...validFingerprint.style,
				dimensions: {
					...validFingerprint.style.dimensions,
					ornament: 1.5,
				},
			},
		};
		const result = StyleFingerprintSchema.safeParse(invalid);
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// DesignTokensV2Schema
// ---------------------------------------------------------------------------

describe("DesignTokensV2Schema", () => {
	const validTokens = {
		atomic: {
			colors: { primary: "oklch(0.5 0.1 180)" },
			typography: {
				fontFamily: { sans: "Inter" },
				fontSize: { sm: "14px", base: "16px", lg: "18px" },
				fontWeight: { normal: 400, bold: 700 },
			},
			spacing: { sm: "8px", md: "16px", lg: "24px", xl: "32px" },
			borderRadius: { sm: "4px" },
			shadows: {},
		},
		gradients: {},
		layout: {
			grid: { columns: { default: "12" }, gutter: { default: "24px" } },
			container: { maxWidth: { default: "1280px" } },
			breakpoints: { sm: "640px" },
			sections: {},
			density: { mode: "comfortable" },
			rhythm: { baseUnit: "8px", verticalRhythm: {} },
		},
		componentSpacing: {},
		motion: {
			duration: { fast: "150ms" },
			easing: { default: "ease" },
			state: { hover: {}, focus: {}, active: {}, disabled: {} },
			scroll: {},
			skeleton: {},
		},
		surfaces: { glass: {}, texture: {}, imageTreatment: {} },
		visualIdentity: {
			colorDistribution: { dominant: {}, secondary: {}, accent: {} },
			borders: {},
		},
	};

	test("valid tokens → passes", () => {
		const result = DesignTokensV2Schema.safeParse(validTokens);
		expect(result.success).toBe(true);
	});

	test("empty colors → fails schema (non-empty required)", () => {
		const invalid = {
			...validTokens,
			atomic: {
				...validTokens.atomic,
				colors: {},
			},
		};
		const result = DesignTokensV2Schema.safeParse(invalid);
		expect(result.success).toBe(false);
	});

	test("empty fontFamily → fails schema (non-empty required)", () => {
		const invalid = {
			...validTokens,
			atomic: {
				...validTokens.atomic,
				typography: {
					...validTokens.atomic.typography,
					fontFamily: {},
				},
			},
		};
		const result = DesignTokensV2Schema.safeParse(invalid);
		expect(result.success).toBe(false);
	});

	test("empty fontSize → fails schema (non-empty required)", () => {
		const invalid = {
			...validTokens,
			atomic: {
				...validTokens.atomic,
				typography: {
					...validTokens.atomic.typography,
					fontSize: {},
				},
			},
		};
		const result = DesignTokensV2Schema.safeParse(invalid);
		expect(result.success).toBe(false);
	});

	test("empty spacing → fails schema (non-empty required)", () => {
		const invalid = {
			...validTokens,
			atomic: {
				...validTokens.atomic,
				spacing: {},
			},
		};
		const result = DesignTokensV2Schema.safeParse(invalid);
		expect(result.success).toBe(false);
	});

	test("missing required layout fields → fails", () => {
		const invalid = {
			...validTokens,
			layout: {
				grid: { columns: { default: "12" }, gutter: { default: "24px" } },
				container: { maxWidth: { default: "1280px" } },
			},
		};
		const result = DesignTokensV2Schema.safeParse(invalid);
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// ComponentRecipesSchema
// ---------------------------------------------------------------------------

describe("ComponentRecipesSchema", () => {
	test("valid recipes → passes", () => {
		const result = ComponentRecipesSchema.safeParse({
			Button: {
				base: { tag: "button" },
				variants: { primary: { className: "bg-primary" } },
			},
		});
		expect(result.success).toBe(true);
	});

	test("missing variants → fails", () => {
		const result = ComponentRecipesSchema.safeParse({
			Button: {
				base: { tag: "button" },
			},
		});
		expect(result.success).toBe(false);
	});

	test("missing base → fails", () => {
		const result = ComponentRecipesSchema.safeParse({
			Button: {
				variants: { primary: {} },
			},
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// RegistrySchema
// ---------------------------------------------------------------------------

describe("RegistrySchema", () => {
	test("valid registry → passes", () => {
		const result = RegistrySchema.safeParse({
			layouts: {},
			collections: {},
			listings: {},
			static_pages: [{ pagetype: "home", route: "/" }],
		});
		expect(result.success).toBe(true);
	});

	test("invalid interaction type → fails", () => {
		const result = RegistrySchema.safeParse({
			layouts: {},
			collections: {},
			listings: {},
			static_pages: [],
			interactive_patterns: [
				{
					id: "p1",
					type: "invalid_type" as "fragment",
					description: "test",
				},
			],
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// ReducedMetaSchema
// ---------------------------------------------------------------------------

describe("ReducedMetaSchema", () => {
	test("valid meta → passes", () => {
		const result = ReducedMetaSchema.safeParse({
			source: {
				total_pages: 10,
				page_types: 3,
				scraped_at: "2025-01-01",
				site_url: "https://example.com",
			},
			global_keys: ["title", "description"],
			page_types: [
				{
					pagetype: "blog",
					route: "/blog/:slug",
					count: 5,
					multi: true,
					has_pagination: true,
					schema_keys: ["title"],
					own_keys: [],
				},
			],
			pagination_candidates: [],
		});
		expect(result.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// QualityScoresSchema
// ---------------------------------------------------------------------------

describe("QualityScoresSchema", () => {
	test("valid scores → passes", () => {
		const result = QualityScoresSchema.safeParse({
			overall: 8.5,
			dimensions: {
				layoutConsistency: 9,
				designTokenUsage: 8,
				componentComposition: 7,
				responsiveDesign: 9,
				semanticHtml: 10,
				visualAppeal: 8,
				motionQuality: 7,
			},
		});
		expect(result.success).toBe(true);
	});

	test("overall > 10 → fails", () => {
		const result = QualityScoresSchema.safeParse({
			overall: 15,
			dimensions: {
				layoutConsistency: 9,
				designTokenUsage: 8,
				componentComposition: 7,
				responsiveDesign: 9,
				semanticHtml: 10,
				visualAppeal: 8,
				motionQuality: 7,
			},
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// ContentModelSchema
// ---------------------------------------------------------------------------

describe("ContentModelSchema", () => {
	test("valid → passes", () => {
		const result = ContentModelSchema.safeParse({
			pages: [
				{ id: "1", url: "https://example.com/", pagetype: "home", content: {} },
			],
		});
		expect(result.success).toBe(true);
	});

	test("missing required field → fails", () => {
		const result = ContentModelSchema.safeParse({
			pages: [{ id: "1", url: "https://example.com/", content: {} }],
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// ComponentManifestSchema
// ---------------------------------------------------------------------------

describe("ComponentManifestSchema", () => {
	test("valid → passes", () => {
		const result = ComponentManifestSchema.safeParse({
			Button: {
				file: "src/components/Button.astro",
				props: { label: "string" },
				slots: ["default"],
			},
		});
		expect(result.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// AssetManifestSchema
// ---------------------------------------------------------------------------

describe("AssetManifestSchema", () => {
	test("valid → passes", () => {
		const result = AssetManifestSchema.safeParse({
			"/images/logo.svg": "/public/images/logo.svg",
		});
		expect(result.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Domain validators
// ---------------------------------------------------------------------------

describe("validateSpacingScale", () => {
	test("4 steps → no errors", () => {
		const tokens = {
			atomic: {
				colors: {},
				typography: {
					fontFamily: { sans: "Inter" },
					fontSize: {},
					fontWeight: {},
				},
				spacing: { sm: "8px", md: "16px", lg: "24px", xl: "32px" },
				borderRadius: {},
				shadows: {},
			},
			gradients: {},
			layout: {
				grid: { columns: {}, gutter: {} },
				container: { maxWidth: {} },
				breakpoints: {},
				sections: {},
				density: { mode: "" },
				rhythm: { baseUnit: "", verticalRhythm: {} },
			},
			componentSpacing: {},
			motion: {
				duration: {},
				easing: {},
				state: { hover: {}, focus: {}, active: {}, disabled: {} },
				scroll: {},
				skeleton: {},
			},
			surfaces: { glass: {}, texture: {}, imageTreatment: {} },
			visualIdentity: {
				colorDistribution: { dominant: {}, secondary: {}, accent: {} },
				borders: {},
			},
		} as unknown as DesignTokensV2;
		expect(validateSpacingScale(tokens)).toEqual([]);
	});

	test("3 steps → error", () => {
		const tokens = {
			atomic: {
				colors: {},
				typography: {
					fontFamily: { sans: "Inter" },
					fontSize: {},
					fontWeight: {},
				},
				spacing: { sm: "8px", md: "16px", lg: "24px" },
				borderRadius: {},
				shadows: {},
			},
			gradients: {},
			layout: {
				grid: { columns: {}, gutter: {} },
				container: { maxWidth: {} },
				breakpoints: {},
				sections: {},
				density: { mode: "" },
				rhythm: { baseUnit: "", verticalRhythm: {} },
			},
			componentSpacing: {},
			motion: {
				duration: {},
				easing: {},
				state: { hover: {}, focus: {}, active: {}, disabled: {} },
				scroll: {},
				skeleton: {},
			},
			surfaces: { glass: {}, texture: {}, imageTreatment: {} },
			visualIdentity: {
				colorDistribution: { dominant: {}, secondary: {}, accent: {} },
				borders: {},
			},
		} as unknown as DesignTokensV2;
		const errors = validateSpacingScale(tokens);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("3 steps");
	});
});

describe("validateTypographyScale", () => {
	test("3 sizes → no errors", () => {
		const tokens = {
			atomic: {
				colors: {},
				typography: {
					fontFamily: { sans: "Inter" },
					fontSize: { sm: "14px", base: "16px", lg: "18px" },
					fontWeight: {},
				},
				spacing: {},
				borderRadius: {},
				shadows: {},
			},
			gradients: {},
			layout: {
				grid: { columns: {}, gutter: {} },
				container: { maxWidth: {} },
				breakpoints: {},
				sections: {},
				density: { mode: "" },
				rhythm: { baseUnit: "", verticalRhythm: {} },
			},
			componentSpacing: {},
			motion: {
				duration: {},
				easing: {},
				state: { hover: {}, focus: {}, active: {}, disabled: {} },
				scroll: {},
				skeleton: {},
			},
			surfaces: { glass: {}, texture: {}, imageTreatment: {} },
			visualIdentity: {
				colorDistribution: { dominant: {}, secondary: {}, accent: {} },
				borders: {},
			},
		} as unknown as DesignTokensV2;
		expect(validateTypographyScale(tokens)).toEqual([]);
	});

	test("2 sizes → error", () => {
		const tokens = {
			atomic: {
				colors: {},
				typography: {
					fontFamily: { sans: "Inter" },
					fontSize: { sm: "14px", base: "16px" },
					fontWeight: {},
				},
				spacing: {},
				borderRadius: {},
				shadows: {},
			},
			gradients: {},
			layout: {
				grid: { columns: {}, gutter: {} },
				container: { maxWidth: {} },
				breakpoints: {},
				sections: {},
				density: { mode: "" },
				rhythm: { baseUnit: "", verticalRhythm: {} },
			},
			componentSpacing: {},
			motion: {
				duration: {},
				easing: {},
				state: { hover: {}, focus: {}, active: {}, disabled: {} },
				scroll: {},
				skeleton: {},
			},
			surfaces: { glass: {}, texture: {}, imageTreatment: {} },
			visualIdentity: {
				colorDistribution: { dominant: {}, secondary: {}, accent: {} },
				borders: {},
			},
		} as unknown as DesignTokensV2;
		const errors = validateTypographyScale(tokens);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("2 font sizes");
	});
});

describe("validateOklchValues", () => {
	test("valid OKLCH → no errors", () => {
		const tokens = {
			atomic: {
				colors: {
					primary: "oklch(0.5 0.1 180)",
					secondary: "oklch(0.6 0.15 260)",
				},
				typography: { fontFamily: {}, fontSize: {}, fontWeight: {} },
				spacing: {},
				borderRadius: {},
				shadows: {},
			},
			gradients: {},
			layout: {
				grid: { columns: {}, gutter: {} },
				container: { maxWidth: {} },
				breakpoints: {},
				sections: {},
				density: { mode: "" },
				rhythm: { baseUnit: "", verticalRhythm: {} },
			},
			componentSpacing: {},
			motion: {
				duration: {},
				easing: {},
				state: { hover: {}, focus: {}, active: {}, disabled: {} },
				scroll: {},
				skeleton: {},
			},
			surfaces: { glass: {}, texture: {}, imageTreatment: {} },
			visualIdentity: {
				colorDistribution: { dominant: {}, secondary: {}, accent: {} },
				borders: {},
			},
		} as unknown as DesignTokensV2;
		expect(validateOklchValues(tokens)).toEqual([]);
	});

	test("invalid OKLCH → error", () => {
		const tokens = {
			atomic: {
				colors: {
					primary: "oklch(bad format)",
					secondary: "oklch(0.5 0.1 180)",
				},
				typography: { fontFamily: {}, fontSize: {}, fontWeight: {} },
				spacing: {},
				borderRadius: {},
				shadows: {},
			},
			gradients: {},
			layout: {
				grid: { columns: {}, gutter: {} },
				container: { maxWidth: {} },
				breakpoints: {},
				sections: {},
				density: { mode: "" },
				rhythm: { baseUnit: "", verticalRhythm: {} },
			},
			componentSpacing: {},
			motion: {
				duration: {},
				easing: {},
				state: { hover: {}, focus: {}, active: {}, disabled: {} },
				scroll: {},
				skeleton: {},
			},
			surfaces: { glass: {}, texture: {}, imageTreatment: {} },
			visualIdentity: {
				colorDistribution: { dominant: {}, secondary: {}, accent: {} },
				borders: {},
			},
		} as unknown as DesignTokensV2;
		const errors = validateOklchValues(tokens);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("primary");
	});

	test("hex colors → error (must be OKLCH)", () => {
		const tokens = {
			atomic: {
				colors: { primary: "#ff0000", secondary: "#00ff00" },
				typography: { fontFamily: {}, fontSize: {}, fontWeight: {} },
				spacing: {},
				borderRadius: {},
				shadows: {},
			},
			gradients: {},
			layout: {
				grid: { columns: {}, gutter: {} },
				container: { maxWidth: {} },
				breakpoints: {},
				sections: {},
				density: { mode: "" },
				rhythm: { baseUnit: "", verticalRhythm: {} },
			},
			componentSpacing: {},
			motion: {
				duration: {},
				easing: {},
				state: { hover: {}, focus: {}, active: {}, disabled: {} },
				scroll: {},
				skeleton: {},
			},
			surfaces: { glass: {}, texture: {}, imageTreatment: {} },
			visualIdentity: {
				colorDistribution: { dominant: {}, secondary: {}, accent: {} },
				borders: {},
			},
		} as unknown as DesignTokensV2;
		const errors = validateOklchValues(tokens);
		expect(errors).toHaveLength(2);
		expect(errors[0]).toContain("primary");
		expect(errors[1]).toContain("secondary");
	});
});

describe("validateContentCoverage", () => {
	test("all covered → empty missing", () => {
		const result = validateContentCoverage(
			[
				{ id: "1", url: "https://example.com/", pagetype: "home", content: {} },
				{
					id: "2",
					url: "https://example.com/about",
					pagetype: "static",
					content: {},
				},
			],
			["/", "/about"],
		);
		expect(result.missing).toEqual([]);
		expect(result.covered).toHaveLength(2);
	});

	test("one missing → listed", () => {
		const result = validateContentCoverage(
			[
				{ id: "1", url: "https://example.com/", pagetype: "home", content: {} },
				{
					id: "2",
					url: "https://example.com/contact",
					pagetype: "static",
					content: {},
				},
			],
			["/"],
		);
		expect(result.missing).toEqual(["https://example.com/contact"]);
		expect(result.covered).toEqual(["https://example.com/"]);
	});
});

describe("validateAssetIntegrity", () => {
	test("all present → empty missing", () => {
		const result = validateAssetIntegrity({ "logo.svg": "/public/logo.svg" }, [
			"logo.svg",
			"/public/logo.svg",
		]);
		expect(result.missing).toEqual([]);
		expect(result.valid).toHaveLength(1);
	});

	test("one missing → listed", () => {
		const result = validateAssetIntegrity(
			{ "missing.png": "/public/missing.png" },
			["logo.svg"],
		);
		expect(result.missing).toEqual(["missing.png"]);
	});
});

describe("findLeakedAbsoluteUrls", () => {
	test("no leaks → empty array", () => {
		const result = findLeakedAbsoluteUrls(
			{ "index.astro": '<div class="hero">Hello</div>' },
			"https://original.com",
		);
		expect(result).toEqual([]);
	});

	test("absolute URL found → reported with file + line", () => {
		const result = findLeakedAbsoluteUrls(
			{
				"index.astro": '<img src="https://original.com/logo.svg" alt="logo" />',
			},
			"https://original.com",
		);
		expect(result).toHaveLength(1);
		expect(result[0].file).toBe("index.astro");
		expect(result[0].url).toBe("https://original.com/logo.svg");
	});

	test("comments are ignored", () => {
		const result = findLeakedAbsoluteUrls(
			{
				"index.astro":
					"<!-- Source: https://original.com/page -->\n<div>content</div>",
			},
			"https://original.com",
		);
		expect(result).toEqual([]);
	});
});

describe("findTailwindClasses", () => {
	test("no Tailwind classes → empty array", () => {
		const result = findTailwindClasses({
			"Button.astro": '<button class="btn btn-primary">Click</button>',
		});
		expect(result).toEqual([]);
	});

	test("Tailwind classes found → reported", () => {
		const result = findTailwindClasses({
			"Card.astro":
				'<div class="flex items-center gap-4 p-4 rounded-lg">content</div>',
		});
		expect(result).toHaveLength(1);
		expect(result[0].file).toBe("Card.astro");
		expect(result[0].classes.length).toBeGreaterThan(0);
	});

	test("non-component files skipped", () => {
		const result = findTailwindClasses({
			"globals.css": ".flex { display: flex; }",
		});
		expect(result).toEqual([]);
	});

	test("className prop also detected", () => {
		const result = findTailwindClasses({
			"Comp.tsx": '<div className="flex justify-center">hi</div>',
		});
		expect(result).toHaveLength(1);
	});
});

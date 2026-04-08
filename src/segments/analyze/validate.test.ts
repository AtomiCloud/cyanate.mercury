import { describe, expect, it } from "bun:test";
import type {
	ValidateAnalyzeOutputsInput,
	ValidationResult,
} from "./validate.js";
import { validateAnalyzeOutputs } from "./validate.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validFingerprint = {
	$schema: "https://mecury.dev/fingerprint.json",
	style: {
		primary: "minimal",
		secondary: ["clean", "modern"],
		dimensions: {
			ornament: 0.2,
			playfulness: 0.3,
			warmth: 0.4,
			density: 0.5,
			motion: 0.3,
			depth: 0.2,
			darkness: 0.6,
			formality: 0.7,
		},
		treatments: {
			surface: "flat",
			corners: "rounded",
			shadows: "subtle",
			borders: "thin",
			gradients: "linear",
			blur: false,
			transparency: false,
			animation_style: "fade",
		},
	},
	confidence: 0.85,
};

const validTokens = {
	atomic: {
		colors: {
			primary: "oklch(0.2 0.15 250)",
			secondary: "oklch(0.5 0.1 200)",
			background: "oklch(0.98 0.005 250)",
			foreground: "oklch(0.15 0.05 250)",
		},
		typography: {
			fontFamily: { sans: "Inter", mono: "JetBrains Mono" },
			fontSize: { sm: "14px", base: "16px", lg: "18px", xl: "24px" },
			fontWeight: { regular: 400, medium: 500, bold: 700 },
		},
		spacing: {
			xs: "4px",
			sm: "8px",
			md: "16px",
			lg: "24px",
			xl: "32px",
		},
		borderRadius: { sm: "4px", md: "8px" },
		shadows: { sm: "0 1px 2px rgba(0,0,0,0.1)" },
	},
	gradients: {},
	layout: {
		grid: { columns: { default: "12" }, gutter: { default: "24px" } },
		container: { maxWidth: { default: "1280px" } },
		breakpoints: { sm: "640px", md: "768px", lg: "1024px" },
		sections: {},
		density: { mode: "comfortable" },
		rhythm: { baseUnit: "8px", verticalRhythm: {} },
	},
	componentSpacing: {},
	motion: {
		duration: { fast: "150ms", normal: "300ms" },
		easing: { ease: "ease-in-out" },
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

const validRecipes = {
	Button: {
		base: { padding: "8px 16px", borderRadius: "8px" },
		variants: { primary: { bg: "blue" } },
	},
	Card: {
		base: { padding: "24px", borderRadius: "12px" },
		variants: {},
	},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateAnalyzeOutputs", () => {
	it("valid complete outputs → { valid: true, errors: [] }", () => {
		const input: ValidateAnalyzeOutputsInput = {
			fingerprint: validFingerprint,
			tokens: validTokens,
			recipes: validRecipes,
		};
		const result: ValidationResult = validateAnalyzeOutputs(input);

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("missing fingerprint dimension → specific error", () => {
		const badFingerprint = {
			...validFingerprint,
			style: {
				...validFingerprint.style,
				dimensions: {
					ornament: 0.2,
					// missing most dimensions
				},
			},
		};

		const result = validateAnalyzeOutputs({
			fingerprint: badFingerprint,
			tokens: validTokens,
			recipes: validRecipes,
		});

		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("fingerprint"))).toBe(true);
	});

	it("empty spacing layer → spacing must have ≥4 steps", () => {
		const badTokens = {
			...validTokens,
			atomic: {
				...validTokens.atomic,
				spacing: { only: "4px" },
			},
		};

		const result = validateAnalyzeOutputs({
			fingerprint: validFingerprint,
			tokens: badTokens,
			recipes: validRecipes,
		});

		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("expected at least 4"))).toBe(
			true,
		);
	});

	it("invalid OKLCH value → unparseable OKLCH error", () => {
		const badTokens = {
			...validTokens,
			atomic: {
				...validTokens.atomic,
				colors: {
					...validTokens.atomic.colors,
					bad: "#ff0000",
				},
			},
		};

		const result = validateAnalyzeOutputs({
			fingerprint: validFingerprint,
			tokens: badTokens,
			recipes: validRecipes,
		});

		expect(result.valid).toBe(false);
		expect(
			result.errors.some(
				(e) => e.includes("OKLCH") || e.includes("must be OKLCH"),
			),
		).toBe(true);
	});

	it("recipes without base → validation error", () => {
		const badRecipes = {
			Broken: {
				// no base
				variants: { dark: {} },
			},
		};

		const result = validateAnalyzeOutputs({
			fingerprint: validFingerprint,
			tokens: validTokens,
			recipes: badRecipes,
		});

		expect(result.valid).toBe(false);
		// Zod schema catches the missing base field before domain check
		expect(result.errors.some((e) => e.includes("recipes:"))).toBe(true);
	});

	it("completely invalid inputs → multiple errors", () => {
		const result = validateAnalyzeOutputs({
			fingerprint: "not json",
			tokens: null,
			recipes: 42,
		});

		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(1);
	});
});

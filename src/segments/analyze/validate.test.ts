import { describe, expect, it } from "bun:test";
import { validateComponentRecipes, validateDesignOutputs } from "./validate.js";

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

describe("validateDesignOutputs", () => {
	it("valid fingerprint + tokens → { valid: true }", () => {
		const result = validateDesignOutputs(validFingerprint, validTokens);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("null fingerprint → errors", () => {
		const result = validateDesignOutputs(null, validTokens);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("fingerprint"))).toBe(true);
	});

	it("bad spacing → domain error", () => {
		const badTokens = {
			...validTokens,
			atomic: {
				...validTokens.atomic,
				spacing: { only: "4px" },
			},
		};
		const result = validateDesignOutputs(validFingerprint, badTokens);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("expected at least 4"))).toBe(
			true,
		);
	});
});

// ---------------------------------------------------------------------------
// validateComponentRecipes
// ---------------------------------------------------------------------------

describe("validateComponentRecipes", () => {
	it("valid recipes → { valid: true }", () => {
		const result = validateComponentRecipes(validRecipes);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("recipes missing base → error", () => {
		const bad = { Broken: { variants: {} } };
		const result = validateComponentRecipes(bad);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("recipes"))).toBe(true);
	});

	it("null recipes → error", () => {
		const result = validateComponentRecipes(null);
		expect(result.valid).toBe(false);
	});

	it("empty recipes object → { valid: true }", () => {
		const result = validateComponentRecipes({});
		expect(result.valid).toBe(true);
	});
});

import { describe, expect, it } from "bun:test";
import type { PageComponentExtraction, PatternsManifest } from "./merge.js";
import {
	assembleDesignTokens,
	buildPatternsManifest,
	clusterSpacing,
	deduplicateComponents,
	deepMerge,
	extractGradientsFromColors,
	flattenColors,
	flattenSpacing,
	normalizeGradients,
	normalizeRawTokens,
	walkNumericLeaves,
	walkOklchLeaves,
} from "./merge.js";

// ---------------------------------------------------------------------------
// walkNumericLeaves
// ---------------------------------------------------------------------------

describe("walkNumericLeaves", () => {
	it("extracts numeric leaves with dotted paths", () => {
		const result = walkNumericLeaves(
			{ hero: { paddingTop: 160, paddingBottom: 128 }, card: { padding: 32 } },
			"",
		);
		expect(result).toContainEqual({ name: "hero.paddingTop", value: 160 });
		expect(result).toContainEqual({ name: "card.padding", value: 32 });
	});

	it("parses px string leaves", () => {
		const result = walkNumericLeaves({ gap: "16px", margin: "24px" }, "");
		expect(result).toContainEqual({ name: "gap", value: 16 });
		expect(result).toContainEqual({ name: "margin", value: 24 });
	});

	it("skips non-numeric, non-px values", () => {
		const result = walkNumericLeaves(
			{ font: "Inter", visible: true, rem: "1rem" },
			"",
		);
		expect(result).toEqual([]);
	});

	it("handles empty object", () => {
		expect(walkNumericLeaves({}, "")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// walkOklchLeaves
// ---------------------------------------------------------------------------

describe("walkOklchLeaves", () => {
	it("extracts OKLCH color strings", () => {
		const result = walkOklchLeaves(
			{
				background: { light: "oklch(1 0 0)", dark: "oklch(0.1 0.01 286)" },
				text: { primary: "oklch(0.1 0.01 286)" },
			},
			"",
		);
		expect(result).toContainEqual({
			name: "background.light",
			value: "oklch(1 0 0)",
		});
		expect(result).toContainEqual({
			name: "text.primary",
			value: "oklch(0.1 0.01 286)",
		});
	});

	it("skips non-OKLCH strings", () => {
		const result = walkOklchLeaves({ bg: "#fff", name: "primary" }, "");
		expect(result).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// flattenColors
// ---------------------------------------------------------------------------

describe("flattenColors", () => {
	it("passes through flat OKLCH strings", () => {
		const result = flattenColors({
			primary: "oklch(0.5 0.1 200)",
			bg: "oklch(0.98 0.005 250)",
		});
		expect(result).toEqual({
			primary: "oklch(0.5 0.1 200)",
			bg: "oklch(0.98 0.005 250)",
		});
	});

	it("flattens nested color objects", () => {
		const result = flattenColors({
			gray: {
				"50": "oklch(0.98 0 0)",
				"900": "oklch(0.15 0.01 250)",
			},
		});
		expect(result["gray.50"]).toBe("oklch(0.98 0 0)");
		expect(result["gray.900"]).toBe("oklch(0.15 0.01 250)");
	});

	it("handles mixed flat and nested", () => {
		const result = flattenColors({
			primary: "oklch(0.5 0.1 200)",
			scale: { light: "oklch(0.9 0 0)" },
		});
		expect(result.primary).toBe("oklch(0.5 0.1 200)");
		expect(result["scale.light"]).toBe("oklch(0.9 0 0)");
	});

	it("preserves non-OKLCH nested values for validator to catch", () => {
		const result = flattenColors({
			gray: {
				"50": "#f9fafb",
				"900": "oklch(0.15 0.01 250)",
			},
		});
		// Both values should be flattened — the hex value is preserved
		// so the downstream OKLCH validator can reject it with actionable feedback
		expect(result["gray.50"]).toBe("#f9fafb");
		expect(result["gray.900"]).toBe("oklch(0.15 0.01 250)");
	});

	it("handles empty object", () => {
		expect(flattenColors({})).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// clusterSpacing
// ---------------------------------------------------------------------------

describe("clusterSpacing", () => {
	it("clusters raw numeric values to nearest scale anchor", () => {
		const result = clusterSpacing({
			xs: 4,
			sm: 5,
			md: 8,
			lg: 15,
			xl: 16,
			"2xl": 32,
		});
		const values = Object.values(result);

		expect(values).toContain("4px");
		expect(values).toContain("8px");
		expect(values).toContain("16px");
		expect(values).toContain("32px");
		// 5 snaps to 4, 15 snaps to 16
		expect(result.sm).toBe("4px");
		expect(result.lg).toBe("16px");
	});

	it("returns empty record for empty object", () => {
		expect(clusterSpacing({})).toEqual({});
	});

	it("handles nested spacing objects", () => {
		const result = clusterSpacing({
			hero: { paddingTop: 128, gap: 24 },
			card: { padding: 32 },
		});
		expect(result["hero.paddingTop"]).toBe("128px");
		expect(result["hero.gap"]).toBe("24px");
		expect(result["card.padding"]).toBe("32px");
	});

	it("handles px string values in nested objects", () => {
		const result = clusterSpacing({
			gap: "16px",
			margin: "1rem",
		});
		expect(result.gap).toBe("16px");
		// 1rem is not a px value, should be ignored
		expect(result.margin).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// deduplicateComponents
// ---------------------------------------------------------------------------

describe("deduplicateComponents", () => {
	it("merges same properties across pages into single recipe", () => {
		const extractions: PageComponentExtraction[] = [
			{
				pageType: "landing",
				components: {
					Button: { padding: "8px 16px", borderRadius: "8px" },
				},
			},
			{
				pageType: "about",
				components: {
					Button: { padding: "8px 16px", borderRadius: "8px" },
				},
			},
		];

		const result = deduplicateComponents(extractions);
		expect(result.Button).toBeDefined();
		expect(result.Button.base).toEqual({
			padding: "8px 16px",
			borderRadius: "8px",
		});
		// Second page with same props → added as variant
		expect(result.Button.variants.about).toBeDefined();
	});

	it("keeps different components separate", () => {
		const extractions: PageComponentExtraction[] = [
			{
				pageType: "landing",
				components: {
					Button: { padding: "8px" },
					Card: { padding: "16px", shadow: "md" },
				},
			},
		];

		const result = deduplicateComponents(extractions);
		expect(result.Button).toBeDefined();
		expect(result.Card).toBeDefined();
	});

	it("returns empty for no extractions", () => {
		expect(deduplicateComponents([])).toEqual({});
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

describe("extractGradientsFromColors", () => {
	const makeTokens = (
		colors: Record<string, string>,
		gradients: Record<string, unknown> = {},
	) =>
		({
			atomic: {
				colors,
				typography: { fontFamily: {}, fontSize: {}, fontWeight: {} },
				spacing: {},
				borderRadius: {},
				shadows: {},
			},
			gradients,
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
		}) as ReturnType<typeof extractGradientsFromColors>;

	it("moves linear-gradient from colors to gradients", () => {
		const input = makeTokens({
			primary: "oklch(0.5 0.1 180)",
			hero: "linear-gradient(180deg, oklch(0.5 0.1 180), oklch(0.8 0.05 200))",
		});
		const result = extractGradientsFromColors(input);

		expect(result.atomic.colors).toEqual({ primary: "oklch(0.5 0.1 180)" });
		expect(result.gradients.hero).toBeDefined();
		expect(result.gradients.hero.type).toBe("linear");
		expect(result.gradients.hero.angle).toBe("180deg");
		expect(result.gradients.hero.stops).toHaveLength(2);
	});

	it("moves radial-gradient from colors to gradients", () => {
		const input = makeTokens({
			bg: "radial-gradient(circle, oklch(0.9 0 0), oklch(0.1 0 0))",
		});
		const result = extractGradientsFromColors(input);

		expect(result.atomic.colors).toEqual({});
		expect(result.gradients.bg).toBeDefined();
		expect(result.gradients.bg.type).toBe("radial");
	});

	it("leaves non-gradient OKLCH values in colors", () => {
		const input = makeTokens({
			primary: "oklch(0.5 0.1 180)",
			secondary: "oklch(50% 0.2 260)",
		});
		const result = extractGradientsFromColors(input);

		expect(result.atomic.colors).toEqual({
			primary: "oklch(0.5 0.1 180)",
			secondary: "oklch(50% 0.2 260)",
		});
		expect(Object.keys(result.gradients)).toHaveLength(0);
	});

	it("preserves existing gradients", () => {
		const existing = {
			old: { type: "linear", stops: [{ color: "red" }] },
		};
		const input = makeTokens(
			{ hero: "linear-gradient(90deg, oklch(0.5 0.1 0))" },
			existing,
		);
		const result = extractGradientsFromColors(input);

		expect(result.gradients.old).toBeDefined();
		expect(result.gradients.hero).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// flattenSpacing
// ---------------------------------------------------------------------------

describe("flattenSpacing", () => {
	it("passes through flat string values", () => {
		const result = flattenSpacing({ sm: "8px", md: "16px", lg: "24px" });
		expect(result).toEqual({ sm: "8px", md: "16px", lg: "24px" });
	});

	it("flattens nested objects to dot-delimited keys", () => {
		const result = flattenSpacing({
			scale: { "0": "0px", "1": "4px", "2": "8px" },
			hero: { paddingTop: "96px" },
		});
		expect(result["scale.0"]).toBe("0px");
		expect(result["scale.1"]).toBe("4px");
		expect(result["hero.paddingTop"]).toBe("96px");
	});

	it("handles mixed flat and nested values", () => {
		const result = flattenSpacing({
			baseUnit: "4px",
			scale: { "1": "4px" },
		});
		expect(result.baseUnit).toBe("4px");
		expect(result["scale.1"]).toBe("4px");
	});

	it("skips non-string, non-object leaves", () => {
		const result = flattenSpacing({
			valid: "8px",
			number: 42 as unknown as string,
			arr: ["a"] as unknown as string,
		});
		expect(result).toEqual({ valid: "8px" });
	});

	it("handles empty object", () => {
		expect(flattenSpacing({})).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// normalizeGradients
// ---------------------------------------------------------------------------

describe("normalizeGradients", () => {
	it("parses raw CSS linear-gradient strings into GradientDef", () => {
		const result = normalizeGradients({
			hero: "linear-gradient(180deg, oklch(0.2 0.04 270), oklch(0.1 0.02 200))",
		});
		expect(result.hero).toBeDefined();
		expect(result.hero.type).toBe("linear");
		expect(result.hero.angle).toBe("180deg");
		expect(result.hero.stops).toHaveLength(2);
	});

	it("parses conic-gradient strings", () => {
		const result = normalizeGradients({
			sweep: "conic-gradient(from 45deg, red, blue)",
		});
		expect(result.sweep).toBeDefined();
		expect(result.sweep.type).toBe("conic");
	});

	it("parses radial-gradient strings", () => {
		const result = normalizeGradients({
			mesh: "radial-gradient(ellipse at 30% 20%, oklch(0.35 0.15 270), transparent 70%)",
		});
		expect(result.mesh).toBeDefined();
		expect(result.mesh.type).toBe("radial");
	});

	it("passes through existing GradientDef objects", () => {
		const existing = {
			type: "linear",
			angle: "90deg",
			stops: [{ color: "oklch(0.5 0.1 200)", position: "0%" }],
		};
		const result = normalizeGradients({ hero: existing });
		expect(result.hero).toBe(existing);
	});

	it("skips non-gradient values", () => {
		const result = normalizeGradients({
			hero: "linear-gradient(180deg, red, blue)",
			bad: "oklch(0.5 0.1 200)",
			worse: 42,
		});
		expect(result.hero).toBeDefined();
		expect(result.bad).toBeUndefined();
		expect(result.worse).toBeUndefined();
	});

	it("handles empty object", () => {
		expect(normalizeGradients({})).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// flattenSpacing — depth guard
// ---------------------------------------------------------------------------

describe("flattenSpacing — max depth guard", () => {
	it("stops recursing beyond MAX_WALK_DEPTH (10)", () => {
		// Build a 12-level nested object
		let obj: Record<string, unknown> = { leaf: "val" };
		for (let i = 0; i < 12; i++) {
			obj = { nested: obj };
		}
		const result = flattenSpacing(obj);
		// Should have some keys from the top levels but not reach the leaf
		const keys = Object.keys(result);
		expect(keys.every((k) => k !== "leaf")).toBe(true);
		expect(keys.every((k) => !k.endsWith(".leaf"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------

describe("deepMerge", () => {
	it("merges flat objects, source wins", () => {
		const result = deepMerge({ a: "1", b: "2" }, { b: "3", c: "4" });
		expect(result).toEqual({ a: "1", b: "3", c: "4" });
	});

	it("deep merges nested objects", () => {
		const target = { nested: { a: "1", b: "2" } };
		const source = { nested: { b: "3", c: "4" } };
		const result = deepMerge(target, source);
		expect(result).toEqual({ nested: { a: "1", b: "3", c: "4" } });
	});

	it("source overwrites target for non-object values", () => {
		const result = deepMerge({ x: "old" }, { x: "new" });
		expect(result).toEqual({ x: "new" });
	});

	it("arrays are replaced, not merged", () => {
		const result = deepMerge({ arr: [1, 2] }, { arr: [3] });
		expect(result).toEqual({ arr: [3] });
	});

	it("undefined values in source are skipped", () => {
		const result = deepMerge({ a: "keep" }, { a: undefined });
		expect(result).toEqual({ a: "keep" });
	});
});

// ---------------------------------------------------------------------------
// normalizeRawTokens
// ---------------------------------------------------------------------------

describe("normalizeRawTokens", () => {
	it("returns a valid DesignTokensV2 shape from minimal input", () => {
		const raw = {
			atomic: {
				colors: { primary: "oklch(0.5 0.2 250)" },
				typography: {
					fontFamily: { sans: "Inter" },
					fontSize: { base: "16px" },
					fontWeight: { regular: 400 },
				},
				spacing: { sm: "8px", md: "16px" },
			},
		};
		const result = normalizeRawTokens(raw);
		expect(result.atomic.colors.primary).toBe("oklch(0.5 0.2 250)");
		expect(result.gradients).toBeDefined();
		expect(result.layout).toBeDefined();
		expect(result.layout.grid).toBeDefined();
		expect(result.motion).toBeDefined();
		expect(result.surfaces).toBeDefined();
		expect(result.visualIdentity).toBeDefined();
	});

	it("normalizes gradient strings into GradientDef objects", () => {
		const raw = {
			atomic: {
				colors: {},
				typography: { fontFamily: {}, fontSize: {}, fontWeight: {} },
				spacing: {},
			},
			gradients: {
				hero: "linear-gradient(90deg, red, blue)",
			},
		};
		const result = normalizeRawTokens(raw);
		expect(typeof result.gradients.hero).toBe("object");
		expect(result.gradients.hero.type).toBe("linear");
	});

	it("scaffolds missing top-level keys", () => {
		const result = normalizeRawTokens({});
		expect(result.layout.grid.columns).toBeDefined();
		expect(result.componentSpacing).toBeDefined();
		expect(result.motion.duration).toBeDefined();
	});

	it("moves gradient strings from colors to gradients layer", () => {
		const raw = {
			atomic: {
				colors: {
					primary: "oklch(0.5 0.2 250)",
					heroGrad:
						"linear-gradient(90deg, oklch(0.5 0.2 250), oklch(0.3 0.1 200))",
				},
				typography: { fontFamily: {}, fontSize: {}, fontWeight: {} },
				spacing: {},
			},
		};
		const result = normalizeRawTokens(raw);
		expect(result.atomic.colors.heroGrad).toBeUndefined();
		expect(result.gradients.heroGrad).toBeDefined();
		expect(result.gradients.heroGrad.type).toBe("linear");
	});
});

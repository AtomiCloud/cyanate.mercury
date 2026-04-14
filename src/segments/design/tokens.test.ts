import { describe, expect, it } from "bun:test";
import type { DesignTokensV2 } from "../../types.js";
import {
	generateFontDeclarations,
	generateLayersFile,
	generateLayersImport,
	generateRootBlock,
	mapToShadcnComponents,
	tokensToCssProperties,
} from "./tokens.js";
import type { ComponentManifestOutput } from "./types.js";

// ---------------------------------------------------------------------------
// tokensToCssProperties
// ---------------------------------------------------------------------------

const makeTokens = (
	overrides: Partial<DesignTokensV2> = {},
): DesignTokensV2 => ({
	atomic: {
		colors: {
			primary: "oklch(0.7 0.15 250)",
			background: "oklch(0.98 0.01 240)",
			foreground: "oklch(0.15 0.02 240)",
			...overrides.atomic?.colors,
		},
		typography: {
			fontFamily: {
				sans: "Inter, sans-serif",
				mono: "JetBrains Mono, monospace",
			},
			fontSize: { sm: "0.875rem", base: "1rem", lg: "1.125rem", xl: "1.25rem" },
			fontWeight: { normal: 400, medium: 500, bold: 700 },
			...overrides.atomic?.typography,
		},
		spacing: {
			xs: "0.25rem",
			sm: "0.5rem",
			md: "1rem",
			lg: "1.5rem",
			xl: "2rem",
			...overrides.atomic?.spacing,
		},
		borderRadius: {
			sm: "0.25rem",
			md: "0.5rem",
			lg: "0.75rem",
			full: "9999px",
			...overrides.atomic?.borderRadius,
		},
		shadows: {
			sm: "0 1px 2px oklch(0 0 0 / 0.05)",
			md: "0 4px 6px oklch(0 0 0 / 0.1)",
			lg: "0 10px 15px oklch(0 0 0 / 0.1)",
			...overrides.atomic?.shadows,
		},
	},
	gradients: {
		primary: {
			type: "linear",
			angle: "135deg",
			stops: [
				{ color: "oklch(0.7 0.15 250)", position: "0%" },
				{ color: "oklch(0.6 0.18 280)", position: "100%" },
			],
		},
	},
	layout: {
		grid: {
			columns: { sm: "1fr", md: "repeat(2, 1fr)", lg: "repeat(4, 1fr)" },
			gutter: { sm: "1rem", md: "1.5rem" },
		},
		container: { maxWidth: { sm: "640px", md: "768px", lg: "1024px" } },
		breakpoints: { sm: "640px", md: "768px", lg: "1024px", xl: "1280px" },
		sections: {
			hero: { top: "4rem", bottom: "4rem" },
			footer: { top: "2rem", bottom: "2rem" },
		},
		density: { mode: "comfortable" },
		rhythm: {
			baseUnit: "8px",
			verticalRhythm: { heading: "2em", paragraph: "1.5em" },
		},
	},
	componentSpacing: { card: { padding: "1.5rem", gap: "1rem" } },
	motion: {
		duration: { fast: "150ms", normal: "300ms", slow: "500ms" },
		easing: {
			easeOut: "cubic-bezier(0.33, 1, 0.68, 1)",
			easeInOut: "cubic-bezier(0.65, 0, 0.35, 1)",
		},
		state: { hover: {}, focus: {}, active: {}, disabled: {} },
		scroll: {},
		skeleton: {},
	},
	surfaces: {
		glass: { subtle: { opacity: "0.8", blur: "8px" } },
		texture: { noise: { opacity: "0.03" } },
		imageTreatment: { polaroid: { rotation: "-3deg", shadow: "0 4px 12px" } },
	},
	visualIdentity: {
		colorDistribution: { dominant: {}, secondary: {}, accent: {} },
		borders: {},
	},
	...overrides,
});

describe("tokensToCssProperties", () => {
	it("maps atomic.colors to CSS custom properties", () => {
		const tokens = makeTokens();
		const props = tokensToCssProperties(tokens);

		expect(props["--color-primary"]).toBe("oklch(0.7 0.15 250)");
		expect(props["--color-background"]).toBe("oklch(0.98 0.01 240)");
		expect(props["--color-foreground"]).toBe("oklch(0.15 0.02 240)");
	});

	it("maps atomic.spacing to CSS custom properties", () => {
		const tokens = makeTokens();
		const props = tokensToCssProperties(tokens);

		expect(props["--spacing-sm"]).toBe("0.5rem");
		expect(props["--spacing-lg"]).toBe("1.5rem");
	});

	it("maps layout.breakpoints to CSS custom properties", () => {
		const tokens = makeTokens();
		const props = tokensToCssProperties(tokens);

		expect(props["--breakpoint-md"]).toBe("768px");
		expect(props["--breakpoint-lg"]).toBe("1024px");
	});

	it("maps motion.duration to CSS custom properties", () => {
		const tokens = makeTokens();
		const props = tokensToCssProperties(tokens);

		expect(props["--motion-duration-fast"]).toBe("150ms");
		expect(props["--motion-duration-normal"]).toBe("300ms");
	});

	it("handles nested token paths correctly", () => {
		const tokens = makeTokens();
		const props = tokensToCssProperties(tokens);

		// font family
		expect(props["--font-family-sans"]).toBe("Inter, sans-serif");
		// typography font size
		expect(props["--font-size-base"]).toBe("1rem");
		// gradient
		expect(props["--gradient-primary"]).toContain("linear-gradient");
	});

	it("handles empty tokens gracefully", () => {
		const emptyTokens: DesignTokensV2 = {
			atomic: {
				colors: {},
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
		};

		const props = tokensToCssProperties(emptyTokens);
		expect(props).toEqual({});
	});
});

describe("generateRootBlock", () => {
	it("produces valid CSS :root block with sorted properties", () => {
		const props: Record<string, string> = {
			"--spacing-sm": "0.5rem",
			"--breakpoint-md": "768px",
			"--font-family-sans": "Inter, sans-serif",
		};

		const block = generateRootBlock(props);
		expect(block).toStartWith(":root {");
		expect(block).toEndWith("}");
		// Properties should be sorted alphabetically
		const lines = block.split("\n").filter((l) => l.includes("--"));
		const names = lines.map((l) => l.trim().split(":")[0]);
		expect(names).toEqual(names.slice().sort());
	});

	it("produces empty :root block for empty props", () => {
		const block = generateRootBlock({});
		expect(block).toBe(":root {\n}");
	});
});

describe("generateFontDeclarations", () => {
	it("generates <link> tags for Google Fonts URLs", () => {
		const result = generateFontDeclarations({
			sans: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap",
			mono: "https://fonts.googleapis.com/css2?family=JetBrains+Mono&display=swap",
		});

		expect(result.links.length).toBe(2);
		expect(result.links[0]).toContain('<link rel="preconnect"');
		expect(result.links[0]).toContain("fonts.googleapis.com");
	});

	it("generates @font-face rules for local fonts", () => {
		const result = generateFontDeclarations({
			sans: "Inter",
			serif: "Georgia",
		});

		expect(result.fontFaceRules.length).toBe(2);
		expect(result.fontFaceRules[0]).toContain("@font-face");
		expect(result.fontFaceRules[0]).toContain('font-family: "Inter"');
	});

	it("handles mixed Google Fonts and local fonts", () => {
		const result = generateFontDeclarations({
			sans: "https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap",
			local: "Local Font",
		});

		expect(result.links.length).toBe(1);
		expect(result.fontFaceRules.length).toBe(1);
	});
});

describe("mapToShadcnComponents", () => {
	it("maps PascalCase component names to Shadcn names via kebab-case", () => {
		const manifest: ComponentManifestOutput = {
			components: {
				Button: {
					file: "src/components/Button.astro",
					collections: ["buttons"],
				},
				Card: {
					file: "src/components/Card.astro",
					collections: ["cards"],
				},
				NavigationMenu: {
					file: "src/components/NavigationMenu.astro",
					collections: ["nav"],
				},
			},
		};

		const components = mapToShadcnComponents(manifest);
		expect(components).toContain("button");
		expect(components).toContain("card");
		expect(components).toContain("navigation-menu");
	});

	it("deduplicates component names", () => {
		const manifest: ComponentManifestOutput = {
			components: {
				Button: {
					file: "src/components/Button.astro",
					collections: ["button"],
				},
				ButtonVariant: {
					file: "src/components/ButtonVariant.astro",
					collections: ["button"],
				},
				Card: {
					file: "src/components/Card.astro",
					collections: ["card"],
				},
			},
		};

		const components = mapToShadcnComponents(manifest);
		expect(components.filter((c) => c === "button").length).toBe(1);
	});

	it("skips unknown component names", () => {
		const manifest: ComponentManifestOutput = {
			components: {
				Button: {
					file: "src/components/Button.astro",
					collections: [],
				},
				CustomWidget: {
					file: "src/components/CustomWidget.astro",
					collections: [],
				},
			},
		};

		const components = mapToShadcnComponents(manifest);
		expect(components).toContain("button");
		expect(components).not.toContain("customwidget");
	});

	it("returns empty array for empty manifest", () => {
		const manifest: ComponentManifestOutput = { components: {} };
		const components = mapToShadcnComponents(manifest);
		expect(components).toEqual([]);
	});
});

describe("generateLayersFile", () => {
	it("contains correct @layer declaration order", () => {
		const content = generateLayersFile();
		expect(content).toContain("@layer");
		expect(content).toContain("reset");
		expect(content).toContain("tokens");
		expect(content).toContain("layout");
	});
});

describe("generateLayersImport", () => {
	it("generates valid ESM import statement for Astro frontmatter", () => {
		const imp = generateLayersImport();
		expect(imp).toContain('import "');
		expect(imp).toContain("../styles/layers.css");
	});
});

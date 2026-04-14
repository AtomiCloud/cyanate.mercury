/**
 * Pure: design token → CSS custom property conversion.
 *
 * Converts the 7-layer DesignTokensV2 into CSS custom properties,
 * generates font loading declarations, and produces Shadcn component mapping.
 */

import type { DesignTokensV2, GradientDef } from "../../types.js";
import type { ComponentManifestOutput, CssPropertyMap } from "./types.js";

// ---------------------------------------------------------------------------
// Token → CSS property name mapping
// ---------------------------------------------------------------------------

/**
 * Convert 7-layer design tokens into a flat CSS custom property map.
 *
 * Covers all atomic tokens (including colors) plus layout, motion, and surfaces.
 */
export function tokensToCssProperties(tokens: DesignTokensV2): CssPropertyMap {
	const props: CssPropertyMap = {};

	// --- atomic ---
	addPrefixed(props, tokens.atomic.colors, "--color-");
	addPrefixed(props, tokens.atomic.spacing, "--spacing-");
	addPrefixed(props, tokens.atomic.borderRadius, "--radius-");
	addPrefixed(props, tokens.atomic.shadows, "--shadow-");
	addPrefixed(props, tokens.atomic.typography.fontFamily, "--font-family-");
	addPrefixed(props, tokens.atomic.typography.fontSize, "--font-size-");
	addPrefixedNumber(
		props,
		tokens.atomic.typography.fontWeight,
		"--font-weight-",
	);

	// --- gradients ---
	addGradients(props, tokens.gradients);

	// --- layout ---
	addPrefixed(props, tokens.layout.breakpoints, "--breakpoint-");
	addPrefixed(props, tokens.layout.grid.columns, "--grid-columns-");
	addPrefixed(props, tokens.layout.grid.gutter, "--grid-gutter-");
	addPrefixed(props, tokens.layout.container.maxWidth, "--container-");
	addSections(props, tokens.layout.sections);
	addRhythm(props, tokens.layout.rhythm);
	if (tokens.layout.density.mode) {
		props["--density-mode"] = tokens.layout.density.mode;
	}

	// --- componentSpacing ---
	addCompoundSpacing(props, tokens.componentSpacing);

	// --- motion ---
	addPrefixed(props, tokens.motion.duration, "--motion-duration-");
	addPrefixed(props, tokens.motion.easing, "--motion-easing-");

	// --- surfaces ---
	addSurfaces(props, tokens.surfaces);

	return props;
}

/** Add prefixed entries from a string record */
function addPrefixed(
	props: CssPropertyMap,
	entries: Record<string, string>,
	prefix: string,
): void {
	for (const [name, value] of Object.entries(entries)) {
		props[`${prefix}${name}`] = value;
	}
}

/** Add prefixed entries from a number record (converts to string) */
function addPrefixedNumber(
	props: CssPropertyMap,
	entries: Record<string, number>,
	prefix: string,
): void {
	for (const [name, value] of Object.entries(entries)) {
		props[`${prefix}${name}`] = String(value);
	}
}

/** Add gradient entries */
function addGradients(
	props: CssPropertyMap,
	gradients: Record<string, GradientDef>,
): void {
	for (const [name, def] of Object.entries(gradients)) {
		const stops = def.stops
			.map((s) => `${s.color} ${s.position ?? ""}`)
			.join(", ");
		const angle = def.angle ?? "180deg";
		const type = def.type === "linear" ? "linear-gradient" : "radial-gradient";
		props[`--gradient-${name}`] =
			type === "linear-gradient"
				? `linear-gradient(${angle}, ${stops})`
				: `radial-gradient(${stops})`;
	}
}

/** Add section top/bottom entries */
function addSections(
	props: CssPropertyMap,
	sections: Record<string, { top: string; bottom: string }>,
): void {
	for (const [name, val] of Object.entries(sections)) {
		props[`--section-top-${name}`] = val.top;
		props[`--section-bottom-${name}`] = val.bottom;
	}
}

/** Add rhythm entries */
function addRhythm(
	props: CssPropertyMap,
	rhythm: { baseUnit: string; verticalRhythm: Record<string, string> },
): void {
	if (rhythm.baseUnit) {
		props["--rhythm-base-unit"] = rhythm.baseUnit;
	}
	for (const [name, value] of Object.entries(rhythm.verticalRhythm)) {
		props[`--rhythm-${name}`] = value;
	}
}

/** Add compound spacing entries (comp + name) */
function addCompoundSpacing(
	props: CssPropertyMap,
	componentSpacing: Record<string, Record<string, string>>,
): void {
	for (const [comp, spacing] of Object.entries(componentSpacing)) {
		for (const [name, value] of Object.entries(spacing)) {
			props[`--spacing-${comp}-${name}`] = value;
		}
	}
}

/** Add surface entries */
function addSurfaces(
	props: CssPropertyMap,
	surfaces: DesignTokensV2["surfaces"],
): void {
	for (const [surfName, entries] of Object.entries(surfaces.glass)) {
		for (const [name, value] of Object.entries(entries)) {
			props[`--glass-${surfName}-${name}`] = String(value);
		}
	}
	for (const [surfName, entries] of Object.entries(surfaces.texture)) {
		for (const [name, value] of Object.entries(entries)) {
			props[`--texture-${surfName}-${name}`] = String(value);
		}
	}
	for (const [surfName, entries] of Object.entries(surfaces.imageTreatment)) {
		for (const [name, value] of Object.entries(entries)) {
			props[`--image-treatment-${surfName}-${name}`] = String(value);
		}
	}
}

// ---------------------------------------------------------------------------
// CSS :root block generation
// ---------------------------------------------------------------------------

/**
 * Generate a sorted `:root` CSS block from a property map.
 *
 * Properties are sorted alphabetically for determinism and readability.
 */
export function generateRootBlock(properties: CssPropertyMap): string {
	const sorted = Object.entries(properties).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	if (sorted.length === 0) {
		return ":root {\n}";
	}
	const lines = sorted.map(([name, value]) => `  ${name}: ${value};`);
	return `:root {\n${lines.join("\n")}\n}`;
}

// ---------------------------------------------------------------------------
// Font loading declarations
// ---------------------------------------------------------------------------

/**
 * Whether a font family is a Google Fonts URL or a local font.
 */
function isGoogleFontsUrl(family: string): boolean {
	return family.startsWith("https://fonts.googleapis.com");
}

/**
 * Separate font families into Google Fonts (URL-based) and local fonts.
 */
function classifyFonts(fontFamilies: Record<string, string>): {
	googleFonts: string[];
	localFonts: Record<string, string>;
} {
	const googleFonts: string[] = [];
	const localFonts: Record<string, string> = {};

	for (const [name, family] of Object.entries(fontFamilies)) {
		if (isGoogleFontsUrl(family)) {
			googleFonts.push(family);
		} else {
			localFonts[name] = family;
		}
	}

	return { googleFonts, localFonts };
}

/**
 * Generate Google Fonts `<link>` tags and local `@font-face` rules.
 *
 * Returns { links, fontFaceRules } where:
 * - links: <link> tags for Google Fonts
 * - fontFaceRules: @font-face CSS rule strings for local fonts
 */
export function generateFontDeclarations(
	fontFamilies: Record<string, string>,
): { links: string[]; fontFaceRules: string[] } {
	const { googleFonts, localFonts } = classifyFonts(fontFamilies);

	// Deduplicate Google Fonts URLs
	const uniqueGoogleFonts = [...new Set(googleFonts)];
	const links = uniqueGoogleFonts.map((url) => {
		const match = url.match(/family=([^&]+)/);
		const _family = match ? decodeURIComponent(match[1]) : "";
		return `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link href="${url}" rel="stylesheet">`;
	});

	// Generate @font-face rules for local fonts
	const fontFaceRules: string[] = [];
	for (const [_name, family] of Object.entries(localFonts)) {
		// Strip quotes if present
		const cleanFamily = family.replace(/^['"]|['"]$/g, "");
		fontFaceRules.push(
			`@font-face {\n  font-family: "${cleanFamily}";\n  src: local("${cleanFamily}");\n}`,
		);
	}

	return { links, fontFaceRules };
}

// ---------------------------------------------------------------------------
// Shadcn component mapping
// ---------------------------------------------------------------------------

/**
 * Map wireframe component manifest to Shadcn component names.
 *
 * The wireframe manifest has component-name keys with { file, collections } values.
 * We extract candidate names from the component name (PascalCase → kebab-case),
 * file basename, and collection names, then match against the known Shadcn set.
 *
 * Returns an array of Shadcn component slugs suitable for `npx shadcn add`.
 */
export function mapToShadcnComponents(
	manifest: ComponentManifestOutput,
): string[] {
	const known = new Set([
		"button",
		"card",
		"input",
		"label",
		"textarea",
		"select",
		"checkbox",
		"radio-group",
		"switch",
		"badge",
		"avatar",
		"dialog",
		"dropdown-menu",
		"navigation-menu",
		"separator",
		"skeleton",
		"table",
		"tabs",
		"tooltip",
		"sonner",
		"progress",
		"slider",
		"toggle",
		"accordion",
		"alert",
		"alert-dialog",
		"aspect-ratio",
		"calendar",
		"carousel",
		"collapsible",
		"context-menu",
		"hover-card",
		"menubar",
		"popover",
		"scroll-area",
		"resizable",
		"sheet",
		"sidebar",
		"command",
		"field",
		"input-otp",
		"pagination",
		"breadcrumb",
		"toggle-group",
	]);

	const seen = new Set<string>();
	const shadcn: string[] = [];

	for (const [componentName, entry] of Object.entries(manifest.components)) {
		// componentName is the wireframe component name (e.g., "HeroSection")
		// entry.file is the actual file path (e.g., "src/components/HeroSection.astro")
		const fileBaseName =
			entry.file
				.split("/")
				.pop()
				?.replace(/\.\w+$/, "")
				?.toLowerCase() ?? "";

		// PascalCase → kebab-case (e.g., "Button" → "button", "NavMenu" → "nav-menu")
		const kebabName = componentName
			.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
			.toLowerCase();

		const candidates = [
			kebabName,
			fileBaseName,
			componentName.toLowerCase(),
			...entry.collections.map((c) => c.toLowerCase()),
		];

		for (const candidate of candidates) {
			if (known.has(candidate) && !seen.has(candidate)) {
				seen.add(candidate);
				shadcn.push(candidate);
			}
		}
	}

	return shadcn;
}

// ---------------------------------------------------------------------------
// CSS layers file generation
// ---------------------------------------------------------------------------

/**
 * Generate layers.css content with correct @layer declaration order.
 *
 * Layer order (broad to specific):
 *   1. reset / base
 *   2. tokens
 *   3. layout
 *   4. typography
 *   5. surfaces
 *   6. color
 *   7. motion
 *   8. components
 */
export function generateLayersFile(): string {
	return `@layer reset, tokens, layout, typography, surfaces, color, motion, components;
`;
}

// ---------------------------------------------------------------------------
// Layers import statement
// ---------------------------------------------------------------------------

/**
 * Generate the ESM import statement to add to Layout.astro for layers.css.
 * Astro frontmatter uses JS/ESM imports, not CSS @import.
 */
export function generateLayersImport(): string {
	return `import "../styles/layers.css";`;
}

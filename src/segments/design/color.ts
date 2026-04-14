/**
 * Pure: color system generation, WCAG contrast checking, and auto-fix.
 *
 * All color logic is pure — no IO, no side effects.
 */

import type { DesignTokensV2 } from "../../types.js";
import type {
	ColorSystem,
	ContrastFix,
	ContrastResult,
	ContrastViolation,
	CssPropertyMap,
} from "./types.js";

// ---------------------------------------------------------------------------
// OKLCH → RGB conversion
// ---------------------------------------------------------------------------

/**
 * Parse an OKLCH string into its components.
 * Returns [L, C, H] where L is 0-1, C is 0-1, H is degrees.
 */
function parseOklch(value: string): [number, number, number] | null {
	const match = value.match(/oklch\s*\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
	if (!match) return null;
	return [
		Number.parseFloat(match[1]),
		Number.parseFloat(match[2]),
		Number.parseFloat(match[3]),
	];
}

/**
 * Convert OKLCH to linear sRGB.
 * Uses the CSS Color Level 4 OKLab path:
 *   OKLCH → OKLab → LMS (cube roots) → linear sRGB
 *
 * References:
 *   - https://bottosson.github.io/posts/oklab/
 *   - CSS Color Level 4 §18
 */
function oklchToLinearRgb(
	L: number,
	C: number,
	H: number,
): [number, number, number] {
	// OKLCh to OKLab
	const hRad = (H * Math.PI) / 180;
	const a = C * Math.cos(hRad);
	const b = C * Math.sin(hRad);

	// OKLab to LMS (non-linear, i.e. cube-root space)
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.291485548 * b;

	// Cube to get LMS
	const l = l_ * l_ * l_;
	const m = m_ * m_ * m_;
	const s = s_ * s_ * s_;

	// LMS to linear sRGB (inverse of M2 × M1)
	const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
	const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
	const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

	return [
		Math.max(0, Math.min(1, r)),
		Math.max(0, Math.min(1, g)),
		Math.max(0, Math.min(1, bLin)),
	];
}

/**
 * Convert sRGB component [0,1] to linear RGB (inverse sRGB companding).
 * Used for WCAG relative luminance from hex/rgb values.
 */
function srgbToLinear(c: number): number {
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

// ---------------------------------------------------------------------------
// Relative luminance (WCAG)
// ---------------------------------------------------------------------------

/**
 * Compute WCAG relative luminance for a color string (oklch, rgb, or hex).
 *
 * Returns a value 0-1 where 0 is black and 1 is white.
 *
 * WCAG luminance uses linear sRGB coefficients:
 *   Y = 0.2126 * R_lin + 0.7152 * G_lin + 0.0722 * B_lin
 */
function relativeLuminance(value: string): number | null {
	// Handle oklch — conversion gives us linear sRGB directly
	const oklch = parseOklch(value);
	if (oklch) {
		const [r, g, b] = oklchToLinearRgb(oklch[0], oklch[1], oklch[2]);
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	}

	// Handle rgb/rgba — values are sRGB, linearize first
	const rgbMatch = value.match(
		/rgba?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i,
	);
	if (rgbMatch) {
		const r = srgbToLinear(Number.parseFloat(rgbMatch[1]) / 255);
		const g = srgbToLinear(Number.parseFloat(rgbMatch[2]) / 255);
		const b = srgbToLinear(Number.parseFloat(rgbMatch[3]) / 255);
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	}

	// Handle hex — values are sRGB, linearize first
	const hexMatch = value.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
	if (hexMatch) {
		const r = srgbToLinear(Number.parseInt(hexMatch[1], 16) / 255);
		const g = srgbToLinear(Number.parseInt(hexMatch[2], 16) / 255);
		const b = srgbToLinear(Number.parseInt(hexMatch[3], 16) / 255);
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	}

	return null;
}

// ---------------------------------------------------------------------------
// Color system generation
// ---------------------------------------------------------------------------

/**
 * Standard color roles we expect in design tokens.
 *
 * These map to the template's source variable names (e.g. --background, --foreground)
 * which are consumed by the @theme inline block to drive Tailwind utilities.
 * We do NOT use --color-* prefix because the template's @theme inline block already
 * maps --color-background: var(--background), etc.
 */
const COLOR_ROLES = [
	"foreground",
	"background",
	"primary",
	"primary-foreground",
	"secondary",
	"secondary-foreground",
	"accent",
	"accent-foreground",
	"muted",
	"muted-foreground",
	"border",
	"input",
	"ring",
	"card",
	"card-foreground",
	"popover",
	"popover-foreground",
	"destructive",
	"destructive-foreground",
] as const;

/**
 * Generate :root and .dark CSS color variables from design tokens.
 *
 * Uses the template's source variable names (--background, --foreground, etc.)
 * which are referenced by @theme inline to drive Tailwind utilities like
 * bg-background, text-foreground, etc.
 */
export function generateColorSystem(
	colorTokens: DesignTokensV2["atomic"]["colors"],
	_visualIdentity: DesignTokensV2["visualIdentity"],
): ColorSystem {
	const light: CssPropertyMap = {};
	const dark: CssPropertyMap = {};

	// Map known color roles to the template's source CSS variables
	for (const role of COLOR_ROLES) {
		const value = colorTokens[role];
		if (value) {
			light[`--${role}`] = value;
			// For dark mode, invert lightness (approximate)
			const oklch = parseOklch(value);
			if (oklch) {
				const [L, C, H] = oklch;
				// Flip lightness: dark = 1 - L (preserves chroma and hue)
				const darkL = Math.max(0, Math.min(1, 1 - L));
				dark[`--${role}`] =
					`oklch(${darkL.toFixed(4)} ${C.toFixed(4)} ${H.toFixed(1)})`;
			} else {
				dark[`--${role}`] = value;
			}
		}
	}

	// Also include all raw color tokens (prefixed with --color- to avoid collision
	// with the template's semantic source vars)
	for (const [name, value] of Object.entries(colorTokens)) {
		if (!light[`--${name}`]) {
			light[`--color-${name}`] = value;
			dark[`--color-${name}`] = value;
		}
	}

	return { light, dark };
}

// ---------------------------------------------------------------------------
// WCAG contrast checking
// ---------------------------------------------------------------------------

/**
 * Check WCAG AA contrast ratio between two colors.
 *
 * Returns ratio (1-21) and pass/fail for AA normal text and AA large text.
 */
export function checkContrast(
	foreground: string,
	background: string,
): ContrastResult {
	const fgLum = relativeLuminance(foreground);
	const bgLum = relativeLuminance(background);

	if (fgLum === null || bgLum === null) {
		return { ratio: 1, passesAA: false, passesAALarge: false };
	}

	const lighter = Math.max(fgLum, bgLum);
	const darker = Math.min(fgLum, bgLum);
	const ratio = (lighter + 0.05) / (darker + 0.05);

	return {
		ratio: Math.round(ratio * 100) / 100,
		passesAA: ratio >= 4.5,
		passesAALarge: ratio >= 3,
	};
}

// ---------------------------------------------------------------------------
// Contrast violations
// ---------------------------------------------------------------------------

/**
 * Find all failing contrast pairs in a color system.
 */
export function findContrastViolations(
	colorPairs: Array<{
		foreground: string;
		background: string;
		context: string;
	}>,
): ContrastViolation[] {
	const violations: ContrastViolation[] = [];

	for (const pair of colorPairs) {
		const result = checkContrast(pair.foreground, pair.background);
		if (!result.passesAA) {
			violations.push({
				context: pair.context,
				ratio: result.ratio,
				required: 4.5,
			});
		}
	}

	return violations;
}

// ---------------------------------------------------------------------------
// Auto-fix contrast
// ---------------------------------------------------------------------------

/**
 * Binary search for an OKLCH lightness that achieves the target contrast ratio
 * against a given background luminance.
 */
function searchLightness(
	bgLum: number,
	C: number,
	H: number,
	isFgLighter: boolean,
	targetRatio: number,
	origL: number,
): number {
	let lo = 0;
	let hi = 1;
	let bestL = origL;

	for (let i = 0; i < 32; i++) {
		const midL = (lo + hi) / 2;
		const [rr, gg, bb] = oklchToLinearRgb(midL, C, H);
		const midLum = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
		const lgt = Math.max(midLum, bgLum);
		const drk = Math.min(midLum, bgLum);
		const ratio = (lgt + 0.05) / (drk + 0.05);

		if (ratio >= targetRatio) {
			bestL = midL;
			// Move towards original L to find minimal adjustment
			if (isFgLighter) hi = midL;
			else lo = midL;
		} else {
			// Move away from original L to increase contrast
			if (isFgLighter) lo = midL;
			else hi = midL;
		}
	}
	return bestL;
}

/**
 * Auto-fix a color to meet contrast ratio by adjusting OKLCH lightness.
 *
 * Preserves hue and chroma, only adjusts lightness.
 * If the foreground is already passing, returns it unchanged.
 */
export function autoFixContrast(
	foreground: string,
	background: string,
	targetRatio: number,
): ContrastFix {
	const bgLum = relativeLuminance(background);
	const fgLum = relativeLuminance(foreground);
	if (bgLum === null || fgLum === null) {
		return { fixed: foreground, adjustment: 0 };
	}

	const fgOklch = parseOklch(foreground);
	if (!fgOklch) {
		return { fixed: foreground, adjustment: 0 };
	}

	const lighter = Math.max(fgLum, bgLum);
	const darker = Math.min(fgLum, bgLum);
	const currentRatio = (lighter + 0.05) / (darker + 0.05);
	if (currentRatio >= targetRatio) {
		return { fixed: foreground, adjustment: 0 };
	}

	const [origL, C, H] = fgOklch;
	const isFgLighter = fgLum > bgLum;
	const bestL = searchLightness(bgLum, C, H, isFgLighter, targetRatio, origL);
	const adjustment = Math.abs(bestL - origL);

	return {
		fixed: `oklch(${bestL.toFixed(4)} ${C.toFixed(4)} ${H.toFixed(1)})`,
		adjustment: Math.round(adjustment * 1000) / 1000,
	};
}

// ---------------------------------------------------------------------------
// Apply contrast fixes
// ---------------------------------------------------------------------------

/**
 * Parse a violation context string to extract color variable keys and mode.
 * Format: "light:foreground:XXX on background:YYY" or "dark:foreground:XXX on background:YYY"
 * Falls back to bare format: "foreground:XXX on background:YYY" (mode = null)
 */
function parseColorContext(
	context: string,
): { fgKey: string; bgKey: string; mode: "light" | "dark" | null } | null {
	const modeMatch = context.match(/^(light|dark):/);
	const mode = modeMatch ? (modeMatch[1] as "light" | "dark") : null;
	const stripped = modeMatch ? context.slice(modeMatch[0].length) : context;

	const fgMatch = stripped.match(/^foreground:(\S+)/);
	const bgMatch = stripped.match(/on background:(\S+)/);

	if (fgMatch && bgMatch) {
		return { fgKey: fgMatch[1], bgKey: bgMatch[1], mode };
	}
	return null;
}

/**
 * Apply fixes from a single violation to a color map.
 */
function applyFixToMap(
	fixedMap: CssPropertyMap,
	originalMap: CssPropertyMap,
	fgVar: string,
	bgVar: string,
	violationRatio: number,
	mode: "light" | "dark",
): string | null {
	const fgColor = fixedMap[fgVar] ?? originalMap[fgVar];
	const bgColor = fixedMap[bgVar] ?? originalMap[bgVar];

	if (!fgColor || !bgColor) return null;

	const fix = autoFixContrast(fgColor, bgColor, 4.5);
	if (fix.adjustment === 0) return null;

	fixedMap[fgVar] = fix.fixed;
	const modeLabel = mode === "dark" ? "Dark" : "Light";
	return `${modeLabel}: ${fgVar} adjusted ${formatAdjustment(fix.adjustment)} lightness to meet 4.5:1 on ${bgVar} (was ${violationRatio.toFixed(2)}:1)`;
}

function formatAdjustment(adj: number): string {
	return `${adj > 0 ? "+" : ""}${adj}`;
}

/**
 * Apply auto-fixes to a color system, returning adjusted map + changelog.
 */
export function applyContrastFixes(
	colorSystem: { light: CssPropertyMap; dark: CssPropertyMap },
	violations: ReturnType<typeof findContrastViolations>,
): {
	fixed: { light: CssPropertyMap; dark: CssPropertyMap };
	changes: string[];
} {
	const fixedLight = { ...colorSystem.light };
	const fixedDark = { ...colorSystem.dark };
	const changes: string[] = [];

	for (const v of violations) {
		const parsed = parseColorContext(v.context);
		if (!parsed) continue;

		const { fgKey, bgKey, mode } = parsed;
		const fgVar = `--${fgKey}`;
		const bgVar = `--${bgKey}`;

		if (mode === "light" || mode === null) {
			const lightChange = applyFixToMap(
				fixedLight,
				colorSystem.light,
				fgVar,
				bgVar,
				v.ratio,
				"light",
			);
			if (lightChange) changes.push(lightChange);
		}

		if (mode === "dark" || mode === null) {
			const darkChange = applyFixToMap(
				fixedDark,
				colorSystem.dark,
				fgVar,
				bgVar,
				v.ratio,
				"dark",
			);
			if (darkChange) changes.push(darkChange);
		}
	}

	return { fixed: { light: fixedLight, dark: fixedDark }, changes };
}

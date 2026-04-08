/**
 * Pure: merge & reconciliation.
 *
 * Clusters spacing, deduplicates colors, builds typography scales,
 * aggregates fingerprints, assembles design tokens, and organizes patterns manifests.
 */

import type {
	ComponentRecipes,
	DesignTokensV2,
	StyleFingerprint,
} from "../../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MeasurementData {
	pageId: string;
	pageType: string;
	spacing?: Array<{ name: string; value: string }>;
	colors?: Array<{ name: string; value: string }>;
	typography?: Array<{
		fontFamily: string;
		fontSize: string;
		fontWeight: number;
	}>;
	components?: Array<{
		name: string;
		structure: string;
		properties: Record<string, unknown>;
		variant?: string;
	}>;
	fingerprint?: {
		dimensions: Record<string, number>;
		weight: number;
	};
}

export interface PatternsManifest {
	[pageType: string]: Array<{
		pageId: string;
		visualMd: string;
		screenshots: string[];
	}>;
}

// ---------------------------------------------------------------------------
// Spacing clustering
// ---------------------------------------------------------------------------

/**
 * Common spacing scale anchors (px). Clustering snaps to nearest anchor
 * within tolerance, otherwise preserves the original value.
 */
const SPACING_ANCHORS = [4, 8, 12, 16, 20, 24, 32, 40, 48, 56, 64, 80, 96, 128];
const SPACING_TOLERANCE = 2; // px

function parsePx(value: string): number | null {
	const match = value.match(/^(\d+(?:\.\d+)?)\s*px$/i);
	return match ? Number.parseFloat(match[1]) : null;
}

function snapToAnchor(px: number): number {
	let bestDist = Infinity;
	let snapped = px;
	for (const anchor of SPACING_ANCHORS) {
		const dist = Math.abs(px - anchor);
		if (dist < bestDist) {
			bestDist = dist;
			snapped = anchor;
		}
	}
	return bestDist <= SPACING_TOLERANCE ? snapped : px;
}

/**
 * Cluster spacing values into a normalized scale.
 *
 * Raw values are snapped to the nearest common scale anchor within tolerance.
 * Returns a sorted record of name→value.
 */
export function clusterSpacing(
	measurements: MeasurementData[],
): Record<string, string> {
	const values = new Map<string, number>();

	for (const m of measurements) {
		for (const s of m.spacing ?? []) {
			const px = parsePx(s.value);
			if (px === null) continue;
			values.set(s.name, snapToAnchor(px));
		}
	}

	const entries = [...values.entries()].sort((a, b) => a[1] - b[1]);
	const result: Record<string, string> = {};
	for (const [name, px] of entries) {
		result[name] = `${px}px`;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Color deduplication
// ---------------------------------------------------------------------------

/**
 * Simple OKLCH ΔE approximation using Euclidean distance in LCh space.
 * Not perceptually perfect but sufficient for deduplication.
 */
function oklchDeltaE(a: string, b: string): number {
	const parse = (v: string): [number, number, number] | null => {
		const m = v.match(/oklch\s*\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
		if (!m) return null;
		return [
			Number.parseFloat(m[1]),
			Number.parseFloat(m[2]),
			Number.parseFloat(m[3]),
		];
	};

	const pa = parse(a);
	const pb = parse(b);
	if (!pa || !pb) return Infinity;

	// Approximate: L*100 for lightness weight, C and H weighted lower
	const dL = (pa[0] - pb[0]) * 100;
	const dC = pa[1] - pb[1];
	const dH = (pa[2] - pb[2]) * 2; // scale hue difference

	return Math.sqrt(dL * dL + dC * dC + dH * dH);
}

const COLOR_DE_THRESHOLD = 3; // OKLCH ΔE threshold for merging

/**
 * Deduplicate color roles across pages.
 * Colors within ΔE threshold are merged, keeping the first name encountered.
 */
export function deduplicateColors(
	measurements: MeasurementData[],
): Record<string, string> {
	const result: Record<string, string> = {};

	for (const m of measurements) {
		for (const c of m.colors ?? []) {
			// Check if a similar color already exists
			let merged = false;
			for (const [_existingName, existingValue] of Object.entries(result)) {
				if (oklchDeltaE(c.value, existingValue) < COLOR_DE_THRESHOLD) {
					merged = true;
					break;
				}
			}
			if (!merged) {
				result[c.name] = c.value;
			}
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Typography scale
// ---------------------------------------------------------------------------

const FONT_SIZE_TOLERANCE = 1; // px

function findNearbySize(sizes: Map<number, string[]>, sizePx: number): boolean {
	for (const [existingPx] of sizes) {
		if (Math.abs(existingPx - sizePx) <= FONT_SIZE_TOLERANCE) {
			return true;
		}
	}
	return false;
}

function processTypographyEntry(
	t: NonNullable<MeasurementData["typography"]>[number],
	families: Record<string, string>,
	sizes: Map<number, string[]>,
	weights: Record<string, number>,
): void {
	if (t.fontFamily) {
		families[t.fontFamily] = t.fontFamily;
	}

	const sizePx = parsePx(t.fontSize);
	if (sizePx !== null && !findNearbySize(sizes, sizePx)) {
		sizes.set(sizePx, [`${sizePx}px`]);
	}

	if (t.fontWeight) {
		weights[`${t.fontWeight}`] = t.fontWeight;
	}
}

/**
 * Build typography scale from measured font sizes.
 * Deduplicates sizes within tolerance, preserving semantic names.
 */
export function buildTypographyScale(measurements: MeasurementData[]): {
	fontFamily: Record<string, string>;
	fontSize: Record<string, string>;
	fontWeight: Record<string, number>;
} {
	const families: Record<string, string> = {};
	const sizes: Map<number, string[]> = new Map();
	const weights: Record<string, number> = {};

	for (const m of measurements) {
		for (const t of m.typography ?? []) {
			processTypographyEntry(t, families, sizes, weights);
		}
	}

	const sortedSizes = [...sizes.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([px, names]) => ({ px, name: names[0] }));

	const fontSize: Record<string, string> = {};
	for (const s of sortedSizes) {
		fontSize[s.name] = `${s.px}px`;
	}

	return { fontFamily: families, fontSize, fontWeight: weights };
}

// ---------------------------------------------------------------------------
// Component deduplication
// ---------------------------------------------------------------------------

/**
 * Simple hash of component structure for deduplication.
 */
function structureKey(
	structure: string,
	properties: Record<string, unknown>,
): string {
	return `${structure}:${JSON.stringify(properties, Object.keys(properties).sort())}`;
}

function processComponent(
	c: NonNullable<MeasurementData["components"]>[number],
	pageType: string,
	recipes: ComponentRecipes,
	seenStructures: Map<string, string>,
): void {
	const key = structureKey(c.structure, c.properties);
	const existing = seenStructures.get(key);

	if (existing !== undefined) {
		if (c.variant) {
			recipes[existing].variants[c.variant] = {
				...c.properties,
				_pageType: pageType,
			};
		}
	} else {
		seenStructures.set(key, c.name);
		recipes[c.name] = {
			base: c.properties,
			variants: c.variant ? { [c.variant]: { _pageType: pageType } } : {},
		};
	}
}

/**
 * Deduplicate component patterns across pages.
 * Same structure+properties → single recipe with variants.
 */
export function deduplicateComponents(
	measurements: MeasurementData[],
): ComponentRecipes {
	const recipes: ComponentRecipes = {};
	const seenStructures = new Map<string, string>();

	for (const m of measurements) {
		for (const c of m.components ?? []) {
			processComponent(c, m.pageType, recipes, seenStructures);
		}
	}

	return recipes;
}

// ---------------------------------------------------------------------------
// Fingerprint aggregation
// ---------------------------------------------------------------------------

const DIMENSION_KEYS = [
	"ornament",
	"playfulness",
	"warmth",
	"density",
	"motion",
	"depth",
	"darkness",
	"formality",
] as const;

type DimensionKey = (typeof DIMENSION_KEYS)[number];

/**
 * Weighted aggregation of fingerprint dimensions across pages.
 */
export function aggregateFingerprint(
	perPageFingerprints: Array<{
		dimensions: Record<string, number>;
		weight: number;
	}>,
): StyleFingerprint["style"]["dimensions"] {
	if (perPageFingerprints.length === 0) {
		// Return neutral defaults
		const result = {} as Record<DimensionKey, number>;
		for (const key of DIMENSION_KEYS) {
			result[key] = 0.5;
		}
		return result;
	}

	if (perPageFingerprints.length === 1) {
		const fp = perPageFingerprints[0];
		const result = {} as Record<DimensionKey, number>;
		for (const key of DIMENSION_KEYS) {
			result[key] = fp.dimensions[key] ?? 0.5;
		}
		return result;
	}

	let totalWeight = 0;
	const weightedSums: Record<string, number> = {};
	for (const key of DIMENSION_KEYS) {
		weightedSums[key] = 0;
	}

	for (const fp of perPageFingerprints) {
		totalWeight += fp.weight;
		for (const key of DIMENSION_KEYS) {
			weightedSums[key] += (fp.dimensions[key] ?? 0.5) * fp.weight;
		}
	}

	const result = {} as Record<DimensionKey, number>;
	for (const key of DIMENSION_KEYS) {
		result[key] = Math.round((weightedSums[key] / totalWeight) * 1000) / 1000;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Design token assembly
// ---------------------------------------------------------------------------

/**
 * Assemble complete design tokens from reconciled parts.
 */
export function assembleDesignTokens(parts: {
	colors: Record<string, string>;
	typography: ReturnType<typeof buildTypographyScale>;
	spacing: Record<string, string>;
}): DesignTokensV2 {
	return {
		atomic: {
			colors: parts.colors,
			typography: parts.typography,
			spacing: parts.spacing,
			borderRadius: {},
			shadows: {},
		},
		gradients: {},
		layout: {
			grid: { columns: {}, gutter: {} },
			container: { maxWidth: {} },
			breakpoints: {},
			sections: {},
			density: { mode: "comfortable" },
			rhythm: { baseUnit: "8px", verticalRhythm: {} },
		},
		componentSpacing: {},
		motion: {
			duration: {},
			easing: {},
			state: { hover: {}, focus: {}, active: {}, disabled: {} },
			scroll: {},
			skeleton: {},
		},
		surfaces: {
			glass: {},
			texture: {},
			imageTreatment: {},
		},
		visualIdentity: {
			colorDistribution: {
				dominant: {},
				secondary: {},
				accent: {},
			},
			borders: {},
		},
	};
}

// ---------------------------------------------------------------------------
// Patterns manifest
// ---------------------------------------------------------------------------

/**
 * Organize visual markdown + screenshots into patterns structure.
 * Groups by page type with deterministic file naming.
 */
export function buildPatternsManifest(
	extractions: Array<{
		pageId: string;
		pageType: string;
		visualMd: string;
		screenshotPaths: string[];
	}>,
): PatternsManifest {
	const manifest: PatternsManifest = {};

	for (const ext of extractions) {
		if (!manifest[ext.pageType]) {
			manifest[ext.pageType] = [];
		}
		manifest[ext.pageType].push({
			pageId: ext.pageId,
			visualMd: ext.visualMd,
			screenshots: ext.screenshotPaths.sort(),
		});
	}

	return manifest;
}

/**
 * Pure: merge & normalization.
 *
 * Clusters spacing, flattens colors, assembles design tokens,
 * deduplicates components, and organizes patterns manifests.
 */

import valueParser from "postcss-value-parser";
import type {
	ComponentRecipes,
	DesignTokensV2,
	GradientDef,
} from "../../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PageComponentExtraction {
	pageType: string;
	components: Record<string, unknown>;
}

export interface PatternsManifest {
	[pageType: string]: Array<{
		pageId: string;
		visualMd: string;
		screenshots: string[];
	}>;
}

// ---------------------------------------------------------------------------
// Recursive walkers for nested extraction objects
// ---------------------------------------------------------------------------

const MAX_WALK_DEPTH = 10;

/**
 * Walk a nested object, yielding `{ name, value }` for every numeric leaf.
 * String leaves matching `/^\d+(\.\d+)?\s*px$/i` are also parsed to numbers.
 */
export function walkNumericLeaves(
	obj: Record<string, unknown>,
	prefix: string,
	depth = 0,
): Array<{ name: string; value: number }> {
	if (depth > MAX_WALK_DEPTH) return [];
	const results: Array<{ name: string; value: number }> = [];

	for (const [key, val] of Object.entries(obj)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof val === "number" && Number.isFinite(val)) {
			results.push({ name: path, value: val });
		} else if (typeof val === "string") {
			const px = parsePxValue(val);
			if (px !== null) results.push({ name: path, value: px });
		} else if (typeof val === "object" && val !== null && !Array.isArray(val)) {
			results.push(
				...walkNumericLeaves(val as Record<string, unknown>, path, depth + 1),
			);
		}
	}
	return results;
}

/**
 * Walk a nested object, yielding `{ name, value }` for every OKLCH color string.
 */
export function walkOklchLeaves(
	obj: Record<string, unknown>,
	prefix: string,
	depth = 0,
): Array<{ name: string; value: string }> {
	if (depth > MAX_WALK_DEPTH) return [];
	const results: Array<{ name: string; value: string }> = [];

	for (const [key, val] of Object.entries(obj)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof val === "string" && /oklch\s*\(/i.test(val)) {
			results.push({ name: path, value: val });
		} else if (typeof val === "object" && val !== null && !Array.isArray(val)) {
			results.push(
				...walkOklchLeaves(val as Record<string, unknown>, path, depth + 1),
			);
		}
	}
	return results;
}

// ---------------------------------------------------------------------------
// Color flattening
// ---------------------------------------------------------------------------

/**
 * Flatten nested color objects into dot-delimited keys.
 * Agents produce color scales like `gray: { "50": "oklch(...)" }` but the
 * DesignTokensV2 schema expects flat `Record<string, string>`.
 *
 * Walks ALL string leaves (not just OKLCH) so that non-OKLCH values are
 * preserved and caught by the downstream OKLCH validator — giving the agent
 * an actionable retry signal instead of silently dropping colors.
 */
export function flattenColors(
	colors: Record<string, unknown>,
): Record<string, string> {
	const flat: Record<string, string> = {};
	for (const [key, val] of Object.entries(colors)) {
		if (typeof val === "string") {
			flat[key] = val;
		} else if (typeof val === "object" && val !== null) {
			walkStringLeaves(val as Record<string, unknown>, key, flat);
		}
	}
	return flat;
}

function walkStringLeaves(
	obj: Record<string, unknown>,
	prefix: string,
	out: Record<string, string>,
	depth = 0,
): void {
	if (depth > 10) return;
	for (const [key, val] of Object.entries(obj)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof val === "string") {
			out[path] = val;
		} else if (typeof val === "object" && val !== null && !Array.isArray(val)) {
			walkStringLeaves(val as Record<string, unknown>, path, out, depth + 1);
		}
	}
}

// ---------------------------------------------------------------------------
// Spacing flattening
// ---------------------------------------------------------------------------

/**
 * Flatten a potentially nested spacing object into a flat `Record<string, string>`.
 *
 * Agents sometimes produce nested structures like `{ scale: { "0": "0px" } }` but
 * the DesignTokensV2 schema expects flat `Record<string, string>`.
 * Nested objects get dot-delimited keys (e.g., `scale.0 → "0px"`).
 */
export function flattenSpacing(
	spacing: Record<string, unknown>,
	prefix = "",
	depth = 0,
): Record<string, string> {
	if (depth > MAX_WALK_DEPTH) return {};
	const flat: Record<string, string> = {};
	for (const [key, val] of Object.entries(spacing)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof val === "string") {
			flat[path] = val;
		} else if (typeof val === "object" && val !== null && !Array.isArray(val)) {
			Object.assign(
				flat,
				flattenSpacing(val as Record<string, unknown>, path, depth + 1),
			);
		}
		// Skip numbers, booleans, arrays — not valid spacing values
	}
	return flat;
}

/** Parse a px string to a number (used by walkers). */
function parsePxValue(value: string): number | null {
	const match = value.match(/^(\d+(?:\.\d+)?)\s*px$/i);
	return match ? Number.parseFloat(match[1]) : null;
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
 * Cluster spacing values from a single spacing object into a normalized scale.
 *
 * Raw values are snapped to the nearest common scale anchor within tolerance.
 * Returns a sorted record of name→value.
 */
export function clusterSpacing(
	spacing: Record<string, unknown>,
): Record<string, string> {
	const values = new Map<string, number>();

	for (const { name, value } of walkNumericLeaves(spacing, "")) {
		values.set(name, snapToAnchor(value));
	}

	const entries = [...values.entries()].sort((a, b) => a[1] - b[1]);
	const result: Record<string, string> = {};
	for (const [name, px] of entries) {
		result[name] = `${px}px`;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Component deduplication
// ---------------------------------------------------------------------------

/**
 * Simple hash of component properties for deduplication.
 */
function componentKey(properties: Record<string, unknown>): string {
	return JSON.stringify(properties, Object.keys(properties).sort());
}

/**
 * Deduplicate component patterns across pages.
 * Same property hash → single recipe with page-type variants.
 */
export function deduplicateComponents(
	extractions: PageComponentExtraction[],
): ComponentRecipes {
	const recipes: ComponentRecipes = {};
	const seenKeys = new Map<string, string>();

	for (const ext of extractions) {
		if (!ext.components || typeof ext.components !== "object") continue;
		for (const [name, rawProps] of Object.entries(ext.components)) {
			if (typeof rawProps !== "object" || rawProps === null) continue;
			const properties = rawProps as Record<string, unknown>;
			const key = componentKey(properties);
			const existing = seenKeys.get(key);

			if (existing !== undefined) {
				// Same structure seen from a different page type → add variant
				recipes[existing].variants[ext.pageType] = {
					...properties,
					_pageType: ext.pageType,
				};
			} else {
				seenKeys.set(key, name);
				recipes[name] = { base: properties, variants: {} };
			}
		}
	}

	return recipes;
}

// ---------------------------------------------------------------------------
// Design token assembly
// ---------------------------------------------------------------------------

/**
 * Assemble complete design tokens from reconciled parts.
 */
export function assembleDesignTokens(parts: {
	colors: Record<string, string>;
	typography: {
		fontFamily: Record<string, string>;
		fontSize: Record<string, string>;
		fontWeight: Record<string, number>;
	};
	spacing: Record<string, string>;
}): DesignTokensV2 {
	const raw: DesignTokensV2 = {
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
	return raw;
}

/**
 * Move gradient strings (linear-gradient, radial-gradient, conic-gradient)
 * from atomic.colors into the gradients field where they belong.
 */
export function extractGradientsFromColors(
	tokens: DesignTokensV2,
): DesignTokensV2 {
	const gradients: Record<string, GradientDef> = { ...tokens.gradients };
	const cleanColors: Record<string, string> = {};

	for (const [name, value] of Object.entries(tokens.atomic.colors)) {
		if (/^(linear|radial|conic)-gradient\s*\(/i.test(value)) {
			if (!(name in gradients)) {
				gradients[name] = parseGradientString(value);
			}
		} else {
			cleanColors[name] = value;
		}
	}

	return {
		...tokens,
		atomic: { ...tokens.atomic, colors: cleanColors },
		gradients,
	};
}

const GRADIENT_RE = /^(linear|radial|conic)-gradient\s*\(/i;

/**
 * Normalize a gradients record: raw CSS gradient strings → GradientDef objects.
 *
 * Agents sometimes put raw CSS strings (e.g. `"linear-gradient(180deg, ...)"`)
 * directly into the gradients field. The Zod schema expects structured
 * `GradientDef` objects. Values that are already GradientDef-shaped pass through.
 */
export function normalizeGradients(
	gradients: Record<string, unknown>,
): Record<string, GradientDef> {
	const result: Record<string, GradientDef> = {};
	for (const [name, value] of Object.entries(gradients)) {
		if (typeof value === "string" && GRADIENT_RE.test(value)) {
			result[name] = parseGradientString(value);
		} else if (
			typeof value === "object" &&
			value !== null &&
			"type" in value &&
			"stops" in value
		) {
			result[name] = value as GradientDef;
		}
		// Skip non-gradient values entirely
	}
	return result;
}

const ANGLE_UNITS = new Set(["deg", "rad", "turn", "grad"]);
const POSITION_UNITS = new Set([
	"%",
	"px",
	"em",
	"rem",
	"vw",
	"vh",
	"vmin",
	"vmax",
]);

/** Parse a CSS gradient string into a GradientDef using postcss-value-parser. */
function parseGradientString(raw: string): GradientDef {
	const parsed = valueParser(raw);
	const fn = parsed.nodes.find(
		(
			n,
		): n is ReturnType<typeof valueParser>["nodes"][number] & {
			type: "function";
			nodes: ReturnType<typeof valueParser>["nodes"];
		} => n.type === "function",
	);
	if (!fn) return { type: "linear", stops: [] };

	const type = fn.value.replace(/-gradient$/i, "").toLowerCase();
	const groups = splitByComma(fn.nodes);

	let angle: string | undefined;
	let stopStart = 0;

	if (type === "linear" && groups.length > 0) {
		const first = trimSpaceNodes(groups[0]);
		const text = valueParser.stringify(first);
		const dim =
			first.length === 1 && first[0].type === "word"
				? valueParser.unit(first[0].value)
				: false;
		if (
			(dim && ANGLE_UNITS.has(dim.unit.toLowerCase())) ||
			text.startsWith("to ")
		) {
			angle = text;
			stopStart = 1;
		}
	}

	const stops = groups.slice(stopStart).map(parseStopNodes);
	return { type, ...(angle ? { angle } : {}), stops };
}

type VPNode = ReturnType<typeof valueParser>["nodes"][number];

/** Split postcss-value-parser nodes on comma dividers. */
function splitByComma(nodes: VPNode[]): VPNode[][] {
	const groups: VPNode[][] = [];
	let current: VPNode[] = [];
	for (const node of nodes) {
		if (node.type === "div" && node.value === ",") {
			groups.push(current);
			current = [];
		} else {
			current.push(node);
		}
	}
	if (current.length > 0) groups.push(current);
	return groups;
}

/** Parse a group of nodes as a gradient stop (color + optional position). */
function parseStopNodes(nodes: VPNode[]): { color: string; position?: string } {
	const trimmed = trimSpaceNodes(nodes);
	if (trimmed.length === 0) return { color: "" };

	const last = trimmed[trimmed.length - 1];
	if (last.type === "word" && trimmed.length > 1) {
		const dim = valueParser.unit(last.value);
		if (dim && POSITION_UNITS.has(dim.unit.toLowerCase())) {
			const colorNodes = trimSpaceNodes(trimmed.slice(0, -1));
			return {
				color: valueParser.stringify(colorNodes),
				position: last.value,
			};
		}
	}

	return { color: valueParser.stringify(trimmed) };
}

/** Trim leading/trailing space nodes. */
function trimSpaceNodes(nodes: VPNode[]): VPNode[] {
	let start = 0;
	let end = nodes.length;
	while (start < end && nodes[start].type === "space") start++;
	while (end > start && nodes[end - 1].type === "space") end--;
	return nodes.slice(start, end);
}

// ---------------------------------------------------------------------------
// Deep merge
// ---------------------------------------------------------------------------

/** Deep merge target with source, preferring source values for conflicts. */
export function deepMerge(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...target };
	for (const [key, value] of Object.entries(source)) {
		const existing = result[key];
		if (
			typeof existing === "object" &&
			existing !== null &&
			!Array.isArray(existing) &&
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value)
		) {
			result[key] = deepMerge(
				existing as Record<string, unknown>,
				value as Record<string, unknown>,
			);
		} else if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Normalize raw tokens (full pipeline)
// ---------------------------------------------------------------------------

/**
 * Run the full normalize chain on raw agent output.
 *
 * scaffold → deepMerge → flattenColors → flattenSpacing → clusterSpacing
 * → normalizeGradients → extractGradientsFromColors
 *
 * Returns a DesignTokensV2 ready for Zod validation. Pure (no IO).
 */
export function normalizeRawTokens(
	rawTokens: Record<string, unknown>,
): DesignTokensV2 {
	const scaffold = assembleDesignTokens({
		colors: {},
		typography: { fontFamily: {}, fontSize: {}, fontWeight: {} },
		spacing: {},
	});
	const merged = deepMerge(
		scaffold as unknown as Record<string, unknown>,
		rawTokens,
	);

	const atomic = merged.atomic as Record<string, unknown> | undefined;
	if (atomic?.colors && typeof atomic.colors === "object") {
		atomic.colors = flattenColors(atomic.colors as Record<string, unknown>);
	}
	if (atomic?.spacing && typeof atomic.spacing === "object") {
		const flat = flattenSpacing(atomic.spacing as Record<string, unknown>);
		atomic.spacing = clusterSpacing(flat);
	}
	if (merged.gradients && typeof merged.gradients === "object") {
		merged.gradients = normalizeGradients(
			merged.gradients as Record<string, unknown>,
		);
	}

	return extractGradientsFromColors(merged as unknown as DesignTokensV2);
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

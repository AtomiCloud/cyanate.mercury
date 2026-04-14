/**
 * Pure: Phase 5 (build-heuristics) logic.
 *
 * Builds compact structure maps per page type and overall heuristics for the
 * classify segment to consume.
 *
 * All functions are pure (data in → data out). No IO.
 */

import { looksLikeImageUrl } from "./download.js";
import type { PreparedPage } from "./ingest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PageTypeHeuristic {
	pagetype: string;
	pageCount: number;
	avgContentLength: number;
	topLevelFieldCount: number;
	richestSampleUrl: string;
	simplestSampleUrl: string;
}

export interface Heuristics {
	totalPages: number;
	totalPageTypes: number;
	pageTypes: PageTypeHeuristic[];
	fieldFrequency: Record<string, string[]>;
}

export interface StructureMap {
	pagetype: string;
	sampleUrl: string;
	tree: string;
}

// ---------------------------------------------------------------------------
// buildStructureMaps
// ---------------------------------------------------------------------------

/**
 * Build a compact structural tree for each page type using its richest sample.
 */
export function buildStructureMaps(pages: PreparedPage[]): StructureMap[] {
	const byType = groupByPagetype(pages);
	const maps: StructureMap[] = [];

	for (const [pagetype, typePages] of Object.entries(byType)) {
		const richest = pickRichest(typePages);
		if (!richest) continue;

		const tree = renderTree(richest.content, 0);
		maps.push({
			pagetype,
			sampleUrl: richest.url,
			tree,
		});
	}

	return maps;
}

// ---------------------------------------------------------------------------
// renderTree
// ---------------------------------------------------------------------------

/**
 * Render a JSON-ish value as a compact indented tree.
 *
 *   name (string, 12 chars)
 *   sections (array[3])
 *     heading (string, 10 chars)
 */
function renderTree(value: unknown, indent: number): string {
	if (Array.isArray(value)) return renderArrayTree(value, indent);
	if (value !== null && typeof value === "object") {
		return renderObjectTree(value as Record<string, unknown>, indent);
	}
	return "";
}

function renderObjectTree(
	value: Record<string, unknown>,
	indent: number,
): string {
	const pad = "  ".repeat(indent);
	const lines: string[] = [];
	for (const [key, v] of Object.entries(value)) {
		const { label, hasChildren } = describeValue(v);
		lines.push(`${pad}${key} (${label})`);
		if (hasChildren) {
			const child = renderTree(v, indent + 1);
			if (child) lines.push(child);
		}
	}
	return lines.join("\n");
}

function renderArrayTree(value: unknown[], indent: number): string {
	if (value.length === 0) return "";
	const first = value[0];
	const { hasChildren } = describeValue(first);
	if (!hasChildren) return "";
	return renderTree(first, indent);
}

function describeValue(value: unknown): {
	label: string;
	hasChildren: boolean;
} {
	if (value === null) return { label: "null", hasChildren: false };
	if (typeof value === "string") {
		if (isLocalImagePath(value) || looksLikeImageUrl(value)) {
			return { label: "local-image", hasChildren: false };
		}
		return { label: `string, ${value.length} chars`, hasChildren: false };
	}
	if (typeof value === "number") return { label: "number", hasChildren: false };
	if (typeof value === "boolean")
		return { label: "boolean", hasChildren: false };
	if (Array.isArray(value)) {
		return { label: `array[${value.length}]`, hasChildren: value.length > 0 };
	}
	if (typeof value === "object") {
		return { label: "object", hasChildren: true };
	}
	return { label: typeof value, hasChildren: false };
}

function isLocalImagePath(value: string): boolean {
	return value.startsWith("images/");
}

// ---------------------------------------------------------------------------
// buildHeuristicsData
// ---------------------------------------------------------------------------

/**
 * Build the full Heuristics artifact.
 */
export function buildHeuristicsData(pages: PreparedPage[]): Heuristics {
	const byType = groupByPagetype(pages);
	const pageTypes: PageTypeHeuristic[] = [];

	for (const [pagetype, typePages] of Object.entries(byType)) {
		if (typePages.length === 0) continue;

		const lengths = typePages.map((p) => contentCharCount(p.content));
		const avgContentLength = Math.round(
			lengths.reduce((sum, n) => sum + n, 0) / lengths.length,
		);

		const richest = pickRichest(typePages);
		const simplest = pickSimplest(typePages);
		const topLevelFieldCount = richest
			? Object.keys(richest.content).length
			: 0;

		pageTypes.push({
			pagetype,
			pageCount: typePages.length,
			avgContentLength,
			topLevelFieldCount,
			richestSampleUrl: richest?.url ?? "",
			simplestSampleUrl: simplest?.url ?? "",
		});
	}

	const fieldFrequency = buildFieldFrequency(pages);

	return {
		totalPages: pages.length,
		totalPageTypes: pageTypes.length,
		pageTypes,
		fieldFrequency,
	};
}

// ---------------------------------------------------------------------------
// Grouping + sample selection
// ---------------------------------------------------------------------------

function groupByPagetype(
	pages: PreparedPage[],
): Record<string, PreparedPage[]> {
	const groups: Record<string, PreparedPage[]> = {};
	for (const page of pages) {
		if (!groups[page.pagetype]) groups[page.pagetype] = [];
		groups[page.pagetype].push(page);
	}
	return groups;
}

function pickRichest(pages: PreparedPage[]): PreparedPage | undefined {
	if (pages.length === 0) return undefined;
	let best = pages[0];
	let bestCount = contentCharCount(best.content);
	for (const page of pages) {
		const count = contentCharCount(page.content);
		if (count > bestCount) {
			best = page;
			bestCount = count;
		}
	}
	return best;
}

function pickSimplest(pages: PreparedPage[]): PreparedPage | undefined {
	if (pages.length === 0) return undefined;
	let best = pages[0];
	let bestCount = contentCharCount(best.content);
	for (const page of pages) {
		const count = contentCharCount(page.content);
		if (count < bestCount) {
			best = page;
			bestCount = count;
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// Character counting
// ---------------------------------------------------------------------------

/** Count total character content (strings) across a nested object. */
export function contentCharCount(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (Array.isArray(value)) {
		return value.reduce((sum: number, v) => sum + contentCharCount(v), 0);
	}
	if (value !== null && typeof value === "object") {
		return Object.values(value as Record<string, unknown>).reduce(
			(sum: number, v) => sum + contentCharCount(v),
			0,
		);
	}
	return 0;
}

// ---------------------------------------------------------------------------
// buildFieldFrequency
// ---------------------------------------------------------------------------

/**
 * Map field names → sorted list of page types that have them as top-level keys.
 * Used by classify to detect global fields (e.g., "header" appearing in all types).
 */
export function buildFieldFrequency(
	pages: PreparedPage[],
): Record<string, string[]> {
	const fieldToTypes: Record<string, Set<string>> = {};

	for (const page of pages) {
		for (const field of Object.keys(page.content)) {
			if (!fieldToTypes[field]) fieldToTypes[field] = new Set();
			fieldToTypes[field].add(page.pagetype);
		}
	}

	const result: Record<string, string[]> = {};
	for (const [field, types] of Object.entries(fieldToTypes)) {
		result[field] = [...types].sort();
	}
	return result;
}

/**
 * Pure: per-page value-normalization helpers (phase 2 — `per-page-value-normalize`).
 *
 * After the classify segment was restructured into 6 per-page phases, this file
 * only contains normalization logic. The old role-classify / sub-classify
 * helpers were deleted; their replacement lives under `phases/*` and operates
 * on `Block[]` rather than per-leaf entries.
 */

import { createHash } from "node:crypto";
import { extractJsonObject } from "../../lib/json-extract.js";
import type { PreparedPage } from "../prepare/ingest.js";
import type { UnitMissing } from "./fan-out.js";
import { collectAllLeafPaths, deepEqual, readPath } from "./lib/path-utils.js";
import type { ClassifyUnit } from "./types.js";

function extractObject(text: string): Record<string, unknown> | null {
	const parsed = extractJsonObject(text);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NormType =
	| "string"
	| "number"
	| "boolean"
	| "datetime"
	| "currency"
	| "string[]"
	| "null"
	| "object"
	| "array"
	| "unchanged";

export const VALID_NORM_TYPES: readonly NormType[] = [
	"string",
	"number",
	"boolean",
	"datetime",
	"currency",
	"string[]",
	"null",
	"object",
	"array",
	"unchanged",
];

export interface NormalizationEntry {
	original: unknown;
	normalized: unknown;
	type: NormType;
}

export interface PageNormalization {
	url: string;
	pagetype: string;
	entries: Record<string, NormalizationEntry>;
}

// ---------------------------------------------------------------------------
// Unit construction
// ---------------------------------------------------------------------------

/** Deterministic hash for a page URL (used for input subdirectories). */
export function classifyUnitHash(url: string): string {
	return createHash("sha1").update(url).digest("hex").slice(0, 12);
}

/** Build fan-out units from prepared content — one per page. */
export function getClassifyUnits(pages: PreparedPage[]): ClassifyUnit[] {
	return pages.map((page) => ({
		id: classifyUnitHash(page.url),
		page,
	}));
}

// ---------------------------------------------------------------------------
// Parse + validate
// ---------------------------------------------------------------------------

/** Parse agent output into PageNormalization. Returns null on parse failure. */
export function parseNormalizationFromAgent(
	output: string,
	page: PreparedPage,
): PageNormalization | null {
	const json = extractObject(output);
	if (!json) return null;

	const entries = json.entries;
	if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
		return null;
	}

	const validated: Record<string, NormalizationEntry> = {};
	for (const [path, raw] of Object.entries(
		entries as Record<string, unknown>,
	)) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const entry = raw as Record<string, unknown>;
		if (
			!("original" in entry) ||
			!("normalized" in entry) ||
			!("type" in entry)
		)
			continue;
		if (typeof entry.type !== "string") continue;
		validated[path] = entry as unknown as NormalizationEntry;
	}

	if (Object.keys(validated).length === 0) return null;

	return {
		url: page.url,
		pagetype: page.pagetype,
		entries: validated,
	};
}

/**
 * Exhaustive structural check for a PageNormalization against its source content.
 *
 * Pure. Used by both the in-process validator and the `mecury check normalization`
 * CLI so the agent can self-verify before declaring done.
 */
export interface NormalizationCheck {
	valid: boolean;
	expectedPaths: string[];
	actualPaths: string[];
	/** Paths present in expected (leaves of content) but missing from entries. */
	missing: string[];
	/** Paths present in entries but not expected (not a leaf of content). */
	extra: string[];
	/** Human-readable errors for entries whose declared type disagrees with the normalized value shape. */
	typeErrors: string[];
	/** Human-readable errors for entries whose `original` disagrees with the value at that path in `content`. */
	roundTripErrors: string[];
}

function isNullish(v: unknown): boolean {
	return v === null || v === undefined;
}

function checkNumericShape(
	path: string,
	entry: NormalizationEntry,
): string | null {
	if (isNullish(entry.normalized)) return null;
	if (typeof entry.normalized !== "number") {
		return `Entry at "${path}" declares type "${entry.type}" but normalized value is ${typeof entry.normalized}`;
	}
	return null;
}

function checkBooleanShape(
	path: string,
	entry: NormalizationEntry,
): string | null {
	if (isNullish(entry.normalized)) return null;
	if (typeof entry.normalized !== "boolean") {
		return `Entry at "${path}" declares type "boolean" but normalized value is ${typeof entry.normalized}`;
	}
	return null;
}

function checkDatetimeShape(
	path: string,
	entry: NormalizationEntry,
): string | null {
	if (typeof entry.normalized !== "string") return null;
	const d = new Date(entry.normalized);
	if (Number.isNaN(d.getTime())) {
		return `Entry at "${path}" declares type "datetime" but normalized value is not a valid date`;
	}
	return null;
}

function checkEntryTypeShape(
	path: string,
	entry: NormalizationEntry,
): string | null {
	if (!VALID_NORM_TYPES.includes(entry.type)) {
		return `Entry at "${path}" has invalid type "${String(entry.type)}"`;
	}
	if (entry.type === "number" || entry.type === "currency") {
		return checkNumericShape(path, entry);
	}
	if (entry.type === "boolean") {
		return checkBooleanShape(path, entry);
	}
	if (entry.type === "string[]" && !Array.isArray(entry.normalized)) {
		return `Entry at "${path}" declares type "string[]" but normalized value is not an array`;
	}
	if (entry.type === "datetime") {
		return checkDatetimeShape(path, entry);
	}
	return null;
}

/**
 * Compute a diagnostic report for a PageNormalization vs. its source content.
 */
export function checkNormalization(
	norm: PageNormalization,
	content: Record<string, unknown>,
): NormalizationCheck {
	const expectedPaths = collectAllLeafPaths(content);
	const actualPaths = Object.keys(norm.entries);
	const expectedSet = new Set(expectedPaths);
	const actualSet = new Set(actualPaths);

	const missing = expectedPaths.filter((p) => !actualSet.has(p));
	const extra = actualPaths.filter((p) => !expectedSet.has(p));

	const typeErrors: string[] = [];
	const roundTripErrors: string[] = [];

	for (const [path, entry] of Object.entries(norm.entries)) {
		if (!entry || typeof entry !== "object") {
			typeErrors.push(`Entry at "${path}" is not an object`);
			continue;
		}
		const typeErr = checkEntryTypeShape(path, entry);
		if (typeErr) typeErrors.push(typeErr);

		if (expectedSet.has(path)) {
			const actual = readPath(content, path);
			if (!deepEqual(entry.original, actual)) {
				roundTripErrors.push(
					`Entry at "${path}": original ${JSON.stringify(entry.original)} does not match content value ${JSON.stringify(actual)}`,
				);
			}
		}
	}

	return {
		valid:
			missing.length === 0 &&
			extra.length === 0 &&
			typeErrors.length === 0 &&
			roundTripErrors.length === 0,
		expectedPaths,
		actualPaths,
		missing,
		extra,
		typeErrors,
		roundTripErrors,
	};
}

// ---------------------------------------------------------------------------
// Apply normalizations — pure
// ---------------------------------------------------------------------------

/**
 * Clone page content and apply every non-trivial normalization entry.
 * Skips "unchanged" / "object" / "array" / "null" entries — those are type
 * annotations, not transformations.
 */
export function applyAllNormalizations(
	content: Record<string, unknown>,
	normalization: PageNormalization,
): Record<string, unknown> {
	const cloned = structuredClone(content);
	for (const [path, entry] of Object.entries(normalization.entries)) {
		if (
			entry.type === "unchanged" ||
			entry.type === "object" ||
			entry.type === "array" ||
			entry.type === "null"
		) {
			continue;
		}
		setPathValue(cloned, path, entry.normalized);
	}
	return cloned;
}

// ---------------------------------------------------------------------------
// Phase-specific findMissing helpers
// ---------------------------------------------------------------------------

/**
 * Build UnitMissing entries for units with no result in the results map.
 * Pulls specific failure reasons from unitErrors when available, so the retry
 * prompt sees the actual validator/parse error instead of a generic stub.
 */
function buildUnitMissing<T>(
	units: ClassifyUnit[],
	results: Map<string, T>,
	unitErrors: Map<string, string>,
): UnitMissing<ClassifyUnit>[] {
	const missing: UnitMissing<ClassifyUnit>[] = [];
	for (const unit of units) {
		if (results.has(unit.id)) continue;
		missing.push({
			unit,
			unitId: unit.id,
			paths: [],
			rejectionContext:
				unitErrors.get(unit.id) ??
				`No result returned for page "${unit.page.url}"`,
		});
	}
	return missing;
}

/** findMissing for the value-normalize fan-out. */
export function findMissingNormalization(
	results: Map<string, PageNormalization>,
	units: ClassifyUnit[],
	unitErrors: Map<string, string>,
): UnitMissing<ClassifyUnit>[] {
	return buildUnitMissing(units, results, unitErrors);
}

// ---------------------------------------------------------------------------
// Path mutation helpers (shared by phases that transform content trees)
// ---------------------------------------------------------------------------

/** Set a value at a dot-path with array index support. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: recursive path setting with array index and object key handling
function setPathValue(
	obj: Record<string, unknown>,
	path: string,
	value: unknown,
): void {
	const segments = parsePathSegments(path);
	if (segments.length === 0) return;

	let current: unknown = obj;
	for (let i = 0; i < segments.length - 1; i++) {
		const seg = segments[i];
		if (current === null || current === undefined) return;
		if (typeof seg === "number") {
			if (!Array.isArray(current)) return;
			current = current[seg];
		} else {
			if (typeof current !== "object" || Array.isArray(current)) return;
			current = (current as Record<string, unknown>)[seg];
		}
	}

	const lastSeg = segments[segments.length - 1];
	if (current === null || current === undefined) return;
	if (typeof lastSeg === "number") {
		if (Array.isArray(current)) current[lastSeg] = value;
	} else {
		if (typeof current === "object" && !Array.isArray(current)) {
			(current as Record<string, unknown>)[lastSeg] = value;
		}
	}
}

/** Parse "items[0].name" into ["items", 0, "name"]. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: path parser with bracket notation and array index support
function parsePathSegments(path: string): Array<string | number> {
	const segments: Array<string | number> = [];
	let current = "";

	for (let i = 0; i < path.length; i++) {
		const ch = path[i];
		if (ch === ".") {
			if (current) segments.push(current);
			current = "";
		} else if (ch === "[") {
			if (current) segments.push(current);
			current = "";
			const end = path.indexOf("]", i + 1);
			if (end === -1) {
				current = path.slice(i);
				break;
			}
			segments.push(Number.parseInt(path.slice(i + 1, end), 10));
			i = end;
		} else {
			current += ch;
		}
	}
	if (current) segments.push(current);
	return segments;
}

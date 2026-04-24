/**
 * Shared helpers for the classify segment.
 *
 * Pared down after the fold-chrome reset. Stage 2 (per-page chrome classify)
 * reintroduces `readPath` + `isLeaf` so the validator can resolve candidate
 * chrome paths on a page and assert they terminate at a leaf.
 * `collectAllLeafPaths` is deferred to Stage 3 (harmonize / coverage).
 */

import { createHash } from "node:crypto";

/**
 * Collapse positional array indices to the wildcard `[*]`. See `harmonize.md`
 * for why the harmonize digest keys on collapsed paths: `share_buttons[3]`
 * on one page and `share_buttons[0]` on another are the same candidate; the
 * scraper's slot number is not semantically meaningful across pages.
 */
export function collapseArrayIndices(path: string): string {
	return path.replace(/\[\d+\]/g, "[*]");
}

/** True if the path contains at least one `[*]` segment. */
export function pathHasWildcard(path: string): boolean {
	return path.includes("[*]");
}

/** Count the number of `[*]` wildcard markers in a path. */
export function countWildcards(path: string): number {
	const m = path.match(/\[\*\]/g);
	return m ? m.length : 0;
}

/** Deterministic hash for a page URL (used for classify input subdirectories). */
export function classifyUnitHash(url: string): string {
	return createHash("sha1").update(url).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Path parsing — accepts dot + bracket notation (e.g. "header.links[0].href")
// ---------------------------------------------------------------------------

/**
 * Split a classifier path into its segments. Arrays use bracket notation so
 * numeric keys stay unambiguous.
 *
 *   "header.nav.links[0].href" → ["header", "nav", "links", 0, "href"]
 *   "items[2]"                 → ["items", 2]
 *   "root"                     → ["root"]
 *   ""                         → []
 */
function splitPath(path: string): Array<string | number> {
	const out: Array<string | number> = [];
	if (!path) return out;
	for (const raw of path.split(".")) {
		if (!raw) continue;
		const match = raw.match(/^([^[]*)((?:\[\d+\])*)$/);
		if (!match) {
			out.push(raw);
			continue;
		}
		const [, key, brackets] = match;
		if (key) out.push(key);
		for (const m of brackets.matchAll(/\[(\d+)\]/g)) out.push(Number(m[1]));
	}
	return out;
}

type StepResult = { found: true; value: unknown } | { found: false };

const MISS: StepResult = { found: false };

function stepInto(cursor: unknown, part: string | number): StepResult {
	if (cursor === null || cursor === undefined) return MISS;
	if (typeof part === "number") {
		if (!Array.isArray(cursor)) return MISS;
		if (part < 0 || part >= cursor.length) return MISS;
		return { found: true, value: cursor[part] };
	}
	if (typeof cursor !== "object" || Array.isArray(cursor)) return MISS;
	const obj = cursor as Record<string, unknown>;
	if (!(part in obj)) return MISS;
	return { found: true, value: obj[part] };
}

/**
 * Resolve a dot-path against a JSON-shaped value. Returns `undefined` when any
 * segment is missing (JSON can't store `undefined`, so this is unambiguous:
 * anything else — including `null` — means the path exists).
 */
export function readPath(value: unknown, path: string): unknown {
	let cursor: unknown = value;
	for (const part of splitPath(path)) {
		const step = stepInto(cursor, part);
		if (!step.found) return undefined;
		cursor = step.value;
	}
	return cursor;
}

/**
 * A value is a leaf if a CMS editor would not traverse into it: primitives,
 * `null`, empty objects, and empty arrays. Non-empty objects / arrays are
 * containers and are rejected when a classifier points at them — Stage 2
 * forbids subtree merging; the classifier must pick the individual leaves.
 */
export function isLeaf(value: unknown): boolean {
	if (value === null) return true;
	const t = typeof value;
	if (t === "string" || t === "number" || t === "boolean") return true;
	if (Array.isArray(value)) return value.length === 0;
	if (t === "object") return Object.keys(value as object).length === 0;
	return false;
}

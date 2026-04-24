/**
 * Materialize per-page chrome against a composed rename table.
 *
 * Pure functions. No I/O, no filesystem. The `harmonize-materialize` phase
 * wraps these to produce per-page `chrome.aligned/<hash>.json` +
 * `<hash>.reverse.json` and a pagetype-wide `chrome.compressed.json` debug
 * view. See `plans/optimized-wondering-gem.md` §Part 1 for the full design.
 *
 * Core operation: for every leaf in a page's chrome.json, look up its
 * wildcard-generalized path in the rename table. If renamed, place the value
 * at the rewritten concrete path in `aligned`; record the inverse in
 * `reverseMap`. If both source and target exist on the same page, handle
 * per the conflict policy:
 *
 *   - same value → `dedupeNotes` entry; keep canonical's value
 *   - different values → `conflicts` entry; keep canonical's value, preserve
 *     source value in the conflict record
 *
 * Never halts. The phase does a round-trip assertion on the clean renames in
 * `reverseMap` (those are strictly invertible by construction).
 */

import type { RenameTable } from "./harmonize-types.js";
import {
	collapseArrayIndices,
	countWildcards,
	isLeaf,
	readPath,
} from "./path-utils.js";

export interface LeafInfo {
	concretePath: string;
	generalPath: string;
	value: unknown;
}

export interface DedupeNote {
	canonical: string;
	sourcePath: string;
	value: unknown;
}

export interface ConflictNote {
	canonical: string;
	sourcePath: string;
	canonicalValue: unknown;
	sourceValue: unknown;
	reason: string;
}

export interface MaterializeResult {
	aligned: unknown;
	/** Per-page reverse: canonical concrete path → original source concrete path. Clean renames only (no conflicts/dedupes). */
	reverseMap: Record<string, string>;
	dedupeNotes: DedupeNote[];
	conflicts: ConflictNote[];
}

export interface CompressedChromeEntry {
	distinctValues: Array<{ value: unknown; pageHashes: string[] }>;
	presentOn: string[];
}

export interface CompressedChrome {
	_meta: {
		totalPages: number;
		totalPaths: number;
		conflictSummary: {
			pagesWithConflicts: number;
			pagesWithDedupes: number;
		};
	};
	paths: Record<string, CompressedChromeEntry>;
}

export interface RoundTripResult {
	ok: boolean;
	mismatches: Array<{
		canonical: string;
		source: string;
		alignedValue: unknown;
		originalValue: unknown;
	}>;
}

// ---------------------------------------------------------------------------
// Leaf enumeration
// ---------------------------------------------------------------------------

/**
 * DFS walk of a JSON-shaped value collecting leaf paths. A "leaf" matches
 * `isLeaf` from path-utils (primitives, null, empty arrays/objects). Each
 * leaf is paired with its wildcard-generalized form for rename lookup.
 */
export function enumerateLeafPaths(obj: unknown): LeafInfo[] {
	const out: LeafInfo[] = [];
	walk(obj, "", out);
	return out;
}

function walk(node: unknown, prefix: string, out: LeafInfo[]): void {
	if (isLeaf(node)) {
		out.push({
			concretePath: prefix,
			generalPath: collapseArrayIndices(prefix),
			value: node,
		});
		return;
	}
	if (Array.isArray(node)) {
		for (let i = 0; i < node.length; i++) {
			const child = prefix === "" ? `[${i}]` : `${prefix}[${i}]`;
			walk(node[i], child, out);
		}
		return;
	}
	if (typeof node === "object" && node !== null) {
		const rec = node as Record<string, unknown>;
		for (const key of Object.keys(rec)) {
			const child = prefix === "" ? key : `${prefix}.${key}`;
			walk(rec[key], child, out);
		}
	}
}

// ---------------------------------------------------------------------------
// Rename table indexing + application to a concrete path
// ---------------------------------------------------------------------------

export interface RenameIndexEntry {
	to: string;
	reason: string;
}

/**
 * Index a flat rename table by `from` (wildcard-generalized path).
 * Throws on duplicate `from` — compose layer should prevent this.
 */
export function indexRenameTable(
	table: RenameTable,
): Map<string, RenameIndexEntry> {
	const m = new Map<string, RenameIndexEntry>();
	for (const entry of table) {
		if (m.has(entry.from)) {
			throw new Error(
				`indexRenameTable: duplicate from "${entry.from}" in rename table`,
			);
		}
		m.set(entry.from, { to: entry.to, reason: entry.reason });
	}
	return m;
}

/**
 * Apply a wildcard rename to a concrete source path. Preserves concrete
 * array indices positionally: the k-th `[*]` in `from` binds to the k-th
 * `[N]` in `concreteSource`, and the same indices are substituted into the
 * k-th `[*]` of `to`.
 *
 * Requires that `from` and `to` have the same number of `[*]` markers and
 * that `concreteSource`'s segments match `from`'s shape.
 */
export function applyWildcardRename(
	concreteSource: string,
	from: string,
	to: string,
): string {
	const fromStars = countWildcards(from);
	const toStars = countWildcards(to);
	if (fromStars !== toStars) {
		throw new Error(
			`applyWildcardRename: wildcard count mismatch — from="${from}" has ${fromStars}, to="${to}" has ${toStars}`,
		);
	}
	if (collapseArrayIndices(concreteSource) !== from) {
		throw new Error(
			`applyWildcardRename: concrete path "${concreteSource}" does not match from pattern "${from}"`,
		);
	}
	// Extract concrete indices from concreteSource in positional order.
	const indices: number[] = [];
	for (const m of concreteSource.matchAll(/\[(\d+)\]/g)) {
		indices.push(Number(m[1]));
	}
	// Substitute into `to` in order.
	let i = 0;
	return to.replace(/\[\*\]/g, () => `[${indices[i++]}]`);
}

// ---------------------------------------------------------------------------
// Set value at concrete path in a growing object
// ---------------------------------------------------------------------------

type PathSegment =
	| { kind: "key"; value: string }
	| { kind: "index"; value: number };

function splitPathSegments(path: string): PathSegment[] {
	const segs: PathSegment[] = [];
	if (!path) return segs;
	for (const raw of path.split(".")) {
		if (!raw) continue;
		const match = raw.match(/^([^[]*)((?:\[\d+\])*)$/);
		if (!match) {
			segs.push({ kind: "key", value: raw });
			continue;
		}
		const [, key, brackets] = match;
		if (key) segs.push({ kind: "key", value: key });
		for (const m of brackets.matchAll(/\[(\d+)\]/g)) {
			segs.push({ kind: "index", value: Number(m[1]) });
		}
	}
	return segs;
}

/**
 * Place `value` at `concretePath` in the object, creating intermediate
 * containers as needed. Mutates `root` in place (the caller owns it) and
 * returns root for chaining.
 *
 * Intermediate shape is inferred from the next segment: if it's a key,
 * intermediate is `{}`; if it's an index, intermediate is `[]`.
 */
export function setAtPath(
	root: Record<string, unknown> | unknown[],
	concretePath: string,
	value: unknown,
): void {
	const segs = splitPathSegments(concretePath);
	if (segs.length === 0) {
		throw new Error("setAtPath: empty path");
	}
	let cursor: Record<string, unknown> | unknown[] = root;
	for (let i = 0; i < segs.length - 1; i++) {
		const seg = segs[i];
		const next = segs[i + 1];
		const needContainer =
			next.kind === "index"
				? ([] as unknown[])
				: ({} as Record<string, unknown>);
		if (seg.kind === "key") {
			const obj = cursor as Record<string, unknown>;
			if (obj[seg.value] === undefined) {
				obj[seg.value] = needContainer;
			}
			cursor = obj[seg.value] as Record<string, unknown> | unknown[];
		} else {
			const arr = cursor as unknown[];
			if (arr[seg.value] === undefined) {
				arr[seg.value] = needContainer;
			}
			cursor = arr[seg.value] as Record<string, unknown> | unknown[];
		}
	}
	const last = segs[segs.length - 1];
	if (last.kind === "key") {
		(cursor as Record<string, unknown>)[last.value] = value;
	} else {
		(cursor as unknown[])[last.value] = value;
	}
}

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

/**
 * Apply a rename table (flat, wildcard-bearing) to a chrome object.
 * Produces:
 *   - `aligned`: the chrome tree with every leaf placed at its canonical path
 *   - `reverseMap`: invertible mappings (canonical concrete path → source concrete path) for clean renames only
 *   - `dedupeNotes`: cases where source and target both existed with the same value
 *   - `conflicts`: cases where source and target both existed with different values
 *
 * Never throws; conflicts are recorded and returned. The phase-level
 * round-trip assertion verifies reverseMap entries invert correctly — that
 * is the correctness invariant for clean renames.
 */
interface TargetedLeaf {
	leaf: LeafInfo;
	canonicalConcrete: string;
}

interface MaterializeState {
	aligned: Record<string, unknown>;
	reverseMap: Record<string, string>;
	dedupeNotes: DedupeNote[];
	conflicts: ConflictNote[];
	handledAsTarget: Set<string>;
	placedCanonicals: Set<string>;
}

export function applyRenameToChrome(
	chrome: unknown,
	renameIndex: Map<string, RenameIndexEntry>,
): MaterializeResult {
	const { targeted, untouchedByPath } = partitionLeaves(chrome, renameIndex);
	const state: MaterializeState = {
		aligned: {},
		reverseMap: {},
		dedupeNotes: [],
		conflicts: [],
		handledAsTarget: new Set(),
		placedCanonicals: new Set(),
	};

	for (const t of targeted) {
		processTargeted(t, state, untouchedByPath);
	}

	for (const [path, leaf] of untouchedByPath.entries()) {
		if (state.handledAsTarget.has(path)) continue;
		setAtPath(state.aligned, path, leaf.value);
	}

	return {
		aligned: state.aligned,
		reverseMap: state.reverseMap,
		dedupeNotes: state.dedupeNotes,
		conflicts: state.conflicts,
	};
}

function partitionLeaves(
	chrome: unknown,
	renameIndex: Map<string, RenameIndexEntry>,
): { targeted: TargetedLeaf[]; untouchedByPath: Map<string, LeafInfo> } {
	const targeted: TargetedLeaf[] = [];
	const untouchedByPath = new Map<string, LeafInfo>();
	for (const leaf of enumerateLeafPaths(chrome)) {
		const rename = renameIndex.get(leaf.generalPath);
		if (!rename) {
			untouchedByPath.set(leaf.concretePath, leaf);
			continue;
		}
		targeted.push({
			leaf,
			canonicalConcrete: applyWildcardRename(
				leaf.concretePath,
				leaf.generalPath,
				rename.to,
			),
		});
	}
	return { targeted, untouchedByPath };
}

function processTargeted(
	t: TargetedLeaf,
	state: MaterializeState,
	untouchedByPath: Map<string, LeafInfo>,
): void {
	const { leaf, canonicalConcrete } = t;

	if (state.placedCanonicals.has(canonicalConcrete)) {
		recordTargetCollision(state, canonicalConcrete, leaf);
		return;
	}

	const untouchedAtCanonical = untouchedByPath.get(canonicalConcrete);
	if (untouchedAtCanonical !== undefined) {
		recordUntouchedCollision(
			state,
			canonicalConcrete,
			leaf,
			untouchedAtCanonical,
		);
		return;
	}

	setAtPath(state.aligned, canonicalConcrete, leaf.value);
	state.placedCanonicals.add(canonicalConcrete);
	state.reverseMap[canonicalConcrete] = leaf.concretePath;
}

function recordTargetCollision(
	state: MaterializeState,
	canonicalConcrete: string,
	leaf: LeafInfo,
): void {
	const existing = readPath(state.aligned, canonicalConcrete);
	if (deepEqual(existing, leaf.value)) {
		state.dedupeNotes.push({
			canonical: canonicalConcrete,
			sourcePath: leaf.concretePath,
			value: leaf.value,
		});
	} else {
		state.conflicts.push({
			canonical: canonicalConcrete,
			sourcePath: leaf.concretePath,
			canonicalValue: existing,
			sourceValue: leaf.value,
			reason: "two rename sources collide at same canonical on one page",
		});
	}
}

function recordUntouchedCollision(
	state: MaterializeState,
	canonicalConcrete: string,
	leaf: LeafInfo,
	untouchedAtCanonical: LeafInfo,
): void {
	if (deepEqual(untouchedAtCanonical.value, leaf.value)) {
		state.dedupeNotes.push({
			canonical: canonicalConcrete,
			sourcePath: leaf.concretePath,
			value: leaf.value,
		});
	} else {
		state.conflicts.push({
			canonical: canonicalConcrete,
			sourcePath: leaf.concretePath,
			canonicalValue: untouchedAtCanonical.value,
			sourceValue: leaf.value,
			reason: "rename target already present on page with differing value",
		});
	}
	setAtPath(state.aligned, canonicalConcrete, untouchedAtCanonical.value);
	state.placedCanonicals.add(canonicalConcrete);
	state.handledAsTarget.add(canonicalConcrete);
}

// ---------------------------------------------------------------------------
// Round-trip verification
// ---------------------------------------------------------------------------

/**
 * Assert that every `reverseMap` entry invertibly maps an aligned canonical
 * back to its original source. This is the correctness invariant for clean
 * renames; dedupes and conflicts are intentionally non-invertible and are
 * tracked separately.
 */
export function verifyRoundTrip(
	original: unknown,
	aligned: unknown,
	reverseMap: Record<string, string>,
): RoundTripResult {
	const mismatches: RoundTripResult["mismatches"] = [];
	for (const [canonical, source] of Object.entries(reverseMap)) {
		const alignedValue = readPath(aligned, canonical);
		const originalValue = readPath(original, source);
		if (!deepEqual(alignedValue, originalValue)) {
			mismatches.push({ canonical, source, alignedValue, originalValue });
		}
	}
	return { ok: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// Compressed debug view
// ---------------------------------------------------------------------------

/**
 * Aggregate per-page aligned chrome into a single path-keyed view:
 *   { "<generalPath>": { distinctValues: [{value, pageHashes[]}], presentOn: [...] } }
 *
 * Paths are collapsed to wildcards (mirrors digest shape) so operators can
 * spot under-merges at a glance: if `footer.contact_info.phone` and
 * `footer.contact_information.phone` both appear as separate entries,
 * alignment missed the alias.
 */
export function buildCompressedChrome(
	perPageAligned: Record<string, unknown>,
	perPageConflicts: Record<
		string,
		{ conflicts: ConflictNote[]; dedupes: DedupeNote[] }
	> = {},
): CompressedChrome {
	const pageHashes = Object.keys(perPageAligned).sort();
	const acc = accumulateLeaves(perPageAligned, pageHashes);
	const paths = finalizeCompressedPaths(acc);
	const conflictSummary = summarizeConflicts(perPageConflicts);

	return {
		_meta: {
			totalPages: pageHashes.length,
			totalPaths: Object.keys(paths).length,
			conflictSummary,
		},
		paths,
	};
}

interface CompressedAcc {
	byPath: Map<string, Map<string, string[]>>;
	presentOn: Map<string, Set<string>>;
}

function accumulateLeaves(
	perPageAligned: Record<string, unknown>,
	pageHashes: string[],
): CompressedAcc {
	const byPath = new Map<string, Map<string, string[]>>();
	const presentOn = new Map<string, Set<string>>();
	for (const pageHash of pageHashes) {
		const leaves = enumerateLeafPaths(perPageAligned[pageHash]);
		for (const leaf of leaves) {
			addLeafToAcc(byPath, presentOn, leaf.generalPath, leaf.value, pageHash);
		}
	}
	return { byPath, presentOn };
}

function addLeafToAcc(
	byPath: Map<string, Map<string, string[]>>,
	presentOn: Map<string, Set<string>>,
	gp: string,
	value: unknown,
	pageHash: string,
): void {
	if (!byPath.has(gp)) byPath.set(gp, new Map());
	const valMap = byPath.get(gp);
	if (valMap) {
		const key = JSON.stringify(value);
		if (!valMap.has(key)) valMap.set(key, []);
		valMap.get(key)?.push(pageHash);
	}
	if (!presentOn.has(gp)) presentOn.set(gp, new Set());
	presentOn.get(gp)?.add(pageHash);
}

function finalizeCompressedPaths(
	acc: CompressedAcc,
): Record<string, CompressedChromeEntry> {
	const paths: Record<string, CompressedChromeEntry> = {};
	for (const path of [...acc.byPath.keys()].sort()) {
		const valMap = acc.byPath.get(path);
		if (!valMap) continue;
		const distinctValues = [...valMap.entries()]
			.map(([k, ph]) => ({
				value: JSON.parse(k) as unknown,
				pageHashes: [...ph].sort(),
			}))
			.sort((a, b) =>
				JSON.stringify(a.value) < JSON.stringify(b.value) ? -1 : 1,
			);
		const present = [...(acc.presentOn.get(path) ?? new Set<string>())].sort();
		paths[path] = { distinctValues, presentOn: present };
	}
	return paths;
}

function summarizeConflicts(
	perPageConflicts: Record<
		string,
		{ conflicts: ConflictNote[]; dedupes: DedupeNote[] }
	>,
): { pagesWithConflicts: number; pagesWithDedupes: number } {
	let pagesWithConflicts = 0;
	let pagesWithDedupes = 0;
	for (const pageHash of Object.keys(perPageConflicts)) {
		const rec = perPageConflicts[pageHash];
		if (rec.conflicts.length > 0) pagesWithConflicts++;
		if (rec.dedupes.length > 0) pagesWithDedupes++;
	}
	return { pagesWithConflicts, pagesWithDedupes };
}

// ---------------------------------------------------------------------------
// Deep equality (JSON-shaped values only)
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== typeof b || typeof a !== "object") return false;
	const aIsArr = Array.isArray(a);
	if (aIsArr !== Array.isArray(b)) return false;
	return aIsArr
		? arraysEqual(a as unknown[], b as unknown[])
		: objectsEqual(a as Record<string, unknown>, b as Record<string, unknown>);
}

function arraysEqual(a: unknown[], b: unknown[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (!deepEqual(a[i], b[i])) return false;
	}
	return true;
}

function objectsEqual(
	a: Record<string, unknown>,
	b: Record<string, unknown>,
): boolean {
	const ak = Object.keys(a);
	if (ak.length !== Object.keys(b).length) return false;
	for (const k of ak) {
		if (!deepEqual(a[k], b[k])) return false;
	}
	return true;
}

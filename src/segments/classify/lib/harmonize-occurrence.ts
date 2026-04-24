/**
 * Build a PageTypeDigest (and flat OccurrenceTable + StructuralSignals) from
 * per-page chrome classify outputs. Pure; no filesystem, no judgment.
 *
 * Candidate key = `collapseArrayIndices(suggestedCanonical ?? sourcePath)`.
 * Positional indices (`[0]`, `[1]`, ...) collapse to `[*]` so that slot
 * instability across pages doesn't fragment one concept into N candidates.
 * See `harmonize.md` §Phase 1.
 */

import { createHash } from "node:crypto";
import type {
	CandidateDigest,
	CandidateSignals,
	DistinctValue,
	OccurrenceRow,
	OccurrenceTable,
	PageTypeDigest,
	StructuralSignals,
} from "./harmonize-types.js";
import {
	collapseArrayIndices,
	pathHasWildcard,
	readPath,
} from "./path-utils.js";

export interface HarmonizePageInput {
	hash: string;
	url: string;
	content: unknown;
	chromePaths: Array<{ sourcePath: string; suggestedCanonical?: string }>;
}

export interface BuildDigestInput {
	pagetype: string;
	pages: HarmonizePageInput[];
}

export interface BuildDigestResult {
	digest: PageTypeDigest;
	occurrenceTable: OccurrenceTable;
	signals: StructuralSignals;
}

export function stableValueHash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	const t = typeof value;
	if (t === "string" || t === "number" || t === "boolean") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (t === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(
			([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
		);
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
	}
	return "null";
}

/**
 * Per-candidate collector. Accumulates while walking pages, then rendered
 * into the final CandidateDigest + signals at the end.
 */
interface CandidateCollector {
	distinctValues: Map<string, DistinctValue>;
	presentOn: Set<string>;
	/** pageHash → ordered values observed on that page (raw-path order). */
	perPageValues: Map<string, unknown[]>;
}

export function buildPageTypeDigest(
	input: BuildDigestInput,
): BuildDigestResult {
	const pageHashes = input.pages.map((p) => p.hash);

	const collectors = new Map<string, CandidateCollector>();
	const rows: OccurrenceRow[] = [];

	for (const page of input.pages) {
		// Preserve within-page traversal order; for arrays that lets perPageValues
		// reflect slot sequence when the classifier walked the content in order.
		for (const entry of page.chromePaths) {
			const rawKey = entry.suggestedCanonical ?? entry.sourcePath;
			const candidate = collapseArrayIndices(rawKey);
			const value = readPath(page.content, entry.sourcePath);
			const hash = stableValueHash(value);

			let collector = collectors.get(candidate);
			if (!collector) {
				collector = {
					distinctValues: new Map(),
					presentOn: new Set(),
					perPageValues: new Map(),
				};
				collectors.set(candidate, collector);
			}

			const existing = collector.distinctValues.get(hash);
			if (existing) {
				existing.pageHashes.push(page.hash);
			} else {
				collector.distinctValues.set(hash, {
					value,
					pageHashes: [page.hash],
				});
			}

			collector.presentOn.add(page.hash);

			let seq = collector.perPageValues.get(page.hash);
			if (!seq) {
				seq = [];
				collector.perPageValues.set(page.hash, seq);
			}
			seq.push(value);

			rows.push({
				candidatePath: candidate,
				pageHash: page.hash,
				sourcePath: entry.sourcePath,
				value,
			});
		}
	}

	const candidates: CandidateDigest[] = [];
	const perCandidateSignals: Record<string, CandidateSignals> = {};

	for (const [candidatePath, collector] of collectors) {
		const presentOn = [...collector.presentOn].sort();
		const absentFrom = pageHashes
			.filter((h) => !collector.presentOn.has(h))
			.sort();

		const distinctValues = [...collector.distinctValues.values()]
			.map((dv) => ({ value: dv.value, pageHashes: [...dv.pageHashes].sort() }))
			.sort((a, b) => {
				const diff = b.pageHashes.length - a.pageHashes.length;
				if (diff !== 0) return diff;
				const ah = stableValueHash(a.value);
				const bh = stableValueHash(b.value);
				return ah < bh ? -1 : ah > bh ? 1 : 0;
			});

		candidates.push({
			candidatePath,
			distinctValues,
			presentOn,
			absentFrom,
		});

		perCandidateSignals[candidatePath] = computeCandidateSignals(
			candidatePath,
			collector,
		);
	}

	candidates.sort((a, b) =>
		a.candidatePath < b.candidatePath
			? -1
			: a.candidatePath > b.candidatePath
				? 1
				: 0,
	);

	rows.sort((a, b) => {
		if (a.candidatePath !== b.candidatePath) {
			return a.candidatePath < b.candidatePath ? -1 : 1;
		}
		if (a.pageHash !== b.pageHash) {
			return a.pageHash < b.pageHash ? -1 : 1;
		}
		return a.sourcePath < b.sourcePath
			? -1
			: a.sourcePath > b.sourcePath
				? 1
				: 0;
	});

	return {
		digest: {
			pagetype: input.pagetype,
			totalPages: input.pages.length,
			pageHashes: [...pageHashes].sort(),
			candidates,
		},
		occurrenceTable: {
			pagetype: input.pagetype,
			totalPages: input.pages.length,
			rows,
		},
		signals: {
			pagetype: input.pagetype,
			perCandidate: perCandidateSignals,
		},
	};
}

function computeCandidateSignals(
	candidatePath: string,
	collector: CandidateCollector,
): CandidateSignals {
	const isArray = pathHasWildcard(candidatePath);
	if (!isArray) return { isArray: false };

	const perPageSequences: Record<string, unknown[]> = {};
	for (const [pageHash, values] of collector.perPageValues) {
		perPageSequences[pageHash] = [...values];
	}

	const flatValues: unknown[] = [];
	for (const values of collector.perPageValues.values()) {
		for (const v of values) flatValues.push(v);
	}
	const elementShape = detectElementShape(flatValues);

	const childKeys = collectChildKeys(flatValues);

	const signals: CandidateSignals = {
		isArray: true,
		elementShape,
		perPageSequences,
	};
	if (childKeys.length > 0) signals.childKeys = childKeys;

	if (elementShape === "primitive") {
		const pairs = computePairwiseOrderConstraints(collector.perPageValues);
		if (pairs.length > 0) signals.pairwiseOrderConstraints = pairs;
	}

	const jaccard = computeElementSetJaccard(collector.perPageValues);
	if (jaccard !== null) signals.elementSetJaccard = jaccard;

	if (elementShape === "object") {
		const uniformity = computeChildKeyUniformity(flatValues);
		if (uniformity !== null) signals.childKeyUniformity = uniformity;
	}

	return signals;
}

/**
 * Deduped (a, b) ordered pairs observed across pages — for primitive arrays
 * only. Uses `stableValueHash` for identity so equal primitives across pages
 * dedupe; the returned pair stores the first-seen original value.
 */
function computePairwiseOrderConstraints(
	perPageValues: Map<string, unknown[]>,
): Array<[unknown, unknown]> {
	const seen = new Map<string, [unknown, unknown]>();
	// Iteration order over Map follows insertion order, which mirrors input
	// page order — deterministic.
	for (const values of perPageValues.values()) {
		for (let i = 0; i < values.length; i++) {
			for (let j = i + 1; j < values.length; j++) {
				const a = values[i];
				const b = values[j];
				const key = `${stableValueHash(a)}→${stableValueHash(b)}`;
				if (!seen.has(key)) seen.set(key, [a, b]);
			}
		}
	}
	// Stable sort by hash so output doesn't flicker across runs.
	return [...seen.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([, pair]) => pair);
}

/**
 * Mean pairwise Jaccard of per-page element *sets* (value-hash membership).
 * Returns null when fewer than two pages contribute values — a single-page
 * pagetype has no pairwise comparison to make.
 */
function computeElementSetJaccard(
	perPageValues: Map<string, unknown[]>,
): number | null {
	const pageSets = collectPageHashSets(perPageValues);
	if (pageSets.length < 2) return null;
	let sum = 0;
	let pairs = 0;
	for (let i = 0; i < pageSets.length; i++) {
		for (let j = i + 1; j < pageSets.length; j++) {
			sum += jaccard(pageSets[i], pageSets[j]);
			pairs++;
		}
	}
	return pairs === 0 ? null : sum / pairs;
}

function collectPageHashSets(
	perPageValues: Map<string, unknown[]>,
): Set<string>[] {
	const out: Set<string>[] = [];
	for (const values of perPageValues.values()) {
		if (values.length === 0) continue;
		const set = new Set<string>();
		for (const v of values) set.add(stableValueHash(v));
		out.push(set);
	}
	return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	let intersect = 0;
	for (const h of a) if (b.has(h)) intersect++;
	const union = a.size + b.size - intersect;
	return union === 0 ? 1 : intersect / union;
}

/**
 * Fraction of object elements that share the modal key set.
 * Non-object elements in a "mixed" shape are ignored. Returns null when no
 * object elements were observed (e.g. all-null).
 */
function computeChildKeyUniformity(values: unknown[]): number | null {
	const counts = new Map<string, number>();
	let total = 0;
	for (const v of values) {
		if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
		const keys = Object.keys(v as Record<string, unknown>).sort();
		const key = keys.join("\u0000");
		counts.set(key, (counts.get(key) ?? 0) + 1);
		total++;
	}
	if (total === 0) return null;
	let modal = 0;
	for (const n of counts.values()) {
		if (n > modal) modal = n;
	}
	return modal / total;
}

function detectElementShape(
	values: unknown[],
): "primitive" | "object" | "mixed" {
	let sawPrimitive = false;
	let sawObject = false;
	for (const v of values) {
		if (v === null) {
			sawPrimitive = true;
			continue;
		}
		const t = typeof v;
		if (t === "string" || t === "number" || t === "boolean") {
			sawPrimitive = true;
		} else if (t === "object" && !Array.isArray(v)) {
			sawObject = true;
		} else {
			// Arrays-of-arrays or other shapes surface as "mixed" so phase 3 flags
			// them for explicit handling.
			sawPrimitive = true;
			sawObject = true;
		}
	}
	if (sawPrimitive && sawObject) return "mixed";
	if (sawObject) return "object";
	return "primitive";
}

function collectChildKeys(values: unknown[]): string[] {
	const keys = new Set<string>();
	for (const v of values) {
		if (v !== null && typeof v === "object" && !Array.isArray(v)) {
			for (const k of Object.keys(v as Record<string, unknown>)) keys.add(k);
		}
	}
	return [...keys].sort();
}

/**
 * Pure batching helpers for the layered align-names tree-reduce.
 *
 * Each align iteration partitions its input into batches of ≤ N items
 * (N = `classify.pagesPerBatch` from config, defaulting to
 * `PAGES_PER_BATCH`). At iteration 1 an item is one page
 * (`DigestChunk { itemId = pageHash }`); at iteration 2+ an item is one
 * prior-iteration batch's post-apply sub-digest (`itemId = "batch-<i>"`).
 * A "batch" is a union of such chunks, which we reconstitute back into a
 * `PageTypeDigest` so the existing `validateRenameTable` /
 * `applyRenameTable` machinery applies unchanged.
 */

import { applyRenameTable } from "./harmonize-rename.js";
import type {
	CandidateDigest,
	PageTypeDigest,
	RenameTable,
} from "./harmonize-types.js";

/**
 * Default batch size for harmonize-align fan-out. Overridable via
 * `classify.pagesPerBatch` in `cui.yaml` — per-pagetype tuning helps
 * when pages are token-dense enough that 5 is too many for the agent's
 * prompt budget, or sparse enough that a larger batch converges faster.
 */
export const PAGES_PER_BATCH = 5;

// ---------------------------------------------------------------------------
// DigestChunk — one "item" at any layer
// ---------------------------------------------------------------------------

/**
 * A self-contained slice of a pagetype digest. At layer 1, one chunk per page.
 * At layer 2+, one chunk per prior-layer batch (the batch's post-apply
 * sub-digest). The `candidates` array is already scoped to this item — each
 * `DistinctValue.pageHashes` list contains only hashes this chunk contributed.
 */
export interface DigestChunk {
	itemId: string;
	candidates: CandidateDigest[];
}

// ---------------------------------------------------------------------------
// batchItems — generic partitioner
// ---------------------------------------------------------------------------

/**
 * Partition `items` into sub-arrays of size ≤ `size`. Preserves input order.
 * Returns an empty array when input is empty (zero batches, not one empty
 * batch — callers use `batches.length === 0` as the "nothing to do" signal).
 */
export function batchItems<T>(items: readonly T[], size: number): T[][] {
	if (size <= 0) {
		throw new Error(`batchItems: size must be > 0, got ${size}`);
	}
	if (items.length === 0) return [];
	const batches: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		batches.push(items.slice(i, i + size));
	}
	return batches;
}

// ---------------------------------------------------------------------------
// Layer 1 — page-scoped chunks from the full pagetype digest
// ---------------------------------------------------------------------------

/**
 * Turn a `PageTypeDigest` into one `DigestChunk` per page. Each chunk holds
 * the subset of candidates that page contributed, with its single observed
 * value bound into `distinctValues[0]`.
 *
 * The returned chunks are ordered by `digest.pageHashes` (which harmonize-prepare
 * sorts), so batching is deterministic across runs.
 */
export function pageChunks(digest: PageTypeDigest): DigestChunk[] {
	const byPage = new Map<string, CandidateDigest[]>();
	for (const hash of digest.pageHashes) byPage.set(hash, []);

	for (const cand of digest.candidates) {
		for (const dv of cand.distinctValues) {
			for (const hash of dv.pageHashes) {
				const list = byPage.get(hash);
				if (list === undefined) {
					// Malformed digest: a candidate references a page hash that
					// `digest.pageHashes` doesn't list. Silently skipping would lose
					// data downstream — throw so the caller (harmonize-prepare) sees it.
					throw new Error(
						`pageChunks: candidate "${cand.candidatePath}" references unknown pageHash "${hash}" (not in digest.pageHashes)`,
					);
				}
				list.push({
					candidatePath: cand.candidatePath,
					distinctValues: [{ value: dv.value, pageHashes: [hash] }],
					presentOn: [hash],
					absentFrom: [],
				});
			}
		}
	}

	return [...byPage.entries()].map(([itemId, candidates]) => ({
		itemId,
		candidates,
	}));
}

// ---------------------------------------------------------------------------
// digestFromChunks — reconstitute a batch's sub-digest
// ---------------------------------------------------------------------------

/**
 * Build a `PageTypeDigest` spanning exactly the items in `chunks`. Candidates
 * contributed by multiple chunks are merged (distinct-value buckets and
 * presence sets union). The synthetic `pageHashes` on the resulting digest
 * are the item IDs — not real page hashes at layer 2+, but the downstream
 * validator/applyRenameTable don't care about their provenance.
 */
export function digestFromChunks(
	chunks: readonly DigestChunk[],
	pagetype: string,
): PageTypeDigest {
	const pageHashes = chunks.map((c) => c.itemId);
	const candidates = chunks.flatMap((c) => c.candidates);
	const raw: PageTypeDigest = {
		pagetype,
		totalPages: chunks.length,
		pageHashes,
		candidates,
	};
	// applyRenameTable with an empty table is how we collapse same-path
	// candidates contributed by multiple chunks. Saves duplicating the merge
	// logic here.
	return applyRenameTable(raw, []);
}

/**
 * Merge already-materialized digests into one larger digest while preserving
 * the real underlying page hashes. This is the reducer primitive used by
 * layered harmonize-align: each batch session consumes a merged digest and
 * emits a new post-rename digest for the next iteration.
 */
export function mergeDigests(
	digests: readonly PageTypeDigest[],
	pagetype?: string,
): PageTypeDigest {
	if (digests.length === 0) {
		throw new Error("mergeDigests: expected at least one digest");
	}
	const resolvedPagetype = pagetype ?? digests[0].pagetype;
	for (const digest of digests) {
		if (digest.pagetype !== resolvedPagetype) {
			throw new Error(
				`mergeDigests: pagetype mismatch (${resolvedPagetype} vs ${digest.pagetype})`,
			);
		}
	}
	const pageHashes = [...new Set(digests.flatMap((d) => d.pageHashes))].sort();
	const raw: PageTypeDigest = {
		pagetype: resolvedPagetype,
		totalPages: pageHashes.length,
		pageHashes,
		candidates: digests.flatMap((d) => d.candidates),
	};
	// `applyRenameTable([], ...)` folds same-path candidates together and
	// re-derives present/absent sets from the merged page universe.
	return applyRenameTable(raw, []);
}

// ---------------------------------------------------------------------------
// Layer N → Layer N+1 — promote per-batch post-apply sub-digests to chunks
// ---------------------------------------------------------------------------

/**
 * Convert a prior-layer per-batch post-apply sub-digest back into a chunk
 * suitable for the next layer's input. `itemId` is the stable batch label
 * (`"batch-<i>"`) so retries are deterministic.
 */
export function chunkFromBatchDigest(
	batchIndex: number,
	batchDigest: PageTypeDigest,
): DigestChunk {
	return {
		itemId: `batch-${batchIndex}`,
		candidates: batchDigest.candidates.map((c) => ({
			candidatePath: c.candidatePath,
			distinctValues: c.distinctValues.map((dv) => ({
				value: dv.value,
				pageHashes: [...dv.pageHashes],
			})),
			presentOn: [...c.presentOn],
			absentFrom: [...c.absentFrom],
		})),
	};
}

// ---------------------------------------------------------------------------
// Union of per-batch rename tables
// ---------------------------------------------------------------------------

/**
 * Merge rename tables produced by disjoint batches of a single layer. Batches
 * partition the item set, so `from`s must be disjoint — duplicate `from`s
 * signal a layer-internal bug (same candidate routed to two batches). We
 * assert loudly rather than silently collapse.
 */
export function unionRenameTables(tables: readonly RenameTable[]): RenameTable {
	const seen = new Map<string, { to: string; batchIdx: number }>();
	const out: RenameTable = [];
	for (let i = 0; i < tables.length; i++) {
		for (const entry of tables[i]) {
			const prior = seen.get(entry.from);
			if (prior) {
				if (prior.to !== entry.to) {
					throw new Error(
						`unionRenameTables: conflicting renames for "${entry.from}" — batch ${prior.batchIdx} → "${prior.to}", batch ${i} → "${entry.to}"`,
					);
				}
				continue;
			}
			seen.set(entry.from, { to: entry.to, batchIdx: i });
			out.push(entry);
		}
	}
	return out;
}

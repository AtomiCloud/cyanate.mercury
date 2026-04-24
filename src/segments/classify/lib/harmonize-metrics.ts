/**
 * Convergence metrics for a rename-table application on a pagetype digest.
 *
 * The rename table is checked per-rule by the validators; these metrics
 * answer a different question: "did the rename table, as a whole,
 * collapse the pagetype's candidate set into a more coherent canonical
 * shape?"
 *
 * Used by the batch-level convergence reviewer (an LLM judge) and written
 * to a sidecar file for human debugging. Pure — no filesystem, no LLM.
 */

import type {
	DistinctValue,
	PageTypeDigest,
	RenameTable,
} from "./harmonize-types.js";

export interface FoldDiffBucket {
	/** The canonical name after renames are applied. */
	canonical: string;
	/** Original candidate names that merged into this bucket (≥1). */
	sources: string[];
	/** Pages on which the canonical bucket is present post-apply. */
	pagesWithBucket: number;
	/** Distinct values observed in the merged bucket. */
	distinctValues: DistinctValue[];
}

export interface ConvergenceMetrics {
	pagetype: string;
	totalPages: number;
	candidatesBefore: number;
	candidatesAfter: number;
	sharedOnAllBefore: number;
	sharedOnAllAfter: number;
	/** null when totalPages < 2 (no pairs to average over). */
	meanJaccardBefore: number | null;
	meanJaccardAfter: number | null;
	/** One entry per distinct `to` in the rename table, sorted by canonical. */
	foldBuckets: FoldDiffBucket[];
}

export function computeConvergenceMetrics(
	beforeDigest: PageTypeDigest,
	afterDigest: PageTypeDigest,
	flat: RenameTable,
): ConvergenceMetrics {
	const totalPages = beforeDigest.totalPages;
	return {
		pagetype: beforeDigest.pagetype,
		totalPages,
		candidatesBefore: beforeDigest.candidates.length,
		candidatesAfter: afterDigest.candidates.length,
		sharedOnAllBefore: countPresentOnAll(beforeDigest),
		sharedOnAllAfter: countPresentOnAll(afterDigest),
		meanJaccardBefore: meanJaccard(beforeDigest),
		meanJaccardAfter: meanJaccard(afterDigest),
		foldBuckets: computeFoldBuckets(flat, afterDigest),
	};
}

function countPresentOnAll(digest: PageTypeDigest): number {
	return digest.candidates.filter(
		(c) => c.presentOn.length === digest.totalPages,
	).length;
}

function meanJaccard(digest: PageTypeDigest): number | null {
	const pages = digest.pageHashes;
	if (pages.length < 2) return null;
	const pageSets = buildPerPageCandidateSets(digest);
	const jaccards = collectPairwiseJaccards(pages, pageSets);
	if (jaccards.length === 0) return null;
	const sum = jaccards.reduce((a, b) => a + b, 0);
	return sum / jaccards.length;
}

function buildPerPageCandidateSets(
	digest: PageTypeDigest,
): Map<string, Set<string>> {
	const pageSets = new Map<string, Set<string>>();
	for (const p of digest.pageHashes) pageSets.set(p, new Set());
	for (const c of digest.candidates) {
		for (const p of c.presentOn) pageSets.get(p)?.add(c.candidatePath);
	}
	return pageSets;
}

function collectPairwiseJaccards(
	pages: readonly string[],
	pageSets: Map<string, Set<string>>,
): number[] {
	const out: number[] = [];
	for (let i = 0; i < pages.length; i++) {
		for (let j = i + 1; j < pages.length; j++) {
			const a = pageSets.get(pages[i]);
			const b = pageSets.get(pages[j]);
			if (!a || !b) continue;
			const { intersection, union } = setOverlap(a, b);
			if (union === 0) continue;
			out.push(intersection / union);
		}
	}
	return out;
}

function setOverlap(
	a: Set<string>,
	b: Set<string>,
): { intersection: number; union: number } {
	let intersection = 0;
	for (const x of a) if (b.has(x)) intersection++;
	const union = a.size + b.size - intersection;
	return { intersection, union };
}

function computeFoldBuckets(
	flat: RenameTable,
	afterDigest: PageTypeDigest,
): FoldDiffBucket[] {
	const byCanonical = new Map<string, string[]>();
	for (const entry of flat) {
		if (!byCanonical.has(entry.to)) byCanonical.set(entry.to, []);
		byCanonical.get(entry.to)?.push(entry.from);
	}
	const afterByPath = new Map(
		afterDigest.candidates.map((c) => [c.candidatePath, c]),
	);
	const buckets: FoldDiffBucket[] = [];
	for (const [canonical, sources] of byCanonical) {
		const cand = afterByPath.get(canonical);
		buckets.push({
			canonical,
			sources: [...sources].sort(),
			pagesWithBucket: cand?.presentOn.length ?? 0,
			distinctValues: cand?.distinctValues ?? [],
		});
	}
	buckets.sort((a, b) => (a.canonical < b.canonical ? -1 : 1));
	return buckets;
}

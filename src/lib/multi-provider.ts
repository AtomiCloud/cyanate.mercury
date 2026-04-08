/**
 * Multi-provider dispatch — pure functions for aggregating results,
 * merging rejection contexts, and resolving provider assignments.
 */

import type {
	CuiConfig,
	LLMProfile,
	Review,
	StepResult,
} from "../engine/types.js";

/**
 * Aggregate an array of step results into a single verdict.
 *
 * - "any_reject": any single REJECT → overall REJECT; any single FAIL → overall FAIL
 * - "all_pass": all must PASS for overall PASS
 */
export function aggregateResults(
	results: StepResult[],
	aggregation: "any_reject" | "all_pass",
): StepResult {
	if (results.length === 0) {
		return { status: "pass", reviews: [] };
	}

	// Any explicit fail takes precedence
	const firstFail = results.find((r) => r.status === "fail");
	if (firstFail) {
		return {
			status: "fail",
			error: firstFail.error ?? "One or more providers failed",
			duration: results.reduce((sum, r) => sum + (r.duration ?? 0), 0),
		};
	}

	if (aggregation === "any_reject") {
		const rejects = results.filter((r) => r.status === "reject");
		if (rejects.length > 0) {
			const allReviews = results
				.filter((r) => r.reviews)
				.flatMap((r) => r.reviews as Review[]);
			return {
				status: "reject",
				reviews: allReviews,
				duration: results.reduce((sum, r) => sum + (r.duration ?? 0), 0),
			};
		}
	}

	// all_pass: any non-pass means reject
	if (aggregation === "all_pass") {
		const nonPass = results.find((r) => r.status !== "pass");
		if (nonPass) {
			const allReviews = results
				.filter((r) => r.reviews)
				.flatMap((r) => r.reviews as Review[]);
			return {
				status: nonPass.status,
				reviews: allReviews,
				duration: results.reduce((sum, r) => sum + (r.duration ?? 0), 0),
			};
		}
	}

	return {
		status: "pass",
		reviews: results
			.filter((r) => r.reviews)
			.flatMap((r) => r.reviews as Review[]),
		duration: results.reduce((sum, r) => sum + (r.duration ?? 0), 0),
	};
}

/**
 * Extract a dedup key and display text from a rejection review.
 * Returns null if the review is not a rejection.
 */
function extractRejectionEntry(
	review: Review,
): { key: string; text: string } | null {
	if (review.verdict !== "reject") return null;
	const context = review.rejectionContext ?? review.findings;
	return {
		key: `${review.reviewerId}:${context}`,
		text: `[${review.reviewerId}] ${context}`,
	};
}

/**
 * Merge rejection contexts from multiple reviewers into a single string.
 * Deduplicates identical findings.
 */
export function mergeRejectionContexts(reviews: Review[][]): string {
	const seen = new Set<string>();
	const parts: string[] = [];

	for (const reviewGroup of reviews) {
		for (const review of reviewGroup) {
			const entry = extractRejectionEntry(review);
			if (!entry) continue;
			if (!seen.has(entry.key)) {
				seen.add(entry.key);
				parts.push(entry.text);
			}
		}
	}

	return parts.join("\n\n");
}

/** Resolved provider configuration including aggregation strategy. */
export interface ResolvedProviderConfig {
	providers: LLMProfile[];
	aggregation: "any_reject" | "all_pass";
}

/**
 * Resolve which providers to use for a given step from config.
 *
 * - If stepId is in step_matrix → use that single provider key
 * - If stepId is in reviewer_matrix → use the matrix providers
 * - Otherwise → fall back to [defaults]
 */
export function resolveProviders(
	config: CuiConfig,
	stepId: string,
): LLMProfile[] {
	return resolveProviderConfig(config, stepId).providers;
}

/**
 * Resolve both providers and aggregation strategy for a given step.
 *
 * - step_matrix entries → single provider, "all_pass" aggregation
 * - reviewer_matrix entries → multiple providers with configured aggregation (defaults to "any_reject")
 * - fallback → single default provider, "all_pass" aggregation
 */
export function resolveProviderConfig(
	config: CuiConfig,
	stepId: string,
): ResolvedProviderConfig {
	// Check step_matrix first — single provider, all must pass
	const providerKey = config.step_matrix?.[stepId];
	if (providerKey && config.providers?.[providerKey]) {
		return {
			providers: [config.providers[providerKey]],
			aggregation: "all_pass",
		};
	}

	// Check reviewer_matrix — multiple providers with configured aggregation
	const matrixEntry = config.reviewer_matrix?.[stepId];
	if (matrixEntry && config.providers) {
		const resolved = matrixEntry.providers
			.map((key) => config.providers?.[key])
			.filter((p): p is LLMProfile => p !== undefined);
		if (resolved.length > 0) {
			return {
				providers: resolved,
				aggregation: matrixEntry.aggregation ?? "any_reject",
			};
		}
	}

	// Fall back to defaults
	return {
		providers: [config.defaults],
		aggregation: "all_pass",
	};
}

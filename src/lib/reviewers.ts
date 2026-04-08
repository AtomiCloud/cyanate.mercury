/**
 * Reusable reviewer step builders — pure functions for verdict parsing,
 * aggregation, and path construction.
 */

import type { Review, StepResult } from "../engine/types.js";

// ---------------------------------------------------------------------------
// Pure verdict parsing
// ---------------------------------------------------------------------------

export interface ParsedVerdict {
	verdict: "pass" | "reject";
	findings: string;
	rejectionContext?: string;
}

/**
 * Parse a reviewer's text output into a structured verdict.
 *
 * Looks for:
 * - "VERDICT: PASS" or "VERDICT:PASS" → pass
 * - "VERDICT: REJECT" or "VERDICT:REJECT" → reject, optionally extracting REJECTION CONTEXT
 * - Malformed output → reject (fail-safe)
 */
export function parseReviewerVerdict(output: string): ParsedVerdict {
	const normalized = output.toUpperCase();

	if (
		normalized.includes("VERDICT: PASS") ||
		normalized.includes("VERDICT:PASS")
	) {
		return {
			verdict: "pass",
			findings: output,
		};
	}

	if (
		normalized.includes("VERDICT: REJECT") ||
		normalized.includes("VERDICT:REJECT")
	) {
		let rejectionContext: string | undefined;
		const rcMatch = output.match(
			/REJECTION CONTEXT[:\s]*\n?([\s\S]*?)(?=\n#{1,3}\s|$)/i,
		);
		if (rcMatch) {
			rejectionContext = rcMatch[1].trim();
		}

		return {
			verdict: "reject",
			findings: output,
			rejectionContext: rejectionContext ?? output,
		};
	}

	// Malformed output — fail-safe: reject
	return {
		verdict: "reject",
		findings: `Malformed reviewer output — could not parse verdict.\n\nOriginal output:\n${output}`,
		rejectionContext:
			"Reviewer output did not contain a valid VERDICT: PASS or VERDICT: REJECT line.",
	};
}

/**
 * Aggregate multiple reviewer verdicts into a single StepResult.
 * Any single REJECT → overall REJECT.
 */
export function aggregateReviewerVerdicts(verdicts: Review[]): StepResult {
	if (verdicts.length === 0) {
		return { status: "pass", reviews: [] };
	}

	const rejects = verdicts.filter((v) => v.verdict === "reject");
	if (rejects.length > 0) {
		return {
			status: "reject",
			reviews: verdicts,
		};
	}

	return {
		status: "pass",
		reviews: verdicts,
	};
}

/**
 * Build evidence directory path for an iteration.
 */
export function evidencePath(workdir: string, iteration: number): string {
	return `${workdir}/evidence/${iteration}`;
}

/**
 * Build review directory path for an iteration.
 */
export function reviewPath(workdir: string, iteration: number): string {
	return `${workdir}/reviews/${iteration}`;
}

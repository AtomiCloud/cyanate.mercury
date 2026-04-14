/**
 * Pure: quality score aggregation and final gate composition.
 *
 * All quality scoring logic is pure — no IO.
 */

import type {
	FidelityThresholdResult,
	FinalGateResult,
	QualityScores,
	QualityThresholdResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Dimension weights for overall score
// ---------------------------------------------------------------------------

const DIMENSION_WEIGHTS: Record<keyof QualityScores["dimensions"], number> = {
	layoutConsistency: 1.5,
	designTokenUsage: 1.5,
	componentComposition: 1.0,
	responsiveDesign: 1.0,
	semanticHtml: 1.0,
	visualAppeal: 1.5,
	motionQuality: 1.0,
};

const DIMENSION_KEYS = Object.keys(DIMENSION_WEIGHTS) as Array<
	keyof QualityScores["dimensions"]
>;

// ---------------------------------------------------------------------------
// Overall score computation
// ---------------------------------------------------------------------------

/**
 * Aggregate dimension scores into an overall quality score.
 *
 * Uses weighted average. All dimensions at 8.0 → 8.0 overall.
 */
export function computeOverallScore(
	dimensions: QualityScores["dimensions"],
): number {
	let totalWeight = 0;
	let weightedSum = 0;

	for (const key of DIMENSION_KEYS) {
		const weight = DIMENSION_WEIGHTS[key];
		const score = dimensions[key] ?? 0;
		weightedSum += score * weight;
		totalWeight += weight;
	}

	return Math.round((weightedSum / totalWeight) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Quality threshold checking
// ---------------------------------------------------------------------------

/**
 * Check if quality scores meet minimum thresholds.
 *
 * @param scores - Full quality scores object
 * @param thresholds - { overall: number; perDimension?: Record<string, number> }
 */
export function checkQualityThresholds(
	scores: QualityScores,
	thresholds: {
		overall: number;
		perDimension?: Partial<Record<keyof QualityScores["dimensions"], number>>;
	},
): QualityThresholdResult {
	const failures: string[] = [];

	// Check overall
	const overall = computeOverallScore(scores.dimensions);
	if (overall < thresholds.overall) {
		failures.push(
			`Overall quality ${overall.toFixed(2)} below threshold ${thresholds.overall}`,
		);
	}

	// Check per-dimension
	const perDim = thresholds.perDimension ?? {};
	for (const [dim, minScore] of Object.entries(perDim)) {
		const actual = scores.dimensions[dim as keyof QualityScores["dimensions"]];
		if (actual !== undefined && actual < (minScore as number)) {
			failures.push(
				`Dimension "${dim}" score ${actual.toFixed(2)} below threshold ${minScore}`,
			);
		}
	}

	return { passes: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Fidelity threshold checking
// ---------------------------------------------------------------------------

/**
 * Check if fidelity scores meet the minimum threshold.
 *
 * @param fidelityScores - Record of dimension → score (0-1)
 * @param threshold - Minimum passing score (default 0.6)
 */
export function checkFidelityThresholds(
	fidelityScores: Record<string, number>,
	threshold: number = 0.6,
): FidelityThresholdResult {
	const failures: string[] = [];

	for (const [dimension, score] of Object.entries(fidelityScores)) {
		if (score < threshold) {
			failures.push(
				`Fidelity dimension "${dimension}" score ${score.toFixed(2)} below threshold ${threshold}`,
			);
		}
	}

	return { passes: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Final gate composition
// ---------------------------------------------------------------------------

/**
 * Compose final gate result from all Phase 6 checks.
 *
 * This is the single point where the design segment decides to pass or reject.
 * All sub-checks must pass for the final gate to pass.
 */
export function composeFinalGate(input: {
	buildSuccess: boolean;
	overflowFree: boolean;
	darkModeWorks: boolean;
	reducedMotionRespected: boolean;
	qualityScores: QualityScores;
	fidelityScores: Record<string, number>;
	layerIsolation: boolean;
	qualityThreshold: number;
	fidelityThreshold: number;
}): FinalGateResult {
	const errors: string[] = [];

	// Build check
	if (!input.buildSuccess) {
		errors.push("Build failed — cannot proceed to QA");
	}

	// Layout checks
	if (!input.overflowFree) {
		errors.push(
			"Content overflow detected — layout phase did not resolve correctly",
		);
	}

	// Accessibility checks
	if (!input.darkModeWorks) {
		errors.push("Dark mode not working — contrast or toggle issue");
	}

	if (!input.reducedMotionRespected) {
		errors.push("Reduced motion not respected — motion phase issue");
	}

	// Layer isolation
	if (!input.layerIsolation) {
		errors.push("CSS layer isolation broken — phase boundary violation");
	}

	// Quality thresholds
	const qualityResult = checkQualityThresholds(input.qualityScores, {
		overall: input.qualityThreshold,
	});
	if (!qualityResult.passes) {
		errors.push(...qualityResult.failures);
	}

	// Fidelity thresholds
	const fidelityResult = checkFidelityThresholds(
		input.fidelityScores,
		input.fidelityThreshold,
	);
	if (!fidelityResult.passes) {
		errors.push(...fidelityResult.failures);
	}

	return { passed: errors.length === 0, errors };
}

import { describe, expect, it } from "bun:test";
import {
	checkFidelityThresholds,
	checkQualityThresholds,
	composeFinalGate,
	computeOverallScore,
} from "./quality.js";
import type { QualityScores } from "./types.js";

describe("computeOverallScore", () => {
	it("returns 8.0 when all dimensions are 8.0", () => {
		const dims: QualityScores["dimensions"] = {
			layoutConsistency: 8.0,
			designTokenUsage: 8.0,
			componentComposition: 8.0,
			responsiveDesign: 8.0,
			semanticHtml: 8.0,
			visualAppeal: 8.0,
			motionQuality: 8.0,
		};

		const overall = computeOverallScore(dims);
		expect(overall).toBe(8.0);
	});

	it("computes weighted average for mixed scores", () => {
		const dims: QualityScores["dimensions"] = {
			layoutConsistency: 10.0,
			designTokenUsage: 10.0,
			componentComposition: 5.0,
			responsiveDesign: 5.0,
			semanticHtml: 5.0,
			visualAppeal: 10.0,
			motionQuality: 5.0,
		};

		const overall = computeOverallScore(dims);
		// Weighted: layout/design/visual × 1.5, others × 1.0
		// (10*1.5 + 10*1.5 + 5*1.0 + 5*1.0 + 5*1.0 + 10*1.5 + 5*1.0) / (1.5*3 + 1.0*4)
		// = (15 + 15 + 5 + 5 + 5 + 15 + 5) / (4.5 + 4)
		// = 60 / 8.5 = 7.06
		expect(overall).toBeGreaterThan(7);
		expect(overall).toBeLessThan(8);
	});

	it("handles zero scores", () => {
		const dims: QualityScores["dimensions"] = {
			layoutConsistency: 0,
			designTokenUsage: 0,
			componentComposition: 0,
			responsiveDesign: 0,
			semanticHtml: 0,
			visualAppeal: 0,
			motionQuality: 0,
		};

		const overall = computeOverallScore(dims);
		expect(overall).toBe(0);
	});
});

describe("checkQualityThresholds", () => {
	it("passes when overall is above threshold", () => {
		const scores: QualityScores = {
			overall: 7.5,
			dimensions: {
				layoutConsistency: 8.0,
				designTokenUsage: 8.0,
				componentComposition: 8.0,
				responsiveDesign: 8.0,
				semanticHtml: 8.0,
				visualAppeal: 8.0,
				motionQuality: 8.0,
			},
		};

		const result = checkQualityThresholds(scores, { overall: 7.0 });
		expect(result.passes).toBe(true);
	});

	it("fails when overall is below threshold", () => {
		const scores: QualityScores = {
			overall: 6.5,
			dimensions: {
				layoutConsistency: 6.5,
				designTokenUsage: 6.5,
				componentComposition: 6.5,
				responsiveDesign: 6.5,
				semanticHtml: 6.5,
				visualAppeal: 6.5,
				motionQuality: 6.5,
			},
		};

		const result = checkQualityThresholds(scores, { overall: 7.0 });
		expect(result.passes).toBe(false);
		expect(result.failures.length).toBeGreaterThan(0);
	});

	it("checks per-dimension thresholds", () => {
		const scores: QualityScores = {
			overall: 8.0,
			dimensions: {
				layoutConsistency: 5.0,
				designTokenUsage: 8.0,
				componentComposition: 8.0,
				responsiveDesign: 8.0,
				semanticHtml: 8.0,
				visualAppeal: 8.0,
				motionQuality: 8.0,
			},
		};

		const result = checkQualityThresholds(scores, {
			overall: 7.0,
			perDimension: { layoutConsistency: 7.0 },
		});

		expect(result.passes).toBe(false);
		expect(result.failures.some((f) => f.includes("layoutConsistency"))).toBe(
			true,
		);
	});
});

describe("checkFidelityThresholds", () => {
	it("passes when all dimensions are >= 0.6", () => {
		const fidelityScores: Record<string, number> = {
			layout: 0.8,
			typography: 0.7,
			color: 0.9,
			spacing: 0.6,
			components: 0.7,
			motion: 0.6,
		};

		const result = checkFidelityThresholds(fidelityScores, 0.6);
		expect(result.passes).toBe(true);
	});

	it("fails when one dimension is below threshold", () => {
		const fidelityScores: Record<string, number> = {
			layout: 0.8,
			typography: 0.4,
			color: 0.9,
			spacing: 0.6,
			components: 0.7,
			motion: 0.6,
		};

		const result = checkFidelityThresholds(fidelityScores, 0.6);
		expect(result.passes).toBe(false);
		expect(result.failures.some((f) => f.includes("typography"))).toBe(true);
	});
});

describe("composeFinalGate", () => {
	it("passes when all sub-checks pass", () => {
		const scores: QualityScores = {
			overall: 8.0,
			dimensions: {
				layoutConsistency: 8.0,
				designTokenUsage: 8.0,
				componentComposition: 8.0,
				responsiveDesign: 8.0,
				semanticHtml: 8.0,
				visualAppeal: 8.0,
				motionQuality: 8.0,
			},
		};

		const result = composeFinalGate({
			buildSuccess: true,
			overflowFree: true,
			darkModeWorks: true,
			reducedMotionRespected: true,
			qualityScores: scores,
			fidelityScores: { layout: 0.8, typography: 0.8, color: 0.8 },
			layerIsolation: true,
			qualityThreshold: 7.0,
			fidelityThreshold: 0.6,
		});

		expect(result.passed).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("fails when build is not successful", () => {
		const result = composeFinalGate({
			buildSuccess: false,
			overflowFree: true,
			darkModeWorks: true,
			reducedMotionRespected: true,
			qualityScores: {
				overall: 8,
				dimensions: {} as QualityScores["dimensions"],
			},
			fidelityScores: {},
			layerIsolation: true,
			qualityThreshold: 7.0,
			fidelityThreshold: 0.6,
		});

		expect(result.passed).toBe(false);
		expect(result.errors.some((e) => e.includes("Build failed"))).toBe(true);
	});

	it("fails when dark mode is broken", () => {
		const result = composeFinalGate({
			buildSuccess: true,
			overflowFree: true,
			darkModeWorks: false,
			reducedMotionRespected: true,
			qualityScores: {
				overall: 8,
				dimensions: {} as QualityScores["dimensions"],
			},
			fidelityScores: {},
			layerIsolation: true,
			qualityThreshold: 7.0,
			fidelityThreshold: 0.6,
		});

		expect(result.passed).toBe(false);
		expect(result.errors.some((e) => e.includes("Dark mode"))).toBe(true);
	});

	it("fails when layer isolation is broken", () => {
		const result = composeFinalGate({
			buildSuccess: true,
			overflowFree: true,
			darkModeWorks: true,
			reducedMotionRespected: true,
			qualityScores: {
				overall: 8,
				dimensions: {} as QualityScores["dimensions"],
			},
			fidelityScores: {},
			layerIsolation: false,
			qualityThreshold: 7.0,
			fidelityThreshold: 0.6,
		});

		expect(result.passed).toBe(false);
		expect(result.errors.some((e) => e.includes("layer isolation"))).toBe(true);
	});

	it("collects all errors when multiple fail", () => {
		const result = composeFinalGate({
			buildSuccess: false,
			overflowFree: false,
			darkModeWorks: false,
			reducedMotionRespected: false,
			qualityScores: {
				overall: 5,
				dimensions: {
					layoutConsistency: 5,
					designTokenUsage: 5,
					componentComposition: 5,
					responsiveDesign: 5,
					semanticHtml: 5,
					visualAppeal: 5,
					motionQuality: 5,
				},
			},
			fidelityScores: { layout: 0.3, typography: 0.3 },
			layerIsolation: false,
			qualityThreshold: 7.0,
			fidelityThreshold: 0.6,
		});

		expect(result.passed).toBe(false);
		expect(result.errors.length).toBeGreaterThan(1);
	});
});

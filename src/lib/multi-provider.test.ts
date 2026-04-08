import { describe, expect, test } from "bun:test";
import type { CuiConfig, Review, StepResult } from "../engine/types.js";
import {
	aggregateResults,
	mergeRejectionContexts,
	resolveProviderConfig,
	resolveProviders,
} from "./multi-provider.js";

// ---------------------------------------------------------------------------
// aggregateResults
// ---------------------------------------------------------------------------

describe("aggregateResults", () => {
	test("3 PASS → PASS", () => {
		const results: StepResult[] = [
			{
				status: "pass",
				reviews: [{ reviewerId: "r1", verdict: "pass", findings: "ok" }],
			},
			{
				status: "pass",
				reviews: [{ reviewerId: "r2", verdict: "pass", findings: "ok" }],
			},
			{
				status: "pass",
				reviews: [{ reviewerId: "r3", verdict: "pass", findings: "ok" }],
			},
		];
		const aggregated = aggregateResults(results, "any_reject");
		expect(aggregated.status).toBe("pass");
	});

	test("2 PASS + 1 REJECT → REJECT with any_reject", () => {
		const results: StepResult[] = [
			{ status: "pass" },
			{
				status: "reject",
				reviews: [{ reviewerId: "r2", verdict: "reject", findings: "bad" }],
			},
			{ status: "pass" },
		];
		const aggregated = aggregateResults(results, "any_reject");
		expect(aggregated.status).toBe("reject");
	});

	test("all REJECT → REJECT", () => {
		const results: StepResult[] = [
			{
				status: "reject",
				reviews: [{ reviewerId: "r1", verdict: "reject", findings: "bad1" }],
			},
			{
				status: "reject",
				reviews: [{ reviewerId: "r2", verdict: "reject", findings: "bad2" }],
			},
		];
		const aggregated = aggregateResults(results, "any_reject");
		expect(aggregated.status).toBe("reject");
	});

	test("empty array → PASS (vacuous truth)", () => {
		const aggregated = aggregateResults([], "any_reject");
		expect(aggregated.status).toBe("pass");
	});

	test("FAIL takes precedence over REJECT", () => {
		const results: StepResult[] = [
			{
				status: "reject",
				reviews: [{ reviewerId: "r1", verdict: "reject", findings: "bad" }],
			},
			{ status: "fail", error: "crashed" },
		];
		const aggregated = aggregateResults(results, "any_reject");
		expect(aggregated.status).toBe("fail");
	});

	test("all_pass: all pass → PASS", () => {
		const results: StepResult[] = [{ status: "pass" }, { status: "pass" }];
		const aggregated = aggregateResults(results, "all_pass");
		expect(aggregated.status).toBe("pass");
	});

	test("all_pass: one reject → REJECT", () => {
		const results: StepResult[] = [
			{ status: "pass" },
			{
				status: "reject",
				reviews: [{ reviewerId: "r2", verdict: "reject", findings: "bad" }],
			},
		];
		const aggregated = aggregateResults(results, "all_pass");
		expect(aggregated.status).toBe("reject");
	});
});

// ---------------------------------------------------------------------------
// mergeRejectionContexts
// ---------------------------------------------------------------------------

describe("mergeRejectionContexts", () => {
	test("merges findings from multiple reviewers", () => {
		const reviews: Review[][] = [
			[
				{
					reviewerId: "r1",
					verdict: "reject",
					findings: "layout issue",
					rejectionContext: "The grid is broken",
				},
			],
			[
				{
					reviewerId: "r2",
					verdict: "reject",
					findings: "color issue",
					rejectionContext: "Contrast too low",
				},
			],
		];
		const merged = mergeRejectionContexts(reviews);
		expect(merged).toContain("[r1] The grid is broken");
		expect(merged).toContain("[r2] Contrast too low");
	});

	test("deduplicates identical findings", () => {
		const reviews: Review[][] = [
			[
				{
					reviewerId: "r1",
					verdict: "reject",
					findings: "bad",
					rejectionContext: "Same issue",
				},
			],
			[
				{
					reviewerId: "r2",
					verdict: "reject",
					findings: "bad",
					rejectionContext: "Same issue",
				},
			],
		];
		const merged = mergeRejectionContexts(reviews);
		// Should only appear once per reviewer, not duplicated
		const count = (merged.match(/\[r1\] Same issue/g) || []).length;
		expect(count).toBe(1);
	});

	test("ignores PASS verdicts", () => {
		const reviews: Review[][] = [
			[
				{
					reviewerId: "r1",
					verdict: "pass",
					findings: "looks good",
				},
			],
		];
		const merged = mergeRejectionContexts(reviews);
		expect(merged).toBe("");
	});
});

// ---------------------------------------------------------------------------
// resolveProviders
// ---------------------------------------------------------------------------

describe("resolveProviders", () => {
	const baseConfig: CuiConfig = {
		input: "/tmp/input",
		defaults: {
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
		},
		profiles: {},
		heartbeat: { timeout: 900_000, interval: 30_000 },
		logging: { eventsFile: "events.jsonl", debugFile: "debug.log" },
		providers: {
			opus: { provider: "anthropic", model: "claude-opus-4-20250514" },
			sonnet: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
		},
		step_matrix: {
			"analyze.style": "opus",
		},
		reviewer_matrix: {
			"review.layout": {
				providers: ["opus", "sonnet"],
				aggregation: "any_reject",
			},
		},
	};

	test("step in step_matrix → returns that provider", () => {
		const providers = resolveProviders(baseConfig, "analyze.style");
		expect(providers).toHaveLength(1);
		expect(providers[0].model).toBe("claude-opus-4-20250514");
	});

	test("step in reviewer_matrix → returns matrix providers", () => {
		const providers = resolveProviders(baseConfig, "review.layout");
		expect(providers).toHaveLength(2);
	});

	test("step not in any matrix → returns defaults", () => {
		const providers = resolveProviders(baseConfig, "unknown-step");
		expect(providers).toHaveLength(1);
		expect(providers[0].model).toBe("claude-sonnet-4-20250514");
	});

	test("no providers config → returns defaults", () => {
		const minimalConfig: CuiConfig = {
			input: "/tmp/input",
			defaults: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
			profiles: {},
			heartbeat: { timeout: 900_000, interval: 30_000 },
			logging: { eventsFile: "events.jsonl", debugFile: "debug.log" },
		};
		const providers = resolveProviders(minimalConfig, "anything");
		expect(providers).toHaveLength(1);
		expect(providers[0].model).toBe("claude-sonnet-4-20250514");
	});
});

// ---------------------------------------------------------------------------
// resolveProviderConfig
// ---------------------------------------------------------------------------

describe("resolveProviderConfig", () => {
	test("step in step_matrix → all_pass aggregation", () => {
		const config: CuiConfig = {
			input: "/tmp/input",
			defaults: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
			profiles: {},
			heartbeat: { timeout: 900_000, interval: 30_000 },
			logging: { eventsFile: "events.jsonl", debugFile: "debug.log" },
			providers: {
				opus: { provider: "anthropic", model: "claude-opus-4-20250514" },
			},
			step_matrix: { "analyze.style": "opus" },
		};
		const resolved = resolveProviderConfig(config, "analyze.style");
		expect(resolved.providers).toHaveLength(1);
		expect(resolved.aggregation).toBe("all_pass");
	});

	test("reviewer_matrix with explicit aggregation → uses it", () => {
		const config: CuiConfig = {
			input: "/tmp/input",
			defaults: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
			profiles: {},
			heartbeat: { timeout: 900_000, interval: 30_000 },
			logging: { eventsFile: "events.jsonl", debugFile: "debug.log" },
			providers: {
				opus: { provider: "anthropic", model: "claude-opus-4-20250514" },
				sonnet: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
			},
			reviewer_matrix: {
				"review.layout": {
					providers: ["opus", "sonnet"],
					aggregation: "any_reject",
				},
			},
		};
		const resolved = resolveProviderConfig(config, "review.layout");
		expect(resolved.providers).toHaveLength(2);
		expect(resolved.aggregation).toBe("any_reject");
	});

	test("reviewer_matrix without explicit aggregation → defaults to any_reject", () => {
		const config: CuiConfig = {
			input: "/tmp/input",
			defaults: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
			profiles: {},
			heartbeat: { timeout: 900_000, interval: 30_000 },
			logging: { eventsFile: "events.jsonl", debugFile: "debug.log" },
			providers: {
				opus: { provider: "anthropic", model: "claude-opus-4-20250514" },
			},
			reviewer_matrix: {
				"review.color": {
					providers: ["opus"],
				},
			},
		};
		const resolved = resolveProviderConfig(config, "review.color");
		expect(resolved.providers).toHaveLength(1);
		expect(resolved.aggregation).toBe("any_reject");
	});

	test("fallback → all_pass aggregation", () => {
		const config: CuiConfig = {
			input: "/tmp/input",
			defaults: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
			profiles: {},
			heartbeat: { timeout: 900_000, interval: 30_000 },
			logging: { eventsFile: "events.jsonl", debugFile: "debug.log" },
		};
		const resolved = resolveProviderConfig(config, "unknown");
		expect(resolved.providers).toHaveLength(1);
		expect(resolved.aggregation).toBe("all_pass");
	});
});

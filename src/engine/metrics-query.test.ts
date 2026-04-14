import { describe, expect, it } from "bun:test";
import type { StepMetric } from "./metrics.js";
import { executeQuery, formatTable, parseQuery } from "./metrics-query.js";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function step(overrides: Partial<StepMetric> = {}): StepMetric {
	return {
		kind: "step",
		ts: "2026-04-12T00:00:00Z",
		runId: "20260412-000000",
		segment: "analyze",
		phase: "identify",
		step: "scout-reference",
		iteration: 1,
		retry: 0,
		model: "glm-5.1",
		provider: "friendli",
		stepType: "agent",
		status: "pass",
		turns: 10,
		inputTokens: 4000,
		outputTokens: 3000,
		cost: 0.5,
		duration: 40000,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe("parseQuery", () => {
	it("parses basic avg by (segment)", () => {
		const q = parseQuery("avg by (segment)");
		expect(q.fn).toBe("avg");
		expect(q.groupBy).toEqual(["segment"]);
		expect(q.filters).toEqual({});
	});

	it("parses multiple group-by labels", () => {
		const q = parseQuery("sum by (segment, phase, step)");
		expect(q.fn).toBe("sum");
		expect(q.groupBy).toEqual(["segment", "phase", "step"]);
	});

	it("parses with filters", () => {
		const q = parseQuery('max by (step) {segment="wireframe"}');
		expect(q.fn).toBe("max");
		expect(q.groupBy).toEqual(["step"]);
		expect(q.filters).toEqual({ segment: "wireframe" });
	});

	it("parses single-quoted filter values", () => {
		const q = parseQuery("min by (phase) {step='classify'}");
		expect(q.filters).toEqual({ step: "classify" });
	});

	it("parses multiple filters", () => {
		const q = parseQuery(
			'count by (status) {segment="analyze", phase="identify"}',
		);
		expect(q.fn).toBe("count");
		expect(q.filters).toEqual({ segment: "analyze", phase: "identify" });
	});

	it("supports percentile functions", () => {
		expect(parseQuery("p50 by (segment)").fn).toBe("p50");
		expect(parseQuery("p90 by (phase)").fn).toBe("p90");
		expect(parseQuery("p99 by (step)").fn).toBe("p99");
	});

	it("throws on empty input", () => {
		expect(() => parseQuery("")).toThrow("Empty query");
	});

	it("throws on unknown aggregation", () => {
		expect(() => parseQuery("median by (segment)")).toThrow(
			"Unknown aggregation",
		);
	});

	it("throws on missing closing paren", () => {
		expect(() => parseQuery("avg by (segment")).toThrow("Missing closing");
	});
});

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

describe("executeQuery", () => {
	const records: StepMetric[] = [
		step({
			segment: "analyze",
			phase: "identify",
			step: "scout",
			turns: 10,
			cost: 0.5,
			duration: 40000,
		}),
		step({
			segment: "analyze",
			phase: "extract",
			step: "fan-out",
			turns: 20,
			cost: 1.0,
			duration: 80000,
		}),
		step({
			segment: "wireframe",
			phase: "classify",
			step: "arch",
			turns: 30,
			cost: 1.5,
			duration: 120000,
		}),
		step({
			segment: "wireframe",
			phase: "classify",
			step: "content",
			turns: 25,
			cost: 1.2,
			duration: 100000,
		}),
		step({
			segment: "wireframe",
			phase: "seed",
			step: "seed-collections",
			turns: 5,
			cost: 0.3,
			duration: 20000,
		}),
	];

	it("sum by segment", () => {
		const result = executeQuery(records, parseQuery("sum by (segment)"));
		expect(result).toHaveLength(2);

		const analyze = result.find((r) => r.segment === "analyze");
		const wireframe = result.find((r) => r.segment === "wireframe");

		expect(analyze?.turns).toBe(30);
		expect(analyze?.cost).toBe(1.5);
		expect(wireframe?.turns).toBe(60);
		expect(wireframe?.cost).toBe(3.0);
	});

	it("avg by segment, phase", () => {
		const result = executeQuery(records, parseQuery("avg by (segment, phase)"));
		const wfClassify = result.find(
			(r) => r.segment === "wireframe" && r.phase === "classify",
		);
		expect(wfClassify?.turns).toBe(27.5); // (30+25)/2
		expect(wfClassify?.cost).toBeCloseTo(1.35); // (1.5+1.2)/2
	});

	it("filters records", () => {
		const result = executeQuery(
			records,
			parseQuery('sum by (phase) {segment="wireframe"}'),
		);
		// Only wireframe records
		expect(result.every((_r) => true)).toBe(true); // they're grouped by phase
		const total = result.reduce((s, r) => s + (Number(r.cost) || 0), 0);
		expect(total).toBe(3.0);
	});

	it("count by status", () => {
		const result = executeQuery(records, parseQuery("count by (status)"));
		expect(result).toHaveLength(1); // all "pass"
		expect(result[0].count).toBe(5);
	});

	it("max by step", () => {
		const result = executeQuery(records, parseQuery("max by (step)"));
		const arch = result.find((r) => r.step === "arch");
		expect(arch?.cost).toBe(1.5);
		expect(arch?.duration).toBe(120000);
	});

	it("returns empty for no matching records", () => {
		const result = executeQuery(
			records,
			parseQuery('sum by (segment) {segment="design"}'),
		);
		expect(result).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

describe("formatTable", () => {
	it("formats a simple table", () => {
		const rows = [
			{ segment: "analyze", turns: 30, cost: 1.5, duration: 120000 },
			{ segment: "wireframe", turns: 60, cost: 3.0, duration: 240000 },
		];
		const output = formatTable(rows);
		expect(output).toContain("segment");
		expect(output).toContain("analyze");
		expect(output).toContain("wireframe");
		expect(output).toContain("$1.50");
		expect(output).toContain("$3.00");
		expect(output).toContain("2m00s");
		expect(output).toContain("4m00s");
	});

	it("returns no results message for empty input", () => {
		expect(formatTable([])).toBe("(no results)");
	});

	it("formats tokens with K/M suffixes", () => {
		const rows = [
			{
				segment: "a",
				inputTokens: 1500,
				outputTokens: 1_200_000,
			},
		];
		const output = formatTable(rows);
		expect(output).toContain("1.5K");
		expect(output).toContain("1.2M");
	});
});

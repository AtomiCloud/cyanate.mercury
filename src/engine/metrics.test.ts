import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunMetric, SegmentMetric, StepMetric } from "./metrics.js";
import { MetricsWriter, readMetrics } from "./metrics.js";

describe("MetricsWriter", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "metrics-test-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	function makeStep(overrides: Partial<StepMetric> = {}): StepMetric {
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
			turns: 12,
			inputTokens: 4200,
			outputTokens: 3100,
			cost: 0.54,
			duration: 41391,
			...overrides,
		};
	}

	it("writes and reads back step metrics", async () => {
		const writer = new MetricsWriter(dir);
		const step = makeStep();
		writer.record(step);

		// Give fire-and-forget a moment
		await new Promise((r) => setTimeout(r, 50));

		const records = await readMetrics(dir);
		expect(records).toHaveLength(1);
		expect(records[0]).toEqual(step);
	});

	it("writes multiple record kinds", async () => {
		const writer = new MetricsWriter(dir);

		writer.record(makeStep());
		writer.record(makeStep({ step: "build-catalog", turns: 0, cost: 0 }));

		const segMetric: SegmentMetric = {
			kind: "segment",
			ts: "2026-04-12T00:05:00Z",
			runId: "20260412-000000",
			segment: "analyze",
			status: "completed",
			steps: 2,
			turns: 12,
			inputTokens: 4200,
			outputTokens: 3100,
			cost: 0.54,
			duration: 50000,
		};
		writer.record(segMetric);

		const runMetric: RunMetric = {
			kind: "run",
			ts: "2026-04-12T00:10:00Z",
			runId: "20260412-000000",
			status: "completed",
			segments: 1,
			steps: 2,
			turns: 12,
			inputTokens: 4200,
			outputTokens: 3100,
			cost: 0.54,
			duration: 60000,
		};
		writer.record(runMetric);

		await new Promise((r) => setTimeout(r, 50));

		const records = await readMetrics(dir);
		expect(records).toHaveLength(4);
		expect(records.filter((r) => r.kind === "step")).toHaveLength(2);
		expect(records.filter((r) => r.kind === "segment")).toHaveLength(1);
		expect(records.filter((r) => r.kind === "run")).toHaveLength(1);
	});

	it("readMetrics returns empty for missing file", async () => {
		const records = await readMetrics(join(dir, "nonexistent"));
		expect(records).toHaveLength(0);
	});
});

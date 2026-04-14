/**
 * Structured metrics persistence.
 *
 * Writes labeled metric records to a JSONL file at runs/<run-id>/metrics.jsonl.
 * Each line is a self-contained JSON object with dimensional labels
 * (segment, phase, step, model, etc.) and numeric values (duration, tokens, cost).
 *
 * Three record kinds:
 *   - "step"    — one per step execution
 *   - "segment" — one per segment completion
 *   - "run"     — one per DAG run completion
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

/** Step-level metric record. */
export interface StepMetric {
	kind: "step";
	ts: string;
	runId: string;
	segment: string;
	phase: string;
	step: string;
	iteration: number;
	retry: number;
	model: string;
	provider: string;
	stepType: "agent" | "programmatic" | "reviewer";
	status: "pass" | "reject" | "fail";
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	/** Wall-clock duration in ms */
	duration: number;
}

/** Segment-level summary record. */
export interface SegmentMetric {
	kind: "segment";
	ts: string;
	runId: string;
	segment: string;
	status: "completed" | "failed";
	steps: number;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	duration: number;
}

/** Run-level summary record. */
export interface RunMetric {
	kind: "run";
	ts: string;
	runId: string;
	status: "completed" | "failed";
	segments: number;
	steps: number;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	duration: number;
}

export type MetricRecord = StepMetric | SegmentMetric | RunMetric;

// ---------------------------------------------------------------------------
// Numeric value keys (for query engine)
// ---------------------------------------------------------------------------

/** All numeric fields present on StepMetric that the query engine aggregates. */
export const STEP_VALUE_KEYS = [
	"turns",
	"inputTokens",
	"outputTokens",
	"cost",
	"duration",
] as const;

export type StepValueKey = (typeof STEP_VALUE_KEYS)[number];

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

const METRICS_FILE = "metrics.jsonl";

export class MetricsWriter {
	private readonly path: string;

	constructor(runDir: string) {
		this.path = join(runDir, METRICS_FILE);
	}

	/** Append a metric record (fire-and-forget). */
	record(entry: MetricRecord): void {
		const line = `${JSON.stringify(entry)}\n`;
		appendFile(this.path, line, "utf-8").catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// Reader (for CLI query)
// ---------------------------------------------------------------------------

export async function readMetrics(runDir: string): Promise<MetricRecord[]> {
	const { readFile } = await import("node:fs/promises");
	let raw: string;
	try {
		raw = await readFile(join(runDir, METRICS_FILE), "utf-8");
	} catch {
		return [];
	}
	const records: MetricRecord[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line) as MetricRecord);
		} catch {
			// skip malformed lines
		}
	}
	return records;
}

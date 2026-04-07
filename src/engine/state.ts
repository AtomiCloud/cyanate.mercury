/**
 * Pipeline state persistence.
 *
 * Each segment maintains a pipeline.json that tracks:
 * - Current phase and iteration
 * - Per-iteration status and step results
 * - Whether the segment completed, failed, or needs retry
 *
 * This enables --from resumption and run inspection.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	IterationState,
	PipelineState,
	RunState,
	StepState,
} from "./types.js";

const PIPELINE_FILE = "pipeline.json";
const RUN_FILE = "run.json";

// ---------------------------------------------------------------------------
// Pipeline state (per segment)
// ---------------------------------------------------------------------------

export async function readPipelineState(
	segmentDir: string,
): Promise<PipelineState | null> {
	try {
		const raw = await readFile(join(segmentDir, PIPELINE_FILE), "utf-8");
		return JSON.parse(raw) as PipelineState;
	} catch {
		return null;
	}
}

export async function writePipelineState(
	segmentDir: string,
	state: PipelineState,
): Promise<void> {
	await writeFile(
		join(segmentDir, PIPELINE_FILE),
		JSON.stringify(state, null, 2),
		"utf-8",
	);
}

export function createPipelineState(
	runId: string,
	segmentId: string,
	firstPhaseId: string,
): PipelineState {
	return {
		runId,
		segmentId,
		status: "running",
		startedAt: new Date().toISOString(),
		currentPhase: firstPhaseId,
		currentIteration: 0,
		iterations: [],
	};
}

export function createIterationState(
	index: number,
	phaseId: string,
	segmentId: string,
	workdir: string,
	steps: string[],
): IterationState {
	return {
		index,
		phaseId,
		segmentId,
		status: "running",
		startedAt: new Date().toISOString(),
		steps: steps.map(
			(stepId): StepState => ({
				stepId,
				status: "pending",
			}),
		),
		workdir,
	};
}

// ---------------------------------------------------------------------------
// Run state (top-level)
// ---------------------------------------------------------------------------

export async function readRunState(runDir: string): Promise<RunState | null> {
	try {
		const raw = await readFile(join(runDir, RUN_FILE), "utf-8");
		return JSON.parse(raw) as RunState;
	} catch {
		return null;
	}
}

export async function writeRunState(
	runDir: string,
	state: RunState,
): Promise<void> {
	await writeFile(
		join(runDir, RUN_FILE),
		JSON.stringify(state, null, 2),
		"utf-8",
	);
}

export function createRunState(runId: string, segmentIds: string[]): RunState {
	const segments: RunState["segments"] = {};
	for (const id of segmentIds) {
		segments[id] = { status: "pending" };
	}
	return {
		runId,
		status: "running",
		startedAt: new Date().toISOString(),
		segments,
	};
}

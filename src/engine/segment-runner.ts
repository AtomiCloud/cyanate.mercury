/**
 * Segment runner.
 *
 * Executes phases within a segment sequentially, managing iterations.
 *
 * Flow:
 *   1. Optionally resume from a specific phase (--from)
 *   2. For each phase: run with retry on rejection
 *   3. Extract output from final iteration
 */

import type { PipelineLogger } from "../lib/logger.js";
import { type PhaseRunResult, runPhase } from "./phase-runner.js";
import {
	createPipelineState,
	readPipelineState,
	writePipelineState,
} from "./state.js";
import type {
	CuiConfig,
	PhaseDef,
	PipelineState,
	SegmentDef,
} from "./types.js";
import { createIteration, createSegmentDir } from "./workdir.js";

export interface SegmentRunOptions {
	segment: SegmentDef;
	runId: string;
	runDir: string;
	depOutputs: Record<string, string>;
	fromPhase?: string;
	config: CuiConfig;
	logger: PipelineLogger;
}

export interface SegmentRunResult {
	status: "completed" | "failed";
	outputDir?: string;
	error?: string;
}

export async function runSegment(
	opts: SegmentRunOptions,
): Promise<SegmentRunResult> {
	const { segment, runId, runDir, depOutputs, fromPhase, config, logger } =
		opts;

	const segmentDir = await createSegmentDir(runDir, segment.id);
	const pipelineState = await resolveState(segmentDir, runId, segment);
	const phases = resolvePhases(segment, fromPhase);
	if (typeof phases === "string") {
		return { status: "failed", error: phases };
	}

	let lastWorkdir = recoverLastWorkdir(pipelineState);
	lastWorkdir = await mergeIfNeeded(
		lastWorkdir,
		depOutputs,
		segmentDir,
		pipelineState,
		segment,
	);

	let iterationCounter = lastIterationIndex(pipelineState);

	for (const phase of phases) {
		const result = await runPhaseWithRetries(
			phase,
			segment,
			segmentDir,
			runId,
			runDir,
			config,
			logger,
			pipelineState,
			lastWorkdir,
			iterationCounter,
		);

		if (result.status === "failed") {
			await markFailed(segmentDir, pipelineState);
			return { status: "failed", error: result.error };
		}

		lastWorkdir = result.workdir;
		iterationCounter = result.iterationCounter;
	}

	const outputDir = `${segmentDir}/output`;
	if (lastWorkdir) {
		await segment.extractOutput(lastWorkdir, outputDir);
	}

	pipelineState.status = "completed";
	pipelineState.finishedAt = new Date().toISOString();
	await writePipelineState(segmentDir, pipelineState);

	return { status: "completed", outputDir };
}

// --- Helpers ---

async function resolveState(
	segmentDir: string,
	runId: string,
	segment: SegmentDef,
): Promise<PipelineState> {
	const existing = await readPipelineState(segmentDir);
	if (existing?.status === "running") return existing;
	return createPipelineState(runId, segment.id, segment.phases[0].id);
}

function resolvePhases(
	segment: SegmentDef,
	fromPhase?: string,
): PhaseDef[] | string {
	if (!fromPhase) return segment.phases;
	const idx = segment.phases.findIndex((p) => p.id === fromPhase);
	if (idx === -1) {
		return `Phase "${fromPhase}" not found in segment "${segment.id}". Available: ${segment.phases.map((p) => p.id).join(", ")}`;
	}
	return segment.phases.slice(idx);
}

function recoverLastWorkdir(state: PipelineState): string | null {
	if (state.iterations.length === 0) return null;
	const last = state.iterations[state.iterations.length - 1];
	return last.status === "passed" ? last.workdir : null;
}

async function mergeIfNeeded(
	lastWorkdir: string | null,
	depOutputs: Record<string, string>,
	segmentDir: string,
	pipelineState: PipelineState,
	segment: SegmentDef,
): Promise<string | null> {
	if (lastWorkdir || Object.keys(depOutputs).length === 0) return lastWorkdir;
	const initDir = await createIteration(segmentDir, 0, "init", null);
	await segment.mergeInputs(initDir, depOutputs);
	pipelineState.currentIteration = 0;
	return initDir;
}

function lastIterationIndex(state: PipelineState): number {
	if (state.iterations.length === 0) return 0;
	return state.iterations[state.iterations.length - 1].index;
}

interface PhaseWithRetriesResult {
	status: "passed" | "failed";
	workdir: string | null;
	iterationCounter: number;
	error?: string;
}

async function runPhaseWithRetries(
	phase: PhaseDef,
	segment: SegmentDef,
	segmentDir: string,
	runId: string,
	runDir: string,
	config: CuiConfig,
	logger: PipelineLogger,
	pipelineState: PipelineState,
	lastWorkdir: string | null,
	iterationCounter: number,
): Promise<PhaseWithRetriesResult> {
	let retries = 0;
	let rejectionContext: string | undefined;
	let sourceDir = lastWorkdir;
	let counter = iterationCounter;

	while (retries <= phase.maxRetries) {
		counter++;

		const result: PhaseRunResult = await runPhase({
			phase,
			segmentId: segment.id,
			segmentDir,
			runId,
			runDir,
			iterationIndex: counter,
			sourceDir,
			rejectionContext,
			config,
			pipelineState,
			logger,
		});

		if (result.status === "passed") {
			return {
				status: "passed",
				workdir: result.iteration.workdir,
				iterationCounter: counter,
			};
		}

		if (result.status === "failed") {
			return {
				status: "failed",
				workdir: null,
				iterationCounter: counter,
				error: `Phase "${phase.id}" failed: ${result.error}`,
			};
		}

		retries++;
		rejectionContext = result.rejectionContext;
		sourceDir = result.iteration.workdir;

		if (retries > phase.maxRetries) {
			return {
				status: "failed",
				workdir: null,
				iterationCounter: counter,
				error: `Phase "${phase.id}" exhausted ${phase.maxRetries} retries`,
			};
		}

		logger.startStep(
			`Retrying ${segment.id}/${phase.id} (attempt ${retries + 1}/${phase.maxRetries + 1})`,
		);
	}

	return { status: "failed", workdir: null, iterationCounter: counter };
}

async function markFailed(
	segmentDir: string,
	pipelineState: PipelineState,
): Promise<void> {
	pipelineState.status = "failed";
	pipelineState.finishedAt = new Date().toISOString();
	await writePipelineState(segmentDir, pipelineState);
}

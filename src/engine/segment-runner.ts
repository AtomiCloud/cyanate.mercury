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
import type { MetricsWriter } from "./metrics.js";
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
	metrics?: MetricsWriter;
}

export interface SegmentRunResult {
	status: "completed" | "failed";
	outputDir?: string;
	error?: string;
}

export async function runSegment(
	opts: SegmentRunOptions,
): Promise<SegmentRunResult> {
	const {
		segment,
		runId,
		runDir,
		depOutputs,
		fromPhase,
		config,
		logger,
		metrics,
	} = opts;

	logger.startSegment(segment.id);

	const segmentDir = await createSegmentDir(runDir, segment.id);
	const pipelineState = await resolveState(segmentDir, runId, segment);
	const phases = resolvePhases(segment, fromPhase);
	if (typeof phases === "string") {
		const stats = logger.finishSegment(segment.id, "failed");
		metrics?.record({
			kind: "segment",
			ts: new Date().toISOString(),
			runId,
			segment: segment.id,
			status: "failed",
			...stats,
		});
		return { status: "failed", error: phases };
	}

	let lastWorkdir = recoverLastWorkdir(pipelineState);
	lastWorkdir = await mergeIfNeeded(
		lastWorkdir,
		depOutputs,
		segmentDir,
		pipelineState,
		segment,
		config,
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
			metrics,
		);

		if (result.status === "failed") {
			await markFailed(segmentDir, pipelineState);
			const stats = logger.finishSegment(segment.id, "failed");
			metrics?.record({
				kind: "segment",
				ts: new Date().toISOString(),
				runId,
				segment: segment.id,
				status: "failed",
				...stats,
			});
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

	const stats = logger.finishSegment(segment.id, "completed");
	metrics?.record({
		kind: "segment",
		ts: new Date().toISOString(),
		runId,
		segment: segment.id,
		status: "completed",
		...stats,
	});
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
	config: CuiConfig,
): Promise<string | null> {
	if (lastWorkdir) return lastWorkdir;
	const initDir = await createIteration(segmentDir, 0, "init", null);
	await segment.mergeInputs(initDir, depOutputs, config);
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
	metrics?: MetricsWriter,
): Promise<PhaseWithRetriesResult> {
	// Programmatic-only phases are deterministic: same input → same output.
	// Retrying without an agent/reviewer to adjust behavior is pointless.
	const hasNonDeterministic = phase.steps.some(
		(s) => s.type === "agent" || s.type === "reviewer",
	);
	const effectiveMaxRetries = hasNonDeterministic ? phase.maxRetries : 0;
	if (!hasNonDeterministic && phase.maxRetries > 0) {
		logger.note(
			`Phase "${phase.id}" has no agent/reviewer steps — clamping retries to 0 (no agent to adjust behavior between attempts)`,
		);
	}

	const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

	let retries = 0;
	let rejectionContext: string | undefined;
	let sourceDir = lastWorkdir;
	let counter = iterationCounter;

	while (retries <= effectiveMaxRetries) {
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
			retry: retries,
			config,
			pipelineState,
			logger,
			metrics,
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

		// Bail early if rejection context is identical to previous attempt
		// (deterministic failure — retrying with same input is pointless)
		// Normalize whitespace so minor formatting differences don't bypass detection.
		if (
			rejectionContext !== undefined &&
			result.rejectionContext !== undefined &&
			normalize(rejectionContext) === normalize(result.rejectionContext)
		) {
			return {
				status: "failed",
				workdir: null,
				iterationCounter: counter,
				error: `Phase "${phase.id}" bailed: identical rejection on consecutive retries. Context: ${result.rejectionContext.slice(0, 200)}`,
			};
		}

		retries++;
		rejectionContext = result.rejectionContext;
		sourceDir = result.iteration.workdir;

		if (retries > effectiveMaxRetries) {
			return {
				status: "failed",
				workdir: null,
				iterationCounter: counter,
				error: `Phase "${phase.id}" exhausted ${effectiveMaxRetries} retries`,
			};
		}

		logger.note(
			`Retrying ${segment.id}/${phase.id} (attempt ${retries + 1}/${effectiveMaxRetries + 1})`,
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

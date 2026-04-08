/**
 * Phase runner.
 *
 * Executes steps within a phase, handles retry on rejection.
 *
 * Flow per phase:
 *   1. Create new iteration (copy workdir from previous)
 *   2. Run each step sequentially in the shared workdir
 *   3. If a step rejects → fail the phase, aggregate reviews
 *   4. If a step fails → fail the phase with error
 *   5. If all pass → phase complete
 *
 * On rejection, the caller (segment-runner) creates a new iteration
 * copying from THIS failed iteration and passes rejection context.
 */

import type { PipelineLogger } from "../lib/logger.js";
import { resolveProfile } from "./profile.js";
import { createIterationState, writePipelineState } from "./state.js";
import type {
	CuiConfig,
	IterationState,
	PhaseDef,
	PipelineState,
	Review,
	StepContext,
	StepDef,
	StepResult,
	StepState,
} from "./types.js";
import { createIteration } from "./workdir.js";

export interface PhaseRunResult {
	status: "passed" | "rejected" | "failed";
	iteration: IterationState;
	reviews: Review[];
	rejectionContext?: string;
	error?: string;
}

export interface PhaseRunOptions {
	phase: PhaseDef;
	segmentId: string;
	segmentDir: string;
	runId: string;
	runDir: string;
	iterationIndex: number;
	sourceDir: string | null;
	rejectionContext?: string;
	config: CuiConfig;
	pipelineState: PipelineState;
	logger: PipelineLogger;
}

export async function runPhase(opts: PhaseRunOptions): Promise<PhaseRunResult> {
	const { phase, segmentId, segmentDir, iterationIndex, sourceDir, logger } =
		opts;

	const workdir = await createIteration(
		segmentDir,
		iterationIndex,
		phase.id,
		sourceDir,
	);

	const iterState = createIterationState(
		iterationIndex,
		phase.id,
		segmentId,
		workdir,
		phase.steps.map((s) => s.id),
	);

	opts.pipelineState.currentIteration = iterationIndex;
	opts.pipelineState.currentPhase = phase.id;
	opts.pipelineState.iterations.push(iterState);
	await writePipelineState(segmentDir, opts.pipelineState);

	logger.startStep(`${segmentId}/${phase.id} (iteration ${iterationIndex})`);

	const allReviews: Review[] = [];

	for (const step of phase.steps) {
		const result = await executeStep(
			step,
			iterState,
			workdir,
			allReviews,
			opts,
		);
		if (result) return result;
	}

	return finishIteration(
		iterState,
		allReviews,
		"passed",
		segmentDir,
		opts,
		logger,
	);
}

/** Execute a single step and return early result if phase should stop. */
async function executeStep(
	step: StepDef,
	iterState: IterationState,
	workdir: string,
	allReviews: Review[],
	opts: PhaseRunOptions,
): Promise<PhaseRunResult | null> {
	const stepState = iterState.steps.find((s) => s.stepId === step.id);
	if (!stepState) return null;

	stepState.status = "running";
	stepState.startedAt = new Date().toISOString();
	await writePipelineState(opts.segmentDir, opts.pipelineState);

	const profile = resolveProfile(
		opts.config,
		opts.segmentId,
		opts.phase.id,
		step.profileKey ?? step.id,
	);

	const ctx: StepContext = {
		workdir,
		segmentId: opts.segmentId,
		phaseId: opts.phase.id,
		stepId: step.id,
		runId: opts.runId,
		runDir: opts.runDir,
		iteration: opts.iterationIndex,
		profile,
		rejectionContext: opts.rejectionContext,
		logger: opts.logger,
		config: opts.config,
	};

	const result = await safeRunStep(step, ctx);
	stepState.finishedAt = new Date().toISOString();
	stepState.duration = result.duration;

	if (result.status === "reject") {
		return handleRejection(stepState, result, iterState, allReviews, opts);
	}

	if (result.status === "fail") {
		return handleFailure(stepState, result, iterState, opts);
	}

	stepState.status = "passed";
	if (result.reviews) {
		stepState.reviews = result.reviews;
		allReviews.push(...result.reviews);
	}
	await writePipelineState(opts.segmentDir, opts.pipelineState);
	return null;
}

async function safeRunStep(
	step: StepDef,
	ctx: StepContext,
): Promise<StepResult> {
	try {
		if (step.parallel && step.parallel > 1) {
			return await runParallelStep(step.run, ctx, step.parallel);
		}
		return await step.run(ctx);
	} catch (err) {
		return {
			status: "fail",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

function handleRejection(
	stepState: StepState,
	result: StepResult,
	iterState: IterationState,
	allReviews: Review[],
	opts: PhaseRunOptions,
): PhaseRunResult {
	stepState.status = "rejected";
	stepState.reviews = result.reviews;
	if (result.reviews) allReviews.push(...result.reviews);
	skipPending(iterState);
	return finishIterationSync(iterState, allReviews, "rejected", opts);
}

function handleFailure(
	stepState: StepState,
	result: StepResult,
	iterState: IterationState,
	opts: PhaseRunOptions,
): PhaseRunResult {
	stepState.status = "failed";
	stepState.error = result.error;
	skipPending(iterState);
	return finishIterationSync(iterState, [], "failed", opts, result.error);
}

function skipPending(iterState: IterationState): void {
	for (const s of iterState.steps) {
		if (s.status === "pending") s.status = "skipped";
	}
}

function finishIterationSync(
	iterState: IterationState,
	reviews: Review[],
	status: "rejected" | "failed",
	opts: PhaseRunOptions,
	error?: string,
): PhaseRunResult {
	iterState.status = status;
	iterState.finishedAt = new Date().toISOString();
	iterState.reviews = reviews;
	if (status === "rejected") {
		iterState.rejectionContext = aggregateRejectionContext(reviews);
	}
	// Fire-and-forget state write
	writePipelineState(opts.segmentDir, opts.pipelineState);
	return {
		status,
		iteration: iterState,
		reviews,
		rejectionContext: iterState.rejectionContext,
		error,
	};
}

async function finishIteration(
	iterState: IterationState,
	reviews: Review[],
	status: "passed",
	segmentDir: string,
	opts: PhaseRunOptions,
	logger: PipelineLogger,
): Promise<PhaseRunResult> {
	iterState.status = status;
	iterState.finishedAt = new Date().toISOString();
	iterState.reviews = reviews;
	await writePipelineState(segmentDir, opts.pipelineState);
	logger.completeStep();
	return { status, iteration: iterState, reviews };
}

async function runParallelStep(
	fn: (ctx: StepContext) => Promise<StepResult>,
	ctx: StepContext,
	count: number,
): Promise<StepResult> {
	const results = await Promise.all(
		Array.from({ length: count }, (_, i) =>
			fn({ ...ctx, stepId: `${ctx.stepId}[${i}]` }),
		),
	);

	const allReviews: Review[] = [];
	let worstStatus: StepResult["status"] = "pass";

	for (const r of results) {
		if (r.reviews) allReviews.push(...r.reviews);
		if (r.status === "fail") worstStatus = "fail";
		else if (r.status === "reject" && worstStatus !== "fail")
			worstStatus = "reject";
	}

	return { status: worstStatus, reviews: allReviews };
}

function aggregateRejectionContext(reviews: Review[]): string {
	const rejections = reviews.filter((r) => r.verdict === "reject");
	if (rejections.length === 0) return "";

	return rejections
		.map((r) => `[${r.reviewerId}] ${r.rejectionContext ?? r.findings}`)
		.join("\n\n");
}

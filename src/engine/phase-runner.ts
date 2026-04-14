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
import type { MetricsWriter } from "./metrics.js";
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
	/** Which retry attempt within this phase (0 = first try) */
	retry: number;
	config: CuiConfig;
	pipelineState: PipelineState;
	logger: PipelineLogger;
	metrics?: MetricsWriter;
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

	const phaseStart = Date.now();
	logger.startStep(`${segmentId}/${phase.id} (iteration ${iterationIndex})`);
	logger.completeStep();

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
		phaseStart,
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

	const stepLabel = `${opts.segmentId}/${opts.phase.id}/${step.id}`;
	opts.logger.startStep(stepLabel);

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
		retry: opts.retry,
		profile,
		rejectionContext: opts.rejectionContext,
		logger: opts.logger,
		config: opts.config,
	};

	const result = await safeRunStep(step, ctx);
	stepState.finishedAt = new Date().toISOString();
	stepState.duration = result.duration;

	// Record step metric
	opts.metrics?.record({
		kind: "step",
		ts: new Date().toISOString(),
		runId: opts.runId,
		segment: opts.segmentId,
		phase: opts.phase.id,
		step: step.id,
		iteration: opts.iterationIndex,
		retry: opts.retry,
		model: profile.model,
		provider: profile.provider,
		stepType: step.type,
		status: result.status,
		turns: result.turns ?? 0,
		inputTokens: result.inputTokens ?? 0,
		outputTokens: result.outputTokens ?? 0,
		cost: result.cost ?? 0,
		duration: result.duration ?? 0,
	});

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
	opts.logger.completeStep();
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
	const context = aggregateRejectionContext(allReviews);
	opts.logger.failStep(context);
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
	opts.logger.failStep(result.error ?? "unknown error");
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
	phaseStart?: number,
): Promise<PhaseRunResult> {
	iterState.status = status;
	iterState.finishedAt = new Date().toISOString();
	iterState.reviews = reviews;
	await writePipelineState(segmentDir, opts.pipelineState);
	if (phaseStart) {
		const elapsed = Date.now() - phaseStart;
		logger.startStep(
			`${opts.segmentId}/${opts.phase.id} done (${formatPhaseDuration(elapsed)})`,
		);
		logger.completeStep();
	}
	return { status, iteration: iterState, reviews };
}

function formatPhaseDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const secs = ms / 1000;
	if (secs < 60) return `${secs.toFixed(1)}s`;
	const mins = Math.floor(secs / 60);
	const rem = Math.round(secs % 60);
	return `${mins}m${rem.toString().padStart(2, "0")}s`;
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

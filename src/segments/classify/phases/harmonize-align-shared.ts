/**
 * Shared logic for the dynamic harmonize-align phase.
 *
 * Per pagetype we loop until convergence: each iteration batches the
 * current candidate set into groups of `pagesPerBatch` (5 by default,
 * overridable via `classify.pagesPerBatch`) and runs one agent call per
 * batch.
 * Iteration 1's input is the pagetype's original `digest.json`, split into
 * one digest item per page; iteration N≥2 picks up the prior iteration's
 * per-batch output digests. Each iteration reduces `N` digests to
 * `ceil(N / pagesPerBatch)` digests, so convergence is structural: the loop
 * stops when the current iteration emits exactly one digest.
 *
 * Per-batch attempt mechanics are unchanged: the agent writes ops.json,
 * invokes `./validate` (a CLI wrapping `validateAlignOps`), iterates
 * within its own tool-use loop, and submits. The runner then calls
 * `validateAlignOps` independently on the submitted ops (single source
 * of truth, same code) and invokes the batch-level convergence reviewer
 * (LLM judge on the post-apply shape). Up to 2 attempt retries with
 * `previous-attempt.json` seeded into the retry workdir so the agent
 * can fix rather than re-derive.
 *
 * Each iteration writes `layer-N/` batch artifacts (N is the runtime
 * iteration count): one rename table + one output digest per batch. We do
 * not union sibling rename tables inside the iteration. Instead, after the
 * reduction reaches a single final digest, we compose every per-batch rename
 * table across every layer into pagetype-root artifacts
 * (`rename-table.composed.json`, `digest.composed.json`, and the legacy
 * flat `rename-table.json` for verdicts/assemble).
 *
 * Pass-through semantics: pagetypes with `totalPages <= 1` skip the LLM
 * entirely (no aliases possible); iteration 1 always runs for multi-page
 * pagetypes, even with a single batch, because that's where first-pass
 * renaming happens.
 *
 * Resume idempotency: on restart, any `layer-N/` whose `iteration.json` is
 * already committed is skipped — we reload its emitted digests and continue
 * the reduction from there. This preserves today's cross-phase resume
 * behavior (don't redo LLM work that already passed).
 */

import {
	access,
	chmod,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProfile } from "../../../engine/profile.js";
import type {
	PhaseDef,
	Review,
	StepContext,
	StepResult,
} from "../../../engine/types.js";
import { agentQueryWithMetrics } from "../../../lib/agent.js";
import { parseReviewerVerdict } from "../../../lib/reviewers.js";
import { agentFanOutStep } from "../../../steps/step.js";
import { validateAlignOps } from "../lib/harmonize-align-validate.js";
import {
	batchItems,
	digestFromChunks,
	mergeDigests,
	PAGES_PER_BATCH,
	pageChunks,
} from "../lib/harmonize-batch.js";
import {
	assertComposedCoverage,
	buildComposedRenameTrace,
	composeRenameTables,
	type LayerRenameInput,
} from "../lib/harmonize-compose.js";
import {
	type ConvergenceMetrics,
	computeConvergenceMetrics,
	type FoldDiffBucket,
} from "../lib/harmonize-metrics.js";
import type {
	ElementKeyRenameSidecar,
	PageTypeDigest,
	RenameTable,
	RichRenameOp,
	StructuralSignals,
} from "../lib/harmonize-types.js";
import {
	discoverPagetypeDirs,
	readDigest,
	readSignals,
} from "./harmonize-shared.js";

// Hard-coded; see CLASSIFY-PLAN.md Stage 3 for rationale.
const MAX_PER_BATCH_RETRIES = 2;

/**
 * Safety cap on the dynamic align loop. With a batch size of 5, six
 * iterations comfortably cover 5^6 = 15,625 pages; anything larger is
 * likely a non-convergence defect rather than legitimate scale, and
 * should fail loudly rather than burn LLM budget forever.
 */
const MAX_ITERATIONS = 6;

/**
 * Absolute path to the CLI validator the agent invokes via `./validate` in
 * each attempt's workdir. Resolved from this file's location so the pipeline
 * works regardless of the caller's cwd.
 */
const VALIDATE_ALIGN_OPS_CLI = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"cli",
	"validate-align-ops.ts",
);

const SUGGEST_FOLDS_CLI = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"cli",
	"suggest-folds.ts",
);

const REVIEW_ALIGN_CLI = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"cli",
	"review-align.ts",
);

const OPS_IFY_CLI = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"cli",
	"ops-ify.ts",
);

const REMEMBER_REJECT_CLI = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"cli",
	"remember-reject.ts",
);

interface Totals {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

interface AlignDigestItem {
	itemId: string;
	digest: PageTypeDigest;
}

interface IterationManifest {
	iteration: number;
	inputItemCount: number;
	outputDigestCount: number;
	converged: boolean;
}

// ---------------------------------------------------------------------------
// Phase factory
// ---------------------------------------------------------------------------

export function buildAlignPhase(): PhaseDef {
	return {
		id: "harmonize-align",
		name: "Harmonize align (dynamic tree-reduce)",
		description:
			"Per-pagetype agent fan-out over configurable batches (default 5 pages); loops until each pagetype's candidate set reduces to ≤ 1 batch, capped at 6 iterations.",
		maxRetries: 0,
		steps: [
			agentFanOutStep({
				id: "harmonize-align",
				name: "Harmonize align fan-out",
				description:
					"Dynamic tree-reduce: iterate per-batch agent fan-out until each pagetype converges to ≤ 1 batch.",
				profileKey: "align-agent",
				run: (ctx) => runAlign(ctx),
			}),
		],
	};
}

// ---------------------------------------------------------------------------
// Phase entry point
// ---------------------------------------------------------------------------

async function runAlign(ctx: StepContext): Promise<StepResult> {
	const start = Date.now();
	const totals: Totals = { turns: 0, inputTokens: 0, outputTokens: 0, cost: 0 };

	const pagetypes = await discoverPagetypeDirs(ctx.workdir);
	if (pagetypes.length === 0) {
		return {
			status: "fail",
			error:
				"harmonize-align: no pagetype digests found; harmonize-prepare must run first",
			duration: Date.now() - start,
		};
	}

	const reviewerProfile = resolveProfile(
		ctx.config,
		"classify",
		"harmonize-align",
		"align-reviewer",
	);

	const pagesPerBatch = ctx.config.classify?.pagesPerBatch ?? PAGES_PER_BATCH;

	const results = await Promise.all(
		pagetypes.map((pt) =>
			processPagetype(pt, ctx, reviewerProfile, totals, pagesPerBatch),
		),
	);

	const duration = Date.now() - start;
	const metrics = {
		turns: totals.turns,
		inputTokens: totals.inputTokens,
		outputTokens: totals.outputTokens,
		cost: totals.cost,
	};

	const failures = results.filter((r) => r.status !== "pass");
	if (failures.length > 0) {
		const reviews: Review[] = failures.flatMap((f) =>
			(f.reviews ?? []).map((r) => ({
				...r,
				reviewerId: `harmonize-align/${f.pagetype}/${r.reviewerId}`,
			})),
		);
		const fallbackReviews: Review[] =
			reviews.length > 0
				? reviews
				: failures.map((f) => ({
						reviewerId: `harmonize-align/${f.pagetype}`,
						verdict: "reject" as const,
						findings: f.error ?? "align phase failed",
						rejectionContext: f.error ?? "align phase failed",
					}));
		return { status: "reject", reviews: fallbackReviews, duration, ...metrics };
	}
	return { status: "pass", duration, ...metrics };
}

// ---------------------------------------------------------------------------
// Per-pagetype orchestration
// ---------------------------------------------------------------------------

interface PagetypeOutcome {
	pagetype: string;
	status: "pass" | "fail";
	error?: string;
	reviews?: Review[];
}

async function processPagetype(
	ptDir: { pagetype: string; outDir: string },
	ctx: StepContext,
	reviewerProfile: ReturnType<typeof resolveProfile>,
	totals: Totals,
	pagesPerBatch: number,
): Promise<PagetypeOutcome> {
	let originalDigest: PageTypeDigest;
	let signals: StructuralSignals | null = null;
	try {
		originalDigest = await readDigest(ptDir.outDir);
		signals = await readSignals(ptDir.outDir);
	} catch (err) {
		return {
			pagetype: ptDir.pagetype,
			status: "fail",
			error: `failed to load harmonize-prepare input: ${String(err)}`,
		};
	}

	// Single-page pagetypes (totalPages ≤ 1) have no cross-page aliases
	// to detect at any iteration — skip the LLM entirely. Downstream
	// (harmonize-verdicts, harmonize-assemble, chrome-verify) also skips
	// these pagetypes; cross-pagetype harmonization will handle them
	// later.
	if (originalDigest.totalPages <= 1) {
		return await runSinglePagePassthrough(ptDir, originalDigest);
	}

	const loopResult = await iterateUntilConverged({
		ptDir,
		originalDigest,
		ctx,
		reviewerProfile,
		totals,
		signals,
		pagesPerBatch,
	});
	if (loopResult.status === "fail") {
		return {
			pagetype: ptDir.pagetype,
			status: "fail",
			error: loopResult.error,
			reviews: loopResult.reviews,
		};
	}

	const composeErr = await writeComposedArtifacts(
		ptDir.outDir,
		loopResult.finalIteration,
	);
	if (composeErr) {
		return { pagetype: ptDir.pagetype, status: "fail", error: composeErr };
	}
	return { pagetype: ptDir.pagetype, status: "pass" };
}

async function runSinglePagePassthrough(
	ptDir: { pagetype: string; outDir: string },
	originalDigest: PageTypeDigest,
): Promise<PagetypeOutcome> {
	const iterDir = join(ptDir.outDir, "layer-1");
	await rm(iterDir, { recursive: true, force: true });
	await mkdir(iterDir, { recursive: true });
	await writePassThroughLayer(iterDir, originalDigest);
	const composeErr = await writeComposedArtifacts(ptDir.outDir, 1);
	if (composeErr) {
		return { pagetype: ptDir.pagetype, status: "fail", error: composeErr };
	}
	return { pagetype: ptDir.pagetype, status: "pass" };
}

interface IterateArgs {
	ptDir: { pagetype: string; outDir: string };
	originalDigest: PageTypeDigest;
	ctx: StepContext;
	reviewerProfile: ReturnType<typeof resolveProfile>;
	totals: Totals;
	signals: StructuralSignals | null;
	pagesPerBatch: number;
}

type IterateResult =
	| { status: "pass"; finalIteration: number }
	| { status: "fail"; error: string; reviews?: Review[] };

async function iterateUntilConverged(
	args: IterateArgs,
): Promise<IterateResult> {
	let iteration = 1;
	let items: AlignDigestItem[] = buildInitialDigestItems(args.originalDigest);
	let finalIteration = 0;

	while (true) {
		if (iteration > MAX_ITERATIONS) {
			return {
				status: "fail",
				error: `harmonize-align: pagetype "${args.ptDir.pagetype}" did not converge after ${MAX_ITERATIONS} iterations (last iteration had ${items.length} items at batch size ${args.pagesPerBatch}). Likely a non-convergence defect in the aligner — investigate rather than raise the cap.`,
			};
		}

		const iterDir = join(args.ptDir.outDir, `layer-${iteration}`);
		const completed = await iterationAlreadyCommitted(iterDir);

		if (!completed) {
			const outcome = await runIterationIfNeeded({
				iteration,
				items,
				iterDir,
				args,
			});
			if (outcome.status === "fail") return outcome;
		}
		finalIteration = iteration;

		const nextItems = await loadPriorLayerItems(args.ptDir.outDir, iteration);
		if (nextItems.length === 0) {
			return {
				status: "fail",
				error: `harmonize-align: layer-${iteration} for pagetype "${args.ptDir.pagetype}" committed without any output digests`,
			};
		}
		if (nextItems.length <= 1) break;

		items = nextItems;
		iteration++;
	}

	return { status: "pass", finalIteration };
}

interface RunIfNeededArgs {
	iteration: number;
	items: AlignDigestItem[];
	iterDir: string;
	args: IterateArgs;
}

type RunIfNeededResult =
	| { status: "ran" }
	| { status: "fail"; error: string; reviews?: Review[] };

async function runIterationIfNeeded(
	a: RunIfNeededArgs,
): Promise<RunIfNeededResult> {
	const batches = batchItems(a.items, a.args.pagesPerBatch);
	if (batches.length === 0) {
		return {
			status: "fail",
			error: `layer-${a.iteration}: no digest items to process`,
		};
	}

	await rm(a.iterDir, { recursive: true, force: true });
	await mkdir(a.iterDir, { recursive: true });

	const outcome = await runIteration({
		iteration: a.iteration,
		pagetype: a.args.ptDir.pagetype,
		inputItemCount: a.items.length,
		batches,
		iterDir: a.iterDir,
		ctx: a.args.ctx,
		reviewerProfile: a.args.reviewerProfile,
		totals: a.args.totals,
		signals: a.args.signals,
	});
	if (outcome.status === "fail") {
		return { status: "fail", error: outcome.error, reviews: outcome.reviews };
	}
	return { status: "ran" };
}

/**
 * An iteration is "committed" when `layer-N/iteration.json` exists — it is
 * written last, after every batch artifact for that layer has landed. On
 * resume we trust committed layers and skip the LLM work.
 */
async function iterationAlreadyCommitted(iterDir: string): Promise<boolean> {
	try {
		await access(join(iterDir, "iteration.json"));
		return true;
	} catch {
		return false;
	}
}

interface RunIterationArgs {
	iteration: number;
	pagetype: string;
	inputItemCount: number;
	batches: AlignDigestItem[][];
	iterDir: string;
	ctx: StepContext;
	reviewerProfile: ReturnType<typeof resolveProfile>;
	totals: Totals;
	signals: StructuralSignals | null;
}

type IterationOutcome =
	| { status: "pass" }
	| { status: "fail"; error: string; reviews?: Review[] };

async function runIteration(args: RunIterationArgs): Promise<IterationOutcome> {
	const {
		iteration,
		pagetype,
		inputItemCount,
		batches,
		iterDir,
		ctx,
		reviewerProfile,
		totals,
		signals,
	} = args;

	// Real work: process each batch in parallel. Retry budget lives inside
	// the per-batch loop; a batch that exhausts retries fails the iteration.
	const batchResults = await Promise.all(
		batches.map((batch, i) =>
			processBatch({
				iteration,
				pagetype,
				batchIndex: i,
				batchItems: batch,
				iterDir,
				ctx,
				reviewerProfile,
				totals,
				signals,
			}),
		),
	);

	const failed = batchResults.filter((r) => r.status === "fail");
	if (failed.length > 0) {
		return {
			status: "fail",
			error: `layer-${iteration}: ${failed.length}/${batchResults.length} batches failed after ${MAX_PER_BATCH_RETRIES + 1} attempts`,
			reviews: failed.map((f) => ({
				reviewerId: `batch-${f.batchIndex}`,
				verdict: "reject" as const,
				findings: f.lastRejection ?? "batch exhausted retries",
				rejectionContext: f.lastRejection ?? "batch exhausted retries",
			})),
		};
	}

	const passed = batchResults.filter(isPassedBatch);
	for (const r of passed) {
		await writeFile(
			join(iterDir, `rename-table.batch-${r.batchIndex}.json`),
			`${JSON.stringify(r.renameTable, null, 2)}\n`,
		);
		await writeFile(
			join(iterDir, `digest.batch-${r.batchIndex}.json`),
			`${JSON.stringify(r.postDigest, null, 2)}\n`,
		);
		if (r.elementKey.length > 0) {
			await writeFile(
				join(iterDir, `element-key-renames.batch-${r.batchIndex}.json`),
				`${JSON.stringify(r.elementKey, null, 2)}\n`,
			);
		}
	}
	const unionElementKey: ElementKeyRenameSidecar = passed.flatMap(
		(r) => r.elementKey,
	);
	await writeFile(
		join(iterDir, "element-key-renames.json"),
		`${JSON.stringify(unionElementKey, null, 2)}\n`,
	);
	if (passed.length === 1) {
		await writeFile(
			join(iterDir, "rename-table.json"),
			`${JSON.stringify(passed[0].renameTable, null, 2)}\n`,
		);
		await writeFile(
			join(iterDir, "digest.json"),
			`${JSON.stringify(passed[0].postDigest, null, 2)}\n`,
		);
	}
	await writeIterationManifest(iterDir, {
		iteration,
		inputItemCount,
		outputDigestCount: passed.length,
		converged: passed.length <= 1,
	});

	return { status: "pass" };
}

// ---------------------------------------------------------------------------
// Pass-through writer — single-page pagetypes (no aliases possible)
// ---------------------------------------------------------------------------

async function writePassThroughLayer(
	layerDir: string,
	inputDigest: PageTypeDigest,
): Promise<void> {
	await writeFile(
		join(layerDir, "rename-table.batch-0.json"),
		`${JSON.stringify([], null, 2)}\n`,
	);
	await writeFile(
		join(layerDir, "digest.batch-0.json"),
		`${JSON.stringify(inputDigest, null, 2)}\n`,
	);
	await writeFile(
		join(layerDir, "rename-table.json"),
		`${JSON.stringify([], null, 2)}\n`,
	);
	await writeFile(
		join(layerDir, "element-key-renames.json"),
		`${JSON.stringify([], null, 2)}\n`,
	);
	await writeFile(
		join(layerDir, "digest.json"),
		`${JSON.stringify(inputDigest, null, 2)}\n`,
	);
	await writeIterationManifest(layerDir, {
		iteration: 1,
		inputItemCount: 1,
		outputDigestCount: 1,
		converged: true,
	});
}

// ---------------------------------------------------------------------------
// Per-batch loop
// ---------------------------------------------------------------------------

interface BatchResult {
	batchIndex: number;
	status: "pass" | "fail";
	renameTable?: RenameTable;
	elementKey?: ElementKeyRenameSidecar;
	postDigest?: PageTypeDigest;
	lastRejection?: string;
}

interface PassedBatch extends BatchResult {
	status: "pass";
	renameTable: RenameTable;
	elementKey: ElementKeyRenameSidecar;
	postDigest: PageTypeDigest;
}

function isPassedBatch(r: BatchResult): r is PassedBatch {
	return (
		r.status === "pass" && !!r.renameTable && !!r.postDigest && !!r.elementKey
	);
}

interface ProcessBatchArgs {
	iteration: number;
	pagetype: string;
	batchIndex: number;
	batchItems: AlignDigestItem[];
	iterDir: string;
	ctx: StepContext;
	reviewerProfile: ReturnType<typeof resolveProfile>;
	totals: Totals;
	signals: StructuralSignals | null;
}

/**
 * Per-attempt workflow:
 *   1. One agent SDK call. The agent uses its tool-use loop to write
 *      ops.json, run `./validate` (CLI wrapping `validateAlignOps`), fix
 *      errors, and resubmit — no pipeline-level iter loop.
 *   2. Safety-net re-run: after the agent returns, the runner invokes the
 *      same `validateAlignOps` on the submitted ops (single source of
 *      truth, defends against a missed `./validate` call) then runs the
 *      convergence reviewer (LLM judge on the post-apply canonical shape).
 *   3. On any failure, write `attempt-outcome.json` summarizing what went
 *      wrong; the next attempt sees it as `previous-attempt.json` in its
 *      workdir so the agent can fix rather than re-derive.
 */
async function processBatch(args: ProcessBatchArgs): Promise<BatchResult> {
	const {
		iteration,
		pagetype,
		batchIndex,
		batchItems,
		iterDir,
		ctx,
		reviewerProfile,
		totals,
		signals,
	} = args;
	const batchDigest = mergeDigests(
		batchItems.map((item) => item.digest),
		pagetype,
	);
	const attemptsRoot = join(iterDir, "attempts", `batch-${batchIndex}`);
	let lastRejection: string | undefined;
	let previousAttempt: AttemptOutcome | undefined;

	for (let attempt = 0; attempt <= MAX_PER_BATCH_RETRIES; attempt++) {
		const attemptDir = join(attemptsRoot, String(attempt));
		await mkdir(attemptDir, { recursive: true });

		const outcome = await runBatchAttempt({
			iteration,
			pagetype,
			batchIndex,
			attempt,
			attemptDir,
			batchDigest,
			ctx,
			reviewerProfile,
			totals,
			signals,
			priorAttemptRejection: lastRejection,
			previousAttempt,
		});

		await writeFile(
			join(attemptDir, "attempt-outcome.json"),
			`${JSON.stringify(outcome, null, 2)}\n`,
		);

		if (outcome.verdict === "pass") {
			return {
				batchIndex,
				status: "pass",
				renameTable: outcome.flat,
				elementKey: outcome.elementKey,
				postDigest: outcome.postDigest,
			};
		}

		lastRejection = outcome.rejectionContext;
		previousAttempt = outcome;
	}

	return { batchIndex, status: "fail", lastRejection };
}

// ---------------------------------------------------------------------------
// Per-attempt driver
// ---------------------------------------------------------------------------

type AttemptOutcome = AttemptPass | AttemptFail;

interface AttemptPass {
	verdict: "pass";
	attempt: number;
	flat: RenameTable;
	elementKey: ElementKeyRenameSidecar;
	postDigest: PageTypeDigest;
	metrics: ConvergenceMetrics;
}

interface AttemptFail {
	verdict: "fail";
	attempt: number;
	/**
	 * Which gate failed.
	 *   - "agent" — the agent call itself didn't produce a parseable ops.json
	 *   - "validator" — the programmatic validation pipeline rejected the ops
	 *     (see `rejectionContext` for the specific sub-check tag)
	 *   - "convergence-reviewer" — the batch-level LLM judge rejected the
	 *     post-apply canonical shape
	 */
	phase: "agent" | "validator" | "convergence-reviewer";
	rejectionContext: string;
	/** Compiled flat table at the moment of failure (empty if the agent itself didn't submit valid ops). */
	flat: RenameTable;
	/** Metrics + fold diff at the moment of failure; null if we failed before apply. */
	metrics: ConvergenceMetrics | null;
	/** Raw findings from the reviewer when phase === "convergence-reviewer". */
	reviewerFindings?: string;
}

interface BatchAttemptArgs {
	iteration: number;
	pagetype: string;
	batchIndex: number;
	ctx: StepContext;
	reviewerProfile: ReturnType<typeof resolveProfile>;
	totals: Totals;
	signals: StructuralSignals | null;
	attempt: number;
	attemptDir: string;
	batchDigest: PageTypeDigest;
	priorAttemptRejection: string | undefined;
	previousAttempt: AttemptOutcome | undefined;
}

async function runBatchAttempt(
	args: BatchAttemptArgs,
): Promise<AttemptOutcome> {
	const agentCall = await runBatchAgent({
		iteration: args.iteration,
		pagetype: args.pagetype,
		batchIndex: args.batchIndex,
		attempt: args.attempt,
		attemptDir: args.attemptDir,
		batchDigest: args.batchDigest,
		ctx: args.ctx,
		totals: args.totals,
		signals: args.signals,
		priorAttemptRejection: args.priorAttemptRejection,
		previousAttempt: args.previousAttempt,
	});
	if (!agentCall.ok) {
		return {
			verdict: "fail",
			attempt: args.attempt,
			phase: "agent",
			rejectionContext: agentCall.rejection,
			flat: [],
			metrics: null,
		};
	}
	const ops = agentCall.ops;

	// Safety net: re-run the same pipeline the CLI ran. The agent could
	// have skipped `./validate` or the CLI could be out of sync — trust
	// neither, run the checks on what the agent actually submitted.
	const result = validateAlignOps(
		args.batchDigest,
		args.signals ?? undefined,
		ops,
	);
	if (!result.valid) {
		const err = result.errors.join("\n");
		await writeFile(join(args.attemptDir, "validator.error.txt"), err);
		return {
			verdict: "fail",
			attempt: args.attempt,
			phase: "validator",
			rejectionContext: err,
			flat: [],
			metrics: null,
		};
	}
	const { flat, elementKey, postDigest } = result;
	await writeFile(
		join(args.attemptDir, "align.compiled.json"),
		`${JSON.stringify({ flat, elementKey }, null, 2)}\n`,
	);

	const metrics = computeConvergenceMetrics(args.batchDigest, postDigest, flat);
	await writeFile(
		join(args.attemptDir, "convergence-metrics.json"),
		`${JSON.stringify(metrics, null, 2)}\n`,
	);

	const review = await runConvergenceReviewer({
		metrics,
		postDigest,
		dir: args.attemptDir,
		iteration: args.iteration,
		pagetype: args.pagetype,
		batchIndex: args.batchIndex,
		attempt: args.attempt,
		ctx: args.ctx,
		reviewerProfile: args.reviewerProfile,
		totals: args.totals,
	});
	if (review.rejected) {
		return {
			verdict: "fail",
			attempt: args.attempt,
			phase: "convergence-reviewer",
			rejectionContext: review.rejectionContext,
			reviewerFindings: review.findings,
			flat,
			metrics,
		};
	}

	return {
		verdict: "pass",
		attempt: args.attempt,
		flat,
		elementKey,
		postDigest,
		metrics,
	};
}

// ---------------------------------------------------------------------------
// Per-attempt agent call
// ---------------------------------------------------------------------------
//
// One agent SDK call per attempt. The agent uses its tool-use loop to
// propose ops, run ./validate, fix, and resubmit — no outer iter loop.

interface BatchAgentArgs {
	iteration: number;
	pagetype: string;
	batchIndex: number;
	attempt: number;
	attemptDir: string;
	batchDigest: PageTypeDigest;
	ctx: StepContext;
	totals: Totals;
	signals: StructuralSignals | null;
	priorAttemptRejection: string | undefined;
	previousAttempt: AttemptOutcome | undefined;
}

type BatchAgentResult =
	| { ok: true; ops: RichRenameOp[] }
	| { ok: false; rejection: string };

async function runBatchAgent(args: BatchAgentArgs): Promise<BatchAgentResult> {
	const { iteration, pagetype, batchIndex, attempt, attemptDir, ctx, totals } =
		args;

	// Seed the agent's workdir (attemptDir itself — no iter subdirs).
	await writeFile(
		join(attemptDir, "digest.json"),
		`${JSON.stringify(args.batchDigest, null, 2)}\n`,
	);
	const hasSignals = args.signals !== null && args.signals !== undefined;
	if (hasSignals) {
		await writeFile(
			join(attemptDir, "signals.json"),
			`${JSON.stringify(args.signals, null, 2)}\n`,
		);
	}
	await writeFile(join(attemptDir, "ops.json"), "[]\n");
	await writeFile(join(attemptDir, "rejects.json"), "[]\n");
	await writeValidateScript(attemptDir, hasSignals);
	await writeSuggestScript(attemptDir);
	await writeReviewScript(attemptDir);
	await writeOpsIfyScript(attemptDir);
	await writeRememberRejectScript(attemptDir);

	const hasPrevious = args.previousAttempt !== undefined;
	if (hasPrevious && args.previousAttempt !== undefined) {
		await writeFile(
			join(attemptDir, "previous-attempt.json"),
			`${JSON.stringify(args.previousAttempt, null, 2)}\n`,
		);
	}

	const prompt = buildInteractiveAlignPrompt({
		iteration,
		pagetype,
		hasSignals,
		hasPreviousAttempt: hasPrevious,
		priorRejection: args.priorAttemptRejection,
	});
	await writeFile(join(attemptDir, "align.prompt.txt"), prompt);

	const call = await agentQueryWithMetrics({
		prompt,
		cwd: attemptDir,
		profile: ctx.profile,
		stepName: `classify/harmonize-align/iter-${iteration}/align[${pagetype}/batch-${batchIndex}]#${attempt}`,
		logger: ctx.logger,
		maxTurns: ctx.profile.maxTurns,
		tools: ["Read", "Write", "Edit", "Bash"],
		config: ctx.config,
	});
	totals.turns += call.turns;
	totals.inputTokens += call.inputTokens;
	totals.outputTokens += call.outputTokens;
	totals.cost += call.cost;
	await writeFile(join(attemptDir, "align.response.txt"), call.output);

	const opsParse = await readFinalOps(attemptDir);
	if (!opsParse.ok) {
		await writeFile(join(attemptDir, "align.error.txt"), opsParse.error);
		return { ok: false, rejection: opsParse.error };
	}
	return { ok: true, ops: opsParse.ops };
}

type OpsParse =
	| { ok: true; ops: RichRenameOp[] }
	| { ok: false; error: string };

async function readFinalOps(dir: string): Promise<OpsParse> {
	let raw: string;
	try {
		raw = await readFile(join(dir, "ops.json"), "utf-8");
	} catch (err) {
		return { ok: false, error: `failed to read ops.json: ${String(err)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, error: `ops.json is not valid JSON: ${String(err)}` };
	}
	if (!Array.isArray(parsed)) {
		return {
			ok: false,
			error: "ops.json must contain a JSON array of rename ops",
		};
	}
	return { ok: true, ops: parsed as RichRenameOp[] };
}

async function writeValidateScript(
	dir: string,
	hasSignals: boolean,
): Promise<void> {
	const argsLine = hasSignals
		? "digest.json ops.json signals.json"
		: "digest.json ops.json";
	const script = `#!/usr/bin/env bash
set -euo pipefail
exec rtk proxy bun run "${VALIDATE_ALIGN_OPS_CLI}" ${argsLine}
`;
	const path = join(dir, "validate");
	await writeFile(path, script, "utf-8");
	await chmod(path, 0o755);
}

async function writeSuggestScript(dir: string): Promise<void> {
	const script = `#!/usr/bin/env bash
set -euo pipefail
exec rtk proxy bun run "${SUGGEST_FOLDS_CLI}" digest.json ops.json rejects.json
`;
	const path = join(dir, "suggest");
	await writeFile(path, script, "utf-8");
	await chmod(path, 0o755);
}

async function writeReviewScript(dir: string): Promise<void> {
	// `./review` auto-discovers the latest suggest-agent/<ts>/suggestions.txt
	// under cwd — no arguments needed.
	const script = `#!/usr/bin/env bash
set -euo pipefail
exec rtk proxy bun run "${REVIEW_ALIGN_CLI}"
`;
	const path = join(dir, "review");
	await writeFile(path, script, "utf-8");
	await chmod(path, 0o755);
}

async function writeOpsIfyScript(dir: string): Promise<void> {
	// `./ops-ify` only converts accepted clusters into rename ops.
	const script = `#!/usr/bin/env bash
set -euo pipefail
exec rtk proxy bun run "${OPS_IFY_CLI}" ops.json "\${1}"
`;
	const path = join(dir, "ops-ify");
	await writeFile(path, script, "utf-8");
	await chmod(path, 0o755);
}

async function writeRememberRejectScript(dir: string): Promise<void> {
	const script = `#!/usr/bin/env bash
set -euo pipefail
exec rtk proxy bun run "${REMEMBER_REJECT_CLI}" rejects.json "\${1}"
`;
	const path = join(dir, "remember-reject");
	await writeFile(path, script, "utf-8");
	await chmod(path, 0o755);
}

function truncateJson(value: unknown, maxLen = 160): string {
	const s = JSON.stringify(value);
	if (s.length <= maxLen) return s;
	return `${s.slice(0, maxLen - 3)}...`;
}

// ---------------------------------------------------------------------------
// Convergence reviewer — batch-level LLM judge on the post-apply shape
// ---------------------------------------------------------------------------

interface ConvergenceReviewerArgs {
	metrics: ConvergenceMetrics;
	/** Post-apply digest after the submitted rename ops were validated. */
	postDigest: PageTypeDigest;
	dir: string;
	iteration: number;
	pagetype: string;
	batchIndex: number;
	attempt: number;
	ctx: StepContext;
	reviewerProfile: ReturnType<typeof resolveProfile>;
	totals: Totals;
}

interface ConvergenceReviewerOutcome {
	rejected: boolean;
	rejectionContext: string;
	findings: string;
}

async function runConvergenceReviewer(
	args: ConvergenceReviewerArgs,
): Promise<ConvergenceReviewerOutcome> {
	const prompt = buildConvergenceReviewerPrompt(args.metrics, args.postDigest);
	await writeFile(join(args.dir, "convergence-reviewer.prompt.txt"), prompt);
	const call = await agentQueryWithMetrics({
		prompt,
		cwd: args.ctx.workdir,
		profile: args.reviewerProfile,
		stepName: `classify/harmonize-align/iter-${args.iteration}/convergence-review[${args.pagetype}/batch-${args.batchIndex}]#${args.attempt}`,
		logger: args.ctx.logger,
		maxTurns: args.reviewerProfile.maxTurns,
		config: args.ctx.config,
	});
	args.totals.turns += call.turns;
	args.totals.inputTokens += call.inputTokens;
	args.totals.outputTokens += call.outputTokens;
	args.totals.cost += call.cost;
	await writeFile(
		join(args.dir, "convergence-reviewer.response.txt"),
		call.output,
	);
	const verdict = parseReviewerVerdict(call.output);
	await writeFile(
		join(args.dir, "convergence-reviewer.verdict.txt"),
		verdict.verdict,
	);
	if (verdict.findings) {
		await writeFile(
			join(args.dir, "convergence-reviewer.findings.txt"),
			verdict.findings,
		);
	}
	if (verdict.verdict === "reject") {
		const rejectionContext =
			verdict.rejectionContext ??
			verdict.findings ??
			"convergence reviewer rejected without findings";
		return {
			rejected: true,
			rejectionContext,
			findings: verdict.findings ?? rejectionContext,
		};
	}
	return {
		rejected: false,
		rejectionContext: "",
		findings: verdict.findings ?? "",
	};
}

function buildConvergenceReviewerPrompt(
	m: ConvergenceMetrics,
	postDigest: PageTypeDigest,
): string {
	const foldBlock =
		m.foldBuckets.length === 0
			? "(no renames proposed — the aligner submitted an empty rename table.)"
			: m.foldBuckets.map(describeFoldBucket).join("\n\n");

	const jBefore =
		m.meanJaccardBefore === null ? "  n/a" : m.meanJaccardBefore.toFixed(3);
	const jAfter =
		m.meanJaccardAfter === null ? "  n/a" : m.meanJaccardAfter.toFixed(3);

	const candidateBlock = describePostDigestCandidates(postDigest);

	return `You are the batch-level acceptance reviewer for a chrome-alignment
step. The aligner has proposed a rename table that collapses alias candidate
paths into canonical names for page type "${m.pagetype}". Your job is to
judge whether the RESULT makes sense as a whole — not each individual
rename in isolation.

## Convergence metrics

Pagetype:               ${m.pagetype}
Pages in batch:         ${m.totalPages}

                        before   after
  total candidates       ${pad(m.candidatesBefore)}  ${pad(m.candidatesAfter)}
  shared on all pages    ${pad(m.sharedOnAllBefore)}  ${pad(m.sharedOnAllAfter)}
  mean pairwise jaccard  ${jBefore}   ${jAfter}

Interpretation: real alias collapse pushes \`candidates\` down and
\`shared on all\` up. If both are unchanged, the rename table did nothing.

## Fold buckets — what actually got merged

${foldBlock}

## Post-apply candidates

${candidateBlock}

## Your job

Pass or reject based on:

1. **Over-merge**: for each bucket with >1 source, do the observed values
   tell a consistent story (same semantic field, just different names)?
   A bucket whose sources hold clearly distinct semantic content (e.g.
   different phone numbers, different headings on the same page, different
   items at the same array position) is a bad merge. REJECT with the
   specific bucket name.

2. **Under-merge**: if \`candidates after\` is close to \`candidates before\`
   and the post-apply candidates still contain obvious alias-pairs (e.g.
   paths differing only in a single word variant with near-identical
   values), note which pairs were missed so the retry can address them.

3. **Healthy zero**: if the fold buckets section reads "(no renames
   proposed)" AND \`shared on all pages\` before was already very high
   relative to \`total candidates\` before, the aligner was correct to
   propose nothing. Pass.

NOTE: the programmatic validator upstream already guarantees every
canonical either (a) appears in the original candidate list or (b) has
≥2 sources collapsing onto it. Do not relitigate canonical naming —
single-source renames onto observed paths are legitimate alias merges,
not "synthetic" targets.

Do NOT assume any extra suggest/review pass ran after the aligner
finished. Judge only the submitted result shown here.

## Output

Output EXACTLY one line beginning with:

  VERDICT: pass
OR
  VERDICT: reject

On reject, follow with one line per bad bucket:

  bucket "<canonical>": <reason>

Then a final section starting with:

  REJECTION CONTEXT:

containing the specific corrections the retry should apply (which buckets
to un-merge, which alias pairs were missed).`;
}

function describeFoldBucket(b: FoldDiffBucket): string {
	const sourcesBlock = b.sources.map((s) => `  ← ${s}`).join("\n");
	const valuesSample = b.distinctValues
		.slice(0, 8)
		.map(
			(dv) =>
				`    · ${truncateJson(dv.value)}  (on ${dv.pageHashes.length} page(s))`,
		)
		.join("\n");
	const extra =
		b.distinctValues.length > 8
			? `\n    · ... (${b.distinctValues.length - 8} more distinct values)`
			: "";
	return `canonical: ${b.canonical}  (present on ${b.pagesWithBucket} page(s) after merge)
sources:
${sourcesBlock}
distinct values in merged bucket:
${valuesSample}${extra}`;
}

function pad(n: number): string {
	return String(n).padStart(5);
}

function describePostDigestCandidates(digest: PageTypeDigest): string {
	if (digest.candidates.length === 0) return "(no candidates remain)";
	return digest.candidates
		.slice()
		.sort((a, b) =>
			a.candidatePath < b.candidatePath
				? -1
				: a.candidatePath > b.candidatePath
					? 1
					: 0,
		)
		.map((cand) => {
			const valuesSample = cand.distinctValues
				.slice(0, 4)
				.map(
					(dv) =>
						`    · ${truncateJson(dv.value)}  (on ${dv.pageHashes.length} page(s))`,
				)
				.join("\n");
			const extra =
				cand.distinctValues.length > 4
					? `\n    · ... (${cand.distinctValues.length - 4} more distinct values)`
					: "";
			return `  • ${cand.candidatePath}  [present on ${cand.presentOn.length}/${digest.totalPages} page(s)]\n${valuesSample}${extra}`;
		})
		.join("\n");
}

// ---------------------------------------------------------------------------
// Composed artifacts at the pagetype root
// ---------------------------------------------------------------------------

async function writeComposedArtifacts(
	ptOutDir: string,
	currentLayer: number,
): Promise<string | null> {
	let originalDigest: PageTypeDigest;
	try {
		originalDigest = await readDigest(ptOutDir);
	} catch (err) {
		return `compose: failed to load original digest: ${String(err)}`;
	}
	const finalItems = await loadPriorLayerItems(ptOutDir, currentLayer);
	if (finalItems.length !== 1) {
		return `compose: expected layer-${currentLayer} to emit exactly 1 digest, found ${finalItems.length}`;
	}
	const currentDigest = finalItems[0].digest;

	const { layerInputs, composedElementKey } =
		await collectComposedInputArtifacts(ptOutDir, currentLayer);

	let composed: ReturnType<typeof composeRenameTables>;
	try {
		composed = composeRenameTables(layerInputs);
	} catch (err) {
		return `compose: ${String(err)}`;
	}

	const coverage = assertComposedCoverage(
		composed,
		originalDigest.candidates.map((c) => c.candidatePath),
		currentDigest.candidates.map((c) => c.candidatePath),
	);
	if (!coverage.valid) {
		return `compose coverage check failed: ${coverage.errors.join("; ")}`;
	}

	await writeComposedRootArtifacts(
		ptOutDir,
		composed,
		currentDigest,
		composedElementKey,
	);
	return null;
}

interface ComposedInputArtifacts {
	layerInputs: LayerRenameInput[];
	composedElementKey: ElementKeyRenameSidecar;
}

async function collectComposedInputArtifacts(
	ptOutDir: string,
	currentLayer: number,
): Promise<ComposedInputArtifacts> {
	const layerInputs: LayerRenameInput[] = [];
	const composedElementKey: ElementKeyRenameSidecar = [];
	for (let n = 1; n <= currentLayer; n++) {
		const layerDir = join(ptOutDir, `layer-${n}`);
		const { renameFiles, elementKeyFiles } =
			await listLayerComposedFiles(layerDir);
		layerInputs.push(
			...(await readLayerRenameInputs(layerDir, n, renameFiles)),
		);
		composedElementKey.push(
			...(await readLayerElementKeySidecars(layerDir, elementKeyFiles)),
		);
	}
	return { layerInputs, composedElementKey };
}

async function listLayerComposedFiles(layerDir: string): Promise<{
	renameFiles: Array<{ idx: number; file: string }>;
	elementKeyFiles: Array<{ idx: number; file: string }>;
}> {
	let files: string[];
	try {
		files = await readdir(layerDir);
	} catch {
		return { renameFiles: [], elementKeyFiles: [] };
	}
	const renameFiles: Array<{ idx: number; file: string }> = [];
	const elementKeyFiles: Array<{ idx: number; file: string }> = [];
	for (const file of files) {
		const renameMatch = file.match(/^rename-table\.batch-(\d+)\.json$/);
		if (renameMatch) {
			renameFiles.push({ idx: Number(renameMatch[1]), file });
		}
		const elementKeyMatch = file.match(
			/^element-key-renames\.batch-(\d+)\.json$/,
		);
		if (elementKeyMatch) {
			elementKeyFiles.push({ idx: Number(elementKeyMatch[1]), file });
		}
	}
	renameFiles.sort((a, b) => a.idx - b.idx);
	elementKeyFiles.sort((a, b) => a.idx - b.idx);
	return { renameFiles, elementKeyFiles };
}

async function readLayerRenameInputs(
	layerDir: string,
	layer: number,
	renameFiles: Array<{ idx: number; file: string }>,
): Promise<LayerRenameInput[]> {
	const out: LayerRenameInput[] = [];
	for (const { idx, file } of renameFiles) {
		const raw = await readFile(join(layerDir, file), "utf-8");
		const table = JSON.parse(raw) as RenameTable;
		if (table.length > 0) out.push({ layer, batchIndex: idx, table });
	}
	return out;
}

async function readLayerElementKeySidecars(
	layerDir: string,
	elementKeyFiles: Array<{ file: string }>,
): Promise<ElementKeyRenameSidecar> {
	const out: ElementKeyRenameSidecar = [];
	for (const { file } of elementKeyFiles) {
		const raw = await readFile(join(layerDir, file), "utf-8");
		out.push(...(JSON.parse(raw) as ElementKeyRenameSidecar));
	}
	return out;
}

async function writeComposedRootArtifacts(
	ptOutDir: string,
	composed: ReturnType<typeof composeRenameTables>,
	currentDigest: PageTypeDigest,
	composedElementKey: ElementKeyRenameSidecar,
): Promise<void> {
	await writeFile(
		join(ptOutDir, "rename-table.composed.json"),
		`${JSON.stringify(composed, null, 2)}\n`,
	);
	await writeFile(
		join(ptOutDir, "rename-trace.composed.json"),
		`${JSON.stringify(buildComposedRenameTrace(composed), null, 2)}\n`,
	);
	await writeFile(
		join(ptOutDir, "digest.composed.json"),
		`${JSON.stringify(currentDigest, null, 2)}\n`,
	);
	// Legacy flat — verdicts/assemble read `rename-table.json` today. Keep
	// writing it so Stage 3c/3d stay unchanged by this PR.
	await writeFile(
		join(ptOutDir, "rename-table.json"),
		`${JSON.stringify(composed.flat, null, 2)}\n`,
	);
	await writeFile(
		join(ptOutDir, "element-key-renames.composed.json"),
		`${JSON.stringify(composedElementKey, null, 2)}\n`,
	);
	await writeFile(
		join(ptOutDir, "element-key-renames.json"),
		`${JSON.stringify(composedElementKey, null, 2)}\n`,
	);
}

// ---------------------------------------------------------------------------
// Prior-layer artifact loaders
// ---------------------------------------------------------------------------

async function loadPriorLayerItems(
	ptOutDir: string,
	priorLayer: number,
): Promise<AlignDigestItem[]> {
	const priorDir = join(ptOutDir, `layer-${priorLayer}`);
	let files: string[];
	try {
		files = await readdir(priorDir);
	} catch {
		return [];
	}
	const entries: Array<{ idx: number; file: string }> = [];
	for (const f of files) {
		const m = f.match(/^digest\.batch-(\d+)\.json$/);
		if (!m) continue;
		entries.push({ idx: Number(m[1]), file: f });
	}
	entries.sort((a, b) => a.idx - b.idx);
	const out: AlignDigestItem[] = [];
	for (const { idx, file } of entries) {
		const raw = await readFile(join(priorDir, file), "utf-8");
		const batchDigest = JSON.parse(raw) as PageTypeDigest;
		out.push({ itemId: `batch-${idx}`, digest: batchDigest });
	}
	return out;
}

function buildInitialDigestItems(
	originalDigest: PageTypeDigest,
): AlignDigestItem[] {
	return pageChunks(originalDigest).map((chunk) => ({
		itemId: chunk.itemId,
		digest: digestFromChunks([chunk], originalDigest.pagetype),
	}));
}

async function writeIterationManifest(
	layerDir: string,
	manifest: IterationManifest,
): Promise<void> {
	await writeFile(
		join(layerDir, "iteration.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

interface InteractivePromptArgs {
	iteration: number;
	pagetype: string;
	hasSignals: boolean;
	hasPreviousAttempt: boolean;
	priorRejection: string | undefined;
}

function buildInteractiveAlignPrompt(args: InteractivePromptArgs): string {
	const {
		iteration,
		pagetype,
		hasSignals,
		hasPreviousAttempt,
		priorRejection,
	} = args;
	const signalsLine = hasSignals
		? "- signals.json — structural signals (shapes, sequences, child keys)\n"
		: "";
	const previousLine = hasPreviousAttempt
		? "- previous-attempt.json — the previous attempt's final rename table + why it was rejected. Read this BEFORE proposing new ops: the flagged buckets/ops tell you what to avoid or fix.\n"
		: "";
	const rejectionBlock = priorRejection
		? `\n## Previous attempt rejected\n\n${priorRejection}\n\nThe structured data is in \`previous-attempt.json\`. Fix the specific issues flagged there; don't restart from zero unless you have to.\n`
		: "";

	return `You are the alias-collapse judge for page type "${pagetype}" (iteration ${iteration}).

A "chrome field name" is the path a classifier emitted for a piece of
structural chrome on a page. Different pages sometimes emit different names
for the same canonical field. A separate suggest sub-agent proposes alias
clusters; you review each one and decide accept or reject. Then you loop —
re-run suggest, review its next batch, accept or reject each, until it's
done.

## Files in this directory

- digest.json — candidates: paths, observed values, which pages had them
- suggestions.txt is written under \`suggest-agent/<timestamp>/\` by \`./suggest\` and holds the latest freeform merge proposals.
${signalsLine}${previousLine}- ops.json — accepted rename ops. Starts as \`[]\`. Appended via \`./ops-ify <cluster.json>\`.
- rejects.json — clusters you rejected. Starts as \`[]\`. Appended via \`./remember-reject reject.json\`. Suggest reads this to avoid re-proposing the same cluster.
- suggest — run \`./suggest\` to write freeform merge proposals into the latest \`suggestions.txt\`. Stdout is only a small status envelope.
- review — run \`./review\` to split the latest \`suggestions.txt\` into structured decisions. It prints \`{ "decisions": [ { "paths": [...], "decision": "accept" | "reject", "suggestedCanonical"?: "...", "reason": "..." } ] }\`.
- ops-ify — run \`./ops-ify <cluster.json>\` to accept (appends flat/subtree op to ops.json).
- remember-reject — run \`./remember-reject reject.json\` to append a rejected path-set to rejects.json.
- validate — run \`./validate\` to final-check ops.json against the validator.

## Workflow — review loop

Loop:

1. Run \`./suggest\`. It writes a new \`suggest-agent/<timestamp>/suggestions.txt\`
   and prints one of:

     // More work to do:
     { "done": false, "note": "..." }

     // Nothing plausible remains:
     { "done": true, "reason": "..." }

2. If \`done: true\`, go to step 5. A \`reason\` like "all suggestions matched
   rejects.json…" is normal — it just means everything suggest could come up
   with is already rejected, so the loop is finished.

3. Otherwise, run \`./review\`. It reads the latest \`suggestions.txt\` and
   returns a reviewer's split of those proposals into accepts vs rejects:

     { "decisions": [
         { "paths": [...], "decision": "accept", "suggestedCanonical": "...", "reason": "..." },
         { "paths": [...], "decision": "reject", "reason": "..." }
       ] }

   The review is the structured split step — same digest, fresh eyes. Use it as your
   default decision for each proposal. You may override if you have a
   specific reason (e.g. the reviewer missed positional instability or
   signals), but the burden of proof is on you.

4. For EACH decision returned by \`./review\`, act on it:

   - **Accept** (paths truly represent the same canonical field — shared
     values line up, structural role matches, naming variants are clearly
     the same concept). Write the cluster object to \`cluster.json\` and run
     \`./ops-ify cluster.json\`. Include \`"suggestedCanonical"\` — use the
     reviewer's pick unless you have reason to choose differently.
   - **Reject** (cluster fuses semantically distinct fields, or evidence is
     thin). Write \`{"paths": [...], "reason": "<why>"}\` to \`reject.json\`
     (paths must have ≥2 entries) and run \`./remember-reject reject.json\`. Rejected
     clusters are remembered so suggest won't re-propose them.

   You MUST process EVERY review decision before re-running suggest. Don't skip any.

   After processing the whole list, go back to step 1. Accepted clusters
   are materialized into the digest and rejected ones are added to the
   rejects sidecar, so the next suggest call returns a strictly smaller
   set (or \`{done: true}\`).

5. Run \`./validate\` once to confirm ops.json is well-formed.
   If it reports errors, edit ops.json directly to remove or fix the
   flagged entries, then re-run \`./validate\`.

If suggest returns \`{done: true}\` immediately with ops.json still \`[]\`,
that's a valid answer — no aliases exist.

## Op schema (ops.json — emitted by ops-ify, or added manually if needed)

  { "kind": "flat",
    "from": "<candidate path>",
    "to":   "<canonical path>",
    "reason": "<short>" }

  { "kind": "subtree",
    "fromPrefix": "<prefix>",
    "toPrefix":   "<prefix>",
    "reason": "<short>" }

  { "kind": "element-key",
    "arrayPath":  "<path ending in [*]>",
    "identifyBy": "<object key on array elements>",
    "renames":    { "<observed value>": "<canonical value>" },
    "reason": "<short>" }

## Rules (the validator enforces — run ./validate to see them concretely)

- Every \`from\` / \`fromPrefix\` / \`arrayPath\` must exist in digest.json.
- No cycles, no \`from === to\`, no same \`from\` mapped to two different \`to\`s.
- Do not fuse structurally-different candidates.

## Positional stability (REQUIRED before accepting a cluster)

Paths include index positions like \`[*]\`. The scraper assigns these per
page — indices do NOT automatically align across pages. Before accepting
a cluster, compare observed values side-by-side in digest.json's
\`distinctValues\`: if slot [N] holds different items on different pages,
renaming that slot will corrupt downstream consumers. Reject the cluster
and move on.

## Prefer reject over accept when uncertain

A missing alias is recoverable by a later layer; a wrong alias fuses
semantically distinct fields and is hard to detect. When in doubt, reject.
${rejectionBlock}`;
}

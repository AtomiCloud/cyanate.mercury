/**
 * Core engine types.
 *
 * Hierarchy: DAG of Segments > Phases > Steps > Iterations
 *
 * - Segment: independent unit with typed I/O, forms a DAG
 * - Phase: serial within segment, each creates a new iteration (copied workdir)
 * - Step: parallel or serial within phase, shares workdir
 * - Iteration: on-disk materialization of a phase attempt
 */

import type { PipelineLogger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// LLM Profile
// ---------------------------------------------------------------------------

/**
 * LLM provider profile — the canonical type definition.
 * If modifying fields, also update the Zod schema in config.ts (LLMProfileSchema).
 */
export interface LLMProfile {
	/** Provider name (e.g., "anthropic", "friendli") */
	provider: string;
	/** Model ID (e.g., "claude-sonnet-4-20250514") */
	model: string;
	/** Max agent turns before aborting */
	maxTurns?: number;
	/**
	 * Optional max output tokens. Populated from `modelMaxTokens[model]` by
	 * `resolveProfile` when not set inline. Direct-API callers prefer
	 * `opts.maxTokens ?? profile.maxTokens ?? DEFAULT_MAX_TOKENS`.
	 */
	maxTokens?: number;
	/** Extra env vars merged when this profile is active */
	env?: Record<string, string>;
	/**
	 * Optional per-million-token pricing. When set, direct-API callers
	 * compute `cost` from the per-bucket token counts the provider returns.
	 * Matches Friendli's three-bucket scheme (Input / Cached Input / Output);
	 * Anthropic `cache_creation_input_tokens` is priced as `input`.
	 */
	pricing?: TokenPricing;
}

/** Per-million-token USD pricing, in the shape Friendli exposes. */
export interface TokenPricing {
	/** USD per 1M uncached input tokens (+ cache-creation input tokens) */
	input: number;
	/** USD per 1M cache-read input tokens */
	cachedInput: number;
	/** USD per 1M output tokens */
	output: number;
}

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

/** Result returned by a step's run function */
export interface StepResult {
	status: "pass" | "reject" | "fail";
	/** Reviews from judges/reviewers (if status is "reject") */
	reviews?: Review[];
	/** Error message (if status is "fail") */
	error?: string;
	/** Wall-clock duration in ms */
	duration?: number;
	/** Agent turn count (populated by agentQueryWithMetrics) */
	turns?: number;
	/** Total input tokens (populated by agentQueryWithMetrics) */
	inputTokens?: number;
	/** Total output tokens (populated by agentQueryWithMetrics) */
	outputTokens?: number;
	/** Total cost in USD (populated by agentQueryWithMetrics) */
	cost?: number;
}

export interface Review {
	reviewerId: string;
	verdict: "pass" | "reject";
	findings: string;
	/** Specific feedback passed to the next iteration's implementer */
	rejectionContext?: string;
}

/** Context passed to every step's run function */
export interface StepContext {
	/** Shared workdir for all steps in the current iteration */
	workdir: string;
	segmentId: string;
	phaseId: string;
	stepId: string;
	runId: string;
	/** Root dir for the entire run (runs/<run-id>/) */
	runDir: string;
	/** Current iteration index (1-based) */
	iteration: number;
	/** Which retry attempt within the phase (0 = first try) */
	retry: number;
	/** Resolved LLM profile for this step */
	profile: LLMProfile;
	/** Aggregated rejection context from previous failed iteration */
	rejectionContext?: string;
	logger: PipelineLogger;
	/** Raw config from cui.yaml */
	config: CuiConfig;
}

/** Step run function signature */
export type StepFn = (ctx: StepContext) => Promise<StepResult>;

/** Step definition registered within a phase */
export interface StepDef {
	id: string;
	name: string;
	description: string;
	/** "agent" = Claude SDK, "programmatic" = TS function, "reviewer" = AI judge */
	type: "agent" | "programmatic" | "reviewer";
	/** Profile override key — resolved via cascading (seg.phase.step) */
	profileKey?: string;
	/** Run N instances in parallel (e.g., one per page) */
	parallel?: number;
	run: StepFn;
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

export interface PhaseDef {
	id: string;
	name: string;
	description: string;
	/** Max retry attempts when a step rejects (default: 3) */
	maxRetries: number;
	/** Ordered steps within this phase */
	steps: StepDef[];
}

// ---------------------------------------------------------------------------
// Segment
// ---------------------------------------------------------------------------

export interface SegmentDef {
	id: string;
	name: string;
	description: string;
	/** IDs of segments this depends on (DAG edges) */
	depends: string[];
	/** Ordered phases within this segment */
	phases: PhaseDef[];
	/** Merge dependency outputs into this segment's initial workdir */
	mergeInputs: (
		workdir: string,
		deps: Record<string, string>,
		config: CuiConfig,
	) => Promise<void>;
	/** Extract output from final iteration workdir into outputDir */
	extractOutput: (workdir: string, outputDir: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Iteration state (persisted to pipeline.json)
// ---------------------------------------------------------------------------

export interface StepState {
	stepId: string;
	status: "pending" | "running" | "passed" | "rejected" | "failed" | "skipped";
	startedAt?: string;
	finishedAt?: string;
	duration?: number;
	error?: string;
	reviews?: Review[];
}

export interface IterationState {
	/** Monotonically increasing index (1-based) */
	index: number;
	/** Which phase this iteration materializes */
	phaseId: string;
	segmentId: string;
	status: "running" | "passed" | "rejected" | "failed";
	startedAt: string;
	finishedAt?: string;
	/** Per-step status within this iteration */
	steps: StepState[];
	/** Aggregated reviews from rejecting steps */
	reviews?: Review[];
	/** Combined rejection context for the next retry */
	rejectionContext?: string;
	/** Absolute path to iteration workdir */
	workdir: string;
}

// ---------------------------------------------------------------------------
// Pipeline state (pipeline.json per segment)
// ---------------------------------------------------------------------------

export interface PipelineState {
	runId: string;
	segmentId: string;
	status: "running" | "completed" | "failed";
	startedAt: string;
	finishedAt?: string;
	currentPhase: string;
	currentIteration: number;
	iterations: IterationState[];
}

// ---------------------------------------------------------------------------
// Run state (run.json at top level)
// ---------------------------------------------------------------------------

/**
 * Identity of a run — sticky across `--dep` and resume.
 *
 * Identity captures *what* the pipeline processed, not *how* it processed it.
 * When a new run uses `--dep <prior-run>`, it inherits the prior run's identity
 * so artifacts stay consistent across segment boundaries even if `cui.yaml`
 * has since been edited to point at a different example / reference.
 */
export interface RunIdentity {
	/** Scraper output directory that the prepare segment read from. */
	input: string;
	/** Reference website URL that the analyze segment extracted design from. */
	reference?: string;
}

export interface RunState {
	runId: string;
	status: "running" | "completed" | "failed";
	startedAt: string;
	finishedAt?: string;
	/**
	 * Sealed identity for this run — written at run start, never mutated.
	 * Optional on reads to tolerate legacy run.json files predating this field.
	 */
	identity?: RunIdentity;
	/**
	 * Effective cui.yaml for this run, with input/reference replaced by the
	 * identity inherited from --dep upstream runs. Written at run start, never
	 * mutated. Optional for backwards compatibility with legacy run.json files.
	 */
	config?: CuiConfig;
	/**
	 * The segment this run started from (--segment flag). Undefined means
	 * started from the DAG root (full pipeline run).
	 */
	startSegment?: string;
	/**
	 * Resolved --dep overrides the run was launched with, as absolute paths
	 * keyed by segment id. Empty map for runs launched without --dep.
	 */
	depOverrides?: Record<string, string>;
	segments: Record<
		string,
		{
			status: "pending" | "running" | "completed" | "failed" | "skipped";
			outputDir?: string;
		}
	>;
}

// ---------------------------------------------------------------------------
// Self-Check
// ---------------------------------------------------------------------------

/** Configuration for the inner self-check loop on agent steps. */
export interface SelfCheckConfig {
	/** Commands to run in the project subdir. All must pass. */
	commands: string[];
	/** Max agent-fix cycles (default: 2). */
	maxAttempts: number;
}

// ---------------------------------------------------------------------------
// Fork + Merge (for parallel agent isolation)
// ---------------------------------------------------------------------------

/** A single file change detected by diffing a fork against the original. */
export interface FileChange {
	/** Relative path within the workdir. */
	path: string;
	type: "add" | "modify" | "delete";
	/** Which fork produced this change. */
	forkId: string;
}

/** Tracks a set of forked workdirs and the pre-fork manifest for diffing. */
export interface ForkPlan {
	originalDir: string;
	/** Pre-fork snapshot: relative path → content hash. */
	manifest: Map<string, string>;
	forks: Array<{ id: string; dir: string }>;
}

/** Result of merging all fork diffs back into the original workdir. */
export interface MergeResult {
	status: "clean" | "conflict";
	applied: FileChange[];
	conflicts?: Array<{ path: string; forkIds: string[] }>;
}

// ---------------------------------------------------------------------------
// Config (cui.yaml)
// ---------------------------------------------------------------------------

interface HeartbeatConfig {
	/** ms before an agent is considered dead (default: 900000 = 15min) */
	timeout: number;
	/** ms between heartbeat logs in non-interactive mode (default: 30000 = 30s) */
	interval: number;
}

interface LoggingConfig {
	/** Filename for agent event logs (default: "agent-events.jsonl") */
	eventsFile: string;
	/** Filename for debug logs (default: "agent-debug.log") */
	debugFile: string;
}

interface ReviewerMatrixEntry {
	/** Provider keys to use for this reviewer */
	providers: string[];
	/** How to aggregate: any provider rejects = reject (default), all must pass */
	aggregation?: "any_reject";
}

export interface CuiConfig {
	/** Path to scraper output directory */
	input: string;
	/** Reference website URL for design extraction */
	reference?: string;
	/** Global LLM defaults */
	defaults: LLMProfile;
	/** Cascading profile overrides keyed by segment.phase.step */
	profiles: Record<string, Partial<LLMProfile>>;
	/**
	 * Per-model token pricing (USD per 1M tokens), keyed by `profile.model`.
	 * `resolveProfile` populates `profile.pricing` from this map when a
	 * profile doesn't specify its own pricing inline. Friendli's three-bucket
	 * scheme: input / cached-input / output.
	 */
	modelPricing?: Record<string, TokenPricing>;
	/**
	 * Per-model max output tokens, keyed by `profile.model`. `resolveProfile`
	 * populates `profile.maxTokens` from this map when a profile doesn't set
	 * its own inline. Lets reasoning models (e.g. GLM-5.1) get a larger budget
	 * than providers' default 4096 cap.
	 */
	modelMaxTokens?: Record<string, number>;
	/** Heartbeat timeout and interval configuration */
	heartbeat: HeartbeatConfig;
	/** Logging file configuration */
	logging: LoggingConfig;
	/** Named LLM provider profiles for multi-provider dispatch */
	providers?: Record<string, LLMProfile>;
	/** Per-reviewer provider assignment and aggregation strategy */
	reviewer_matrix?: Record<string, ReviewerMatrixEntry>;
	/** Per-step provider override: stepId → provider key */
	step_matrix?: Record<string, string>;
	/** Classify segment config */
	classify?: {
		/** Local SonicJS instance URL for Phase 9d roundtrip gate. */
		localSonicJsUrl: string;
		/** Batch size for harmonize-align per-iteration fan-out. Default: 5. */
		pagesPerBatch?: number;
	};
	/** Global concurrency controls */
	concurrency?: {
		/** Max concurrent Claude SDK query() calls across the entire run. */
		maxQueries?: number;
	};
}

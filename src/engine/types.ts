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

export interface LLMProfile {
	/** Provider name (e.g., "anthropic", "friendli") */
	provider: string;
	/** Model ID (e.g., "claude-sonnet-4-20250514") */
	model: string;
	/** Max agent turns before aborting */
	maxTurns?: number;
	/** Extra env vars merged when this profile is active */
	env?: Record<string, string>;
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
	mergeInputs: (workdir: string, deps: Record<string, string>) => Promise<void>;
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

export interface RunState {
	runId: string;
	status: "running" | "completed" | "failed";
	startedAt: string;
	finishedAt?: string;
	segments: Record<
		string,
		{
			status: "pending" | "running" | "completed" | "failed" | "skipped";
			outputDir?: string;
		}
	>;
}

// ---------------------------------------------------------------------------
// Config (cui.yaml)
// ---------------------------------------------------------------------------

export interface HeartbeatConfig {
	/** ms before an agent is considered dead (default: 900000 = 15min) */
	timeout: number;
	/** ms between heartbeat logs in non-interactive mode (default: 30000 = 30s) */
	interval: number;
}

export interface LoggingConfig {
	/** Filename for agent event logs (default: "agent-events.jsonl") */
	eventsFile: string;
	/** Filename for debug logs (default: "agent-debug.log") */
	debugFile: string;
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
	/** Heartbeat timeout and interval configuration */
	heartbeat: HeartbeatConfig;
	/** Logging file configuration */
	logging: LoggingConfig;
}

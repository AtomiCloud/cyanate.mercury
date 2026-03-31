/**
 * Step and Phase interfaces for the v2 pipeline.
 *
 * A Phase is a group of related steps that share a validation gate.
 * Phases run sequentially; within a phase, steps run in order.
 * Each phase has an approval gate that must pass before proceeding.
 */

import type { ScraperOutput } from '../types.js';
import type { PipelineLogger } from '../lib/logger.js';

export interface StepEnvOverride {
  /** Override the env profile for this step (e.g., "cerebras" -> .env.cerebras) */
  profile?: string;
  /** Direct env var overrides (merged on top of profile, highest priority) */
  env?: Record<string, string>;
}

export interface StepStatus {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: string;
  finishedAt?: string;
  duration?: number;
  profile?: string;
  turnCount?: number;
  error?: string;
}

export interface StepContext {
  id: string;
  name: string;
  phase: string;
  runDir: string;
  scratchDir: string;
  templateDir: string;
  scraperOutput: ScraperOutput;
  referenceUrl?: string;
  /** Origin URL of the source site (e.g., "https://example.com") */
  sourceOrigin?: string;
  env: Record<string, string>;
  logger?: PipelineLogger;
  /** Prior reviewer rejection feedback, available on retry iterations */
  rejectionContext?: string;
}

export interface Step {
  id: string;
  name: string;
  description: string;
  envOverride?: StepEnvOverride;
  /** If true, this step is deterministic (same input → same output).
   *  On retry, deterministic steps are skipped and their output is reused. */
  deterministic?: boolean;
  run(workingDir: string, ctx: StepContext): Promise<StepStatus>;
}

/**
 * A loop group: runs a sequence of steps repeatedly until all pass or max iterations hit.
 * Each iteration gets its own step directories so you can see the evolution.
 */
export interface StepLoop {
  id: string;
  name: string;
  steps: Step[];
  maxIterations: number;
}

/** A pipeline item is either a single step or a loop group */
export type PipelineItem = Step | StepLoop;

export function isStepLoop(item: PipelineItem): item is StepLoop {
  return 'steps' in item && Array.isArray((item as StepLoop).steps);
}

// --- v2 Phase types ---

export type PhaseId =
  | 'analyze'
  | 'structure'
  | 'layout'
  | 'design'
  | 'color'
  | 'motion'
  | 'polish';

export interface PhaseGate {
  /** Phase identifier */
  id: PhaseId;
  /** Human-readable name */
  name: string;
  /** Description of what this phase does */
  description: string;
  /** Steps within this phase */
  steps: Step[];
  /** Whether this phase has an iteration loop for validation + fix */
  maxRetries?: number;
  /** Validation step that acts as the gate */
  gateStep?: Step;
}

/** The v2 pipeline is an ordered list of phases */
export type PipelinePhase = PhaseGate;

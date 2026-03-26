/**
 * Step interface and related types for the pipeline.
 *
 * Each step is isolated - it receives a working directory and context,
 * does its work (usually via an agent), and returns a status.
 * The runner handles copying between steps.
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
  runDir: string;
  templateDir: string;
  scraperOutput: ScraperOutput;
  referenceUrl?: string;
  env: Record<string, string>;
  logger?: PipelineLogger;
}

export interface Step {
  id: string;
  name: string;
  description: string;
  /** Whether this step modifies the project files (triggers copy forward) */
  modifiesSite: boolean;
  envOverride?: StepEnvOverride;
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

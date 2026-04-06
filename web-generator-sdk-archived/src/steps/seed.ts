/**
 * Legacy seed step.
 *
 * The pipeline now uses the split deterministic steps:
 * - seed-content
 * - seed-assets
 * - seed-contracts
 *
 * This file remains only as a guard for old imports/resume paths.
 */

import type { Step, StepContext, StepStatus } from './step.js';

export const seedStep: Step = {
  id: 'seed',
  name: 'Phase 1c: Seed (Legacy)',
  description: 'Legacy seed wrapper retained for compatibility',
  deterministic: true,

  async run(_workingDir: string, _ctx: StepContext): Promise<StepStatus> {
    const now = new Date().toISOString();
    return {
      status: 'failed',
      startedAt: now,
      finishedAt: now,
      duration: 0,
      error: 'Legacy seed step is no longer supported. Use seed-content, seed-assets, and seed-contracts.',
    };
  },
};

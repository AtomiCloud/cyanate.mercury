/**
 * Step 0: Setup
 * Copy the Astro template into the working directory.
 */

import type { Step, StepContext, StepStatus } from './step.js';
import { copyDirectory } from '../lib/fs.js';

export const setupStep: Step = {
  id: 'setup',
  name: 'Setup',
  description: 'Copy Astro template to working directory',
  modifiesSite: true,

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    console.log(`[setup] Copying template to ${workingDir}...`);
    await copyDirectory(ctx.templateDir, workingDir);

    return {
      status: 'completed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    };
  },
};

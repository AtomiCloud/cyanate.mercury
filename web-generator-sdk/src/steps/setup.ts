/**
 * Step 0: Setup
 * Copy the Astro template into the working directory.
 */

import type { Step, StepContext, StepStatus } from './step.js';
import { copyDirectory } from '../lib/fs.js';
import { execSync } from 'child_process';

export const setupStep: Step = {
  id: 'setup',
  name: 'Setup',
  description: 'Copy Astro template to working directory',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    await copyDirectory(ctx.templateDir, workingDir);

    execSync('npm install', { cwd: workingDir, timeout: 120000, stdio: 'pipe' });

    return {
      status: 'completed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    };
  },
};

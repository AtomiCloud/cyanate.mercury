/**
 * Step 0: Setup
 * Copy the Astro template into the working directory.
 */

import { join } from 'path';
import { stat } from 'fs/promises';
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

    // Copy .claude/skills/ into the working dir so agents find them via cwd-scoped settings
    const skillsSrc = join(process.cwd(), '.claude', 'skills');
    try {
      await stat(skillsSrc);
      await copyDirectory(skillsSrc, join(workingDir, '.claude', 'skills'));
    } catch { /* skills dir may not exist */ }

    try {
      execSync('npm install', { cwd: workingDir, timeout: 120000, stdio: 'pipe' });
    } catch (e) {
      return {
        status: 'failed',
        startedAt: new Date(startTime).toISOString(),
        finishedAt: new Date().toISOString(),
        duration: Date.now() - startTime,
        error: `npm install failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    return {
      status: 'completed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    };
  },
};

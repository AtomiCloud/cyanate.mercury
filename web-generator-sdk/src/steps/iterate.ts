/**
 * Step 7: Iterate and Fix
 * Fix validation or functional check issues.
 *
 * After running, re-reads the reports to determine if issues were actually resolved.
 */

import { readFile, writeFile } from 'fs/promises';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery } from '../lib/agent.js';

export const iterateStep: Step = {
  id: 'iterate',
  name: 'Iterate',
  description: 'Fix validation errors and functional issues',
  modifiesSite: true,

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    let errors: string[] = [];

    // Collect errors from all previous reports
    for (const reportFile of ['validation-report.json', 'functional-report.json', 'quality-report.json']) {
      try {
        const report = JSON.parse(await readFile(`${workingDir}/${reportFile}`, 'utf-8'));
        if (report.passed) continue;
        if (report.errors?.length) errors.push(...report.errors);
        if (report.scores) {
          const lowScores = Object.entries(report.scores as Record<string, number>)
            .filter(([, v]) => v < 7)
            .map(([k, v]) => `${k}: ${v}/10`);
          if (lowScores.length) errors.push(`Low quality scores: ${lowScores.join(', ')}`);
        }
      } catch {
        // Report doesn't exist - skip
      }
    }

    if (errors.length === 0) {
      errors = ['General quality improvements needed.'];
    }

    const prompt = `Use the **iterate-and-fix** skill to fix the following issues in the Astro project at the current directory.

Consult the **Astro** skill for Astro framework reference when fixing issues.

## Errors
${errors.join('\n')}

## Instructions
1. Read the problematic files
2. Edit them to fix the errors
3. Re-run validation to confirm the fixes

Fix all the issues listed above. After making changes, run the validation commands again to confirm the fixes work.`;

    await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
    });

    // Re-read reports to check if issues were actually resolved
    let stillHasIssues = false;
    let remainingErrors: string[] = [];

    for (const reportFile of ['validation-report.json', 'functional-report.json', 'quality-report.json']) {
      try {
        const report = JSON.parse(await readFile(`${workingDir}/${reportFile}`, 'utf-8'));
        if (!report.passed) {
          stillHasIssues = true;
          if (report.errors?.length) remainingErrors.push(...report.errors);
          if (report.scores) {
            const lowScores = Object.entries(report.scores as Record<string, number>)
              .filter(([, v]) => v < 7)
              .map(([k, v]) => `${k}: ${v}/10`);
            remainingErrors.push(...lowScores);
          }
        }
      } catch {
        // Report doesn't exist - assume ok
      }
    }

    return {
      status: stillHasIssues ? 'failed' : 'completed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
      error: stillHasIssues ? `${remainingErrors.length} remaining issue(s)` : undefined,
    };
  },
};

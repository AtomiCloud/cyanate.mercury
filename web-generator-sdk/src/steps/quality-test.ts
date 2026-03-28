/**
 * Step 8: Quality Test
 * Run quality checks on the generated code.
 *
 * Returns failed if quality scores are below threshold,
 * so the loop can re-run validate -> iterate to fix them.
 */

import { readFile, writeFile } from 'fs/promises';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery } from '../lib/agent.js';

const MIN_SCORE = 7;

export const qualityTestStep: Step = {
  id: 'quality-test',
  name: 'Quality Test',
  description: 'Run visual and functional quality checks',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const prompt = `Use the **test-and-quality** skill to evaluate the visual quality of the Astro project at the current directory.

Run the following quality checks:
1. Functional test - Start dev server, visit index page, check for console errors
2. Quality evaluation - Score each dimension (layoutConsistency, designTokenUsage, componentComposition, responsiveDesign, semanticHTML, visualAppeal)
3. Responsive check - Test at mobile (375px), tablet (768px), and desktop (1920px) viewports

Save results as quality-scores.json and test-report.json.
If all checks pass with scores >= ${MIN_SCORE}/10, output "QUALITY_PASSED" at the end.`;

    const result = await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
    });

    const passed = result.includes('QUALITY_PASSED');

    // Write quality report so other steps can read it
    try {
      const scores = JSON.parse(await readFile(`${workingDir}/quality-scores.json`, 'utf-8'));
      await writeFile(
        `${workingDir}/quality-report.json`,
        JSON.stringify({ passed, scores, minScore: MIN_SCORE }, null, 2),
        'utf-8',
      );
    } catch {
      await writeFile(
        `${workingDir}/quality-report.json`,
        JSON.stringify({ passed, scores: null, minScore: MIN_SCORE }, null, 2),
        'utf-8',
      );
    }

    return {
      status: passed ? 'completed' : 'failed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
      error: passed ? undefined : `Quality scores below ${MIN_SCORE}/10`,
    };
  },
};

/**
 * Step 5: Validate
 * Run typecheck, astro check, and build.
 */

import { writeFile } from 'fs/promises';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery, extractErrors } from '../lib/agent.js';

export const validateStep: Step = {
  id: 'validate',
  name: 'Validate',
  description: 'Run typecheck, astro check, and build',
  modifiesSite: true,

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const prompt = `Use the **validate-and-repair** skill to validate the Astro project at the current directory.

Consult the **Astro** skill for Astro CLI commands and project structure reference.

Run the following validation checks:
1. Type check: npm run typecheck
2. Astro check: npx astro check
3. Build test: npm run build

For each check:
- Run the command
- Capture and report any errors
- If all checks pass without errors, output "VALIDATION_PASSED" at the end

If there are errors, list them clearly so they can be fixed.`;

    const result = await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
    });

    const passed = result.includes('VALIDATION_PASSED') || !result.toLowerCase().includes('error');

    const errors = passed ? [] : extractErrors(result);

    // Write validation report so other steps can read it
    await writeFile(
      `${workingDir}/validation-report.json`,
      JSON.stringify({ passed, errors }, null, 2),
      'utf-8',
    );

    return {
      status: passed ? 'completed' : 'failed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
      error: passed ? undefined : `${errors.length} validation error(s)`,
    };
  },
};

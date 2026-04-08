/**
 * Step 3: Plan Brief
 * Create a comprehensive design brief combining layout plan + design tokens.
 */

import { readFile, writeFile } from 'fs/promises';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery } from '../lib/agent.js';

export const planBriefStep: Step = {
  id: 'plan-brief',
  name: 'Plan Brief',
  description: 'Create design brief from layout plan and design tokens',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const designTokens = await readFile(`${workingDir}/design-tokens.json`, 'utf-8')
      .catch(() => 'No design tokens available');
    const layoutPlan = await readFile(`${workingDir}/layout-plan.json`, 'utf-8')
      .catch(() => 'No layout plan available');

    const prompt = `Use the **design-brief** skill to create a comprehensive design brief based on the following:

## Scraper Output
\`\`\`json
${JSON.stringify(ctx.scraperOutput).slice(0, 15000)}
\`\`\`

## Design Tokens
\`\`\`
${designTokens}
\`\`\`

## Layout Plan
\`\`\`
${layoutPlan.slice(0, 10000)}
\`\`\`

Create a design brief that includes:
1. Site structure and navigation (from layout plan)
2. Page layouts for each page type (from layout plan)
3. Component requirements (from layout plan)
4. Content mapping (which content fields go where)
5. Styling approach (colors, typography, spacing from design tokens)

The brief should guide the Astro code generation process. Use the layout plan as the source of truth for structure.`;

    const result = await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
    });

    await writeFile(
      `${workingDir}/design-brief.json`,
      result,
      'utf-8',
    );

    return {
      status: 'completed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    };
  },
};

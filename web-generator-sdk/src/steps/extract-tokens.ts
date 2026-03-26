/**
 * Step 1: Extract Design Tokens
 * Extract design tokens from reference site or generate defaults.
 */

import { writeFile } from 'fs/promises';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery } from '../lib/agent.js';

export const extractTokensStep: Step = {
  id: 'extract-tokens',
  name: 'Extract Design Tokens',
  description: 'Extract design tokens from reference website',
  modifiesSite: false,

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const prompt = ctx.referenceUrl
      ? `Use the **extract-design-tokens** skill to analyze the reference site: ${ctx.referenceUrl}

Analyze the reference site and extract:
1. Colors (primary, secondary, accent, background, foreground, muted, border)
2. Typography (font families, sizes, weights)
3. Spacing scale
4. Border radius values
5. Shadow values

Return all colors in OKLCH format. Provide the result as a JSON object.`
      : `Use the **extract-design-tokens** skill to generate default design tokens for a modern, clean aesthetic.

Provide a default design token set in JSON format with all colors in OKLCH format:
- Primary: A nice blue/purple tone
- Secondary: A complementary color
- Accent: A vibrant highlight color
- Background: Light neutral
- Foreground: Dark text
- Muted: Subdued neutral
- Border: Subtle border color

Also include typography, spacing, border radius, and shadow tokens.`;

    const result = await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
    });

    await writeFile(
      `${workingDir}/design-tokens.json`,
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

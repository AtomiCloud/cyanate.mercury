/**
 * Step 2: Plan Layout
 * Create a layout plan for the site structure.
 */

import { writeFile } from 'fs/promises';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery } from '../lib/agent.js';

export const planLayoutStep: Step = {
  id: 'plan-layout',
  name: 'Plan Layout',
  description: 'Create layout plan for page structure and responsive strategy',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const prompt = `Use the **design-brief** skill to create a layout plan for the site structure.

## Scraper Structure
\`\`\`json
${JSON.stringify(ctx.scraperOutput.structure).slice(0, 15000)}
\`\`\`

## Scraper Schema (defines content structure per page type)
\`\`\`json
${JSON.stringify(ctx.scraperOutput.schema).slice(0, 15000)}
\`\`\`

Create a layout plan that specifies:

1. **Page Routing Structure**
   - List all pages with their URL patterns
   - Identify static vs dynamic routes (e.g., /blog/[slug])
   - Map page relationships (navigation hierarchy)

2. **Section Composition for Each Page Type**
   - What sections appear on each page (e.g., landing: hero, features, testimonials, CTA)
   - Section order within each page
   - Which sections are shared (header, footer) vs page-specific

3. **Responsive Strategy**
   - Mobile-first breakpoints
   - Layout patterns (stack on mobile, grid on desktop)
   - Content prioritization for smaller screens

4. **Component Mapping**
   - Which reusable Astro components to create for each section type
   - Section-to-component relationship

5. **Content Data Requirements**
   - What content fields each section needs from content.json
   - Field mappings from schema to components

Focus on structure and layout - NOT colors or styling (that comes later).`;

    const result = await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
    });

    await writeFile(
      `${workingDir}/layout-plan.json`,
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

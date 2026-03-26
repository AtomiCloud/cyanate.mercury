/**
 * Step 4: Generate Astro Code
 * Generate pages, components, and layouts using the design brief.
 */

import { readFile } from 'fs/promises';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery } from '../lib/agent.js';

export const generateStep: Step = {
  id: 'generate',
  name: 'Generate',
  description: 'Generate Astro pages, components, and layouts',
  modifiesSite: true,

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const layoutPlan = await readFile(`${workingDir}/layout-plan.json`, 'utf-8')
      .catch(() => 'No layout plan available');
    const designBrief = await readFile(`${workingDir}/design-brief.json`, 'utf-8')
      .catch(() => 'No design brief available');

    const prompt = `Use the **astro-codegen** skill to generate Astro pages, components, and layouts for the current directory.

Consult the **Astro** skill for Astro framework best practices, CLI commands, and project structure.
Consult the **Shadcn** skill for proper component usage and installation patterns.
Reference the **Frontend Design** skill for layout best practices and design patterns.

## Layout Plan
\`\`\`
${layoutPlan.slice(0, 10000)}
\`\`\`

## Design Brief
\`\`\`
${designBrief.slice(0, 10000)}
\`\`\`

## Content Data (to be used at build time)
\`\`\`json
${JSON.stringify(ctx.scraperOutput.content).slice(0, 15000)}
\`\`\`

## Instructions - LAYOUT FIRST APPROACH

Follow this phased approach:

### Phase 1: Data Setup
1. Copy content.json to src/data/content.json (the scraper's content data)
2. Review the src/lib/content.ts helper - it already has functions to read content

### Phase 2: Layout Structure (DO THIS FIRST)
1. Create the page file structure matching the layout plan's routing
2. For each page, create the HTML/Tailwind structure (divs, sections) - use PLACEHOLDER text like "Hero Title", "Feature 1"
3. DO NOT use real content from content.json yet - focus purely on layout/structure
4. Ensure responsive breakpoints match the layout plan
5. Use import to read content: \`import { getPageByUrl } from '../lib/content'\`

### Phase 3: Content Integration
1. Now replace placeholders with actual content from src/data/content.json
2. Use the content.ts helper functions (getPageByUrl, getAllPages, etc.)
3. Map schema fields to component props

### Phase 4: Visual Design
1. Apply design tokens (colors, typography, spacing) from design brief to globals.css
2. Refine component styling to match the design brief aesthetic

### Important Constraints
- DO NOT hardcode content in .astro files - all content must come from src/data/content.json via content.ts
- Layout structure (HTML divs, sections) comes FIRST, before styling
- Follow the layout plan's section composition exactly
- Use Astro's static generation - content is injected at BUILD time, not runtime

Start by reading the existing template files and src/lib/content.ts to understand the structure.

When you're done, provide a summary of all files created and modified.`;

    const result = await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
    });

    return {
      status: 'completed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    };
  },
};

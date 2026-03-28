/**
 * Phase 3: DESIGN
 *
 * Apply typography, component styling, surfaces, shadows, borders.
 * Neutral palette (grays only) — no real colors yet.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery } from '../lib/agent.js';

export const designStep: Step = {
  id: 'design',
  name: 'Phase 3: Design',
  description: 'Apply typography, component styling, surfaces (neutral palette)',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const fingerprint = await readFile(join(ctx.scratchDir, 'style-fingerprint.json'), 'utf-8')
      .catch(() => '{}');
    const tokens = await readFile(join(ctx.scratchDir, 'design-tokens.json'), 'utf-8')
      .catch(() => '{}');
    const recipes = await readFile(join(ctx.scratchDir, 'component-recipes.json'), 'utf-8')
      .catch(() => '{}');

    const rejectionSection = ctx.rejectionContext
      ? `\n## Prior Reviewer Feedback (Retry)\n\nThe previous attempt was rejected by reviewers. Address these issues:\n\n${ctx.rejectionContext}\n\n`
      : '';

    const prompt = `Apply typography, component styling, surfaces, shadows, and borders to the Astro project at the current directory.

${rejectionSection}
Consult the **Astro** skill for Astro framework reference.
Consult the **Shadcn** skill for component installation and usage.

## IMPORTANT: Pages already exist
The site already has real pages built from content collections (Phase 2: Layout). Do NOT replace or remove any pages.
Only ADD typography, component styling, surfaces, shadows, and borders to existing components and pages.

## Style Fingerprint
\`\`\`json
${fingerprint}
\`\`\`

## Design Tokens (atomic, gradients, surfaces, visualIdentity layers)
\`\`\`json
${tokens}
\`\`\`

## Component Recipes
\`\`\`json
${recipes}
\`\`\`

## Instructions

You are in Phase 3: DESIGN. Apply typography, component shapes, and surface effects. Use ONLY neutral grays for colors — real colors come in Phase 4.

### What to apply:
1. **Typography** — font families, sizes, weights, line heights, letter spacing from atomic.typography
2. **Component recipes** — button shapes (padding, radius, weight), card variants, input styling, badge styling
3. **Surface treatment** — glass/blur effects (backdrop-filter), texture overlays (noise/grain)
4. **Shadows** — from atomic.shadows
5. **Border radius** — from atomic.borderRadius
6. **Border styles** — from visualIdentity.borders
7. **Gradient structure** — angle and stop positions (colors = neutral placeholders)

### Style fingerprint treatment mapping:
- surface "frosted-glass" → backdrop-filter: blur(12px); background: rgba(255,255,255,0.25)
- corners "sharp" → border-radius: 0
- corners "pill" → border-radius: 9999px for interactive elements
- shadows "layered-soft" → multiple box-shadows with large blur
- shadows "hard-offset" → offset shadows (neobrutalist)
- borders "thick" → border: 2-3px solid
- borders "none" → remove borders, rely on shadow/elevation

### Color constraint (NEUTRAL PALETTE ONLY):
Override all color CSS variables to neutral grays:
\`\`\`css
:root {
  --background: oklch(0.98 0 0);
  --foreground: oklch(0.15 0 0);
  --primary: oklch(0.4 0 0);
  --secondary: oklch(0.5 0 0);
  --muted: oklch(0.92 0 0);
  --border: oklch(0.88 0 0);
  --accent: oklch(0.45 0 0);
  --destructive: oklch(0.5 0.15 25);
  --card: oklch(1.0 0 0);
  --popover: oklch(1.0 0 0);
  --ring: oklch(0.4 0 0);
}
\`\`\`

### Install any needed Shadcn components:
Use: npx shadcn add [component] for each component in the recipes (button, card, input, badge, etc.)

### Validation:
1. Run: npm run typecheck
2. Run: npx astro check
3. Run: npm run build

If all checks pass, output "DESIGN_PHASE_PASSED".`;

    const result = await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
    });

    const passed = result.includes('DESIGN_PHASE_PASSED');

    return {
      status: passed ? 'completed' : 'failed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
      error: passed ? undefined : 'Design phase failed validation',
    };
  },
};

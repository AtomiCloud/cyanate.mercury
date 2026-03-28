/**
 * Phase 4: COLOR
 *
 * Apply the color system — map atomic colors to CSS custom properties,
 * build theme system (light + dark), validate WCAG contrast.
 *
 * Key property: ONLY modifies globals.css. No .astro or .tsx files change.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery } from '../lib/agent.js';

export const colorStep: Step = {
  id: 'color',
  name: 'Phase 4: Color',
  description: 'Apply color system, theme variants, WCAG contrast validation',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const tokens = await readFile(join(ctx.scratchDir, 'design-tokens.json'), 'utf-8')
      .catch(() => '{}');
    const fingerprint = await readFile(join(ctx.scratchDir, 'style-fingerprint.json'), 'utf-8')
      .catch(() => '{}');

    // Read current globals.css
    let globalsCss = '';
    try {
      globalsCss = await readFile(join(workingDir, 'src/styles/globals.css'), 'utf-8');
    } catch {
      globalsCss = '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n';
    }

    const rejectionSection = ctx.rejectionContext
      ? `\n## Prior Reviewer Feedback (Retry)\n\nThe previous attempt was rejected by reviewers. Address these issues:\n\n${ctx.rejectionContext}\n\n`
      : '';

    const prompt = `Apply the color system to the Astro project at the current directory.

${rejectionSection}
Consult the **Astro** skill for Astro framework reference.

## Design Tokens (atomic.colors, visualIdentity layers)
\`\`\`json
${tokens}
\`\`\`

## Style Fingerprint (darkness dimension)
\`\`\`json
${fingerprint}
\`\`\`

## Current globals.css
\`\`\`css
${globalsCss.slice(0, 10000)}
\`\`\`

## Instructions

You are in Phase 4: COLOR. Apply the color system ONLY.

### CRITICAL CONSTRAINT:
Only modify \`src/styles/globals.css\`. Do NOT modify any .astro or .tsx files.
Layout (Phase 2) and design (Phase 3) are physically impossible to regress if you only touch globals.css.

### What to do:
1. **Map atomic colors → CSS custom properties** in the \`::root\` block
   - Replace the neutral placeholder values with actual colors from design-tokens.json
   - All colors must be in OKLCH format
   - Include: --background, --foreground, --primary, --secondary, --accent, --muted, --border, --destructive, --card, --popover, --ring, --input, --primary-foreground, --secondary-foreground, --accent-foreground, --muted-foreground

2. **Apply 60-30-10 color distribution** from visualIdentity.colorDistribution:
   - 60% dominant color (backgrounds, large surfaces)
   - 30% secondary color (cards, sections, navigation)
   - 10% accent color (CTAs, highlights, active states)

3. **Set up dark mode theme** in a \`.dark\` class variant:
   - If darkness > 0.7: dark theme primary, light mode secondary
   - Invert backgrounds and foregrounds
   - Ensure text remains readable in both modes

4. **Apply gradient colors** — replace neutral placeholders in gradients with actual colors

5. **Apply border colors** from visualIdentity.borders

### WCAG Contrast Requirements:
- Normal text (< 18px / < 14px bold): minimum 4.5:1 contrast ratio
- Large text (>= 18px / >= 14px bold): minimum 3.1:1 contrast ratio
- UI components (borders, icons): minimum 3:1 contrast ratio
- Test on both light and dark themes

### Validation:
1. Run: npm run typecheck
2. Run: npx astro check
3. Run: npm run build

If all checks pass, output "COLOR_PHASE_PASSED".`;

    const result = await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
    });

    const passed = result.includes('COLOR_PHASE_PASSED');

    return {
      status: passed ? 'completed' : 'failed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
      error: passed ? undefined : 'Color phase failed validation',
    };
  },
};

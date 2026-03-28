/**
 * Phase 0: ANALYZE
 *
 * Extract style fingerprint, 7-layer design tokens, and component recipes
 * from the reference URL. Outputs structured JSON files to scratch directory.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery } from '../lib/agent.js';

export const analyzeStep: Step = {
  id: 'analyze',
  name: 'Phase 0: Analyze',
  description: 'Extract style fingerprint, 7-layer design tokens, and component recipes',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const styleClassification = await readFile(
      join(process.cwd(), 'DESIGN-STYLE-CLASSIFICATION.md'), 'utf-8',
    ).catch(() => '');
    const tokenResearch = await readFile(
      join(process.cwd(), 'DESIGN-TOKEN-RESEARCH.md'), 'utf-8',
    ).catch(() => '');

    const rejectionSection = ctx.rejectionContext
      ? `\n## Prior Reviewer Feedback (Retry)\n\nThe previous attempt was rejected by reviewers. Address these issues:\n\n${ctx.rejectionContext}\n\n`
      : '';

    const prompt = `Use the **extract-design-tokens** skill to analyze the reference site: ${ctx.referenceUrl || 'not provided'}

${rejectionSection}
${styleClassification ? `## Style Classification Reference\n${styleClassification.slice(0, 8000)}\n` : ''}
${tokenResearch ? `## Token Architecture Reference\n${tokenResearch.slice(0, 8000)}\n` : ''}

Analyze the reference site and extract THREE structured JSON files:

## 1. style-fingerprint.json

Classify the site's visual personality with these dimensions (0.0-1.0):
- ornament (minimal to highly decorative)
- playfulness (serious to playful)
- warmth (cool to warm)
- density (airy to dense)
- motion (static to animated)
- depth (flat to layered)
- darkness (light to dark)
- formality (casual to formal)

Include primary style category (e.g., "minimalist", "brutalist", "corporate") and secondary styles.
Include treatments: surface, corners, shadows, borders, gradients, blur, transparency, animation_style.
Set confidence score (0.0-1.0).

## 2. design-tokens.json

Extract a 7-layer token architecture. The TOP-LEVEL KEYS must be exactly these names (no layer prefixes):

\`\`\`json
{
  "atomic": { ... },
  "gradients": { ... },
  "layout": { ... },
  "componentSpacing": { ... },
  "motion": { ... },
  "surfaces": { ... },
  "visualIdentity": { ... }
}
\`\`\`

Each layer:
1. **atomic** - colors, typography, spacing, borderRadius, shadows
2. **gradients** - gradient definitions (type, angle, stops)
3. **layout** - grid, container, breakpoints, sections, density, rhythm
4. **componentSpacing** - inset, insetSquish, insetStretch, stack, inline, grid
5. **motion** - duration, easing, state (hover/focus/active/disabled), scroll, skeleton
6. **surfaces** - glass (must have real values: backdropBlur, background, borderColor), texture (must have real values: type, opacity, etc.), imageTreatment
7. **visualIdentity** - colorDistribution (must have keys: dominant, secondary, accent — NOT "neutral"), borders

CRITICAL: Do NOT prefix the keys with "layer0_", "layer1_", etc. Use the exact key names shown above.

All colors in OKLCH format. Include actual measured values from the site.

## 3. component-recipes.json

For each component type found (button, card, navigation, input, badge, etc.):
- **base**: padding, fontWeight, borderRadius, fontSize, lineHeight, etc.
- **variants**: at least 2 (e.g., primary, secondary, ghost, destructive, link for buttons)
- **states**: hover, focus, active, disabled transitions/transforms

Use CSS values like "token:primary" to reference design tokens where appropriate.

## IMPORTANT
- Write all 3 files to the scratch directory: ${ctx.scratchDir}
- Each file must be valid JSON
- All 7 token layers must have non-empty values
- Component recipes must have base + at least 2 variants
- If no reference URL, generate reasonable defaults for a modern SaaS site`;

    await agentQuery({
      prompt,
      cwd: ctx.scratchDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
    });

    // Validate outputs exist and are valid JSON
    const errors: string[] = [];
    for (const file of ['style-fingerprint.json', 'design-tokens.json', 'component-recipes.json']) {
      try {
        const content = await readFile(join(ctx.scratchDir, file), 'utf-8');
        JSON.parse(content);
      } catch (e) {
        errors.push(`${file}: ${e instanceof Error ? e.message : 'invalid or missing'}`);
      }
    }

    return {
      status: errors.length === 0 ? 'completed' : 'failed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
      error: errors.length > 0 ? errors.join('; ') : undefined,
    };
  },
};

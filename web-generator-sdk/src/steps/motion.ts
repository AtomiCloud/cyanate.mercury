/**
 * Phase 5: MOTION
 *
 * Add transitions, hover/focus/active/disabled states, scroll reveals,
 * easing curves, and prefers-reduced-motion support.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery } from '../lib/agent.js';

export const motionStep: Step = {
  id: 'motion',
  name: 'Phase 5: Motion',
  description: 'Add transitions, hover/focus states, scroll reveals, reduced-motion',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const tokens = await readFile(join(ctx.scratchDir, 'design-tokens.json'), 'utf-8')
      .catch(() => '{}');
    const fingerprint = await readFile(join(ctx.scratchDir, 'style-fingerprint.json'), 'utf-8')
      .catch(() => '{}');
    const recipes = await readFile(join(ctx.scratchDir, 'component-recipes.json'), 'utf-8')
      .catch(() => '{}');

    const rejectionSection = ctx.rejectionContext
      ? `\n## Prior Reviewer Feedback (Retry)\n\nThe previous attempt was rejected by reviewers. Address these issues:\n\n${ctx.rejectionContext}\n\n`
      : '';

    const prompt = `Add motion, transitions, and interaction states to the Astro project at the current directory.

${rejectionSection}
Consult the **Astro** skill for Astro framework reference.
Consult the **Shadcn** skill for component styling patterns.

## IMPORTANT: Pages already exist
The site already has real pages with layout and design applied (Phases 2-3). Do NOT remove or replace any pages.
Only ADD motion, transitions, hover/focus states, and scroll animations to existing components and pages.

## Design Tokens (motion layer)
\`\`\`json
${tokens}
\`\`\`

## Style Fingerprint (motion dimension, animation_style)
\`\`\`json
${fingerprint}
\`\`\`

## Component Recipes (states)
\`\`\`json
${recipes}
\`\`\`

## Instructions

You are in Phase 5: MOTION. Add transitions, hover/focus/active/disabled states, and scroll animations.

### Motion density (from style fingerprint motion dimension 0.0-1.0):
- 0.0-0.2 → Only essential interactions (hover color, focus ring). No scroll animations.
- 0.2-0.4 → Subtle transitions (200ms ease), gentle scroll reveals
- 0.4-0.6 → Standard modern (spring-gentle, staggered reveals, card hover lifts)
- 0.6-0.8 → Expressive (bouncy easings, staggered grids, parallax elements)
- 0.8-1.0 → Cinematic (slow transitions >400ms, dramatic scroll effects)

### Animation style → easing mapping:
- "subtle" → ease, 150-200ms
- "spring-gentle" → cubic-bezier(0.34, 1.56, 0.64, 1), 200-300ms
- "spring-bouncy" → cubic-bezier(0.68, -0.6, 0.32, 1.6), 200-400ms
- "snappy" → cubic-bezier(0.16, 1, 0.3, 1), 100-200ms
- "cinematic" → ease-in-out, 400-600ms

### What to apply:
1. **Transition durations** from motion.duration → CSS variables in globals.css
2. **Easing curves** from motion.easing → CSS variables
3. **Interaction states** from component-recipes states + motion.state:
   - Hover: bg shift, elevation delta, translateY
   - Focus: ring width, ring offset, ring color
   - Active: scale reduction, shadow collapse
   - Disabled: opacity 0.5, cursor not-allowed
4. **Scroll reveals** — fade-in, slide-up patterns (if motion > 0.2)
5. **Staggered children** — 50-100ms delay per item in grids
6. **prefers-reduced-motion** media query support:
   - All scroll-triggered animations disabled
   - Hover/focus transitions instant (0ms) or very subtle
   - No auto-playing animations

### CRITICAL RULES:
- NO \`transition: all\` — each transition must list explicit properties
- NO \`!important\` on transition properties
- Animations must ONLY use transform and opacity (no width/height/top/left transitions)
- No animation exceeds 1s (scroll reveals max 600ms, hover max 300ms)
- Scroll animations fire once and don't re-trigger

### Files to modify:
- src/styles/globals.css — transition/easing CSS variables, prefers-reduced-motion
- src/components/ui/*.tsx — component hover/focus/active/disabled transitions
- src/components/*.astro — scroll reveal classes on sections
- src/layouts/Layout.astro — scroll reveal wrapper if needed

### Validation:
1. Run: npm run typecheck
2. Run: npx astro check
3. Run: npm run build

If all checks pass, output "MOTION_PHASE_PASSED".`;

    const result = await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
    });

    const passed = result.includes('MOTION_PHASE_PASSED');

    return {
      status: passed ? 'completed' : 'failed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
      error: passed ? undefined : 'Motion phase failed validation',
    };
  },
};

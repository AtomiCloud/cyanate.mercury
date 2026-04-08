/**
 * Phase 5: MOTION
 *
 * Add transitions, hover/focus/active/disabled states, scroll reveals,
 * easing curves, and prefers-reduced-motion support.
 */

import { readFile, readdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery } from '../lib/agent.js';

const MOTION_FORBIDDEN_DECLARATIONS = [
  /(^|[;\s{])color\s*:[^;]+;?/gmi,
  /(^|[;\s{])background(?:-color)?\s*:[^;]+;?/gmi,
  /\boklch\([^)]*\)/gmi,
  /\bhsl\([^)]*\)/gmi,
  /\brgb\([^)]*\)/gmi,
  /#[0-9a-fA-F]{3,8}\b/g,
  /(^|[;\s{])font-size\s*:[^;]+;?/gmi,
  /(^|[;\s{])font-weight\s*:[^;]+;?/gmi,
  /(^|[;\s{])font-family\s*:[^;]+;?/gmi,
];

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
    const interactionManifest = await readFile(join(workingDir, 'output/reduced/interaction-manifest.json'), 'utf-8')
      .catch(() => '{"patterns":[]}');

    const rejectionSection = ctx.rejectionContext
      ? `\n## Prior Reviewer Feedback (Retry)\n\nThe previous attempt was rejected by checks or reviewers. Address these issues:\n\n${ctx.rejectionContext}\n\n`
      : '';

    const prompt = `Add motion and interaction behavior to the Astro project at the current directory.

${rejectionSection}
Consult the **Astro** skill for Astro framework reference.
Consult the **Shadcn** skill for component styling patterns.

## Scope
This phase owns motion and interaction behavior. Layout/design/color already exist.
Do not replace pages or restructure the site unless required to wire the interactions from the manifest.

## Inputs
### Design Tokens
\`\`\`json
${tokens}
\`\`\`

### Style Fingerprint
\`\`\`json
${fingerprint}
\`\`\`

### Component Recipes
\`\`\`json
${recipes}
\`\`\`

### Interaction Manifest
\`\`\`json
${interactionManifest}
\`\`\`

## Required work
- Add transition duration/easing variables from the motion token layer.
- Add hover/focus/active/disabled behavior for interactive components.
- Fully wire manifest-driven interactions where required:
  - fragment navigation
  - modal/popup open-close behavior
  - accordion/tab toggles
  - search/filter controls when present
- Ensure prefers-reduced-motion support is effective.

## Rules
- No \`transition: all\`
- No \`!important\` for transition rules
- Use transform/opacity for animation where possible
- Avoid introducing regressions in layout, typography, or color ownership
- Do NOT add or change color values in this phase: no \`oklch(...)\`, \`hsl(...)\`, \`rgb(...)\`, hex colors, or palette rewrites
- Do NOT add typography/layout declarations in this phase: no \`font-size\`, \`font-weight\`, \`font-family\`, \`grid-template\`, \`grid-cols\`, or new spacing/layout structure unrelated to interaction behavior
- Treat runtime/contract checks as authoritative; your job is to implement behavior cleanly so those checks pass

## Hover and Focus State Rules
- Hover and non-hover states MUST be visually different. Do NOT write identical ternary branches like \`isActive ? '' : ''\`.
- Prefer CSS :hover pseudo-class over JavaScript hover tracking — it's more reliable and doesn't have child-element bubbling issues.
- Every interactive element (card, button, link) MUST have a visible hover state (background change, shadow, transform, or opacity shift).
- Focus states MUST be visible for keyboard navigation — never remove outline without providing an alternative.

## Validation note
Do not rely on sentinel strings or self-reported pass/fail. The pipeline will run deterministic contract/runtime checks after this step.
Return a concise summary of what you changed.`;

    await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
      maxTurns: 100,
    });

    // sanitizeMotionPhaseOutput removed — was stripping legitimate CSS

    return {
      status: 'completed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    };
  },
};

async function sanitizeMotionPhaseOutput(workingDir: string): Promise<void> {
  const srcDir = join(workingDir, 'src');
  const files = await listSourceFiles(srcDir);
  await Promise.all(files.map(async (file) => {
    const original = await readFile(file, 'utf-8');
    const sanitized = sanitizeMotionSource(original);
    if (sanitized !== original) {
      await writeFile(file, sanitized, 'utf-8');
    }
  }));
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(fullPath));
      continue;
    }
    if (entry.name.endsWith('.astro') || entry.name.endsWith('.css') || entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function sanitizeMotionSource(source: string): string {
  let next = source;
  for (const pattern of MOTION_FORBIDDEN_DECLARATIONS) {
    next = next.replace(pattern, (match, prefix: string) => prefix || '');
  }
  return next.replace(/\n{3,}/g, '\n\n');
}

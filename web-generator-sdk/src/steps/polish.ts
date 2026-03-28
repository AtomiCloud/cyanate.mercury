/**
 * Phase 6: POLISH
 *
 * Final validation and quality assurance. Read-only on source files.
 * Runs full build, functional checks, responsive audit, quality scoring.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery, extractErrors } from '../lib/agent.js';

export const polishStep: Step = {
  id: 'polish',
  name: 'Phase 6: Polish',
  description: 'Final validation, quality scoring, style fingerprint fidelity check',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const fingerprint = await readFile(join(ctx.scratchDir, 'style-fingerprint.json'), 'utf-8')
      .catch(() => '{}');

    const rejectionSection = ctx.rejectionContext
      ? `\n## Prior Reviewer Feedback (Retry)\n\nThe previous attempt was rejected by reviewers. Address these issues:\n\n${ctx.rejectionContext}\n\n`
      : '';

    const prompt = `Run final validation and quality assurance on the Astro project at the current directory.

${rejectionSection}
Consult the **Astro** skill for Astro CLI commands.
Consult the **webapp-testing** skill for Playwright testing.
Consult the **test-and-quality** skill for quality scoring.

## Style Fingerprint (reference for fidelity check)
\`\`\`json
${fingerprint}
\`\`\`

## Validation Checks

### 1. Static Checks
Run all three:
1. npm run typecheck
2. npx astro check
3. npm run build

### 2. Functional Checks (Playwright)
Start dev server first: npm run dev

1. **Page load test** — visit every page, confirm no crash, no console errors
2. **Link checker** — find ALL links across ALL pages, visit each, report broken links
3. **Navigation test** — click every nav link on every page, verify correct destination
4. **Button test** — find all buttons on all pages, click each, verify all are interactive
5. **All pages test** — visit every page defined in src/pages/, verify each loads without error

### 3. Responsive Checks
Screenshot at three breakpoints:
1. 375px (mobile) — no horizontal scrollbar, content reflowed, nav accessible
2. 768px (tablet) — layout transitions, no overflow
3. 1280px (desktop) — full layout visible, content not stretched

### 4. Quality Scoring (7 dimensions, each 1-10)
Save results to quality-scores.json:
- layoutConsistency (20%) — spacing follows rhythm, grid alignment, no magic numbers
- designTokenUsage (20%) — all values from tokens, no hardcoded colors/sizes
- componentComposition (15%) — variants render, recipes followed, shared components used
- responsiveDesign (15%) — clean reflow at all 3 breakpoints, no overflow
- semanticHtml (10%) — heading hierarchy, landmark elements, ARIA labels
- visualAppeal (10%) — professional, matches style fingerprint aesthetic
- motionQuality (10%) — smooth transitions, correct easing, reduced-motion works

### 5. Style Fingerprint Fidelity
Compare the generated site against the style fingerprint dimensions.
Flag dimensions that diverge > 0.2 from the target.

## Output Files
Write these JSON files to the project root:
1. \`quality-scores.json\` — { overall, dimensions: { layoutConsistency, ... } }
2. \`test-report.json\` — { timestamp, pages, responsive, functional }

If quality score overall >= 8.5/10, output "POLISH_PHASE_PASSED" at the end.
If score < 8.5, output "POLISH_PHASE_FAILED" with the low-scoring dimensions listed.`;

    const result = await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
    });

    const passed = result.includes('POLISH_PHASE_PASSED');

    // Read quality scores for reporting
    let scores: { overall: number } | null = null;
    try {
      scores = JSON.parse(await readFile(join(workingDir, 'quality-scores.json'), 'utf-8'));
    } catch { /* scores file not created */ }

    return {
      status: passed ? 'completed' : 'failed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
      error: passed
        ? undefined
        : `Quality score below threshold${scores ? ` (overall: ${scores.overall})` : ''}`,
    };
  },
};

/**
 * Phase 6: POLISH
 *
 * Final validation and quality assurance. Read-only on source files.
 * Runs full build, functional checks, responsive audit, quality scoring.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery } from '../lib/agent.js';

const STABLE_TSCONFIG = `{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": [".astro/types.d.ts", "**/*"],
  "exclude": ["dist"]
}
`;

const STABLE_POSTCSS = `export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
`;

export const polishStep: Step = {
  id: 'polish',
  name: 'Phase 6: Polish',
  description: 'Final validation, quality scoring, style fingerprint fidelity check',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const fingerprint = await readFile(join(ctx.scratchDir, 'style-fingerprint.json'), 'utf-8')
      .catch(() => '{}');

    const rejectionSection = ctx.rejectionContext
      ? `\n## Prior Reviewer Feedback (Retry)\n\nThe previous attempt was rejected by checks or reviewers. Address these issues:\n\n${ctx.rejectionContext}\n\n`
      : '';

    const prompt = `Perform the final polish pass on the Astro project at the current directory.

${rejectionSection}
Consult the **Astro** skill for Astro CLI commands.

## Style Fingerprint Reference
\`\`\`json
${fingerprint}
\`\`\`

## Scope
This is the final integration phase.
- Fix remaining polish issues only.
- Do not re-architect earlier phases unless required to resolve a concrete issue from rejection context.
- Focus on visual cohesion, style fidelity, and final UX polish.

## Priorities
- tighten final visual consistency
- improve fidelity to the style fingerprint
- resolve small UX rough edges
- keep deterministic checks green

## Validation note
The pipeline will run deterministic runtime and quality checks after this step.
Do not rely on sentinel strings or self-reported pass/fail.
Return a concise summary of the final refinements you made.`;

    await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
      maxTurns: 100,
    });

    await restorePolishToolingFiles(workingDir);

    return {
      status: 'completed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    };
  },
};

async function restorePolishToolingFiles(workingDir: string): Promise<void> {
  await writeFile(join(workingDir, 'tsconfig.json'), STABLE_TSCONFIG, 'utf-8');
  await writeFile(join(workingDir, 'postcss.config.js'), STABLE_POSTCSS, 'utf-8');
}

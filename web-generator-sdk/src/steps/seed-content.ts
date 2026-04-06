import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import type { Registry } from '../types.js';
import { validateRegistry } from '../lib/validate-boundary.js';
import { deriveOrigin, seedContentArtifacts, writeDynamicBindings } from '../lib/seed-helpers.js';
import { formatSemanticIssues, validateRegistrySemantics, validateReducedMetaSemantics } from '../lib/semantics.js';

export const seedContentStep: Step = {
  id: 'seed-content',
  name: 'Phase 1d: Seed Content',
  description: 'Write Astro content collections and static data deterministically',
  deterministic: true,

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();
    try {
      const reducedDir = join(workingDir, 'output/reduced');
      const rawRegistry = JSON.parse(await readFile(join(reducedDir, 'registry.json'), 'utf-8'));
      const registry = validateRegistry(rawRegistry) as unknown as Registry;
      const meta = JSON.parse(await readFile(join(reducedDir, 'meta.json'), 'utf-8'));

      const metaIssues = validateReducedMetaSemantics(meta);
      const registryIssues = validateRegistrySemantics(registry, meta);
      if (metaIssues.length > 0 || registryIssues.length > 0) {
        throw new Error([
          formatSemanticIssues('Reduced meta validation failed', metaIssues),
          formatSemanticIssues('Registry validation failed', registryIssues),
        ].filter(Boolean).join('\n\n'));
      }

      const sourceOrigin = ctx.sourceOrigin || deriveOrigin(
        ((ctx.scraperOutput.structure as unknown) as Record<string, unknown>)?.site_url as string
        || ctx.scraperOutput.structure.pages[0]?.url
        || '',
      );

      const result = await seedContentArtifacts({
        siteDir: workingDir,
        reducedDir,
        registry,
        scraperOutput: ctx.scraperOutput,
        sourceOrigin,
      });

      // Write dynamic bindings manifest to src/data/ if content-reduction produced one
      await writeDynamicBindings(workingDir, reducedDir);

      await writeFile(join(workingDir, 'seed-content-report.json'), JSON.stringify({
        collectionCounts: result.collectionCounts,
        staticPages: result.staticPageEntries.length,
        sourceOrigin,
      }, null, 2), 'utf-8');

      return {
        status: 'completed',
        startedAt: new Date(startTime).toISOString(),
        finishedAt: new Date().toISOString(),
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        status: 'failed',
        startedAt: new Date(startTime).toISOString(),
        finishedAt: new Date().toISOString(),
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

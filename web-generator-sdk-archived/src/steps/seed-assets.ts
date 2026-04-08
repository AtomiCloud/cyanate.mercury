import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import { buildImageRewriteMap, deriveOrigin, seedContentArtifacts } from '../lib/seed-helpers.js';
import { validateRegistry } from '../lib/validate-boundary.js';
import type { Registry } from '../types.js';

export const seedAssetsStep: Step = {
  id: 'seed-assets',
  name: 'Phase 1e: Seed Assets',
  description: 'Download and localize source assets deterministically',
  deterministic: true,

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();
    try {
      const reducedDir = join(workingDir, 'output/reduced');
      const rawRegistry = JSON.parse(await readFile(join(reducedDir, 'registry.json'), 'utf-8'));
      const registry = validateRegistry(rawRegistry) as unknown as Registry;
      const sourceOrigin = ctx.sourceOrigin || deriveOrigin(
        ((ctx.scraperOutput.structure as unknown) as Record<string, unknown>)?.site_url as string
        || ctx.scraperOutput.structure.pages[0]?.url
        || '',
      );

      await mkdir(join(workingDir, 'public/images'), { recursive: true });
      const assets = await buildImageRewriteMap({
        siteDir: workingDir,
        scraperContent: ctx.scraperOutput.content,
        sourceOrigin,
      });

      await seedContentArtifacts({
        siteDir: workingDir,
        reducedDir,
        registry,
        scraperOutput: ctx.scraperOutput,
        sourceOrigin,
        rewriteMap: assets.rewriteMap,
      });

      if (assets.errors.length > 0) {
        await writeFile(join(workingDir, 'missing-assets.json'), JSON.stringify({ missing: assets.errors }, null, 2), 'utf-8');
      }

      await writeFile(join(workingDir, 'seed-assets-report.json'), JSON.stringify({
        downloadedCount: assets.downloadedCount,
        localizedCount: assets.rewriteMap.size,
        missingCount: assets.errors.length,
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

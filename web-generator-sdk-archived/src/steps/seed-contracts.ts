import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import type { InteractionManifest, Registry } from '../types.js';
import { validateInteractionManifestData, validateRegistry } from '../lib/validate-boundary.js';
import {
  formatSemanticIssues,
  validateInteractionManifest,
  validateRegistrySemantics,
  validateReducedMetaSemantics,
} from '../lib/semantics.js';
import { deriveOrigin, scanForSourceOriginLeaks } from '../lib/seed-helpers.js';

export const seedContractsStep: Step = {
  id: 'seed-contracts',
  name: 'Phase 1f: Seed Contracts',
  description: 'Validate seeded collections, assets, and interaction manifests as an integrated contract',
  deterministic: true,

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();
    try {
      const reducedDir = join(workingDir, 'output/reduced');
      const meta = JSON.parse(await readFile(join(reducedDir, 'meta.json'), 'utf-8'));
      const rawRegistry = JSON.parse(await readFile(join(reducedDir, 'registry.json'), 'utf-8'));
      const registry = validateRegistry(rawRegistry) as unknown as Registry;
      const interactionManifest = validateInteractionManifestData(
        JSON.parse(await readFile(join(reducedDir, 'interaction-manifest.json'), 'utf-8')),
        registry,
      ) as InteractionManifest;

      const issues = [
        ...validateReducedMetaSemantics(meta),
        ...validateRegistrySemantics(registry, meta),
        ...validateInteractionManifest(interactionManifest, registry),
      ];

      const sourceOrigin = ctx.sourceOrigin || deriveOrigin(
        ((ctx.scraperOutput.structure as unknown) as Record<string, unknown>)?.site_url as string
        || ctx.scraperOutput.structure.pages[0]?.url
        || '',
      );
      const leaks = sourceOrigin ? await scanForSourceOriginLeaks(workingDir, sourceOrigin) : [];
      if (leaks.length > 0) {
        issues.push(...leaks.map((leak) => ({ path: leak.file, message: `Source origin leakage: ${leak.match}` })));
      }

      let missingAssetCount = 0;
      try {
        const assetManifest = JSON.parse(await readFile(join(workingDir, 'asset-manifest.json'), 'utf-8'));
        const missing = Array.isArray(assetManifest.missing) ? assetManifest.missing : [];
        missingAssetCount = missing.length;
      } catch {
        issues.push({ path: 'asset-manifest.json', message: 'Missing asset manifest' });
      }

      if (issues.length > 0) {
        throw new Error(formatSemanticIssues('Seed contract validation failed', issues));
      }

      await writeFile(join(workingDir, 'seed-contracts-report.json'), JSON.stringify({
        status: 'ok',
        interactionPatterns: interactionManifest.patterns.length,
        missingAssetCount,
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

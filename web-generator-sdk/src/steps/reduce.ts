/**
 * Phase 1a: REDUCE (Code — No AI)
 *
 * Programmatic reduction of raw scraper output into a per-page-type package.
 * Groups content by pagetype, detects multi/single, extracts global chrome,
 * picks samples, and writes reduced output.
 */

import { readFile, writeFile, mkdir, copyFile } from 'fs/promises';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import type { ReducedMeta, PageTypeInfo } from '../types.js';

function countLeafFields(obj: unknown, depth = 0): number {
  if (obj === null || obj === undefined) return 0;
  if (typeof obj !== 'object') return 1;
  if (Array.isArray(obj)) return obj.reduce((sum, item) => sum + countLeafFields(item, depth + 1), 0);
  return Object.values(obj).reduce((sum, val) => sum + countLeafFields(val, depth + 1), 0);
}

function normalizeRoute(url: string): string {
  return url
    .replace(/\{(\w+)\}/g, '[$1]')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
}

function extractSlugParam(url: string): string | undefined {
  const match = url.match(/\{(\w+)\}/);
  return match ? match[1] : undefined;
}

export const reduceStep: Step = {
  id: 'reduce',
  name: 'Phase 1a: Reduce',
  description: 'Programmatically reduce scraper output into per-page-type packages',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const structure = ctx.scraperOutput.structure;
    const schema = ctx.scraperOutput.schema;
    const content = ctx.scraperOutput.content;

    const outputDir = join(workingDir, 'output/reduced');
    await mkdir(join(outputDir, 'global'), { recursive: true });

    // Group content by pagetype
    const grouped = new Map<string, typeof content.pages>();
    for (const page of content.pages) {
      const list = grouped.get(page.pagetype) || [];
      list.push(page);
      grouped.set(page.pagetype, list);
    }

    // Detect global keys (present in >90% of page types)
    const pageTypes = Array.from(grouped.keys());
    const threshold = Math.ceil(pageTypes.length * 0.9);
    const keyCounts = new Map<string, number>();
    for (const [pagetype] of grouped) {
      const schemaKeys = Object.keys(schema[pagetype]?.properties || {});
      for (const key of schemaKeys) {
        keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
      }
    }
    const globalKeys = Array.from(keyCounts.entries())
      .filter(([, count]) => count >= threshold)
      .map(([key]) => key);

    // Build page type info
    const pageTypeInfos: PageTypeInfo[] = pageTypes.map((pagetype) => {
      const entries = grouped.get(pagetype) || [];
      const firstEntry = entries[0];
      const route = normalizeRoute(firstEntry?.url || '/');
      const schemaKeys = Object.keys(schema[pagetype]?.properties || {});

      // Detect pagination
      const hasPagination = 'pagination' in (schema[pagetype]?.properties || {}) || route.includes('[page]');

      return {
        pagetype,
        route,
        count: entries.length,
        multi: entries.length > 1,
        has_pagination: hasPagination,
        slug_param: extractSlugParam(firstEntry?.url || ''),
        schema_keys: schemaKeys,
        own_keys: schemaKeys.filter(k => !globalKeys.includes(k)),
      };
    });

    // Validate page count invariant
    const totalCount = pageTypeInfos.reduce((sum, pt) => sum + pt.count, 0);
    if (totalCount !== structure.pages.length) {
      return {
        status: 'failed',
        startedAt: new Date(startTime).toISOString(),
        finishedAt: new Date().toISOString(),
        duration: Date.now() - startTime,
        error: `Page count invariant failed: sum(counts)=${totalCount} !== total_pages=${structure.pages.length}`,
      };
    }

    // Write meta.json
    const meta: ReducedMeta = {
      source: {
        total_pages: structure.pages.length,
        page_types: pageTypes.length,
        scraped_at: new Date().toISOString(),
        site_url: ctx.referenceUrl || structure.pages[0]?.url || '',
      },
      global_keys: globalKeys,
      page_types: pageTypeInfos,
      pagination_candidates: pageTypeInfos
        .filter(pt => pt.has_pagination)
        .map(pt => ({ pagetype: pt.pagetype, evidence: 'Pagination detected in schema or URL pattern' })),
    };
    await writeFile(join(outputDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

    // Write per-type schemas and samples
    for (const [pagetype, entries] of grouped) {
      const typeDir = join(outputDir, 'types', pagetype);
      const samplesDir = join(typeDir, 'samples');
      await mkdir(samplesDir, { recursive: true });

      // Copy schema
      if (schema[pagetype]) {
        await writeFile(
          join(typeDir, 'schema.json'),
          JSON.stringify(schema[pagetype], null, 2),
          'utf-8',
        );
      }

      // Sort by leaf field count and pick richest + simplest
      const sorted = entries
        .map(e => ({ entry: e, count: countLeafFields(e.content) }))
        .sort((a, b) => b.count - a.count);

      const richest = sorted[0];
      const simplest = sorted[sorted.length - 1];

      await writeFile(
        join(samplesDir, 'richest.json'),
        JSON.stringify(richest.entry, null, 2),
        'utf-8',
      );
      if (simplest !== richest) {
        await writeFile(
          join(samplesDir, 'simplest.json'),
          JSON.stringify(simplest.entry, null, 2),
          'utf-8',
        );
      }
    }

    // Extract global content from landing page
    const landingPage = content.pages.find(p => p.pagetype === 'landing')
      || content.pages[0];
    if (landingPage) {
      for (const key of globalKeys) {
        if (landingPage.content[key]) {
          await writeFile(
            join(outputDir, 'global', `${key}.json`),
            JSON.stringify(landingPage.content[key], null, 2),
            'utf-8',
          );
        }
      }
    }

    return {
      status: 'completed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    };
  },
};

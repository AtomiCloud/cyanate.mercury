/**
 * Phase 1c: SEED (Code — No AI)
 *
 * Write scraped content into Astro content collections and static data files.
 * Deterministic code — no AI involved.
 */

import { readFile, writeFile, mkdir, copyFile, rm } from 'fs/promises';
import { join, basename } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import type { Registry } from '../types.js';

export const seedStep: Step = {
  id: 'seed',
  name: 'Phase 1c: Seed',
  description: 'Write content into Astro content collections and static data',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const reducedDir = join(workingDir, 'output/reduced');
    const siteDir = workingDir; // The Astro project is in workingDir

    let registry: Registry;
    try {
      registry = JSON.parse(await readFile(join(reducedDir, 'registry.json'), 'utf-8'));
    } catch (e) {
      return {
        status: 'failed',
        startedAt: new Date(startTime).toISOString(),
        finishedAt: new Date().toISOString(),
        duration: Date.now() - startTime,
        error: `Cannot read registry.json: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const contentDir = join(siteDir, 'src/content');
    const dataDir = join(siteDir, 'src/data');
    await mkdir(contentDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });

    // Write content collection entries for each collection
    const collectionCounts: Record<string, number> = {};

    for (const [collectionName, collection] of Object.entries(registry.collections)) {
      const collectionDir = join(contentDir, collectionName);
      await mkdir(collectionDir, { recursive: true });

      // Find all content entries matching this collection's source pagetype
      const matchingEntries = ctx.scraperOutput.content.pages.filter(
        p => p.pagetype === collection.source_pagetype,
      );

      let fileCount = 0;
      for (const entry of matchingEntries) {
        // Extract slug from the slug_field
        let slugValue = entry.content[collection.slug_field];
        if (typeof slugValue !== 'string') {
          slugValue = entry.url || entry.id || String(entry.content[collection.slug_field] ?? '');
        }

        // Convert to safe filename
        const filename = slugToFilename(String(slugValue));
        const filePath = join(collectionDir, `${filename}.json`);

        await writeFile(filePath, JSON.stringify(entry.content, null, 2), 'utf-8');
        fileCount++;
      }
      collectionCounts[collectionName] = fileCount;
    }

    // Write static pages
    const staticPageEntries: Array<{ pagetype: string; route: string; content: Record<string, unknown> }> = [];
    for (const sp of registry.static_pages) {
      const entry = ctx.scraperOutput.content.pages.find(
        p => p.pagetype === sp.pagetype && (p.url === sp.route || p.url === sp.route + '/'),
      );
      if (entry) {
        staticPageEntries.push({
          pagetype: sp.pagetype,
          route: sp.route,
          content: entry.content,
        });
      }
    }
    await writeFile(
      join(dataDir, 'static-pages.json'),
      JSON.stringify(staticPageEntries, null, 2),
      'utf-8',
    );

    // Copy global content
    for (const key of ['navigation', 'footer', 'floating_widgets']) {
      try {
        const globalFile = join(reducedDir, 'global', `${key}.json`);
        await copyFile(globalFile, join(dataDir, `${key}.json`));
      } catch { /* global file doesn't exist — skip */ }
    }

    // Remove legacy content config if it exists (Astro v6 uses src/content.config.ts)
    try { await rm(join(contentDir, 'config.ts')); } catch { /* doesn't exist */ }

    // Generate content.config.ts with Astro v6 format
    const configContent = generateContentConfig(registry, ctx.scraperOutput.schema);
    await writeFile(join(siteDir, 'src/content.config.ts'), configContent, 'utf-8');

    // Create content.ts helper library
    const contentHelper = generateContentHelper(registry);
    await writeFile(join(siteDir, 'src/lib/content.ts'), contentHelper, 'utf-8');

    // Validate counts
    const totalCollectionFiles = Object.values(collectionCounts).reduce((a, b) => a + b, 0);
    const expectedTotal = ctx.scraperOutput.content.pages.length;

    if (totalCollectionFiles + staticPageEntries.length !== expectedTotal) {
      // Log warning but don't fail — some pages might not be accounted for
      console.warn(
        `[seed] Page count mismatch: collections=${totalCollectionFiles}, static=${staticPageEntries.length}, total=${expectedTotal}`,
      );
    }

    // Install dependencies (node_modules is skipped during copy-forward)
    // Build validation is deferred to the reviewer gate
    const { execSync } = await import('child_process');

    try {
      execSync('npm install', { cwd: siteDir, timeout: 120000, stdio: 'pipe' });
    } catch (e) {
      return {
        status: 'failed',
        startedAt: new Date(startTime).toISOString(),
        finishedAt: new Date().toISOString(),
        duration: Date.now() - startTime,
        error: `npm install failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    return {
      status: 'completed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    };
  },
};

function slugToFilename(slug: string): string {
  return slug
    .replace(/^https?:\/\//, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    || 'index';
}

function generateContentConfig(registry: Registry, schema: Record<string, unknown>): string {
  let config = `import { defineCollection, z } from 'astro:content';\n`;
  config += `import { glob } from 'astro/loaders';\n\n`;

  const collectionDefs: string[] = [];

  for (const [name] of Object.entries(registry.collections)) {
    // Astro v6: use glob loader for data collections
    collectionDefs.push(
      `  ${name}: defineCollection({
    loader: glob({ pattern: '**/*.json', base: './src/content/${name}' }),
  }),`,
    );
  }

  config += `export const collections = {\n${collectionDefs.join('\n')}\n};\n`;

  return config;
}

function generateContentHelper(registry: Registry): string {
  let helper = `// Content helpers — auto-generated by Phase 1c: Seed\n\n`;
  helper += `import type { GetStaticPaths } from 'astro';\n\n`;

  // Import static pages
  helper += `import staticPages from '../data/static-pages.json';\n`;
  helper += `type StaticPage = typeof staticPages[number];\n\n`;

  helper += `export function getStaticPage(route: string): StaticPage | undefined {\n`;
  helper += `  return staticPages.find(p => p.route === route);\n}\n\n`;

  helper += `export function getAllStaticPages(): StaticPage[] {\n`;
  helper += `  return staticPages;\n}\n\n`;

  // Helper for getting all content entries for a collection
  // Astro uses getCollection('name') with a string argument, not named exports
  helper += `import { getCollection } from 'astro:content';\n\n`;
  for (const [name, collection] of Object.entries(registry.collections)) {
    helper += `// Collection: ${name} (from ${collection.source_pagetype})\n`;
    helper += `export async function get${capitalize(name)}Entries() {\n`;
    helper += `  return await getCollection('${name}');\n`;
    helper += `}\n\n`;
  }

  return helper;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

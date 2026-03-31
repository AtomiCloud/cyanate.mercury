/**
 * Phase 1c: SEED (Code — No AI)
 *
 * Write scraped content into Astro content collections and static data files.
 * Also: rewrite absolute source-site URLs to relative local routes, and
 * download images from the source site to public/images/.
 * Deterministic code — no AI involved.
 */

import { readFile, writeFile, mkdir, copyFile, rm, readdir } from 'fs/promises';
import { join, basename, extname } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import type { Registry } from '../types.js';
import { validateRegistry } from '../lib/validate-boundary.js';

/**
 * Normalize collections from either array or object format to Record<string, CollectionDef>.
 * The classify AI step may output collections as:
 *   - Array: [{name: "doctors", source_pagetype: "doctor_profile", ...}, ...]
 *   - Object: {doctors: {source_pagetype: "doctor_profile", ...}, ...}
 * We always convert to the object format so Object.entries() gives semantic names.
 */
function normalizeCollections(
  collections: Registry['collections'],
): Record<string, { source_pagetype: string; slug_field: string; listable_by: string[]; filterable_by: string; slug_pattern?: string; slug_extract?: number | string; search_fields?: string[] }> {
  if (!collections) return {};
  if (Array.isArray(collections)) {
    const result: Record<string, { source_pagetype: string; slug_field: string; listable_by: string[]; filterable_by: string; slug_pattern?: string; slug_extract?: number | string; search_fields?: string[] }> = {};
    for (const coll of collections) {
      const obj = coll as Record<string, unknown>;
      const name = (obj.name || obj.id) as string;
      if (!name) continue;
      const { name: _n, id: _id, ...rest } = obj;
      result[name] = rest as { source_pagetype: string; slug_field: string; listable_by: string[]; filterable_by: string };
    }
    return result;
  }
  return collections as Record<string, { source_pagetype: string; slug_field: string; listable_by: string[]; filterable_by: string }>;
}

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
      const raw = JSON.parse(await readFile(join(reducedDir, 'registry.json'), 'utf-8'));
      registry = validateRegistry(raw) as unknown as Registry;
    } catch (e) {
      return {
        status: 'failed',
        startedAt: new Date(startTime).toISOString(),
        finishedAt: new Date().toISOString(),
        duration: Date.now() - startTime,
        error: `Cannot read/validate registry.json: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // Use sourceOrigin from pipeline context, falling back to local derivation
    const sourceOrigin = ctx.sourceOrigin || deriveOrigin(
      ((ctx.scraperOutput.structure as unknown) as Record<string, unknown>)?.site_url as string
        || ctx.scraperOutput.structure.pages[0]?.url
        || '',
    );

    const contentDir = join(siteDir, 'src/content');
    const dataDir = join(siteDir, 'src/data');
    const imagesDir = join(siteDir, 'public/images');
    await mkdir(contentDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await mkdir(imagesDir, { recursive: true });

    // ── Phase A: Collect all image URLs from content ──────────────────
    const imageUrls = new Map<string, string>(); // originalUrl → localFilename
    const imageExtensions = /\.(jpe?g|png|gif|webp|svg|avif|ico)(\?.*)?$/i;

    for (const page of ctx.scraperOutput.content.pages) {
      collectImageUrls(page.content, sourceOrigin, imageUrls, imageExtensions);
    }

    // ── Phase B: Download images ─────────────────────────────────────
    let downloadedCount = 0;
    const downloadErrors: string[] = [];

    if (imageUrls.size > 0) {
      console.log(`[seed] Downloading ${imageUrls.size} images from source site...`);
      const results = await downloadImages(imageUrls, imagesDir, 10);
      downloadedCount = results.downloaded;
      downloadErrors.push(...results.errors);
      if (downloadErrors.length > 0) {
        console.warn(`[seed] ${downloadErrors.length} images failed to download (will keep original URLs)`);
      }
      console.log(`[seed] Downloaded ${downloadedCount}/${imageUrls.size} images`);
    }

    // Build the URL rewrite map: source-site URLs → local paths
    const rewriteMap = new Map<string, string>();
    for (const [originalUrl, localFile] of imageUrls) {
      // Only rewrite to local if the file was actually downloaded
      const localPath = join(imagesDir, localFile);
      try {
        const { stat } = await import('fs/promises');
        await stat(localPath);
        rewriteMap.set(originalUrl, `/images/${localFile}`);
      } catch {
        // File doesn't exist (download failed) — don't rewrite
      }
    }

    // ── Normalize collections: classify may output array or object ──
    const normalizedCollections = normalizeCollections(registry.collections);
    (registry as unknown as Record<string, unknown>).collections = normalizedCollections;

    // ── Phase C: Write content collections with rewritten URLs ───────
    const collectionCounts: Record<string, number> = {};

    for (const [collectionName, collection] of Object.entries(normalizedCollections)) {
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
          const fallback = entry.url || entry.id || String(entry.content[collection.slug_field] ?? '');
          console.warn(`[seed] Collection "${collectionName}": slug_field "${collection.slug_field}" is not a string for entry (type: ${typeof slugValue}), falling back to "${String(fallback).slice(0, 60)}"`);
          slugValue = fallback;
        }

        // Convert to safe filename
        const filename = slugToFilename(String(slugValue));
        const filePath = join(collectionDir, `${filename}.json`);

        // Rewrite URLs in content before writing
        const rewrittenContent = rewriteUrls(entry.content, sourceOrigin, rewriteMap) as Record<string, unknown>;
        await writeFile(filePath, JSON.stringify(rewrittenContent, null, 2), 'utf-8');
        fileCount++;
      }
      collectionCounts[collectionName] = fileCount;
    }

    // ── Phase D: Write static pages with rewritten URLs ──────────────
    const staticPageEntries: Array<{ pagetype: string; route: string; content: Record<string, unknown> }> = [];
    for (const sp of registry.static_pages) {
      const entry = ctx.scraperOutput.content.pages.find(
        p => {
          if (p.pagetype !== sp.pagetype) return false;
          try {
            const pagePath = new URL(p.url).pathname.replace(/\/$/, '');
            const routePath = sp.route.replace(/\/$/, '');
            return pagePath === routePath;
          } catch {
            // p.url is already a relative path
            return p.url === sp.route || p.url === sp.route + '/';
          }
        },
      );
      if (entry) {
        staticPageEntries.push({
          pagetype: sp.pagetype,
          route: sp.route,
          content: rewriteUrls(entry.content, sourceOrigin, rewriteMap) as Record<string, unknown>,
        });
      }
    }
    await writeFile(
      join(dataDir, 'static-pages.json'),
      JSON.stringify(staticPageEntries, null, 2),
      'utf-8',
    );

    // ── Phase E: Copy global content with rewritten URLs ─────────────
    for (const key of ['navigation', 'footer', 'floating_widgets']) {
      try {
        const globalFile = join(reducedDir, 'global', `${key}.json`);
        const raw = await readFile(globalFile, 'utf-8');
        const parsed = JSON.parse(raw);
        const rewritten = rewriteUrls(parsed, sourceOrigin, rewriteMap);
        await writeFile(join(dataDir, `${key}.json`), JSON.stringify(rewritten, null, 2), 'utf-8');
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

    // ── Phase F: Post-seed validation — scan for remaining sourceOrigin refs ──
    if (sourceOrigin) {
      const leaks = await scanForSourceOriginLeaks(siteDir, sourceOrigin);
      if (leaks.length > 0) {
        console.warn(`[seed] Found ${leaks.length} remaining source-origin references:`);
        for (const leak of leaks.slice(0, 10)) {
          console.warn(`  ${leak.file}: ${leak.match}`);
        }
        if (leaks.length > 10) {
          console.warn(`  ... and ${leaks.length - 10} more`);
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

// ─── URL Rewriting ─────────────────────────────────────────────────────

/**
 * Derive the origin (scheme + host) from a URL string.
 * Handles both `https://example.com/` and `/path` forms.
 */
function deriveOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin; // e.g. "https://royal-healthcare.com"
  } catch {
    return '';
  }
}

/**
 * Recursively rewrite URLs in a content object.
 * - Source-site page URLs → relative routes (e.g. `/about-us`)
 * - Downloaded image URLs → `/images/filename.ext`
 * - External URLs → left unchanged
 */
function rewriteUrls(
  obj: unknown,
  sourceOrigin: string,
  imageRewrites: Map<string, string>,
): unknown {
  if (typeof obj === 'string') {
    // Check image rewrites first (more specific)
    for (const [originalUrl, localPath] of imageRewrites) {
      if (obj === originalUrl || obj.startsWith(originalUrl + '?') || obj.startsWith(originalUrl + '#')) {
        return localPath;
      }
    }
    // Rewrite source-site page URLs to relative routes
    if (sourceOrigin && obj.startsWith(sourceOrigin)) {
      const path = obj.slice(sourceOrigin.length);
      return normalizeRelativeRoute(path);
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => rewriteUrls(item, sourceOrigin, imageRewrites));
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = rewriteUrls(value, sourceOrigin, imageRewrites);
    }
    return result;
  }
  return obj;
}

/**
 * Normalize a relative route: strip trailing slashes, ensure leading slash.
 * `/about-us/` → `/about-us`
 * `about-us` → `/about-us`
 */
function normalizeRelativeRoute(path: string): string {
  let normalized = path.replace(/\/+/g, '/').replace(/\/$/, '');
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }
  return normalized || '/';
}

// ─── Image Collection & Download ───────────────────────────────────────

const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|svg|avif|ico)$/i;

/**
 * Recursively collect image URLs from a content object.
 * Identifies strings that look like image URLs from the source site.
 */
function collectImageUrls(
  obj: unknown,
  sourceOrigin: string,
  collected: Map<string, string>,
  extensionRegex: RegExp,
): void {
  if (typeof obj === 'string') {
    const isImageUrl = extensionRegex.test(obj);
    const looksLikeImage = !isImageUrl && (
      obj.includes('/wp-content/uploads/') ||
      obj.includes('/images/') ||
      obj.includes('/img/') ||
      obj.includes('/uploads/') ||
      obj.includes('/assets/') ||
      obj.includes('/media/')
    );
    if (isImageUrl || looksLikeImage) {
      // Only collect URLs from the source site
      if (sourceOrigin && obj.startsWith(sourceOrigin)) {
        if (!collected.has(obj)) {
          const filename = imageUrlToLocalFilename(obj);
          collected.set(obj, filename);
        }
      } else if (obj.startsWith('http')) {
        // External image — still try to download for completeness
        if (!collected.has(obj)) {
          const filename = imageUrlToLocalFilename(obj);
          collected.set(obj, filename);
        }
      }
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) collectImageUrls(item, sourceOrigin, collected, extensionRegex);
  } else if (obj !== null && typeof obj === 'object') {
    for (const value of Object.values(obj as Record<string, unknown>)) {
      collectImageUrls(value, sourceOrigin, collected, extensionRegex);
    }
  }
}

/**
 * Convert an image URL to a safe local filename.
 * `https://example.com/wp-content/uploads/2025/10/photo.jpeg` → `photo-2025-10.jpeg`
 */
function imageUrlToLocalFilename(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const lastSegment = segments[segments.length - 1] || 'image';
    // If the filename is generic (like "image.jpeg"), include parent dirs for uniqueness
    if (segments.length > 1 && lastSegment.length < 10) {
      const parent = segments[segments.length - 2] || '';
      const ext = extname(lastSegment);
      const base = basename(lastSegment, ext);
      return `${slugToFilename(parent)}-${base}${ext}`.toLowerCase();
    }
    return slugToFilename(lastSegment.replace(/\.[^.]+$/, '')) + extname(lastSegment).toLowerCase();
  } catch {
    return slugToFilename(url.slice(-40)) + '.jpg';
  }
}

interface DownloadResult {
  downloaded: number;
  errors: string[];
}

/**
 * Download images concurrently with a concurrency limit.
 * Failed downloads are skipped gracefully — the original URL is kept.
 */
async function downloadImages(
  urlMap: Map<string, string>,
  destDir: string,
  concurrency: number,
): Promise<DownloadResult> {
  let downloaded = 0;
  const errors: string[] = [];
  const entries = Array.from(urlMap.entries());

  // Simple semaphore
  let running = 0;
  const queue: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (running < concurrency) {
      running++;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => queue.push(() => { running++; resolve(); }));
  };
  const release = () => {
    running--;
    if (queue.length > 0) queue.shift()!();
  };

  const promises = entries.map(async ([url, filename]) => {
    await acquire();
    try {
      const dest = join(destDir, filename);
      // Skip if already downloaded (e.g., from a previous run)
      try {
        const { stat } = await import('fs/promises');
        const s = await stat(dest);
        if (s.size > 0) {
          downloaded++;
          return;
        }
      } catch { /* file doesn't exist — proceed with download */ }

      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000), // 15s timeout per image
        headers: { 'User-Agent': 'WebGeneratorSDK/2.0' },
      });

      if (!response.ok) {
        errors.push(`${url} → HTTP ${response.status}`);
        return;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/') && !contentType.startsWith('application/octet-stream')) {
        errors.push(`${url} → not an image (${contentType})`);
        return;
      }

      const buffer = await response.arrayBuffer();
      const { writeFile: writeFn } = await import('fs/promises');
      await writeFn(dest, Buffer.from(buffer));
      downloaded++;
    } catch (e) {
      errors.push(`${url} → ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      release();
    }
  });

  await Promise.allSettled(promises);
  return { downloaded, errors };
}

// ─── Filename Helpers ──────────────────────────────────────────────────

function slugToFilename(slug: string): string {
  return slug
    .replace(/^https?:\/\//, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    || 'index';
}

function generateContentConfig(registry: Registry, _schema: Record<string, unknown>): string {
  const normalizedColls = normalizeCollections(registry.collections);
  let config = `import { defineCollection, z } from 'astro:content';\n`;
  config += `import { glob } from 'astro/loaders';\n\n`;

  const collectionDefs: string[] = [];

  for (const [name] of Object.entries(normalizedColls)) {
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
  helper += `  const normalized = route.replace(/\\/\\+$/, '') || '/';\n`;
  helper += `  return staticPages.find(p => {\n`;
  helper += `    const pNorm = p.route.replace(/\\/\\+$/, '') || '/';\n`;
  helper += `    return pNorm === normalized;\n`;
  helper += `  });\n}\n\n`;

  helper += `export function getAllStaticPages(): StaticPage[] {\n`;
  helper += `  return staticPages;\n}\n\n`;

  // Helper for getting all content entries for a collection
  // Astro uses getCollection('name') with a string argument, not named exports
  helper += `import { getCollection } from 'astro:content';\n\n`;
  const normalizedColls = normalizeCollections(registry.collections);
  for (const [name, collection] of Object.entries(normalizedColls)) {
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

// ─── Post-seed Validation ───────────────────────────────────────────────

interface SourceOriginLeak {
  file: string;
  match: string;
}

/**
 * Scan all JSON data files written by the seed step for remaining
 * references to the source site origin. These indicate URLs that
 * rewriteUrls() missed.
 */
async function scanForSourceOriginLeaks(
  siteDir: string,
  sourceOrigin: string,
): Promise<SourceOriginLeak[]> {
  const leaks: SourceOriginLeak[] = [];

  const scanDirs = [
    join(siteDir, 'src/content'),
    join(siteDir, 'src/data'),
  ];

  for (const dir of scanDirs) {
    await scanDirForLeaks(dir, sourceOrigin, leaks);
  }

  return leaks;
}

async function scanDirForLeaks(
  dir: string,
  sourceOrigin: string,
  leaks: SourceOriginLeak[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) return;

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanDirForLeaks(fullPath, sourceOrigin, leaks);
    } else if (entry.name.endsWith('.json')) {
      try {
        const content = await readFile(fullPath, 'utf-8');
        if (content.includes(sourceOrigin)) {
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(sourceOrigin)) {
              const trimmed = lines[i].trim();
              leaks.push({
                file: fullPath.replace(dir + '/', ''),
                match: trimmed.length > 120 ? trimmed.slice(0, 120) + '...' : trimmed,
              });
            }
          }
        }
      } catch { /* can't read file — skip */ }
    }
  }
}

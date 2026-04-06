import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { basename, extname, join } from 'path';
import type { ContentData, Registry, SchemaData, ScraperOutput, ReducedPageContent, BindingsManifest } from '../types.js';

/**
 * Strip external URLs from prev/next page navigation objects in content.
 * Keeps label/title as contextual metadata but removes broken source-site links.
 * The template will derive prev/next from Astro collection ordering instead.
 */
export function neutralizePrevNextLinks(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(neutralizePrevNextLinks);
  if (obj && typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    // Detect a navigation object with previous/next keys
    if ('previous' in record || 'next' in record) {
      // Check if this looks like a prev/next page nav (has url fields pointing to pages)
      const hasPrev = record.previous && typeof record.previous === 'object';
      const hasNext = record.next !== null && record.next !== undefined && typeof record.next === 'object';
      if (hasPrev || hasNext) {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) {
          if (key === 'previous' && value && typeof value === 'object') {
            // Keep label/title, drop url
            const { url: _u, ...meta } = value as Record<string, unknown>;
            result[key] = meta;
          } else if (key === 'next') {
            if (value && typeof value === 'object') {
              const { url: _u, ...meta } = value as Record<string, unknown>;
              result[key] = meta;
            } else {
              // null/undefined next — keep as-is
              result[key] = value;
            }
          } else {
            result[key] = neutralizePrevNextLinks(value);
          }
        }
        return result;
      }
    }
    // Recurse into nested objects
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      result[key] = neutralizePrevNextLinks(value);
    }
    return result;
  }
  return obj;
}

export function normalizeCollections(
  collections: Registry['collections'],
): Record<string, { source_pagetype: string; slug_field: string; listable_by: string[]; filterable_by: string; slug_pattern?: string; slug_extract?: number | string; search_fields?: string[]; ordered?: boolean }> {
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

export function deriveOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function normalizeRelativeRoute(path: string): string {
  let normalized = path.replace(/\/+/g, '/').replace(/\/$/, '');
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  return normalized || '/';
}

export function rewriteUrls(
  obj: unknown,
  sourceOrigin: string,
  imageRewrites: Map<string, string>,
): unknown {
  if (typeof obj === 'string') {
    for (const [originalUrl, localPath] of imageRewrites) {
      if (obj === originalUrl || obj.startsWith(`${originalUrl}?`) || obj.startsWith(`${originalUrl}#`)) {
        return localPath;
      }
    }
    if (sourceOrigin && obj.startsWith(sourceOrigin)) {
      return normalizeRelativeRoute(obj.slice(sourceOrigin.length));
    }
    if (obj.startsWith('/') && !obj.startsWith('/images/') && !obj.startsWith('/assets/') && !obj.startsWith('/favicon.')) {
      return normalizeRelativeRoute(obj);
    }
    if (obj.startsWith('#') && obj !== '#' && obj !== '#top') {
      const anchor = obj.slice(1);
      if (/popup|modal|dialog|overlay|offcanvas|collapse|accordion|dropdown|elementor-action/i.test(anchor)) {
        return '#';
      }
    }
    return obj;
  }
  if (Array.isArray(obj)) return obj.map((item) => rewriteUrls(item, sourceOrigin, imageRewrites));
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = rewriteUrls(value, sourceOrigin, imageRewrites);
    }
    return result;
  }
  return obj;
}

export function slugToFilename(slug: string): string {
  return slug
    .replace(/^https?:\/\//, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    || 'index';
}

function deriveSlugFromUrl(url: string, slugExtract?: number | string): string {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 0) return 'index';
    if (typeof slugExtract === 'number' && segments[slugExtract]) {
      return segments[slugExtract];
    }
    if (typeof slugExtract === 'string' && slugExtract !== 'last_path_segment') {
      const parsed = Number(slugExtract);
      if (!Number.isNaN(parsed) && segments[parsed]) {
        return segments[parsed];
      }
    }
    return segments[segments.length - 1] || 'index';
  } catch {
    return slugToFilename(url);
  }
}

function getCollectionEntrySlug(
  entry: ScraperOutput['content']['pages'][number],
  collection: { slug_field: string; slug_extract?: number | string },
): string {
  if (collection.slug_field === 'url') {
    return deriveSlugFromUrl(entry.url, collection.slug_extract);
  }

  const slugValue = entry.content[collection.slug_field];
  if (typeof slugValue === 'string' && slugValue.trim() !== '') {
    return slugValue;
  }

  return entry.url || entry.id || String(slugValue ?? 'index');
}

export function imageUrlToLocalFilename(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const lastSegment = segments[segments.length - 1] || 'image';
    if (segments.length > 1 && lastSegment.length < 10) {
      const parent = segments[segments.length - 2] || '';
      const ext = extname(lastSegment);
      const base = basename(lastSegment, ext);
      return `${slugToFilename(parent)}-${base}${ext}`.toLowerCase();
    }
    return slugToFilename(lastSegment.replace(/\.[^.]+$/, '')) + extname(lastSegment).toLowerCase();
  } catch {
    return `${slugToFilename(url.slice(-40))}.jpg`;
  }
}

export function collectImageUrls(
  obj: unknown,
  sourceOrigin: string,
  collected: Map<string, string>,
  extensionRegex: RegExp,
): void {
  if (typeof obj === 'string') {
    const isImageUrl = extensionRegex.test(obj);
    const looksLikeImage = !isImageUrl && (
      obj.includes('/wp-content/uploads/')
      || obj.includes('/images/')
      || obj.includes('/img/')
      || obj.includes('/uploads/')
      || obj.includes('/assets/')
      || obj.includes('/media/')
    );
    if (isImageUrl || looksLikeImage) {
      if (sourceOrigin && obj.startsWith(sourceOrigin)) {
        if (!collected.has(obj)) collected.set(obj, imageUrlToLocalFilename(obj));
      } else if (obj.startsWith('http')) {
        if (!collected.has(obj)) collected.set(obj, imageUrlToLocalFilename(obj));
      }
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) collectImageUrls(item, sourceOrigin, collected, extensionRegex);
    return;
  }
  if (obj && typeof obj === 'object') {
    for (const value of Object.values(obj as Record<string, unknown>)) {
      collectImageUrls(value, sourceOrigin, collected, extensionRegex);
    }
  }
}

export interface DownloadResult {
  downloaded: number;
  errors: string[];
}

export async function downloadImages(
  urlMap: Map<string, string>,
  destDir: string,
  concurrency: number,
): Promise<DownloadResult> {
  let downloaded = 0;
  const errors: string[] = [];
  const entries = Array.from(urlMap.entries());

  let running = 0;
  const queue: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (running < concurrency) {
      running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => queue.push(() => { running++; resolve(); }));
  };
  const release = () => {
    running--;
    if (queue.length > 0) queue.shift()!();
  };

  const promises = entries.map(async ([url, filename]) => {
    await acquire();
    try {
      const dest = join(destDir, filename);
      try {
        const info = await stat(dest);
        if (info.size > 0) {
          downloaded++;
          return;
        }
      } catch {
        // missing
      }

      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
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
      await writeFile(dest, Buffer.from(buffer));
      downloaded++;
    } catch (error) {
      errors.push(`${url} → ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      release();
    }
  });

  await Promise.allSettled(promises);
  return { downloaded, errors };
}

export function generateContentConfig(registry: Registry, _schema: SchemaData): string {
  const normalizedColls = normalizeCollections(registry.collections);
  let config = `import { defineCollection } from 'astro:content';\n`;
  config += `import { glob } from 'astro/loaders';\n\n`;

  const collectionDefs: string[] = [];
  for (const [name] of Object.entries(normalizedColls)) {
    collectionDefs.push(`  ${name}: defineCollection({\n    loader: glob({ pattern: '**/*.json', base: './src/content/${name}' }),\n  }),`);
  }

  config += `export const collections = {\n${collectionDefs.join('\n')}\n};\n`;
  return config;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function generateContentHelper(registry: Registry): string {
  let helper = `// Content helpers — auto-generated by seed steps\n\n`;
  helper += `import staticPages from '../data/static-pages.json';\n`;
  helper += `import { getCollection } from 'astro:content';\n\n`;

  // Try to import dynamic bindings (may not exist if content-reduction didn't run)
  helper += `let dynamicBindings: Record<string, unknown[]> = {};\n`;
  helper += `try {\n`;
  helper += `  const mod = await import('../data/dynamic-bindings.json');\n`;
  helper += `  dynamicBindings = (mod.default as { pages: Record<string, unknown[]> }).pages || {};\n`;
  helper += `} catch { /* no dynamic bindings */ }\n\n`;

  helper += `type StaticPage = typeof staticPages[number];\n\n`;
  helper += `export function getStaticPage(route: string): StaticPage | undefined {\n`;
  helper += `  const normalized = route.replace(/\\/\\+$/, '') || '/';\n`;
  helper += `  return staticPages.find((page) => (page.route.replace(/\\/\\+$/, '') || '/') === normalized);\n`;
  helper += `}\n\n`;
  helper += `export function getAllStaticPages(): StaticPage[] {\n  return staticPages;\n}\n\n`;

  helper += `export function getDynamicBindings(pagetype: string, slug?: string): unknown[] {\n`;
  helper += `  const key = slug ? \`\${pagetype}/\${slug}\` : pagetype;\n`;
  helper += `  return dynamicBindings[key] || [];\n`;
  helper += `}\n\n`;

  const normalizedColls = normalizeCollections(registry.collections);
  for (const [name, collection] of Object.entries(normalizedColls)) {
    helper += `// Collection: ${name} (from ${collection.source_pagetype})\n`;
    helper += `export async function get${capitalize(name)}Entries() {\n`;
    helper += `  return await getCollection('${name}');\n`;
    helper += `}\n\n`;
  }

  // Add prev/next helper for ordered collections
  const orderedColls = Object.entries(normalizedColls).filter(([_, c]) => c.ordered);
  if (orderedColls.length > 0) {
    helper += `// Prev/next navigation helpers for ordered collections\n`;
    helper += `export async function getAdjacentEntries(collectionName: string, currentId: string) {\n`;
    helper += `  const entries = await getCollection(collectionName);\n`;
    helper += `  const idx = entries.findIndex((e: { id: string }) => e.id === currentId);\n`;
    helper += `  return {\n`;
    helper += `    prev: idx > 0 ? entries[idx - 1] : null,\n`;
    helper += `    next: idx < entries.length - 1 ? entries[idx + 1] : null,\n`;
    helper += `  };\n`;
    helper += `}\n\n`;
  }

  return helper;
}

export interface SourceOriginLeak {
  file: string;
  match: string;
}

export async function scanDirForLeaks(
  dir: string,
  sourceOrigin: string,
  leaks: SourceOriginLeak[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanDirForLeaks(fullPath, sourceOrigin, leaks);
    } else if (entry.name.endsWith('.json')) {
      try {
        const content = await readFile(fullPath, 'utf-8');
        if (!content.includes(sourceOrigin)) continue;
        for (const line of content.split('\n')) {
          if (!line.includes(sourceOrigin)) continue;
          const trimmed = line.trim();
          leaks.push({
            file: fullPath.replace(`${dir}/`, ''),
            match: trimmed.length > 120 ? `${trimmed.slice(0, 120)}...` : trimmed,
          });
        }
      } catch {
        // ignore
      }
    }
  }
}

export async function scanForSourceOriginLeaks(siteDir: string, sourceOrigin: string): Promise<SourceOriginLeak[]> {
  const leaks: SourceOriginLeak[] = [];
  for (const dir of [join(siteDir, 'src/content'), join(siteDir, 'src/data')]) {
    await scanDirForLeaks(dir, sourceOrigin, leaks);
  }
  return leaks;
}

export async function walkJsonFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      results.push(...await walkJsonFiles(full));
    } else if (entry.name.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

export async function clearLegacyContentConfig(contentDir: string): Promise<void> {
  try {
    await rm(join(contentDir, 'config.ts'));
  } catch {
    // ignore
  }
}

/**
 * Load reduced content from content-reduction step output.
 * Returns a Map keyed by "{pagetype}/{slug}" to ReducedPageContent.
 */
export async function loadReducedContent(reducedDir: string): Promise<Map<string, ReducedPageContent> | null> {
  const contentReducedDir = join(reducedDir, 'content-reduced');
  try {
    const files = await readdir(contentReducedDir);
    const jsonFiles = files.filter(f => f.endsWith('.json') && f !== 'bindings-manifest.json');
    if (jsonFiles.length === 0) return null;

    const map = new Map<string, ReducedPageContent>();
    for (const file of jsonFiles) {
      const content: ReducedPageContent = JSON.parse(await readFile(join(contentReducedDir, file), 'utf-8'));
      map.set(`${content.pagetype}/${content.slug}`, content);
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * Write dynamic bindings manifest to src/data/dynamic-bindings.json
 */
export async function writeDynamicBindings(siteDir: string, reducedDir: string): Promise<void> {
  const manifestPath = join(reducedDir, 'content-reduced', 'bindings-manifest.json');
  try {
    const manifest = await readFile(manifestPath, 'utf-8');
    const dataDir = join(siteDir, 'src/data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'dynamic-bindings.json'), manifest, 'utf-8');
  } catch {
    // No manifest — content reduction step may not have run
  }
}

export interface SeedContentResult {
  collectionCounts: Record<string, number>;
  staticPageEntries: Array<{ pagetype: string; route: string; content: Record<string, unknown> }>;
  rewriteMap: Map<string, string>;
  sourceOrigin: string;
}

export async function seedContentArtifacts(opts: {
  siteDir: string;
  reducedDir: string;
  registry: Registry;
  scraperOutput: ScraperOutput;
  sourceOrigin: string;
  rewriteMap?: Map<string, string>;
}): Promise<SeedContentResult> {
  const { siteDir, reducedDir, registry, scraperOutput, sourceOrigin } = opts;
  const rewriteMap = opts.rewriteMap || new Map<string, string>();
  const normalizedCollections = normalizeCollections(registry.collections);
  (registry as unknown as Record<string, unknown>).collections = normalizedCollections;

  const contentDir = join(siteDir, 'src/content');
  const dataDir = join(siteDir, 'src/data');
  await mkdir(contentDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  // Try to load reduced content from content-reduction step
  const reducedContent = await loadReducedContent(reducedDir);

  const collectionCounts: Record<string, number> = {};
  for (const [collectionName, collection] of Object.entries(normalizedCollections)) {
    const collectionDir = join(contentDir, collectionName);
    await mkdir(collectionDir, { recursive: true });

    const matchingEntries = scraperOutput.content.pages.filter((page) => page.pagetype === collection.source_pagetype);
    let fileCount = 0;
    for (const entry of matchingEntries) {
      const filename = slugToFilename(getCollectionEntrySlug(entry, collection));

      // Use reduced content if available, otherwise fall back to raw + neutralize
      const reducedKey = `${entry.pagetype}/${filename}`;
      const reduced = reducedContent?.get(reducedKey);
      let contentToWrite: Record<string, unknown>;
      if (reduced) {
        contentToWrite = rewriteUrls(reduced.static_content, sourceOrigin, rewriteMap) as Record<string, unknown>;
      } else {
        const rewrittenContent = rewriteUrls(entry.content, sourceOrigin, rewriteMap) as Record<string, unknown>;
        contentToWrite = neutralizePrevNextLinks(rewrittenContent) as Record<string, unknown>;
      }
      await writeFile(join(collectionDir, `${filename}.json`), JSON.stringify(contentToWrite, null, 2), 'utf-8');
      fileCount++;
    }
    collectionCounts[collectionName] = fileCount;
  }

  const staticPageEntries: Array<{ pagetype: string; route: string; content: Record<string, unknown> }> = [];
  for (const staticPage of registry.static_pages) {
    const entry = scraperOutput.content.pages.find((page) => {
      if (page.pagetype !== staticPage.pagetype) return false;
      try {
        const pagePath = new URL(page.url).pathname.replace(/\/$/, '');
        const routePath = staticPage.route.replace(/\/$/, '');
        return pagePath === routePath;
      } catch {
        return page.url === staticPage.route || page.url === `${staticPage.route}/`;
      }
    });
    if (!entry) continue;

    // Use reduced content if available
    const slug = staticPage.route.replace(/^\/|\/$/g, '') || 'index';
    const reducedKey = `${staticPage.pagetype}/${slug}`;
    const reduced = reducedContent?.get(reducedKey);
    const content = reduced
      ? rewriteUrls(reduced.static_content, sourceOrigin, rewriteMap) as Record<string, unknown>
      : neutralizePrevNextLinks(rewriteUrls(entry.content, sourceOrigin, rewriteMap)) as Record<string, unknown>;

    staticPageEntries.push({
      pagetype: staticPage.pagetype,
      route: staticPage.route,
      content,
    });
  }

  await writeFile(join(dataDir, 'static-pages.json'), JSON.stringify(staticPageEntries, null, 2), 'utf-8');

  for (const key of ['navigation', 'footer', 'floating_widgets']) {
    try {
      const raw = await readFile(join(reducedDir, 'global', `${key}.json`), 'utf-8');
      const parsed = JSON.parse(raw);
      const rewritten = rewriteUrls(parsed, sourceOrigin, rewriteMap);
      await writeFile(join(dataDir, `${key}.json`), JSON.stringify(rewritten, null, 2), 'utf-8');
    } catch {
      // ignore missing globals
    }
  }

  await clearLegacyContentConfig(contentDir);
  await writeFile(join(siteDir, 'src/content.config.ts'), generateContentConfig(registry, scraperOutput.schema), 'utf-8');
  await writeFile(join(siteDir, 'src/lib/content.ts'), generateContentHelper(registry), 'utf-8');

  return { collectionCounts, staticPageEntries, rewriteMap, sourceOrigin };
}

export async function buildImageRewriteMap(opts: {
  siteDir: string;
  scraperContent: ContentData;
  sourceOrigin: string;
}): Promise<{ imageUrls: Map<string, string>; rewriteMap: Map<string, string>; errors: string[]; downloadedCount: number }> {
  const imagesDir = join(opts.siteDir, 'public/images');
  await mkdir(imagesDir, { recursive: true });

  const imageUrls = new Map<string, string>();
  const imageExtensions = /\.(jpe?g|png|gif|webp|svg|avif|ico)(\?.*)?$/i;
  for (const page of opts.scraperContent.pages) {
    collectImageUrls(page.content, opts.sourceOrigin, imageUrls, imageExtensions);
  }

  const results = imageUrls.size > 0 ? await downloadImages(imageUrls, imagesDir, 10) : { downloaded: 0, errors: [] };
  const rewriteMap = new Map<string, string>();
  for (const [originalUrl, localFile] of imageUrls) {
    try {
      await stat(join(imagesDir, localFile));
      rewriteMap.set(originalUrl, `/images/${localFile}`);
    } catch {
      // ignore missing downloads
    }
  }

  await writeFile(join(opts.siteDir, 'asset-manifest.json'), JSON.stringify({
    downloaded: Array.from(rewriteMap.values()),
    missing: Array.from(imageUrls.keys()).filter((url) => !rewriteMap.has(url)),
  }, null, 2), 'utf-8');

  return { imageUrls, rewriteMap, errors: results.errors, downloadedCount: results.downloaded };
}

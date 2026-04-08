/**
 * Static invariant checker for the v2 pipeline.
 *
 * Runs regex-based checks against .astro source files and data JSON.
 * No build step needed — runs in milliseconds.
 * Used by the `invariant-check` programmatic reviewer.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, extname, relative } from 'path';
import type { Registry } from '../types.js';

// --- Types ---

export interface InvariantError {
  file: string;
  line?: number;
  check: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface InvariantResult {
  passed: boolean;
  errors: InvariantError[];
  warnings: InvariantError[];
  duration: number;
  summary: string;
}

export interface InvariantOptions {
  /** Source directory of the Astro project (e.g., step-4-seed/template-astro-project/) */
  srcDir: string;
  /** Origin URL of the original site (e.g., "https://royal-healthcare.com") */
  sourceOrigin?: string;
  /** Previous step's page count (for regression check) */
  previousPageCount?: number;
  /** Phase ID running these checks */
  phaseId?: string;
  /** Only run these checks (by name) */
  onlyChecks?: string[];
}

// --- Helpers ---

async function walkFiles(dir: string, exts: string[]): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      results.push(...await walkFiles(fullPath, exts));
    } else if (exts.includes(extname(entry.name))) {
      results.push(fullPath);
    }
  }
  return results;
}

function readFileLines(filePath: string): Promise<string[]> {
  return readFile(filePath, 'utf-8').then(c => c.split('\n'));
}

/** Extract all href values from HTML/astro source */
function extractHrefs(content: string): Array<{ href: string; line: number }> {
  const results: Array<{ href: string; line: number }> = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // Match href="..." or href='...'
    const re = /href=["']([^"']+)["']/g;
    let match;
    while ((match = re.exec(lines[i])) !== null) {
      results.push({ href: match[1], line: i + 1 });
    }
  }
  return results;
}

/** Extract all id attributes from HTML/astro source */
function extractIds(content: string): Set<string> {
  const ids = new Set<string>();
  const re = /id=["']([^"']+)["']/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    ids.add(match[1]);
  }
  return ids;
}

/** Extract all src values from HTML/astro source */
function extractSrcs(content: string): Array<{ src: string; line: number }> {
  const results: Array<{ src: string; line: number }> = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const re = /src=["']([^"']+)["']/g;
    let match;
    while ((match = re.exec(lines[i])) !== null) {
      results.push({ src: match[1], line: i + 1 });
    }
  }
  return results;
}

/** Build a set of known routes from the Astro project structure and seeded registry/content */
async function buildKnownRoutes(srcDir: string): Promise<{ routes: Set<string>; dynamicPatterns: RegExp[] }> {
  const routes = new Set<string>();
  const dynamicPatterns: RegExp[] = [];
  const pagesDir = join(srcDir, 'src', 'pages');

  const addRoute = (route: string | undefined) => {
    if (!route) return;
    const normalized = route === '/' ? '/' : route.replace(/\/+$/, '') || '/';
    routes.add(normalized);
    if (normalized !== '/') routes.add(`${normalized}/`);
  };

  try {
    const pageFiles = await walkFiles(pagesDir, ['.astro', '.md', '.mdx']);
    for (const file of pageFiles) {
      const relPath = relative(pagesDir, file);
      const ext = extname(relPath);
      let route = '/' + relPath.slice(0, -(ext.length));

      // Dynamic routes: [slug] → build regex pattern + derive concrete routes from content/registry
      if (route.includes('[') && route.includes(']')) {
        // Convert /doctor-category/[specialty]/index → /doctor-category/[^/]+
        let pattern = route.replace(/\/index$/, '');
        pattern = pattern.replace(/\[\.{3}\w+\]/g, '.+'); // [...slug] → .+
        pattern = pattern.replace(/\[\w+\]/g, '[^/]+'); // [slug] → [^/]+
        dynamicPatterns.push(new RegExp(`^${pattern}$`));
        continue;
      }

      if (route.endsWith('/index')) {
        route = route.slice(0, -('/index'.length)) || '/';
      }

      addRoute(route);
    }
  } catch {
    // pages dir might not exist yet
  }

  try {
    const registry = JSON.parse(await readFile(join(srcDir, 'output/reduced/registry.json'), 'utf-8')) as Registry;

    for (const staticPage of registry.static_pages || []) {
      addRoute(staticPage.route);
    }

    for (const listing of Object.values(registry.listings || {})) {
      if (!listing.route.includes('[') && !listing.route.includes(':')) {
        addRoute(listing.route);
      }
    }
  } catch {
    // registry might not exist yet
  }

  try {
    const staticPages = JSON.parse(await readFile(join(srcDir, 'src/data/static-pages.json'), 'utf-8')) as Array<{ route?: string }>;
    for (const page of staticPages) {
      addRoute(page.route);
    }
  } catch {
    // static pages data might not exist yet
  }

  try {
    const contentDir = join(srcDir, 'src', 'content');
    const collections = await readdir(contentDir, { withFileTypes: true });
    for (const entry of collections) {
      if (!entry.isDirectory()) continue;
      const collectionDir = join(contentDir, entry.name);
      const files = await readdir(collectionDir, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        const slug = file.name.replace(/\.json$/, '');
        const routes = entry.name === 'blog_posts'
          ? [`/blog/${slug}`]
          : entry.name === 'doctors'
            ? [`/doctors/${slug}`, `/doctor/${slug}`]  // accept both singular and plural
            : entry.name === 'legal_pages'
              ? [`/legal/${slug}`]
              : entry.name === 'pages'
                ? [`/${slug}`]
                : [`/${entry.name}/${slug}`];
        for (const r of routes) addRoute(r);
      }
    }
  } catch {
    // content collections might not exist yet
  }

  return { routes, dynamicPatterns };
}

/** Read JSON data files and extract href values */
async function readDataHrefs(srcDir: string): Promise<Array<{ file: string; href: string }>> {
  const results: Array<{ file: string; href: string }> = [];
  const dataDir = join(srcDir, 'src', 'data');

  try {
    const files = await walkFiles(dataDir, ['.json']);
    for (const file of files) {
      try {
        const content = await readFile(file, 'utf-8');
        const json = JSON.parse(content);
        extractJsonHrefs(json, relative(srcDir, file), results);
      } catch {
        // skip unparseable files
      }
    }
  } catch {
    // data dir might not exist
  }

  return results;
}

function extractJsonHrefs(obj: unknown, file: string, results: Array<{ file: string; href: string }>): void {
  if (typeof obj === 'string') {
    // Check if it looks like a navigational URL/path; ignore obvious asset paths.
    if ((obj.startsWith('/') || obj.startsWith('http') || obj.startsWith('#')) && !isAssetPath(obj)) {
      results.push({ file, href: obj });
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) extractJsonHrefs(item, file, results);
  } else if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      extractJsonHrefs(val, file, results);
    }
  }
}

// --- Individual checks ---

function isAssetPath(path: string): boolean {
  const cleanPath = path.split('?')[0].split('#')[0].toLowerCase();
  return cleanPath.startsWith('/images/')
    || cleanPath.startsWith('/assets/')
    || cleanPath.startsWith('/favicon.')
    || /\.(png|jpe?g|gif|webp|svg|avif|ico|css|js|map|woff2?|ttf|otf|mp4|webm|pdf)$/i.test(cleanPath);
}

function isKnownInternalRoute(href: string, knownRoutes: Set<string>, dynamicPatterns?: RegExp[]): boolean {
  const cleanPath = href.split('?')[0].split('#')[0];
  const withSlash = cleanPath.endsWith('/') ? cleanPath : cleanPath + '/';
  const withoutSlash = cleanPath.endsWith('/') ? cleanPath.slice(0, -1) : cleanPath;
  if (knownRoutes.has(cleanPath) || knownRoutes.has(withSlash) || knownRoutes.has(withoutSlash)) return true;
  // Check against dynamic route patterns (e.g. /doctor-category/[specialty]/ matches /doctor-category/all-doctors/)
  if (dynamicPatterns) {
    for (const pattern of dynamicPatterns) {
      if (pattern.test(withoutSlash) || pattern.test(withSlash)) return true;
    }
  }
  return false;
}

async function checkBrokenInternalLinksInData(srcDir: string): Promise<InvariantError[]> {
  const errors: InvariantError[] = [];
  const { routes: knownRoutes, dynamicPatterns } = await buildKnownRoutes(srcDir);
  const dataHrefs = await readDataHrefs(srcDir);

  for (const { file, href } of dataHrefs) {
    if (href.startsWith('http') || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    if (isAssetPath(href)) continue;
    if (href === '/' || href === '') continue;
    if (isKnownInternalRoute(href, knownRoutes, dynamicPatterns)) continue;
    // Fallback: try with /blog/ prefix (data sometimes omits it for blog post slugs)
    if (isKnownInternalRoute(`/blog${href}`, knownRoutes, dynamicPatterns)) continue;

    errors.push({
      file,
      check: 'broken-internal-links-data',
      message: `Link "${href}" does not match any known route`,
      severity: 'error',
    });
  }

  return errors;
}

async function checkBrokenInternalLinksInAstro(srcDir: string): Promise<InvariantError[]> {
  const errors: InvariantError[] = [];
  const { routes: knownRoutes, dynamicPatterns } = await buildKnownRoutes(srcDir);
  const astroFiles = await walkFiles(join(srcDir, 'src'), ['.astro']);

  for (const file of astroFiles) {
    const content = await readFile(file, 'utf-8');
    const hrefs = extractHrefs(content);
    const relFile = relative(srcDir, file);

    for (const { href, line } of hrefs) {
      if (href.startsWith('http') || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
      if (isAssetPath(href)) continue;
      if (href === '/' || href === '' || href.startsWith('{')) continue;

      const cleanPath = href.split('?')[0].split('#')[0];
      if (cleanPath.includes('[')) continue;
      if (isKnownInternalRoute(href, knownRoutes, dynamicPatterns)) continue;

      errors.push({
        file: relFile,
        line,
        check: 'broken-internal-links-astro',
        message: `Link "${href}" does not match any known route`,
        severity: 'error',
      });
    }
  }

  return errors;
}

async function checkDeadHashLinks(srcDir: string): Promise<InvariantError[]> {
  const errors: InvariantError[] = [];
  const astroFiles = await walkFiles(join(srcDir, 'src'), ['.astro']);
  const projectIds = new Set<string>();

  for (const file of astroFiles) {
    const content = await readFile(file, 'utf-8');
    for (const id of extractIds(content)) {
      projectIds.add(id);
      try {
        projectIds.add(decodeURIComponent(id));
      } catch {
        // ignore malformed URI sequences
      }
    }
  }

  for (const file of astroFiles) {
    const content = await readFile(file, 'utf-8');
    const relFile = relative(srcDir, file);
    const hrefs = extractHrefs(content);
    const ids = extractIds(content);

    for (const { href, line } of hrefs) {
      if (!href.startsWith('#') || href === '#' || href === '#top') continue;

      const targetId = href.slice(1);
      let decodedId = targetId;
      try {
        decodedId = decodeURIComponent(targetId);
      } catch {
        decodedId = targetId;
      }

      if (!ids.has(targetId) && !ids.has(decodedId) && !projectIds.has(targetId) && !projectIds.has(decodedId)) {
        errors.push({
          file: relFile,
          line,
          check: 'dead-hash-links',
          message: `Hash link "${href}" — no element with id="${targetId}" found in the project`,
          severity: 'error',
        });
      }
    }
  }

  return errors;
}

async function checkEmptyPages(srcDir: string): Promise<InvariantError[]> {
  const errors: InvariantError[] = [];
  const pagesDir = join(srcDir, 'src', 'pages');

  try {
    const astroFiles = await walkFiles(pagesDir, ['.astro']);

    for (const file of astroFiles) {
      const content = await readFile(file, 'utf-8');
      const relFile = relative(srcDir, file);

      // Skip dynamic routes — they need content collections to render
      if (relFile.includes('[') && relFile.includes(']')) continue;

      // Skip redirect-only pages
      if (content.includes('Astro.redirect') || content.includes('return redirect')) continue;

      // Check if the page has actual content rendering between the frontmatter and closing tag
      // Look for <main>, slot, or actual rendered content
      const hasMainContent = /<main[\s>]/.test(content) || /slot\s*\/?>/.test(content);
      const hasContentExpression = /\{[^}]*(entry|page|data|content|props|children|Astro)[^}]*\}/i.test(content);

      if (!hasMainContent && !hasContentExpression) {
        // Check if it's a page that just imports a layout (legitimate)
        const hasLayoutImport = /import.*Layout/.test(content);
        if (!hasLayoutImport) {
          errors.push({
            file: relFile,
            check: 'empty-pages',
            message: `Page has no main content area, no slot, and no layout import`,
            severity: 'warning',
          });
        }
      }
    }
  } catch {
    // pages dir might not exist yet
  }

  return errors;
}

async function checkSourceOriginLeakage(srcDir: string, sourceOrigin?: string): Promise<InvariantError[]> {
  if (!sourceOrigin) return [];

  const errors: InvariantError[] = [];
  const allFiles = await walkFiles(join(srcDir, 'src'), ['.astro', '.json', '.ts', '.tsx', '.css']);

  for (const file of allFiles) {
    const content = await readFile(file, 'utf-8');
    const relFile = relative(srcDir, file);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(sourceOrigin)) {
        // Skip comments
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('<!--')) continue;

        errors.push({
          file: relFile,
          line: i + 1,
          check: 'source-origin-leakage',
          message: `Contains source origin "${sourceOrigin}" — should have been rewritten to a local path`,
          severity: 'error',
        });
      }
    }
  }

  return errors;
}

async function checkBrokenImages(srcDir: string): Promise<InvariantError[]> {
  const errors: InvariantError[] = [];
  const astroFiles = await walkFiles(join(srcDir, 'src'), ['.astro']);

  for (const file of astroFiles) {
    const content = await readFile(file, 'utf-8');
    const relFile = relative(srcDir, file);
    const srcs = extractSrcs(content);

    for (const { src, line } of srcs) {
      // Skip external URLs, dynamic expressions, data URIs
      if (src.startsWith('http') || src.startsWith('{') || src.startsWith('data:')) continue;

      // Check local images
      if (src.startsWith('/images/') || src.startsWith('/assets/')) {
        const imagePath = join(srcDir, 'public', src);
        try {
          const s = await stat(imagePath);
          if (!s.isFile()) {
            errors.push({
              file: relFile,
              line,
              check: 'broken-images',
              message: `Image path "${src}" exists but is not a file`,
              severity: 'error',
            });
          }
        } catch {
          errors.push({
            file: relFile,
            line,
            check: 'broken-images',
            message: `Image "${src}" not found in public/`,
            severity: 'warning',
          });
        }
      }
    }
  }

  return errors;
}

async function checkInteractiveElements(srcDir: string): Promise<InvariantError[]> {
  const errors: InvariantError[] = [];
  const astroFiles = await walkFiles(join(srcDir, 'src'), ['.astro']);

  for (const file of astroFiles) {
    const content = await readFile(file, 'utf-8');
    const relFile = relative(srcDir, file);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check <button> without accessible text
      const buttonMatches = [...line.matchAll(/<button[^>]*>/g)];
      for (const match of buttonMatches) {
        const tag = match[0];
        // Skip self-closing, or buttons with aria-label or title
        if (tag.includes('aria-label=') || tag.includes('title=')) continue;

        // Check if next content is text (rough heuristic)
        const afterTag = line.slice(match.index! + tag.length);
        const nextContent = afterTag.trim();
        if (nextContent === '' || nextContent.startsWith('<')) {
          errors.push({
            file: relFile,
            line: i + 1,
            check: 'interactive-elements',
            message: `Button has no visible text or aria-label`,
            severity: 'warning',
          });
        }
      }

      // Check <a> without href
      const anchorMatches = [...line.matchAll(/<a[^>]*>/g)];
      for (const match of anchorMatches) {
        const tag = match[0];
        if (!tag.includes('href=') && !tag.includes('href =')) {
          errors.push({
            file: relFile,
            line: i + 1,
            check: 'interactive-elements',
            message: `Anchor tag has no href attribute`,
            severity: 'warning',
          });
        }
      }
    }
  }

  return errors;
}

async function checkPageCount(srcDir: string, previousPageCount?: number): Promise<InvariantError[]> {
  if (previousPageCount === undefined) return [];

  const errors: InvariantError[] = [];
  const pagesDir = join(srcDir, 'src', 'pages');

  try {
    const pageFiles = await walkFiles(pagesDir, ['.astro', '.md', '.mdx']);
    const currentCount = pageFiles.length;

    if (currentCount < previousPageCount) {
      errors.push({
        file: 'src/pages/',
        check: 'page-count',
        message: `Page count decreased from ${previousPageCount} to ${currentCount}`,
        severity: 'error',
      });
    }
  } catch {
    // pages dir might not exist
  }

  return errors;
}

async function checkContentCollectionCompleteness(srcDir: string): Promise<InvariantError[]> {
  const errors: InvariantError[] = [];
  const contentDir = join(srcDir, 'src', 'content');

  try {
    const collections = await readdir(contentDir, { withFileTypes: true });
    for (const entry of collections) {
      if (!entry.isDirectory()) continue;
      const collectionDir = join(contentDir, entry.name);
      const files = await readdir(collectionDir, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        try {
          const raw = await readFile(join(collectionDir, file.name), 'utf-8');
          const data = JSON.parse(raw);
          if (typeof data !== 'object' || data === null || Array.isArray(data)) continue;

          let substantiveCount = 0;
          for (const val of Object.values(data as Record<string, unknown>)) {
            if (typeof val === 'string' && val.length > 20) {
              substantiveCount++;
            } else if (Array.isArray(val) && val.length > 0) {
              substantiveCount++;
            } else if (val && typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length > 1) {
              substantiveCount++;
            }
          }

          if (substantiveCount < 2) {
            errors.push({
              file: relative(srcDir, join(collectionDir, file.name)),
              check: 'content-collection-completeness',
              message: `Content collection entry "${file.name}" is a stub (${substantiveCount} substantive field(s))`,
              severity: 'error',
            });
          }
        } catch {
          // skip unparseable files
        }
      }
    }
  } catch {
    // content dir might not exist yet
  }

  return errors;
}

async function checkNavRouteAlignment(srcDir: string): Promise<InvariantError[]> {
  const errors: InvariantError[] = [];
  const navPath = join(srcDir, 'src', 'data', 'navigation.json');

  let navData: unknown;
  try {
    navData = JSON.parse(await readFile(navPath, 'utf-8'));
  } catch {
    // navigation.json doesn't exist or is unparseable — nothing to check
    return errors;
  }

  const { routes: knownRoutes, dynamicPatterns } = await buildKnownRoutes(srcDir);

  // Extract all url fields from the navigation tree
  const navUrls: string[] = [];
  function extractUrls(obj: unknown): void {
    if (Array.isArray(obj)) {
      for (const item of obj) extractUrls(item);
    } else if (obj && typeof obj === 'object') {
      const record = obj as Record<string, unknown>;
      if (typeof record.url === 'string') {
        navUrls.push(record.url);
      }
      for (const val of Object.values(record)) {
        if (typeof val === 'object' && val !== null) extractUrls(val);
      }
    }
  }
  extractUrls(navData);

  for (const url of navUrls) {
    // Skip external, anchors, empty, root
    if (url.startsWith('http') || url.startsWith('#') || url.startsWith('mailto:') || url.startsWith('tel:')) continue;
    if (url === '/' || url === '') continue;
    if (isAssetPath(url)) continue;

    if (!isKnownInternalRoute(url, knownRoutes, dynamicPatterns)) {
      errors.push({
        file: relative(srcDir, navPath),
        check: 'nav-route-alignment',
        message: `Navigation URL "${url}" does not match any known route`,
        severity: 'error',
      });
    }
  }

  return errors;
}

async function checkExternalLinks(srcDir: string): Promise<InvariantError[]> {
  const warnings: InvariantError[] = [];
  const allFiles = await walkFiles(join(srcDir, 'src'), ['.astro', '.json']);

  // Known-good external domains (CDNs, fonts, etc.)
  const knownGoodDomains = [
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'cdn.jsdelivr.net',
    'unpkg.com',
    'vercel.com',
    'vercel.app',
  ];

  for (const file of allFiles) {
    const content = await readFile(file, 'utf-8');
    const relFile = relative(srcDir, file);
    const hrefs = [...extractHrefs(content), ...extractSrcs(content).map(s => ({ href: s.src, line: s.line }))];

    for (const { href, line } of hrefs) {
      if (!href.startsWith('http')) continue;

      try {
        const url = new URL(href);
        if (knownGoodDomains.some(d => url.hostname === d || url.hostname.endsWith('.' + d))) continue;

        warnings.push({
          file: relFile,
          line,
          check: 'external-links',
          message: `External link to ${url.hostname} — verify this is intentional`,
          severity: 'warning',
        });
      } catch {
        // Not a valid URL, skip
      }
    }
  }

  return warnings;
}

// --- Runner ---

/**
 * Phase-appropriate invariant check sets.
 *
 * Early phases (layout, design) only own CSS/HTML structure — they cannot
 * fix data files produced by the seed step. Running data-level checks
 * (broken-internal-links on JSON, source-origin-leakage in data files)
 * during those phases causes infinite retry loops because the agent
 * literally cannot fix the issue.
 */
const PHASE_CHECKS: Record<string, string[]> = {
  // Early UI phases only own CSS/HTML — they cannot fix data files from the seed step.
  // content-collection-completeness and nav-route-alignment are data-level checks
  // that only the seed step can address; running them here causes infinite retry loops.
  layout: ['broken-internal-links-astro', 'empty-pages', 'broken-images', 'page-count'],
  mobile: ['broken-internal-links-astro', 'empty-pages', 'broken-images', 'page-count'],
  design: ['empty-pages', 'broken-images', 'page-count'],
  color: ['empty-pages', 'broken-images', 'page-count'],
  motion: ['empty-pages', 'broken-images', 'page-count'],
  // Polish phase is the final gate — run everything
  polish: [
    'broken-internal-links-astro', 'broken-internal-links-data', 'dead-hash-links', 'empty-pages',
    'source-origin-leakage', 'broken-images', 'interactive-elements',
    'page-count', 'external-links', 'content-collection-completeness', 'nav-route-alignment',
  ],
};

export async function runAllInvariants(options: InvariantOptions): Promise<InvariantResult> {
  const startTime = Date.now();
  const { srcDir, sourceOrigin, previousPageCount, onlyChecks, phaseId } = options;
  const allErrors: InvariantError[] = [];
  const allWarnings: InvariantError[] = [];

  const checks: Array<{ name: string; run: () => Promise<InvariantError[]> }> = [
    { name: 'broken-internal-links-astro', run: () => checkBrokenInternalLinksInAstro(srcDir) },
    { name: 'broken-internal-links-data', run: () => checkBrokenInternalLinksInData(srcDir) },
    { name: 'dead-hash-links', run: () => checkDeadHashLinks(srcDir) },
    { name: 'empty-pages', run: () => checkEmptyPages(srcDir) },
    { name: 'source-origin-leakage', run: () => checkSourceOriginLeakage(srcDir, sourceOrigin) },
    { name: 'broken-images', run: () => checkBrokenImages(srcDir) },
    { name: 'interactive-elements', run: () => checkInteractiveElements(srcDir) },
    { name: 'page-count', run: () => checkPageCount(srcDir, previousPageCount) },
    { name: 'external-links', run: () => checkExternalLinks(srcDir) },
    { name: 'content-collection-completeness', run: () => checkContentCollectionCompleteness(srcDir) },
    { name: 'nav-route-alignment', run: () => checkNavRouteAlignment(srcDir) },
  ];

  // Determine which checks to run: explicit onlyChecks > phase-based > all
  const phaseAllowList = phaseId ? PHASE_CHECKS[phaseId] : undefined;

  for (const check of checks) {
    if (onlyChecks && !onlyChecks.includes(check.name)) continue;
    if (!onlyChecks && phaseAllowList && !phaseAllowList.includes(check.name)) continue;

    try {
      const errs = await check.run();
      for (const e of errs) {
        if (e.severity === 'warning') {
          allWarnings.push(e);
        } else {
          allErrors.push(e);
        }
      }
    } catch (err) {
      allWarnings.push({
        file: 'invariants',
        check: check.name,
        message: `Check failed to run: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'warning',
      });
    }
  }

  const duration = Date.now() - startTime;
  const passed = allErrors.length === 0;

  return {
    passed,
    errors: allErrors,
    warnings: allWarnings,
    duration,
    summary: formatSummary(allErrors, allWarnings, duration),
  };
}

function formatSummary(errors: InvariantError[], warnings: InvariantError[], duration: number): string {
  const lines: string[] = [];

  if (errors.length === 0 && warnings.length === 0) {
    lines.push(`All invariants passed (${duration}ms)`);
  } else {
    lines.push(`${errors.length} error(s), ${warnings.length} warning(s) (${duration}ms)`);
  }

  if (errors.length > 0) {
    lines.push('');
    lines.push('ERRORS:');
    const grouped = groupBy(errors, 'check');
    for (const [check, errs] of Object.entries(grouped)) {
      lines.push(`  ${check}: ${errs.length} issue(s)`);
      for (const e of errs.slice(0, 5)) {
        const loc = e.line ? `${e.file}:${e.line}` : e.file;
        lines.push(`    - ${loc}: ${e.message}`);
      }
      if (errs.length > 5) {
        lines.push(`    ... and ${errs.length - 5} more`);
      }
    }
  }

  if (warnings.length > 0) {
    lines.push('');
    lines.push('WARNINGS:');
    const grouped = groupBy(warnings, 'check');
    for (const [check, warns] of Object.entries(grouped)) {
      lines.push(`  ${check}: ${warns.length} issue(s)`);
      for (const w of warns.slice(0, 3)) {
        const loc = w.line ? `${w.file}:${w.line}` : w.file;
        lines.push(`    - ${loc}: ${w.message}`);
      }
      if (warns.length > 3) {
        lines.push(`    ... and ${warns.length - 3} more`);
      }
    }
  }

  return lines.join('\n');
}

function groupBy(arr: InvariantError[], key: keyof InvariantError): Record<string, InvariantError[]> {
  const result: Record<string, InvariantError[]> = {};
  for (const item of arr) {
    const k = String(item[key]);
    (result[k] ??= []).push(item);
  }
  return result;
}

/** Format invariant result for embedding in a reviewer prompt */
export function generateInvariantReport(result: InvariantResult): string {
  return `## Invariant Check Results

**Status:** ${result.passed ? 'PASS' : 'FAIL'}
**Duration:** ${result.duration}ms

${result.summary}

${result.errors.length > 0 ? `### Errors (${result.errors.length})\n${result.errors.map(e => `- **${e.check}**: ${e.file}${e.line ? `:${e.line}` : ''} — ${e.message}`).join('\n')}` : ''}

${result.warnings.length > 0 ? `### Warnings (${result.warnings.length})\n${result.warnings.map(w => `- **${w.check}**: ${w.file}${w.line ? `:${w.line}` : ''} — ${w.message}`).join('\n')}` : ''}
`;
}

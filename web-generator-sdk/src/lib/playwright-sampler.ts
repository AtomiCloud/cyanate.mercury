/**
 * Playwright page-type sampler.
 *
 * Reads registry.json to discover page types, picks 1-3 sample URLs per type
 * from the built dist/, then runs Playwright checks against each at mobile
 * (375px) and desktop (1280px) viewports.
 *
 * Tests: HTTP 200, non-empty content, heading hierarchy, console errors,
 * horizontal overflow, nav presence, footer presence, image loading.
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { chromium, type Browser, type Page, type ConsoleMessage } from 'playwright';
import type { Registry } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SamplerOptions {
  /** Absolute path to the built Astro site (contains dist/) */
  siteDir: string;
  /** Base URL where the site is being served (e.g. http://localhost:4321) */
  baseUrl: string;
  /** Maximum samples per page type (default 3) */
  maxSamplesPerType?: number;
  /** Timeout per page navigation in ms (default 15 000) */
  pageTimeout?: number;
}

export interface PageCheck {
  url: string;
  pageType: string;
  viewport: 'mobile' | 'desktop';
  status: number | null;
  hasContent: boolean;
  headingHierarchyOk: boolean;
  headingIssues: string[];
  consoleErrors: string[];
  hasOverflow: boolean;
  hasNav: boolean;
  hasFooter: boolean;
  brokenImages: string[];
  passed: boolean;
}

export interface SamplerReport {
  timestamp: string;
  baseUrl: string;
  totalChecks: number;
  passed: number;
  failed: number;
  checks: PageCheck[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VIEWPORTS = {
  mobile:  { width: 375,  height: 812 },
  desktop: { width: 1280, height: 800 },
} as const;

/**
 * Discover sample URLs by reading registry.json and scanning dist/ for
 * actual generated HTML files.
 */
async function discoverSamples(
  siteDir: string,
  maxPerType: number,
): Promise<Array<{ url: string; pageType: string }>> {
  const samples: Array<{ url: string; pageType: string }> = [];
  const distDir = join(siteDir, 'dist');

  // Try loading registry.json
  let registry: Registry | null = null;
  for (const candidate of [
    join(siteDir, 'output/reduced/registry.json'),
    join(siteDir, 'output/registry.json'),
  ]) {
    try {
      registry = JSON.parse(await readFile(candidate, 'utf-8'));
      break;
    } catch { /* try next */ }
  }

  // 1. Static pages (always include all — they're few)
  if (registry?.static_pages) {
    for (const sp of registry.static_pages) {
      samples.push({ url: sp.route || '/', pageType: sp.pagetype });
    }
  } else {
    // Fallback: at least check the homepage
    samples.push({ url: '/', pageType: 'landing' });
  }

  // 2. Collection pages — pick up to maxPerType from dist/ per collection
  if (registry?.collections) {
    for (const [collName, _coll] of Object.entries(registry.collections)) {
      const contentDir = join(siteDir, 'src/content', collName);
      let slugs: string[] = [];
      try {
        const files = await readdir(contentDir);
        slugs = files
          .filter(f => f.endsWith('.json'))
          .map(f => f.replace(/\.json$/, ''));
      } catch { /* content dir may not exist */ }

      // Find the actual dist dir for this collection
      // Collections can map to various route patterns, so scan dist/
      const collDirs = await findDistDirs(distDir, collName);

      let added = 0;
      for (const slug of slugs) {
        if (added >= maxPerType) break;
        // Try to find this slug's HTML in dist/
        const found = await findDistPage(distDir, collDirs, slug);
        if (found) {
          samples.push({ url: found, pageType: collName });
          added++;
        }
      }
    }
  }

  // 3. Listing pages
  if (registry && Array.isArray(registry.listings)) {
    for (const listing of registry.listings as Array<{ id: string; route: string }>) {
      // Static listings (no params) — add directly
      if (!listing.route.includes('[')) {
        samples.push({ url: listing.route, pageType: `listing:${listing.id}` });
      }
      // Dynamic listings — find samples from dist/
      // e.g., /category/[slug] — look for dist/category/*/index.html
      else {
        const routeBase = listing.route.split('[')[0].replace(/\/$/, '');
        if (routeBase) {
          try {
            const entries = await readdir(join(distDir, routeBase.replace(/^\//, '')));
            let added = 0;
            for (const entry of entries) {
              if (added >= maxPerType) break;
              const pagePath = join(distDir, routeBase.replace(/^\//, ''), entry, 'index.html');
              try {
                await stat(pagePath);
                samples.push({
                  url: `${routeBase}/${entry}`,
                  pageType: `listing:${listing.id}`,
                });
                added++;
              } catch { /* not a valid page */ }
            }
          } catch { /* dir doesn't exist */ }
        }
      }
    }
  }

  return samples;
}

/** Find dist subdirectories that might contain collection pages. */
async function findDistDirs(distDir: string, collName: string): Promise<string[]> {
  // Map common collection names to their dist directory names
  const candidates = [
    collName,
    collName.replace(/_/g, '-'),
    collName.replace(/_/g, '/'),
  ];
  const found: string[] = [];
  for (const c of candidates) {
    try {
      await stat(join(distDir, c));
      found.push(c);
    } catch { /* doesn't exist */ }
  }
  return found;
}

/** Find a built page for a given slug across possible dist directories. */
async function findDistPage(
  distDir: string,
  collDirs: string[],
  slug: string,
): Promise<string | null> {
  for (const dir of collDirs) {
    // Try dir/slug/index.html
    try {
      await stat(join(distDir, dir, slug, 'index.html'));
      return `/${dir}/${slug}`;
    } catch { /* try next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Page checks
// ---------------------------------------------------------------------------

async function checkPage(
  page: Page,
  url: string,
  pageType: string,
  viewport: 'mobile' | 'desktop',
  baseUrl: string,
  timeout: number,
): Promise<PageCheck> {
  const consoleErrors: string[] = [];
  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  };
  page.on('console', onConsole);

  await page.setViewportSize(VIEWPORTS[viewport]);

  const fullUrl = new URL(url, baseUrl).href;
  let status: number | null = null;

  try {
    const response = await page.goto(fullUrl, {
      waitUntil: 'networkidle',
      timeout,
    });
    status = response?.status() ?? null;
  } catch {
    page.off('console', onConsole);
    return {
      url, pageType, viewport, status: null,
      hasContent: false, headingHierarchyOk: false, headingIssues: ['Navigation timeout'],
      consoleErrors, hasOverflow: false, hasNav: false, hasFooter: false,
      brokenImages: [], passed: false,
    };
  }

  // Run all checks in a single evaluate call for efficiency
  const checks = await page.evaluate(() => {
    const body = document.body;
    const bodyText = (body.innerText || '').trim();

    // Heading hierarchy
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    const levels = headings.map(h => parseInt(h.tagName[1], 10));
    const headingIssues: string[] = [];
    const h1Count = levels.filter(l => l === 1).length;
    if (h1Count === 0) headingIssues.push('No h1 found');
    if (h1Count > 1) headingIssues.push(`Multiple h1 elements (${h1Count})`);
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] > levels[i - 1] + 1) {
        headingIssues.push(`Heading skip: h${levels[i - 1]} -> h${levels[i]}`);
        break; // report first skip only
      }
    }

    // Overflow
    const hasOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;

    // Nav + footer
    const hasNav = !!document.querySelector('nav, header');
    const hasFooter = !!document.querySelector('footer');

    // Broken images
    const images = Array.from(document.querySelectorAll('img'));
    const brokenImages: string[] = [];
    for (const img of images) {
      if (!img.complete || img.naturalWidth === 0) {
        brokenImages.push(img.src || img.getAttribute('data-src') || '(unknown)');
      }
    }

    return {
      hasContent: bodyText.length > 50,
      headingHierarchyOk: headingIssues.length === 0,
      headingIssues,
      hasOverflow,
      hasNav,
      hasFooter,
      brokenImages,
    };
  });

  page.off('console', onConsole);

  const passed =
    status === 200 &&
    checks.hasContent &&
    checks.headingHierarchyOk &&
    consoleErrors.length === 0 &&
    !checks.hasOverflow &&
    checks.hasNav &&
    checks.hasFooter &&
    checks.brokenImages.length === 0;

  return {
    url,
    pageType,
    viewport,
    status,
    hasContent: checks.hasContent,
    headingHierarchyOk: checks.headingHierarchyOk,
    headingIssues: checks.headingIssues,
    consoleErrors,
    hasOverflow: checks.hasOverflow,
    hasNav: checks.hasNav,
    hasFooter: checks.hasFooter,
    brokenImages: checks.brokenImages,
    passed,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run the Playwright page-type sampler.
 *
 * Expects the site to already be served at `opts.baseUrl` (e.g. via
 * `npx astro preview` or a static file server on dist/).
 */
export async function runPlaywrightSampler(
  opts: SamplerOptions,
): Promise<SamplerReport> {
  const maxPerType = opts.maxSamplesPerType ?? 3;
  const timeout = opts.pageTimeout ?? 15_000;

  const samples = await discoverSamples(opts.siteDir, maxPerType);

  const browser = await chromium.launch({ headless: true });
  const checks: PageCheck[] = [];

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    for (const sample of samples) {
      for (const vp of ['mobile', 'desktop'] as const) {
        const result = await checkPage(
          page,
          sample.url,
          sample.pageType,
          vp,
          opts.baseUrl,
          timeout,
        );
        checks.push(result);
      }
    }

    await context.close();
  } finally {
    await browser.close();
  }

  const passed = checks.filter(c => c.passed).length;

  return {
    timestamp: new Date().toISOString(),
    baseUrl: opts.baseUrl,
    totalChecks: checks.length,
    passed,
    failed: checks.length - passed,
    checks,
  };
}

/**
 * Format a sampler report as a markdown summary suitable for a reviewer verdict.
 */
export function formatSamplerReport(report: SamplerReport): string {
  const lines: string[] = [
    `# Playwright Sampler Report`,
    ``,
    `**Time:** ${report.timestamp}`,
    `**Base URL:** ${report.baseUrl}`,
    `**Checks:** ${report.totalChecks} total, ${report.passed} passed, ${report.failed} failed`,
    ``,
  ];

  if (report.failed === 0) {
    lines.push('All checks passed.');
  } else {
    lines.push('## Failures');
    lines.push('');
    for (const check of report.checks) {
      if (check.passed) continue;
      const issues: string[] = [];
      if (check.status !== 200) issues.push(`HTTP ${check.status ?? 'timeout'}`);
      if (!check.hasContent) issues.push('Empty content');
      if (!check.headingHierarchyOk) issues.push(`Headings: ${check.headingIssues.join(', ')}`);
      if (check.consoleErrors.length > 0) issues.push(`Console errors: ${check.consoleErrors.length}`);
      if (check.hasOverflow) issues.push('Horizontal overflow');
      if (!check.hasNav) issues.push('Missing nav/header');
      if (!check.hasFooter) issues.push('Missing footer');
      if (check.brokenImages.length > 0) issues.push(`Broken images: ${check.brokenImages.length}`);
      lines.push(`- **${check.url}** (${check.viewport}, ${check.pageType}): ${issues.join('; ')}`);
    }
  }

  return lines.join('\n');
}

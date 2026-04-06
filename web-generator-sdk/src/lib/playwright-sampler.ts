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

import { readFile, readdir, stat, mkdir, writeFile } from 'fs/promises';
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
  /** Which viewports to check (default: both mobile and desktop) */
  viewports?: Array<'mobile' | 'desktop'>;
  /** Directory to save screenshots and a11y snapshots. If set, screenshots are captured for every page check. */
  screenshotDir?: string;
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
  /** Paths to captured screenshots (empty if screenshotDir not provided) */
  screenshots: { fold?: string; full?: string };
  /** Path to accessibility snapshot JSON (empty if screenshotDir not provided) */
  a11ySnapshot?: string;
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

  // 1. Static pages — always include homepage, cap the rest at maxPerType
  if (registry?.static_pages) {
    const home = registry.static_pages.find(sp => sp.route === '/');
    if (home) samples.push({ url: '/', pageType: home.pagetype });
    let added = 0;
    for (const sp of registry.static_pages) {
      if (sp.route === '/') continue;
      if (added >= maxPerType) break;
      samples.push({ url: sp.route || '/', pageType: sp.pagetype });
      added++;
    }
  } else {
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
  screenshotDir?: string,
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
      brokenImages: [], passed: false, screenshots: {},
    };
  }

  // Run all checks in a single evaluate call for efficiency
  const checks = await page.evaluate(() => {
    const body = document.body;
    const main = document.querySelector('main');
    const contentRoot = main ?? body;
    const bodyText = (contentRoot.textContent || '').trim();

    // Heading hierarchy
    const headings = Array.from(contentRoot.querySelectorAll('h1, h2, h3, h4, h5, h6'));
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

  // Capture screenshots and accessibility snapshot if screenshotDir is set
  const screenshots: { fold?: string; full?: string } = {};
  let a11ySnapshot: string | undefined;
  if (screenshotDir) {
    try {
      const slug = url.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-|-$/g, '') || 'index';
      const prefix = `${pageType}-${slug}-${viewport}`;
      const typeDir = join(screenshotDir, pageType);
      await mkdir(typeDir, { recursive: true });

      const foldPath = join(typeDir, `${prefix}-fold.jpeg`);
      await page.screenshot({ path: foldPath, type: 'jpeg', quality: 65 });
      screenshots.fold = foldPath;

      const fullPath = join(typeDir, `${prefix}-full.jpeg`);
      await page.screenshot({ path: fullPath, type: 'jpeg', quality: 65, fullPage: true });
      screenshots.full = fullPath;

      // Accessibility snapshot via ARIA snapshot (Playwright 1.49+)
      const a11yText = await page.locator('body').ariaSnapshot();
      if (a11yText) {
        const a11yPath = join(typeDir, `${prefix}-a11y.txt`);
        await writeFile(a11yPath, a11yText, 'utf-8');
        a11ySnapshot = a11yPath;
      }
    } catch { /* screenshot capture is best-effort */ }
  }

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
    screenshots,
    a11ySnapshot,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run the Playwright page-type sampler.
 *
 * Expects the site to already be served at `opts.baseUrl` (e.g. via
 * `bun x astro preview` or a static file server on dist/).
 */
export async function runPlaywrightSampler(
  opts: SamplerOptions,
): Promise<SamplerReport> {
  const maxPerType = opts.maxSamplesPerType ?? 3;
  const timeout = opts.pageTimeout ?? 15_000;
  const viewports = opts.viewports ?? ['mobile', 'desktop'];
  const screenshotDir = opts.screenshotDir;

  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true });
  }

  const samples = await discoverSamples(opts.siteDir, maxPerType);

  const browser = await chromium.launch({ headless: true });
  const checks: PageCheck[] = [];

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    for (const sample of samples) {
      for (const vp of viewports) {
        const result = await checkPage(
          page,
          sample.url,
          sample.pageType,
          vp,
          opts.baseUrl,
          timeout,
          screenshotDir,
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

// ---------------------------------------------------------------------------
// Interaction tests
// ---------------------------------------------------------------------------

export interface InteractionTestResult {
  test: string;
  page: string;
  viewport: 'mobile' | 'desktop';
  passed: boolean;
  details: string;
  screenshotBefore?: string;
  screenshotAfter?: string;
}

export interface InteractionTestReport {
  timestamp: string;
  tests: InteractionTestResult[];
  passed: number;
  failed: number;
}

/**
 * Run automated interaction tests on the generated site.
 *
 * Tests interactive elements: mobile nav toggle, hover states, clickable links.
 * Uses Playwright to exercise interactions and capture before/after screenshots.
 */
export async function runInteractionTests(opts: {
  baseUrl: string;
  siteDir: string;
  outputDir: string;
  phases?: string[];
}): Promise<InteractionTestReport> {
  const results: InteractionTestResult[] = [];
  await mkdir(opts.outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Test 1: Mobile nav toggle
    await page.setViewportSize(VIEWPORTS.mobile);
    try {
      await page.goto(new URL('/', opts.baseUrl).href, { waitUntil: 'networkidle', timeout: 15000 });

      const beforePath = join(opts.outputDir, 'mobile-nav-before.png');
      await page.screenshot({ path: beforePath });

      // Find hamburger / mobile menu trigger with broad selectors
      const menuButton = await page.$([
        'button[aria-label*="menu" i]',
        'button[aria-label*="nav" i]',
        'button[aria-label*="Menu"]',
        '[data-mobile-nav-toggle]',
        'button.hamburger',
        'button.mobile-menu',
      ].join(', '));

      if (menuButton && await menuButton.isVisible()) {
        await menuButton.click();
        await page.waitForTimeout(600);

        const afterPath = join(opts.outputDir, 'mobile-nav-after.png');
        await page.screenshot({ path: afterPath });

        // Check if a nav/drawer became visible
        const visibleNav = await page.evaluate(() => {
          const navEls = document.querySelectorAll('nav, [role="navigation"], .mobile-nav, .drawer, .mobile-menu');
          for (const el of navEls) {
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (style.display !== 'none' && style.visibility !== 'hidden' &&
                parseFloat(style.opacity) > 0 && rect.height > 50) {
              return true;
            }
          }
          return false;
        });

        results.push({
          test: 'Mobile nav toggle',
          page: '/',
          viewport: 'mobile',
          passed: visibleNav,
          details: visibleNav
            ? 'Nav element became visible after clicking menu button'
            : 'Nav element did NOT become visible after clicking menu button — toggle is broken',
          screenshotBefore: beforePath,
          screenshotAfter: afterPath,
        });
      } else {
        results.push({
          test: 'Mobile nav toggle',
          page: '/',
          viewport: 'mobile',
          passed: true,
          details: 'No mobile menu button found (may not apply to this site)',
        });
      }
    } catch (err) {
      results.push({
        test: 'Mobile nav toggle',
        page: '/',
        viewport: 'mobile',
        passed: false,
        details: `Test crashed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Test 2: Hover states on interactive elements (desktop)
    await page.setViewportSize(VIEWPORTS.desktop);
    try {
      await page.goto(new URL('/', opts.baseUrl).href, { waitUntil: 'networkidle', timeout: 15000 });

      // Find card-like interactive elements
      const cards = await page.$$('a:has(> div), .card, [class*="card"], a[href]:has(img)');
      const testCard = cards.length > 0 ? cards[0] : null;

      if (testCard && await testCard.isVisible()) {
        // Get initial styles
        const beforeStyles = await testCard.evaluate((el) => {
          const s = getComputedStyle(el);
          return { transform: s.transform, boxShadow: s.boxShadow, opacity: s.opacity, backgroundColor: s.backgroundColor };
        });

        const beforePath = join(opts.outputDir, 'hover-before.png');
        await page.screenshot({ path: beforePath });

        await testCard.hover();
        await page.waitForTimeout(400);

        const afterPath = join(opts.outputDir, 'hover-after.png');
        await page.screenshot({ path: afterPath });

        const afterStyles = await testCard.evaluate((el) => {
          const s = getComputedStyle(el);
          return { transform: s.transform, boxShadow: s.boxShadow, opacity: s.opacity, backgroundColor: s.backgroundColor };
        });

        const styleChanged = beforeStyles.transform !== afterStyles.transform
          || beforeStyles.boxShadow !== afterStyles.boxShadow
          || beforeStyles.opacity !== afterStyles.opacity
          || beforeStyles.backgroundColor !== afterStyles.backgroundColor;

        results.push({
          test: 'Hover state on interactive card',
          page: '/',
          viewport: 'desktop',
          passed: styleChanged,
          details: styleChanged
            ? 'Card element changed visual state on hover'
            : 'Card element did NOT change on hover — no visible hover feedback',
          screenshotBefore: beforePath,
          screenshotAfter: afterPath,
        });
      } else {
        results.push({
          test: 'Hover state on interactive card',
          page: '/',
          viewport: 'desktop',
          passed: true,
          details: 'No card-like interactive elements found on homepage',
        });
      }
    } catch (err) {
      results.push({
        test: 'Hover state on interactive card',
        page: '/',
        viewport: 'desktop',
        passed: false,
        details: `Test crashed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Test 3: Nav link validity — click each nav link and verify HTTP 200
    await page.setViewportSize(VIEWPORTS.desktop);
    try {
      await page.goto(new URL('/', opts.baseUrl).href, { waitUntil: 'networkidle', timeout: 15000 });

      const navLinks = await page.evaluate((base) => {
        const links = Array.from(document.querySelectorAll('nav a[href], header a[href]'));
        return links
          .map(a => (a as HTMLAnchorElement).getAttribute('href'))
          .filter((href): href is string => !!href && href.startsWith('/') && !href.startsWith('//'))
          .filter((href, i, arr) => arr.indexOf(href) === i) // dedupe
          .slice(0, 10); // cap at 10
      }, opts.baseUrl);

      let brokenLinks = 0;
      const broken: string[] = [];
      for (const href of navLinks) {
        try {
          const resp = await page.goto(new URL(href, opts.baseUrl).href, { waitUntil: 'domcontentloaded', timeout: 10000 });
          if (!resp || resp.status() >= 400) {
            brokenLinks++;
            broken.push(`${href} → HTTP ${resp?.status() ?? 'timeout'}`);
          }
        } catch {
          brokenLinks++;
          broken.push(`${href} → timeout`);
        }
      }

      results.push({
        test: 'Nav link validity',
        page: '/',
        viewport: 'desktop',
        passed: brokenLinks === 0,
        details: brokenLinks === 0
          ? `All ${navLinks.length} nav links returned HTTP 200`
          : `${brokenLinks}/${navLinks.length} nav links broken: ${broken.join(', ')}`,
      });
    } catch (err) {
      results.push({
        test: 'Nav link validity',
        page: '/',
        viewport: 'desktop',
        passed: false,
        details: `Test crashed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    await context.close();
  } finally {
    await browser.close();
  }

  const passed = results.filter(r => r.passed).length;
  const report: InteractionTestReport = {
    timestamp: new Date().toISOString(),
    tests: results,
    passed,
    failed: results.length - passed,
  };

  await writeFile(
    join(opts.outputDir, 'interaction-tests.json'),
    JSON.stringify(report, null, 2),
    'utf-8',
  );

  return report;
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

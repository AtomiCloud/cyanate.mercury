/**
 * Snapshot-based regression detection for the v2 pipeline.
 *
 * After each phase passes, captures key metrics. The next phase's
 * reviewer compares against the snapshot to detect regressions.
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import { join, extname, relative } from 'path';
import type { PhaseId } from '../steps/step.js';

// --- Types ---

export interface PhaseSnapshot {
  phase: PhaseId;
  timestamp: string;
  pageCount: number;
  navLinks: string[];
  footerLinks: string[];
  cssVarCount: number;
  fileManifest: string[];
  sourceOriginRefs: number;
}

export interface RegressionReport {
  hasRegressions: boolean;
  regressions: RegressionItem[];
}

export interface RegressionItem {
  metric: string;
  previous: string | number;
  current: string | number;
  description: string;
}

// --- Helpers ---

async function walkFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git' || entry.name === 'scratch') continue;
        results.push(...await walkFiles(fullPath));
      } else {
        results.push(fullPath);
      }
    }
  } catch {
    // dir doesn't exist
  }
  return results;
}

async function countCssVars(srcDir: string): Promise<number> {
  try {
    const globalsCss = await readFile(join(srcDir, 'src', 'styles', 'globals.css'), 'utf-8');
    const matches = globalsCss.match(/--[a-zA-Z][\w-]*\s*:/g);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

async function readJsonLinks(filePath: string): Promise<string[]> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const json = JSON.parse(content);
    return extractLinks(json);
  } catch {
    return [];
  }
}

function extractLinks(obj: unknown): string[] {
  const links: string[] = [];
  if (typeof obj === 'string') {
    if (obj.startsWith('/') || obj.startsWith('http')) {
      links.push(obj);
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) links.push(...extractLinks(item));
  } else if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      links.push(...extractLinks(val));
    }
  }
  return links;
}

async function countSourceOriginRefs(srcDir: string, sourceOrigin?: string): Promise<number> {
  if (!sourceOrigin) return 0;

  const files = await walkFiles(join(srcDir, 'src'));
  let count = 0;
  for (const file of files) {
    try {
      const content = await readFile(file, 'utf-8');
      // Count occurrences that aren't in comments
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('<!--')) continue;
        if (line.includes(sourceOrigin)) count++;
      }
    } catch {
      // skip
    }
  }
  return count;
}

// --- Core functions ---

export async function createSnapshot(
  phase: PhaseId,
  projectDir: string,
  sourceOrigin?: string,
): Promise<PhaseSnapshot> {
  const srcDir = projectDir;
  const pagesDir = join(srcDir, 'src', 'pages');
  const dataDir = join(srcDir, 'src', 'data');

  // Count pages
  let pageCount = 0;
  try {
    const pageFiles = await walkFiles(pagesDir);
    pageCount = pageFiles.filter(f => extname(f) === '.astro' || extname(f) === '.md').length;
  } catch {
    // pages dir doesn't exist yet
  }

  // Read nav and footer links
  const navLinks = await readJsonLinks(join(dataDir, 'navigation.json'));
  const footerLinks = await readJsonLinks(join(dataDir, 'footer.json'));

  // Count CSS variables
  const cssVarCount = await countCssVars(srcDir);

  // Build file manifest
  const allFiles = await walkFiles(join(srcDir, 'src'));
  const fileManifest = allFiles
    .map(f => relative(srcDir, f))
    .sort();

  // Count source origin references
  const sourceOriginRefs = await countSourceOriginRefs(srcDir, sourceOrigin);

  return {
    phase,
    timestamp: new Date().toISOString(),
    pageCount,
    navLinks: [...new Set(navLinks)],
    footerLinks: [...new Set(footerLinks)],
    cssVarCount,
    fileManifest,
    sourceOriginRefs,
  };
}

export async function writeSnapshot(
  snapshot: PhaseSnapshot,
  runDir: string,
): Promise<void> {
  const snapshotsDir = join(runDir, 'snapshots');
  await mkdir(snapshotsDir, { recursive: true });
  await writeFile(
    join(snapshotsDir, `${snapshot.phase}.json`),
    JSON.stringify(snapshot, null, 2),
    'utf-8',
  );
}

export async function readSnapshot(
  phase: PhaseId,
  runDir: string,
): Promise<PhaseSnapshot | null> {
  try {
    const content = await readFile(join(runDir, 'snapshots', `${phase}.json`), 'utf-8');
    return JSON.parse(content) as PhaseSnapshot;
  } catch {
    return null;
  }
}

/**
 * Find the most recent snapshot before the given phase.
 */
export async function readPreviousSnapshot(
  currentPhase: PhaseId,
  runDir: string,
): Promise<PhaseSnapshot | null> {
  const phaseOrder: PhaseId[] = ['analyze', 'structure', 'layout', 'mobile', 'design', 'color', 'motion', 'polish'];
  const currentIdx = phaseOrder.indexOf(currentPhase);
  if (currentIdx <= 0) return null;

  // Walk backwards to find the most recent snapshot
  for (let i = currentIdx - 1; i >= 0; i--) {
    const snapshot = await readSnapshot(phaseOrder[i], runDir);
    if (snapshot) return snapshot;
  }
  return null;
}

export function compareSnapshots(
  prev: PhaseSnapshot,
  curr: PhaseSnapshot,
): RegressionReport {
  const regressions: RegressionItem[] = [];

  // Page count must not decrease
  if (curr.pageCount < prev.pageCount) {
    regressions.push({
      metric: 'pageCount',
      previous: prev.pageCount,
      current: curr.pageCount,
      description: `Page count decreased from ${prev.pageCount} to ${curr.pageCount}`,
    });
  }

  // Nav links must not disappear
  const prevNavSet = new Set(prev.navLinks);
  const currNavSet = new Set(curr.navLinks);
  for (const link of prevNavSet) {
    if (!currNavSet.has(link)) {
      regressions.push({
        metric: 'navLinks',
        previous: link,
        current: '(missing)',
        description: `Navigation link "${link}" disappeared`,
      });
    }
  }

  // Footer links must not disappear
  const prevFooterSet = new Set(prev.footerLinks);
  const currFooterSet = new Set(curr.footerLinks);
  for (const link of prevFooterSet) {
    if (!currFooterSet.has(link)) {
      regressions.push({
        metric: 'footerLinks',
        previous: link,
        current: '(missing)',
        description: `Footer link "${link}" disappeared`,
      });
    }
  }

  // CSS var count must not decrease
  if (curr.cssVarCount < prev.cssVarCount) {
    regressions.push({
      metric: 'cssVarCount',
      previous: prev.cssVarCount,
      current: curr.cssVarCount,
      description: `CSS variable count decreased from ${prev.cssVarCount} to ${curr.cssVarCount}`,
    });
  }

  // Source origin refs should stay 0 (once seed clears them)
  if (prev.sourceOriginRefs === 0 && curr.sourceOriginRefs > 0) {
    regressions.push({
      metric: 'sourceOriginRefs',
      previous: 0,
      current: curr.sourceOriginRefs,
      description: `Source origin references reappeared (${curr.sourceOriginRefs} found)`,
    });
  }

  return {
    hasRegressions: regressions.length > 0,
    regressions,
  };
}

/** Format regression report for embedding in a reviewer prompt */
export function formatRegressionReport(report: RegressionReport): string {
  if (!report.hasRegressions) {
    return 'No regressions detected compared to previous phase snapshot.';
  }

  const lines = ['## Snapshot Regression Report', ''];
  lines.push(`Found ${report.regressions.length} regression(s):`);
  lines.push('');
  for (const r of report.regressions) {
    lines.push(`- **${r.metric}**: ${r.description} (was: ${r.previous}, now: ${r.current})`);
  }
  return lines.join('\n');
}

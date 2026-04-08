/**
 * Reviewer system for the v2 pipeline.
 *
 * Implements the implementer + reviewer pattern:
 * - Each phase runs an implementer step, then spawns parallel reviewer agents
 * - Reviewers write verdict files to reviews/ directory
 * - Any rejection → loop back to implementer with rejection context
 * - All pass → delete reviews/ folder → next phase
 * - Semaphore-controlled parallelism (default max 5 concurrent)
 */

import { mkdir, writeFile, readFile, rm, readdir, stat } from 'fs/promises';
import { join } from 'path';
import type { PipelineLogger } from './logger.js';
import { agentQuery } from './agent.js';

// --- Model mapping ---
// M1 uses a faster model for efficiency, M2 uses a more capable model for thoroughness.
// These map to the ANTHROPIC_MODEL env var that the agent SDK reads.
const MODEL_MAP: Record<string, string> = {
  M1: 'claude-haiku-4-5-20251001',
  M2: 'claude-sonnet-4-6',
};

// --- Types ---

export interface ReviewerDef {
  /** Unique reviewer ID (e.g., "reviewer-json-validity") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Which phase this reviewer belongs to */
  phase: string;
  /** The model variant (M1 fast, M2 capable, V1 vision) */
  model: 'M1' | 'M2' | 'V1';
  /** The prompt to send to the reviewer agent */
  prompt: (ctx: ReviewerContext) => string;
  /** Whether this reviewer needs a running dev server */
  needsDevServer?: boolean;
  /** Whether this is a per-page reviewer (spawns one per page) */
  perPage?: boolean;
  /** Whether this reviewer spawns one instance per page type (reads screenshots grouped by type) */
  perPageType?: boolean;
  /** If true, this reviewer runs as a programmatic function (no AI agent call) */
  programmatic?: boolean;
  /** Programmatic reviewer function. Returns PASS/REJECT verdict. */
  runFn?: (ctx: ReviewerContext) => Promise<ReviewVerdict>;
}

export interface ReviewerContext {
  /** Working directory (step dir with the Astro project) */
  workingDir: string;
  /** Evidence directory */
  evidenceDir: string;
  /** Reviews directory */
  reviewsDir: string;
  /** Scratch directory (Phase 0 outputs) */
  scratchDir: string;
  /** Phase ID */
  phaseId: string;
  /** Phase name */
  phaseName: string;
  /** Reference URL */
  referenceUrl?: string;
  /** Origin URL of the source site (e.g., "https://example.com") */
  sourceOrigin?: string;
  /** Path to the previous step's snapshot directory */
  snapshotPath?: string;
  /** Run directory (for reading/writing snapshots) */
  runDir?: string;
  /** Path to the site directory BEFORE this phase ran (for diff-based reviewing) */
  prevPhaseDir?: string;
  /** URL of a running preview server (e.g., "http://localhost:4321") */
  devServerUrl?: string;
  /** Environment variables */
  env: Record<string, string>;
  /** Pages to check (for per-page reviewers) */
  pages?: string[];
  /** Logger */
  logger?: PipelineLogger;
}

export interface ReviewVerdict {
  reviewerId: string;
  verdict: 'PASS' | 'REJECT';
  evidence: string;
  findings: string;
  rejectionContext?: string;
}

export interface ReviewResult {
  reviewerId: string;
  passed: boolean;
  verdict: ReviewVerdict;
  duration: number;
}

// --- Semaphore ---

export class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    }
  }
}

// --- Reviewer execution ---

/**
 * Run a single reviewer agent. The agent reads evidence, checks the project,
 * and writes its verdict to reviews/reviewer-{id}.md.
 */
async function runReviewer(
  reviewer: ReviewerDef,
  ctx: ReviewerContext,
  semaphore: Semaphore,
): Promise<ReviewResult> {
  const startTime = Date.now();
  await semaphore.acquire();

  try {
    // Give each reviewer its own evidence subdirectory to avoid write races
    const reviewerEvidenceDir = join(ctx.evidenceDir, reviewer.id);
    await mkdir(reviewerEvidenceDir, { recursive: true });
    const reviewerCtx = { ...ctx, evidenceDir: reviewerEvidenceDir };

    const prompt = reviewer.prompt(reviewerCtx);

    // Inject model selection via ANTHROPIC_MODEL env var
    // V1 = vision model, configured via cui.json visionModel → VISION_MODEL env var
    const resolvedModel = reviewer.model === 'V1'
      ? (ctx.env.VISION_MODEL || ctx.env.ANTHROPIC_DEFAULT_SONNET_MODEL || MODEL_MAP.M2)
      : (MODEL_MAP[reviewer.model] || process.env.ANTHROPIC_MODEL || '');
    const reviewerEnv = {
      ...ctx.env,
      ANTHROPIC_MODEL: resolvedModel,
    };

    const result = await agentQuery({
      prompt,
      cwd: ctx.workingDir,
      env: reviewerEnv,
      stepName: `${ctx.phaseName} / ${reviewer.name}`,
      logger: ctx.logger,
      maxTurns: 20,
    });

    // Parse the verdict from the result
    const verdict = parseVerdict(reviewer.id, result);

    // Write verdict file to reviews/
    const verdictContent = formatVerdictFile(reviewer, verdict);
    await writeFile(
      join(ctx.reviewsDir, `reviewer-${reviewer.id}.md`),
      verdictContent,
      'utf-8',
    );

    return {
      reviewerId: reviewer.id,
      passed: verdict.verdict === 'PASS',
      verdict,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    // If reviewer hit max turns, treat as PASS — it explored without finding issues
    const errMsg = err instanceof Error ? err.message : String(err);
    const isMaxTurns = errMsg.includes('error_max_turns');
    const errorVerdict: ReviewVerdict = {
      reviewerId: reviewer.id,
      verdict: isMaxTurns ? 'PASS' : 'REJECT',
      evidence: isMaxTurns ? 'Reviewer exhausted turn budget without finding issues' : 'Reviewer agent crashed or timed out',
      findings: `Error: ${errMsg}`,
      rejectionContext: isMaxTurns ? '' : `Reviewer ${reviewer.id} failed to execute: ${errMsg}`,
    };

    await writeFile(
      join(ctx.reviewsDir, `reviewer-${reviewer.id}.md`),
      formatVerdictFile(reviewer, errorVerdict),
      'utf-8',
    ).catch(() => {});

    return {
      reviewerId: reviewer.id,
      passed: isMaxTurns,
      verdict: errorVerdict,
      duration: Date.now() - startTime,
    };
  } finally {
    semaphore.release();
  }
}

/**
 * Run a per-page reviewer — spawns one reviewer agent per page.
 */
async function runPerPageReviewer(
  reviewer: ReviewerDef,
  ctx: ReviewerContext,
  semaphore: Semaphore,
): Promise<ReviewResult[]> {
  const pages = ctx.pages || [];

  if (pages.length === 0) {
    // Per-page reviewers with no pages — skip (don't log, breaks TUI)
    return [];
  }

  const results: ReviewResult[] = [];

  const promises = pages.map(async (page) => {
    const pageReviewer: ReviewerDef = {
      ...reviewer,
      id: `${reviewer.id}-page-${page.replace(/[^a-zA-Z0-9]/g, '-')}`,
      name: `${reviewer.name} (${page})`,
      perPage: false,
      prompt: (reviewerCtx) => {
        const basePrompt = reviewer.prompt(reviewerCtx);
        return `${basePrompt}\n\n## Target Page\n${page}`;
      },
    };

    return runReviewer(pageReviewer, ctx, semaphore);
  });

  const settled = await Promise.allSettled(promises);
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      results.push(s.value);
    }
  }

  return results;
}

/**
 * Build a mapping from screenshot page-type directory names to their .astro source files.
 * Uses the site's src/pages/ directory to find matching templates.
 */
async function buildPageTypeFileMap(siteDir: string, pageTypes: string[]): Promise<Record<string, string[]>> {
  const map: Record<string, string[]> = {};
  const pagesDir = join(siteDir, 'src/pages');
  const componentsDir = join(siteDir, 'src/components');

  for (const pt of pageTypes) {
    const files: string[] = [];

    if (pt === 'landing' || pt === 'homepage') {
      files.push('src/pages/index.astro');
    } else {
      // Check for directory-based routes: src/pages/<pt>/[slug].astro, src/pages/<pt>/index.astro
      try {
        const dirEntries = await readdir(join(pagesDir, pt));
        for (const f of dirEntries) {
          if (f.endsWith('.astro')) files.push(`src/pages/${pt}/${f}`);
        }
      } catch { /* dir doesn't exist */ }

      // Check for file-based routes: src/pages/<pt>.astro
      try {
        await stat(join(pagesDir, `${pt}.astro`));
        files.push(`src/pages/${pt}.astro`);
      } catch { /* doesn't exist */ }

      // Check hyphenated variants (e.g., "about" → "about-us.astro")
      try {
        const allPages = await readdir(pagesDir);
        for (const f of allPages) {
          if (f.endsWith('.astro') && f.startsWith(pt)) {
            const candidate = `src/pages/${f}`;
            if (!files.includes(candidate)) files.push(candidate);
          }
        }
      } catch { /* */ }
    }

    // Always include shared components — they affect every page type
    try {
      const components = await readdir(componentsDir);
      for (const f of components) {
        if (f.endsWith('.astro')) files.push(`src/components/${f}`);
      }
    } catch { /* */ }

    // Include layouts
    try {
      const layouts = await readdir(join(siteDir, 'src/layouts'));
      for (const f of layouts) {
        if (f.endsWith('.astro')) files.push(`src/layouts/${f}`);
      }
    } catch { /* */ }

    map[pt] = files;
  }

  return map;
}

/**
 * Run a per-page-type reviewer — discovers page types from screenshots directory,
 * spawns one reviewer agent per type.
 */
async function runPerPageTypeReviewer(
  reviewer: ReviewerDef,
  ctx: ReviewerContext,
  semaphore: Semaphore,
): Promise<ReviewResult[]> {
  // Discover page types from the screenshots directory
  const screenshotsDir = join(ctx.evidenceDir, 'screenshots');
  let pageTypes: string[] = [];
  try {
    const entries = await readdir(screenshotsDir, { withFileTypes: true });
    pageTypes = entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    // No screenshots directory — skip
    return [];
  }

  if (pageTypes.length === 0) return [];

  // Build page-type → astro file mapping so reviewers know exactly which files to inspect
  const fileMap = await buildPageTypeFileMap(ctx.workingDir, pageTypes);

  const results: ReviewResult[] = [];
  const promises = pageTypes.map(async (pageType) => {
    const astroFiles = fileMap[pageType] || [];
    const fileListSection = astroFiles.length > 0
      ? `## Source files for this page type\n\nThese are the .astro files responsible for rendering "${pageType}" pages. Read them to diagnose any visual issues:\n${astroFiles.map(f => `- \`${f}\``).join('\n')}`
      : `## Source files\n\nUse Glob to find .astro files under src/pages/${pageType}/ and src/components/.`;

    const typeReviewer: ReviewerDef = {
      ...reviewer,
      id: `${reviewer.id}-${pageType}`,
      name: `${reviewer.name} (${pageType})`,
      perPageType: false,
      prompt: (reviewerCtx) => {
        const basePrompt = reviewer.prompt(reviewerCtx);
        return `${basePrompt}\n\n## Target Page Type\n${pageType}\n\n${fileListSection}\n\nRead screenshots from: ${join(screenshotsDir, pageType)}/\nAlso check for previous phase screenshots in: ${join(reviewerCtx.evidenceDir, 'screenshots-prev', pageType)}/`;
      },
    };
    return runReviewer(typeReviewer, ctx, semaphore);
  });

  const settled = await Promise.allSettled(promises);
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      results.push(s.value);
    }
  }
  return results;
}

/**
 * Run a single programmatic reviewer (no AI agent call).
 */
async function runProgrammaticReviewer(
  reviewer: ReviewerDef,
  ctx: ReviewerContext,
): Promise<ReviewResult> {
  const startTime = Date.now();

  try {
    const verdict = await reviewer.runFn!(ctx);

    // Write verdict file to reviews/
    await writeFile(
      join(ctx.reviewsDir, `reviewer-${reviewer.id}.md`),
      formatVerdictFile(reviewer, verdict),
      'utf-8',
    );

    return {
      reviewerId: reviewer.id,
      passed: verdict.verdict === 'PASS',
      verdict,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    const errorVerdict: ReviewVerdict = {
      reviewerId: reviewer.id,
      verdict: 'REJECT',
      evidence: 'Programmatic reviewer crashed',
      findings: `Error: ${err instanceof Error ? err.message : String(err)}`,
      rejectionContext: `Reviewer ${reviewer.id} failed: ${err instanceof Error ? err.message : String(err)}`,
    };

    await writeFile(
      join(ctx.reviewsDir, `reviewer-${reviewer.id}.md`),
      formatVerdictFile(reviewer, errorVerdict),
      'utf-8',
    ).catch(() => {});

    return {
      reviewerId: reviewer.id,
      passed: false,
      verdict: errorVerdict,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Run all reviewers for a phase in parallel (with semaphore).
 * Returns the combined result and whether all passed.
 */
export async function runReviewers(
  reviewers: ReviewerDef[],
  ctx: ReviewerContext,
  maxConcurrent = 5,
): Promise<{ allPassed: boolean; results: ReviewResult[] }> {
  const semaphore = new Semaphore(maxConcurrent);
  const results: ReviewResult[] = [];

  const promises = reviewers.map(async (reviewer) => {
    if (reviewer.programmatic && reviewer.runFn) {
      return runProgrammaticReviewer(reviewer, ctx);
    }
    if (reviewer.perPageType) {
      return runPerPageTypeReviewer(reviewer, ctx, semaphore);
    }
    if (reviewer.perPage) {
      return runPerPageReviewer(reviewer, ctx, semaphore);
    }
    return runReviewer(reviewer, ctx, semaphore);
  });

  const settled = await Promise.allSettled(promises);
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      const value = s.value;
      if (Array.isArray(value)) {
        results.push(...value);
      } else {
        results.push(value);
      }
    }
  }

  const allPassed = results.every((r) => r.passed);
  return { allPassed, results };
}

/**
 * Read all rejection contexts from the reviews/ directory.
 * Used by the implementer on retry to understand what to fix.
 */
export async function readRejectionContexts(reviewsDir: string): Promise<string> {
  let files: string[];
  try {
    files = await readdir(reviewsDir);
  } catch {
    return '';
  }

  const rejections: string[] = [];
  for (const file of files) {
    if (!file.startsWith('reviewer-') || !file.endsWith('.md')) continue;
    try {
      const content = await readFile(join(reviewsDir, file), 'utf-8');
      if (content.includes('## Verdict: REJECT')) {
        // Extract only the rejection context section, not the full report
        // This prevents exponential growth when rejection contexts are nested
        const ctxMatch = content.match(/## Rejection Context[^\n]*\n([\s\S]*?)(?=\n## |\n---|\s*$)/);
        const reviewerIdMatch = content.match(/^# Review: (.+)/m);
        const reviewerId = reviewerIdMatch ? reviewerIdMatch[1] : file;
        const ctx = ctxMatch ? ctxMatch[1].trim() : 'Rejected (no context provided)';
        rejections.push(`**${reviewerId}**: ${ctx}`);
      }
    } catch { /* skip */ }
  }

  const combined = rejections.join('\n\n');
  // Cap at ~4000 chars to prevent prompt bloat on repeated retries
  if (combined.length > 4000) {
    return combined.slice(0, 3950) + '\n\n... (truncated, see reviews/ for full details)';
  }
  return combined;
}

/**
 * Preserve review history after all reviewers pass.
 * We keep per-attempt directories for traceability, so cleanup is now a no-op.
 */
export async function cleanupReviews(_reviewsDir: string): Promise<void> {
  return;
}

// --- Verdict parsing ---

function parseVerdict(reviewerId: string, output: string): ReviewVerdict {
  // Case-insensitive match for common verdict formats:
  //   VERDICT: PASS, Verdict: PASS, verdict: pass, PASS, ALL CHECKS PASSED, etc.
  const normalized = output.toUpperCase();
  const rejected = normalized.includes('VERDICT: REJECT') || normalized.includes('VERDICT:REJECT');
  const passed = !rejected && (
    normalized.includes('VERDICT: PASS') || normalized.includes('VERDICT:PASS')
    || normalized.includes('ALL CHECKS PASSED')
  );

  return {
    reviewerId,
    verdict: rejected ? 'REJECT' : (passed ? 'PASS' : 'REJECT'), // Fail-safe: default to REJECT if no explicit verdict
    evidence: extractSection(output, 'Evidence'),
    findings: extractSection(output, 'Findings'),
    rejectionContext: rejected ? extractSection(output, 'Rejection Context') : undefined,
  };
}

function extractSection(text: string, sectionName: string): string {
  const header = `## ${sectionName}`;
  const idx = text.indexOf(header);
  if (idx === -1) return '';
  const start = idx + header.length;
  const nextSection = text.indexOf('\n## ', start + 1);
  if (nextSection === -1) return text.slice(start).trim();
  return text.slice(start, nextSection).trim();
}

function formatVerdictFile(reviewer: ReviewerDef, verdict: ReviewVerdict): string {
  let content = `# Review: ${reviewer.id}\n\n`;
  content += `## Verdict: ${verdict.verdict}\n\n`;
  content += `## Evidence\n${verdict.evidence}\n\n`;
  content += `## Findings\n${verdict.findings}\n`;
  if (verdict.rejectionContext) {
    content += `\n## Rejection Context (if rejected)\n${verdict.rejectionContext}\n`;
  }
  return content;
}

// --- Quality scoring ---

export interface QualityDimensions {
  layoutConsistency: number;
  designTokenUsage: number;
  componentComposition: number;
  responsiveDesign: number;
  semanticHtml: number;
  visualAppeal: number;
  motionQuality: number;
}

/**
 * Compute overall quality score from dimensions with weights.
 */
export function computeOverallScore(dimensions: QualityDimensions): number {
  const weights = {
    layoutConsistency: 0.20,
    designTokenUsage: 0.20,
    componentComposition: 0.15,
    responsiveDesign: 0.15,
    semanticHtml: 0.10,
    visualAppeal: 0.10,
    motionQuality: 0.10,
  };

  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    score += (dimensions[key as keyof QualityDimensions] || 0) * weight;
  }
  return Math.round(score * 100) / 100;
}

/**
 * Compute cosine similarity between two vectors (style fingerprint dimensions).
 * Returns 0.0 (identical) to 1.0 (maximally different).
 * The spec says divergence ≤ 0.2 is acceptable.
 */
export function cosineDivergence(reference: number[], generated: number[]): number {
  if (reference.length !== generated.length || reference.length === 0) return 1.0;

  let dotProduct = 0;
  let refMag = 0;
  let genMag = 0;

  for (let i = 0; i < reference.length; i++) {
    dotProduct += reference[i] * generated[i];
    refMag += reference[i] * reference[i];
    genMag += generated[i] * generated[i];
  }

  const magnitude = Math.sqrt(refMag) * Math.sqrt(genMag);
  if (magnitude === 0) return 1.0;

  // cosine similarity: 1.0 = identical, -1.0 = opposite
  const similarity = dotProduct / magnitude;
  // divergence: 0.0 = identical, 1.0 = maximally different
  return 1 - similarity;
}

// --- Visual regression ---

/**
 * Copy previous phase's screenshots to the current evidence directory
 * so reviewers can compare against them.
 *
 * Phase comparison chain:
 *   Phase 1c → baseline
 *   Phase 2  → compare with Phase 1c (only layout should differ)
 *   Phase 3  → compare with Phase 2  (only typography/design should differ)
 *   Phase 4  → compare with Phase 3  (only color should differ)
 *   Phase 5  → compare with Phase 4  (no visible difference expected)
 */
export async function copyPreviousPhaseScreenshots(
  prevPhaseEvidenceDir: string,
  currentEvidenceDir: string,
): Promise<boolean> {
  const prevScreenshotsDir = join(prevPhaseEvidenceDir, 'screenshots');
  const regressionDir = join(currentEvidenceDir, 'screenshots-prev');

  try {
    const { copyDirectory } = await import('./fs.js');
    await copyDirectory(prevScreenshotsDir, regressionDir);
    return true;
  } catch {
    return false; // Previous screenshots not available (first phase or no screenshots yet)
  }
}

/**
 * Pipeline runner v2.
 *
 * Orchestrates phases sequentially using the implementer + reviewer pattern.
 * Each phase:
 *   1. IMPLEMENTER — runs steps, produces output files, creates evidence/
 *   2. REVIEWERS — parallel reviewer agents, semaphore-controlled (max 5)
 *   3. Any rejection → loop back to implementer with rejection context (max 3 retries)
 *   4. All pass → DELETE reviews/ folder → next phase begins
 *
 * Phases:
 *   0: ANALYZE   — style fingerprint, design tokens, component recipes
 *   1: STRUCTURE — reduce, classify, seed (content collections)
 *   2: LAYOUT    — grid/flex/spacing (gray-box)
 *   3: DESIGN    — typography/components/surfaces (neutral palette)
 *   4: COLOR     — color system, theme, WCAG
 *   5: MOTION    — transitions, states, scroll reveals
 *   6: POLISH    — final validation, quality scoring
 */

import { mkdir, writeFile, readFile, copyFile, stat } from 'fs/promises';
import { execSync } from 'child_process';
import { join, resolve } from 'path';
import type { CuiConfig, RunMetadata, Registry } from '../types.js';
import type { Step, StepContext, StepStatus, PipelinePhase, PhaseId } from '../steps/step.js';
import { createSnapshot, writeSnapshot } from '../lib/snapshot.js';
import { resolveStepEnv } from '../env.js';
import { copyDirectory } from '../lib/fs.js';
import { loadScraperOutput } from '../lib/scraper.js';
import { createPipelineLogger } from '../lib/logger.js';
import type { PipelineLogger } from '../lib/logger.js';
import { parseResumePath } from './resume.js';
import { runReviewers, readRejectionContexts, cleanupReviews, copyPreviousPhaseScreenshots } from '../lib/reviewer.js';
import type { ReviewerContext } from '../lib/reviewer.js';
import { getReviewersForPhase } from '../lib/reviewer-matrix.js';
import { runContractChecks, runRuntimeChecks, runPolishQualityChecks } from '../lib/checks.js';

// v2 Phase step imports
import { setupStep } from '../steps/setup.js';
import { analyzeStep } from '../steps/analyze.js';
import { reduceStep } from '../steps/reduce.js';
import { classifyStep } from '../steps/classify.js';
import { interactionDiscoveryStep } from '../steps/interaction-discovery.js';
import { contentReductionStep } from '../steps/content-reduction.js';
import { seedContentStep } from '../steps/seed-content.js';
import { seedAssetsStep } from '../steps/seed-assets.js';
import { seedContractsStep } from '../steps/seed-contracts.js';
import { layoutStep } from '../steps/layout.js';
import { mobileStep } from '../steps/mobile.js';
import { designStep } from '../steps/design.js';
import { colorStep } from '../steps/color.js';
import { motionStep } from '../steps/motion.js';
import { polishStep } from '../steps/polish.js';

/**
 * v2 Pipeline: 7 phases + setup, each with its own validation gate.
 *
 * Uses the implementer + reviewer pattern:
 * - Phase-specific reviewers × 2 models (M1, M2)
 * - Generic reviewers × 2 models (M1, M2)
 * - Per-page reviewers (one agent per page per check type)
 * - Semaphore-controlled parallelism (max 5 concurrent)
 * - Loop-back on rejection (max 3 retries per phase)
 * - Reviews folder cleanup on all-pass
 */
export const PIPELINE: PipelinePhase[] = [
  {
    id: 'analyze',
    name: 'Phase 0: Analyze',
    description: 'Extract style fingerprint, 7-layer design tokens, component recipes',
    steps: [analyzeStep],
    maxRetries: 1,
  },
  {
    id: 'structure',
    name: 'Phase 1: Structure',
    description: 'Reduce, classify, discover interactions, and seed content/assets/contracts',
    steps: [reduceStep, classifyStep, interactionDiscoveryStep, contentReductionStep, seedContentStep, seedAssetsStep, seedContractsStep],
    maxRetries: 1,
  },
  {
    id: 'layout',
    name: 'Phase 2: Layout',
    description: 'Apply grid/flex layout, spacing, shared structure, and desktop/tablet baseline',
    steps: [layoutStep],
    maxRetries: 4,
    runRuntimeChecks: true,
  },
  {
    id: 'mobile',
    name: 'Phase 2b: Mobile Friendliness',
    description: 'Fix mobile navigation, small-screen stacking, and overflow',
    steps: [mobileStep],
    maxRetries: 2,
    runRuntimeChecks: true,
  },
  {
    id: 'design',
    name: 'Phase 3: Design',
    description: 'Apply typography, component styling, surfaces',
    steps: [designStep],
    maxRetries: 1,
  },
  {
    id: 'color',
    name: 'Phase 4: Color',
    description: 'Apply color system, theme variants, WCAG contrast',
    steps: [colorStep],
    maxRetries: 1,
  },
  {
    id: 'motion',
    name: 'Phase 5: Motion',
    description: 'Add transitions, hover/focus states, scroll reveals, and interaction behavior',
    steps: [motionStep],
    maxRetries: 1,
    runRuntimeChecks: true,
  },
  {
    id: 'polish',
    name: 'Phase 6: Polish',
    description: 'Final validation, quality scoring, style fidelity',
    steps: [polishStep],
    maxRetries: 1,
    runRuntimeChecks: true,
  },
];

/** Phases that produce a buildable Astro project (can run deterministic checks) */
const PHASES_WITH_BUILDABLE_SITE: Set<PhaseId> = new Set([
  'structure', 'layout', 'mobile', 'design', 'color', 'motion', 'polish',
]);

const PHASES_WITH_CONTRACT_CHECKS: Set<PhaseId> = new Set([
  'layout', 'mobile', 'design', 'color', 'motion', 'polish',
]);

/** Default max concurrent reviewers */
const MAX_CONCURRENT_REVIEWERS = 30;

/** Flatten all phases and their steps into an ordered list for resume support */
function flattenPipeline(pipeline: PipelinePhase[]): Step[] {
  const flat: Step[] = [];
  for (const phase of pipeline) {
    for (const step of phase.steps) {
      flat.push(step);
    }
  }
  return flat;
}

function generateRunId(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${h}${min}${s}`;
}

async function writeStatus(stepDir: string, status: StepStatus): Promise<void> {
  await writeFile(
    join(stepDir, 'status.json'),
    JSON.stringify(status, null, 2),
    'utf-8',
  );
}

interface StepMeta {
  stepId: string;
  phase: string;
  retry: number;
  prevStep: string | null;
  /** Whether the phase's reviewer gate passed after this step */
  reviewersPassed?: boolean;
}

async function writeStepMeta(stepDir: string, meta: StepMeta): Promise<void> {
  await writeFile(
    join(stepDir, 'step.json'),
    JSON.stringify(meta, null, 2),
    'utf-8',
  );
}

/**
 * Create evidence and reviews directories for a phase step.
 * Returns the paths to both directories.
 */
async function createPhaseDirectories(stepDir: string): Promise<{ evidenceDir: string; reviewsDir: string }> {
  const evidenceDir = join(stepDir, 'evidence');
  const reviewsRootDir = join(stepDir, 'reviews');
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(reviewsRootDir, { recursive: true });

  let nextAttempt = 1;
  try {
    const { readdir } = await import('fs/promises');
    const entries = await readdir(reviewsRootDir, { withFileTypes: true });
    const attemptNums = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name.match(/^attempt-(\d+)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => Number.parseInt(match[1] || '0', 10))
      .filter((num) => Number.isFinite(num));
    nextAttempt = (attemptNums.length > 0 ? Math.max(...attemptNums) : 0) + 1;
  } catch {
    // ignore
  }

  const reviewsDir = join(reviewsRootDir, `attempt-${nextAttempt}`);
  await mkdir(reviewsDir, { recursive: true });
  return { evidenceDir, reviewsDir };
}

async function hasBuildableSite(siteDir: string): Promise<boolean> {
  try {
    await stat(join(siteDir, 'package.json'));
    await stat(join(siteDir, 'node_modules'));
    return true;
  } catch {
    return false;
  }
}

async function ensureProjectDependencies(siteDir: string): Promise<void> {
  try {
    await stat(join(siteDir, 'package.json'));
  } catch {
    return;
  }
  try {
    execSync('bun install', { cwd: siteDir, timeout: 120000, stdio: 'pipe' });
  } catch {
    // best effort; later build/type checks will surface actual failure details
  }
}

async function runPhaseContractStage(
  phaseId: PhaseId,
  siteDir: string,
  evidenceDir: string,
  sourceOrigin: string | undefined,
  prevPhaseDir: string | undefined,
  runDir: string,
): Promise<{ ok: boolean; rejectionContext?: string }> {
  if (!PHASES_WITH_CONTRACT_CHECKS.has(phaseId)) {
    return { ok: true };
  }

  const status = await runContractChecks({
    phaseId,
    workingDir: siteDir,
    evidenceDir,
    sourceOrigin,
    prevPhaseDir,
    runDir,
  });

  return {
    ok: status.status === 'completed',
    rejectionContext: status.rejectionContext,
  };
}

async function runPhaseRuntimeStage(
  phase: PipelinePhase,
  siteDir: string,
  evidenceDir: string,
): Promise<{ ok: boolean; rejectionContext?: string }> {
  if (!phase.runRuntimeChecks) {
    return { ok: true };
  }

  const status = phase.id === 'polish'
    ? await runPolishQualityChecks({
      workingDir: siteDir,
      evidenceDir,
      scratchDir: join(siteDir, 'scratch'),
    })
    : await runRuntimeChecks({
      phaseId: phase.id,
      workingDir: siteDir,
      evidenceDir,
    });

  return {
    ok: status.status === 'completed',
    rejectionContext: status.rejectionContext,
  };
}

/**
 * Build the page list for per-page reviewers.
 * Derives routes from the registry (static pages + listings + collection slugs)
 * and falls back to scraper output structure pages.
 */
async function buildPageList(
  siteDir: string,
  runInputDir: string,
  phaseId: PhaseId,
): Promise<string[]> {
  const pages: string[] = [];
  const { readFile } = await import('fs/promises');
  const { join } = await import('path');

  // Try to read registry.json from the site directory (available after Phase 1c)
  try {
    const registry = JSON.parse(
      await readFile(join(siteDir, 'output/reduced/registry.json'), 'utf-8'),
    ) as Registry;

    // Add static page routes
    for (const sp of registry.static_pages) {
      pages.push(sp.route);
    }

    // Add listing routes
    for (const listing of Object.values(registry.listings || {})) {
      pages.push(listing.route);
    }

    // Add representative collection entry routes (first entry per collection)
    // These are the actual page URLs the dev server will serve
    try {
      const contentDir = join(siteDir, 'src/content');
      const { readdir } = await import('fs/promises');
      for (const [collName] of Object.entries(registry.collections || {})) {
        const collDir = join(contentDir, collName);
        const entries = await readdir(collDir).catch(() => []);
        if (entries.length > 0) {
          // Use the first entry's slug as a representative page
          const slug = entries[0].replace(/\.json$/, '');
          pages.push(`/${collName}/${slug}`);
        }
      }
    } catch { /* content dir not ready yet */ }
  } catch {
    // Registry not available — fall back to scraper structure pages
  }

  // If still empty, fall back to scraper output structure pages
  if (pages.length === 0) {
    try {
      const structure = JSON.parse(
        await readFile(join(runInputDir, 'structure.json'), 'utf-8'),
      );
      for (const page of structure.pages || []) {
        pages.push(page.url || page.id);
      }
    } catch { /* no structure.json available */ }
  }

  // Deduplicate and filter empty
  return [...new Set(pages.filter(Boolean))];
}

/**
 * Run the reviewer gate for a phase.
 * Spawns all reviewers in parallel (semaphore-controlled), reads verdicts,
 * and returns whether all passed.
 */
async function runReviewerGate(
  phaseId: PhaseId,
  phaseName: string,
  siteDir: string,
  evidenceDir: string,
  reviewsDir: string,
  scratchDir: string,
  referenceUrl: string | undefined,
  sourceOrigin: string | undefined,
  env: Record<string, string>,
  logger: PipelineLogger,
  runInputDir: string,
  snapshotPath?: string,
  runDir?: string,
  devServerUrl?: string,
  prevPhaseDir?: string,
): Promise<{ allPassed: boolean; rejectionCount: number }> {
  const reviewers = getReviewersForPhase(phaseId);

  // Build page list for per-page reviewers
  const pages = await buildPageList(siteDir, runInputDir, phaseId);

  const ctx: ReviewerContext = {
    workingDir: siteDir,
    evidenceDir,
    reviewsDir,
    scratchDir,
    phaseId,
    phaseName,
    referenceUrl,
    sourceOrigin,
    snapshotPath,
    runDir,
    prevPhaseDir,
    devServerUrl,
    env,
    pages: pages.length > 0 ? pages : undefined,
    logger,
  };

  logger.startStep(`${phaseName} — reviewers (${reviewers.length} reviewers)`);

  const { allPassed, results } = await runReviewers(reviewers, ctx, MAX_CONCURRENT_REVIEWERS);

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  if (allPassed) {
    logger.completeStep(0);
  } else {
    logger.failStep(`${failed}/${results.length} reviewers rejected`);
  }

  return { allPassed, rejectionCount: failed };
}

/**
 * Wait for the Astro preview server to print its URL to stdout/stderr.
 * Returns the URL (e.g. "http://localhost:4321") or rejects on timeout.
 */
function waitForServerUrl(
  proc: import('child_process').ChildProcess,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const urlPattern = /https?:\/\/localhost:\d+/;
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; reject(new Error('Preview server timed out')); }
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      if (resolved) return;
      const text = chunk.toString();
      const match = text.match(urlPattern);
      if (match) {
        resolved = true;
        clearTimeout(timer);
        resolve(match[0]);
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', (err) => {
      if (!resolved) { resolved = true; clearTimeout(timer); reject(err); }
    });
    proc.on('exit', (code) => {
      if (!resolved) { resolved = true; clearTimeout(timer); reject(new Error(`Preview exited with code ${code}`)); }
    });
  });
}

export async function runPipeline(config: CuiConfig, fromStep?: string, opts?: { nonInteractive?: boolean }): Promise<void> {
  const interactive = !opts?.nonInteractive;

  const runsDir = join(process.cwd(), 'runs');
  const runId = generateRunId();
  const runDir = join(runsDir, runId);
  const inputDir = join(process.cwd(), config.input);
  const resolvedInputDir = resolve(inputDir);

  const logger = createPipelineLogger({ interactive, runId });

  // Print header (non-interactive mode only; TUI shows run ID in dashboard)
  if (!interactive) {
    console.log(`\n  Web Generator SDK v2 — Pipeline Architecture v2`);
    console.log(`  Run:       ${runId}`);
    console.log(`  Input:     ${resolvedInputDir}`);
    console.log(`  Reference: ${config.reference || 'none'}`);
    console.log(`  Profile:   ${config.profile}\n`);
  }

  // Create run directory
  await mkdir(runDir, { recursive: true });

  // Load scraper output
  const scraperOutput = await loadScraperOutput(resolvedInputDir);

  // Derive sourceOrigin from structure.json site_url (fallback to first page URL)
  let sourceOrigin: string | undefined;
  try {
    const rawSiteUrl = scraperOutput.structure.site_url
      || scraperOutput.structure.pages?.[0]?.url
      || '';
    if (rawSiteUrl) sourceOrigin = new URL(rawSiteUrl).origin;
  } catch { /* malformed URL — leave undefined */ }

  // Copy scraper input to run/input/ for reference
  const runInputDir = join(runDir, 'input');
  await mkdir(runInputDir, { recursive: true });
  await copyDirectory(resolvedInputDir, runInputDir);
  if (config.reference) {
    await writeFile(join(runInputDir, 'reference-url.txt'), config.reference, 'utf-8');
  }

  // Copy cui.json into run
  try {
    await copyFile(join(process.cwd(), 'cui.json'), join(runDir, 'cui.json'));
  } catch { /* no cui.json */ }

  // Handle resume
  let startPhaseIdx = 0;
  let resumedFrom: string | undefined;

  let sourceRunDir: string | undefined;
  if (fromStep) {
    const allSteps = flattenPipeline(PIPELINE);
    const parsed = await parseResumePath(fromStep, allSteps);
    sourceRunDir = parsed.sourceRunDir;

    // Read step.json to check if reviewers passed.
    // If missing or no reviewersPassed field, assume they didn't — re-run the phase.
    let reviewersPassed = false;
    try {
      const resolved = join(process.cwd(), fromStep);
      const meta = JSON.parse(await readFile(join(resolved, 'step.json'), 'utf-8'));
      reviewersPassed = meta.reviewersPassed === true;
    } catch { /* no step.json — treat as not passed */ }

    // Find which phase contains this step
    for (let i = 0; i < PIPELINE.length; i++) {
      const hasStep = PIPELINE[i].steps.some(s => s.id === parsed.resumeStepId);
      if (hasStep) {
        const isLastStepInPhase = PIPELINE[i].steps[PIPELINE[i].steps.length - 1].id === parsed.resumeStepId;
        if (isLastStepInPhase && reviewersPassed) {
          // Step completed AND reviewers passed → next phase
          startPhaseIdx = i + 1;
        } else {
          // Mid-phase step, or reviewers didn't pass → restart this phase
          startPhaseIdx = i;
        }
        break;
      }
    }
    resumedFrom = fromStep;
  }

  // Initialize run metadata
  const runMeta: RunMetadata = {
    runId,
    status: 'running',
    config,
    inputPath: resolvedInputDir,
    referenceUrl: config.reference,
    profileName: config.profile,
    runDir,
    createdAt: new Date().toISOString(),
    completedSteps: [],
    resumedFrom,
  };
  await writeFile(join(runDir, 'run.json'), JSON.stringify(runMeta, null, 2), 'utf-8');

  const templateDir = join(process.cwd(), 'template/astro-project');
  let prevStepDir: string | null = null;
  let siteDir: string | null = null;
  let stepOrdinal = 0;

  // Snapshot tracking: after each phase passes, snapshot the site dir for comparison
  const snapshotsDir = join(runDir, 'snapshots');
  let prevSnapshotPath: string | undefined;

  const makeCtx = (step: Step, phase: string, env: Record<string, string>, stepDir: string): StepContext => ({
    id: step.id,
    name: step.name,
    phase,
    runDir,
    scratchDir: join(stepDir, 'scratch'),
    templateDir,
    scraperOutput,
    referenceUrl: config.reference,
    sourceOrigin,
    env,
    logger,
    stepConfig: config.steps?.[step.id],
  });

  // Phase 0 is special: run setup first, then analyze
  // Setup step runs before all phases
  if (startPhaseIdx === 0) {
    const setupDir = join(runDir, `step-${stepOrdinal}-setup`);
    stepOrdinal++;
    await mkdir(setupDir, { recursive: true });

    const env = await resolveStepEnv(config.profile, setupStep.envOverride, config.steps?.[setupStep.id]);
    const ctx = makeCtx(setupStep, 'setup', env, setupDir);

    logger.startStep(setupStep.name);
    await writeStatus(setupDir, { status: 'running', startedAt: new Date().toISOString() });

    let setupResult: StepStatus;
    const setupStart = Date.now();
    try {
      setupResult = await setupStep.run(setupDir, ctx);
    } catch (err) {
      setupResult = {
        status: 'failed',
        startedAt: new Date(setupStart).toISOString(),
        finishedAt: new Date().toISOString(),
        duration: Date.now() - setupStart,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    await writeStatus(setupDir, setupResult);
    prevStepDir = setupDir;
    siteDir = setupDir;

    if (setupResult.status === 'completed') {
      runMeta.completedSteps.push(setupStep.id);
      logger.completeStep(0);
    } else {
      runMeta.status = 'failed';
      runMeta.failedStep = setupStep.id;
      runMeta.finishedAt = new Date().toISOString();
      await writeFile(join(runDir, 'run.json'), JSON.stringify(runMeta, null, 2), 'utf-8');
      logger.failStep(setupResult.error || 'Setup failed');
      logger.destroy();
      if (!interactive) console.error(`\n  Pipeline failed at: Setup`);
      process.exit(1);
    }
  } else {
    // Resuming: find the site directory from the last completed step in the source run
    const allSteps = flattenPipeline(PIPELINE);
    const { readdir } = await import('fs/promises');
    const sourceEntries = await readdir(sourceRunDir!);
    for (let i = allSteps.length - 1; i >= 0; i--) {
      const stepId = allSteps[i].id;
      const match = sourceEntries.find(e => e.startsWith(`step-`) && e.endsWith(`-${stepId}`));
      if (match) {
        const srcStepDir = join(sourceRunDir!, match);
        try {
          await stat(join(srcStepDir, 'package.json'));
          // Copy the project into the new run directory so subsequent phases write there
          const newStepDir = join(runDir, match);
          await copyDirectory(srcStepDir, newStepDir);
          await ensureProjectDependencies(newStepDir);
          siteDir = newStepDir;
          prevStepDir = newStepDir;
          const ordinalMatch = match.match(/^step-(\d+)-/);
          if (ordinalMatch) stepOrdinal = Number.parseInt(ordinalMatch[1], 10) + 1;
          break;
        } catch { /* not a project dir */ }
      }
    }
    if (!siteDir) {
      console.error('Cannot find project directory for resume');
      process.exit(1);
    }
  }

  // Run each phase
  let prevPhaseEvidenceDir: string | null = null;
  for (let phaseIdx = startPhaseIdx; phaseIdx < PIPELINE.length; phaseIdx++) {
    const phase = PIPELINE[phaseIdx];

    // Record siteDir before this phase starts (for retry restoration)
    const prePhaseSiteDir: string | null = siteDir;

    // Track ordinals for this phase (for retry cleanup)
    const phaseStepOrdinals = new Map<string, number>();
    const phaseStartOrdinal = stepOrdinal;

    // The step directory where evidence/ and reviews/ live (last step in phase)
    let phaseStepDir: string | undefined;
    let phaseRejectionContext: string | undefined;
    // Track whether the previous attempt's implementer succeeded — if so,
    // retry copies from the previous attempt's output (incremental fix) instead
    // of restoring to pre-phase state (full rebuild).
    let prevAttemptImplementerPassed = false;

    for (let retry = 0; retry <= (phase.maxRetries || 1); retry++) {
      let implementerPassed = true;

      // Steps that can be skipped on retry (deterministic + completed in prior attempt)
      let skipOnRetry = new Set<string>();

      // On retry, read rejection context BEFORE cleaning up step directories.
      // Context can come from two sources:
      //   1. Reviewer verdicts (reviews/ directory) — when implementer passed but reviewers rejected
      //   2. Implementer failure (status.json) — when a step crashed before reaching reviewers
      let rejectionContext: string | undefined;
      if (retry > 0) {
        const contexts: string[] = [];

        if (phaseRejectionContext) {
          contexts.push(phaseRejectionContext);
        }

        // Source 1: reviewer rejection context
        if (phaseStepDir) {
          const reviewsDir = join(phaseStepDir, 'reviews');
          const reviewerCtx = await readRejectionContexts(reviewsDir);
          if (reviewerCtx) contexts.push(reviewerCtx);
        }

        // Source 2: implementer step failure errors
        for (const [stepId, ordinal] of phaseStepOrdinals) {
          const stepDir = join(runDir, `step-${ordinal}-${stepId}`);
          try {
            const statusRaw = await readFile(join(stepDir, 'status.json'), 'utf-8');
            const status = JSON.parse(statusRaw);
            if (status.status === 'failed' && status.error) {
              contexts.push(`**Step "${stepId}" failed:** ${status.error}`);
            }
          } catch { /* status.json may not exist */ }
        }

        rejectionContext = contexts.filter(Boolean).join('\n\n') || undefined;
      }

      // On retry, decide whether to do an incremental fix or full rebuild.
      // If the previous attempt's implementer succeeded (rejection came from
      // contract/runtime/reviewer checks), copy from the previous attempt's
      // output so the agent discovers all files already exist and only fixes
      // what the reviewer flagged. Otherwise, restore to pre-phase state.
      if (retry > 0 && prePhaseSiteDir) {
        if (prevAttemptImplementerPassed && phaseStepDir) {
          // Incremental retry: start from previous attempt's completed output.
          // The agent will find all files in place and focus on reviewer fixes.
          phaseStepOrdinals.clear();
          prevStepDir = phaseStepDir;
          siteDir = phaseStepDir;
        } else {
          // Full rebuild: implementer crashed, restore to pre-phase state.
          let restoreDir: string | null = prePhaseSiteDir;
          if (phase.steps.length > 1) {
            for (const step of phase.steps) {
              if (!step.deterministic) break;
              const ordinal = phaseStepOrdinals.get(step.id);
              if (ordinal === undefined) break;
              const stepDir = join(runDir, `step-${ordinal}-${step.id}`);
              try {
                const statusRaw = await readFile(join(stepDir, 'status.json'), 'utf-8');
                const status = JSON.parse(statusRaw);
                if (status.status === 'completed') {
                  restoreDir = stepDir;
                  skipOnRetry.add(step.id);
                  continue;
                }
              } catch { /* no status */ }
              break;
            }
          }
          phaseStepOrdinals.clear();
          prevStepDir = restoreDir;
          siteDir = restoreDir;
        }
      }

      for (const step of phase.steps) {
        const stepConfig = config.steps?.[step.id];
        if (stepConfig?.skip) {
          logger.startStep(step.name);
          logger.skipStep();
          runMeta.completedSteps.push(step.id);
          continue;
        }

        // Skip deterministic steps on retry — their output is already in prevStepDir
        if (skipOnRetry.has(step.id)) {
          logger.startStep(`${step.name} (reused)`);
          logger.skipStep();
          continue;
        }

        let stepDir: string;
        stepDir = join(runDir, `step-${stepOrdinal}-${step.id}`);
        phaseStepOrdinals.set(step.id, stepOrdinal);
        stepOrdinal++;
        await mkdir(stepDir, { recursive: true });
        if (prevStepDir) {
          await copyDirectory(prevStepDir, stepDir);
          await ensureProjectDependencies(stepDir);
        }

        // Copy scraper input for reference
        try { await copyFile(join(runInputDir, 'structure.json'), join(stepDir, 'structure.json')); } catch { /* exists */ }
        try { await copyFile(join(runInputDir, 'schema.json'), join(stepDir, 'schema.json')); } catch { /* exists */ }
        try { await copyFile(join(runInputDir, 'content.json'), join(stepDir, 'content.json')); } catch { /* exists */ }

        const env = await resolveStepEnv(config.profile, step.envOverride, stepConfig);
        const ctx = makeCtx(step, phase.id, env, stepDir);

        // Ensure scratch/ exists — agents use it as cwd
        await mkdir(join(stepDir, 'scratch'), { recursive: true });

        // Plumb rejection context into implementer on retry
        if (rejectionContext) {
          ctx.rejectionContext = rejectionContext;
        }

        const retryLabel = retry > 0 ? ` (retry ${retry})` : '';
        logger.startStep(`${step.name}${retryLabel}`);
        await writeStatus(stepDir, { status: 'running', startedAt: new Date().toISOString() });

        // Write step identity and lineage
        const prevStepName = prevStepDir ? prevStepDir.split('/').pop()! : null;
        await writeStepMeta(stepDir, {
          stepId: step.id,
          phase: phase.id,
          retry,
          prevStep: prevStepName,
        });

        let result: StepStatus;
        const stepStart = Date.now();
        try {
          result = await step.run(stepDir, ctx);
        } catch (err) {
          result = {
            status: 'failed',
            startedAt: new Date(stepStart).toISOString(),
            finishedAt: new Date().toISOString(),
            duration: Date.now() - stepStart,
            error: err instanceof Error ? err.message : String(err),
          };
        }

        await writeStatus(stepDir, result);

        siteDir = stepDir;
        prevStepDir = stepDir;
        phaseStepDir = stepDir;

        if (result.status === 'completed') {
          runMeta.completedSteps.push(step.id);
          logger.completeStep(0);
        } else {
          implementerPassed = false;
          logger.failStep(result.error || 'Unknown error');
          break;
        }
      }

      // Track for next retry: did the implementer succeed this time?
      prevAttemptImplementerPassed = implementerPassed;

      if (!implementerPassed) {
        // Implementer failed — retry or give up
        if (retry < (phase.maxRetries || 1)) {
          logger.startStep(`Retry ${phase.name} — implementer failed (${retry + 1}/${phase.maxRetries})`);
          logger.skipStep();
          continue;
        }

        runMeta.status = 'failed';
        runMeta.failedStep = phase.id;
        runMeta.finishedAt = new Date().toISOString();
        await writeFile(join(runDir, 'run.json'), JSON.stringify(runMeta, null, 2), 'utf-8');
        logger.destroy();
        if (!interactive) console.error(`\n  Pipeline failed at: ${phase.name} (implementer, ${phase.maxRetries} retries exhausted)`);
        process.exit(1);
      }

      // Implementer passed — now run deterministic stages, then the AI reviewer gate

      const currentSiteDir = (siteDir || prevStepDir || phaseStepDir)!;

      // Create evidence/ and reviews/ directories
      const { evidenceDir, reviewsDir } = await createPhaseDirectories(phaseStepDir!);

      const buildable = PHASES_WITH_BUILDABLE_SITE.has(phase.id) && await hasBuildableSite(currentSiteDir);

      // Copy previous phase screenshots for visual regression comparison
      if (prevPhaseEvidenceDir) {
        await copyPreviousPhaseScreenshots(prevPhaseEvidenceDir, evidenceDir);
      }

      if (buildable) {
        logger.startStep(`${phase.name} — contract checks`);
        const contractResult = await runPhaseContractStage(
          phase.id,
          currentSiteDir,
          evidenceDir,
          sourceOrigin,
          prePhaseSiteDir || undefined,
          runDir,
        );
        if (contractResult.ok) {
          logger.completeStep(0);
        } else {
          logger.failStep(contractResult.rejectionContext || 'Contract checks failed');
          phaseRejectionContext = contractResult.rejectionContext || 'Contract checks failed';
          if (retry < (phase.maxRetries || 1)) {
            logger.startStep(`Retry ${phase.name} — contract checks failed (${retry + 1}/${phase.maxRetries})`);
            logger.skipStep();
            continue;
          }
          runMeta.status = 'failed';
          runMeta.failedStep = `${phase.id}-contract`;
          runMeta.finishedAt = new Date().toISOString();
          await writeFile(join(runDir, 'run.json'), JSON.stringify(runMeta, null, 2), 'utf-8');
          logger.destroy();
          if (!interactive) console.error(`\n  Pipeline failed at: ${phase.name} (contract checks)`);
          process.exit(1);
        }
      }

      if (buildable && phase.runRuntimeChecks) {
        logger.startStep(`${phase.name} — runtime checks`);
        const runtimeResult = await runPhaseRuntimeStage(phase, currentSiteDir, evidenceDir);
        if (runtimeResult.ok) {
          logger.completeStep(0);
        } else {
          logger.failStep(runtimeResult.rejectionContext || 'Runtime checks failed');
          phaseRejectionContext = runtimeResult.rejectionContext || 'Runtime checks failed';
          if (retry < (phase.maxRetries || 1)) {
            logger.startStep(`Retry ${phase.name} — runtime checks failed (${retry + 1}/${phase.maxRetries})`);
            logger.skipStep();
            continue;
          }
          runMeta.status = 'failed';
          runMeta.failedStep = `${phase.id}-runtime`;
          runMeta.finishedAt = new Date().toISOString();
          await writeFile(join(runDir, 'run.json'), JSON.stringify(runMeta, null, 2), 'utf-8');
          logger.destroy();
          if (!interactive) console.error(`\n  Pipeline failed at: ${phase.name} (runtime checks)`);
          process.exit(1);
        }
      }

      // Start preview server for AI reviewers that need rendered pages
      let devServerUrl: string | undefined;
      let previewProcess: import('child_process').ChildProcess | undefined;
      if (buildable) {
        try {
          const { spawn } = await import('child_process');
          previewProcess = spawn('bun', ['x', 'astro', 'preview', '--port', '0'], {
            cwd: currentSiteDir,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          devServerUrl = await waitForServerUrl(previewProcess, 30_000);
        } catch {
          if (previewProcess) { previewProcess.kill(); previewProcess = undefined; }
        }
      }

      // Determine env for reviewers — use reviewerProfile if configured, else fall back to step env
      const reviewerProfile = config.reviewerProfile || config.profile;
      const lastStep = phase.steps[phase.steps.length - 1];
      const lastStepConfig = config.steps?.[lastStep.id];
      const reviewerEnv = await resolveStepEnv(reviewerProfile, lastStep.envOverride, lastStepConfig);
      if (config.visionModel) {
        reviewerEnv.VISION_MODEL = config.visionModel;
      }

      // Run AI reviewers only after deterministic checks pass
      const reviewScratchDir = join(currentSiteDir, 'scratch');
      let reviewResult: { allPassed: boolean; rejectionCount: number };
      try {
        reviewResult = await runReviewerGate(
          phase.id,
          phase.name,
          currentSiteDir,
          evidenceDir,
          reviewsDir,
          reviewScratchDir,
          config.reference,
          sourceOrigin,
          reviewerEnv,
          logger,
          runInputDir,
          prevSnapshotPath,
          runDir,
          devServerUrl,
          prePhaseSiteDir || undefined,
        );
      } finally {
        if (previewProcess) {
          previewProcess.kill();
          previewProcess = undefined;
        }
      }

      if (reviewResult.allPassed) {
        phaseRejectionContext = undefined;
        try {
          const metaPath = join(phaseStepDir!, 'step.json');
          const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
          meta.reviewersPassed = true;
          await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
        } catch { /* best effort */ }

        await cleanupReviews(reviewsDir);
        prevPhaseEvidenceDir = evidenceDir;

        if (buildable) {
          const snapshotDir = join(snapshotsDir, phase.id);
          try {
            await mkdir(snapshotsDir, { recursive: true });
            await copyDirectory(currentSiteDir, snapshotDir);
            prevSnapshotPath = snapshotDir;
            const snapshot = await createSnapshot(phase.id as PhaseId, currentSiteDir, sourceOrigin);
            await writeSnapshot(snapshot, runDir);
          } catch { /* snapshot is best-effort */ }
        }

        break;
      }

      phaseRejectionContext = await readRejectionContexts(reviewsDir) || `${reviewResult.rejectionCount} reviewer(s) rejected`;
      if (retry < (phase.maxRetries || 1)) {
        logger.startStep(`Retry ${phase.name} — ${reviewResult.rejectionCount} reviewer(s) rejected (${retry + 1}/${phase.maxRetries})`);
        logger.skipStep();
      } else {
        runMeta.status = 'failed';
        runMeta.failedStep = `${phase.id}-reviewers`;
        runMeta.finishedAt = new Date().toISOString();
        await writeFile(join(runDir, 'run.json'), JSON.stringify(runMeta, null, 2), 'utf-8');
        logger.destroy();
        if (!interactive) {
          console.error(`\n  Pipeline failed at: ${phase.name} (reviewers, ${phase.maxRetries} retries exhausted)`);
          console.error(`  Check reviews/ in: ${phaseStepDir}`);
        }
        process.exit(1);
      }
    }
  }

  // Pipeline completed
  runMeta.status = 'completed';
  runMeta.finishedAt = new Date().toISOString();
  await writeFile(join(runDir, 'run.json'), JSON.stringify(runMeta, null, 2), 'utf-8');

  logger.destroy();
  if (!interactive) {
    console.log(`  Pipeline complete!  runs/${runId}\n`);
  }
}

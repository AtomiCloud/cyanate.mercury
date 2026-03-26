/**
 * Pipeline runner.
 *
 * Orchestrates pipeline items (steps and loop groups) sequentially:
 * 1. Create run directory
 * 2. Copy input data
 * 3. For each item: copy previous step -> resolve env -> run -> write status
 * 4. Loop groups repeat their steps until all pass or max iterations hit
 */

import { mkdir, writeFile, copyFile } from 'fs/promises';
import { join, resolve } from 'path';
import type { CuiConfig, RunMetadata } from '../types.js';
import type { Step, StepContext, StepStatus, PipelineItem, StepLoop } from '../steps/step.js';
import { isStepLoop } from '../steps/step.js';
import { resolveStepEnv } from '../env.js';
import { copyDirectory } from '../lib/fs.js';
import { loadScraperOutput } from '../lib/scraper.js';
import { createPipelineLogger } from '../lib/logger.js';
import type { PipelineLogger } from '../lib/logger.js';
import { parseResumePath, copyCompletedSteps } from './resume.js';

// Pipeline definition: steps and loop groups in order
import { setupStep } from '../steps/setup.js';
import { extractTokensStep } from '../steps/extract-tokens.js';
import { planLayoutStep } from '../steps/plan-layout.js';
import { planBriefStep } from '../steps/plan-brief.js';
import { generateStep } from '../steps/generate.js';
import { validateStep } from '../steps/validate.js';
import { functionalCheckStep } from '../steps/functional-check.js';
import { iterateStep } from '../steps/iterate.js';
import { qualityTestStep } from '../steps/quality-test.js';

export const PIPELINE: PipelineItem[] = [
  setupStep,
  extractTokensStep,
  planLayoutStep,
  planBriefStep,
  generateStep,
  // Validate -> Functional Check -> Iterate -> Quality Test loop (up to 3 times)
  {
    id: 'fix-loop',
    name: 'Validate & Fix',
    steps: [validateStep, functionalCheckStep, iterateStep, qualityTestStep],
    maxIterations: 3,
  },
];

/**
 * Flatten the pipeline into an ordered list of { step, iteration } tuples.
 * Loop groups expand into repeated steps.
 */
function flattenPipeline(pipeline: PipelineItem[]): { step: Step; iteration: number; loopId?: string }[] {
  const flat: { step: Step; iteration: number; loopId?: string }[] = [];

  for (const item of pipeline) {
    if (isStepLoop(item)) {
      const loop = item as StepLoop;
      for (const step of loop.steps) {
        flat.push({ step, iteration: 1, loopId: loop.id });
      }
    } else {
      flat.push({ step: item as Step, iteration: 1 });
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

export async function runPipeline(config: CuiConfig, fromStep?: string, opts?: { nonInteractive?: boolean }): Promise<void> {
  const interactive = !opts?.nonInteractive;
  const logger = createPipelineLogger({ interactive });

  const runsDir = join(process.cwd(), 'runs');
  const runId = generateRunId();
  const runDir = join(runsDir, runId);
  const inputDir = join(process.cwd(), config.input);
  const resolvedInputDir = resolve(inputDir);

  // Print header (only once, above the TUI)
  console.log(`\n  Web Generator SDK v2`);
  console.log(`  Run:       ${runId}`);
  console.log(`  Input:     ${resolvedInputDir}`);
  console.log(`  Reference: ${config.reference || 'none'}`);
  console.log(`  Profile:   ${config.profile}\n`);

  // Create run directory
  await mkdir(runDir, { recursive: true });

  // Load scraper output
  const scraperOutput = await loadScraperOutput(resolvedInputDir);

  // Copy scraper input to run/input/ for reference
  const runInputDir = join(runDir, 'input');
  await mkdir(runInputDir, { recursive: true });
  await copyDirectory(resolvedInputDir, runInputDir);
  if (config.reference) {
    await writeFile(join(runInputDir, 'reference-url.txt'), config.reference, 'utf-8');
  }

  // Copy cui.json into run
  await copyFile(join(process.cwd(), 'cui.json'), join(runDir, 'cui.json'));

  // Handle resume
  let startItemIdx = 0;
  let resumedFrom: string | undefined;

  if (fromStep) {
    const { resumeStepIdx } = await parseResumePath(fromStep, flattenPipeline(PIPELINE).map(e => e.step));
    startItemIdx = resumeStepIdx;
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

  const makeCtx = (step: Step, env: Record<string, string>): StepContext => ({
    id: step.id,
    name: step.name,
    runDir,
    templateDir,
    scraperOutput,
    referenceUrl: config.reference,
    env,
    logger,
  });

  for (let itemIdx = 0; itemIdx < PIPELINE.length; itemIdx++) {
    const item = PIPELINE[itemIdx];

    if (isStepLoop(item)) {
      const loop = item as StepLoop;

      for (let iteration = 1; iteration <= loop.maxIterations; iteration++) {
        let allPassed = true;
        let loopPrevDir = prevStepDir;

        for (const step of loop.steps) {
          const stepConfig = config.steps?.[step.id];
          if (stepConfig?.skip) continue;

          const stepDirName = `step-${0}-${step.id}`; // step dir naming handled below
          const stepDir = join(runDir, stepDirName);
          await mkdir(stepDir, { recursive: true });

          if (loopPrevDir) await copyDirectory(loopPrevDir, stepDir);
          try { await copyFile(join(runInputDir, 'structure.json'), join(stepDir, 'structure.json')); } catch { /* exists */ }
          try { await copyFile(join(runInputDir, 'schema.json'), join(stepDir, 'schema.json')); } catch { /* exists */ }
          try { await copyFile(join(runInputDir, 'content.json'), join(stepDir, 'content.json')); } catch { /* exists */ }

          const env = await resolveStepEnv(config.profile, step.envOverride, stepConfig);
          const ctx = makeCtx(step, env);

          logger.startStep(step.name);
          await writeStatus(stepDir, { status: 'running', startedAt: new Date().toISOString() });

          let result: StepStatus;
          const startTime = Date.now();
          try {
            result = await step.run(stepDir, ctx);
          } catch (err) {
            result = {
              status: 'failed',
              startedAt: new Date(startTime).toISOString(),
              finishedAt: new Date().toISOString(),
              duration: Date.now() - startTime,
              error: err instanceof Error ? err.message : String(err),
            };
          }

          await writeStatus(stepDir, result);
          loopPrevDir = stepDir;
          prevStepDir = stepDir;

          if (result.status === 'completed') {
            runMeta.completedSteps.push(step.id);
            logger.completeStep(0);
          } else {
            allPassed = false;
            logger.failStep(result.error || 'Unknown error');
          }
        }

        if (allPassed) break;
      }

    } else {
      const step = item as Step;
      const stepConfig = config.steps?.[step.id];

      if (stepConfig?.skip) {
        logger.startStep(step.name);
        logger.skipStep();
        runMeta.completedSteps.push(step.id);
        continue;
      }

      const stepDir = join(runDir, `step-${0}-${step.id}`);
      await mkdir(stepDir, { recursive: true });

      if (prevStepDir) await copyDirectory(prevStepDir, stepDir);
      try { await copyFile(join(runInputDir, 'structure.json'), join(stepDir, 'structure.json')); } catch { /* exists */ }
      try { await copyFile(join(runInputDir, 'schema.json'), join(stepDir, 'schema.json')); } catch { /* exists */ }
      try { await copyFile(join(runInputDir, 'content.json'), join(stepDir, 'content.json')); } catch { /* exists */ }

      const env = await resolveStepEnv(config.profile, step.envOverride, stepConfig);
      const ctx = makeCtx(step, env);

      logger.startStep(step.name);
      await writeStatus(stepDir, { status: 'running', startedAt: new Date().toISOString() });

      let result: StepStatus;
      const startTime = Date.now();
      try {
        result = await step.run(stepDir, ctx);
      } catch (err) {
        result = {
          status: 'failed',
          startedAt: new Date(startTime).toISOString(),
          finishedAt: new Date().toISOString(),
          duration: Date.now() - startTime,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      await writeStatus(stepDir, result);
      prevStepDir = stepDir;

      if (result.status === 'completed') {
        runMeta.completedSteps.push(step.id);
        logger.completeStep(0);
      } else {
        runMeta.status = 'failed';
        runMeta.failedStep = step.id;
        runMeta.finishedAt = new Date().toISOString();
        await writeFile(join(runDir, 'run.json'), JSON.stringify(runMeta, null, 2), 'utf-8');
        logger.failStep(result.error || 'Unknown error');
        logger.destroy();
        console.error(`\n  Pipeline failed at: ${step.name}`);
        console.error(`  Retry: bun src/index.ts --from runs/${runId}/step-0-${step.id}`);
        process.exit(1);
      }
    }
  }

  // Pipeline completed
  runMeta.status = 'completed';
  runMeta.finishedAt = new Date().toISOString();
  await writeFile(join(runDir, 'run.json'), JSON.stringify(runMeta, null, 2), 'utf-8');

  logger.destroy();
  console.log(`  Pipeline complete!  runs/${runId}\n`);
}

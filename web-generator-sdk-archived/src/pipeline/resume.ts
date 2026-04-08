/**
 * Resume logic for --from flag.
 *
 * Parses the source step path, copies completed steps into the new run,
 * and returns the step index to resume from.
 */

import { readFile, stat, mkdir } from 'fs/promises';
import { join, dirname, basename } from 'path';
import type { Step } from '../steps/step.js';
import { copyDirectory } from '../lib/fs.js';

interface ResumeInfo {
  sourceRunDir: string;
  /** The step ID to resume from (e.g., "layout", "seed") */
  resumeStepId: string;
}

export async function parseResumePath(fromPath: string, steps: Step[]): Promise<ResumeInfo> {
  const resolved = join(process.cwd(), fromPath);
  const dirName = basename(resolved);
  const sourceRunDir = dirname(resolved);

  // Try reading step.json for identity (preferred)
  let resumeStepId: string;
  try {
    const stepMeta = JSON.parse(await readFile(join(resolved, 'step.json'), 'utf-8'));
    resumeStepId = stepMeta.stepId;
    console.log(`  [resume] Read step.json — step: ${stepMeta.stepId}, phase: ${stepMeta.phase}, retry: ${stepMeta.retry}`);
    if (stepMeta.prevStep) {
      console.log(`  [resume] Previous step: ${stepMeta.prevStep}`);
    }
  } catch {
    // Fallback: parse directory name
    const match = dirName.match(/^step-(\d+)-(.+)$/);
    if (!match) {
      throw new Error(`Invalid --from path: expected step-N-{id} directory with step.json, got "${dirName}"`);
    }
    resumeStepId = match[2];
    console.log(`  [resume] No step.json found, parsed step ID from directory name: ${resumeStepId}`);
  }

  // Validate the step ID exists in the pipeline
  const stepExists = steps.some(s => s.id === resumeStepId);
  if (!stepExists) {
    throw new Error(`Step "${resumeStepId}" not found in pipeline. Valid steps: ${steps.map(s => s.id).join(', ')}`);
  }

  // Validate the source step is completed
  const statusPath = join(resolved, 'status.json');
  try {
    const statusData = JSON.parse(await readFile(statusPath, 'utf-8'));
    if (statusData.status !== 'completed') {
      throw new Error(`Cannot resume from step "${dirName}" with status "${statusData.status}" - must be completed`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Step not found: ${resolved}`);
    }
    throw e;
  }

  return { sourceRunDir, resumeStepId };
}

export async function copyCompletedSteps(
  sourceRunDir: string,
  newRunDir: string,
  steps: Step[],
  resumeStepIdx: number,
): Promise<void> {
  for (let i = 0; i < resumeStepIdx; i++) {
    const step = steps[i];
    const stepDirName = `step-${i}-${step.id}`;
    const sourceStepDir = join(sourceRunDir, stepDirName);
    const destStepDir = join(newRunDir, stepDirName);

    try {
      await stat(sourceStepDir);
      await mkdir(destStepDir, { recursive: true });
      await copyDirectory(sourceStepDir, destStepDir);
      console.log(`  [resume] Copied ${stepDirName}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Source step directory missing: ${sourceStepDir}`);
      }
      throw e;
    }
  }
}

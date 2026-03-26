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
  resumeStepIdx: number;
}

export async function parseResumePath(fromPath: string, steps: Step[]): Promise<ResumeInfo> {
  const resolved = join(process.cwd(), fromPath);
  const dirName = basename(resolved); // e.g., "step-4-generate"
  const match = dirName.match(/^step-(\d+)-(.+)$/);

  if (!match) {
    throw new Error(`Invalid --from path: expected step-N-{id}, got "${dirName}"`);
  }

  const resumeStepIdx = parseInt(match[1], 10);
  const sourceRunDir = dirname(resolved);

  // Validate the source step exists and is completed
  const statusPath = join(resolved, 'status.json');
  try {
    const status = JSON.parse(await readFile(statusPath, 'utf-8'));
    if (status.status !== 'completed') {
      throw new Error(`Cannot resume from step "${dirName}" with status "${status.status}" - must be completed`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Step not found: ${resolved}`);
    }
    throw e;
  }

  // Validate step index
  if (resumeStepIdx >= steps.length) {
    throw new Error(`Step index ${resumeStepIdx} out of range (0-${steps.length - 1})`);
  }

  return { sourceRunDir, resumeStepIdx };
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

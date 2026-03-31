/**
 * Env profile loader.
 *
 * Parses .env.{profile} files and resolves per-step env overrides.
 * Priority (highest wins):
 *   1. cui.json step.env (direct env vars)
 *   2. cui.json step.profile
 *   3. step.envOverride (hardcoded in step definition)
 *   4. cui.json profile (default)
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type { StepConfigOverride } from './types.js';
import type { StepEnvOverride } from './steps/step.js';

export async function loadEnvProfile(profileName: string): Promise<Record<string, string>> {
  const envPath = join(process.cwd(), `.env.${profileName}`);
  let content: string;
  try {
    content = await readFile(envPath, 'utf-8');
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT') {
      throw new Error(`.env.${profileName} not found at ${envPath}`);
    }
    throw e;
  }

  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

export async function resolveStepEnv(
  defaultProfile: string,
  stepEnvOverride?: StepEnvOverride,
  configStepsOverride?: StepConfigOverride,
): Promise<Record<string, string>> {
  let env = await loadEnvProfile(defaultProfile);

  // Step-level profile override (hardcoded in step def)
  if (stepEnvOverride?.profile) {
    const overrideEnv = await loadEnvProfile(stepEnvOverride.profile);
    env = { ...env, ...overrideEnv };
  }

  // cui.json per-step profile override
  if (configStepsOverride?.profile) {
    const overrideEnv = await loadEnvProfile(configStepsOverride.profile);
    env = { ...env, ...overrideEnv };
  }

  // cui.json per-step direct env vars
  if (configStepsOverride?.env) {
    env = { ...env, ...configStepsOverride.env };
  }

  // Step-level direct env vars (highest priority)
  if (stepEnvOverride?.env) {
    env = { ...env, ...stepEnvOverride.env };
  }

  return env;
}

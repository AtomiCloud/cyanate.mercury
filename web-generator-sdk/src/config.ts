/**
 * Configuration for the Web Generator SDK
 */

import { join } from 'path';
import { cwd } from 'process';

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  // Path to the Astro template (relative to project root)
  TEMPLATE_PATH: join(cwd(), 'template/astro-project'),

  // Path where generated projects will be created
  PROJECTS_PATH: join(cwd(), 'projects'),

  // Available custom skills
  SKILLS: [
    'extract-design-tokens',
    'design-brief',
    'astro-codegen',
    'validate-and-repair',
    'test-and-quality',
    'iterate-and-fix',
  ],

  // Third-party skills to load
  THIRD_PARTY_SKILLS: {
    shadcn: 'shadcn/ui',       // Shadcn UI components
    frontend: 'frontend-design', // Frontend design guidance
    astro: 'astro',             // Astro framework knowledge
  },

  // Maximum iterations for validation/repair loop
  MAX_ITERATIONS: 3,

  // Timeout for agent queries (in milliseconds)
  QUERY_TIMEOUT: 300000, // 5 minutes
} as const;

/**
 * Environment variables
 */
export function getEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getApiKey(): string {
  return getEnvVar('ANTHROPIC_API_KEY');
}

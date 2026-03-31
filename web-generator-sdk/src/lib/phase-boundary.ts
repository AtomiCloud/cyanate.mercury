/**
 * Phase boundary enforcement for the v2 pipeline.
 *
 * Diffs files between steps and rejects forbidden property additions
 * based on phase ownership rules from CLAUDE.md.
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, extname, relative } from 'path';
import type { PhaseId } from '../steps/step.js';

// --- Types ---

export interface BoundaryViolation {
  file: string;
  line: number;
  phase: PhaseId;
  forbidden: string;
  matchedText: string;
  description: string;
}

export interface PhaseOwnership {
  phase: PhaseId;
  /** File globs this phase is allowed to modify */
  allowedPatterns: RegExp[];
  /** Property patterns this phase must NOT add */
  forbiddenAdditions: RegExp[];
  /** Human-readable description of what this phase owns */
  owns: string;
}

// --- Phase ownership rules ---

const PHASE_RULES: PhaseOwnership[] = [
  {
    phase: 'layout',
    owns: 'Grid/flex, spacing, responsive breakpoints',
    allowedPatterns: [
      /\.astro$/,
      /\.css$/,
    ],
    forbiddenAdditions: [
      /\bfont-family\b/,
      /\bfont-size\b/,
      /\bfont-weight\b/,
      /\bletter-spacing\b/,
      /\bline-height\b/,
      /\bcolor\s*:/,
      /\bbackground-color\b/,
      /\btransition\b/,
      /\banimation\b/,
      /\bonmouse\w+\s*=/,
    ],
  },
  {
    phase: 'design',
    owns: 'Typography, component styling, surfaces (neutral palette)',
    allowedPatterns: [
      /\.astro$/,
      /\.css$/,
      /\.tsx$/,
    ],
    forbiddenAdditions: [
      /\btransition-[\w-]+\s*:/,
      /\btransition\s*:/,
      /\banimation\b/,
      /\bonmouse\w+\s*=/,
      /\bhover:\s*(?!text-)(?!border)(?!bg-)(?!shadow)/,
      /\btranslateY\b/,
      /\btranslateX\b/,
      /\bscale\(/,
    ],
  },
  {
    phase: 'color',
    owns: 'Color system, themes (globals.css CSS variables only)',
    allowedPatterns: [
      /globals\.css$/,
    ],
    forbiddenAdditions: [
      /\bfont-size\b/,
      /\bfont-weight\b/,
      /\bgrid-template/,
      /\bgrid-cols/,
      /\bflex\b/,
      /\bgap-/,
      /\bpadding\b/,
      /\bmargin\b/,
      /\bpy-/,
      /\bpx-/,
      /\bmy-/,
      /\bmx-/,
      /\bp-/,
      /\bm-/,
    ],
  },
  {
    phase: 'motion',
    owns: 'Transitions, hover/focus states, scroll reveals',
    allowedPatterns: [
      /\.astro$/,
      /\.css$/,
      /\.tsx$/,
    ],
    forbiddenAdditions: [
      /\boklch\(/,
      /\bhsl\(/,
      /\brgb\(/,
      /\b#[0-9a-fA-F]{3,8}\b/,
      /\bfont-size\b/,
      /\bfont-weight\b/,
      /\bfont-family\b/,
      /\bgrid-template/,
      /\bgrid-cols/,
      /\bgap-/,
    ],
  },
];

// --- Core functions ---

/**
 * Check phase boundaries by comparing current step files against forbidden patterns.
 * This runs on the CURRENT step's output — it doesn't need a diff, it scans for
 * properties that the current phase should not be adding.
 */
export async function checkPhaseBoundary(
  projectDir: string,
  phase: PhaseId,
): Promise<BoundaryViolation[]> {
  const rule = PHASE_RULES.find(r => r.phase === phase);
  if (!rule) return []; // No rules for this phase = no boundary to enforce

  const violations: BoundaryViolation[] = [];
  const srcDir = join(projectDir, 'src');
  const files = await walkFiles(srcDir, ['.astro', '.css', '.tsx', '.ts']);

  for (const file of files) {
    const relFile = relative(projectDir, file);

    // Check if file is in allowed patterns
    const isAllowed = rule.allowedPatterns.some(p => p.test(relFile));
    if (!isAllowed) {
      // File type not allowed for this phase — but only report if it was likely modified
      // We can't diff here, so skip non-allowed file types silently
      continue;
    }

    try {
      const content = await readFile(file, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comments
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('<!--') || trimmed.startsWith('/*')) continue;

        for (const pattern of rule.forbiddenAdditions) {
          if (pattern.test(line)) {
            // Extract the matched text for context
            const match = line.match(pattern);
            violations.push({
              file: relFile,
              line: i + 1,
              phase,
              forbidden: pattern.source,
              matchedText: match ? match[0] : '(pattern match)',
              description: `${phase} phase is not allowed to add "${match ? match[0] : pattern.source}" — ${rule.owns} only`,
            });
          }
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return violations;
}

/**
 * Compare two step output directories and check for phase boundary violations
 * in the diff (only check ADDED lines).
 */
export async function checkPhaseBoundaryDiff(
  prevProjectDir: string,
  currProjectDir: string,
  phase: PhaseId,
): Promise<BoundaryViolation[]> {
  const rule = PHASE_RULES.find(r => r.phase === phase);
  if (!rule) return [];

  const violations: BoundaryViolation[] = [];

  // Walk current step's files
  const srcDir = join(currProjectDir, 'src');
  const files = await walkFiles(srcDir, ['.astro', '.css', '.tsx', '.ts']);

  for (const file of files) {
    const relFile = relative(currProjectDir, file);
    const isAllowed = rule.allowedPatterns.some(p => p.test(relFile));
    if (!isAllowed) continue;

    const currContent = await readFile(file, 'utf-8').catch(() => '');
    const prevFile = join(prevProjectDir, relFile);
    const prevContent = await readFile(prevFile, 'utf-8').catch(() => '');

    // Simple diff: find lines in current that aren't in previous
    const prevLines = new Set(prevContent.split('\n'));
    const currLines = currContent.split('\n');

    for (let i = 0; i < currLines.length; i++) {
      const line = currLines[i];
      if (prevLines.has(line)) continue; // Unchanged line, skip

      // This is a new or modified line — check against forbidden patterns
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('<!--') || trimmed.startsWith('/*')) continue;

      for (const pattern of rule.forbiddenAdditions) {
        if (pattern.test(line)) {
          const match = line.match(pattern);
          violations.push({
            file: relFile,
            line: i + 1,
            phase,
            forbidden: pattern.source,
            matchedText: match ? match[0] : '(pattern match)',
            description: `${phase} phase added "${match ? match[0] : pattern.source}" which is outside its ownership (${rule.owns})`,
          });
        }
      }
    }
  }

  return violations;
}

/** Format violations for embedding in a reviewer prompt */
export function formatBoundaryViolations(violations: BoundaryViolation[]): string {
  if (violations.length === 0) {
    return 'No phase boundary violations detected.';
  }

  const lines = ['## Phase Boundary Violations', ''];
  lines.push(`Found ${violations.length} violation(s):`);
  lines.push('');

  const grouped = new Map<string, BoundaryViolation[]>();
  for (const v of violations) {
    const key = v.file;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(v);
  }

  for (const [file, fileViolations] of grouped) {
    lines.push(`### ${file}`);
    for (const v of fileViolations.slice(0, 10)) {
      lines.push(`- Line ${v.line}: ${v.description}`);
    }
    if (fileViolations.length > 10) {
      lines.push(`  ... and ${fileViolations.length - 10} more`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function walkFiles(dir: string, exts: string[]): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git' || entry.name === 'scratch') continue;
        results.push(...await walkFiles(fullPath, exts));
      } else if (exts.includes(extname(entry.name))) {
        results.push(fullPath);
      }
    }
  } catch {
    // dir doesn't exist
  }
  return results;
}

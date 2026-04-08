import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import type { InteractionManifest, InteractionPattern, PageContent } from '../types.js';
import { validateInteractionManifestData } from '../lib/validate-boundary.js';
import { loadRegistryFromDir } from '../lib/semantics.js';

function walkStrings(value: unknown, visitor: (text: string) => void): void {
  if (typeof value === 'string') {
    visitor(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visitor);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      walkStrings(item, visitor);
    }
  }
}

function detectPatternType(text: string): InteractionPattern['type'] {
  const lower = text.toLowerCase();
  if (lower.includes('modal') || lower.includes('dialog')) return 'modal';
  if (lower.includes('popup')) return 'popup';
  if (lower.includes('accordion')) return 'accordion';
  if (lower.includes('tab')) return 'tabs';
  if (lower.includes('search')) return 'search';
  if (lower.includes('filter') || lower.includes('sort')) return 'filter';
  if (lower.includes('form') || lower.includes('book') || lower.includes('appointment')) return 'form';
  return 'fragment';
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'interaction';
}

function normalizeRoute(route: string): string {
  return route.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function normalizePageRoute(urlOrRoute: string): string {
  try {
    return normalizeRoute(new URL(urlOrRoute).pathname || '/');
  } catch {
    return normalizeRoute(urlOrRoute);
  }
}

function collectInteractionPatterns(pages: PageContent[]): InteractionManifest {
  const patternMap = new Map<string, InteractionPattern>();
  const pageMap = new Map<string, { ids: Set<string>; triggers: Set<string> }>();

  for (const page of pages) {
    const route = normalizePageRoute(page.url || '/');
    const pageEntry = pageMap.get(route) || { ids: new Set<string>(), triggers: new Set<string>() };

    walkStrings(page.content, (text) => {
      const fragmentMatches = text.matchAll(/#([a-zA-Z][\w:-]*)/g);
      for (const match of fragmentMatches) {
        const target = `#${match[1]}`;
        const id = `${page.pagetype}-${slugify(match[1])}`;
        const type = detectPatternType(text);
        pageEntry.ids.add(match[1]);
        pageEntry.triggers.add(target);
        if (!patternMap.has(id)) {
          patternMap.set(id, {
            id,
            type,
            trigger: target,
            target,
            pageType: page.pagetype,
            route,
            description: `Discovered ${type} interaction from content reference ${target}`,
          });
        }
      }

      const lower = text.toLowerCase();
      const keywordDetections: Array<{ type: InteractionPattern['type']; regex: RegExp; requiresStrongEvidence?: boolean }> = [
        { type: 'modal', regex: /modal|dialog/ },
        { type: 'popup', regex: /popup|#contact-us-popup|elementor-action:action=popup:open/ },
        { type: 'accordion', regex: /accordion|faq/ },
        { type: 'tabs', regex: /\btabs?\b/, requiresStrongEvidence: true },
        { type: 'search', regex: /\bsearch\b/, requiresStrongEvidence: true },
        { type: 'filter', regex: /\bfilter\b|\bsort\b/, requiresStrongEvidence: true },
        { type: 'form', regex: /\bform\b|appointment|book now|contact us/ },
      ];
      for (const { type, regex, requiresStrongEvidence } of keywordDetections) {
        if (!regex.test(lower)) continue;
        if (requiresStrongEvidence && !/(placeholder|input|select|textarea|button|submit|query|results|tab-pane|tab-panel|filter)/.test(lower)) {
          continue;
        }
        const id = `${page.pagetype}-${type}`;
        if (!patternMap.has(id)) {
          patternMap.set(id, {
            id,
            type,
            pageType: page.pagetype,
            route,
            description: `Detected ${type} pattern from content text`,
          });
        }
      }
    });

    pageMap.set(route, pageEntry);
  }

  return {
    patterns: Array.from(patternMap.values()).sort((a, b) => a.id.localeCompare(b.id)),
    pages: Array.from(pageMap.entries()).map(([route, page]) => ({
      route,
      ids: Array.from(page.ids).sort(),
      triggers: Array.from(page.triggers).sort(),
    })).sort((a, b) => a.route.localeCompare(b.route)),
  };
}

export const interactionDiscoveryStep: Step = {
  id: 'interaction-discovery',
  name: 'Phase 1c: Interaction Discovery',
  description: 'Discover hash-fragment and interactive content patterns from the source content',
  deterministic: true,

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    try {
      const registry = await loadRegistryFromDir(workingDir);
      const manifest = collectInteractionPatterns(ctx.scraperOutput.content.pages);
      const validated = validateInteractionManifestData(manifest, registry);

      await mkdir(join(workingDir, 'output/reduced'), { recursive: true });
      await mkdir(join(workingDir, 'scratch'), { recursive: true });

      await writeFile(
        join(workingDir, 'output/reduced/interaction-manifest.json'),
        JSON.stringify(validated, null, 2),
        'utf-8',
      );

      await writeFile(
        join(workingDir, 'scratch', 'interaction-manifest.json'),
        JSON.stringify(validated, null, 2),
        'utf-8',
      );

      return {
        status: 'completed',
        startedAt: new Date(startTime).toISOString(),
        finishedAt: new Date().toISOString(),
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        status: 'failed',
        startedAt: new Date(startTime).toISOString(),
        finishedAt: new Date().toISOString(),
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

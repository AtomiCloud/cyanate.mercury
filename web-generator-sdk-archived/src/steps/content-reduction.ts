/**
 * Phase 1c2: CONTENT REDUCTION (AI)
 *
 * Analyzes each page type's content and produces a reduction spec that separates:
 * - Static CMS-friendly content (flat fields, max 2-3 levels of nesting)
 * - Dynamic bindings (collection queries, prev/next navigation, sidebar listings, globals)
 *
 * One LLM call per pagetype (not per page). The LLM returns a reduction spec,
 * which is then applied programmatically to all pages of that type.
 */

import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import type {
  DynamicBinding,
  ReducedPageContent,
  BindingsManifest,
  ReductionSpec,
  Registry,
  ReducedMeta,
} from '../types.js';
import { agentQuery } from '../lib/agent.js';
import { slugToFilename } from '../lib/seed-helpers.js';

function buildReductionPrompt(
  pagetype: string,
  count: number,
  isCollection: boolean,
  collectionName: string | null,
  ordered: boolean,
  schema: string,
  richestSample: string,
  registry: Registry,
  globalKeys: string[],
): string {
  const collectionsContext = Object.entries(registry.collections)
    .map(([name, c]) => `  - ${name} (source_pagetype: ${c.source_pagetype}, ordered: ${c.ordered ?? false})`)
    .join('\n');

  // Extract top-level field names from the richest sample for the completeness requirement
  let sampleFieldNames: string[] = [];
  try {
    const parsed = JSON.parse(richestSample);
    const content = parsed.content || parsed;
    sampleFieldNames = Object.keys(content);
  } catch { /* best effort */ }
  const fieldList = sampleFieldNames.length > 0
    ? sampleFieldNames.map(k => `  - ${k}`).join('\n')
    : '  (see sample above)';

  return `You are a content architect. Classify every field in a page's content into one of three buckets: static content, dynamic binding, or explicitly dropped.

## Context

### Page Type: ${pagetype}
- Instance count: ${count}
- Is collection entry: ${isCollection}${collectionName ? ` (collection: ${collectionName})` : ''}
- Has ordered navigation (prev/next): ${ordered}

### Available Collections (from registry.json)
${collectionsContext || '  (none)'}

### Global Keys (already extracted to src/data/)
${globalKeys.length > 0 ? globalKeys.map(k => `  - ${k}`).join('\n') : '  (none identified)'}

### Page Schema
\`\`\`json
${schema.slice(0, 5000)}
\`\`\`

### Richest Sample Content
\`\`\`json
${richestSample.slice(0, 12000)}
\`\`\`

## Task

Classify EVERY top-level field into exactly one bucket. Output ONLY valid JSON, no markdown fences.

Shape:
{
  "static_fields": {
    "<output_field_name>": {
      "source": "<dot.path.in.content or top-level key>",
      "flatten_to": "object" | "string" | "array"
    }
  },
  "dynamic_bindings": [
    {
      "type": "collection_query" | "prev_next" | "sidebar_listing" | "global",
      "field": "<top-level content field name>",
      "collection": "<collection name from registry>",
      "display": "<carousel|grid|list|cards|categorized_list>",
      "limit": <number or omit>,
      "group_by": "<field name or omit>"
    }
  ],
  "drop_fields": [
    { "field": "<field name>", "reason": "<why it is safe to discard>" }
  ]
}

## CRITICAL: Complete Field Accounting

The top-level fields in this page type are:
${fieldList}

**Every one of these fields MUST appear in exactly one of:**
- \`static_fields\` (via a "source" that starts with the field name)
- \`dynamic_bindings\` (via "field" matching the field name)
- \`drop_fields\` (via "field" matching the field name, with a reason)

A programmatic checker will verify completeness. Missing fields = invalid spec = retry.

## Classification Rules

1. **Global chrome** → dynamic_bindings type "global": Field matches a global key (${globalKeys.join(', ')}), or contains nav menus / footer / floating widgets identical across all pages.

2. **Collection references** → dynamic_bindings type "collection_query": Field contains a LIST of items linking to a known collection's pages. Set "limit" to item count.

3. **Sidebar listings** → dynamic_bindings type "sidebar_listing": Field is a categorized/grouped list from another collection.

4. **Prev/next navigation** → dynamic_bindings type "prev_next": Only for ordered collections.

5. **Static content** → static_fields: **Page-specific content that varies per instance.** This includes profile data, descriptions, images, titles, biographies, qualifications, dates — anything unique to this page. Flatten to max 2-3 levels:
   - Section objects → { heading, body, image, cta }
   - Lists of simple items stay as arrays of objects
   - Preserve semantic structure: hero, profile data, sections, testimonials

6. **Drop fields** → drop_fields: ONLY purely presentational metadata with zero content value (HTML form IDs, CSS classes, auto-generated breadcrumbs). You MUST provide a reason. **When in doubt, classify as static.**

## Important
- Do NOT hardcode specific content values — produce a structural template
- Every "collection" value MUST be one of: ${Object.keys(registry.collections).join(', ') || '(none)'}
- prev_next bindings are ONLY valid for ordered collections
- Output ONLY the JSON object, nothing else`;
}

function getValueAtPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function flattenToDepth(obj: unknown, maxDepth: number, currentDepth = 0): unknown {
  if (currentDepth >= maxDepth || obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => flattenToDepth(item, maxDepth, currentDepth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    result[key] = flattenToDepth(value, maxDepth, currentDepth + 1);
  }
  return result;
}

/** Normalize drop_fields to a set of field names (handles both old string[] and new {field,reason}[] format) */
function getDropFieldNames(dropFields: ReductionSpec['drop_fields']): Set<string> {
  const names = new Set<string>();
  for (const item of dropFields) {
    if (typeof item === 'string') names.add(item);
    else if (item && typeof item === 'object' && 'field' in item) names.add(item.field);
  }
  return names;
}

/**
 * Validate that every top-level field in content is accounted for in the spec.
 * Returns unaccounted field names. Empty array = all fields covered.
 */
function validateFieldCompleteness(
  contentKeys: string[],
  spec: ReductionSpec,
): string[] {
  // Collect all fields claimed by each bucket
  const claimed = new Set<string>();

  // static_fields: "source" starts with the field name (could be "doctor_profile.name" → claims "doctor_profile")
  for (const mapping of Object.values(spec.static_fields)) {
    const topLevel = mapping.source.split('.')[0];
    claimed.add(topLevel);
  }

  // dynamic_bindings: "field" is the top-level field name
  for (const binding of spec.dynamic_bindings) {
    if (binding.field) claimed.add(binding.field);
  }

  // drop_fields
  for (const name of getDropFieldNames(spec.drop_fields)) {
    claimed.add(name);
  }

  return contentKeys.filter(k => !claimed.has(k));
}

function applyReductionSpec(
  content: Record<string, unknown>,
  spec: ReductionSpec,
): { static_content: Record<string, unknown>; dynamic_bindings: DynamicBinding[] } {
  const staticContent: Record<string, unknown> = {};
  const dropSet = getDropFieldNames(spec.drop_fields);

  // Apply static field mappings
  for (const [outputField, mapping] of Object.entries(spec.static_fields)) {
    const value = getValueAtPath(content, mapping.source);
    if (value !== undefined) {
      staticContent[outputField] = flattenToDepth(value, 3);
    }
  }

  // If no static_fields defined but there's content, include non-dropped, non-dynamic fields
  if (Object.keys(spec.static_fields).length === 0) {
    const dynamicFields = new Set(spec.dynamic_bindings.map(b => b.field));
    for (const [key, value] of Object.entries(content)) {
      if (!dropSet.has(key) && !dynamicFields.has(key)) {
        staticContent[key] = flattenToDepth(value, 3);
      }
    }
  }

  return {
    static_content: staticContent,
    dynamic_bindings: spec.dynamic_bindings,
  };
}

function parseReductionSpec(raw: string, registry: Registry): ReductionSpec {
  // Strip markdown fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const parsed = JSON.parse(cleaned);

  // Validate structure
  if (!parsed.static_fields || typeof parsed.static_fields !== 'object') {
    parsed.static_fields = {};
  }
  if (!Array.isArray(parsed.dynamic_bindings)) {
    parsed.dynamic_bindings = [];
  }
  if (!Array.isArray(parsed.drop_fields)) {
    parsed.drop_fields = [];
  }

  // Validate collection references
  const validCollections = new Set(Object.keys(registry.collections));
  for (const binding of parsed.dynamic_bindings) {
    if (binding.collection && !validCollections.has(binding.collection) && binding.type !== 'global') {
      throw new Error(`Binding references unknown collection "${binding.collection}". Valid: ${[...validCollections].join(', ')}`);
    }
    if (binding.type === 'prev_next') {
      const coll = registry.collections[binding.collection];
      if (!coll?.ordered) {
        throw new Error(`prev_next binding for "${binding.collection}" but collection is not marked as ordered`);
      }
    }
  }

  return parsed as ReductionSpec;
}

function deriveSlug(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] || 'index';
  } catch {
    return slugToFilename(url);
  }
}

function deriveRoute(url: string, siteUrl?: string): string {
  try {
    const pathname = new URL(url).pathname;
    return pathname.replace(/\/$/, '') || '/';
  } catch {
    return url;
  }
}

export const contentReductionStep: Step = {
  id: 'content-reduction',
  name: 'Phase 1c2: Content Reduction',
  description: 'Separate static CMS content from dynamic collection bindings per pagetype',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    try {
      const reducedDir = join(workingDir, 'output/reduced');
      const outputDir = join(reducedDir, 'content-reduced');
      await mkdir(outputDir, { recursive: true });

      const meta: ReducedMeta = JSON.parse(await readFile(join(reducedDir, 'meta.json'), 'utf-8'));
      const registry: Registry = JSON.parse(await readFile(join(reducedDir, 'registry.json'), 'utf-8'));

      // Build lookup: pagetype -> collection info
      const pagetypeToCollection = new Map<string, { name: string; ordered: boolean }>();
      for (const [collName, coll] of Object.entries(registry.collections)) {
        pagetypeToCollection.set(coll.source_pagetype, {
          name: collName,
          ordered: coll.ordered ?? false,
        });
      }

      const globalKeys = meta.global_keys || [];
      const allReducedPages: ReducedPageContent[] = [];

      // Process each pagetype
      for (const pageType of meta.page_types) {
        // Log progress via step name (logger doesn't have a generic log method)

        // Read schema and richest sample
        let schema = '{}';
        let richestSample = '{}';
        try {
          schema = await readFile(join(reducedDir, 'types', pageType.pagetype, 'schema.json'), 'utf-8');
        } catch { /* no schema */ }
        try {
          richestSample = await readFile(join(reducedDir, 'types', pageType.pagetype, 'samples', 'richest.json'), 'utf-8');
        } catch { /* no sample */ }

        const collInfo = pagetypeToCollection.get(pageType.pagetype);
        const isCollection = !!collInfo;
        const collectionName = collInfo?.name ?? null;
        const ordered = collInfo?.ordered ?? false;

        const prompt = buildReductionPrompt(
          pageType.pagetype,
          pageType.count,
          isCollection,
          collectionName,
          ordered,
          schema,
          richestSample,
          registry,
          globalKeys,
        );

        const result = await agentQuery({
          prompt,
          cwd: workingDir,
          env: ctx.env,
          stepName: ctx.name,
          logger: ctx.logger,
        });

        // Parse the reduction spec and save for debugging
        const spec = parseReductionSpec(result, registry);
        const specDir = join(reducedDir, 'types', pageType.pagetype);
        await mkdir(specDir, { recursive: true });
        await writeFile(join(specDir, 'reduction-spec.json'), JSON.stringify(spec, null, 2), 'utf-8');

        // Completeness check: every top-level content field must be accounted for.
        // Use the richest sample's content keys as the reference.
        let referenceKeys: string[] = [];
        try {
          const parsed = JSON.parse(richestSample);
          referenceKeys = Object.keys(parsed.content || parsed);
        } catch { /* best effort */ }

        const unaccounted = referenceKeys.length > 0
          ? validateFieldCompleteness(referenceKeys, spec)
          : [];

        // Salvage unaccounted fields as static content in the spec
        if (unaccounted.length > 0) {
          for (const field of unaccounted) {
            spec.static_fields[field] = { source: field, flatten_to: 'object' };
          }
          // Save updated spec with salvaged fields
          await writeFile(join(specDir, 'reduction-spec.json'), JSON.stringify(spec, null, 2), 'utf-8');
          await writeFile(join(specDir, 'salvaged-fields.json'), JSON.stringify(unaccounted), 'utf-8');
        }

        // Apply to all pages of this pagetype
        const pages = ctx.scraperOutput.content.pages.filter(p => p.pagetype === pageType.pagetype);
        for (const page of pages) {
          const slug = deriveSlug(page.url);
          const route = deriveRoute(page.url);
          const { static_content, dynamic_bindings } = applyReductionSpec(page.content, spec);

          const reduced: ReducedPageContent = {
            pagetype: pageType.pagetype,
            slug,
            route,
            static_content,
            dynamic_bindings,
          };

          allReducedPages.push(reduced);
          await writeFile(
            join(outputDir, `${pageType.pagetype}-${slugToFilename(slug)}.json`),
            JSON.stringify(reduced, null, 2),
            'utf-8',
          );
        }

        // Spec applied: dynamic_bindings, static_fields, drop_fields tracked per pagetype
      }

      // Build bindings manifest
      const manifest = buildBindingsManifest(allReducedPages, registry);
      await writeFile(
        join(outputDir, 'bindings-manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8',
      );

      // Content reduction complete

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

function buildBindingsManifest(pages: ReducedPageContent[], registry: Registry): BindingsManifest {
  const pagesMap: Record<string, DynamicBinding[]> = {};
  const collectionUsage = new Map<string, Array<{ pagetype: string; field: string; display?: string }>>();
  const prevNextCollections = new Set<string>();
  const globalFields = new Set<string>();

  for (const page of pages) {
    const key = `${page.pagetype}/${page.slug}`;
    pagesMap[key] = page.dynamic_bindings;

    for (const binding of page.dynamic_bindings) {
      if (binding.type === 'global') {
        globalFields.add(binding.field);
      } else if (binding.type === 'prev_next' && binding.collection) {
        prevNextCollections.add(binding.collection);
      } else if (binding.collection) {
        if (!collectionUsage.has(binding.collection)) {
          collectionUsage.set(binding.collection, []);
        }
        // Avoid duplicate entries
        const existing = collectionUsage.get(binding.collection)!;
        if (!existing.some(e => e.pagetype === page.pagetype && e.field === binding.field)) {
          existing.push({
            pagetype: page.pagetype,
            field: binding.field,
            display: binding.display,
          });
        }
      }
    }
  }

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    pages: pagesMap,
    collection_queries: Array.from(collectionUsage.entries()).map(([collection, used_by]) => ({
      collection,
      used_by,
    })),
    prev_next_collections: Array.from(prevNextCollections),
    global_fields: Array.from(globalFields),
  };
}

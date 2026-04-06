/**
 * Phase 1b: CLASSIFY (AI)
 *
 * Classify page types and define site architecture — collections, routing, layouts.
 * Reads reduced output and produces registry.json.
 */

import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery } from '../lib/agent.js';
import { validateRegistryWithMeta, validateReducedMetaStrict } from '../lib/validate-boundary.js';

export const classifyStep: Step = {
  id: 'classify',
  name: 'Phase 1b: Classify',
  description: 'Classify page types and define site architecture',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const reducedDir = join(workingDir, 'output/reduced');

    // Read meta.json
    const meta = await readFile(join(reducedDir, 'meta.json'), 'utf-8');
    const parsedMeta = validateReducedMetaStrict(JSON.parse(meta));

    // Collect all type schemas and samples
    let typesContext = '';
    try {
      const typesDir = join(reducedDir, 'types');
      const typeNames = await readdir(typesDir);
      for (const typeName of typeNames) {
        const schemaFile = join(typesDir, typeName, 'schema.json');
        try {
          const schema = await readFile(schemaFile, 'utf-8');
          typesContext += `\n### ${typeName}/schema.json\n\`\`\`json\n${schema.slice(0, 5000)}\n\`\`\`\n`;
        } catch { /* no schema */ }

        // Read richest sample
        const richestFile = join(typesDir, typeName, 'samples', 'richest.json');
        try {
          const sample = await readFile(richestFile, 'utf-8');
          typesContext += `\n### ${typeName}/samples/richest.json\n\`\`\`json\n${sample.slice(0, 3000)}\n\`\`\`\n`;
        } catch { /* no sample */ }
      }
    } catch { /* no types dir */ }

    const rejectionSection = ctx.rejectionContext
      ? `\n## Prior Reviewer Feedback (Retry)\n\nThe previous attempt was rejected by reviewers. Address these issues:\n\n${ctx.rejectionContext}\n\n`
      : '';

    const prompt = `You are a site architect. Analyze the reduced scraper data and produce a registry.json that defines the site architecture.

${rejectionSection}

## meta.json
\`\`\`json
${meta}
\`\`\`
${typesContext}

## Task

Create a \`registry.json\` file with THIS EXACT TOP-LEVEL SHAPE:

\`\`\`json
{
  "layouts": {
    "main": {
      "description": "...",
      "page_types": ["team_listing", "blog_listing"]
    }
  },
  "collections": {
    "doctors": {
      "source_pagetype": "doctor_profile",
      "slug_field": "url",
      "slug_extract": "last_path_segment",
      "listable_by": ["doctor_listing"],
      "filterable_by": [],
      "ordered": false
    }
  },
  "listings": {
    "doctor_listing": {
      "route": "/doctor-category/[specialty]",
      "queries": [
        { "collection": "doctors", "filter_by_param": "specialty" }
      ],
      "paginated": false,
      "searchable": true,
      "search_fields": ["slug", "specialty"]
    }
  },
  "static_pages": [
    { "pagetype": "landing", "route": "/" }
  ],
  "navigation": {
    "source": "...",
    "structure": "..."
  },
  "interactive_patterns": []
}
\`\`\`

## CRITICAL SHAPE RULES
- \`layouts\` MUST be an object keyed by layout id, NOT an array
- \`collections\` MUST be an object keyed by collection name, NOT an array
- \`listings\` MUST be an object keyed by listing id, NOT an array
- Do NOT include helper sections like \`coverage\` or \`validation\`
- Do NOT use \`null\` anywhere in registry.json
- Use \`[]\` for empty arrays
- Use only valid JSON

## Section rules

### 1. layouts
Only group page types that truly share a layout template. Each layout has:
- description: what this layout looks like
- page_types: array of pagetype strings that use this layout
- layouts are presentation groupings only; they do NOT determine coverage ownership

### 2. collections
For each multi-instance CONTENT pagetype, define a content collection:
- source_pagetype: which pagetype provides the content
- slug_field: which exact content field/path contains the URL slug
- if no explicit slug field exists, use \`"slug_field": "url"\` and \`"slug_extract": "last_path_segment"\`
- listable_by: which listing pagetypes display this collection
- filterable_by: array/string using exact content field/path names, or [] if none
- ordered: true if the content samples contain previous/next page navigation (e.g., navigation.previous / navigation.next with adjacent page links). This means entries have a sequential relationship and prev/next should be derived from collection order at template time, not from scraped links.
- ordered: false or omit if entries are independent (no prev/next navigation)

### 3. listings
For each listing/filtering/archive page:
- route: normalized Astro-style route pattern (use \`[slug]\`, \`[category]\`, etc. — not \`{slug}\`)
- queries: array of { collection, group_by?, filter_by_param? }
- paginated: boolean
- searchable: boolean (true for any listing with > 10 items)
- search_fields: array of exact content field/path names to search

### 4. static_pages
Single-instance pages only:
- pagetype + route for each
- this array may be empty if the dataset has no singleton pagetypes worth routing as static pages

### 5. navigation
- source: path to navigation data
- structure: description of nav structure

### 6. interactive_patterns (optional)
Identify interactive UI patterns from the source site that need implementation:
- Look for hash links (#popup, #modal, #book-now, etc.) in the content samples
- Look for form actions, search bars, filtering UIs, tabs, accordions
- For each pattern found, describe: { id, type, trigger, description }

## FIELD SELECTION RULES
- \`slug_field\`, \`filterable_by\`, and \`search_fields\` MUST use exact keys/paths that appear in the provided schema/sample JSON
- The only allowed virtual slug field is \`url\`; when you use it, also set \`slug_extract\` to \`"last_path_segment"\`
- Do NOT invent \`slug\` unless the sample/schema explicitly contains \`slug\`
- Do NOT invent aliases like \`title\`, \`name\`, \`doctor_name\`, \`specialty\`, \`category_name\`, or \`date\` unless those exact keys appear in the samples
- Prefer \`slug\` if present in the sample/schema; otherwise use \`url\` with \`slug_extract: "last_path_segment"\`; otherwise use the exact nested path seen in the provided data
- If a field is not clearly present in schema/sample artifacts, do not guess it
- If the reduced metadata provides no field evidence for a pagetype, prefer \`filterable_by: []\`, omit \`filter_by_param\`, and keep \`search_fields: []\`

## COVERAGE RULES
Each pagetype in meta.json must appear in exactly ONE ownership bucket:
1. \`collections.*.source_pagetype\`
2. \`listings\` entry whose key matches the pagetype
3. \`static_pages[].pagetype\`

Layouts are NOT ownership buckets.
Do NOT place the same pagetype in multiple ownership buckets.
In particular:
- single-instance content pages usually belong in \`static_pages\`
- multi-instance content/detail types usually belong in \`collections\`
- listing/archive/filter pagetypes usually belong in \`listings\` and should use the same id as the source pagetype when possible
- do not mark a multi-instance pagetype as a static page

## DATASET HEURISTICS
- Use collections for multi-instance detail/content pagetypes like doctor profiles, blog posts, generic pages, legal pages
- Use listings for listing/archive/filter pagetypes like blog listings, doctor listings, category archives, date archives
- Use static_pages for single-instance landing/about/services-style pages

## SELF-CHECK BEFORE WRITING
Verify all of these are true before writing registry.json:
- collections is an object, not array
- listings is an object, not array
- no null values
- all slug/search/filter fields exist exactly in schema/sample data, except \`slug_field: "url"\` with \`slug_extract: "last_path_segment"\`
- when reduced metadata exposes no field universe for a pagetype, avoid guessed filter/search fields entirely
- no pagetype appears in more than one ownership bucket
- no route collisions between listings and static pages
- static_pages may be empty

Write the result as registry.json in: ${reducedDir}`;

    await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
    });

    // Validate registry.json was created and semantically sound
    try {
      const registry = JSON.parse(await readFile(join(reducedDir, 'registry.json'), 'utf-8'));
      validateRegistryWithMeta(registry, parsedMeta);
    } catch (e) {
      return {
        status: 'failed',
        startedAt: new Date(startTime).toISOString(),
        finishedAt: new Date().toISOString(),
        duration: Date.now() - startTime,
        error: `registry.json invalid or missing: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    return {
      status: 'completed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    };
  },
};

/**
 * Phase 1b: CLASSIFY (AI)
 *
 * Classify page types and define site architecture — collections, routing, layouts.
 * Reads reduced output and produces registry.json.
 */

import { readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery } from '../lib/agent.js';

export const classifyStep: Step = {
  id: 'classify',
  name: 'Phase 1b: Classify',
  description: 'Classify page types and define site architecture',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    const reducedDir = join(workingDir, 'output/reduced');

    // Read meta.json
    const meta = await readFile(join(reducedDir, 'meta.json'), 'utf-8');

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

Create a \`registry.json\` file with the following structure:

### 1. layouts
Group page types that share a layout template. Each layout has:
- description: what this layout looks like
- page_types: array of pagetype strings that use this layout

### 2. collections
For each multi-instance pagetype, define a content collection:
- source_pagetype: which pagetype provides the content
- slug_field: which content field contains the URL slug
- listable_by: which listing pages display this collection
- filterable_by: what field can be used for filtering

### 3. listings
For each listing/filtering page:
- route: the URL pattern
- queries: array of { collection, group_by?, filter_by_param? }
- paginated: boolean
- searchable: boolean (true for any listing with > 10 items)
- search_fields: array of content field names to search (e.g., ["title", "body", "specialty"])

### 4. static_pages
Single-instance pages:
- pagetype + route for each

### 5. navigation
- source: path to navigation data
- structure: description of nav structure

## Validation Rules
- Every pagetype in meta.json must appear in exactly ONE of: layouts.*.page_types, collections.*.source_pagetype, or static_pages[].pagetype
- Every collection's source_pagetype must have multi: true in meta.json
- No orphan page types
- sum(static_pages.length) + sum(collection source counts) === total_pages

Write the result as registry.json in: ${reducedDir}`;

    await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
    });

    // Validate registry.json was created
    try {
      const registry = JSON.parse(await readFile(join(reducedDir, 'registry.json'), 'utf-8'));
      if (!registry.layouts || !registry.collections || !registry.static_pages) {
        return {
          status: 'failed',
          startedAt: new Date(startTime).toISOString(),
          finishedAt: new Date().toISOString(),
          duration: Date.now() - startTime,
          error: 'registry.json missing required sections (layouts, collections, static_pages)',
        };
      }
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

/**
 * Phase 2: LAYOUT
 *
 * Build actual pages from content collections and apply grid/flex layout,
 * spacing, responsive breakpoints. Gray-box mode — no color, no typography.
 *
 * The prompt is fully generic — all page/collection/route details come from
 * registry.json, never hardcoded.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import type { Registry } from '../types.js';
import { agentQuery } from '../lib/agent.js';
import { validateRegistry, validateDesignTokens } from '../lib/validate-boundary.js';

export const layoutStep: Step = {
  id: 'layout',
  name: 'Phase 2: Layout',
  description: 'Build pages from content and apply grid/flex layout (gray-box mode)',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    // Read style fingerprint and design tokens from scratch
    let fingerprint: string;
    let tokens: string;
    try {
      fingerprint = await readFile(join(ctx.scratchDir, 'style-fingerprint.json'), 'utf-8');
    } catch {
      return { status: 'failed', startedAt: new Date(startTime).toISOString(), finishedAt: new Date().toISOString(), duration: Date.now() - startTime, error: 'Missing style-fingerprint.json in scratch directory' };
    }
    try {
      tokens = await readFile(join(ctx.scratchDir, 'design-tokens.json'), 'utf-8');
      validateDesignTokens(JSON.parse(tokens));
    } catch (e) {
      return { status: 'failed', startedAt: new Date(startTime).toISOString(), finishedAt: new Date().toISOString(), duration: Date.now() - startTime, error: `Invalid design-tokens.json: ${e instanceof Error ? e.message : String(e)}` };
    }

    // Read registry for site architecture
    let registry: string;
    try {
      registry = await readFile(join(workingDir, 'output/reduced/registry.json'), 'utf-8');
      validateRegistry(JSON.parse(registry));
    } catch (e) {
      return { status: 'failed', startedAt: new Date(startTime).toISOString(), finishedAt: new Date().toISOString(), duration: Date.now() - startTime, error: `Invalid registry.json: ${e instanceof Error ? e.message : String(e)}` };
    }

    // Read content helper to understand available functions
    const contentHelper = await readFile(join(workingDir, 'src/lib/content.ts'), 'utf-8')
      .catch(() => '');

    const rejectionSection = ctx.rejectionContext
      ? `\n## Prior Reviewer Feedback (Retry)\n\nThe previous attempt was rejected by reviewers. Address these issues:\n\n${ctx.rejectionContext}\n\n`
      : '';

    // Read content config
    const contentConfig = await readFile(join(workingDir, 'src/content.config.ts'), 'utf-8')
      .catch(() => '');

    // Parse registry for dynamic prompt sections
    let registryObj: Registry | null = null;
    try { registryObj = JSON.parse(registry); } catch {}
    const staticPagesSection = buildStaticPagesSection(registryObj);
    const dynamicRoutesSection = buildDynamicRoutesSection(registryObj);
    const listingPagesSection = buildListingPagesSection(registryObj, registry);
    const searchSection = buildSearchSection(registryObj);

    const prompt = `${rejectionSection}
Consult the **Astro** skill for Astro framework reference.

## CRITICAL: This is NOT just a styling task
You must BUILD THE ACTUAL PAGES for the site. The current index.astro is a placeholder — replace it with real content.

## CRITICAL: Every [slug].astro MUST export getStaticPaths()
Astro requires \`export async function getStaticPaths()\` for ALL dynamic routes ([slug].astro, [...slug].astro).
WITHOUT this, the build WILL FAIL with "GetStaticPathsRequired" error.
Example pattern:
\`\`\`astro
---
import { getCollection } from 'astro:content';

export async function getStaticPaths() {
  const entries = await getCollection('COLLECTION_NAME');
  return entries.map(entry => ({
    params: { slug: entry.id },
    props: { entry },
  }));
}

const { entry } = Astro.props;
// ... render entry
---
\`\`\`

## Site Architecture (from registry.json)
\`\`\`json
${registry}
\`\`\`

## Content Available

### Content Config (src/content.config.ts) — USE THESE EXACT COLLECTION NAMES:
\`\`\`typescript
${contentConfig}
\`\`\`

IMPORTANT: Use the collection names defined in content.config.ts — do NOT invent names.
Check the actual defineCollection() calls to find the correct names.

### Static Pages Data (src/data/static-pages.json):
Contains the homepage, about page, services page and other single-instance page content.
Each entry has: { pagetype, route, content }.

### Content Helper (src/lib/content.ts):
\`\`\`typescript
${contentHelper}
\`\`\`

## Design Tokens — LAYOUT LAYER ONLY (use only grid/flex/spacing values, ignore colors/typography)
\`\`\`json
${tokens}
\`\`\`

## KEY INSIGHT: This is a TEMPLATE-based site, NOT 100 individual pages

Astro uses content collections + dynamic routes. You do NOT create a file per page.
The seed step already wrote all content JSON files to src/content/{collection}/*.json.
You only need to create TEMPLATES that Astro expands at build time.

For a site with 100 pages, you typically need only 10-20 .astro files:
- 1 template per collection: src/pages/{collection}/[slug].astro (handles ALL items in that collection)
- 1 file per static page: src/pages/about-us.astro, src/pages/our-services.astro
- 1 file per listing: src/pages/news-events/index.astro
- Shared components: Header, Footer, Hero, Layouts

DO NOT create individual pages for each content entry. The [slug].astro template + getStaticPaths() does that automatically.

## Instructions

You are in Phase 2: LAYOUT. You must create ~15-20 template files, NOT 100+ pages.

### STRICT EXECUTION ORDER (follow exactly):

**Step 1 — Create shared components (3 files):**
- **src/components/Header.astro** — Nav header. ALL links MUST use relative routes (href="/about-us", NOT href="https://..."). Read nav from src/data/navigation.json if it exists, otherwise hardcode from registry routes.
- **src/components/Footer.astro** — Footer with relative links.
- **src/components/Hero.astro** — Reusable hero section.

**Step 2 — Create layouts (2 files):**
- **src/layouts/LandingLayout.astro** — Full-width layout for landing page.
- **src/layouts/StandardLayout.astro** — Standard layout with Header + breadcrumbs + Footer.

**Step 3 — Create static page templates (from registry.static_pages):**
${staticPagesSection}

**Step 4 — Create dynamic route templates (1 file per collection, from registry.collections):**
${dynamicRoutesSection}

**Step 5 — Create listing page templates (from registry.listings):**
${listingPagesSection}

${searchSection}

**Step 6 — Build and fix:**
1. Run \`npx astro build\` ONCE
2. Fix only BLOCKING errors (type errors, missing imports)
3. Run build again to confirm
4. Output "LAYOUT_PHASE_PASSED" only when build succeeds

### Layout properties to apply:
1. **Container widths** — from tokens: layout.container.maxWidth (e.g., max-w-7xl mx-auto)
2. **Grid structures** — from tokens: layout.grid (e.g., grid grid-cols-1 md:grid-cols-3 gap-8)
3. **Section spacing** — from tokens: layout.sections (e.g., py-20 md:py-24)
4. **Responsive breakpoints** — sm/md/lg prefixes from tokens: layout.breakpoints
5. **Vertical rhythm** — spacing multiples of baseUnit from tokens: layout.rhythm

### What NOT to apply:
- NO color classes (no bg-*, text-*, border-color-*)
- NO font classes (no font-*, text-lg, font-bold)
- NO shadow classes (no shadow-*)
- NO border-radius classes (no rounded-*)
- NO transition/animation classes

### Content rendering:
- Use real \`<img>\` tags: \`<img src={entry.data.photo} alt={entry.data.name} />\`
- For missing images: \`<div class="aspect-video bg-gray-100 border border-gray-200"></div>\`
- Content URLs have already been rewritten to relative routes by the seed step

### Link rules (CRITICAL):
- ALL links MUST be relative: href="/about-us", href="/blog/my-post"
- NEVER use absolute URLs to the original site

If all checks pass, output "LAYOUT_PHASE_PASSED".`;

    const result = await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
      maxTurns: 200,
    });

    const passed = result.includes('LAYOUT_PHASE_PASSED');

    return {
      status: passed ? 'completed' : 'failed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
      error: passed ? undefined : 'Layout phase failed validation',
    };
  },
};

// ─── Dynamic prompt builders (generic — no hardcoded site names) ──────

function buildStaticPagesSection(registry: Registry | null): string {
  if (!registry) {
    return `#### 1. Static Pages (read routes from registry.json):
- Create a page for each entry in registry.static_pages, using the route and layout specified.
- Read content from src/data/static-pages.json for each route.`;
  }

  const entries = registry.static_pages;
  if (entries.length === 0) return '';

  const lines = entries.map(sp => {
    const layout = ('layout' in sp ? (sp as Record<string, unknown>).layout : 'standard') as string;
    const layoutType = layout === 'landing' ? 'landing layout' : 'standard layout';
    const routeFile = routeToAstroFile(sp.route);
    return `- **src/pages/${routeFile}** — ${sp.pagetype} (${layoutType}). Route: "${sp.route}". Read content from src/data/static-pages.json for the entry with route "${sp.route}".`;
  });

  return `#### 1. Static Pages (replace index.astro):\n${lines.join('\n')}`;
}

function buildDynamicRoutesSection(registry: Registry | null): string {
  if (!registry) {
    return `#### 2. Dynamic Collection Pages (read from registry.collections):
- For each collection in registry.json, create a [slug].astro page.
- ALL must have getStaticPaths() using getCollection('collection_name').`;
  }

  const lines: string[] = [];
  for (const [collName, coll] of Object.entries(registry.collections)) {
    // Derive a sensible route path from the listing or the collection name
    const slugDir = collectionNameToSlugDir(collName);
    const astroFile = `src/pages/${slugDir}/[slug].astro`;
    lines.push(
      `- **${astroFile}** — ${collName} detail page. MUST export getStaticPaths using getCollection('${collName}').`,
    );
  }

  if (lines.length === 0) return '';

  return `#### 2. Dynamic Collection Pages (ALL must have getStaticPaths):\n${lines.join('\n')}`;
}

function buildListingPagesSection(registry: Registry | null, registryJson: string): string {
  if (!registry) {
    return `#### 3. Listing Pages (read from registry.listings):
- For each listing in registry.json, create the listing page at the specified route.
- If the listing has paginated: true, include pagination controls.`;
  }

  const lines: string[] = [];
  for (const [listingName, listing] of Object.entries(registry.listings)) {
    const routeFile = listingRouteToAstroFile(listing.route);
    const collection = listing.queries[0]?.collection || listingName;
    const paginatedNote = listing.paginated ? ' Include pagination controls.' : '';
    lines.push(
      `- **src/pages/${routeFile}** — ${listingName} listing. Query collection '${collection}'.${paginatedNote}`,
    );
  }

  if (lines.length === 0) return '';

  return `#### 3. Listing Pages:${lines.length ? '' : ' (none)'}\n${lines.join('\n')}`;
}

function buildSearchSection(registry: Registry | null): string {
  if (!registry) return '';

  // Identify listings that have enough items to warrant search
  const searchableListings: string[] = [];
  for (const [name, listing] of Object.entries(registry.listings)) {
    const collection = listing.queries[0]?.collection;
    if (collection && listing.paginated) {
      searchableListings.push(name);
    }
  }

  if (searchableListings.length === 0) return '';

  const listingNames = searchableListings.join(', ');

  return `#### 6. Search Component (for listing pages):
For listing pages that are paginated (${listingNames}), include a client-side search bar:
- Create **src/components/SearchableList.tsx** (React component) that accepts an array of items as JSON prop
- The component should provide: text search input, result count, and the list of filtered items
- Use simple Array.filter() matching on title/name fields (no external library needed for basic search)
- Serialize the collection data as a JSON prop in the Astro page and pass it to the React component
- Style: search input with placeholder "Search...", results count text, responsive grid of result cards
- For listings with filterable_by fields, also include a filter dropdown/select above the grid

Example Astro usage:
\`\`\`astro
---
import { getCollection } from 'astro:content';
import SearchableList from '../components/SearchableList';

const entries = await getCollection('blog_post');
const items = entries.map(e => ({ id: e.id, title: e.data.title, ... }));
---
<SearchableList client:load items={JSON.stringify(items)} searchFields={["title"]} />
\`\`\``;
}

// ─── Route helpers ─────────────────────────────────────────────────────

/** Convert a registry route to an Astro page file path. */
function routeToAstroFile(route: string): string {
  const normalized = route.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  if (normalized === '/') return 'index.astro';
  // /about-us → about-us.astro
  const segments = normalized.split('/').filter(Boolean);
  return segments.join('/') + '.astro';
}

/** Convert a listing route (with :params) to an Astro dynamic page file path. */
function listingRouteToAstroFile(route: string): string {
  // /news-events/ → news-events/index.astro
  // /category/:category/ → category/[category]/index.astro
  // /doctor-category/:specialty/ → doctor-category/[specialty]/index.astro
  let normalized = route.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  normalized = normalized.replace(/:(\w+)/g, '[$1]');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return 'index.astro';
  // Check if the last segment is dynamic
  const last = segments[segments.length - 1];
  if (last.startsWith('[')) {
    // e.g. category/[category] → category/[category]/index.astro
    return segments.join('/') + '/index.astro';
  }
  return segments.join('/') + '/index.astro';
}

/** Convert a collection name to a slug directory for routing.
 *  blog_post → blog, doctor_profile → doctor, etc.
 */
function collectionNameToSlugDir(name: string): string {
  // Common patterns: blog_post → blog, doctor_profile → doctor,
  // blog_category → category, date_archive → archive
  const overrides: Record<string, string> = {
    blog_post: 'blog',
    doctor_profile: 'doctor',
    blog_category: 'category',
    date_archive: 'archive',
  };
  if (overrides[name]) return overrides[name];
  // Fallback: use the first word before underscore
  return name.split('_')[0] || name;
}

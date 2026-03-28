/**
 * Phase 2: LAYOUT
 *
 * Build actual pages from content collections and apply grid/flex layout,
 * spacing, responsive breakpoints. Gray-box mode — no color, no typography.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import { agentQuery } from '../lib/agent.js';

export const layoutStep: Step = {
  id: 'layout',
  name: 'Phase 2: Layout',
  description: 'Build pages from content and apply grid/flex layout (gray-box mode)',

  async run(workingDir: string, ctx: StepContext): Promise<StepStatus> {
    const startTime = Date.now();

    // Read style fingerprint and design tokens from scratch
    const fingerprint = await readFile(join(ctx.scratchDir, 'style-fingerprint.json'), 'utf-8')
      .catch(() => '{}');
    const tokens = await readFile(join(ctx.scratchDir, 'design-tokens.json'), 'utf-8')
      .catch(() => '{}');

    // Read registry for site architecture
    const registry = await readFile(join(workingDir, 'output/reduced/registry.json'), 'utf-8')
      .catch(() => '{}');

    // Read content helper to understand available functions
    const contentHelper = await readFile(join(workingDir, 'src/lib/content.ts'), 'utf-8')
      .catch(() => '');

    const rejectionSection = ctx.rejectionContext
      ? `\n## Prior Reviewer Feedback (Retry)\n\nThe previous attempt was rejected by reviewers. Address these issues:\n\n${ctx.rejectionContext}\n\n`
      : '';

    // Read content.config.ts to get actual collection names
    const contentConfig = await readFile(join(workingDir, 'src/content.config.ts'), 'utf-8')
      .catch(() => '');

    const prompt = `Build the actual site pages from content collections and apply grid/flex layout.

${rejectionSection}
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
  const entries = await getCollection('articles');
  return entries.map(entry => ({
    params: { slug: entry.id.replace(/^royal-healthcare-com-/, '').replace(/\\.json$/, '') },
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

IMPORTANT: Use the collection names defined in content.config.ts — NOT assumptions like 'blog_posts' or 'legal'.
Check the actual defineCollection() calls to find the correct names (likely 'articles', 'doctors', 'categories', 'pages', 'legal_docs').

### Static Pages Data (src/data/static-pages.json):
Contains the homepage, about page, and services page content with navigation, hero sections, etc.

### Content Helper (src/lib/content.ts):
\`\`\`typescript
${contentHelper}
\`\`\`

## Style Fingerprint
\`\`\`json
${fingerprint}
\`\`\`

## Design Tokens (layout + componentSpacing layers)
\`\`\`json
${tokens}
\`\`\`

## Instructions

You are in Phase 2: LAYOUT. You must:
1. **Create all pages** based on the registry architecture
2. **Apply layout properties** (grid, flex, spacing, containers)
3. **DO NOT apply** colors, typography, shadows, or visual styling
4. **EVERY dynamic route MUST have getStaticPaths()** — this is non-negotiable

### Pages to create:

#### 1. Static Pages (replace index.astro):
- **src/pages/index.astro** — Homepage (landing layout). Read content from \`src/data/static-pages.json\` for the landing page entry. Include: hero section, feature highlights, testimonials, CTA.
- **src/pages/about-us.astro** — About page (standard layout). Read content from static-pages.json for the about entry.
- **src/pages/our-services.astro** — Services page (standard layout). Read content from static-pages.json for the services entry.

#### 2. Dynamic Collection Pages (ALL must have getStaticPaths):
- **src/pages/blog/[slug].astro** — Blog post detail. MUST export getStaticPaths using getCollection('articles').
- **src/pages/doctor/[slug].astro** — Doctor profile detail. MUST export getStaticPaths using getCollection('doctors').
- **src/pages/[...slug].astro** — Generic page catch-all. MUST export getStaticPaths using getCollection('pages').
- **src/pages/legal/[slug].astro** — Legal pages. MUST export getStaticPaths using getCollection('legal_docs').

#### 3. Listing Pages (also dynamic if they have [slug]):
- **src/pages/news-events/index.astro** — Blog listing. Query all articles.
- **src/pages/category/[slug].astro** — Blog category filter. MUST export getStaticPaths.
- **src/pages/meet-our-team/index.astro** — Team listing (query doctors).
- **src/pages/doctor-category/[slug].astro** — Doctor category filter. MUST export getStaticPaths.

#### 4. Layout Components:
- **src/layouts/LandingLayout.astro** — Full-width hero layout for homepage
- **src/layouts/StandardLayout.astro** — Standard layout with header/nav/footer for inner pages

#### 5. Shared Components:
- **src/components/Header.astro** — Navigation header with logo and menu from registry.navigation
- **src/components/Footer.astro** — Footer
- **src/components/Hero.astro** — Hero section component

### Layout properties to apply:
1. **Container widths** — from tokens: layout.container.maxWidth (e.g., max-w-7xl mx-auto)
2. **Grid structures** — from tokens: layout.grid (e.g., grid grid-cols-1 md:grid-cols-3 gap-8)
3. **Section spacing** — from tokens: layout.sections (e.g., py-20 md:py-24)
4. **Responsive breakpoints** — sm/md/lg prefixes from tokens: layout.breakpoints
5. **Vertical rhythm** — spacing multiples of baseUnit from tokens: layout.rhythm
6. **Component spacing** — from tokens: componentSpacing

### Style fingerprint influence:
- High density (>0.7) → tighter spacing (py-12, gap-6)
- Low density (<0.3) → airy spacing (py-24, gap-12)
- High formality (>0.7) → strict grid, aligned columns
- High depth (>0.7) → layered sections, z-index stacking

### What NOT to apply:
- NO color classes (no bg-*, text-*, border-color-*)
- NO font classes (no font-*, text-lg, font-bold)
- NO shadow classes (no shadow-*)
- NO border-radius classes (no rounded-*)
- NO transition/animation classes

### Content rendering:
- Each page should render the ACTUAL content from the content collections
- Blog posts should display title, date, content, featured image
- Doctor profiles should display name, specialty, photo, bio
- Static pages should render their header, hero, body content, etc.
- Use placeholder elements (gray boxes) for images: \`<div class="aspect-video bg-gray-200"></div>\`

### Build strategy:
1. Create ALL pages first (with getStaticPaths on every dynamic route)
2. Then run \`npx astro build\` ONCE to validate
3. Fix any build errors
4. Run build again to confirm
5. Output "LAYOUT_PHASE_PASSED" only when build succeeds

If all checks pass, output "LAYOUT_PHASE_PASSED".`;

    const result = await agentQuery({
      prompt,
      cwd: workingDir,
      env: ctx.env,
      stepName: ctx.name,
      logger: ctx.logger,
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

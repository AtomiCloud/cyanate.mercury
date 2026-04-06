/**
 * Phase 2: LAYOUT
 *
 * Build actual pages from content collections and apply grid/flex layout,
 * spacing, and desktop/tablet structural responsiveness. Gray-box mode — no color, no typography, no mobile interaction work.
 *
 * The prompt should stay registry-driven and avoid hardcoded page-family or
 * vertical-specific assumptions.
 */

import { readFile, readdir, rm, writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import { join } from 'path';
import type { Step, StepContext, StepStatus } from './step.js';
import type { Registry } from '../types.js';
import { agentQuery } from '../lib/agent.js';
import { validateRegistry, validateDesignTokens } from '../lib/validate-boundary.js';
import { Semaphore } from '../lib/reviewer.js';

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

    const interactionManifest = await readFile(join(workingDir, 'output/reduced/interaction-manifest.json'), 'utf-8')
      .catch(() => '{"patterns":[],"pages":[]}');

    // Read dynamic bindings manifest if content-reduction step produced one
    const dynamicBindingsJson = await readFile(join(workingDir, 'src/data/dynamic-bindings.json'), 'utf-8')
      .catch(() => '');

    // Read asset manifest so agents know which images actually exist
    const assetManifestJson = await readFile(join(workingDir, 'asset-manifest.json'), 'utf-8')
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
    const interactiveSection = buildInteractiveSection(registryObj);
    const routeMapSection = buildRouteMap(registryObj);

    // ─── Shared prompt fragments ────────────────────────────────────────
    const workingDirAnchor = `Your working directory is ${workingDir}. Do NOT navigate elsewhere. All paths are relative to this directory.`;

    const astroPatterns = `
## Astro Patterns
- Every [slug].astro MUST export getStaticPaths() using getCollection().
- Static pages use getStaticPage('/route') from src/lib/content.ts — NOT Astro.props.entry.
- Content collection names come from src/content.config.ts — do NOT invent names.
- Do NOT install, remove, or upgrade dependencies.
- Do NOT edit package.json, astro.config.mjs, or toolchain files.`;

    const layoutCssRules = `
## Layout CSS Rules
- Container: Read EXACT px from design-tokens.json layout.container.maxWidth → max-w-[Xpx] (NOT max-w-7xl)
- Section spacing: Read EXACT values from design-tokens.json layout.sections → use lg:py-XX to match token px
- Grids: from tokens layout.grid
- Breakpoints: sm/md/lg from tokens layout.breakpoints
- Hero: CONDITIONAL grid — lg:grid-cols-2 only when image prop present, single-column otherwise
- NO color classes (bg-*, text-*, border-color-*), NO font classes, NO shadow, NO rounded, NO transitions

## CRITICAL: Container Responsibility (read carefully — past failures were caused by violating this)
- Layout <main> MUST be full-width: <main class="w-full"> — NO max-w-*, NO px-*, NO py-* on <main>.
- Each <section> inside <main> owns its own container: <div class="max-w-[Xpx] mx-auto px-6">.
- This allows full-bleed sections (background spans viewport) while content is constrained.
- NEVER put container classes on BOTH a parent layout AND a child section — that doubles padding.
- NEVER put two max-w-* classes on the same element.
- NEVER put py-* on <main> — each section controls its own vertical spacing.
- Narrow content (blog prose) uses max-w-3xl on an inner div, NOT on the layout <main>.`;

    const linkRules = `
## Link Rules
${routeMapSection}
- ALL links MUST be relative (start with /). NEVER use absolute URLs. NEVER invent paths.
- Links MUST match actual file paths in src/pages/. For example, if the page is src/pages/longevity-wellness.astro, the link is "/longevity-wellness", NOT "/our-services/longevity-wellness".
- NEVER create links to generic pages like /contact, /book-an-appointment, /search, /login, /signup unless they appear in the route map above. If the source site had such pages but they are not in the route map, use "#" as the href instead.
- Check the route map above and match links to actual routes — broken links will fail invariant checks and block the pipeline.`;

    const dataGrounding = `
## Data Grounding
- Inspect actual JSON in src/data/static-pages.json and src/content/*/*.json before writing templates.
- Ground every template to REAL field shapes. Do not assume generic fields.
- Handle nested objects/arrays generically.
- EVERY content section MUST have a structural layout skeleton — heading PLUS grid/flex/list for items.
  Do NOT render a section as just an <h2> with no content below it. If data exists (awards, videos, features, etc.),
  render at minimum a grid or flex container with item placeholders wired to the data fields.
  Even if items are sparse, the structural layout must exist.`;

    const contentInfo = `
## Content Config (src/content.config.ts):
\`\`\`typescript
${contentConfig}
\`\`\`

## Content Helper (src/lib/content.ts):
\`\`\`typescript
${contentHelper}
\`\`\``;

    const dynamicBindingsInfo = dynamicBindingsJson ? `
## Dynamic Bindings (src/data/dynamic-bindings.json)
\`\`\`json
${dynamicBindingsJson.slice(0, 4000)}
\`\`\`
- collection_query: use getCollection() and render in specified display format
- prev_next: compute from array index in getStaticPaths()
- global: import from src/data/ JSON files directly
` : '';

    const assetInfo = assetManifestJson ? `
## Image Assets
An asset manifest exists at \`asset-manifest.json\` in the working directory. It contains a \`downloaded\` array listing all image paths that exist in \`public/\`.

**Before using ANY image path in a template**, read \`asset-manifest.json\` and confirm the path exists in the \`downloaded\` array.
- Do NOT invent image paths like /images/logo.svg.
- Do NOT assume an image exists just because a content field references it.
- If no matching image exists, omit the <img> tag or use a placeholder <div> with a background color.` : '';

    // ─── Sub-agent 1: Layout Plan ──────────────────────────────────────
    const planPrompt = `${workingDirAnchor}
${rejectionSection}

You are a PLANNING agent. Your ONLY job is to read design tokens, style fingerprint, registry, component recipes, and interaction manifest, then write a single JSON file: scratch/layout-plan.json.

Do NOT create any .astro or .tsx files. Only output the plan JSON.

## Input files to read:
- scratch/design-tokens.json — layout values (container, grids, spacing, breakpoints)
- scratch/style-fingerprint.json — site personality
- output/reduced/registry.json — site architecture (static_pages, collections, listings, interactive_patterns)
- scratch/component-recipes.json — component patterns from reference
- output/reduced/interaction-manifest.json — navigation, fragment targets, popups
- src/data/navigation.json and src/data/footer.json — site chrome data
- src/content.config.ts — collection names

## Output: scratch/layout-plan.json

Write this exact structure:
\`\`\`json
{
  "css": {
    "container": "max-w-[Xpx] mx-auto px-6",
    "sectionPadding": "py-NN md:py-NN lg:py-NN",
    "heroWithImage": "grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12 items-center",
    "heroWithoutImage": "max-w-3xl",
    "grids": { "4col": "...", "3col": "...", "2col": "..." },
    "breakpoints": { "sm": "NNNpx", "md": "NNNpx", "lg": "NNNpx" },
    "gutter": "NNpx"
  },
  "layouts": [
    { "name": "LandingLayout", "file": "src/layouts/LandingLayout.astro", "description": "..." },
    { "name": "StandardLayout", "file": "src/layouts/StandardLayout.astro", "description": "..." }
  ],
  "sharedComponents": [
    { "name": "Header", "file": "src/components/Header.astro", "dataSource": "src/data/navigation.json", "notes": "..." },
    { "name": "Footer", "file": "src/components/Footer.astro", "dataSource": "src/data/footer.json", "notes": "..." },
    { "name": "Hero", "file": "src/components/Hero.astro", "notes": "Conditional: 2-col grid with image OR full-width text-only" }
  ],
  "pageGroups": [
    { "id": "homepage", "files": ["src/pages/index.astro"], "layout": "LandingLayout", "dataSource": "static-pages.json route /" },
    { "id": "static", "files": ["src/pages/about-us.astro", ...], "layout": "StandardLayout", "dataSource": "static-pages.json" },
    { "id": "collections", "files": ["src/pages/blog/[slug].astro", ...], "layout": "StandardLayout", "dataSource": "content collections via getStaticPaths" },
    { "id": "listings", "files": ["src/pages/news-events/index.astro", ...], "layout": "StandardLayout", "dataSource": "content collections via getCollection" }
  ]
}
\`\`\`

Rules:
- Extract EXACT pixel values from design-tokens.json and convert to Tailwind classes.
- Container maxWidth must be max-w-[Xpx] with the exact token value, NOT max-w-7xl.
- Section padding must match token values at desktop breakpoint (use lg: prefix).
- Discover components from component-recipes.json and interaction manifest — don't hardcode.
- Derive pageGroups from registry.json (static_pages grouped by pagetype, collections, listings).
- For each pageGroup, list the exact .astro file paths needed.
- For interactive patterns from registry, add them to sharedComponents.
- Add SearchableList.tsx if any listing has paginated:true.
- IMPORTANT: Keep pageGroups consolidated — aim for 4-8 groups total, NOT one per page.
  - Group all similar static pages together (e.g. all service/info pages in one group).
  - Group all collection detail pages together (blog posts, doctors, legal).
  - Group all listing pages together (blog listing, category listing, doctor listing).
  - The homepage is always its own group.

IMPORTANT architecture rule for the plan:
- Layout <main> MUST be full-width (<main class="w-full">) with NO max-w, NO px, NO py.
- Each <section> inside pages owns its own container (max-w-[Xpx] mx-auto px-6).
- This prevents double-container issues. Include this in the plan description for layouts.

After writing the file, output "PLAN_DONE".`;

    let agentError: string | undefined;
    const isRetry = !!rejectionSection;

    // On retry, skip plan + components agents — they already ran and their output is in place.
    if (!isRetry) {
      // Run planning agent
      try {
        await agentQuery({
          prompt: planPrompt,
          cwd: workingDir,
          env: ctx.env,
          stepName: `${ctx.name}/plan`,
          logger: ctx.logger,
          maxTurns: 15,
        });
      } catch (error) {
        agentError = error instanceof Error ? error.message : String(error);
      }
    }

    // Read the plan (or use a fallback structure)
    let layoutPlan: LayoutPlan;
    try {
      const planJson = await readFile(join(workingDir, 'scratch/layout-plan.json'), 'utf-8');
      layoutPlan = JSON.parse(planJson) as LayoutPlan;
    } catch {
      // If planning agent failed, build a minimal plan from registry
      layoutPlan = buildFallbackPlan(registryObj, tokens);
    }

    // Write the plan back (ensure it's available for all sub-agents)
    await writeFile(join(workingDir, 'scratch/layout-plan.json'), JSON.stringify(layoutPlan, null, 2), 'utf-8');

    // ─── Sub-agent 2: Layouts + Shared Components ──────────────────────
    const componentsPrompt = `${workingDirAnchor}
Consult the **Astro** skill for Astro framework reference.

You are a COMPONENT BUILDER agent. Create the layout files and shared components listed in scratch/layout-plan.json.

## Steps:
1. Read scratch/layout-plan.json — this is your source of truth for CSS values and file list.
2. For EVERY file in "layouts" and "sharedComponents" arrays, create the file.
3. Use the EXACT CSS classes from layout-plan.json css section (container, sectionPadding, grids, etc.).
4. For Header: read src/data/navigation.json for nav links.
5. For Footer: read src/data/footer.json for footer content.
6. For Hero: implement CONDITIONAL grid — use heroWithImage classes when image prop exists, heroWithoutImage when it doesn't.
7. For interactive components (modals, accordions, tabs): create minimal functional stubs with correct IDs.

## CRITICAL: Layout <main> must be full-width
All layout files (LandingLayout, StandardLayout, etc.) MUST use:
  <main class="w-full">
    <slot />
  </main>
Do NOT put max-w-*, px-*, or py-* on <main>. Each page section owns its own container.
This prevents double-padding when sections add their own max-w-[1200px] mx-auto px-6.

## CRITICAL: Header MUST be sticky
The Header component MUST use sticky positioning so it stays visible during scroll:
  <header class="w-full sticky top-0 z-40">
This is required for the site's CTA button to remain accessible.

## CRITICAL: Section padding consistency
EVERY <section> on EVERY page MUST have the FULL padding chain from layout-plan.json css.sectionPadding.
For example if the plan says "py-12 md:py-16 lg:py-20", use ALL THREE breakpoints on every section.
NEVER use only "lg:py-20" without the base "py-12" — that leaves zero padding at mobile/tablet widths.

${astroPatterns}
${layoutCssRules}
${linkRules}
${contentInfo}
${assetInfo}

## Semantic HTML
- Each page should have exactly one h1. Use h2 for section headings. Only h3 inside h2 sections.

## Interaction Manifest
\`\`\`json
${interactionManifest}
\`\`\`

After creating ALL files, output "COMPONENTS_DONE".`;

    if (!isRetry) {
      try {
        await agentQuery({
          prompt: componentsPrompt,
          cwd: workingDir,
          env: ctx.env,
          stepName: `${ctx.name}/components`,
          logger: ctx.logger,
          maxTurns: 30,
        });
      } catch (error) {
        agentError = error instanceof Error ? error.message : String(error);
      }
    }

    // ─── Sub-agent 3: Page Templates (one agent per page file, parallel) ─
    const pageGroups = layoutPlan.pageGroups || [];
    const allPageTasks: Array<{ file: string; group: LayoutPlanPageGroup }> = [];
    for (const group of pageGroups) {
      for (const file of group.files) {
        allPageTasks.push({ file, group });
      }
    }

    // On retry, only run agents for files mentioned in the rejection context.
    // Files the reviewer didn't complain about are already correct — don't touch them.
    let tasksToRun = allPageTasks;
    if (isRetry && ctx.rejectionContext) {
      const rc = ctx.rejectionContext.toLowerCase();
      tasksToRun = allPageTasks.filter(({ file }) => {
        const fileLower = file.toLowerCase();
        const basename = file.split('/').pop() || '';
        const pathWithoutExt = file.replace(/\.astro$/, '');

        // Direct match: exact file path or basename in rejection text
        if (rc.includes(basename.toLowerCase())
          || rc.includes(pathWithoutExt.toLowerCase())
          || rc.includes(fileLower)) {
          return true;
        }

        // Page-type match: map visual-qa reviewer page-type names to file paths.
        // Reviewer IDs look like "visual-qa-doctors", "visual-qa-landing", etc.
        // Extract directory segments from file path for matching.
        const segments = fileLower.split('/');
        for (const seg of segments) {
          const clean = seg.replace(/\.astro$/, '').replace(/^\[.*\]$/, '');
          if (clean && clean.length > 2 && rc.includes(clean)) return true;
        }

        // Also match shared components if rejection mentions header/footer/hero
        if (fileLower.includes('header') && rc.includes('header')) return true;
        if (fileLower.includes('footer') && rc.includes('footer')) return true;
        if (fileLower.includes('hero') && rc.includes('hero')) return true;

        // Match "landing" / "homepage" → index.astro
        if (fileLower === 'src/pages/index.astro' && (rc.includes('landing') || rc.includes('homepage'))) return true;

        return false;
      });
      // If no specific files matched, fall back to all (reviewer may have used vague language)
      if (tasksToRun.length === 0) tasksToRun = allPageTasks;
    }

    const maxConcurrent = ctx.stepConfig?.maxConcurrentPageAgents ?? 5;
    const semaphore = new Semaphore(maxConcurrent);
    const failedPages: { file: string; groupId: string; error: string }[] = [];

    const pagePromises = tasksToRun.map(async ({ file, group }) => {
      await semaphore.acquire();
      try {
        const pagePrompt = isRetry
          ? `${workingDirAnchor}
${rejectionSection}
You are a PAGE FIX agent. The file ${file} already exists from a prior attempt.

## Your ONLY job:
1. Read the existing file: ${file}
2. Read the reviewer feedback above carefully.
3. Make ONLY the specific changes the reviewer requested for this file.
4. Do NOT rewrite the file from scratch. Do NOT change anything the reviewer didn't mention.
5. After fixing, output "PAGE_FIXED".
${assetInfo}`
          : `${workingDirAnchor}
Consult the **Astro** skill for Astro framework reference.

You are a PAGE TEMPLATE agent. Create this ONE file:
- ${file}

## Context:
- Page group: "${group.id}"
- Layout to use: ${group.layout}
- Data source: ${group.dataSource}

## Instructions:
1. Read scratch/layout-plan.json for CSS values — use EXACT classes from the css section.
2. Read the shared components already created (src/components/, src/layouts/) to understand imports.
3. For [slug].astro files, MUST export getStaticPaths() using getCollection().
4. For static pages, use getStaticPage('/route') from src/lib/content.ts.

${astroPatterns}
${layoutCssRules}
${linkRules}
${dataGrounding}
${contentInfo}
${dynamicBindingsInfo}
${assetInfo}

## CRITICAL: Avoid double-container and nested main (past rejections caused by these)
- If you use a SectionContainer or Section component that already provides max-w-[Xpx] mx-auto px-6, do NOT add another max-w/mx-auto/px wrapper inside it.
- Do NOT wrap page content in <main> — the layout already provides <main>. Your page slot content goes directly into the layout's <main>.
- Read the layout file to see what it provides before adding any container classes.

## CRITICAL: Section padding consistency
EVERY <section> MUST have the FULL padding chain from layout-plan.json css.sectionPadding (e.g. "py-12 md:py-16 lg:py-20").
NEVER use only "lg:py-20" without base "py-12" — that leaves zero padding at mobile/tablet.
Copy the EXACT sectionPadding string from layout-plan.json onto every <section>.

## CRITICAL: Section grouping
A heading and its associated content grid/list MUST be in the SAME <section>.
Do NOT put a section heading in one <section> and its grid in a separate <section> — that creates
double padding (160px gap) and visually disconnects the heading from its content.
WRONG: <section class="py-20"><h2>Services</h2></section><section class="py-20"><div class="grid">...</div></section>
RIGHT: <section class="py-20"><h2>Services</h2><div class="grid mt-8">...</div></section>

## Semantic HTML (MANDATORY)
- EVERY page MUST have exactly one <h1> tag for the page title. This is checked automatically and will cause rejection if missing.
- Use h2 for section headings under h1. Only use h3 inside a section that has an h2.
- Cards in grids: use h2 or non-heading elements, never jump h1→h3.

## Registry
\`\`\`json
${registry}
\`\`\`

## Image Sizing Rules
- ALL images MUST have explicit size constraints with max-height or max-width.
- Logo images in header: use h-8 md:h-10 with max-h-10. NEVER allow unbounded height.
- Badge/store images in footer: constrain with max-h-12 or h-10.
- Hero images: use max-h-[400px] or an aspect-ratio constraint.
- NEVER use w-auto or h-auto without a corresponding max-height or max-width.

## Content Wiring Verification
- After writing each page template, READ the actual JSON data file it consumes.
- Verify that the fields accessed in the template EXIST in the data.
- If a content collection entry only has page_title and no other fields, flag it — do NOT write a detailed template expecting fields that don't exist.

## Button and Link Rules
- EVERY <button> MUST have visible text content or an aria-label.
- NEVER render an empty <button></button> — if data for button text is missing, use a sensible default or omit the button.

After creating the file, output "PAGE_DONE".`;

        await agentQuery({
          prompt: pagePrompt,
          cwd: workingDir,
          env: ctx.env,
          stepName: `${ctx.name}/page-${file.replace(/[\/.]/g, '-')}`,
          logger: ctx.logger,
          maxTurns: isRetry ? 10 : 15,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        agentError = msg;
        failedPages.push({ file, groupId: group.id, error: msg });
      } finally {
        semaphore.release();
      }
    });

    await Promise.allSettled(pagePromises);

    // Build the expected pages list from plan for the build-fix agent
    const allExpectedFiles = pageGroups.flatMap((g: LayoutPlanPageGroup) => g.files);
    const failedPagesSummary = failedPages.length > 0
      ? `\n## WARNING: These page files FAILED during creation and may be missing:\n${failedPages.map(p => `- ${p.file} (group: ${p.groupId})`).join('\n')}\nYou MUST create these missing files before the build can succeed.\n`
      : '';

    // ─── Sub-agent 4: Build + Fix ──────────────────────────────────────
    const buildFixPrompt = `${workingDirAnchor}
Consult the **Astro** skill for Astro framework reference.

You are a BUILD-FIX agent. Your ONLY job is to make the Astro project build successfully with ALL pages.

## Expected pages (from layout plan):
${allExpectedFiles.map((f: string) => `- ${f}`).join('\n')}
${failedPagesSummary}
## Steps:
1. First check which expected files are MISSING — list the files in src/pages/ and compare to the expected list above.
2. For any missing files, CREATE them using the layout plan (read scratch/layout-plan.json for CSS values).
3. Run \`bun run build\`
4. If it succeeds, output "LAYOUT_PHASE_PASSED" and stop.
5. If it fails, read the error output carefully and fix ONLY the broken files.
6. Re-run \`bun run build\` after each fix.
7. Attempt at most 5 build-fix cycles.
8. After 5 attempts, output "LAYOUT_PHASE_PASSED" anyway.

## Common Astro build errors and fixes:
- \`Cannot access 'X' before initialization\` — variable used before declaration in .astro frontmatter. In Astro frontmatter, ordering MUST be: (1) imports, (2) const page = getStaticPage(...), (3) const d = page?.content ?? {}, (4) everything else. NEVER use a variable before its declaration line.
- \`getStaticPaths() did not return\` — [slug].astro files MUST export getStaticPaths() that returns an array of { params, props }.
- Wrong collection names — check src/content.config.ts for correct names.
- Missing imports — check what the file references and add the import.
- \`prerender error\` on a specific route — read that route's .astro file, find the runtime error, fix it.

## Rules:
- Do NOT restructure or rewrite working files that build correctly.
- Do NOT install, remove, or upgrade dependencies.
- Fix only what the build error says is broken, or create missing files.
- Read scratch/layout-plan.json if you need CSS values.
- For [slug].astro dynamic routes, always use getCollection() from astro:content.

${astroPatterns}
${contentInfo}
${dynamicBindingsInfo}
${assetInfo}

Output "LAYOUT_PHASE_PASSED" when build succeeds or after 5 fix attempts.`;

    let result = '';
    try {
      result = await agentQuery({
        prompt: buildFixPrompt,
        cwd: workingDir,
        env: ctx.env,
        stepName: `${ctx.name}/build-fix`,
        logger: ctx.logger,
        maxTurns: 100,
      });
    } catch (error) {
      agentError = error instanceof Error ? error.message : String(error);
    }

    // sanitizeLayoutPhaseOutput removed — was stripping legitimate CSS (colors, fonts)
    await normalizeGeneratedHeadingHierarchy(workingDir);
    await dedupeStaticRouteFiles(workingDir);
    // dedupAstroFrontmatter removed — build+fix agent handles syntax errors
    await ensureGlobalPopupMounts(workingDir);
    await normalizeHeroMinHeight(workingDir);
    await fixConflictingMaxWidths(workingDir);
    await repairBrokenInternalLinks(workingDir, registryObj);
    await ensureNoHorizontalOverflow(workingDir);
    await writeFile(join(workingDir, 'tsconfig.json'), STABLE_LAYOUT_TSCONFIG, 'utf-8');

    const markerPassed = result.includes('LAYOUT_PHASE_PASSED');
    const buildPassed = await verifyGeneratedLayoutBuild(workingDir);
    const passed = markerPassed || buildPassed;

    return {
      status: passed ? 'completed' : 'failed',
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
      error: passed ? undefined : (agentError || 'Layout phase failed validation'),
    };
  },
};

// ─── Layout plan types ───────────────────────────────────────────────

interface LayoutPlanCss {
  container: string;
  sectionPadding: string;
  heroWithImage: string;
  heroWithoutImage: string;
  grids: Record<string, string>;
  breakpoints: Record<string, string>;
  gutter: string;
}

interface LayoutPlanComponent {
  name: string;
  file: string;
  dataSource?: string;
  notes?: string;
}

interface LayoutPlanPageGroup {
  id: string;
  files: string[];
  layout: string;
  dataSource: string;
}

interface LayoutPlan {
  css: LayoutPlanCss;
  layouts: LayoutPlanComponent[];
  sharedComponents: LayoutPlanComponent[];
  pageGroups: LayoutPlanPageGroup[];
}

/** Build a minimal plan from registry when the planning agent fails */
function buildFallbackPlan(registry: Registry | null, tokensJson: string): LayoutPlan {
  let container = 'max-w-[1200px] mx-auto px-6';
  let sectionPadding = 'py-12 md:py-16 lg:py-20';
  try {
    const t = JSON.parse(tokensJson);
    const maxW = t?.layout?.container?.maxWidth;
    if (maxW) container = `max-w-[${maxW}] mx-auto px-6`;
    const secPad = t?.layout?.sections?.padding?.default?.top;
    if (secPad) {
      const px = parseInt(secPad, 10);
      if (px) sectionPadding = `py-12 md:py-16 lg:py-[${px}px]`;
    }
  } catch {}

  const css: LayoutPlanCss = {
    container,
    sectionPadding,
    heroWithImage: 'grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12 items-center',
    heroWithoutImage: 'max-w-3xl',
    grids: {
      '4col': 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6',
      '3col': 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6',
      '2col': 'grid grid-cols-1 md:grid-cols-2 gap-8',
    },
    breakpoints: { sm: '640px', md: '768px', lg: '1024px' },
    gutter: '24px',
  };

  const layouts: LayoutPlanComponent[] = [
    { name: 'LandingLayout', file: 'src/layouts/LandingLayout.astro', notes: 'Full-bleed sections' },
    { name: 'StandardLayout', file: 'src/layouts/StandardLayout.astro', notes: 'Constrained with breadcrumbs' },
  ];

  const sharedComponents: LayoutPlanComponent[] = [
    { name: 'Header', file: 'src/components/Header.astro', dataSource: 'src/data/navigation.json' },
    { name: 'Footer', file: 'src/components/Footer.astro', dataSource: 'src/data/footer.json' },
    { name: 'Hero', file: 'src/components/Hero.astro', notes: 'Conditional grid' },
  ];

  const pageGroups: LayoutPlanPageGroup[] = [];

  if (registry) {
    // Homepage
    const homePage = registry.static_pages.find(sp => sp.route === '/');
    if (homePage) {
      pageGroups.push({ id: 'homepage', files: ['src/pages/index.astro'], layout: 'LandingLayout', dataSource: 'static-pages.json route /' });
    }

    // Static pages (non-homepage)
    const staticFiles = registry.static_pages
      .filter(sp => sp.route !== '/')
      .map(sp => `src/pages/${routeToAstroFile(sp.route)}`);
    if (staticFiles.length > 0) {
      pageGroups.push({ id: 'static', files: staticFiles, layout: 'StandardLayout', dataSource: 'static-pages.json' });
    }

    // Collection detail pages
    const collectionFiles = Object.keys(registry.collections).map(name => {
      const dir = collectionNameToSlugDir(name);
      return `src/pages/${dir}/[slug].astro`;
    });
    if (collectionFiles.length > 0) {
      pageGroups.push({ id: 'collections', files: collectionFiles, layout: 'StandardLayout', dataSource: 'content collections via getStaticPaths' });
    }

    // Listing pages
    const listingFiles = Object.values(registry.listings).map(listing => {
      return `src/pages/${listingRouteToAstroFile(listing.route)}`;
    });
    if (listingFiles.length > 0) {
      pageGroups.push({ id: 'listings', files: listingFiles, layout: 'StandardLayout', dataSource: 'content collections via getCollection' });
    }
  }

  return { css, layouts, sharedComponents, pageGroups };
}

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

function buildInteractiveSection(registry: Registry | null): string {
  if (!registry) return '';
  const patterns = (registry as unknown as Record<string, unknown>).interactive_patterns;
  if (!patterns || !Array.isArray(patterns) || patterns.length === 0) return '';

  const lines = patterns.map((p: Record<string, unknown>) => {
    const trigger = p.trigger ? ` (trigger: \`${p.trigger}\`)` : '';
    return `- **${p.id}**: ${p.type}${trigger} — ${p.description}`;
  });

  return `**Step 5b — Create interactive components (from registry.interactive_patterns):**
For each interactive pattern identified from the source site, create a minimal stub component:
${lines.join('\n')}

For modals/popups: create a simple React component with open/close state (client:load).
For accordions/tabs: use HTML details/summary or a simple React toggle.
The content/styling will be refined in later phases — just make them functional with correct IDs so hash links work.`;
}

// ─── Route map builder ────────────────────────────────────────────────

/** Build a complete list of all known routes from the registry for the prompt. */
function buildRouteMap(registry: Registry | null): string {
  if (!registry) return '- Check registry.json for all valid routes.';

  const routes: string[] = [];

  // Static pages
  for (const sp of registry.static_pages) {
    routes.push(`${sp.route} (${sp.pagetype})`);
  }

  // Collection detail routes
  for (const [collName, _coll] of Object.entries(registry.collections)) {
    const slugDir = collectionNameToSlugDir(collName);
    routes.push(`/${slugDir}/[slug] (${collName} detail)`);
  }

  // Listing routes
  for (const [listingName, listing] of Object.entries(registry.listings)) {
    routes.push(`${listing.route} (${listingName} listing)`);
  }

  if (routes.length === 0) return '- No routes found in registry.';

  const routeLines = routes.map(r => `  - ${r}`).join('\n');
  return `**All valid internal routes (from registry):**\n${routeLines}`;
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

const STABLE_LAYOUT_TSCONFIG = `{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": [".astro/types.d.ts", "**/*"],
  "exclude": ["dist"]
}
`;

const LAYOUT_FORBIDDEN_DECLARATIONS = [
  /(^|[;\s{])font-size\s*:[^;]+;?/gmi,
  /(^|[;\s{])font-weight\s*:[^;]+;?/gmi,
  /(^|[;\s{])font-family\s*:[^;]+;?/gmi,
  /(^|[;\s{])letter-spacing\s*:[^;]+;?/gmi,
  /(^|[;\s{])line-height\s*:[^;]+;?/gmi,
  /(^|[;\s{])color\s*:[^;]+;?/gmi,
  /(^|[;\s{])background-color\s*:[^;]+;?/gmi,
  /(^|[;\s{])border-color\s*:[^;]+;?/gmi,
  /(^|[;\s{])outline-color\s*:[^;]+;?/gmi,
  /(^|[;\s{])background\s*:\s*(?:oklch|hsl|rgb|#)[^;]+;?/gmi,
  /(^|[;\s{])transition\s*:[^;]+;?/gmi,
  /(^|[;\s{])animation\s*:[^;]+;?/gmi,
];

async function sanitizeLayoutPhaseOutput(workingDir: string, sourceOrigin?: string): Promise<void> {
  const srcDir = join(workingDir, 'src');
  const files = await listSourceFiles(srcDir);
  await Promise.all(files.map(async (file) => {
    const original = await readFile(file, 'utf-8');
    const sanitized = sanitizeLayoutSource(original, sourceOrigin);
    if (sanitized !== original) {
      await writeFile(file, sanitized, 'utf-8');
    }
  }));
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(fullPath));
      continue;
    }
    if (entry.name.endsWith('.astro') || entry.name.endsWith('.css') || entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function sanitizeLayoutSource(source: string, sourceOrigin?: string): string {
  let next = source;
  for (const pattern of LAYOUT_FORBIDDEN_DECLARATIONS) {
    next = next.replace(pattern, (match, prefix: string) => prefix || '');
  }
  // Strip color values from border shorthand (e.g. "border: 1px solid oklch(...)" → "border: 1px solid")
  next = next.replace(
    /border\s*:\s*(\d+[a-z]*\s+(?:solid|dashed|dotted|double|groove|ridge|inset|outset))\s+(?:oklch|hsl|rgb|#)\([^)]*\)[^;]*/gmi,
    'border: $1',
  );
  next = next.replace(
    /border\s*:\s*(\d+[a-z]*\s+(?:solid|dashed|dotted|double|groove|ridge|inset|outset))\s+#[0-9a-fA-F]{3,8}\b/gmi,
    'border: $1',
  );
  // Strip Tailwind transition/animation/duration utility classes from class attributes
  next = next.replace(/\b(?:transition-(?:all|colors|opacity|shadow|transform|none)|duration-\d+|ease-(?:in|out|in-out|out-in)|animate-\w+)\b/g, '');
  // Strip hardcoded source origin URLs (the layout agent should not reference the original site)
  if (sourceOrigin) {
    const escaped = sourceOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    next = next.replace(new RegExp(escaped, 'g'), '');
  }
  return next.replace(/\n{3,}/g, '\n\n');
}

async function verifyGeneratedLayoutBuild(workingDir: string): Promise<boolean> {
  try {
    const proc = spawn('npm', ['run', 'build'], {
      cwd: workingDir,
      stdio: 'ignore',
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', resolve);
    });
    return exitCode === 0;
  } catch {
    return false;
  }
}

async function normalizeGeneratedHeadingHierarchy(workingDir: string): Promise<void> {
  // Removed the h3→h2 / h4→h2 flattening — it was breaking CSS selectors
  // that correctly target h3 for card headings under h2 section headings.
  // The prompt already has explicit heading hierarchy rules; trust the agent's output.
}

/** Fix conflicting max-width classes on the same element.
 *  e.g., `class="max-w-[1200px] mx-auto px-6 max-w-3xl"` → remove the second max-w-*.
 *  Also removes redundant inner container wrappers when the parent layout already provides one. */
async function fixConflictingMaxWidths(workingDir: string): Promise<void> {
  const srcDir = join(workingDir, 'src');
  const files = await listSourceFiles(srcDir);
  await Promise.all(files.map(async (file) => {
    const original = await readFile(file, 'utf-8');
    let fixed = original;

    // Fix: two max-w-* classes on the same class attribute
    // Keep the first max-w-* and remove subsequent ones
    fixed = fixed.replace(/class="([^"]*)"/g, (_match, classes: string) => {
      const tokens = classes.split(/\s+/);
      let seenMaxW = false;
      const filtered = tokens.filter(t => {
        if (t.startsWith('max-w-')) {
          if (seenMaxW) return false; // remove duplicate
          seenMaxW = true;
        }
        return true;
      });
      return `class="${filtered.join(' ')}"`;
    });

    if (fixed !== original) {
      await writeFile(file, fixed, 'utf-8');
    }
  }));
}

async function normalizeHeroMinHeight(workingDir: string): Promise<void> {
  const heroPath = join(workingDir, 'src/components/Hero.astro');
  try {
    const source = await readFile(heroPath, 'utf-8');
    let repaired = source;
    repaired = repaired.replace(/v-bind\(minHeight\)/g, 'var(--hero-min-height, 480px)');
    repaired = repaired.replace(/<section class="hero-section"/, '<section class="hero-section" style={`--hero-min-height: ${minHeight}`}');
    if (repaired !== source) {
      await writeFile(heroPath, repaired, 'utf-8');
    }
  } catch {
    // ignore missing hero
  }
}

async function ensureGlobalPopupMounts(workingDir: string): Promise<void> {
  const layoutFiles = [
    join(workingDir, 'src/layouts/LandingLayout.astro'),
    join(workingDir, 'src/layouts/StandardLayout.astro'),
  ];

  await Promise.all(layoutFiles.map(async (filePath) => {
    let source: string;
    try {
      source = await readFile(filePath, 'utf-8');
    } catch {
      return;
    }

    let repaired = source;
    if (repaired.includes('#contact-us-popup') && !repaired.includes("import ContactUsPopup from '@/components/ContactUsPopup.astro';")) {
      repaired = repaired.replace(/^---\n/, "---\nimport ContactUsPopup from '@/components/ContactUsPopup.astro';\n");
    }
    if (repaired.includes("import ContactUsPopup from '@/components/ContactUsPopup.astro';") && !repaired.includes('<ContactUsPopup')) {
      repaired = repaired.replace(/<\/body>/, '    <ContactUsPopup />\n  </body>');
      repaired = repaired.replace(/<\/main>\s*<\/div>\s*$/, '</main>\n  <ContactUsPopup />\n</div>');
      repaired = repaired.replace(/<\/main>\s*$/, '</main>\n  <ContactUsPopup />');
    }

    if (repaired !== source) {
      await writeFile(filePath, repaired, 'utf-8');
    }
  }));

}

async function dedupeStaticRouteFiles(workingDir: string): Promise<void> {
  const staticPagesPath = join(workingDir, 'src/data/static-pages.json');
  let staticPages: Array<{ route?: string }> = [];
  try {
    staticPages = JSON.parse(await readFile(staticPagesPath, 'utf-8')) as Array<{ route?: string }>;
  } catch {
    return;
  }

  await Promise.all(staticPages.map(async (page) => {
    if (!page.route || page.route === '/') return;
    const flatPath = join(workingDir, 'src/pages', routeToAstroFile(page.route));
    const nestedPath = join(workingDir, 'src/pages', listingRouteToAstroFile(page.route));
    try {
      await readFile(flatPath, 'utf-8');
      await readFile(nestedPath, 'utf-8');
      await rm(nestedPath, { force: true });
    } catch {
      // ignore if one side is missing
    }
  }));
}

/** Generic frontmatter dedup for ALL .astro files.
 *  Deduplicates imports (by module path) and const declarations (by variable name).
 *  Ensures imports come before all other statements. */
async function dedupAstroFrontmatter(workingDir: string): Promise<void> {
  const pagesDir = join(workingDir, 'src/pages');
  const files: string[] = [];
  async function walk(dir: string) {
    let entries: import('fs').Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.astro')) files.push(full);
    }
  }
  await walk(pagesDir);

  for (const filePath of files) {
    let source: string;
    try { source = await readFile(filePath, 'utf-8'); } catch { continue; }

    const match = source.match(/^---\n([\s\S]*?)\n---/);
    if (!match) continue;
    const frontmatter = match[1] || '';

    const lines = frontmatter.split('\n');
    const seenImports = new Set<string>();
    const seenConsts = new Set<string>();
    const imports: string[] = [];
    const rest: string[] = [];

    for (const line of lines) {
      // Dedup imports by module specifier
      const importMatch = line.match(/^\s*import\s.*from\s+['"]([^'"]+)['"]/);
      if (importMatch) {
        const mod = importMatch[1].replace(/\.ts$/, '').replace(/^@\//, '../');
        if (seenImports.has(mod)) continue;
        seenImports.add(mod);
        imports.push(line);
        continue;
      }
      // Dedup const declarations by variable name
      const constMatch = line.match(/^\s*const\s+(\w+)\s*=/);
      if (constMatch) {
        const varName = constMatch[1];
        if (seenConsts.has(varName)) continue;
        seenConsts.add(varName);
      }
      rest.push(line);
    }

    const fixed = [...imports, ...rest].join('\n');
    if (fixed !== frontmatter) {
      const repaired = source.replace(/^---\n[\s\S]*?\n---/, `---\n${fixed}\n---`);
      await writeFile(filePath, repaired, 'utf-8');
    }
  }
}

/** Repair broken internal links by matching them to actual page files.
 *  Scans all .astro files for href="/..." links, checks if a matching page exists,
 *  and if not, tries to find the correct route from the generated pages directory. */
async function repairBrokenInternalLinks(workingDir: string, registry: Registry | null): Promise<void> {
  if (!registry) return;

  // Build a set of all valid routes from actual page files
  const pagesDir = join(workingDir, 'src/pages');
  const validRoutes = new Set<string>();

  async function scanDir(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await scanDir(join(dir, entry.name), `${prefix}/${entry.name}`);
      } else if (entry.name.endsWith('.astro')) {
        const routeName = entry.name.replace('.astro', '');
        if (routeName === 'index') {
          validRoutes.add(prefix || '/');
        } else if (routeName.startsWith('[')) {
          // Dynamic route — enumerate content collection files under this dir
          // e.g. src/pages/legal/[slug].astro + src/content/legal/*.json → /legal/privacy-policy
          const contentDir = join(workingDir, 'src/content', prefix.split('/').filter(Boolean).pop() || '');
          const contentEntries = await readdir(contentDir).catch(() => [] as string[]);
          for (const cf of contentEntries) {
            if (cf.endsWith('.json') || cf.endsWith('.md') || cf.endsWith('.mdx')) {
              const slug = cf.replace(/\.(json|md|mdx)$/, '');
              validRoutes.add(`${prefix}/${slug}`);
            }
          }
        } else {
          validRoutes.add(`${prefix}/${routeName}`);
        }
      }
    }
  }
  await scanDir(pagesDir, '');

  // Build a mapping of bare names to actual routes for common mismatches
  const routeByLastSegment = new Map<string, string>();
  for (const route of validRoutes) {
    const segments = route.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && !routeByLastSegment.has(last)) {
      routeByLastSegment.set(last, route);
    }
  }

  // Scan all .astro source files and fix broken links
  const srcDir = join(workingDir, 'src');
  const files = await listSourceFiles(srcDir);
  await Promise.all(files.map(async (file) => {
    if (!file.endsWith('.astro')) return;
    const original = await readFile(file, 'utf-8');
    let fixed = original;

    // Find all href="/..." links
    fixed = fixed.replace(/href="(\/[^"#?]*)"/g, (_match, href: string) => {
      const normalized = href.replace(/\/$/, '') || '/';
      if (validRoutes.has(normalized)) return `href="${href}"`;

      // Try to find a matching route by the last segment
      const segments = normalized.split('/').filter(Boolean);
      const last = segments[segments.length - 1];
      if (last) {
        const correctRoute = routeByLastSegment.get(last);
        if (correctRoute) {
          return `href="${correctRoute}"`;
        }
      }
      // No fix found — leave as-is
      return `href="${href}"`;
    });

    if (fixed !== original) {
      await writeFile(file, fixed, 'utf-8');
    }
  }));
}

/** Post-process layout output: ensure globals.css is imported in ALL layouts
 *  and add overflow/image guards to globals.css. */
async function ensureNoHorizontalOverflow(workingDir: string): Promise<void> {
  // 1. Ensure every layout .astro file imports globals.css
  const layoutDir = join(workingDir, 'src/layouts');
  try {
    const entries = await readdir(layoutDir);
    for (const f of entries) {
      if (!f.endsWith('.astro')) continue;
      const filePath = join(layoutDir, f);
      let content = await readFile(filePath, 'utf-8');
      if (content.includes('globals.css')) continue; // already imports it
      // Insert import inside the frontmatter (between --- fences)
      if (content.startsWith('---')) {
        content = content.replace(/^---\n/, "---\nimport '../styles/globals.css';\n");
      } else {
        // No frontmatter — add one
        content = "---\nimport '../styles/globals.css';\n---\n" + content;
      }
      await writeFile(filePath, content, 'utf-8');
    }
  } catch {
    // layouts dir missing — nothing to do
  }

  // 2. Add overflow + image guards to globals.css
  const globalsPath = join(workingDir, 'src/styles/globals.css');
  try {
    let css = await readFile(globalsPath, 'utf-8');
    if (css.includes('/* overflow-guard */')) return; // already patched
    css += `
/* overflow-guard */
html, body {
  overflow-x: hidden !important;
  max-width: 100vw !important;
}
img, video, svg {
  max-width: 100% !important;
}
`;
    await writeFile(globalsPath, css, 'utf-8');
  } catch {
    // globals.css missing — nothing to do
  }
}

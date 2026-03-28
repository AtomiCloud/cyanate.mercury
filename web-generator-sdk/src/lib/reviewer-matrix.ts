/**
 * Per-phase reviewer matrix.
 *
 * Defines which reviewers run for each phase.
 * Phase-Specific × 2 models (M1, M2) + Generic × 2 models (M1, M2).
 * Per-page reviewers spawn one agent per page.
 */

import type { ReviewerDef, ReviewerContext } from './reviewer.js';

// --- Generic reviewer (runs npm run check) ---

function genericReviewerPrompt(ctx: ReviewerContext): string {
  return `You are a code quality reviewer. Run the following checks on the Astro project at the current directory:

1. Run: npx biome check . --formatter-enabled=false
2. Run: npx astro check
3. Run: npm run build

If ALL checks pass without errors, output:
VERDICT: PASS

If ANY check fails, output:
VERDICT: REJECT

## Evidence
Describe what each check found.

## Findings
List what passed and what failed.

## Rejection Context (if rejected)
Specific errors from the failing check(s).`;
}

// --- Phase 0: Analyze reviewers ---

function jsonValidityPrompt(ctx: ReviewerContext): string {
  return `You are a JSON validity reviewer. Run a script to programmatically validate all Phase 0 output files.

Run this command in bash:
\`\`\`bash
node -e "
const fs = require('fs');
const path = require('path');
const scratch = '${ctx.scratchDir}';
const errors = [];

// 1. style-fingerprint.json
try {
  const sf = JSON.parse(fs.readFileSync(path.join(scratch, 'style-fingerprint.json'), 'utf8'));
  if (typeof sf.style?.primary !== 'string') errors.push('style-fingerprint: missing style.primary string');
  if (typeof sf.style?.dimensions !== 'object' || Object.keys(sf.style?.dimensions || {}).length < 8) errors.push('style-fingerprint: dimensions needs 8 fields');
  if (typeof sf.confidence !== 'number' || sf.confidence <= 0.6) {
    if (typeof sf.style?.confidence !== 'number' || sf.style.confidence <= 0.6) {
      errors.push('style-fingerprint: confidence must be > 0.6 (check top-level or style.confidence)');
    }
  }
} catch(e) { errors.push('style-fingerprint: ' + e.message); }

// 2. design-tokens.json
try {
  const dt = JSON.parse(fs.readFileSync(path.join(scratch, 'design-tokens.json'), 'utf8'));
  const required = ['atomic', 'gradients', 'layout', 'componentSpacing', 'motion', 'surfaces', 'visualIdentity'];
  for (const key of required) {
    if (!dt[key] || Object.keys(dt[key]).length === 0) errors.push('design-tokens: missing or empty layer: ' + key);
  }
  // Check surfaces have real values (not empty objects)
  if (dt.surfaces) {
    if (dt.surfaces.glass && typeof dt.surfaces.glass === 'object' && Object.keys(dt.surfaces.glass).length === 0) {
      errors.push('design-tokens: surfaces.glass is empty object');
    }
    if (dt.surfaces.texture && typeof dt.surfaces.texture === 'object' && Object.keys(dt.surfaces.texture).length === 0) {
      errors.push('design-tokens: surfaces.texture is empty object');
    }
  }
  // Check colorDistribution has correct keys
  if (dt.visualIdentity?.colorDistribution) {
    const cd = dt.visualIdentity.colorDistribution;
    if (!cd.dominant) errors.push('design-tokens: colorDistribution.missing dominant');
    if (!cd.secondary) errors.push('design-tokens: colorDistribution.missing secondary');
    if (!cd.accent) errors.push('design-tokens: colorDistribution.missing accent');
  }
} catch(e) { errors.push('design-tokens: ' + e.message); }

// 3. component-recipes.json
try {
  const cr = JSON.parse(fs.readFileSync(path.join(scratch, 'component-recipes.json'), 'utf8'));
  if (!cr.button || !cr.button.base) errors.push('component-recipes: missing button.base');
  if (!cr.card || !cr.card.base) errors.push('component-recipes: missing card.base');
} catch(e) { errors.push('component-recipes: ' + e.message); }

if (errors.length > 0) { console.log('FAILURES:'); errors.forEach(e => console.log('  - ' + e)); process.exit(1); }
else { console.log('ALL CHECKS PASSED'); process.exit(0); }
"
\`\`\`

If the script outputs "ALL CHECKS PASSED", output exactly:
VERDICT: PASS

If the script outputs "FAILURES", output exactly:
VERDICT: REJECT

## Evidence
Paste the script output.

## Findings
List what passed and what failed.

## Rejection Context (if rejected)
List the specific failures from the script output.`;
}

function tokenCompletenessPrompt(ctx: ReviewerContext): string {
  return `You are a design token completeness reviewer. Verify all 7 layers of design-tokens.json have non-empty values.

Read: ${ctx.scratchDir}/design-tokens.json

Check each layer:
1. atomic — must have: colors, typography (fontFamily, fontSize, fontWeight), spacing, borderRadius, shadows — all non-empty
2. gradients — at least one gradient definition with type, stops
3. layout — must have: grid (columns, gutter), container (maxWidth), breakpoints, sections, density, rhythm — all non-empty
4. componentSpacing — must have at least: inset, stack, inline
5. motion — must have: duration, easing, state (hover, focus, active, disabled) — all non-empty
6. surfaces — glass and texture must NOT be empty objects {}. They must contain actual property values (e.g., glass: { backdropBlur: "12px", background: "rgba(255,255,255,0.25)" })
7. visualIdentity — colorDistribution must have exactly these keys: dominant, secondary, accent (NOT "neutral" or other names)

If all 7 layers are complete with non-empty values, output:
VERDICT: PASS

If any layer is empty or missing required sub-properties, output:
VERDICT: REJECT

## Evidence
Per-layer completeness check.

## Findings
What's present and what's missing.

## Rejection Context (if rejected)
Specific missing layers or empty values.`;
}

function styleConfidencePrompt(ctx: ReviewerContext): string {
  return `You are a style classification reviewer. Verify the style fingerprint is reasonable.

Read: ${ctx.scratchDir}/style-fingerprint.json

Check:
1. Primary style category is a recognized style (minimalist, corporate, brutalist, playful, editorial, etc.)
2. Confidence score > 0.6
3. All 8 dimension values are between 0.0 and 1.0
4. Treatments are valid: surface, corners, shadows, borders, gradients are strings; blur, transparency are booleans; animation_style is a string
5. Secondary styles is an array (can be empty)
6. If motion dimension > 0.5, verify animation_style is set

If all checks pass, output:
VERDICT: PASS

If any check fails, output:
VERDICT: REJECT

## Evidence
Style classification details.

## Findings
Classification quality assessment.

## Rejection Context (if rejected)
Specific issues found.`;
}

// --- Phase 1a: Reduce reviewers ---

function reduceInvariantPrompt(ctx: ReviewerContext): string {
  return `You are a data invariant reviewer. Verify the Phase 1a reduction preserved the page count.

Read: ${ctx.workingDir}/output/reduced/meta.json

Check:
1. Sum of all page_types[].count equals source.total_pages
2. No page types are missing from meta.json
3. Every page type from the scraper output is represented
4. Route patterns are valid (no double slashes, proper [slug] format)

If all invariants hold, output:
VERDICT: PASS

If any invariant is violated, output:
VERDICT: REJECT

## Evidence
Count verification details.

## Findings
Invariant check results.

## Rejection Context (if rejected)
Specific invariant violations with numbers.`;
}

// --- Phase 1b: Classify reviewers ---

function classifyCoveragePrompt(ctx: ReviewerContext): string {
  return `You are an architecture coverage reviewer. Verify the Phase 1b registry covers all page types.

Read: ${ctx.workingDir}/output/reduced/registry.json and ${ctx.workingDir}/output/reduced/meta.json

Check:
1. Every pagetype in meta.json appears in exactly ONE of: layouts.*.page_types, collections.*.source_pagetype, or static_pages[].pagetype
2. Every collection's source_pagetype exists in meta.json with multi: true
3. No orphan page types

If all checks pass, output:
VERDICT: PASS

If any check fails, output:
VERDICT: REJECT

## Evidence
Page type coverage analysis.

## Findings
Which types are covered and how.

## Rejection Context (if rejected)
Orphan page types or coverage gaps.`;
}

// --- Per-page reviewers ---

function linksReviewerPrompt(ctx: ReviewerContext): string {
  return `You are a link integrity reviewer. Check all links on pages in the Astro project at the current directory.

Start the dev server (npm run dev), then for each page:
1. Visit the page using Playwright (or webapp-testing skill)
2. Find all <a href> elements
3. Visit each link and verify it returns 200 (not 404/500)
4. Check for broken internal links and external links

Write the following evidence files to ${ctx.evidenceDir}:
- \`broken-links.json\` — array of { page, href, status, error } for all broken links
- \`page-links.json\` — adjacency list: { page: string, linksTo: string[] } for each page

Report all broken links found.

If no broken links found, output:
VERDICT: PASS

If any broken links found, output:
VERDICT: REJECT

## Evidence
Pages checked, links verified, results per page.

## Findings
Link check results.

## Rejection Context (if rejected)
List of broken links with page URL and link URL.`;
}

function imagesReviewerPrompt(ctx: ReviewerContext): string {
  return `You are an image integrity reviewer. Check all images on pages in the Astro project at the current directory.

Start the dev server (npm run dev), then for each page:
1. Visit the page
2. Find all <img> elements
3. Verify each src loads (no 404)
4. Check all images have alt attributes

Write the following evidence file to ${ctx.evidenceDir}:
- \`broken-images.json\` — array of { page, src, alt, error } for all broken or missing-alt images

If all images load and have alt text, output:
VERDICT: PASS

If any broken images or missing alt attributes, output:
VERDICT: REJECT

## Evidence
Images checked, results per page.

## Findings
Image check results.

## Rejection Context (if rejected)
Broken images or missing alt attributes.`;
}

function consoleReviewerPrompt(ctx: ReviewerContext): string {
  return `You are a console error reviewer. Check for console errors on all pages in the Astro project at the current directory.

Start the dev server (npm run dev), then for each page:
1. Visit the page
2. Collect all console errors and warnings
3. Check for JavaScript errors, React hydration errors, missing module errors

Write the following evidence file to ${ctx.evidenceDir}:
- \`console-errors.json\` — array of { page, errors: string[], warnings: string[] } for each page

If no console errors on any page, output:
VERDICT: PASS

If any console errors found, output:
VERDICT: REJECT

## Evidence
Console output per page.

## Findings
Error summary.

## Rejection Context (if rejected)
Console errors with page URL and error message.`;
}

function responsiveReviewerPrompt(ctx: ReviewerContext): string {
  return `You are a responsive design reviewer. Check the Astro project at the current directory at three breakpoints.

Start the dev server (npm run dev), then for each page:
1. Visit at 375px width — check: no horizontal scrollbar, single-column reflow, mobile nav accessible
2. Visit at 768px width — check: layout transitions correct, no overflow
3. Visit at 1280px width — check: full layout, content not stretched, grid columns visible

Take screenshots at each breakpoint and write them to ${ctx.evidenceDir}/screenshots/ with the naming pattern: {page}-{viewport}.png (e.g., home-375.png, home-768.png, home-1280.png).

Write the following evidence file to ${ctx.evidenceDir}:
- \`responsive.json\` — array of { page, viewport, issues: string[] } for each page at each breakpoint

If all pages are responsive at all breakpoints, output:
VERDICT: PASS

If any responsive issues found, output:
VERDICT: REJECT

## Evidence
Screenshots and responsive check results.

## Findings
Responsive issues if any.

## Rejection Context (if rejected)
Breakpoint failures with page URL and issue description.`;
}

function semanticHtmlPrompt(ctx: ReviewerContext): string {
  return `You are a semantic HTML reviewer. Check the HTML structure of pages in the Astro project at the current directory.

Start the dev server (npm run dev), then check each page:
1. Every page has <header>, <main>, appropriate <footer>
2. Heading hierarchy correct (h1 > h2 > h3, no skipping levels)
3. No duplicate h1s per page
4. Images have alt attributes
5. Forms have associated <label> elements
6. Navigation uses <nav> element
7. ARIA labels where appropriate

If all semantic HTML checks pass, output:
VERDICT: PASS

If any issues found, output:
VERDICT: REJECT

## Evidence
Semantic HTML check results per page.

## Findings
HTML structure issues if any.

## Rejection Context (if rejected)
Semantic issues with page URL and element reference.`;
}

// --- Phase 2: Layout reviewers ---

function marginsReviewerPrompt(ctx: ReviewerContext): string {
  return `You are a layout margin/spacing reviewer. Check that the Astro project at the current directory follows the design token spacing.

Read the design tokens from: ${ctx.scratchDir}/design-tokens.json

Check:
1. No overflow-x: hidden on body
2. Grid gutters match design-tokens.json → layout.grid.gutter
3. Section spacing follows rhythm scale (multiples of layout.rhythm.baseUnit)
4. Container widths match design-tokens.json → layout.container.maxWidth
5. No !important on layout properties
6. Mobile-first approach: base styles for mobile, md: and lg: for desktop
7. Tailwind classes reference only layout utilities (grid, flex, gap, padding, margin, max-w, mx-auto, px, py)

If all checks pass, output:
VERDICT: PASS

If any issues found, output:
VERDICT: REJECT

## Evidence
Spacing verification details.

## Findings
Spacing issues if any.

## Rejection Context (if rejected)
Specific spacing violations with file and element.`;
}

// --- Phase 3: Design reviewers ---

function typographyReviewerPrompt(ctx: ReviewerContext): string {
  return `You are a typography reviewer. Check the Astro project at the current directory for correct typography.

Read the design tokens from: ${ctx.scratchDir}/design-tokens.json
Read the component recipes from: ${ctx.scratchDir}/component-recipes.json

Check:
1. globals.css contains typography variables (font-family, font-size scale, line-height, letter-spacing)
2. No hardcoded font sizes or weights in .astro files (all from CSS variables or Tailwind utilities)
3. Typography scale: h1 > h2 > h3 sizes follow design-tokens.json → atomic.typography.fontSize
4. Font loading: fonts load before content renders (no FOUT)

If all checks pass, output:
VERDICT: PASS

If any issues found, output:
VERDICT: REJECT

## Evidence
Typography verification details.

## Findings
Typography issues if any.

## Rejection Context (if rejected)
Specific typography violations.`;
}

function componentRecipesReviewerPrompt(ctx: ReviewerContext): string {
  return `You are a component recipe reviewer. Check that components in the Astro project follow the component recipes.

Read the component recipes from: ${ctx.scratchDir}/component-recipes.json

For each component in the recipes (button, card, input, badge, etc.):
1. Check that the component exists in src/components/ui/
2. Verify base properties match (padding, fontWeight, borderRadius, fontSize)
3. Verify at least 2 variants exist
4. Verify variant styling matches the recipe

If all component recipes are followed, output:
VERDICT: PASS

If any component deviates from its recipe, output:
VERDICT: REJECT

## Evidence
Component recipe compliance per component.

## Findings
Recipe deviations if any.

## Rejection Context (if rejected)
Specific component mismatches with expected vs actual values.`;
}

// --- Phase 4: Color reviewers ---

function colorContrastPrompt(ctx: ReviewerContext): string {
  return `You are a color contrast reviewer. Check the Astro project at the current directory for WCAG compliance.

Read the design tokens from: ${ctx.scratchDir}/design-tokens.json

Check:
1. globals.css :root block contains all color CSS variables (primary, secondary, accent, background, foreground, muted, border, destructive, card, popover, ring, input)
2. globals.css .dark block exists with dark mode color overrides
3. All color values are in OKLCH format
4. No hardcoded color values in .astro files (all from CSS variables)
5. WCAG contrast ratios: normal text ≥ 4.5:1, large text ≥ 3.1:1, UI components ≥ 3:1
6. Dark mode: all text remains readable
7. No invalid colors (no NaN, no out-of-range values)

If all checks pass, output:
VERDICT: PASS

If any issues found, output:
VERDICT: REJECT

## Evidence
Color system verification details.

## Findings
Color issues if any.

## Rejection Context (if rejected)
Specific color violations with CSS variable and value.`;
}

function paletteReviewerPrompt(ctx: ReviewerContext): string {
  return `You are a color palette reviewer. Check the 60-30-10 color distribution in the Astro project.

Read the design tokens from: ${ctx.scratchDir}/design-tokens.json

Check:
1. 60% dominant color applied to backgrounds/surfaces
2. 30% secondary color applied to cards/sections/navigation
3. 10% accent color applied to CTAs/highlights/active states
4. Gradient rendering: no banding or color space errors
5. Border colors visible and appropriate contrast
6. Link colors distinguishable from body text

If all checks pass, output:
VERDICT: PASS

If any issues found, output:
VERDICT: REJECT

## Evidence
Color distribution analysis.

## Findings
Distribution issues if any.

## Rejection Context (if rejected)
Specific distribution violations.`;
}

// --- Phase 5: Motion reviewers ---

function motionReviewerPrompt(ctx: ReviewerContext): string {
  return `You are a motion/animation reviewer. Check the Astro project at the current directory for motion quality.

Read the design tokens from: ${ctx.scratchDir}/design-tokens.json
Read the component recipes from: ${ctx.scratchDir}/component-recipes.json

Check:
1. globals.css contains transition/easing CSS variables (duration, timing-function)
2. No "transition: all" anywhere (each transition lists explicit properties)
3. No !important on transition properties
4. No layout shift: animations only use transform and opacity
5. Animation duration limits: scroll reveals max 600ms, hover max 300ms
6. Easing curves match design-tokens.json → motion.easing values (not default "ease")
7. Scroll animations fire once and don't re-trigger
8. No auto-playing animations

If all checks pass, output:
VERDICT: PASS

If any issues found, output:
VERDICT: REJECT

## Evidence
Motion verification details.

## Findings
Motion issues if any.

## Rejection Context (if rejected)
Specific motion violations with file and property.`;
}

function reducedMotionPrompt(ctx: ReviewerContext): string {
  return `You are a reduced-motion accessibility reviewer. Check that the Astro project at the current directory supports prefers-reduced-motion.

Check:
1. prefers-reduced-motion media query exists in globals.css
2. Under prefers-reduced-motion: reduce, all scroll-triggered animations are disabled
3. Hover/focus transitions are instant (0ms) or very subtle under reduced-motion
4. No auto-playing animations that can't be stopped

If all checks pass, output:
VERDICT: PASS

If any issues found, output:
VERDICT: REJECT

## Evidence
Reduced-motion support details.

## Findings
Reduced-motion issues if any.

## Rejection Context (if rejected)
Specific reduced-motion violations.`;
}

// --- Phase 6: Polish reviewers ---

function qualityScorePrompt(ctx: ReviewerContext): string {
  return `You are a quality scoring reviewer. Score the Astro project at the current directory across 7 dimensions.

Read the style fingerprint from: ${ctx.scratchDir}/style-fingerprint.json

Score each dimension (1-10):
1. **layoutConsistency** (20%) — spacing follows rhythm, grid alignment, no magic numbers
2. **designTokenUsage** (20%) — all values from tokens, no hardcoded colors/sizes
3. **componentComposition** (15%) — variants render, recipes followed, shared components used
4. **responsiveDesign** (15%) — clean reflow at all 3 breakpoints, no overflow
5. **semanticHtml** (10%) — heading hierarchy, landmark elements, ARIA labels
6. **visualAppeal** (10%) — professional, matches style fingerprint aesthetic
7. **motionQuality** (10%) — smooth transitions, correct easing, reduced-motion works

Compute weighted overall score. Write results to quality-scores.json in the project root.

If overall score ≥ 8.5, output:
VERDICT: PASS

If overall score < 8.5, output:
VERDICT: REJECT

## Evidence
Per-dimension scores and weighted overall.

## Findings
Strengths and weaknesses.

## Rejection Context (if rejected)
Low-scoring dimensions with specific issues.`;
}

function visualRegressionPrompt(ctx: ReviewerContext): string {
  return `You are a visual regression reviewer. Compare screenshots from the current phase against the previous phase to ensure no unintended visual changes.

Current phase screenshots: ${ctx.evidenceDir}/screenshots/
Previous phase screenshots: ${ctx.evidenceDir}/screenshots-prev/

For each screenshot pair (matching by page name and viewport):
1. Compare the current screenshot against the previous phase screenshot
2. Identify ONLY changes that belong to the current phase's scope
3. Flag any changes that belong to a PREVIOUS phase's scope as regressions

Expected changes per phase:
- Phase 1→2 (Layout): Only layout changes (grid, spacing, containers). No color, no typography changes.
- Phase 2→3 (Design): Only typography/design changes (fonts, shadows, borders, surfaces). No color changes.
- Phase 3→4 (Color): Only color changes. No layout, no typography regressions.
- Phase 4→5 (Motion): No visible difference expected (motion is invisible in static screenshots).

If no regressions found, output:
VERDICT: PASS

If any regressions found, output:
VERDICT: REJECT

## Evidence
Per-screenshot comparison results.

## Findings
What changed and whether it's expected for this phase.

## Rejection Context (if rejected)
Specific screenshots with regression annotations.`;
}

function fingerprintFidelityPrompt(ctx: ReviewerContext): string {
  return `You are a style fingerprint fidelity reviewer. Compare the generated site against the reference style fingerprint.

Read the style fingerprint from: ${ctx.scratchDir}/style-fingerprint.json

For each dimension (ornament, playfulness, warmth, density, motion, depth, darkness, formality):
1. Assess the generated site's actual value for that dimension (0.0-1.0)
2. Compare against the reference fingerprint value
3. Flag any dimension where divergence > 0.2

Start the dev server and visually inspect the site to assess each dimension.

If all dimensions are within 0.2 of the reference, output:
VERDICT: PASS

If any dimension diverges > 0.2, output:
VERDICT: REJECT

## Evidence
Per-dimension comparison (reference vs generated).

## Findings
Divergence analysis.

## Rejection Context (if rejected)
Dimensions that diverge with specific examples of what doesn't match.`;
}

// --- Phase 2: Layout programmatic check ---

function layoutCheckPrompt(ctx: ReviewerContext): string {
  return `You are a layout check reviewer. Run a script to programmatically validate the Phase 2 layout output.

Run this command in bash:
\`\`\`bash
node -e "
const fs = require('fs');
const path = require('path');
const dir = '${ctx.workingDir}';
const errors = [];

// Helper: check if file exists
function exists(p) { try { fs.accessSync(path.join(dir, p)); return true; } catch { return false; } }

// Helper: read file content
function read(p) { try { return fs.readFileSync(path.join(dir, p), 'utf8'); } catch { return ''; } }

// 1. Check REQUIRED static pages exist
const requiredPages = ['index.astro', 'about-us.astro', 'our-services.astro'];
for (const page of requiredPages) {
  if (!exists('src/pages/' + page)) errors.push('Missing required page: src/pages/' + page);
}

// 2. Check dynamic routes exist with getStaticPaths
const dynamicRoutes = [
  'src/pages/blog/[slug].astro',
  'src/pages/doctor/[slug].astro',
  'src/pages/legal/[slug].astro',
];
for (const route of dynamicRoutes) {
  if (!exists(route)) {
    errors.push('Missing dynamic route: ' + route);
  } else {
    const content = read(route);
    if (!content.includes('getStaticPaths')) {
      errors.push(route + ' missing getStaticPaths() — build will fail');
    }
  }
}

// 3. Check listing pages exist
const listingPages = [
  'src/pages/news-events/index.astro',
  'src/pages/meet-our-team/index.astro',
];
for (const page of listingPages) {
  if (!exists(page)) errors.push('Missing listing page: ' + page);
}

// 4. Check layout components exist
if (!exists('src/layouts/Layout.astro') && !exists('src/layouts/layout.astro') && !exists('src/layouts/BaseLayout.astro')) {
  errors.push('No layout file found in src/layouts/');
}

// 5. Check shared components exist
if (!exists('src/components/Header.astro')) errors.push('Missing component: src/components/Header.astro');
if (!exists('src/components/Footer.astro')) errors.push('Missing component: src/components/Footer.astro');

// 6. Check design-tokens.json has layout layer
try {
  const dt = JSON.parse(fs.readFileSync(path.join(dir, 'scratch/design-tokens.json'), 'utf8'));
  if (!dt.layout) errors.push('design-tokens.json missing layout layer');
} catch {}

// 7. Check pages use content collections (not just static placeholder content)
const indexContent = read('src/pages/index.astro');
if (indexContent && !indexContent.includes('getCollection') && !indexContent.includes('import') && !indexContent.includes('static-pages.json')) {
  errors.push('index.astro appears to be a placeholder — no content imports');
}

if (errors.length > 0) { console.log('FAILURES:'); errors.forEach(e => console.log('  - ' + e)); process.exit(1); }
else { console.log('ALL CHECKS PASSED'); process.exit(0); }
"
\`\`\`

If the script outputs "ALL CHECKS PASSED", output exactly:
VERDICT: PASS

If the script outputs "FAILURES", output exactly:
VERDICT: REJECT

## Evidence
Paste the script output.

## Findings
List what passed and what failed.

## Rejection Context (if rejected)
List the specific failures from the script output.`;
}

// --- Phase 3: Design programmatic check ---

function designCheckPrompt(ctx: ReviewerContext): string {
  return `You are a design check reviewer. Run a script to programmatically validate the Phase 3 design output.

Run this command in bash:
\`\`\`bash
node -e "
const fs = require('fs');
const path = require('path');
const dir = '${ctx.workingDir}';
const errors = [];

// 1. Check globals.css has typography variables
try {
  const css = fs.readFileSync(path.join(dir, 'src/styles/globals.css'), 'utf8');
  if (!/--font/.test(css) && !/font-family/.test(css)) errors.push('globals.css missing typography variables');
} catch {}

// 2. Check component-recipes.json exists in scratch
try {
  const cr = JSON.parse(fs.readFileSync(path.join(dir, 'scratch/component-recipes.json'), 'utf8'));
  if (!cr.button) errors.push('component-recipes.json missing button');
} catch(e) { errors.push('component-recipes.json missing or invalid: ' + e.message); }

// 3. Check at least one component exists in src/components/
try {
  const components = fs.readdirSync(path.join(dir, 'src/components'));
  if (components.length === 0) errors.push('No components in src/components/');
} catch {}

// 4. Check design-tokens.json has atomic layer with typography
try {
  const dt = JSON.parse(fs.readFileSync(path.join(dir, 'scratch/design-tokens.json'), 'utf8'));
  if (!dt.atomic?.typography) errors.push('design-tokens.json missing atomic.typography');
} catch {}

if (errors.length > 0) { console.log('FAILURES:'); errors.forEach(e => console.log('  - ' + e)); process.exit(1); }
else { console.log('ALL CHECKS PASSED'); process.exit(0); }
"
\`\`\`

If the script outputs "ALL CHECKS PASSED", output exactly:
VERDICT: PASS

If the script outputs "FAILURES", output exactly:
VERDICT: REJECT

## Evidence
Paste the script output.

## Findings
List what passed and what failed.

## Rejection Context (if rejected)
List the specific failures from the script output.`;
}

// --- Phase 4: Color programmatic check ---

function colorCheckPrompt(ctx: ReviewerContext): string {
  return `You are a color check reviewer. Run a script to programmatically validate the Phase 4 color output.

Run this command in bash:
\`\`\`bash
node -e "
const fs = require('fs');
const path = require('path');
const dir = '${ctx.workingDir}';
const errors = [];

// 1. Check globals.css has :root with color variables
try {
  const css = fs.readFileSync(path.join(dir, 'src/styles/globals.css'), 'utf8');
  if (!/:root/.test(css)) errors.push('globals.css missing :root block');
  if (!/oklch/.test(css)) errors.push('globals.css has no oklch color values');
  if (/\\.dark/.test(css) || /\\[data-mode.*dark\\]/.test(css) || /prefers-color-scheme\\s*:\\s*dark/.test(css)) {
    // dark mode exists - good
  } else {
    errors.push('globals.css missing dark mode block');
  }
} catch {}

// 2. Check design-tokens.json has atomic.colors
try {
  const dt = JSON.parse(fs.readFileSync(path.join(dir, 'scratch/design-tokens.json'), 'utf8'));
  if (!dt.atomic?.colors) errors.push('design-tokens.json missing atomic.colors');
} catch {}

if (errors.length > 0) { console.log('FAILURES:'); errors.forEach(e => console.log('  - ' + e)); process.exit(1); }
else { console.log('ALL CHECKS PASSED'); process.exit(0); }
"
\`\`\`

If the script outputs "ALL CHECKS PASSED", output exactly:
VERDICT: PASS

If the script outputs "FAILURES", output exactly:
VERDICT: REJECT

## Evidence
Paste the script output.

## Findings
List what passed and what failed.

## Rejection Context (if rejected)
List the specific failures from the script output.`;
}

// --- Phase 5: Motion programmatic check ---

function motionCheckPrompt(ctx: ReviewerContext): string {
  return `You are a motion check reviewer. Run a script to programmatically validate the Phase 5 motion output.

Run this command in bash:
\`\`\`bash
node -e "
const fs = require('fs');
const path = require('path');
const dir = '${ctx.workingDir}';
const errors = [];

// 1. Check globals.css has transition variables or transition definitions
try {
  const css = fs.readFileSync(path.join(dir, 'src/styles/globals.css'), 'utf8');
  const hasTransition = /transition/.test(css);
  const hasReducedMotion = /prefers-reduced-motion/.test(css);
  if (!hasTransition && !hasReducedMotion) errors.push('globals.css has no transition or motion definitions');
  if (!hasReducedMotion) errors.push('globals.css missing prefers-reduced-motion media query');
} catch {}

// 2. Check design-tokens.json has motion layer
try {
  const dt = JSON.parse(fs.readFileSync(path.join(dir, 'scratch/design-tokens.json'), 'utf8'));
  if (!dt.motion) errors.push('design-tokens.json missing motion layer');
} catch {}

if (errors.length > 0) { console.log('FAILURES:'); errors.forEach(e => console.log('  - ' + e)); process.exit(1); }
else { console.log('ALL CHECKS PASSED'); process.exit(0); }
"
\`\`\`

If the script outputs "ALL CHECKS PASSED", output exactly:
VERDICT: PASS

If the script outputs "FAILURES", output exactly:
VERDICT: REJECT

## Evidence
Paste the script output.

## Findings
List what passed and what failed.

## Rejection Context (if rejected)
List the specific failures from the script output.`;
}

// --- Phase 6: Polish programmatic check ---

function polishCheckPrompt(ctx: ReviewerContext): string {
  return `You are a polish check reviewer. Run a script to programmatically validate the Phase 6 polish output.

Run this command in bash:
\`\`\`bash
node -e "
const fs = require('fs');
const path = require('path');
const dir = '${ctx.workingDir}';
const errors = [];

// 1. Check project has pages
try {
  const pagesDir = path.join(dir, 'src/pages');
  const pages = fs.readdirSync(pagesDir);
  if (pages.length === 0) errors.push('No files in src/pages/');
} catch(e) { errors.push('src/pages/ not accessible: ' + e.message); }

// 2. Check globals.css exists with both :root and dark mode
try {
  const css = fs.readFileSync(path.join(dir, 'src/styles/globals.css'), 'utf8');
  if (!/:root/.test(css)) errors.push('globals.css missing :root');
  if (!/oklch/.test(css)) errors.push('globals.css missing oklch colors');
} catch {}

// 3. Check style-fingerprint.json exists in scratch
try {
  const sf = JSON.parse(fs.readFileSync(path.join(dir, 'scratch/style-fingerprint.json'), 'utf8'));
  if (!sf.style) errors.push('style-fingerprint.json missing style object');
} catch {}

// 4. Check design-tokens.json has all 7 layers
try {
  const dt = JSON.parse(fs.readFileSync(path.join(dir, 'scratch/design-tokens.json'), 'utf8'));
  const required = ['atomic', 'gradients', 'layout', 'componentSpacing', 'motion', 'surfaces', 'visualIdentity'];
  for (const key of required) {
    if (!dt[key]) errors.push('design-tokens.json missing layer: ' + key);
  }
} catch {}

// 5. Check at least one component exists
try {
  const components = fs.readdirSync(path.join(dir, 'src/components'));
  if (components.length === 0) errors.push('No components in src/components/');
} catch {}

if (errors.length > 0) { console.log('FAILURES:'); errors.forEach(e => console.log('  - ' + e)); process.exit(1); }
else { console.log('ALL CHECKS PASSED'); process.exit(0); }
"
\`\`\`

If the script outputs "ALL CHECKS PASSED", output exactly:
VERDICT: PASS

If the script outputs "FAILURES", output exactly:
VERDICT: REJECT

## Evidence
Paste the script output.

## Findings
List what passed and what failed.

## Rejection Context (if rejected)
List the specific failures from the script output.`;
}

// --- Phase-specific checklist (M1 + M2) ---

type PhaseChecklistFn = (phaseId: string) => string;

function phaseSpecificChecklistPrompt(phaseId: string): string {
  const checklists: Record<string, string> = {
    analyze: `## Phase 0: ANALYZE Checklist
- Style fingerprint has a primary category with confidence > 0.6
- All 7 token layers have non-empty values (no null/undefined)
- Component recipes have base + at least 2 variants
- All color values are valid CSS (parseable by CSS.supports)
- prefers-reduced-motion plan exists if motion.dimension > 0.5
- JSON files are valid (JSON.parse succeeds on all 3 outputs)`,

    structure: `## Phase 1: STRUCTURE Checklist

### Phase 1a: REDUCE
- Page count invariant: sum(page_types[].count) === source.total_pages
- No missing schemas: every pagetype in content has a matching schema entry
- Sample coverage: richest sample has ≥ 80% of schema keys populated
- Output completeness: meta.json + types/*/schema.json + types/*/samples/ all written

### Phase 1b: CLASSIFY
- Every pagetype accounted for: each type in meta.json appears in exactly one of: layouts.*.page_types, collections.*, or static_pages
- Collection sources match: every collection's source_pagetype exists in meta.json with multi: true
- Listing routes valid: every listing route matches a pagetype's route pattern from meta.json
- Static page routes valid: every static page route matches a single-instance pagetype from meta.json
- No orphans: sum(static_pages.length) + sum(collections[*].source count) === total_pages

### Phase 1c: SEED
- Content collections are properly defined in src/content/config.ts
- Content files exist for each collection in src/content/{name}/*.json
- src/data/static-pages.json exists and contains static page entries
- Global content (navigation, footer) copied to src/data/
- Content helper library (src/lib/content.ts) generated
- npm run typecheck passes
- npx astro check passes
- npm run build passes`,

    layout: `## Phase 2: LAYOUT Checklist
- No overflow-x: hidden on body
- Tailwind classes reference only layout utilities (grid, flex, gap, padding, margin, max-w, mx-auto, px, py)
- Grid items have consistent gutters matching design-tokens.json → layout.grid.gutter
- Section spacing follows the rhythm scale (multiples of layout.rhythm.baseUnit)
- Container widths match design-tokens.json → layout.container.maxWidth
- No !important on layout properties
- Mobile-first approach: base styles for mobile, md: and lg: add desktop styles
- No horizontal scrollbar at any breakpoint (375px, 768px, 1280px)
- No overlapping elements at any breakpoint
- Content reflows correctly (multi-column → single-column on mobile)`,

    design: `## Phase 3: DESIGN Checklist
- globals.css contains typography variables
- Component recipes are followed: button padding/radius/weight match component-recipes.json
- No hardcoded font sizes or weights in .astro files
- Font loading: no FOUT
- Typography scale: h1 > h2 > h3 sizes follow design-tokens.json
- Surface effects render correctly
- Shadcn components installed: all referenced components in component-recipes.json are present
- Neutral palette screenshots verify structure + design visible without color influence`,

    color: `## Phase 4: COLOR Checklist
- globals.css :root block contains all color CSS variables
- globals.css .dark block exists with dark mode overrides
- All color values are in OKLCH format
- No hardcoded color values in .astro files
- WCAG contrast ratios: normal text ≥ 4.5:1, large text ≥ 3.1:1, UI components ≥ 3:1
- No invalid colors: all CSS variables resolve to valid OKLCH values
- 60-30-10 color distribution
- Dark mode: all text remains readable
- Link colors: distinguishable from body text`,

    motion: `## Phase 5: MOTION Checklist
- globals.css contains transition/easing CSS variables
- prefers-reduced-motion media query exists in globals.css
- No "transition: all" anywhere
- No !important on transition properties
- No layout shift: animations only use transform and opacity
- Animation duration limits: scroll reveals max 600ms, hover max 300ms
- Scroll animations fire once and don't re-trigger
- Easing curves match design-tokens.json → motion.easing
- prefers-reduced-motion: all scroll-triggered animations disabled
- No auto-playing animations`,

    polish: `## Phase 6: POLISH Checklist
- All pages load without crash, no console errors
- All links across all pages verified (no 404/500)
- All buttons on all pages are interactive
- Screenshot at 375px: no horizontal scrollbar, mobile nav accessible
- Screenshot at 768px: layout transitions correct
- Screenshot at 1280px: full layout, all grid columns visible
- Quality score ≥ 8.5 overall
- Style fingerprint fidelity: cosine similarity within 0.2`,
  };

  return checklists[phaseId] || '';
}

function phaseSpecificReviewerPrompt(phaseId: string): (ctx: ReviewerContext) => string {
  return (ctx: ReviewerContext) => {
    const checklist = phaseSpecificChecklistPrompt(phaseId);
    return `You are a phase-specific reviewer for ${ctx.phaseName}.

${checklist}

Read the project files and evidence in: ${ctx.evidenceDir}
Read design tokens from: ${ctx.scratchDir}/design-tokens.json
Read style fingerprint from: ${ctx.scratchDir}/style-fingerprint.json

Start the dev server (npm run dev) if needed for visual checks.

Check every item in the checklist above. For each item, report PASS or FAIL with evidence.

If ALL items pass, output:
VERDICT: PASS

If ANY item fails, output:
VERDICT: REJECT

## Evidence
Per-checklist-item results with supporting evidence.

## Findings
Summary of what passed and what failed.

## Rejection Context (if rejected)
Specific checklist items that failed with details.`;
  };
}

// --- Reviewer Matrix ---

/**
 * Get the list of reviewers for a given phase.
 */
export function getReviewersForPhase(phaseId: string): ReviewerDef[] {
  switch (phaseId) {
    case 'analyze':
      return [
        { id: 'json-validity', name: 'JSON Validity', phase: 'analyze', model: 'M1', prompt: jsonValidityPrompt },
      ];

    case 'structure':
      return [
        { id: 'json-validity', name: 'JSON Validity', phase: 'structure', model: 'M1', prompt: jsonValidityPrompt },
      ];

    case 'layout':
      return [
        { id: 'layout-check', name: 'Layout Check', phase: 'layout', model: 'M1', prompt: layoutCheckPrompt },
      ];

    case 'design':
      return [
        { id: 'design-check', name: 'Design Check', phase: 'design', model: 'M1', prompt: designCheckPrompt },
      ];

    case 'color':
      return [
        { id: 'color-check', name: 'Color Check', phase: 'color', model: 'M1', prompt: colorCheckPrompt },
      ];

    case 'motion':
      return [
        { id: 'motion-check', name: 'Motion Check', phase: 'motion', model: 'M1', prompt: motionCheckPrompt },
      ];

    case 'polish':
      return [
        { id: 'polish-check', name: 'Polish Check', phase: 'polish', model: 'M1', prompt: polishCheckPrompt },
      ];

    default:
      return [
        { id: 'generic-M1', name: 'Generic M1', phase: phaseId, model: 'M1', prompt: genericReviewerPrompt },
        { id: 'generic-M2', name: 'Generic M2', phase: phaseId, model: 'M2', prompt: genericReviewerPrompt },
      ];
  }
}

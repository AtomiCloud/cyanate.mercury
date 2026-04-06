/**
 * Subjective AI reviewer matrix.
 *
 * Deterministic contract/runtime/regression checks now run in src/lib/checks.ts
 * via the pipeline runner before any AI review. This file is intentionally
 * limited to reviewers that require judgment: architecture plausibility,
 * visual fidelity, motion taste, and final polish.
 */

import type { ReviewerDef, ReviewerContext } from './reviewer.js';

function sharedContext(ctx: ReviewerContext): string {
  return `
## Context
- Working directory: ${ctx.workingDir}
- Evidence directory: ${ctx.evidenceDir}
- Scratch directory: ${ctx.scratchDir}
- Phase: ${ctx.phaseName}
${ctx.referenceUrl ? `- Reference URL: ${ctx.referenceUrl}` : ''}

Read any relevant files directly from the project and evidence directories before deciding.
Do not repeat deterministic checks that are already covered by build/type/runtime gates unless they are needed to explain a subjective judgment.

Output format:
VERDICT: PASS or VERDICT: REJECT

## Evidence
Concrete observations from the project/evidence.

## Findings
What subjectively works well or poorly.

## Rejection Context (if rejected)
Only list issues that genuinely require implementer changes in this phase.
`;
}

function analyzeReviewerPrompt(ctx: ReviewerContext): string {
  return `You are a design analysis reviewer.

Review the generated analysis artifacts against the reference style intent:
- ${ctx.scratchDir}/style-fingerprint.json
- ${ctx.scratchDir}/design-tokens.json
- ${ctx.scratchDir}/component-recipes.json

This phase is about extracting a transferable design system from the reference.
The source site's content/domain should NOT be used to reject the analysis just because its existing brand personality differs from the reference.

Judge only subjective quality:
- whether the style fingerprint feels plausible for the reference
- whether the token system reflects the same visual personality in a reusable, non-branded form
- whether component recipes feel coherent and usable for the extracted style across arbitrary source content
- whether the artifacts avoid leaking reference-brand-specific names, proprietary branding, or non-transferable motifs

Do NOT reject solely because the source site's current visual identity differs from the reference site.
Reject only for major plausibility/fidelity/transferability problems, not for minor preference differences.
${sharedContext(ctx)}`;
}

function structureReviewerPrompt(ctx: ReviewerContext): string {
  return `You are a site-architecture reviewer.

Review the structure outputs:
- ${ctx.workingDir}/output/reduced/meta.json
- ${ctx.workingDir}/output/reduced/registry.json
- ${ctx.workingDir}/output/reduced/interaction-manifest.json

Judge only subjective architecture quality:
- whether page types are grouped sensibly into layouts/collections/listings
- whether the interaction model matches the content and routes
- whether the resulting site architecture feels reasonable for the source site

Reject only for clearly wrong IA decisions or obvious misinterpretations.
${sharedContext(ctx)}`;
}

function layoutReviewerPrompt(ctx: ReviewerContext): string {
  return `You are a layout reviewer.

Inspect the generated site and evidence for structural composition quality.
Focus ONLY on what layout owns:
- page composition and hierarchy
- section ordering and density
- grid/flex structure, spacing, container sizing
- responsive breakpoints as they affect desktop composition
- whether the layout structure feels appropriate for the source content
- whether interaction structure placeholders feel logically placed

Do NOT reject for:
- Mobile navigation (hamburger button, drawer, mobile nav toggle) — that belongs to the mobile phase
- Typography, color, or motion taste — later phases
- CSS font-size rules, heading sizing, or heading selector mismatches — those are typography concerns for the design phase
- Responsive behavior at tablet/mobile widths (overflow, stacking) — mobile phase
- Missing mobile-only UI elements — mobile phase

DO check for:
- Broken image references — if an <img> src points to a path that does not exist in public/, this is a layout problem. The layout agent has the asset manifest and must only use paths that exist.
- Empty page sections — if a page renders with no visible content, the content wiring is broken.

Reject for structural composition problems at desktop/tablet widths: grid/flex structure, container sizing, section ordering, column counts, spacing, responsive grid breakpoints, broken image references, and empty content wiring. A heading tag mismatch (h2 vs h3 in CSS) is NOT a layout rejection — it is a typography concern.
${sharedContext(ctx)}`;
}

function mobileReviewerPrompt(ctx: ReviewerContext): string {
  return `You are a mobile responsiveness reviewer.

Inspect the generated site and runtime evidence for mobile usability.
Focus on:
- whether navigation remains usable on mobile when desktop nav is hidden
- whether pages avoid horizontal overflow at narrow widths
- whether mobile interaction placeholders are reachable and logically placed
- whether small-screen stacking/layout choices feel structurally correct

Do not reject for typography/color taste; those belong to later phases.
${sharedContext(ctx)}`;
}

function designReviewerPrompt(ctx: ReviewerContext): string {
  return `You are a design reviewer.

Inspect the generated site and scratch artifacts.
Focus on:
- typography quality and hierarchy
- component styling quality
- surface treatment quality
- whether the neutral/styled design direction matches the intended personality before color tuning

Reject only for clear design incoherence or recipe/fidelity misses that require this phase to fix.
${sharedContext(ctx)}`;
}

function colorReviewerPrompt(ctx: ReviewerContext): string {
  return `You are a color reviewer.

Inspect the generated site and design tokens.
Focus on:
- palette quality
- visual balance and emphasis
- dark/light treatment appropriateness
- fidelity to the reference site's color mood

Reject only for obvious palette mismatch, poor balance, or severe aesthetic issues.
${sharedContext(ctx)}`;
}

function motionReviewerPrompt(ctx: ReviewerContext): string {
  return `You are a motion reviewer.

Inspect the generated site and runtime evidence.
Focus on:
- whether motion feels appropriate for the target style
- whether interactive feedback feels polished
- whether behavior is too flat, too flashy, or mismatched to the site's tone

Do not reject for deterministic breakage already covered by runtime checks unless it directly supports a subjective mismatch.
${sharedContext(ctx)}`;
}

// --- Per-page-type visual reviewer ---
// One instance spawned per page type (root, static, listing, detail, legal, etc.)
// Reads screenshots captured by the Playwright sampler.

const VISUAL_PHASE_FOCUS: Record<string, string> = {
  layout: 'Focus on structural composition, element sizing, content wiring, and whether sections have real content.',
  mobile: 'Focus on mobile viewport usability: is content accessible, is navigation reachable, does stacking work?',
  color: 'Focus on color contrast, palette coherence, and text readability.',
  motion: 'Focus on whether interactive states are visible and animations feel polished.',
  polish: 'Focus on overall quality: does this look like a finished, professional website?',
};

function visualReviewerPrompt(ctx: ReviewerContext): string {
  const phaseFocus = VISUAL_PHASE_FOCUS[ctx.phaseId] || VISUAL_PHASE_FOCUS.polish;
  return `You are a visual QA reviewer. You will review screenshots of generated web pages.

## What to read

1. Read the **fold screenshots** (files ending in \`-fold.jpeg\`) for above-the-fold quality.
2. Read the **full-page screenshots** (files ending in \`-full.jpeg\`) to check content below the fold.
3. Read the accessibility snapshot text files (\`-a11y.txt\`) alongside them for structural context.
4. **Read the .astro source files** listed in the "Source files for this page type" section below. These are the templates that render the pages you're reviewing.

The screenshots are in your assigned page type's subdirectory under evidence/screenshots/.

## What to judge

For each fold screenshot, judge whether the above-the-fold view looks like a real, professional website:
- Is content actually present and readable? Or are there empty sections, placeholder text, or repeated stubs?
- Are images properly sized relative to their containers? Are logos reasonable size?
- Is text contrast sufficient to read comfortably?
- Does the layout make sense? Are elements clipped, overlapping, or misaligned?
- Are there buttons or links with no visible text?
- On mobile screenshots: is content accessible and usable?

Use the a11y snapshot to check for content below the fold (headings, links, sections) without needing the full screenshot.

If an evidence/screenshots-prev/ directory exists for this page type, compare fold screenshots for regressions between phases.

**Phase focus:** ${phaseFocus}

Don't nitpick design choices or color preferences. Focus on things that are clearly broken, unfinished, or would make a user think the site is not production-ready.

## Rejection format

If you reject, your **Rejection Context** section MUST include:
1. The **exact file path(s)** that need fixing (e.g., \`src/pages/doctors/[slug].astro\`, \`src/components/Header.astro\`)
2. A **specific code-level diagnosis**: what is wrong in the template (e.g., "line 42 renders hardcoded 'Doctor Profile' instead of reading entry.data.name from the content collection")
3. A **concrete fix description**: what the implementer should change (e.g., "replace the hardcoded string with {entry.data.name} and destructure entry from Astro.props")

Do NOT describe issues only in visual terms. The implementer who reads your rejection cannot see screenshots — they need file paths and code-level guidance.

${sharedContext(ctx)}`;
}

function polishReviewerPrompt(ctx: ReviewerContext): string {
  return `You are a final polish reviewer.

Inspect the full site, evidence, and style fingerprint.
Focus on:
- final visual fidelity to the reference
- overall polish and cohesion
- whether the site feels production-ready from an aesthetic/UX perspective

Reject only for significant style fidelity gaps or major polish issues.
${sharedContext(ctx)}`;
}

export function getReviewersForPhase(phaseId: string): ReviewerDef[] {
  switch (phaseId) {
    case 'analyze':
      return [
        { id: 'analyze-fidelity', name: 'Analyze Fidelity', phase: 'analyze', model: 'M2', prompt: analyzeReviewerPrompt },
      ];

    case 'structure':
      return [
        { id: 'structure-architecture', name: 'Structure Architecture', phase: 'structure', model: 'M2', prompt: structureReviewerPrompt },
      ];

    case 'layout':
      return [
        { id: 'layout-composition', name: 'Layout Composition', phase: 'layout', model: 'M2', prompt: layoutReviewerPrompt },
        { id: 'visual-qa', name: 'Visual QA', phase: 'layout', model: 'V1', prompt: visualReviewerPrompt, perPageType: true },
      ];

    case 'mobile':
      return [
        { id: 'mobile-responsiveness', name: 'Mobile Responsiveness', phase: 'mobile', model: 'M2', prompt: mobileReviewerPrompt },
        { id: 'visual-qa', name: 'Visual QA', phase: 'mobile', model: 'V1', prompt: visualReviewerPrompt, perPageType: true },
      ];

    case 'design':
      return [
        { id: 'design-quality', name: 'Design Quality', phase: 'design', model: 'M2', prompt: designReviewerPrompt },
      ];

    case 'color':
      return [
        { id: 'color-fidelity', name: 'Color Fidelity', phase: 'color', model: 'M2', prompt: colorReviewerPrompt },
      ];

    case 'motion':
      return [
        { id: 'motion-quality', name: 'Motion Quality', phase: 'motion', model: 'M2', prompt: motionReviewerPrompt },
        { id: 'visual-qa', name: 'Visual QA', phase: 'motion', model: 'V1', prompt: visualReviewerPrompt, perPageType: true },
      ];

    case 'polish':
      return [
        { id: 'final-polish', name: 'Final Polish', phase: 'polish', model: 'M2', prompt: polishReviewerPrompt },
        { id: 'visual-qa', name: 'Visual QA', phase: 'polish', model: 'V1', prompt: visualReviewerPrompt, perPageType: true },
      ];

    default:
      return [];
  }
}

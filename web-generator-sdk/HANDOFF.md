# Session Handoff — Pipeline Tuning (Layout Phase)

## THE GOAL

From GOAL.md: **Tune the pipeline to run end-to-end autonomously across all 7 phases** (Analyze → Structure → Layout → Design → Color → Motion → Polish). Follow the diagnose→fix→rerun loop until the full pipeline succeeds.

**Current blocker: Phase 2 (Layout).** Phases 0–1 and all seed steps complete reliably. Layout builds successfully and passes contract checks, but fails runtime checks (Playwright) or reviewer gate.

## CONSTRAINT

- Only cheap profiles allowed: `friendli`, `zai`, or `mm`. Do NOT switch to `claude`.
- Current `cui.json` uses `"profile": "friendli"`.
- Use `bun run llm-watch` to monitor runs — saves tokens vs tailing output files.

## WHAT'S ALREADY BEEN DONE (in the source tree)

### Layout sub-agent architecture (src/steps/layout.ts)

The layout step uses a **divide-and-conquer** sub-agent architecture:

1. **Plan agent** (maxTurns: 15) — Reads design tokens, fingerprint, registry. Outputs `scratch/layout-plan.json` with exact CSS values, layout definitions, component list, and page groups. This is the single source of truth for CSS classes.

2. **Components agent** (maxTurns: 30) — Creates layout files (`src/layouts/*.astro`) and shared components (`src/components/*.astro`) from the plan.

3. **Per-page agents** (maxTurns: 15, parallel) — One agent per `.astro` page file, running concurrently with a `Semaphore` (default max 5, configurable via `cui.json` `steps.layout.maxConcurrentPageAgents`).

4. **Build-fix agent** (maxTurns: 50) — Runs `npx astro build`, creates missing files, fixes errors.

### Retry architecture (src/pipeline/runner.ts)

- **Incremental retry**: When a reviewer rejects (not implementer crash), the next attempt copies from the **previous attempt's completed output** instead of restoring to pre-phase state. The agent finds all files already in place and focuses on fixes.
- **Rejection context**: Passed via `ctx.rejectionContext` to the implementer on retry.

### Targeted retry (src/steps/layout.ts)

On retry:
- Plan and components agents are **skipped** (output already exists from prior attempt).
- Per-page agents only run for **files mentioned in the rejection context** (not all pages).
- The retry page agent prompt is focused: "Read the existing file, make ONLY the changes the reviewer requested."

### Runtime gate alignment (src/lib/checks.ts) — RECENT

Previously, the runtime check gate for the layout phase filtered out most failures (broken images, hasContent, hasOverflow, 404 console errors). This meant:
- Errors from the layout agent (e.g., inventing `/images/logo.svg` instead of using a real asset path) silently passed through and propagated to every subsequent phase.
- The rejection context sent to retry agents included ALL failures (unfiltered), creating noise the agent couldn't act on.

**Fixed:**
- Layout now blocks on ALL runtime failure types: `consoleErrors`, `hasContent`, `headingHierarchyOk`, `hasOverflow`, `hasNav`, `hasFooter`, `brokenImages`.
- The rejection context now only includes blocking failures (filtered report), so the retry agent gets a clean signal. This benefits all phases, not just layout.

### Asset manifest injection (src/steps/layout.ts) — RECENT

The layout agents (components, page templates, page fix, build-fix) now receive the asset manifest listing all available image paths in `public/images/`. The prompt tells agents to only use paths from the manifest and never invent image paths.

### Layout reviewer scope (src/lib/reviewer-matrix.ts) — RECENT

The layout reviewer no longer ignores broken images. It now checks for broken image references and empty content wiring in addition to structural composition.

### Other fixes already applied

- `src/lib/invariants.ts` — Dynamic route matching for `[slug]` patterns
- `src/lib/playwright-sampler.ts` — Optional viewports field, maxSamplesPerType reduced to 2, homepage always included
- `src/lib/checks.ts` — Layout phase: desktop-only viewports
- `src/lib/reviewer-matrix.ts` — Layout reviewer excludes mobile nav, typography, font-size, mobile responsive
- `src/steps/layout.ts` — Route map injection, container width `max-w-[Xpx]`, Hero conditional grid, section padding from tokens, programmatic link repair, heading normalization, popup mounts
- `scripts/llm-watch.ts` — Stall timeout 10 min
- `src/lib/reviewer.ts` — Semaphore class (reused by layout step for parallel page agents)

## WHAT'S HAPPENING NOW

The last run (`20260404-222850`) failed at `layout-runtime` after exhausting 3 attempts. The pattern was:
- Layout implementer **builds successfully** every time (100+ pages, typecheck passes, invariants pass)
- **Runtime checks fail** — the blocking issues were:
  - `/legal/terms-conditions` and `/legal/privacy-policy`: heading hierarchy broken (`headingHierarchyOk: false`)
  - `/images/logo.svg`: Header component referenced a nonexistent image (layout agent invented the path instead of using `rhc-logo-2.png` from the asset manifest)
  - Various pages with 404 console errors from the invented logo path

With the recent fixes (asset manifest injection, stricter gate, aligned rejection context), the next run should:
- Give the layout agent visibility into available images → no more invented paths
- Block on all real issues → nothing silently passes through
- Send clean rejection context → retry agent knows exactly what to fix

## WHAT TO TRY NEXT

### 1. Run the pipeline and see how the fixes perform

The recent changes (asset manifest, gate alignment, rejection context) haven't been tested in a live run yet. Run from scratch and observe:
- Does the layout agent use real image paths from the manifest?
- Are the runtime check failures actionable and specific?
- Does the retry agent fix the issues it's told about?

### 2. Internal sub-phase review loops (if convergence is still poor)

If the layout step still fails after 3 attempts, the biggest architectural improvement is adding lightweight review gates between sub-agents inside `layout.ts`:

- **After plan agent**: Validate `layout-plan.json` — do pageGroups cover all registry pages? Are grid column counts reasonable?
- **After components agent**: Review the component files — does Footer grid-cols-N match child count? Do layouts use `<main class="w-full">`?
- **After page agents + build-fix**: Existing full review gate.

Each mini-review has its own retry loop. Errors don't compound across sub-agents.

### 3. Bump maxRetries if convergence is close

Currently `maxRetries: 2` (3 total attempts). If the reviewer consistently flags only 1-2 issues per attempt, bumping to `maxRetries: 3` or `4` gives more chances to converge. Each retry is fast (skip plan/components, only fix flagged files).

## KEY FILES

| File | Purpose |
|------|---------|
| `src/steps/layout.ts` | Layout step with divide-and-conquer sub-agents |
| `src/pipeline/runner.ts` | Pipeline orchestration, incremental retry logic |
| `src/lib/reviewer-matrix.ts` | Reviewer prompts and phase assignments |
| `src/lib/reviewer.ts` | Reviewer runner + Semaphore class |
| `src/lib/checks.ts` | Contract + runtime check orchestration, gate filtering |
| `src/lib/playwright-sampler.ts` | Playwright page sampling |
| `src/lib/invariants.ts` | Static invariant checks (links, headings) |
| `src/types.ts` | StepConfigOverride (maxConcurrentPageAgents) |
| `src/steps/step.ts` | StepContext interface |
| `scripts/llm-watch.ts` | Pipeline monitor script |

## RULES

- Every fix must improve the pipeline for arbitrary inputs (not just this site)
- Do NOT touch `template/` or `cui.json`
- Do NOT modify run artifacts in `runs/`
- Phase ownership table is in `CLAUDE.md`

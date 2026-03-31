# GOAL: Full Pipeline Run — Clean Pass

## Objective
Run the full 7-phase pipeline (`bun dev`) end-to-end and fix any issues that arise. The pipeline must complete all 7 phases without exhausting retries.

## Rules
1. **NEVER touch `template/`** — it's a generic base, not site-specific
2. **Keep the pipeline architecture intact** — 7 phases, implementer+reviewer pattern, phase-aware invariant checks
3. **Fix issues in SDK source code only** (`src/`), not in run outputs or templates

## What Was Fixed
1. **seed.ts `normalizeCollections()` field name bug** — The classify AI step outputs collections with `id` field (e.g., `"id": "patient_journeys"`), not `name`. The function was looking for `.name`, found nothing, and skipped all entries. This produced numeric content directories (`0/`, `1/`, ..., `7/`) and broke the content config. Fix: `obj.name || obj.id`.
2. **invariants.ts phase-aware filtering** — Layout/design/color/motion phases skip data-level checks (`broken-internal-links`, `source-origin-leakage`) that only polish can fix
3. **template/ cleanup** — Removed site-specific files that were accidentally added

## Current State
- Old run `20260330-002952` was killed (had numeric collection bug)
- **New run `20260330-030334`** started with fixed code, currently in analyze phase (~45min)
- TypeScript compiles clean (`tsc --noEmit` passes)
- Template is clean

## What to Verify After Seed Completes
- `content.config.ts` should have semantic collection names (`doctors`, `blog_posts`, etc.), NOT numeric keys (`0`, `1`, ...)
- Content directories should be `src/content/doctors/`, `src/content/blog_posts/`, etc.

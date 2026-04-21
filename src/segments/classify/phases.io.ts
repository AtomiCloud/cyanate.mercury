/**
 * IO shell: classify segment phase definitions.
 *
 * Phases live in `phases/*.ts`; this file is a thin re-export so the segment
 * registration in `index.ts` and existing importers don't need to know about
 * the directory structure.
 *
 * Currently wired:
 *   1. `classify-prepare`  — materialize per-page content.json inputs
 *   2. `chrome-classify`   — per-page chrome classify + inline reviewer
 *
 * Per-page-type harmonize + materialize/verify land as later stages —
 * see `CLASSIFY-PLAN.md`.
 */

export { chromeClassifyPhase } from "./phases/chrome-classify.js";
export { classifyPreparePhase } from "./phases/prepare.js";

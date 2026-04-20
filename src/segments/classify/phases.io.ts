/**
 * IO shell: classify segment phase definitions.
 *
 * Phases live in `phases/*.ts`; this file is a thin re-export so the segment
 * registration in `index.ts` and existing importers don't need to know about
 * the directory structure.
 *
 * Currently wired: phase 1 (prepare). Per-page chrome classify + per-pagetype
 * harmonize + materialize/verify land as later stages — see `CLASSIFY-PLAN.md`.
 */

export { classifyPreparePhase } from "./phases/prepare.js";

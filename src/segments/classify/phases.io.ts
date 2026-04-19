/**
 * IO shell: classify segment phase definitions.
 *
 * Phases live in `phases/*.ts`; this file is a thin re-export so the segment
 * registration in `index.ts` and existing importers don't need to know about
 * the directory structure.
 *
 * Stage 1 (current): only phases 1 (prepare) + 2 (value-normalize) are wired.
 * Phases 3–6 (noise-trim, chunk-remap, fate-scope, shape-and-kind) land in
 * subsequent stages — see `CLASSIFY-REWRITE-PROGRESS.md`.
 */

export { classifyPreparePhase } from "./phases/prepare.js";
export { perPageValueNormalizePhase } from "./phases/value-normalize.js";

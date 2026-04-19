/**
 * IO shell: classify segment phase definitions.
 *
 * Phases live in `phases/*.ts`; this file is a thin re-export so the segment
 * registration in `index.ts` and existing importers don't need to know about
 * the directory structure.
 *
 * Wired so far: phases 1 (prepare) and 2 (value-normalize, which now also
 * carries the deterministic + LLM noise detection formerly in phase 3 —
 * every leaf is visited by the LLM at most once).
 * Phases 4–6 (chunk-remap, fate-scope, shape-and-kind) land in subsequent
 * stages — see `CLASSIFY-REWRITE-PROGRESS.md`.
 */

export { classifyPreparePhase } from "./phases/prepare.js";
export { perPageValueNormalizePhase } from "./phases/value-normalize.js";

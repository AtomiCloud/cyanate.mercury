/**
 * IO shell: classify segment phase definitions.
 *
 * Phases live in `phases/*.ts`; this file is a thin re-export so the segment
 * registration in `index.ts` and existing importers don't need to know about
 * the directory structure.
 *
 * Wired:
 *   1. `classify-prepare`           — materialize per-page content.json inputs
 *   2. `chrome-classify`            — per-page chrome classify + inline reviewer
 *   3. `chrome-shape-normalize`     — per-page shape normalization + reviewer/fixer
 *   4. `harmonize-prepare`          — build per-pagetype occurrence + digest (programmatic)
 *   5. `harmonize-align`            — dynamic tree-reduce: per-pagetype LLM fan-out
 *                                      over batches of N pages (N = classify.pagesPerBatch,
 *                                      default 5) with inline reviewer; loops until
 *                                      each pagetype converges to ≤ 1 batch
 *   6. `harmonize-materialize`      — apply composed renames to per-page chrome;
 *                                      emit chrome.aligned/<hash>.{json,reverse.json}
 *                                      + pagetype-wide chrome.compressed.json debug view
 *   7. `harmonize-verdicts`         — LLM fan-out + reviewer: per-candidate verdicts
 *   8. `harmonize-assemble`         — build canonical tree + mappers (programmatic)
 *   9. `chrome-verify`              — deterministic round-trip check
 *
 * Cross-pagetype harmonize (global chrome) lands as Stage 5 — see
 * `CLASSIFY-PLAN.md`.
 */

export { chromeClassifyPhase } from "./phases/chrome-classify.js";
export { chromeShapeNormalizePhase } from "./phases/chrome-shape-normalize.js";
export { harmonizeAlignPhase } from "./phases/harmonize-align.js";
export { harmonizeAssemblePhase } from "./phases/harmonize-assemble.js";
export { harmonizeMaterializePhase } from "./phases/harmonize-materialize.js";
export { harmonizePreparePhase } from "./phases/harmonize-prepare.js";
export { harmonizeVerdictsPhase } from "./phases/harmonize-verdicts.js";
export { classifyPreparePhase } from "./phases/prepare.js";
export { chromeVerifyPhase } from "./phases/verify.js";

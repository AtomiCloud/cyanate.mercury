/**
 * Phase 3b — `harmonize-align`
 *
 * Dynamic tree-reduce align phase. Per-pagetype, we loop: each iteration
 * reduces the current digest set `classify.pagesPerBatch` at a time
 * (default 5): one agent call per batch emits a batch-local rename table
 * plus a new merged digest for that batch. Sibling rename tables are not
 * unioned inside the same iteration. Instead, later iterations reconcile
 * the emitted digests until exactly one digest remains. Hard cap of 6
 * iterations as a non-convergence safety net.
 *
 * Iteration N's artifacts live under `classify-output/<pagetype>/layer-N/`.
 * Once the reduction converges, the phase writes `rename-table.composed.json`
 * + `digest.composed.json` at the pagetype root for downstream phases.
 *
 * Profile keys:
 *   - classify.harmonize-align.align-agent
 *   - classify.harmonize-align.align-reviewer
 */

import { buildAlignPhase } from "./harmonize-align-shared.js";

export const harmonizeAlignPhase = buildAlignPhase();

# Classify segment rewrite — staged implementation plan

Plan source: `/Users/erng/.claude-opus47/plans/groovy-cuddling-teapot.md`

## Strategy

Each stage must leave the repo in a **green** state (lint+typecheck+knip pass,
unit tests pass). New phases 3–6 are added one at a time so each can be
exercised against a real run before moving on.

**Current state**: Stage 1 complete. Stage 2 superseded — the old phase 3
(`per-page-noise-trim`) has been **dissolved into phase 2
(`per-page-value-normalize`)** so every leaf is visited by the LLM at most
once. Deterministic noise signatures are attached inline during the
deterministic pre-pass; ambiguous leaves now get one merged LLM call that
judges both type and `isNoise`. `phases/noise-trim.ts` has been deleted.

---

## Stage 0 — Shared infrastructure (rolled into Stage 1 commit)

Files that everything else depends on.

- [x] `types.ts` — minimal (`ClassifyUnit` only); block-level types re-added per stage
- [x] `lib/path-utils.ts` — renamed from `coverage.ts`; `setPathCreating` added in Stage 2 for leaf-tree stitch-back
- [x] `lib/noise-signatures.ts` — landed in Stage 2 (deterministic classifier)
- [ ] `lib/block-ops.ts` — re-introduced in Stage 3 (phase 4 consumer)
- [x] `per-page-classify.ts` — trimmed to normalize-only (role/subclass helpers deleted)

---

## Stage 1 — Move phases 1+2 to new layout, delete obsolete plumbing, get to GREEN

Objective: reach a compiling state where the classify segment runs only
phase 1 (`classify-prepare`) and phase 2 (`per-page-value-normalize`).
Downstream phases 3–6 do not exist yet; `extractOutput` just passes through
prepare's files without producing a `page-classifications.json`.

- [x] Create `phases/prepare.ts` — exports `classifyPreparePhase` (copy of current phase 1)
- [x] Create `phases/value-normalize.ts` — exports `perPageValueNormalizePhase` (renamed from `per-page-normalize`)
- [x] Reduce `phases.io.ts` to re-exports of phases 1+2 only (delete role-classify + sub-classify phases)
- [x] Update `index.ts` — register only phases 1+2, trim `extractOutput` file list
- [x] Update `cui.yaml` — rename `classify.per-page-normalize.a0-normalize` → `classify.per-page-value-normalize.a0-normalize`
- [x] Delete obsolete test sections in `per-page-classify.test.ts` (role/subclass/coverage; keep normalize + hash + paths tests)
- [x] Remove `page-classifications.json` / `classify-coverage-report.json` from segment `extractOutput`
- [x] `check-cli.ts` — audit for broken references after trim (still imports `parseNormalizationFromAgent` + `checkNormalization`, both kept)

**Verification**:
- [x] `direnv exec . bun run check` — lint + typecheck + knip all clean ✅
- [x] `direnv exec . bun test src/segments/classify/` — 88/88 classify tests pass ✅
- [x] `direnv exec . bun test` — 597/597 total tests pass ✅
- [ ] `direnv exec . ./src/cli.ts run --start-segment classify` — deferred: needs live LLM, user to run manually

---

## Stage 2 — Phase 3 dissolved into Phase 2 (merged normalize + noise)

**Rationale**: per-leaf normalization and per-leaf noise detection were both
touching every ambiguous leaf with a separate LLM call. That was paying for
the leaf twice. The merged design visits each leaf **at most once**: the
deterministic pre-pass attaches obvious noise signatures inline, and the
ambiguous-leaf LLM batch returns `{type, normalized, isNoise, reason?}` per
leaf in a single prompt.

- [x] `NormalizationEntry` extended with optional `noise?: { signature, reason? }`
- [x] `deterministic-normalize.ts` attaches `noise` for deterministic signatures (null, empty, whitespace-only, "null"/"undefined"/"N/A"/"(no data)")
- [x] `llm-normalize.ts` prompt + parser extended with `isNoise`/`reason` — invalid `isNoise=true` without `reason` rejects the entry
- [x] Phase 2 `apply-normalizations` step now emits 4 files under `normalize/output/`:
  - `normalization.json`, `normalized-content.json`, `kept-leaves.json`, `noise-log.json`, `trimmed-content.json`
- [x] Partition + stitch helpers (`partitionByNoise`, `stitchKeptLeaves`) live in `per-page-classify.ts`
- [x] `lib/noise-signatures.ts` + `lib/path-utils.ts` `setPathCreating` still carry their weight (reused by the merged phase)
- [x] `phases/noise-trim.ts` + `phases/noise-trim.test.ts` deleted; `phases.io.ts` and `index.ts` updated

**Verification**:
- [x] `direnv exec . bun run check` — lint + typecheck + knip clean ✅
- [x] `direnv exec . bun test` — 623/623 tests pass ✅
- [ ] `./src/cli.ts run --start-segment classify` — **pending user manual test** (reaches phase 2, produces `normalize/output/{normalization,normalized-content,trimmed-content,kept-leaves,noise-log}.json` per page)

---

## Stage 3 — Phase 4: `per-page-chunk-remap`

- [ ] Create `phases/chunk-remap.ts`
  - Step 4a `chunk-remap-agent` (agent fan-out): writes `blocks-draft.json` per unit
  - Step 4b `apply-chunks` (programmatic verify gate): run `checkBlockPartition` from `block-ops`; write `chunk-remap/output/blocks.json`
- [ ] Register phase 4
- [ ] Add `classify.per-page-chunk-remap.chunk-remap-agent` profile placeholder
- [ ] Unit tests: `phases/chunk-remap.test.ts` (partition, yank accounting, label uniqueness, parse)

**Verification**: same as Stage 2, plus confirm `blocks.json` lines up with kept leaves

---

## Stage 4 — Phase 5: `per-page-fate-scope`

- [ ] Create `phases/fate-scope.ts`
  - Step 5a `fate-scope-agent` (agent fan-out): writes `fate-scope.json`
  - Step 5b `apply-fate-scope` (programmatic): merge onto blocks, enum validation, count match
- [ ] Register phase 5
- [ ] Add `classify.per-page-fate-scope.fate-scope-agent` profile placeholder
- [ ] Unit tests: `phases/fate-scope.test.ts`

---

## Stage 5 — Phase 6: `per-page-shape-and-kind`

- [ ] Create `phases/shape-and-kind.ts`
  - Step 6a `shape-and-kind-agents` (agent fan-out): per-unit `Promise.all` of cms shape-agent + non-cms kind-agent
  - Step 6b `apply-shape-and-kind` (programmatic): merge, validate exactly-one-of shape/kind per block
- [ ] Register phase 6
- [ ] Add `classify.per-page-shape-and-kind.shape-and-kind-agents` profile placeholder
- [ ] Unit tests: `phases/shape-and-kind.test.ts`

---

## Stage 6 — Segment output aggregation

- [ ] Update `index.ts` `extractOutput` to:
  - Aggregate per-unit `shape-and-kind/output/blocks.json` into `page-classifications.json` as `PageClassification[]` (new shape)
  - Emit `classify-coverage-report.json` with per-page gate results
- [ ] Confirm downstream segments don't read `page-classifications.json` (plan says they don't, re-verify)

**Verification**: full pipeline run on `example/physio`; inspect `page-classifications.json` for expected block counts and annotations

---

## Stage 7 — Final cleanup

- [ ] Delete any dead exports knip flags from `per-page-classify.ts`
- [ ] Confirm no references to old role/subclass types anywhere
- [ ] Final `bun run check` clean

---

## Notes / gotchas

- `ClassifyUnit` moved from `per-page-classify.ts` to `types.ts`. Imports
  in every phase file must point at `types.js`.
- `ValidationResult` also lives in `types.ts`.
- `coverage.ts` → `lib/path-utils.ts`: `deterministic-normalize.ts` and
  `llm-normalize.ts` already updated in Stage 0.
- Segment-level `page-classifications.json` shape CHANGES — old:
  `{ pages: PageClassification[] }` with `entries` map. New: bare array
  with `blocks: Block[]`. Plan confirmed nothing outside classify consumes it.
- Each new phase uses `runFanOutWithPerUnitRetry` with `maxAttempts = 3`.
  Rejection context from gate failures flows into next-attempt prompt.
- Phase 6 has `Promise.all` of two sub-agents **inside** one `runUnit` — the
  fan-out framework treats the combined result as one unit.
- Tests: each phase's test file focuses on the pure parse + validator funcs,
  not the io shell. Keep io-shell tests minimal (types compile, happy path).

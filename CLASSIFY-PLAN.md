# Classify segment — plan

See also: [UL.md](./UL.md) for the vocabulary used below (`chrome`, `page_type`, `harmonize`, `canonicalize`, etc).

## Goal

For every `page_type` cluster, produce:
- **chrome** — the canonical chrome fields (with values) shared by pages of that type
- **body** — per-page residual content (original minus chrome)
- **per-page mapping** — for each page, which of its source paths map to which canonical chrome field

Invariant: `body + chrome + mapping → original page` byte-for-byte. Any mismatch fails the phase loudly.

Later: extract `global` chrome (fields shared across every page_type) via cross-pagetype harmonize.

## Design (pivot from fold)

Earlier experimentation used a serial fold per page_type with an ops vocabulary (`add-path` / `remove-path` / `yank` / `normalize`) and a per-step reviewer. That machinery was over-engineered. Current design is simpler:

1. **Per-page chrome classify (parallel, per `page_type`)** — one LLM call per page. Input: the page's content. Output: the paths on this page that are chrome, with an optional suggested canonical name per path. No cross-page context in this call. Parallelizable across pages.

2. **Harmonize within `page_type`** — one pass per page_type. Takes the union of per-page chrome paths + their suggested canonicals, runs a (largely deterministic) merge:
   - Values must agree across pages for a path to stay chrome. Disagreement → drop from chrome (it's per-page dynamic).
   - Similar paths with different suggested canonicals get merged (one LLM call for rename judgment if heuristics aren't enough).
   - Output: `chrome.json` (canonical fields + values) + per-page `{sourcePath → canonicalName}` mapping.

3. **Materialize + verify (programmatic)** — for each page: subtract source paths → write `body/<hash>.json`; reconstruct `body + chrome + mapping` → deep-equal to original or fail loudly.

4. **Cross-`page_type` harmonize (future)** — extract `global` chrome (fields identical across every page_type's chrome template); produce a layout-level template.

Trade-off: per-page classify loses cross-page context (one page can't see that 23 peers all have `header.logo`). Harmonize recovers this via the value-agreement check and rename merging. In exchange: 1 LLM call per page (not 2), parallel rather than serial, simpler prompt per call, simpler data model.

## UL glossary (quick reminder)

- `chrome` / `body` — axis 1 (structural role)
- `global` / `per-page-type` / `per-page` — axis 2 (scope)
- `harmonize (layout)` vs `harmonize (page-type)` — cross-page passes at different scopes
- `canonicalize` — pure rename pass (subset of harmonize)

Fate (`content` / `dynamic` / `interactive` / `noise`) is **out of scope** for this plan. Fate classification lands in a later phase after chrome has been extracted.

## Current state

**Stages 1, 2, 4 implemented. Stage 3 (harmonize) is being rewritten** — the previous single-agent `chrome-harmonize-pagetype` phase converged unreliably and produced silent semantic defects (LLM decisions drifting from the canonical tree it built in the same turn). Replaced by a 4-logical-stage design (prep → align → verdicts → assemble); align-names is a dynamic tree-reduce over 5-page batches (configurable via `classify.pagesPerBatch`) that loops until each pagetype converges. Stage 5 (cross-pagetype global chrome) remains.

Pipeline (post-rewrite):
```
classify (depends: [prepare])
├── classify-prepare              — materialize per-page content.json inputs
│                                    under classify-input/<pagetype>/<hash>/content.json
├── chrome-classify               — per-page chrome classify + inline reviewer
│                                    writes output/chrome-classify.json per page
├── harmonize-prepare             — programmatic: build per-pagetype digest +
│                                    occurrence-table from chrome-classify output
├── harmonize-align               — per-pagetype dynamic tree-reduce: agent
│                                    fan-out over batches of N + reviewer;
│                                    loops until each pagetype converges to
│                                    ≤ 1 batch; writes rename-table.composed
│                                    + digest.composed for downstream
├── harmonize-verdicts            — agent fan-out per pagetype: emit per-candidate
│                                    verdicts (keep-static / keep-dynamic / demote
│                                    / defer-to-operator) with concrete named value
│                                    for keep-static; keep-dynamic materializes a
│                                    per-page chrome-dynamic.json sidecar
├── harmonize-assemble            — programmatic: build canonical chrome tree + per-page
│                                    mappers deterministically from verdicts
└── chrome-verify                 — deterministic round-trip gate; writes per-page
                                     body.json
```

## Staged rollout (not yet started)

Each stage leaves the repo in a green state and is testable end-to-end against `./example/physio` before moving on.

### Stage 1 — classify-prepare (DONE)

- Output: `classify-input/<pagetype>/<hash>/content.json` per page.
- Nesting by `<pagetype>` makes it easy to eyeball which pages share a cluster without cross-referencing.

### Stage 2 — per-page chrome classify (DONE)

- One LLM call per page + inline reviewer. Parallel across pages within a page_type; also parallel across page_types (bounded by `config.concurrency.maxQueries`).
- Input: the page's content. Output: `{chromePaths: [{sourcePath, suggestedCanonical?}]}`.
- Written to `classify-input/<pagetype>/<hash>/output/chrome-classify.json`.
- Profile keys: `classify.chrome-classify.chrome-classify-agent` + `classify.chrome-classify.chrome-classify-reviewer`.

### Stage 3 — per-page-type harmonize (REWRITE)

**Status: in progress.** Replaces the earlier single-agent `chrome-harmonize-pagetype` phase. The LLM no longer builds the canonical tree — it emits verdicts, a deterministic assembler builds the tree. This eliminates the "decision says X, tree says Y" failure class we observed in run `20260420-213103` on `team_member` (value_conflicts declared `keep-majority` on `header.navigation[2].href` and `[7].href` but the canonical omitted the field).

Split into **four phases**. Two call the LLM; two are programmatic.

#### Design principles (driving the split)

- **LLM judgment is separated from tree construction.** The agent names values; the assembler places them. Decision-vs-tree divergence becomes structurally impossible.
- **No coverage thresholds.** Scraper unreliability makes `X / N pages had this field` unreliable as a signal — we'd be laundering extraction noise into canonical. The robust signal is *value homogeneity among present pages* plus the LLM's semantic read of the value itself. Coverage is descriptive metadata, never a routing gate.
- **Per-stage programmatic validators.** Each LLM stage has a tight, targeted validator with precise rejection feedback. Retries converge faster because the agent knows exactly what invariant it violated.
- **Align-names tree-reduces over 5-page batches (configurable via `classify.pagesPerBatch`).** Scales to pagetypes with thousands of pages without blowing up the agent prompt. Each batch's LLM sees that batch's chromePaths + values (values matter — they distinguish aliases from same-shape-different-meaning). Each iteration folds the prior iteration's per-batch outputs; the loop runs until the next iteration would have ≤ 1 batch, capped at 6 iterations as a non-convergence safety net. Every iteration's rename_table is preserved; a composed final table chains them for downstream consumers.
- **Per-batch reviewer watches the remap.** Align-names batches each get a reviewer in addition to the programmatic validator — the reviewer sees the same values the agent saw and rejects mis-judged aliases (e.g. `header.title ↔ footer.title` where values clearly differ). Without this, a bad iteration-1 merge is invisible to iteration 2. Reviewer chunks its review in groups of ≤ 20 rename rules for focus.
- **Verdicts keeps a single-call design with reviewer.** Input volume is bounded by candidate count post-rename, which is small after alignment. Assemble has no LLM.

#### Phase 3a — `harmonize-prepare` (programmatic)

Scans every page's `content.json` + `output/chrome-classify.json`. Per page-type, emits:

- `classify-output/<pagetype>/occurrence-table.json` — flat `(candidatePath, pageHash, value)` rows. Candidate grouping key is `suggestedCanonical ?? sourcePath`.
- `classify-output/<pagetype>/value-digest.json` — per-candidate: `{ distinctValues: [{value, pageHashes}], presentOn: [...], absentFrom: [...] }`.

No scoring, no thresholds, no judgment. Validator: every candidate path is parseable; every page is accounted for. `maxRetries: 0`.

#### Phase 3b — `harmonize-align` (dynamic tree-reduce)

The original single-call align-names worked for the physio example (small pagetypes) but breaks down at scale: a pagetype with hundreds of pages generates hundreds of candidates, which doesn't fit in one prompt with values. Replaced by a tree-reduce over **batches of N pages** (N = `classify.pagesPerBatch`, default 5) that loops dynamically per pagetype until convergence, capped at 6 iterations.

**Single phase, dynamic loop.** Per pagetype, iteration 1 batches the original page list; iteration N≥2 batches the prior iteration's per-batch outputs. The loop exits when the next iteration would have ≤ 1 batch (i.e., the prior iteration already saw everything cross-batch and nothing new can be reconciled). Small pagetypes converge in one iteration; large ones keep iterating — no hard cap. Pagetypes with `totalPages ≤ 1` skip the LLM entirely (no aliases possible).

**Per-batch loop (identical at every iteration):**

1. **Agent call** — input: batch's 20 items (pages at iteration 1; prior-iteration per-batch outputs at iteration ≥ 2) with paths + distinct values + page hashes. Output: `{ rename_table: [{ from, to, reason }] }`.
2. **Programmatic validator** (structural, fatal on fail): every `from` appears in batch input; `from !== to`; no cycles; no ambiguous mappings; no renames collapsing structurally-incompatible shapes. A terminal `to` MAY be a synthetic name (not observed on any page) — needed when several pages use divergent variants (`nav`, `nav_items`, `navigation`) and none is a clean canonical. Path integrity is enforced post-apply by step 4, not here.
3. **Coverage check** (programmatic): every input candidate either (a) stays untouched or (b) is a `from` in rename_table. No silent drops. Trivially true given the validator, but asserted explicitly so regressions fail loudly.
4. **Trace-coverage check** (programmatic, post-apply): apply the rename table to the batch digest, then assert every original candidate path resolves to a bucket in the applied digest whose `presentOn` is the union of its sources' page hashes, and that the applied digest contains no bucket that isn't the terminal of some rename chain. This is the safety net that lets step 2 accept synthetic `to` names: an invented canonical is fine as long as the applied algebra remains faithful.
5. **Reviewer** (LLM, semantic): checks each proposed rename against values. Rejects mis-judged aliases (e.g. `header.title ↔ footer.title` where values look different). Reviewer splits its review in chunks of ≤ 20 rules per LLM call; any chunk rejecting fails the batch.
6. **Retry** — up to 2 per batch. Any validator / coverage / trace-coverage / reviewer-chunk failure at attempt `i` → aggregated findings become the `rejectionContext` for attempt `i+1`. Findings are prefixed with their source (`validator:`, `coverage:`, `trace-coverage:`, `reviewer:`) so the agent sees actionable, de-duplicated feedback.

**Per-iteration union + apply** (programmatic, after all batches pass):

- Union per-batch rename_tables (disjoint `from`s since batches partition the candidate set) → `layer-N/rename-table.json`.
- Apply to the iteration's input digest → `layer-N/digest.json` (the reduced candidate set fed to iteration N+1 if needed).

**Resume idempotency.** An iteration is considered "committed" when `layer-N/digest.json` is present on disk (it's the last file written in each iteration). On resume, any committed iteration's artifacts are reused — no fresh LLM calls — and the loop continues from there. Matches today's cross-phase resume behavior (don't redo work that already passed).

**Composition + final output** (written at the end of the final iteration for a pagetype):

- `rename-table.composed.json` — chain of all executed iterations' union tables. For every original candidate, walks the chain and records the final canonical name + reasons per hop.
- `digest.composed.json` — final post-rename digest.
- Post-composition coverage check: every candidate in the original `digest.json` resolves to a final canonical name in `digest.composed.json`. If not, the phase fails loudly.
- Verdicts and assemble read only these two composed files — they stay iteration-count-unaware.

**Profile keys** (shared across all iterations):

```
classify.harmonize-align.align-agent
classify.harmonize-align.align-reviewer
```

Defaults: `zai-org/GLM-5` for the agent, `zai-org/GLM-5.1` for the reviewer.

**Per-pagetype artifacts:**

```
classify-output/<pagetype>/
  digest.json                                    # from harmonize-prepare
  occurrence-table.json                          # from harmonize-prepare
  layer-1/
    attempts/batch-<i>/<attempt>/
      align.prompt.txt, align.response.txt, align.parsed.json, align.error.txt
      review.chunk-<j>.prompt.txt, review.chunk-<j>.response.txt,
      review.chunk-<j>.verdict.txt, review.chunk-<j>.findings.txt
    rename-table.batch-<i>.json
    rename-table.json                            # union within iteration
    digest.json                                  # post-iteration reduced
  layer-2/ (only if iteration 2 ran; identical shape)
  layer-3/ (only if iteration 3 ran; identical shape)
  ...                                            # N is runtime-determined
  rename-table.composed.json                     # final chained — verdicts + assemble read this
  digest.composed.json                           # final post-rename digest
```

`layer-N/` directories survived the rewrite as artifact names; N is now a runtime-determined iteration index rather than a fixed layer number. Per-iteration granularity also surfaces in step names: `classify/harmonize-align/iter-<N>/align[<pagetype>/batch-<i>]#<attempt>`.

**Constants:**

- `PAGES_PER_BATCH = 5` — default batch size for align fan-out. Configurable per-project via `classify.pagesPerBatch` in `cui.yaml`.
- `MAX_ITERATIONS = 6` — hard cap on the align loop. Exceeding this fails the pagetype loudly (likely non-convergence defect, not legitimate scale).
- `RULES_PER_REVIEW_CHUNK = 20` — hard-coded.
- `MAX_PER_BATCH_RETRIES = 2` — hard-coded.

**Phase-level retry**: `maxRetries: 0`. Per-batch retries live inside each agent loop; the phase doesn't restart when a batch fails.

#### Phase 3c — `harmonize-verdicts` (agent fan-out per page-type)

Takes the renamed occurrence digest and asks for a verdict per canonical candidate.

- **Preprocessing (programmatic)**: apply `rename_table` to the value-digest, folding aliased paths together.
- **Agent input**: for each post-rename canonical candidate — the name, every distinct value observed (with page hashes; `null` counted as a value), and which pages didn't have it.
- **Verdict set** (LLM picks exactly one per candidate):
  | Verdict | Agent also names | Meaning |
  |---|---|---|
  | `keep` | concrete value | present pages agree (or single-page with chrome-looking value); absent pages get this value at render time |
  | `keep-majority` | concrete value | present pages disagree; agent picks one value explicitly (including `null`) |
  | `demote` | — | value pattern reads as authorial / per-page content; not chrome |
  | `defer-to-operator` | — | genuine disagreement LLM won't resolve; operator reviews downstream |
- **Programmatic validator**:
  - Every post-rename canonical candidate has exactly one verdict — no missing, no duplicates.
  - `keep` / `keep-majority` include a concrete value. `null` is a valid value; explicit null is required.
  - `demote` / `defer-to-operator` include a rationale string.
  - No verdicts on candidates not present in the post-rename digest (catches fabrication).
- **Reviewer**: yes — `classify.harmonize-verdicts.verdicts-reviewer`. Checks semantic quality: do `demote` rationales actually describe per-page content? Does a `keep-majority` with a 1-of-7 "majority" really look correct, or should it have been `defer`?
- **Output**: `classify-output/<pagetype>/verdicts.json`.
- Profile keys: `classify.harmonize-verdicts.verdicts-agent` + `.verdicts-reviewer`.
- **Retries**: `MAX_RETRIES = 0` — fails immediately on any malformed output, validator reject, or reviewer reject. A retry with the same digest + prompt rarely flips the verdict; if the model produced a defect once, that's a signal (prompt drift, model regression, candidate set too dense) worth surfacing rather than burning turns.

#### Phase 3c — revision proposal: split `keep` into `keep-static` / `keep-dynamic`

**Status: IMPLEMENTED.** Supersedes the `keep` / `keep-majority` vocabulary above. `demote` and `defer-to-operator` are unchanged.

**Motivation.** Two distinctions the current four-verdict set flattens:

1. *Semantically-equivalent values written differently* — phone numbers, names, addresses. The validator requires `keep-majority.value` to deep-equal an observed `distinctValue`, so the LLM cannot emit a normalized canonical; it picks one variant and silently loses the rest, or punts to `defer-to-operator`.
2. *Dynamic chrome* — breadcrumbs, related/suggested posts, pagination, next/prev, active-nav indicators. Structurally chrome (layout reserves space; it belongs to the shared template) but the value is per-page by design. Current vocabulary forces a false choice: `demote` (wrong — it *is* chrome), `keep-majority` (wrong — no majority), `defer-to-operator` (punt).

**New verdict set.**

| Verdict | Value | Meaning |
|---|---|---|
| `keep-static` | LLM names canonical value | Chrome with one shared value. Value may be an observed distinct value OR a normalized form (e.g. phone reformat). |
| `keep-dynamic` | none | Chrome, but values vary per-page by design. Canonical leaf holds the sentinel `"<dynamic>"`; per-page values live in sibling `chrome-dynamic.json`. |
| `demote` | — | Per-page authored content. Not chrome. Unchanged. |
| `defer-to-operator` | — | Agent won't resolve. Unchanged. |

Old `keep` collapses into `keep-static` with `observed: true`. Old `keep-majority` collapses into `keep-static` with `observed: false` + rationale when values are equivalent, or `keep-dynamic` when the variation is structural, or `defer-to-operator` when genuinely ambiguous.

**Verdict shapes.**

```ts
type Verdict =
  | { candidatePath: string; kind: "keep-static";
      value: unknown;            // may be normalized; null allowed
      observed: boolean;         // true iff value is byte-equal to some distinctValue
      absentFrom: string[];
      rationale?: string;        // required when observed === false
    }
  | { candidatePath: string; kind: "keep-dynamic";
      pattern?: string;          // short label: "breadcrumb" | "related-posts" | "pagination" | ...
      rationale: string;
    }
  | { candidatePath: string; kind: "demote"; rationale: string }
  | { candidatePath: string; kind: "defer-to-operator"; rationale: string };
```

**Validator (`harmonize-verdicts-validate.ts`).**

- `keep-static`:
  - `value` key present (null permitted).
  - `observed` boolean present.
  - `absentFrom` is an array and ⊆ `candidate.absentFrom`.
  - `observed === true` ⇒ `value` deep-equals one of `candidate.distinctValues`.
  - `observed === false` ⇒ non-empty `rationale`; no constraint on `value` (normalized canonical allowed).
- `keep-dynamic`:
  - Non-empty `rationale`. Optional `pattern` string.
  - No `value` key (reject if present — keeps the decision clean).
- `demote` / `defer-to-operator`: unchanged (non-empty rationale).
- Coverage, duplicate, fabrication, kind-enum checks: unchanged.

**Prompt (`harmonize-verdicts.ts`).**

- `VERDICT_GUIDE` replaces the `keep` / `keep-majority` sections with `keep-static` (explain the `observed` flag; give phone/name/address normalization examples) and `keep-dynamic` (examples: breadcrumbs, related/suggested posts, pagination, next/prev, active-nav state).
- `OUTPUT_SCHEMA` reflects the four new shapes.
- `buildReviewerPrompt` gains mis-judgment classes: a `keep-dynamic` whose values are clearly authored per-page content (should have been `demote`); a `keep-static` with `observed: false` whose normalization is unjustified or changes meaning.

**Assembler (`harmonize-assembler.ts`).**

- `keep-static` → place `value` at canonical leaf (existing `keep` behavior).
- `keep-dynamic` → place sentinel `"<dynamic>"` at canonical leaf; append to per-pagetype `chrome-dynamic.json`:
  ```json
  {
    "<candidatePath>": {
      "rationale": "...",
      "pattern": "breadcrumb",
      "values": [
        { "pageHash": "abc", "value": <observed value for that page> }
      ],
      "absentFrom": ["<pageHash>", ...]
    }
  }
  ```
  Per-page values come from `preRenameDigest.distinctValues` (one row per pageHash that saw the candidate).
- Per-page mappers: `keep-dynamic` paths produce mapper entries the same way as `keep-static` — `fold-meta` needs each page's source path even when the canonical value is a slot.
- `chrome-fields.json` (flat index): `keep-dynamic` entries get `value: "<dynamic>"`; detail lives in `chrome-dynamic.json`.

**chrome-verify (`chrome-verify.ts`).**

- When a canonical path's verdict is `keep-dynamic`, round-trip sources the per-page value from `chrome-dynamic.json` keyed by `pageHash` rather than walking `chrome.json`.
- Absent pages in a dynamic slot: page must not map any source path to that canonical (same disjointness rule, against the dynamic table).
- Sentinel `"<dynamic>"` never participates in a value-hash equality check.

**New artifact.**

```
classify-output/<pagetype>/
  chrome.json            # keep-dynamic leaves hold "<dynamic>"
  chrome-dynamic.json    # NEW — per-slot aggregate for keep-dynamic paths
  chrome-fields.json     # keep-dynamic entries have value "<dynamic>"
  fold-meta/<hash>.json  # unchanged shape; keep-dynamic paths also produce entries
```

**Sentinel choice.** `"<dynamic>"` — literal string. Not relied on for programmatic identification (`verdicts.json` is authoritative); it's a human-readable cue + render-time signal. Collision with genuine scraper content is negligible in practice; strengthen to `"<chrome:dynamic>"` later if we ever hit one.

**Retry + reviewer fan-out.** Structural flow unchanged. Validator error messages adopt the new kinds so rejection context stays actionable.

**Migration.** Existing runs re-run from `--from harmonize-verdicts` after this lands. No API surface outside the classify segment changes.

**Retired by this proposal (relative to the 3c design above).**

- `keep` as a distinct verdict → absorbed by `keep-static` with `observed: true`.
- `keep-majority` as a distinct verdict → absorbed by `keep-static` with `observed: false` + rationale, or `keep-dynamic`, or `defer-to-operator` depending on the judgment.
- The "value must be one of the observed distinct values" hard gate → replaced by an `observed` flag + rationale-when-not-observed. Still loud in `value-conflicts.json` for operators.

#### Phase 3d — `harmonize-assemble` (programmatic)

Deterministically constructs the canonical chrome tree and per-page mappers.

- Start with empty canonical. For each `keep` / `keep-majority` verdict: parse the canonical path, walk/create nested structure, place the named value at the leaf. `null` leaves are allowed.
- For each page: build `fold-meta/<hash>.json` mapper — entries for paths the page contributed that match a `keep` / `keep-majority` canonical field. Pages in a `keep` verdict's `absentFrom` list simply have no mapper entry at that path; renderer falls back to the canonical default.
- Emit `chrome-fields.json` (flat index of canonical field → value).
- Surface full conflict detail in `value-conflicts.json` — all candidates with >1 distinct value, whatever the verdict.
- **Programmatic validator** (belt-and-braces):
  - Every `keep` / `keep-majority` field resolves on the constructed canonical tree (this is the exact check that flagged the prior bug).
  - No canonical leaf has unsupported type.
  - Every page's mapper round-trips: applying mapper to canonical + page's residual body reproduces the original content at leaf-value level.
  - No candidate in the post-rename occurrence table is orphaned (every one is in exactly one verdict, and that verdict's placement in the tree is consistent).
- `maxRetries: 0`. A failure here indicates an upstream verdict bug — fail loudly with a pointer back to the verdict artifact.
- **Outputs** under `classify-output/<pagetype>/`: `chrome.json`, `chrome-fields.json`, `harmonize-meta.json`, `value-conflicts.json`, `fold-meta/<hash>.json`.

#### Operator override workflow

Because `verdicts.json` is the single source of truth that `harmonize-assemble` reads, manual overrides are clean:

1. Scan `classify-output/<pagetype>/value-conflicts.json` for `defer-to-operator` entries (loud signal).
2. Inspect values + live site, make a human call.
3. Edit `verdicts.json` — flip verdict to `keep` (with chosen value) or `demote`; add `operator_override: true`.
4. Re-run from `harmonize-assemble` (deterministic, no tokens) via `--from harmonize-assemble`.

#### Retired from the previous design

- `polyfilled` as a separate verdict. Collapses into `keep` with an `absentFrom` annotation — no behavioral difference, cleaner schema.
- Coverage / presence thresholds. No longer a routing signal.
- Single-turn `{canonical, rename_table, demoted, polyfilled, value_conflicts}` emission. Split across align-layers (rename), verdicts (judgments), and assemble (tree building).
- Single-call `harmonize-align-names` phase (no reviewer, paths-only prompt). Replaced by three layered phases with per-batch reviewers seeing values. Intermediate design that shipped briefly; never ran against a pagetype > 20 pages, so the scale problem surfaced only in review.

### Stage 4 — chrome-verify (DONE, unchanged by Stage 3 rewrite)

- Pure deterministic. `maxRetries: 0` — a failure means Stage 3 is structurally wrong.
- For every page: verify duplicates, disjointness of `entries` and `demotedSourcePaths`, sourcePath resolution on content, canonicalField resolution on canonical, and value-hash equality.
- Writes `classify-output/<pagetype>/body/<hash>.json` for **every** page (passing or failing — body is derived deterministically from `splitByChromePaths(content, mapper.entries.sourcePaths)` and is well-defined regardless of verify verdict). `verify-report.json` carries the per-page pass/fail detail.
- Invariant: `body + mapper(canonical) ≡ content` at the leaf-value level. Literal reconstruction is avoided because `splitByChromePaths` compacts arrays — value-hash equality is the sound equivalent.
- Pre-checks that Stage 3 produced `chrome.json` for each pagetype; emits a specific "Stage 3 did not produce outputs" error rather than raw ENOENT.

### Stage 5 — cross-page_type harmonize (global chrome)

- Identify chrome fields that appear identically across every page_type. Extract into `classify-output/global/chrome.json`.
- Remove those fields from each page_type's `chrome.json` (they're now inherited).

## Non-goals for this plan

- Fate classification (content / dynamic / interactive / noise). Separate later phase.
- Block-level partitioning (widget scoping, form grouping). Separate later phase.
- Wireframe / layout / design segment wiring — they'll break until chrome output is restored; out of scope until Stages 2–4 land.

## Verification workflow (applies to every stage)

1. `direnv exec . bun run check` — lint + typecheck + knip + knip --production clean.
2. `direnv exec . bun test` — full suite green.
3. Manual: `direnv exec . bun run ./src/cli.ts run --start-segment classify` on `./example/physio` — inspect expected outputs per stage.

## Notes

- 100% leaf coverage is a hard gate at every step: every kept leaf on a page must be accounted for (either in body or as a chrome entry). Missing leaves fail the gate.
- Per-page classify runs in parallel — no serial fold state, no per-step LLM reviewer. Harmonize is the only place cross-page reasoning happens.
- Per-page-type fan-out concurrency is bounded by `config.concurrency.maxQueries ?? 8`.

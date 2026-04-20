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

**Only `classify-prepare` is implemented.**

Pipeline:
```
classify (depends: [prepare])
└── classify-prepare   — materialize per-page content.json inputs
                         under classify-input/<pagetype>/<hash>/content.json
```

Downstream segments that depended on `chrome.json` / `body` / etc. will not find them until phases 2–4 land.

## Staged rollout (not yet started)

Each stage leaves the repo in a green state and is testable end-to-end against `./example/physio` before moving on.

### Stage 1 — classify-prepare (DONE)

- Output: `classify-input/<pagetype>/<hash>/content.json` per page.
- Nesting by `<pagetype>` makes it easy to eyeball which pages share a cluster without cross-referencing.

### Stage 2 — per-page chrome classify

- One LLM call per page. Parallel across pages within a page_type; also parallel across page_types (bounded by `config.concurrency.maxQueries`).
- Input: the page's content. Output: `{chromePaths: [{sourcePath, suggestedCanonical?}]}`.
- Written to `classify-input/<pagetype>/<hash>/chrome-classify.json`.
- Profile key: `classify.chrome-classify.chrome-classify-agent`.
- Tests: per-page parse + gate (every returned path must resolve on the page).

### Stage 3 — per-page-type harmonize

- One pass per page_type. Reads all `chrome-classify.json` files in that page_type cluster.
- Steps:
  1. Programmatic: union all chrome paths. For each, collect values from every page that has it.
  2. Programmatic: drop paths whose values disagree (not truly chrome — flag in `value-conflicts.json` for operator).
  3. Optional LLM rename pass: inspect similar candidate names and propose merges (only when heuristics can't decide).
  4. Emit `classify-output/<pagetype>/chrome.json` (canonical fields + values) + per-page `fold-meta/<hash>.json` (source-path → canonical-name mapping).
- Profile key: `classify.chrome-harmonize-pagetype.rename-agent` (only invoked when needed).

### Stage 4 — materialize + verify

- Programmatic. For each page of each page_type:
  - `body/<hash>.json` = content minus source paths listed in fold-meta.
  - Reconstruct = `body + chrome + fold-meta`. Assert byte-equal to original.
- Fail the phase loudly on any mismatch.

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

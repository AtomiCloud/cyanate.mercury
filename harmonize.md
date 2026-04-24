# Harmonize sub-pipeline — redesign

Companion to `CLASSIFY-PLAN.md`. Scope: the harmonize sub-pipeline inside the
classify segment. Replaces the current three-step shape
(prepare → align-layer-{1,2,3} → verdicts → assemble → verify) with a
seven-phase shape that separates identity, array-resolution, and scalar
judgment.

Status column legend: **approved** = design locked, ready to implement;
**proposed** = subject to change; will be reviewed phase-by-phase before
implementation.

| Phase | Name                          | Kind         | Status   |
|-------|-------------------------------|--------------|----------|
| 1     | harmonize-prepare             | programmatic | approved |
| 2     | harmonize-align-names         | LLM tree     | approved |
| 3     | harmonize-array-resolve       | LLM per-array| proposed |
| 4     | harmonize-scalar-verdicts     | LLM chunked  | proposed |
| 5     | harmonize-stabilize           | programmatic | proposed |
| 6     | harmonize-assemble            | programmatic | proposed |
| 7     | harmonize-verify              | LLM reviewer | proposed |

## Why redesign

Run `20260421-162736` failed at `harmonize-verdicts` on pagetype
`team_member` with 297 post-rename candidates. Root cause: 297 verdicts ≈
17 K output tokens, close to GLM-5's reliable per-turn ceiling; the model
truncated/omitted verdicts and corrupted the JSON. Downstream this manifested
as "response did not contain a JSON object with a `verdicts` array".

Secondary defect the old shape couldn't articulate: positional-array
identity. `share_buttons[3]` on one page means "Copy Link" and on another
means "Pinterest" because the scraper assigns `[N]` per page. The verdict
vocabulary had no way to say "this is chrome, but the *slots* aren't stable
— resolve by element identity, not index". The aligner couldn't rename
`share_buttons[3]` either — it's a correct leaf on both pages, just with
different meanings.

The redesign splits the judgment work by reasoning mode (identity vs.
array-resolution vs. scalar-verdict), collapses positional instability at
the candidate-grain level, and uses a hierarchical merge-tree to scale to
~8 K pages per pagetype.

## Candidate grain — `[*]` not `[N]`

The old pipeline preserved positional indices in candidate paths
(`share_buttons[3]` was its own candidate). The new pipeline collapses every
`[digit]` to `[*]` at Phase 1 boundary:

- `share_buttons[3].label` → `share_buttons[*].label`
- `header.nav[0].href` → `header.nav[*].href`

Benefits:

- Rotation, reordering, and partial presence are facts *about one candidate*
  rather than about four mutually-disagreeing candidates.
- Element identity becomes a first-class concern — Phase 3 is where we say
  "this array's members are `Twitter | Facebook | Pinterest`" regardless of
  which slot each page put them in.
- The digest is much smaller (hundreds of positional candidates collapse to
  dozens of array candidates).

## Phase 1 — harmonize-prepare  **(approved)**

### Purpose

Programmatic digest builder. No LLM, no judgment. Produces two artifacts per
pagetype:

1. `digest.json` — one `CandidateDigest` per collapsed path, with
   value-bucket `distinctValues`, `presentOn`, `absentFrom`. Same shape as
   today, but candidate keys are `[*]`-collapsed.
2. `structural-signals.json` — per-candidate metadata used by phases 2, 3,
   and 4 to calibrate their prompts without making decisions.

### Differences from current `harmonize-prepare`

- **Path collapse**: every `[N]` in a candidate path becomes `[*]`. The
  candidate key for `share_buttons[3].label` and `share_buttons[0].label`
  is the same string: `share_buttons[*].label`.
- **Per-page sequence retention**: because a single page can hit the same
  `[*]`-path multiple times (one per element), the digest preserves the
  ordered sequence of observed values per page on array candidates. (Today's
  digest stores only a flat bucketization.)
- **Structural signals sidecar**:
  - `elementShape`: `"primitive" | "object" | "mixed"` (per array candidate).
  - `perPageSequences`: `Record<pageHash, unknown[]>` — the ordered values
    observed at that `[*]`-path per page. Drives Phase 3 array-resolve.
  - `pairwiseOrderConstraints`: for primitive arrays, pairs `(a, b)` where
    `a` appeared before `b` on at least one page. Feeds topological sort
    in Phase 5 stabilize.
  - `elementSetJaccard`: mean pairwise jaccard of element sets across
    pages (scalar 0..1). Hints "rotation vs. rewrite vs. stable".
  - `childKeyUniformity`: for object-element arrays, fraction of elements
    sharing the same key set. Hints "consistent record shape vs. motley".

### Data shape

```ts
interface PageTypeDigest {
  pagetype: string;
  totalPages: number;
  pageHashes: string[];
  candidates: CandidateDigest[];
}

interface CandidateDigest {
  candidatePath: string;      // always [*]-collapsed
  distinctValues: DistinctValue[];
  presentOn: string[];        // page hashes with ≥1 occurrence
  absentFrom: string[];
}

interface StructuralSignals {
  pagetype: string;
  perCandidate: Record<string, CandidateSignals>;
}

interface CandidateSignals {
  isArray: boolean;              // path contains [*]?
  elementShape?: "primitive" | "object" | "mixed";
  perPageSequences?: Record<string, unknown[]>;
  pairwiseOrderConstraints?: Array<[unknown, unknown]>;
  elementSetJaccard?: number;
  childKeyUniformity?: number;
  childKeys?: string[];          // observed object keys
}
```

### Tests

- Two pages with `share_buttons` in different slot orders → one candidate
  `share_buttons[*].label`, distinctValues flattens values across positions,
  `perPageSequences` retains the per-page order.
- Missing page (no `share_buttons` at all) → listed in `absentFrom`.
- Nested arrays (`nav[0].items[0].href`) → all indices collapsed.

## Phase 2 — harmonize-align-names  **(approved)**

### Purpose

LLM-driven identity pass. Decides which candidate paths are *aliases* for
the same concept and emits rename ops.

### Topology — hierarchical merge tree (unchanged)

Same 20-fanout, same three layers:

```
layer 1:  20 raw per-page digests          (2^0 ·  20 =    20 pages)
layer 2:  20 layer-1 outputs               (20 ·  20 =   400 pages)
layer 3:  20 layer-2 outputs               (400 ·  20 = 8 000 pages)
```

Each layer: aligner nodes run in parallel within the layer, sequential
across layers. An aligner node consumes ≤20 inputs.

### Rename vocabulary — extended

Today: flat only — `{from, to, reason}`.

New: union of three op kinds — all validated, all compiled down to flat
renames at the output boundary so downstream (verdicts, assemble) stays
schema-compatible.

```ts
type RenameOp =
  | { kind: "flat";    from: string; to: string; reason: string }
  | { kind: "subtree"; fromPrefix: string; toPrefix: string; reason: string }
  | { kind: "element-key";
      arrayPath: string;           // e.g. "share_buttons[*]"
      identifyBy: string;          // element key used for identity, e.g. "label"
      renames: Record<string, string>;  // observed label → canonical label
      reason: string };
```

- **flat** (unchanged): `header.nav[*].href` → `header.navigation[*].href`.
- **subtree**: `footer.legal.*` → `footer.*`. One op instead of N flats.
- **element-key**: normalize in-array identities. Example: inside
  `share_buttons[*]`, map observed `label` values
  `{"Share on Twitter" → "Twitter", "Share on FB" → "Facebook"}`. Does not
  change leaf path names — changes the element identity used by Phase 3.

### Aligner internal iteration

Current: one LLM call per batch per attempt. Up to 2 retries on rejection.

New: within a batch, loop *until agent proposes no new ops* (up to N turns).
Each turn the agent sees prior renames plus any new candidates it hadn't
renamed yet. This lets a complicated batch converge without hitting the
retry cliff — retries remain, but now only for genuine defects (validation
failures), not incompleteness.

### Code structure

- `harmonize-align-layer-{1,2,3}.ts` stay as thin wrappers, but layer-1 is
  no longer special-cased vs. layer-2+. All layers share one code path.
- `harmonize-align-shared.ts` extends the per-batch loop to:
  - Accept extended rename ops in agent output.
  - Validate extended ops (new validators for subtree + element-key).
  - Compile rich ops to flat at write-time — `rename-table.json` remains
    a flat `RenameTable` so Phase 4+ consume the same shape as today.
  - Internal "propose more ops?" loop until convergence.

### Differences from current align-shared

- **Vocabulary**: extended ops in agent response, compiled to flat at output.
- **Iteration**: converge within a batch, not one-shot-then-retry.
- **L1 parity**: same pass-through rules at all layers (pass-through when
  `totalPages ≤ 1` OR `≤ 1 batch` at any layer).
- **Element-key validation**: new validator — `arrayPath` must exist as a
  `[*]`-collapsed candidate in the digest; `identifyBy` must be an observed
  key on element objects; rename keys must appear as observed values.

### Tests

- Extended ops parse and compile to expected flat renames.
- Subtree rename with collision refused by validator.
- Element-key rename on `share_buttons[*]` collapses three label variants.
- Internal iteration terminates when agent returns `{rename_ops: []}`.

## Phase 3 — harmonize-array-resolve  **(proposed)**

### Purpose

For every array candidate (`[*]` in path), classify its fate:

- `chrome-static`: shared chrome, canonical element order derivable (Phase 5
  stabilize).
- `chrome-dynamic`: structural chrome, per-page values (breadcrumbs, related
  posts).
- `authored`: editorial page content (list of blog posts on a listing page).
- `deferred`: LLM can't tell confidently; human override.

### Inputs

Per array candidate: the candidate's `distinctValues`, full
`perPageSequences` from signals, `elementSetJaccard`, `orderConstraints`,
`elementShape`, `childKeys`.

### Output

One verdict per array candidate:

```ts
type ArrayVerdict =
  | { candidatePath; kind: "chrome-static";  canonicalOrder?: unknown[];  rationale }
  | { candidatePath; kind: "chrome-dynamic"; pattern?;                     rationale }
  | { candidatePath; kind: "authored";       rationale }
  | { candidatePath; kind: "deferred";       rationale };
```

For `chrome-static`: Phase 5 (stabilize) uses `canonicalOrder` to align
per-page sequences against the canonical, inserting nulls for missing slots.

### Fan-out

One LLM call per array candidate. Chunk output if many arrays — each
candidate's verdict is self-contained so chunking is trivial.

## Phase 4 — harmonize-scalar-verdicts  **(proposed)**

### Purpose

For every scalar (non-array) candidate, emit one verdict from:
`chrome-static | chrome-dynamic | authored | deferred`.

Same vocabulary as today's verdicts phase, but:

- Renamed `demote` → `authored` for parity with Phase 3.
- Renamed `keep-static` → `chrome-static`, `keep-dynamic` → `chrome-dynamic`,
  `defer-to-operator` → `deferred`.
- Chunked by default: verdicts emitted in chunks of ≤100 candidates per LLM
  turn, so team_member's 297 scalar candidates → 3 turns, each ≤6 K output
  tokens. (Today: all-or-nothing, breaks at scale.)

### Chunking strategy

Split candidates deterministically (alphabetical by path) into N chunks of
≤100. Each chunk's LLM call sees the global pagetype summary + the chunk's
candidates. Validator assembles chunk outputs, retries per-chunk on failure.

## Phase 5 — harmonize-stabilize  **(proposed)**

### Purpose

Programmatic. Applies Phase 3 results to produce stable canonical sequences
for `chrome-static` arrays:

- If `canonicalOrder` was given: use it directly.
- If not: run a topological sort over `pairwiseOrderConstraints`; ties
  broken by frequency then by hash.
- For each page, align its observed sequence against the canonical — fill
  missing slots with a polyfill value recorded in the verdict (or `null`).

Output: per-page stabilized views of each chrome-static array.

## Phase 6 — harmonize-assemble  **(proposed)**

### Purpose

Programmatic. Combines:

- Scalar chrome-static + chrome-dynamic verdicts from Phase 4.
- Array chrome-static (stabilized) + chrome-dynamic from Phases 3 + 5.
- Rename compositions from Phase 2.

Emits:

- `canonical.json` — canonical tree (static values in place, dynamic slots
  as sentinels).
- `chrome-dynamic.json` — per-pagetype sidecar: per-slot pageHash → value
  maps.
- `page-mappers.json` — per-page `sourcePath` → canonical-field bindings +
  demoted paths.

No LLM. Any validator failure here = upstream bug.

## Phase 7 — harmonize-verify  **(proposed)**

### Purpose

LLM sanity check — does the canonical tree + per-page mapping reproduce
each page's content faithfully?

Sample ~3 pages per pagetype, walk each page's mapper, resolve each source
path on the raw content, compare against the canonical + chrome-dynamic
slot for that page. Reviewer asks:

- Any mapper entry where `sourcePath` doesn't resolve?
- Any canonical field missing a value on pages where it should be present?
- Any chrome-dynamic slot where a page's observed value disagrees with the
  sidecar?

Output: pass / reject. Reject routes back to Phase 4 (scalar) or Phase 3
(array) depending on which candidate tripped the check.

## Implementation order

1. **Phase 1** — new digest shape + signals sidecar. Breaks downstream
   (verdicts expects `[N]`-grain); that's OK — Phase 4 replaces it.
2. **Phase 2** — extended rename vocabulary, internal iteration. Emits
   flat rename table at the boundary so Phase 4+ stays compatible when we
   reach it.
3. Test phases 1-2 against an existing run's `classify-input/` tree. No
   end-to-end run yet; we're validating phases in isolation.
4. Phase 3 design refresh + implementation.
5. Phase 4 design refresh + implementation.
6. Phase 5 + 6 + 7 together (they're a pipeline tail that's meaningless in
   isolation).
7. Delete old `harmonize-verdicts`, `harmonize-assemble`, `harmonize-verify`.

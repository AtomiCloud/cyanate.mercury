---
name: tune
description: Analyze a pipeline run to diagnose failures, find root causes, classify fixes, and produce actionable recommendations. Use when asked to analyze a run, debug a pipeline failure, investigate why a segment failed, or review run artifacts.
user_invocable: true
---

# Pipeline Run Analysis

Analyze pipeline runs to diagnose failures, find root causes, and produce actionable fix recommendations.

## When to Use

User asks to analyze a run, debug a pipeline failure, investigate why a segment/phase failed, or review run artifacts.

## Pipeline Context

Five-segment DAG with two sources and two sinks:

```
prepare ────► classify
analyze  ┐
         ├─► design
wireframe┘
```

- `prepare`, `analyze`, `wireframe` have no deps.
- `classify` depends on `prepare`.
- `design` depends on `analyze` + `wireframe` (fan-in).

Each segment has serial **phases**, each phase has **steps** (agent/programmatic/reviewer). Failed phases retry up to `maxRetries` times with rejection context passed forward. Identical consecutive rejections trigger early abort.

Run artifacts:
- `runs/<run-id>/run.json` — DAG state + per-segment `outputDir` + run `identity` (input, reference)
- `runs/<run-id>/<segment>/pipeline.json` — iteration history + reviews for that segment
- `runs/<run-id>/<segment>/output/` — final segment output (what downstream deps consume)
- `runs/<run-id>/<segment>/iteration-N-<phase>/` — per-iteration workdirs. `iteration-0-init/` contains the merged inputs copied from upstream deps — the exact bytes this segment saw.
- `runs/<run-id>/metrics.jsonl` — cost/tokens/duration

Iterations are numbered globally within a segment (not per-phase). Retry counter is 0-indexed.

### Segment Breakdown

**Prepare** — Ingests and cleans scraper output. No AI.
- Phases: ingest → download-assets → resolve-routes → apply-rewrites → build-heuristics → validate-dataset
- Output: `pages.json`, `prepared-content.json`, `asset-manifest.json`, `structure-map.json`, `heuristics.json`, `page-type-meta.json`

**Analyze** — Extracts visual design from reference website.
- Phases: scout → extract-design → discover-components
- Output: `style-fingerprint.json`, `design-tokens.json`, `component-recipes.json`, `catalog.json`, `patterns/`

**Wireframe** — Transforms scraper output into a working unstyled Astro project.
- Phases: reduce → classify → seed → generate → validate
- Output: Full Astro project with content collections, routes, component scaffolds

**Classify** — AI classification of prepared content into a CMS-adapter-ready bundle.
- Phases: classify-page-types → detect-globals → detect-shared → detect-dynamics → classify-fields → normalize-values → map-render-as → compose-trees → assemble-and-verify → resolve-and-bundle
- Output: `registry.json`, `globals.json`, `shared-components.json`, `dynamics.json`, `field-classifications.json`, `render-maps.json`, `content-model.json`, `resolved-entries.json`, `roundtrip-report.json`

**Design** — Applies design tokens to the wireframe (fan-in of analyze + wireframe).
- Phases: token → layout → typography → color → motion → qa
- Output: Fully styled, deployable Astro project

## Instructions

### Step 1: Read the run state

Read these files in order:
1. `runs/<run-id>/run.json` — Which segments failed?
2. For each failed segment: `runs/<run-id>/<segment>/pipeline.json` — Which phase failed? How many retries? What was the rejection context?
3. `runs/<run-id>/metrics.jsonl` — Cost and token data for anomalies

### Step 2: Find root causes, not proximal causes

"Reviewer rejected" is never the root cause. Ask: **why did the agent produce wrong output?**

Examples of root vs. proximal:
- Proximal: "validate rejected because `design-tokens.json` had invalid structure"
- Root: "The merge step's prompt doesn't specify the Zod schema the validator expects, so the agent invents a plausible-but-wrong structure"

Common root causes:
- **Prompt gap** — The prompt doesn't tell the agent something it needs to know
- **Contract mismatch** — Phase N's output schema doesn't match Phase N+1's input assumptions
- **Missing validation** — A programmatic step should enforce a constraint but doesn't
- **Impossible task** — The prompt asks for something the model can't do with the given context
- **Context overflow** — Too much input, agent loses track of critical details
- **Ambiguous instruction** — Multiple valid interpretations, agent picks the wrong one
- **Bad upstream input** — The failing segment consumes garbage from a dependency. See Step 2b.

### Step 2b: Is this segment the cause, or is an upstream segment?

**Before proposing any fix in the failing segment, rule out the upstream dep.** A failure in `classify` may be a bug in classify, OR it may be bad `pages.json` / `prepared-content.json` from `prepare`. A failure in `design` may be a malformed Astro project from `wireframe`, OR corrupt `design-tokens.json` from `analyze`. Fixing the wrong segment wastes work and leaves the real defect in place.

**How to trace upstream via folder metadata:**

1. **Identify the failing segment's deps.** Read `src/segments/<failing-segment>/index.ts` → `depends: [...]`. If empty, there's no upstream to blame — move on.

2. **Find the dep artifacts.** Two scenarios:
   - **Same run:** If the full pipeline ran end-to-end, upstream output is at `runs/<run-id>/<dep-segment>/output/`. The `run.json` has `segments.<dep>.outputDir`.
   - **Cross-run (--dep flag):** If the failing segment was started with `--dep prepare=<path>`, trace the path. It points to a prior run's segment output dir. Navigate up one level to find that run's `run.json` for identity / status / warnings. The `run.json` field `identity: { input, reference }` confirms which scraper input was used.

3. **Inspect the handoff — iteration-0-init vs upstream output.** Every segment's first iteration workdir (`iteration-0-init/`) contains what `mergeInputs` copied from the dep output. Compare:
   - `runs/<upstream-run>/<dep-segment>/output/<file>` — what the dep produced.
   - `runs/<run-id>/<failing-segment>/iteration-0-init/<file>` — what the downstream received.
   If they disagree, the `mergeInputs` hook has a bug (wrong file list, rename, etc.). If they match but the content is wrong, the upstream segment is the culprit.

4. **Read the upstream `pipeline.json`.** Even a "completed" upstream can leave landmines:
   - Borderline passes in validation (e.g., coverage just above 85% threshold)
   - Retry loops that converged but produced degraded output
   - Phases with zero-length reviews (no validation at all)
   These don't trigger failures upstream but propagate into downstream segments.

5. **Sanity-check the specific upstream artifacts the failing phase reads.** Common handoff failure modes:
   - `prepared-content.json` has `content: {}` for some pages (ingest missed them) → classify can't classify empty pages
   - `asset-manifest.json` has paths that don't exist on disk → downstream image validation fails
   - `design-tokens.json` has null values under keys the consumer treats as required
   - `heuristics.json` has wrong page-type counts or missing fields → classify misidentifies page types

6. **Decide where the fix belongs:**
   - **Fix upstream** if the upstream output violates its own spec — that's where the bug is.
   - **Fix the contract** (schema / `mergeInputs` / `extractOutput`) if upstream and downstream disagree on shape.
   - **Fix downstream** only if the upstream output is correct and the downstream just doesn't handle it.

   Adding a defensive try/catch in the downstream to paper over bad upstream input is almost always wrong — it trades a loud failure now for a silent wrong answer later.

### Step 3: Classify — micro or macro

**Micro** = the pipeline design is sound but a specific step/prompt/schema has a bug.
Examples: wrong Zod schema, prompt missing a critical instruction, contract gap between adjacent phases, reviewer checking the wrong thing.

**Macro** = fundamental design problem requiring architectural rethinking.
Examples: phase trying to do too much in one shot, retry loop can't converge because feedback doesn't address the real problem, model not capable enough for the task as scoped.

### Step 4: Generic fixes only

Test every fix: **would this also help on a completely different reference site and scraper input?**

- DO: fix schema mismatches, clarify ambiguous prompts, add missing contracts, restructure provably-too-complex phases, improve rejection context specificity
- DON'T: add site-specific examples, hardcode structure from current test case, add special-case handling, tune retry counts based on one run

### Step 5: Analyze retries

Read the full retry sequence, not just the final blocker:

1. **First attempt**: What went wrong?
2. **Each retry**: Did the rejection context help? Same or different errors?
3. **Pattern detection**:
   - Same error repeated -> feedback not actionable, or model capability limit
   - Different error each time -> underspecified task, too many wrong answers
   - Progressive improvement -> close to convergence, might need better guidance
   - Oscillating between states -> contradictory constraints in prompt or reviewer

Distinguish **model capability issue** from **structural problem**:

Model capability (not worth fixing in code):
- Almost-correct output with minor errors a human would catch
- Retry shows understanding of feedback but imperfect execution

Structural problem (fix in code):
- Agent ignores or misinterprets the rejection context
- Error stems from missing information the agent literally doesn't have
- Reviewer feedback is vague or contradicts the original prompt

### Step 6: Explain what failed

For each failure, provide: what the step does (plain English), what went wrong (with evidence), root cause, micro/macro classification, proposed generic fix, retry pattern analysis.

### Step 7: Think beyond the checklist

Consider:
- Cost efficiency — is the pipeline spending tokens in the right places?
- Phase boundaries — are they drawn correctly, or should work shift between phases?
- Segment boundaries — should a fix belong in the upstream segment instead? (See Step 2b.)
- DAG structure — does the dependency graph itself make sense?
- Reviewer criteria — do they match what actually matters for output quality?
- Fragile passes — things that passed but look like they'd break on different input
- Upstream ripple effects — did an earlier phase (or earlier segment) produce subtly wrong output that only surfaced later? Even "completed" upstream segments can ship degraded artifacts.

Flag anything that seems off even if it didn't directly cause the failure.

### Step 8: Interrogate your own analysis

Before writing the report, stress-test your conclusions. A confident-sounding root cause is often wrong in a way that looks right.

**Blindspots — what didn't you look at?**
- Did you only read the failing segment's `pipeline.json` and skip upstream `pipeline.json`s?
- Did you read the agent events log, or only the reviewer verdict? The agent may have flagged the real issue in an earlier turn.
- Did you check `metrics.jsonl` for cost/token anomalies that hint at context overflow or repeated tool flailing?
- Did you read the *passing* phases in the failing segment? A later phase's failure may be seeded by subtle drift in an earlier "passed" phase.
- Did you look at `iteration-0-init/` to see the actual bytes the segment received, or did you assume the upstream output matched?

**Assumptions — what are you taking for granted?**
- "The schema is correct" — is it? Read it.
- "The prompt says X" — does it? Open it.
- "The reviewer checks Y" — does it? Read the reviewer's run function.
- "This segment depends on Z" — does it? Read `depends: [...]`.
- "The upstream output conforms to its spec" — did you verify, or assume because status was `completed`?
- "The fix is generic" — would it actually help on a different reference site, or did you pattern-match on the current test case?

**Unknown unknowns — what questions haven't you asked?**
- Is there a class of failure that wouldn't show up in `pipeline.json` at all? (e.g., a step that silently wrote an empty file and a downstream step didn't notice.)
- Is the failure deterministic, or did it happen to trigger this run? Would a rerun produce a different phase failing?
- Could the real defect be outside the pipeline entirely — `cui.yaml`, provider config, network, scraper input that's subtly different from the usual?
- Is there a pattern across multiple runs you haven't looked at? One run is anecdote, three runs is signal.

If stress-testing surfaces a gap, go back and fill it before producing the report. Don't paper over an assumption you can cheaply verify.

## Output Format

```
## Run <run-id> Analysis

### Summary
- Segments: [status of each]
- Duration / Cost
- Outcome: [one-line]

### Failure: <Segment> / <Phase>
**What this step does:** [plain English]
**What went wrong:** [specific, with evidence]
**Root cause:** [why the output was wrong — not "it was rejected"]
**Upstream check:** [Did the upstream dep provide valid input? If not, which file/field was wrong and where did the real defect originate? If upstream is clean, say "upstream verified — issue is in this segment."]
**Classification:** Micro | Macro
**Fix:** [generic — explain why it's not overfitted. State which segment the fix belongs in.]
**Retries:** [pattern analysis if applicable]

### Failure 2: ...

### Observations
[Anything else worth noting — cost, token waste, phase boundary issues,
architectural concerns, things that passed but look fragile, upstream ripple effects]

### Recommendations (Priority Order)
1. [Highest impact fix]
2. ...
```

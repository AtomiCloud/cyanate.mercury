---
name: tune
description: Analyze a pipeline run to diagnose failures, find root causes, classify fixes, and produce actionable recommendations. Use when asked to analyze a run, debug a pipeline failure, investigate why a segment failed, or review run artifacts.
user_invocable: true
---

# Pipeline Run Analysis

Produce root causes with `(input, actual, expected)` triples and generic fixes.

## Pipeline

Five-segment DAG:

```
prepare ────► classify
analyze  ┐
         ├─► design
wireframe┘
```

Segment phases and outputs: see `REFERENCE.md`.

Artifacts under `runs/<run-id>/`:
- `run.json` — DAG state, per-segment `outputDir`, `identity` (input, reference).
- `<seg>/pipeline.json` — iteration history + reviews.
- `<seg>/output/` — what downstream deps consume.
- `<seg>/iteration-N-<phase>/` — per-iteration workdirs. `iteration-0-init/` = merged upstream inputs.
- `metrics.jsonl` — cost/tokens/duration.

Iterations are 1-indexed globally within a segment; retries 0-indexed within a phase.

## Flow

### 1. Triage — read only `run.json`

- Primary targets = segments with `status: failed`.
- Secondary = `completed` with long duration or high retry count (borderline).
- `pending` / `skipped` from upstream failure = not targets (root cause is upstream).

### 2. Fan out — one Explore subagent per primary target, in parallel

Spawn all subagents in a single message. Even if targets form a dep chain, analyze in parallel — downstream subagents flag "upstream may be the real cause" and you reconcile in aggregation. The upstream-handoff check is done *inside* each subagent, not as a serial follow-up.

**Subagent brief template** (fill in, send to `Explore`):

```
Run: <run-id>
Segment: <segment>

Diagnose why this segment failed. Return a root-cause report.

Slice pipeline.json — don't read end-to-end:
  export RUN_ID=<run-id>
  .claude/skills/tune/slice.sh last-fail <segment>
  .claude/skills/tune/slice.sh reasons   <segment> <phase>
  .claude/skills/tune/slice.sh last-steps <segment> <phase>

Then:
1. Read the failing step's `run` in src/segments/<segment>/...
2. Diff iteration-0-init/ vs the failing iteration's workdir — what did the step actually write?
3. Read rejection contexts across ALL iterations, not just the last.
4. Upstream check (inline, not later):
   - src/segments/<segment>/index.ts → depends: [...]. Empty → skip.
   - Diff iteration-0-init/<file> vs runs/<upstream-run>/<dep>/output/<file>.
     Disagree → mergeInputs bug. Agree + bad → upstream bug.
   - Spot-check the fields the failing phase consumes.
5. Classify micro/macro. See REFERENCE.md §"Generic fixes" and §"CLI principle".

Return <200 words:
- Failing phase + step
- (input, actual, expected) triple with real file bytes
- Root cause (not "reviewer rejected")
- Retry pattern: same / different / progressive / oscillating
- Upstream verdict: clean | <dep> bug | mergeInputs bug
- Classification + generic fix (which segment + which file)
```

### 3. Aggregate

Collect subagent reports. If two subagents blame the same upstream defect, merge. Write using the output skeleton below.

### 4. Sanity pass (brief — don't re-do the analysis)

Before writing, verify:
1. Every root cause cites a file read.
2. Each triple reads back from real bytes (no paraphrase drift).
3. Each fix is generic — would it help on a different reference site + scraper input?

Then run `RUN_ID=<run-id> .claude/skills/tune/slice.sh cost` and flag anomalies in Observations.

## Output

```
## Run <run-id> Analysis

### Summary
- Segments: [status of each]
- Duration / Cost
- Outcome: [one line]

### Failure: <Segment> / <Phase>
- What this step does: [one sentence]
- Triple:
  - Input: [real bytes from workdir]
  - Actual: [verbatim]
  - Expected: [with rule cited]
- Root cause: [not "rejected"]
- Upstream: clean | <dep> bug | mergeInputs bug
- Classification: Micro | Macro
- Fix: [generic — which segment + file]
- Retries: [pattern, if >1 iteration]

### Failure 2: ...

### Observations
[One-liners: cost anomalies, fragile passes, DAG/phase-boundary concerns.]

### Recommendations (priority order)
1. [Highest-impact fix]
2. ...
```

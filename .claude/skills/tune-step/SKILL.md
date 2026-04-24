---
name: tune-step
description: Analyze a single pipeline step in isolation — diagnose why it failed or retried, and verify correctness of its output even on pass. Use when asked to debug a specific step, investigate a single phase's agent/programmatic/reviewer, or sanity-check a step's output.
user_invocable: true
---

# Single-Step Analysis

Zoom into one step. Answer: (1) did it fail/retry? why? (2) even if it passed — is the output correct?

Use `/tune` for whole-run or segment-level analysis.

Shared reference (root-cause taxonomy, retry patterns, CLI principle, triple example): `../tune/REFERENCE.md`.

## Pipeline context (condensed)

Hierarchy: `Segment > Phase > Step > Iteration`.

Step types: `agent` (Claude SDK) / `programmatic` (TS fn) / `reviewer` (AI judge). Steps in a phase share a workdir and run in declared order (or `parallel: N`). Phases retry up to `maxRetries` (default 3) with aggregated `rejectionContext` forwarded. Iterations are 1-indexed globally per segment; retries 0-indexed within a phase.

Artifacts: `runs/<run-id>/<seg>/pipeline.json` (`iterations[].steps[]` has status/duration/error/reviews), iteration workdirs, `iteration-0-init/`, `agent-events.jsonl` (name from `cui.yaml logging.eventsFile`), `metrics.jsonl`.

## Flow

### 1. Identify the target — one consolidated prompt

If the user didn't fully specify, pre-read `run.json` + segment `pipeline.json` + `src/segments/<seg>/...` to enumerate options, then ask **one** `AskUserQuestion` with up to four questions (run / segment / phase / step). Resolve `latest` → most recently modified `run.json`.

State back: `<run-id> → <seg> → <phase> → <step>` (type, iterations it ran in).

### 2. Read the StepDef

From `src/segments/<seg>/...`:
- `type`, `profileKey` (resolve via `cui.yaml` cascade for this exact `segment.phase.step`), `parallel`.
- `run` fn: for agents — prompt + files read/written; for programmatic — logic; for reviewers — what it checks.

Without this you can't judge correctness.

### 3. Validate inputs

Before blaming the step:
- **Workdir entry state** — prior iteration's final workdir (or `iteration-0-init/` for phase 1). Inspect the files this step reads.
- **Rejection context on retries** — actionable? Contradicts the prompt? Addresses the real defect?
- **Config** — `cui.yaml` values the step reads.
- **Upstream merge** — if phase 1, diff `iteration-0-init/` vs upstream `output/` for `mergeInputs` bugs.

Malformed input → step is probably not root cause. Flag origin.

### 4. Execution analysis

Per iteration:
- Read `iterations[i].steps[j]` in pipeline.json.
- **Agent** — open `agent-events.jsonl`. Prompt seen? tools called? files written? final turn? hit `maxTurns`?
- **Programmatic** — did `run` throw? write empty/degraded?
- **Reviewer** — finding substantive, or checking wrong thing?

List files created/modified (diff against prior state). If `parallel: N`, inspect all N — one fork may have failed silently.

### 5. Concrete (input, actual, expected) triple

For every failure cited, copy real bytes. No paraphrase.
- **Input** — exact prompt slice, candidate row, or upstream file line.
- **Actual** — verbatim op/line/verdict.
- **Expected** — what it should have produced, with the rule/contract cited.

A root cause that can't be expressed as a verifiable triple is almost always wrong. Example in `REFERENCE.md`.

### 6. Retry pattern (if >1 iteration)

Same / different / progressive / oscillating. Was rejection context actionable? Distinguish model capability (minor slips) from structural (missing info, contradictions).

### 7. Output correctness — even on pass

- **Schema** — Zod in `phases.io.ts` or similar.
- **Spec conformance** — matches next-segment `mergeInputs` and consuming phase's input assumptions.
- **Semantic sanity** — walk outputs. E.g. `pages.json` content non-empty; `design-tokens.json` no nulls where values expected; recipes reference real components; reviewers actually exercised the claim.
- **Borderline** — coverage just above threshold, zero-length reviews, retry converged degraded.

Schema pass + semantically wrong = silent defect. Surface explicitly.

### 8. Classify + fix

- **Micro** = specific defect (wrong Zod schema, missing prompt constraint, reviewer checks wrong thing, programmatic off-by-one).
- **Macro** = scope/design wrong (step does too much, wrong phase, shouldn't exist).

Generic fixes only: would this help on a different reference site + scraper input?

**Agent failed a programmatic check? Add a CLI, don't patch the prompt.** See `REFERENCE.md §CLI principle`.

### 9. Stop at step boundary

Downstream concerns → one line in Observations. Don't chase — that's `/tune`.

### 10. Stress-test before writing

If any answer is "no", go read the file:
- Agent events log actually read (not just final pipeline.json status)?
- Workdir diffed (not inferred from StepDef)?
- Reviewer step → did you read the *implementer's* output it judged?
- `parallel: N` → all N inspected?
- Rejection context across *all* retries?
- `cui.yaml` profile cascade resolved for this exact `segment.phase.step`?

## Output

```
## Step Analysis: <segment> / <phase> / <step>

**Target:** <run-id> → <seg>/<phase>/<step>
**Type:** agent | programmatic | reviewer
**Profile:** <provider>/<model>  (agent/reviewer only)
**Iterations this step ran in:** N
**Final status:** passed | rejected | failed

### What this step does
[One paragraph, from StepDef. No guesses.]

### Input validation
[Valid, or which file/field was bad and origin.]

### Execution analysis
[Per iteration: what it did, what it wrote, why pass/reject/fail. Evidence from agent logs / pipeline.json.]

### Concrete triple  (if any failure)
- **Input:**
- **Actual:**
- **Expected:**

### Retry pattern  (if >1 iteration)

### Output correctness  (always, even on pass)
- Schema: pass/fail + evidence
- Spec conformance:
- Semantic sanity:
- Borderline flags:

### Root cause
[Not "rejected". If step is clean, say so and point upstream.]

### Classification
Micro | Macro

### Fix
[Generic. Which file/step/prompt.]

### Observations
[One-line downstream concerns OK. Don't chase.]
```

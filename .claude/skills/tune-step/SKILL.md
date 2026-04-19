---
name: tune-step
description: Analyze a single pipeline step in isolation — diagnose why it failed or retried, and verify correctness of its output even on pass. Use when asked to debug a specific step, investigate a single phase's agent/programmatic/reviewer, or sanity-check a step's output.
user_invocable: true
---

# Single-Step Analysis

Zoom into one step within one phase within one segment. Ignore downstream consequences. Answer two questions:

1. **Did the step fail or retry? Why?**
2. **Even if it passed — is the output correct? Why or why not?**

## When to Use

User asks to debug a specific step, investigate why a single step rejected/retried, or sanity-check a step's output even though it passed. Use `/tune` instead when the scope is a whole run or segment failure.

## Pipeline Context (condensed)

Hierarchy: `Segment > Phase > Step > Iteration`.

- **Step types**: `agent` (Claude SDK), `programmatic` (TS function), `reviewer` (AI judge).
- Steps within a phase run in declared order (or in parallel if `parallel: N`) and **share a workdir**. An agent step's output is whatever files it wrote into that workdir.
- Reviewers run last within a phase; they don't write outputs, they emit `Review[]` with `verdict: pass | reject` and a `rejectionContext` string.
- A phase retries up to `maxRetries` (default 3) when any step rejects. Each retry creates a new iteration workdir seeded from the phase's entry state, with the previous iteration's aggregated `rejectionContext` passed forward.
- Iterations are numbered globally per segment (not per-phase), 1-based. Retry counter is 0-indexed within the phase.

Run artifacts relevant to a single step:

- `runs/<run-id>/<segment>/pipeline.json` — `iterations[]` → `steps[]` has per-step `status`, `duration`, `error`, `reviews`.
- `runs/<run-id>/<segment>/iteration-N-<phase>/` — the workdir after that iteration's phase ran. Contains files the step read and wrote.
- `runs/<run-id>/<segment>/iteration-0-init/` — inputs merged from upstream deps (the starting state of the segment).
- Agent event logs: files named per `cui.yaml` `logging.eventsFile` (default `agent-events.jsonl`) in the iteration workdir. Contains the agent's turns, tool calls, prompts.
- `runs/<run-id>/metrics.jsonl` — cost/tokens per step.

## Instructions

### Step 1: Identify the target step

Prompt the user progressively. Don't guess.

1. **Run ID.** If user didn't provide, ask. Accept `latest` → resolve to the most recently modified `runs/<run-id>/run.json`.
2. **Segment.** Read the run's `run.json`. If user didn't specify, list the segments with their statuses and ask which one.
3. **Phase.** Read the segment's `pipeline.json` and `src/segments/<segment>/index.ts` to enumerate phases. List phases with pass/reject/fail status across iterations and ask.
4. **Step.** Read the phase's `steps: StepDef[]` in code. List them with type (`agent` / `programmatic` / `reviewer`) and per-iteration status. Ask which one.

Once the step is identified, state back the exact target: `<run-id> → <segment> → <phase> → <step>` with step type and how many iterations it ran in.

### Step 2: Read the step's definition

Find the `StepDef` in `src/segments/<segment>/...` (usually `<phase>.ts` or similar). Capture:

- `type` — agent / programmatic / reviewer
- `profileKey` — which LLM profile was used (resolve via `cui.yaml` cascade if agent/reviewer)
- `parallel` — was it fanned out?
- The `run` function — what does it actually do? For agents: what's the prompt? What files does it read/write? For programmatic: what's the logic? For reviewers: what does it check?

Without this, you can't judge whether the output is correct — you don't know what "correct" means for this step.

### Step 3: Validate the step's inputs

**Before blaming the step, verify it received valid input.** A step's input surface is:

- **Workdir state at phase entry** — copy from the prior iteration's final workdir (or `iteration-0-init/` for the first phase). Inspect the specific files this step reads.
- **Rejection context** — for retries, the aggregated feedback from the previous iteration. Is it actionable? Does it contradict the original prompt? Does it address the actual defect?
- **Config** — `cui.yaml` values the step reads (e.g., `classify.localSonicJsUrl`).
- **Upstream segment output** — if this is the first phase, check `iteration-0-init/` vs the upstream segment's `output/` dir to detect `mergeInputs` bugs.

If the input was already malformed, the step is probably not the root cause — flag it and point to the upstream origin.

### Step 4: Analyze the step's execution

For each iteration this step ran in:

1. Read the step's entry in `pipeline.json` → `iterations[i].steps[j]`.
2. For agent steps: open the agent events log (`agent-events.jsonl` or configured name) in that iteration's workdir. Look at the prompt the agent saw, the tools it called, the files it wrote, the final assistant turn. Did it follow instructions? Did it get lost? Did it hit `maxTurns`?
3. For programmatic steps: read the `run` function. Did it throw? Did it silently write an empty/degraded output?
4. For reviewer steps: read the reviewer's findings. Is the rejection substantive, or is the reviewer checking the wrong thing?

Record what the step *actually* wrote — list the files created/modified in the workdir during this step (diff against prior iteration's final state).

### Step 5: Analyze failures and retries

If the step rejected or failed across iterations:

1. **First attempt**: what went wrong? Root cause, not proximal ("reviewer rejected" is never the root).
2. **Each retry**: did the `rejectionContext` help? Same or different error?
3. **Pattern**:
   - Same error repeated → feedback not actionable, or model capability limit
   - Different error each time → underspecified task, too many wrong answers
   - Progressive improvement → close to convergence, needs sharper guidance
   - Oscillating → contradictory constraints in prompt or reviewer

Distinguish **model capability** (almost-correct, minor slips) from **structural problem** (missing info, vague feedback, contradictory prompt).

Common root causes at the step level:

- **Prompt gap** — agent isn't told a required constraint or schema
- **Context overflow** — too much input, agent drops details
- **Wrong tool exposure** — agent doesn't have the tool it needs, or has a tempting wrong one
- **Reviewer checks wrong thing** — rejects valid output, or passes invalid output
- **Schema mismatch** — step's output shape ≠ what downstream consumers or validators expect
- **Bad rejection context** — vague, contradictory, or pointing at the wrong defect

### Step 6: Validate outputs even on pass

**Even if the step passed, verify the output is actually correct.** Passes can be degraded:

- **Schema conformance** — if there's a Zod schema for the output, does the produced file match? (Check `src/segments/<segment>/phases.io.ts` or similar.)
- **Spec conformance** — does the output match what the segment's contract promises downstream? (Read `mergeInputs` of the *next* segment, or the consuming phase's input assumptions.)
- **Semantic plausibility** — walk the output. Examples:
  - `pages.json` — every page has non-empty `content`?
  - `design-tokens.json` — no null values where the consumer expects values? Plausible color/typography ranges?
  - `heuristics.json` — page-type counts match the scraper input?
  - `component-recipes.json` — recipes reference components that exist?
  - Reviewer verdicts — did reviewers actually exercise the claim they pass on, or is it a rubber-stamp?
- **Borderline passes** — coverage just above threshold, zero-length reviews, retry that converged but to a worse state than iteration 1.

If the output passes schema but looks wrong semantically, that's a silent defect — surface it explicitly. These are the failures that ripple downstream.

### Step 7: Classify and propose a fix

**Micro** = this step has a specific defect. Examples: wrong Zod schema, prompt missing a constraint, reviewer checking the wrong thing, programmatic step has an off-by-one.

**Macro** = the step's scope or design is the problem. Examples: step asked to do too much in one agent turn, step should be split, phase ordering is wrong, this step shouldn't exist.

**Generic fixes only.** Test each fix: *would this also help on a different reference site and scraper input?* No hardcoded examples, no site-specific patches, no retry-count tuning based on one run.

### Step 8: Stop at the step boundary

You are not tuning the whole pipeline. Don't speculate about later steps, phases, or segments. If you spot something suspicious downstream, mention it in one line under Observations and stop — that's `/tune`'s job.

### Step 9: Interrogate your own analysis

Before writing the report, stress-test your conclusions. A step-level analysis is particularly vulnerable to confident-but-wrong answers because the scope is narrow — it's easy to explain what you *can* see and miss what you can't.

**Blindspots — what didn't you look at?**
- Did you read the agent events log, or only the final status in `pipeline.json`? The agent's turn-by-turn trace often shows the real point of confusion.
- Did you diff the workdir before and after the step, or assume based on the step's description? A step may have written less (or more) than you think.
- If the step is a reviewer, did you read the *implementer's* output the reviewer was judging? The reviewer may be rejecting for reasons the findings don't capture.
- If the step has `parallel: N`, did you inspect all N instances, or just one? One fork may have failed silently while others passed.
- Did you check the rejection context across all retries, or just the final one?

**Assumptions — what are you taking for granted?**
- "The prompt says X" — open it and read it. Don't paraphrase from memory of the StepDef.
- "The step reads file F" — grep the `run` function to confirm, don't assume from the phase's typical pattern.
- "The schema is Z" — read the Zod definition in `phases.io.ts` or equivalent. Schemas drift.
- "The input is valid" — open `iteration-0-init/` or the prior iteration's workdir and verify. Status=`completed` upstream doesn't mean the artifact is clean.
- "The profile is the default" — resolve the `cui.yaml` cascade for this specific `segment.phase.step` key. Overrides are easy to miss.
- "The output is correct because the step passed" — passes can be degraded (see Step 6). Verify, don't infer.

**Unknown unknowns — what questions haven't you asked?**
- Could the step have silently written an empty or partial file that downstream won't notice until much later?
- Is this step actually the right place for this work, or is it papering over a defect that belongs elsewhere (upstream step, schema, reviewer)?
- Did the step hit a tool limit, turn limit, or timeout without it surfacing as `fail`? Check duration and turn count against typical baselines.
- Is there a class of input this step has never been tested on that might expose the same defect? (Relevant when proposing a generic fix.)
- If this step is a reviewer, is it possible it's rubber-stamping — i.e., it technically ran but didn't exercise the claim it's passing on?

If stress-testing surfaces a gap, go back and fill it. For a single-step analysis the cost of one extra file read is tiny; the cost of a wrong root cause is a real fix applied to the wrong place.

## Output Format

```
## Step Analysis: <segment> / <phase> / <step>

**Target:** `<run-id>` → <segment> / <phase> / <step>
**Type:** agent | programmatic | reviewer
**Profile:** <provider>/<model>  (agent/reviewer only)
**Iterations this step ran in:** N
**Final status:** passed | rejected | failed

### What this step does
[Plain English. One paragraph. Based on the StepDef, not guesses.]

### Input validation
[Were the inputs (workdir state, rejection context, config) valid? If not, which file/field was malformed and where did it originate? If clean, say "inputs verified."]

### Execution analysis
[Per iteration: what the step actually did, what it wrote, why it passed/rejected/failed. Include specific evidence from agent logs / pipeline.json.]

### Retry pattern  (if >1 iteration)
[Same error / different error / progressive / oscillating. Was rejection context actionable?]

### Output correctness  (always, even on pass)
- Schema: [pass/fail with evidence]
- Spec conformance: [pass/fail with evidence]
- Semantic sanity: [specific checks performed and results]
- Borderline flags: [anything that technically passed but looks degraded]

### Root cause
[Why the output was wrong — not "it was rejected". If the step is clean, say so and point upstream.]

### Classification
Micro | Macro

### Fix
[Generic fix. Explain why it's not overfitted. State exactly which file/step/prompt to change.]

### Observations
[Anything else worth noting at the step level. One-line downstream concerns OK but don't chase them.]
```

# TUNE.md — Run Analysis Protocol

When asked to analyze a pipeline run, follow this protocol. Use it as a framework, not a cage — if you notice something interesting outside these steps, follow that thread too.

## Pipeline Context

Three-segment fan-in DAG: `analyze` and `wireframe` run in parallel, then `design` consumes both outputs. Each segment has serial **phases**, each phase has **steps** (agent/programmatic/reviewer). Failed phases retry up to `maxRetries` times with rejection context passed forward. Identical consecutive rejections trigger early abort.

Run artifacts: `runs/<run-id>/run.json` (DAG state), `<segment>/pipeline.json` (iteration history + reviews), `metrics.jsonl` (cost/tokens/duration), `iteration-N-<phase>/` (workdirs).

Iterations are numbered globally within a segment (not per-phase). Retry counter is 0-indexed.

### Segment Breakdown

**Analyze** — Extracts visual design from reference website into canonical JSON artifacts.
- Phases: identify → extract → merge → validate
- Output: `style-fingerprint.json`, `design-tokens.json`, `component-recipes.json`, `catalog.json`, `patterns/`

**Wireframe** — Transforms scraper output into a working unstyled Astro project.
- Phases: reduce → classify → seed → generate → validate
- Output: Full Astro project with content collections, routes, component scaffolds

**Design** — Applies design tokens to the wireframe (fan-in of analyze + wireframe).
- Phases: token → layout → typography → color → motion → qa
- Output: Fully styled, deployable Astro project

---

## Analysis Steps

### 1. Read the run state

Read these files in order:
1. `runs/<run-id>/run.json` — Which segments failed?
2. For each failed segment: `runs/<run-id>/<segment>/pipeline.json` — Which phase failed? How many retries? What was the rejection context?
3. `runs/<run-id>/metrics.jsonl` — Cost and token data for anomalies

### 2. Find root causes, not proximal causes

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

### 3. Classify: micro or macro

**Micro** = the pipeline design is sound but a specific step/prompt/schema has a bug.
Examples: wrong Zod schema, prompt missing a critical instruction, contract gap between adjacent phases, reviewer checking the wrong thing.

**Macro** = fundamental design problem requiring architectural rethinking.
Examples: phase trying to do too much in one shot, retry loop can't converge because feedback doesn't address the real problem, model not capable enough for the task as scoped.

### 4. Generic fixes only

Test every fix: **would this also help on a completely different reference site and scraper input?**

- DO: fix schema mismatches, clarify ambiguous prompts, add missing contracts, restructure provably-too-complex phases, improve rejection context specificity
- DON'T: add site-specific examples, hardcode structure from current test case, add special-case handling, tune retry counts based on one run

### 5. Analyze retries

Don't just check the final blocker. Read the full retry sequence:

1. **First attempt**: What went wrong?
2. **Each retry**: Did the rejection context help? Same or different errors?
3. **Pattern detection**:
   - Same error repeated → feedback not actionable, or model capability limit
   - Different error each time → underspecified task, too many wrong answers
   - Progressive improvement → close to convergence, might need better guidance
   - Oscillating between states → contradictory constraints in prompt or reviewer

Distinguish **model capability issue** from **structural problem**:

Model capability (not worth fixing in code):
- Almost-correct output with minor errors a human would catch
- Retry shows understanding of feedback but imperfect execution

Structural problem (fix in code):
- Agent ignores or misinterprets the rejection context
- Error stems from missing information the agent literally doesn't have
- Reviewer feedback is vague or contradicts the original prompt

### 6. Explain what failed

For each failure, provide: what the step does (plain English), what went wrong (with evidence), root cause, micro/macro classification, proposed generic fix, retry pattern analysis.

### 7. Think beyond the checklist

This protocol covers the common patterns, but don't stop here. Consider:
- Cost efficiency — is the pipeline spending tokens in the right places?
- Phase boundaries — are they drawn correctly, or should work shift between phases?
- DAG structure — does the dependency graph itself make sense?
- Reviewer criteria — do they match what actually matters for output quality?
- Fragile passes — things that passed but look like they'd break on different input
- Upstream ripple effects — did an earlier phase produce subtly wrong output that only surfaced later?

Flag anything that seems off even if it didn't directly cause the failure.

---

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
**Classification:** Micro | Macro
**Fix:** [generic — explain why it's not overfitted]
**Retries:** [pattern analysis if applicable]

### Failure 2: ...

### Observations
[Anything else worth noting — cost, token waste, phase boundary issues,
architectural concerns, things that passed but look fragile, upstream ripple effects]

### Recommendations (Priority Order)
1. [Highest impact fix]
2. ...
```

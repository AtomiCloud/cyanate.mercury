# Pipeline Tuning Goal

**Tune the web-generator pipeline to run end-to-end autonomously.**

## Loop

Reprint this section before every iteration. Then:

1. **Run** `bun run llm-watch` (optionally `--from runs/X/step-N-id` to resume)
2. **Read** the single-line output: `succeeded`, `crashed`, `failed: {step}`, or `failed-retry: {step}`
3. **If succeeded → stop.** Otherwise, spawn an Opus **diagnose** agent:
   - Pass: the failure line, the run ID, and the project root
   - It inspects `runs/{latest}/{step-dir}/status.json`, `evidence/*.json`, `reviews/`
   - It classifies the failure and identifies which file(s) + what to change
   - It returns a concise fix plan: file path, what's wrong, what to change
4. **Spawn an Opus **implement** agent with the fix plan from step 3
   - It reads the target file(s), applies the fix, and verifies TypeScript compiles
5. **Go to step 1.**

## Diagnosis Agent Instructions

```
You are diagnosing a pipeline failure. Read these artifacts in order:

1. runs/{run-id}/{step-dir}/status.json — error summary
2. runs/{run-id}/{step-dir}/evidence/contract-checks.json — build/boundary/regression
3. runs/{run-id}/{step-dir}/evidence/runtime-checks.json — browser checks
4. runs/{run-id}/{step-dir}/reviews/attempt-{N}/*.json — reviewer verdicts

Classify the failure as one of:
- build-error: TypeScript/build failure in generated code or glue
- boundary-violation: phase produced CSS/HTML outside its ownership
- regression: a metric that passed in a previous phase now fails
- reviewer-rejection: AI reviewers rejected the output
- agent-crash: implementer agent timed out or threw an exception

Then identify the generic fix needed. Available levers:
- Pipeline design (split/merge/add/remove phases)
- Programmatic checks (contract, runtime, boundary in src/lib/)
- Glue code (orchestration, data transforms, handoffs in src/steps/ and src/pipeline/)
- Implementer prompts (the prompt strings in each step file)
- Reviewer prompts (src/lib/reviewer.ts, src/lib/reviewer-matrix.ts)

Return a fix plan:
- failure_class: (one of the above)
- root_cause: (one sentence)
- files_to_change: (list of paths)
- fix_description: (what to change in each file, generic — not overfitted to this example)
```

## Implement Agent Instructions

```
You are implementing a fix for the web-generator pipeline.

Apply the fix plan exactly as described. Rules:
- Generic fixes only — must improve the pipeline for arbitrary inputs
- Read each file before editing
- After editing, run `npx tsc --noEmit` from the project root to verify compilation
- Do NOT touch template/ or cui.json
- Do NOT modify run artifacts in runs/

The pipeline source is at src/:
- src/pipeline/runner.ts — orchestration
- src/steps/*.ts — phase implementers (each has a prompt + post-processing)
- src/lib/agent.ts — AI agent wrapper
- src/lib/phase-boundary.ts — CSS/HTML ownership rules
- src/lib/checks.ts — contract + runtime check orchestration
- src/lib/snapshot.ts — regression detection
- src/lib/invariants.ts — static invariant checks
- src/lib/reviewer.ts — AI reviewer runner
- src/lib/reviewer-matrix.ts — which reviewers run for each phase
- src/lib/validate-boundary.ts — Zod schemas for handoff data
- src/lib/semantics.ts — semantic validation
- src/lib/playwright-sampler.ts — browser-based sampling
- src/lib/seed-helpers.ts — deterministic seed utilities
```

## Rules

- Every fix must improve the pipeline for arbitrary inputs
- Resume from the last working step to save time/tokens
- Do NOT touch `template/` or `cui.json`
- Do NOT modify run artifacts in `runs/`
- Phase ownership table is in `CLAUDE.md`

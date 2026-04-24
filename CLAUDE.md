# Mecury -- AI Website regeneration engine

Regenerates a complete website from scraped content using a reference site's design.

 Produces CMS-ready Astro.js sites with the original content but the reference site's visual design.

## Project Goal

 Given:
- **Scraper output** (`example/`): `structure.json`, `schema.json`, `content.json` from an existing website
  
- **Reference URL**: a target website whose design to replicate (e.g., `https://vercel.com/`)
  
- **Output**: Complete Astro.js project deployed to Vercel

 The example is representative of the generic input format -- any website with any number of pages, page types, and content structure can be fed in.

 The pipeline must handle arbitrary scraper output + any reference URL.

 See `PIPELINE-V2.md` in the archived code for the full pipeline specification.

 A reference doc: [PIPELINE-V2.md](../../web-generator-sdk-archived/PIPELINE-V2.md).
 archived code (`web-generator-sdk-archived/`) contains the full v2 pipeline spec. The reference doc: [PIPELINE-V2.md] describes the 7-phase layered approach, phase independence, and the implementer+review pattern.

 Reference doc: [PIPELINE-V2.md] provides the best understanding.

 the 7-phase approach.

 phase independence, and the implementer+review pattern. **Important:** The reference doc has PIPELINE-V2.md`, in the archived code. It provides the full context for the rebuild. The not the CLAUDE.md or also needed to understand the project structure, files organization, and pipeline tuning instructions, **important:** Study the reference doc at `web-generator-sdk-archived/PIPELINE-V2.md`.

 It's dense but thorough.

## Ubiquitous Language

See [UL.md](./UL.md) for the project vocabulary (scope, fate, structural role, partition mechanics, transformation terms, review terms). Use those terms exactly — if a concept isn't defined there, agree on a definition and add it before using it in conversation or code.

- **Phase-specific reviewers** (× 2 models) M1 + M2)
- **Generic reviewers** (× 2 models)
- **Per-page reviewers** (one per page per check type)
- **Visual regression checks** (screenshots comparison between phases

- **Runtime validation** (build checks, Playwright browser automation)

- **Quality scoring** (7 dimensions, layout, design, motion, polish)

## The 7 Phases

| Phase | Purpose | Key Files |
|-------|---------|----------------|
| 0 | Analyze | `style-fingerprint.json`, `design-tokens.json`, `component-recipes.json` | `src/steps/analyze.ts`, `scratch/` directory |
 Extracted into 3 analysis JSONs |
| 1a: Reduce | Deterministic reduction | `reduced/` directory ( group content by type, samples pages types) | `src/steps/reeduce.ts` |
| 1b: classify | AI-based classification | `reduced/registry.json` | `src/steps/classify.ts` |
| 1c: seed | Deterministic seeding into Astro content collections | `src/content/`, `src/data/`, Astro project scaffold |
| 2 | Layout | Grid/flex, spacing, responsive (gray-box wireframes) | `src/steps/layout.ts` | `projects/` — `.astro` files with layout classes |
| 3 | Design | Typography, component styling, surfaces (neutral palette) | `src/steps/design.ts` | `.astro` + `.css` + components |
| 4 | Color | Color system, WCAG contrast, dark mode | `globals.css` only |
| 5 | Motion | Transitions, hover/focus states, scroll reveals | components + `globals.css` |
| 6 | Polish | Validation, quality scoring, fidelity check | `quality-scores.json`, `test-report.json` |

### Key Architectural Abdecisions

|----------|
| Phase boundary file | Phase N touches |
| 0 | Analyze → `scratch/` ( created, carried through unchanged |
| 1a: Structure | `structure.json` + `schema.json` + `content.json` → `reduced/` → project scaffold | `projects/` | Carried through unchanged |
| 2: Layout | `projects/` — layout classes added to `.astro` + `globals.css` spacing vars |
| 3: Design | `projects/` — typography, component styling added to `globals.css` typography/surfaces vars |
| 4: Color | `projects/` -- color vars added to `globals.css` (`:root` + `.dark`) |
| 5: Motion | `projects/` — transition/animation vars added to components + `globals.css` |
| 6: Polish | `projects/` — read-only: adds `quality-scores.json` + `test-report.json` |

## Phase Independence (Why It Matters)

 Each phase only touches properties it owns. Later phases physically cannot regress. earlier work:
- Phase 4 only modifies `globals.css` color variables
 layout and design are safe
- Phase 5 only modifies transitions/animations, no visual regressions
- Phase 6 is read-only, reports only issues

## Architecture

```
src/
  steps/          -- One file per pipeline phase (step interface + prompt + post-processing)
  pipeline/       -- Runner orchestration ( implementer+review loop
  lib/            -- Shared utilities:
    agent.ts            -- Claude Agent SDK wrapper with token tracking
    checks.ts          -- Contract + runtime check orchestration
    playwright-sampler.ts -- Browser-based page sampling
    reviewer.ts        -- AI reviewer runner + Semaphore
    reviewer-matrix.ts -- Which reviewers run for each phase
    phase-boundary.ts  -- CSS/HTML ownership rules
    snapshot.ts        -- Regression detection
    invariants.ts      -- Static invariant checks (links, headings)
    semantics.ts       -- Semantic validation
    validate-boundary.ts -- Zod schemas for handoff data
    seed-helpers.ts    -- Deterministic seed utilities
    logger.ts          -- TUI dashboard and verbose logging
    types.ts            -- All shared type definitions
template/
  astro-project/      -- Base Astro template (React, Tailwind v4, Shadcn, Biome)
cui.json          -- Config: input path, reference URL, env profile
```

## Lessons from v1 (Archived)

The archived implementation (`web-generator-sdk-archived/`) went through extensive iteration. Key findings:

1. **Layout phase is the hardest** -- divide-and-conquer sub-agents with internal review gates improve convergence
2. **Asset path hallucination** -- AI invents image paths that don't exist. An asset manifest prevents this
3. **Runtime gates need to strict** -- filtered check silently pass through errors that propagate
4. **Rejection context must be specific** -- "some images broken" doesn't help. Name exact file + exact issue
5. **Phase independence is the core value** -- breaking ownership boundaries causes cascading regressions

## Design principle — programmatic checks become agent-facing CLIs

Whenever a step has a programmatic check (validator, schema, coverage assertion, lint, shape invariant), expose it as a **CLI** the agent invokes during its turn, not only as a post-agent gate the outer runner applies.

The pattern is fix-before-submit, not propose-then-reject:

1. Pipeline seeds the agent's workdir with the inputs (`digest.json`, `ops.json` = `[]`, etc.) and a `validate` shell wrapper.
2. Agent writes its proposal to the output file.
3. Agent runs `./validate` (Bash tool). The CLI prints `{valid, errors}` and exits 0/1.
4. Agent edits the output file until validate passes.
5. Runner reads the final file; re-runs the same checks as a safety net.

Why: rejecting after the agent returns burns a full attempt on a 1-line mistake and loses the agent's intent. In-turn tool use lets the agent self-correct with specific error messages, preserves intent, and collapses the outer retry budget to genuine failures. The CLI is also runnable by humans for debugging.

When adding a new step that has programmatic rules:

- Put the rules in a pure function in `lib/`.
- Add a CLI entry at `src/segments/<seg>/cli/<name>.ts` that wraps it, reading inputs from argv and writing `{valid, errors}` JSON to stdout.
- Register the CLI as a knip entry in `knip.json`.
- Seed the agent's iter workdir with inputs + `validate` wrapper (`chmod +x`); set `cwd: iterDir` and `tools: ["Read", "Write", "Edit", "Bash"]`.
- Keep the prompt short — the CLI is the authority for rules, not the prompt.
- Keep a same-logic safety-net in the runner after the agent exits.

See `src/segments/classify/cli/validate-align-ops.ts` + `harmonize-align-shared.ts` `runConvergeIter` for the reference implementation.

## Parallelization — subagents and teams first

Before starting any non-trivial task (multi-file changes, research + implementation, orthogonal features), **split the work into independent subagents or a team**. This is the default, not a last resort.

- **Independent research or file reads**: spawn multiple `Agent` calls in parallel (subagent_type `Explore` or `general-purpose`).
- **Multi-file edits that don't overlap**: spawn one `Agent` per file or per logical group. Run them all in one message.
- **Complex multi-step workflows with coordination**: use `TeamCreate` + `TaskCreate` to break the work into tasks, spawn teammates via `Agent` with `team_name`, and assign tasks with `TaskUpdate`.
- **Rule of thumb**: if a task touches 3+ files or has 2+ independent phases, parallelize. The overhead of spawning agents is negligible compared to the speedup from concurrent execution.

Always prefer parallel over sequential when there are no data dependencies between the subtasks.

## Development

```bash
direnv allow    # loads nix dev shell (first time only)
```

**Before declaring any task complete, always run `bun run check` and fix all issues (lint, typecheck, knip).**

```bash
direnv exec . bun run check    # lint + typecheck + knip — must pass clean
```


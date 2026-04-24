# Tune reference

Supporting detail for `/tune` and `/tune-step`. Open only when needed.

## Segment breakdown

**Prepare** — ingests and cleans scraper output. No AI.
- Phases: `ingest → download-assets → resolve-routes → apply-rewrites → build-heuristics → validate-dataset`
- Output: `pages.json`, `prepared-content.json`, `asset-manifest.json`, `structure-map.json`, `heuristics.json`, `page-type-meta.json`

**Analyze** — extracts visual design from reference website.
- Phases: `scout → extract-design → discover-components`
- Output: `style-fingerprint.json`, `design-tokens.json`, `component-recipes.json`, `catalog.json`, `patterns/`

**Wireframe** — transforms scraper output into a working unstyled Astro project.
- Phases: `reduce → classify → seed → generate → validate`
- Output: Astro project with content collections, routes, component scaffolds.

**Classify** — AI classification of prepared content into a CMS-adapter-ready bundle.
- Phases: `classify-page-types → detect-globals → detect-shared → detect-dynamics → classify-fields → normalize-values → map-render-as → compose-trees → assemble-and-verify → resolve-and-bundle`
- Output: `registry.json`, `globals.json`, `shared-components.json`, `dynamics.json`, `field-classifications.json`, `render-maps.json`, `content-model.json`, `resolved-entries.json`, `roundtrip-report.json`

**Design** — applies tokens to the wireframe (fan-in of analyze + wireframe).
- Phases: `token → layout → typography → color → motion → qa`
- Output: fully styled, deployable Astro project.

## Common root causes

- **Prompt gap** — prompt doesn't tell the agent something it needs to know.
- **Contract mismatch** — phase N output schema ≠ phase N+1 input assumption.
- **Missing validation** — programmatic step should enforce a constraint but doesn't.
- **Impossible task** — prompt asks for something the model can't do with the given context.
- **Context overflow** — too much input, agent drops details.
- **Ambiguous instruction** — multiple valid readings, agent picks wrong one.
- **Wrong tool exposure** — agent lacks a needed tool, or has a tempting wrong one.
- **Reviewer checks wrong thing** — rejects valid output, or passes invalid output.
- **Schema drift** — output shape ≠ downstream validator expectation.
- **Bad rejection context** — vague, contradictory, or pointing at wrong defect.
- **Bad upstream** — fix upstream, not downstream.

## Retry patterns

- **Same error repeated** → feedback not actionable, or model capability limit.
- **Different error each time** → underspecified task.
- **Progressive improvement** → close to convergence, needs sharper guidance.
- **Oscillating** → contradictory constraints in prompt or reviewer.

## Generic fixes

Test: would this help on a different reference site + scraper input?

- DO: fix schema mismatches, clarify ambiguous prompts, add missing contracts, split provably-too-complex phases, improve rejection-context specificity.
- DON'T: site-specific examples, hardcoded structure from current test case, special-case handling, retry-count tuning based on one run.

## CLI principle — programmatic checks become agent-facing CLIs

When the defect is programmatically decidable (from not in candidate set, schema violation, coverage error, shape mismatch, unresolved reference, bad prefix), expose the check as a CLI the agent runs during its turn — don't add another rule to the prompt.

**Symptoms that signal this fix:**
- Same class of rejection recurring across runs with slightly different details (path names, schema fields).
- Prompt has grown "DO NOT..." rules mirroring validator error messages.
- Attempt-level retries burning 3–4 minutes on functional typos.
- Agent's output is almost right — specific fields would pass if edited in place.

**Shape:**
1. Pure function in `lib/`.
2. CLI at `src/segments/<seg>/cli/<name>.ts` — reads argv, prints `{valid, errors}`, exits 0/1.
3. Register as knip entry in `knip.json`.
4. In step runner per iter: seed iter workdir with inputs + `validate` wrapper (chmodded); call agent with `cwd: iterDir`, `tools: ["Read","Write","Edit","Bash"]`; re-run same check after agent exits as safety net.
5. Short prompt: list files, tell agent to run `./validate` and iterate until it passes. Remove the rule cascade.

**Don't apply when:**
- Defect is judgment/semantic (reviewer disagrees whether a rename is a good idea).
- Check is genuinely cross-step and this step shouldn't know about it.
- Check is prohibitively expensive to run N times per turn (rare — most validators are ms-scale).

Reference impl: `src/segments/classify/cli/validate-align-ops.ts` + `harmonize-align-shared.ts::runConvergeIter`. See also CLAUDE.md §"Design principle — programmatic checks become agent-facing CLIs".

## Concrete-triple example

From a real `harmonize-align-layer-1` run:

> **Input** — candidate list for `team_member/batch-0` contained `header.navigation[*].children[*].href` and `header.navigation[*].children[*].name`, but NOT `header.navigation[*].children` itself as a candidate.
>
> **Actual** — agent emitted `rename_ops[18]: {kind: "subtree", fromPrefix: "header.navigation[*].dropdown", toPrefix: "header.navigation[*].children", ...}` and 5 other subtree ops with equally unmatched `fromPrefix`es.
>
> **Expected** — either (a) no op (the prefix doesn't appear in candidates), or (b) two flat ops per prefix: `…dropdown[*].href → …children[*].href` and `.name → .name`. The prompt states "fromPrefix MUST match at least one candidate path"; this prefix matches zero.

Abstract phrases like "agent hallucinated a prefix" sound plausible whether or not you read the files. Triples force you to open them — the single cheapest way to catch a wrong conclusion.

# Spec: Implement PIPELINE-V3 Three-Segment Fan-in DAG Architecture

## Summary

Implement the three pipeline segments (analyze, wireframe, design) as defined in `PIPELINE-V3.md`, registering them into the existing engine infrastructure (`src/engine/`). This involves creating ~40+ step implementations across 3 segments with ~15 phases total, expanding the config schema to support multi-provider consensus and reviewer matrices, and building supporting utilities (Playwright browser automation, multi-provider dispatch, Zod schema validation for output contracts). The engine infrastructure (DAG executor, segment/phase/step runners, state persistence, CLI) is already complete and ready — this work is purely segment implementation that plugs into the existing framework.

## Verification Evidence

### 1. Claude Agent SDK supports non-Anthropic providers
- **Assumption**: Claude Agent SDK supports minimax, glm, kimi providers
- **Checked**: Triage notes this was confirmed by user from prior testing
- **Status**: Confirmed — the SDK wraps provider dispatch; `src/lib/agent.ts` sets `ANTHROPIC_MODEL` env var and the profile system (`src/engine/profile.ts`) resolves provider/model pairs from `cui.yaml` profiles

### 2. Provider API keys and rate limits
- **Assumption**: minimax, glm, kimi need API credentials; spec caps at 45 concurrent LLM calls
- **Checked**: Cannot verify provider-side concurrency limits without API access
- **Status**: UNVERIFIED: Provider-specific concurrency limits — could not verify because no API access to provider documentation. The 45-call cap is a local safeguard; actual provider limits may be lower and would need runtime discovery or configuration.

### 3. Playwright can extract computed styles from reference sites
- **Assumption**: Reference sites may use CSP, bot detection, or lazy loading
- **Checked**: Cannot test live against vercel.com without running Playwright
- **Status**: UNVERIFIED: Reference site accessibility — could not verify because requires live browser execution. Mitigation: the spec includes retry policy and graceful degradation (design segment compensates if analyze produces incomplete data).

### 4. OKLCH color conversion in Playwright context
- **Assumption**: `culori` or equivalent can be injected into `page.evaluate()`
- **Checked**: Playwright supports `page.addScriptTag({ path: ... })` to inject bundled scripts into the page context. `culori` is an npm package that can be bundled to a single file and injected.
- **Status**: Confirmed feasible — requires bundling culori to a standalone script and injecting via `page.addScriptTag()` before extraction. This is a known Playwright pattern.

### 5. Astro v6 content collection API
- **Assumption**: Template uses `defineCollection`, `glob()`, `file()` loaders, `reference()`
- **Checked**: `template/astro-project/package.json` has `"astro": "^6.0.3"`. Astro v6 uses `src/content.config.ts` (not `src/content/config.ts`), `glob()` and `file()` loaders, and `defineCollection` with Zod schemas.
- **Status**: Confirmed — Astro 6.0.3 in the template. The `content.config.ts` location and API match the spec exactly.

### 6. Shadcn CLI availability
- **Assumption**: Template's `components.json` is compatible with `npx shadcn@latest add`
- **Checked**: `template/astro-project/components.json` exists with `style: "new-york"`, `tsx: true`, Tailwind CSS variables enabled, aliases configured (`@/components`, `@/lib/utils`, `@/components/ui`), icon library: `lucide`. `package.json` has `shadcn: "^2.6.0"`.
- **Status**: Confirmed — components.json is valid Shadcn v2 config, CLI installation will work.

## Requirements

### Functional Requirements

#### FR-1: Config Schema Expansion

The current `CuiConfigSchema` in `src/config.ts` (Zod) and `CuiConfig` in `src/engine/types.ts` must be expanded to support multi-provider and reviewer matrix configuration.

**New fields to add to `CuiConfig`:**
- `providers`: `Record<string, LLMProfile>` — named provider pool (e.g., `minimax`, `glm`, `kimi`)
- `reviewer_matrix`: `Record<string, { providers: string[], aggregation?: "any_reject" }>` — named reviewer configurations (`default`, `critical`, `vision`, `vision_critical`)
- `step_matrix`: `Record<string, string>` — maps step IDs (e.g., `analyze.merge`) to reviewer matrix names

**Behavior:**
- `providers` field is optional; if absent, all steps use `defaults` profile
- `reviewer_matrix` is optional; if absent, all reviewers run single-provider on `defaults`
- `step_matrix` maps `{segment}.{phase}.{step}` patterns to matrix names
- Multi-provider steps: run the same prompt on all providers in the matrix entry, aggregate results per `aggregation` rule (`any_reject` = any REJECT → REJECT, PASS requires unanimity)

**Note on dual CuiConfig:** There are two `CuiConfig` interfaces — one in `src/engine/types.ts:206` (used by config.ts loader) and one in `src/types.ts:293` (different shape, appears unused by the engine). The engine's version is authoritative. The `src/types.ts` version should be reconciled or removed to avoid confusion.

**Files:** `src/config.ts`, `src/engine/types.ts`, `src/types.ts`

#### FR-2: Multi-Provider Dispatch Utility

A new utility that runs the same agent/reviewer prompt across multiple providers and aggregates results.

**Interface:**
```typescript
multiProviderQuery(opts: {
  providers: LLMProfile[];
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  stepName: string;
  logger: PipelineLogger;
  maxTurns?: number;
  config: CuiConfig;
  aggregation: "any_reject" | "all_pass";
}): Promise<{ results: StepResult[]; aggregated: StepResult }>
```

**Behavior:**
- Runs `agentQuery` in parallel for each provider
- Applies aggregation: `any_reject` means any single REJECT → REJECT with merged rejection contexts
- Provider concurrency capped at 45 simultaneous calls (global semaphore)

**Files:** New `src/lib/multi-provider.ts`

#### FR-3: Playwright Utilities

New Playwright helper module for browser automation used by both analyze (computed style extraction) and wireframe/design (console capture, vision screenshots).

**Capabilities needed:**
- Launch headless browser with configurable viewport (375px, 768px, 1440px)
- Take full-page screenshots at specified viewports
- Extract computed styles from DOM elements via `getComputedStyle`
- Extract CSS custom properties from `document.styleSheets`
- Extract pseudo-element styles via `getComputedStyle(el, '::before')`
- Extract transition/animation properties from stylesheets
- Inject `culori` library for OKLCH color conversion in browser context
- Console error/warning capture per page
- Isolated browser contexts (no shared state between reviewers)
- Visit all pages in a built Astro site for review purposes

**Files:** New `src/lib/playwright-utils.ts`

#### FR-4: Segment 1 — Analyze

Register segment with `id: "analyze"`, `depends: []`. Implements 4 phases:

**Phase 1: Identify + Scout**
- Step 1a (programmatic): Read `structure.json`, extract unique pagetype set
- Step 1b (agent): Scout reference URL, map target types → reference URLs with confidence scores. Output: catalog JSON with `matched`, `unmatched`, `generic` arrays. Confidence thresholds: ≥0.7 full extraction, 0.4–0.7 low_confidence flag, <0.4 skip.

**Phase 2: Extract (fan-out)**
- For each page in catalog: run 2 agents in parallel (visual + measurement)
- Visual agent: screenshots at 3 viewports + vision model analysis → per-page markdown + screenshots
- Measurement agent: Playwright computed styles, CSS custom properties, pseudo-elements, transitions, OKLCH conversion → structured measurements JSON
- N pages × 2 agents concurrent, capped at 45 LLM calls

**Phase 3: Merge**
- Single LLM agent (multi-provider consensus per step_matrix config) synthesizes all extraction results into 3 canonical JSONs:
  - `style-fingerprint.json` — 8-dimension personality + treatments
  - `design-tokens.json` — 7-layer token architecture
  - `component-recipes.json` — per-component CSS bundles
- Reconciliation rules: spacing clustering, color role dedup, typography scale, component dedup, fingerprint weighted aggregation
- Pattern compilation (programmatic): organize visual agent markdown + screenshots into `patterns/` directory

**Phase 4: Validate**
- Programmatic gate: Zod validation of 3 output JSONs, OKLCH parseable, 7 layers non-empty, recipes have base+variants, spacing ≥4 steps, typography ≥3 sizes
- Semantic AI review: vision-capable agent compares screenshots vs tokens for completeness/coherence/fidelity
- Retry: max 2 retries on failure. If still failing, warn and proceed.

**Output contract:** `style-fingerprint.json`, `design-tokens.json`, `component-recipes.json`, `patterns/` directory

**Files:** New `src/segments/analyze.ts` + supporting modules

#### FR-5: Segment 2 — Wireframe

Register segment with `id: "wireframe"`, `depends: []`. Implements 5 phases:

**Phase 1: Reduce (programmatic)**
- Group pages by pagetype, count instances
- Extract richest + simplest sample per type
- Download all referenced images with content-addressed naming
- Build `asset-manifest.json` (original URL → local path)
- Rewrite internal links to relative Astro routes
- Flag CMS-specific URLs for removal, external links for preservation
- Output: `reduced/` directory + `asset-manifest.json`

**Phase 2: Classify (AI — 3 parallel classifiers + validation + review + incremental merge)**
- Step 2a: Three classifiers in parallel (architecture, content model, interaction+components)
- Step 2b: Programmatic cross-validation of classifier outputs
- Step 2c: AI review for semantic consistency
- Step 2d: Incremental multi-provider merge in 5 sub-steps:
  - 2d-1: Build `registry.json` (multi-provider consensus)
  - 2d-2: Build `content-model.json` (multi-provider, validated against registry)
  - 2d-3: Build `component-manifest.json` (multi-provider, validated against registry + content-model)
  - 2d-4: Cross-validation (programmatic — every relationship resolves, no orphans)
  - 2d-5: Conflict resolution (AI, only if provider disagreements remain)

**Phase 3: Transform + Seed (programmatic)**
- Copy Astro template into workdir
- Apply content-model composition specs to all pages
- Write content collections, singletons, globals
- Generate `src/content.config.ts` with Zod schemas + loaders
- Validate: every source page accounted for, no orphans

**Phase 4: Generate Wireframe (AI + programmatic)**
- Step 4a: Components (fan-out per component) — unstyled semantic HTML, no classes, no Tailwind
- Step 4b: Layouts — Layout.astro with global components wired with real data
- Step 4c: Page stubs (programmatic) — working route skeletons
- Step 4d: Per-page-type content fill (fan-out per page type) — fill stubs with components + content bindings
- Step 4e: Reviewers — two-pass review (static+console+vision+content in pass 1; trace in pass 2). Fix loop max 3 iterations.

**Phase 5: Final Validation (programmatic gate)**
- `astro build && pagefind --site dist` clean
- `bun run check` passes
- `lychee dist/` zero broken links/images
- Playwright visits every route, no HTTP 500s
- Content coverage: every source page has a rendered route
- No original-site absolute URLs, no Tailwind utility classes in components
- All asset-manifest images exist, `dist/pagefind/` exists

**Output contract:** Working unstyled Astro project, `content-model.json`, `component-manifest.json`, `registry.json`, `asset-manifest.json`

**Files:** New `src/segments/wireframe.ts` + supporting modules

#### FR-6: Segment 3 — Design

Register segment with `id: "design"`, `depends: ["analyze", "wireframe"]`. Implements 6 phases:

**Phase 1: Token Injection + Shadcn Setup**
- Step 1a (programmatic): Convert design tokens to CSS custom properties in `globals.css`
- Step 1b (agent): Install Shadcn components via CLI based on component-manifest mapping
- Step 1c (programmatic): Font loading setup (Google Fonts / local)
- Step 1d (programmatic gate): Build passes, all Shadcn components present

**Phase 2: Layout (agent — fan-out per page type)**
- Step 2a: Global layout skeleton (single agent) — container structure, section spacing
- Step 2b: Per-page-type layout (fan-out) — mobile-first grid/flex at 3 breakpoints
- Step 2c: Three-breakpoint validation gate (programmatic + vision)
- CSS layer: `@layer layout`
- On REJECT: fan-out fix, max 3 iterations

**Phase 3: Typography + Surfaces (agent — fan-out per component)**
- Step 3a: Global typography (single agent) — heading scale, prose
- Step 3b: Shadcn component customization (fan-out) — recipe mapping
- Step 3c: Astro component surface treatment (fan-out) — fingerprint-driven
- Step 3d: Review gate (programmatic + vision)
- CSS layers: `@layer typography, surfaces`
- On REJECT: fix per failing component, max 3 iterations

**Phase 4: Color + Dark Mode (single agent + programmatic)**
- Step 4a (programmatic): Color system generation — `:root` + `.dark` CSS vars
- Step 4b (agent): Component color application + dark mode toggle
- Step 4c (programmatic): WCAG contrast validation with auto-fix
- Step 4d: Review gate (programmatic + vision, light + dark at 3 breakpoints)
- CSS layer: `@layer color`

**Phase 5: Motion (agent — global + fan-out per component)**
- Step 5a: Global motion styles — transitions, scroll reveal, focus-visible
- Step 5b: Per-component state application (fan-out) — hover/focus/active/disabled
- Step 5c: Review gate (programmatic + vision)
- CSS layer: `@layer motion`

**Phase 6: Final Visual QA (reviewers)**
- Step 6a: Full reviewer sweep (static, console, vision, WCAG, fidelity, content completeness)
- Step 6b: Quality scoring (7 dimensions, ≥7.0 threshold)
- Step 6c: Design fidelity score (vision, 8 dimensions, ≥0.6 threshold)
- Step 6d: Final gate — build success, no overflow, dark mode correct, reduced-motion, quality ≥7.0, fidelity ≥0.6
- On REJECT: fix loop max 3 iterations

**CSS Layer Order:** `@layer layout, typography, surfaces, color, motion;` — declared once in `src/styles/layers.css`, imported before `globals.css`.

**Output contract:** Fully styled Astro project with `quality-scores.json`

**Files:** New `src/segments/design.ts` + supporting modules

#### FR-7: Evidence + Review System

Cross-cutting folder structure that all segments use:

```
workdir/
  evidence/{iteration}/     ← build.json, biome.json, typecheck.json, screenshots/, console-errors/
  reviews/{iteration}/      ← static-checks.md, console-review.md, vision-review.md, trace-review.md
```

**Four reviewer types** must be implemented as reusable step builders:
1. **Static checks reviewer** (agent + Bash): runs `bun run check`, `astro build`, `lychee dist/`
2. **Console error reviewer** (agent + Playwright): visits all pages, captures console errors
3. **Vision reviewer** (agent + Playwright + vision): screenshots at 3 viewports, vision analysis
4. **Trace reviewer** (agent + Read): traces errors back to source files with fix instructions

**Aggregation:** Any single REJECT from any reviewer → phase REJECT. Rejection context merges all findings.

**Files:** New `src/lib/reviewers.ts` (reusable reviewer step builders)

#### FR-8: Segment Registration and CLI Integration

Each segment must:
- Call `registry.register(segmentDef)` at module level
- Be imported in `src/index.ts` (uncomment existing stubs or add new imports)
- Appear in `bun src/index.ts list` output with correct dependencies, phases, and step counts
- Implement `mergeInputs()` (for design segment — copy analyze + wireframe outputs into workdir)
- Implement `extractOutput()` (copy final outputs to segment output directory)

**Files:** `src/index.ts`, `src/segments/analyze.ts`, `src/segments/wireframe.ts`, `src/segments/design.ts`

### Non-Functional Requirements

#### 1. Linting
**Applies.** All new code must pass `bun run check` (biome + tsc + knip). The project uses Biome with an existing config. New files in `src/segments/`, `src/lib/` must follow existing patterns (explicit `.js` extensions in imports, proper type imports). Knip must not flag new exports as unused — all new modules must be imported by segments or `src/index.ts`.

#### 2. Building
**Applies.** The project builds with `bun` (TypeScript). New files must compile cleanly with `tsc`. No new build steps needed — segments are TypeScript modules imported at runtime. New dependencies needed: `culori` (OKLCH conversion), `playwright` (browser automation) — these must be added to `package.json`. `lychee` (link checking) is a system binary provided by the nix development shell — it must NOT be added to `package.json`.

#### 3. Unit Testing
**Partially applies.** Unit testing individual steps is impractical (they run AI agents or browser automation). However, programmatic steps (reduce, transform+seed, token-to-CSS conversion, Zod validators, reconciliation utilities) can and should have unit tests for their pure logic. Test the data transforms, Zod schemas, and utility functions.

#### 4. Integration Testing
**Applies.** The natural validation is end-to-end: run each segment independently with example input and verify outputs. The evidence + review system IS the built-in integration test. Validate: each segment registers, runs against `example/` input, and produces valid output artifacts.

#### 5. End-to-End Testing
**Applies but deferred.** A full pipeline run (all 3 segments) with example input + visual inspection is the E2E test. This is listed in the triage validation matrix as "manual post-release." The review system with Playwright vision checks provides automated E2E coverage within each segment.

#### 6. Documentation
**Does not apply for new docs.** `PIPELINE-V3.md` is the specification and already exists. Code comments should document non-obvious decisions in step implementations (e.g., reconciliation heuristics, OKLCH conversion approach). No README or ADR changes needed.

#### 7. Observability
**Applies.** The existing `src/lib/logger.ts` provides TUI dashboard and event logging. The `agentQuery` wrapper logs events to `agent-events.jsonl` with turn counts, token usage, and cost. No additional observability needed — the evidence + review system produces a complete audit trail in `evidence/` and `reviews/` directories per iteration.

#### 8. Invariant Checking
**Applies.** Key invariants:
- Phase ownership: wireframe produces zero CSS classes/styling; design writes only to its own CSS `@layer`
- Output contract: each segment's output must Zod-validate against the TypeScript interfaces in `src/types.ts`
- Cross-phase regression: design phases check that earlier layers haven't been modified (grep-based layer isolation)
- Content completeness: every source page in `content.json` must have a rendered route
- Asset integrity: every entry in `asset-manifest.json` must have a corresponding file in `public/images/`
These are enforced by programmatic gate steps within each segment.

#### 9. Security
**Applies minimally.** Playwright navigates external reference URLs — standard browser automation, no credential handling. The pipeline runs locally. API keys for providers (minimax, glm, kimi) come from environment variables per `LLMProfile.env`. No user-facing input validation needed. No secrets stored in output artifacts.

#### 10. Performance
**Applies.** Key performance concerns:
- Provider concurrency: global semaphore capping at 45 simultaneous LLM calls (configurable)
- Fan-out parallelism: analyze Phase 2 (N pages × 2 agents), wireframe Phase 4a (N components), design Phase 2b (N page types) — all must respect the concurrency cap
- Playwright browser instances: each reviewer gets its own context but browsers should be reused where possible
- Token budget: analyze ~200-340k tokens, design ~900k-2M tokens per run. No optimization needed beyond the concurrency cap.

#### 11. Backwards Compatibility
**Does not apply.** No existing segments to break. The engine API (`SegmentDef`, `StepDef`, step builders) is stable and we're implementing against it. Config schema expansion is additive (new optional fields). Existing `cui.yaml` files work without changes.

#### 12. Accessibility
**Applies for generated output.** The design segment Phase 4 (color) includes WCAG contrast validation with auto-fix. The pipeline produces web content that must meet contrast requirements. Phase 6 Final QA includes WCAG checks. The pipeline tool itself has no UI beyond the CLI.

#### Additional Domain-Specific Items

**13. CSS Layer Isolation** — Design segment phases write to specific `@layer` scopes. Cross-phase regression detection (grep for properties outside owned layer) is a critical invariant. Each design phase retry must verify it hasn't modified other layers.

**14. Retry Semantics** — Each phase has configurable `maxRetries`. The engine handles retry by copying the iteration workdir and providing `rejectionContext` to the next attempt. Segment implementations must ensure their steps read and act on `ctx.rejectionContext`.

**15. Fan-out Step Support** — The engine's `phase-runner.ts` supports `step.parallel > 1` for spawning N instances. Segment implementations that need per-page or per-component fan-out must use this mechanism or implement custom fan-out within a step's `run` function.

## Acceptance Criteria

### Infrastructure
- [ ] `src/config.ts` Zod schema accepts `providers`, `reviewer_matrix`, and `step_matrix` fields; existing configs without these fields still parse correctly
- [ ] `bun src/index.ts list` shows all 3 segments with correct dependency graph, phase counts, and step counts
- [ ] `bun run check` passes clean (biome + tsc + knip) with all new code

### Segment: Analyze
- [ ] Registers with `id: "analyze"`, `depends: []`
- [ ] Phase 1 reads `structure.json` and produces page type catalog
- [ ] Phase 2 launches parallel extraction agents (visual + measurement) for each cataloged page
- [ ] Phase 3 produces `style-fingerprint.json`, `design-tokens.json`, `component-recipes.json` that Zod-validate against `src/types.ts` interfaces
- [ ] Phase 4 runs programmatic validation gate + semantic AI review with retry policy
- [ ] `extractOutput()` copies the 3 JSONs + `patterns/` to the output directory

### Segment: Wireframe
- [ ] Registers with `id: "wireframe"`, `depends: []`
- [ ] Phase 1 produces `reduced/` directory with downloaded images and `asset-manifest.json`
- [ ] Phase 2 produces `registry.json`, `content-model.json`, `component-manifest.json` with cross-validation
- [ ] Phase 3 produces working Astro project scaffold with content collections, `content.config.ts`, and all route files
- [ ] Phase 4 generates unstyled components, layouts, and page content — `astro build` succeeds
- [ ] Phase 5 final validation: build clean, `bun run check` passes, content coverage 100%, no Tailwind classes in components

### Segment: Design
- [ ] Registers with `id: "design"`, `depends: ["analyze", "wireframe"]`
- [ ] `mergeInputs()` correctly overlays analyze tokens + wireframe project into workdir
- [ ] Phase 1 converts tokens to CSS custom properties and installs Shadcn components
- [ ] Phases 2-5 apply layout, typography, color, and motion in isolated `@layer` scopes
- [ ] Phase 6 produces `quality-scores.json` with overall ≥7.0 and design fidelity ≥0.6
- [ ] Final output: styled Astro project builds clean, renders at 375/768/1440px without overflow, dark mode works

### Evidence + Review System
- [ ] `evidence/{iteration}/` and `reviews/{iteration}/` directories populated by reviewer steps
- [ ] All 4 reviewer types (static, console, vision, trace) operational
- [ ] Rejection flow: reviews aggregated into `rejectionContext`, next iteration's implementer reads them
- [ ] Multi-provider consensus works: same prompt runs on configured providers, any REJECT → REJECT

### End-to-End
- [ ] Full pipeline run: `bun src/index.ts run` with example input + vercel.com reference completes all 3 segments
- [ ] Analyze and wireframe run concurrently (independent); design waits for both
- [ ] Resume works: `bun src/index.ts resume <run-dir>` picks up from failed segment

## Out of Scope

- **CMS adapter implementation** — covered by separate `CMS-ADAPTER-SPEC.md`; the wireframe segment generates CMS-compatible content files but does not implement push/pull
- **Custom provider adapters** — assumes Claude Agent SDK handles minimax/glm/kimi natively; no custom HTTP clients
- **Template modifications** — the Astro template (`template/astro-project/`) is used as-is; no changes to its base structure, build config, or pre-built features (Search, query layer, CMS sync)
- **Production deployment** — Vercel deployment configuration is not part of this pipeline implementation
- **Scraper implementation** — the pipeline consumes scraper output; scraping is a separate tool
- **Performance optimization** — token budget monitoring and cost optimization beyond the 45-call concurrency cap
- **Test suite creation** — moderate testing level per triage: validate segments work with example input, no formal test framework setup

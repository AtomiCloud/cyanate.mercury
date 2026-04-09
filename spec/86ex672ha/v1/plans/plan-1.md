# Plan 1: Shared Infrastructure — Config, Multi-Provider, Playwright, Reviewers

## Overview

Build the cross-cutting foundation that all three segments depend on: expanded config schema for multi-provider consensus, the multi-provider dispatch utility, Playwright browser automation helpers, reusable reviewer step builders, and Zod output validators. All programmatic logic is split into **pure functions** (data in → data out, fully unit-testable) and **thin IO shells** (file/process/browser side-effects). This is the prerequisite for all segment work and forms a standalone committable unit.

## Architecture: Pure Core / IO Shell

Every module follows this pattern:

```
src/lib/foo.ts          ← pure functions (transforms, validators, aggregators)
src/lib/foo.io.ts       ← IO shell (reads files, writes files, spawns processes, calls agentQuery)
src/lib/foo.test.ts     ← unit tests for pure functions only
```

The IO shell imports and calls pure functions, passing in data it read from disk/network. Steps (in segments) call the IO shell. Tests call pure functions directly with fixture data.

## Changes

### 1. Expand Config Schema — `src/config.ts` + `src/engine/types.ts`

**Pure (already pure — Zod schemas are declarative):**

Add to `src/engine/types.ts`:
```typescript
providers?: Record<string, LLMProfile>;
reviewer_matrix?: Record<string, { providers: string[]; aggregation?: "any_reject" }>;
step_matrix?: Record<string, string>;
```

Add corresponding Zod schemas in `src/config.ts` (all optional, existing configs parse unchanged).

Reconcile dual `CuiConfig`: mark `src/types.ts:293` as `@deprecated`, update any imports to use `src/engine/types.ts` version.

**Tests** (`src/config.test.ts`):
- Parse config with all new fields → valid
- Parse config without new fields → valid (backwards compat)
- Parse config with invalid `reviewer_matrix` shape → error
- Parse config with unknown `step_matrix` reference → passes (validated at runtime, not schema-level)

### 2. Multi-Provider Dispatch — `src/lib/multi-provider.ts` + `src/lib/multi-provider.io.ts`

**Pure** (`src/lib/multi-provider.ts`):
```typescript
// Aggregate an array of step results into a single verdict
export function aggregateResults(
  results: StepResult[],
  aggregation: "any_reject" | "all_pass"
): StepResult;

// Merge rejection contexts from multiple providers into one string
export function mergeRejectionContexts(reviews: Review[][]): string;

// Resolve which providers to use for a given step from config
export function resolveProviders(
  config: CuiConfig,
  stepId: string
): LLMProfile[];
```

**IO Shell** (`src/lib/multi-provider.io.ts`):
```typescript
// Runs agentQuery in parallel for each provider, calls aggregateResults
export async function multiProviderQuery(opts: {
  providers: LLMProfile[];
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  stepName: string;
  logger: PipelineLogger;
  maxTurns?: number;
  config: CuiConfig;
  aggregation: "any_reject" | "all_pass";
}): Promise<{ results: StepResult[]; aggregated: StepResult }>;
```

**Tests** (`src/lib/multi-provider.test.ts`):
- `aggregateResults`: 3 PASS → PASS; 2 PASS + 1 REJECT → REJECT; all REJECT → REJECT
- `aggregateResults`: empty array → PASS (vacuous truth)
- `mergeRejectionContexts`: merges findings from multiple reviewers, deduplicates
- `resolveProviders`: step in `step_matrix` → returns matrix providers; step not in matrix → returns `[defaults]`

### 3. Concurrency Semaphore — `src/lib/semaphore.ts`

**Pure (stateful but no IO):**
```typescript
export class Semaphore {
  constructor(limit: number);
  async acquire(): Promise<() => void>;
  get available(): number;
  get pending(): number;
}
```

**Tests** (`src/lib/semaphore.test.ts`):
- Acquire up to limit → all resolve immediately
- Acquire limit+1 → last one waits until a release
- Release in order → pending resolves FIFO
- Concurrent stress: 100 acquires with limit 5, verify never >5 concurrent

### 4. Playwright Utilities — `src/lib/playwright-utils.ts`

This is inherently IO (browser automation). No pure/IO split needed — but extract any data transforms done on browser results into pure helpers:

**Pure helpers** (in `src/lib/playwright-utils.ts`):
```typescript
// Parse raw getComputedStyle output into structured token map
export function parseComputedStyles(raw: Record<string, string>): StyleMap;

// Parse CSS custom properties from raw stylesheet text
export function parseCssCustomProperties(rawSheets: string[]): Record<string, string>;

// Categorize console messages by severity
export function categorizeConsoleMessages(
  messages: Array<{ type: string; text: string }>
): { errors: string[]; warnings: string[]; info: string[] };
```

**IO Shell** (rest of `src/lib/playwright-utils.ts`):
- `launchBrowser()`, `screenshotAtViewports()`, `extractComputedStyles()`, `extractCssCustomProperties()`, `extractPseudoStyles()`, `extractTransitions()`, `injectCulori()`, `captureConsoleErrors()`, `visitAllRoutes()`, `createIsolatedContext()`

**Tests** (`src/lib/playwright-utils.test.ts`):
- `parseComputedStyles`: raw map → structured tokens
- `parseCssCustomProperties`: raw sheet text → property map; handles multiple sheets; handles empty
- `categorizeConsoleMessages`: mixed messages → correct buckets; unknown types → info

Dependencies to add: `culori`. `@playwright/test` already present.

### 5. Reusable Reviewer Step Builders — `src/lib/reviewers.ts` + `src/lib/reviewers.io.ts`

**Pure** (`src/lib/reviewers.ts`):
```typescript
// Parse a reviewer's text output into a structured verdict
export function parseReviewerVerdict(output: string): {
  verdict: "pass" | "reject";
  findings: string;
  rejectionContext?: string;
};

// Aggregate multiple reviewer verdicts (any REJECT → REJECT)
export function aggregateReviewerVerdicts(verdicts: Review[]): StepResult;

// Build evidence directory path for an iteration
export function evidencePath(workdir: string, iteration: number): string;

// Build review directory path for an iteration
export function reviewPath(workdir: string, iteration: number): string;
```

**IO Shell** (`src/lib/reviewers.io.ts`):
Four factories that return `StepDef` objects:
```typescript
export function staticChecksReviewer(opts: ReviewerOpts): StepDef;   // runs bun check, astro build, lychee
export function consoleErrorReviewer(opts: ReviewerOpts): StepDef;   // Playwright console capture
export function visionReviewer(opts: ReviewerOpts): StepDef;         // Playwright screenshots + vision AI
export function traceReviewer(opts: ReviewerOpts): StepDef;          // reads files + AI trace
```

Each reviewer writes evidence/reviews to disk, then calls pure `parseReviewerVerdict` / `aggregateReviewerVerdicts`.

**Tests** (`src/lib/reviewers.test.ts`):
- `parseReviewerVerdict`: "VERDICT: PASS" → pass; "VERDICT: REJECT\nREJECTION CONTEXT: ..." → reject with context
- `parseReviewerVerdict`: malformed output → reject (fail-safe)
- `aggregateReviewerVerdicts`: all pass → pass; one reject → reject with merged findings
- `evidencePath` / `reviewPath`: correct path construction

### 6. Zod Output Validators — `src/lib/validators.ts`

**Pure (Zod schemas are declarative data validators):**

Schemas for all output contracts:
- `StyleFingerprintSchema` — validates 8 dimensions are numbers in [0,1], treatments are strings
- `DesignTokensV2Schema` — validates 7 layers non-empty, OKLCH strings parseable
- `ComponentRecipesSchema` — validates each recipe has `base` + `variants`
- `RegistrySchema` — validates collections, listings, static_pages
- `ReducedMetaSchema` — validates page_types array
- `QualityScoresSchema` — validates 7 dimensions, overall in [0,10]
- `ContentModelSchema`, `ComponentManifestSchema`, `AssetManifestSchema`

Plus domain-specific pure validators:
```typescript
// Check spacing scale has ≥4 steps
export function validateSpacingScale(tokens: DesignTokensV2): string[];

// Check typography has ≥3 sizes
export function validateTypographyScale(tokens: DesignTokensV2): string[];

// Check OKLCH values are parseable
export function validateOklchValues(tokens: DesignTokensV2): string[];

// Check content coverage: every source page has a route
export function validateContentCoverage(
  sourcePages: PageContent[],
  generatedRoutes: string[]
): { covered: string[]; missing: string[] };

// Check asset integrity: every manifest entry has a file
export function validateAssetIntegrity(
  manifest: Record<string, string>,
  existingFiles: string[]
): { valid: string[]; missing: string[] };

// Check no absolute URLs from original site leak into generated files
export function findLeakedAbsoluteUrls(
  fileContents: Record<string, string>,
  originalSiteUrl: string
): Array<{ file: string; line: number; url: string }>;

// Check no Tailwind utility classes in component files
export function findTailwindClasses(
  fileContents: Record<string, string>
): Array<{ file: string; line: number; classes: string[] }>;
```

**Tests** (`src/lib/validators.test.ts`):
- Each Zod schema: valid fixture → passes; missing required field → fails; wrong types → fails
- `validateSpacingScale`: 4 steps → []; 3 steps → error message
- `validateTypographyScale`: 3 sizes → []; 2 sizes → error
- `validateOklchValues`: valid `oklch(0.5 0.1 180)` → []; invalid `#ff0000` → error
- `validateContentCoverage`: all covered → empty missing; one missing → listed
- `validateAssetIntegrity`: all present → empty missing; one missing → listed
- `findLeakedAbsoluteUrls`: no leaks → []; `https://original.com/foo` found → reported with file + line
- `findTailwindClasses`: no classes → []; `class="flex items-center"` found → reported

## Spec Adherence

| Requirement | Coverage |
|---|---|
| FR-1: Config Schema Expansion | Full — `providers`, `reviewer_matrix`, `step_matrix` fields |
| FR-2: Multi-Provider Dispatch | Full — pure aggregation + IO dispatch |
| FR-3: Playwright Utilities | Full — all capabilities, pure data transforms extracted |
| FR-7: Evidence + Review System | Full — 4 reviewer types, pure verdict parsing |
| NFR-1: Linting | All new files pass `bun run check` |
| NFR-2: Building | `culori` added |
| NFR-3: Unit Testing | High coverage: all pure functions have unit tests |
| NFR-8: Invariant Checking | Zod validators + domain validators enforce contracts |
| NFR-10: Performance | Global semaphore caps concurrency at 45 |

## Acceptance Criteria

### Functional Checks
- Config schema: with/without new fields both parse correctly
- `aggregateResults`: any_reject semantics correct
- `resolveProviders`: step_matrix → matrix providers lookup works
- Semaphore: concurrency correctly bounded
- All Zod schemas: accept valid fixtures, reject invalid
- All domain validators: correct error detection on edge cases
- Reviewer verdict parsing: handles pass, reject, and malformed output

### Non-Functional Checks
- `bun run check` passes clean
- Unit test suite passes with high coverage on all `*.test.ts` files
- No knip unused export warnings

## Validation Approach

- **Immediate automated**: `bun run check` clean; `bun test` passes all unit tests; coverage report shows >90% on pure modules
- **Manual immediate**: Verify config schema with sample `cui.yaml`
- **Post-release**: Playwright utils validated when segments run against live sites

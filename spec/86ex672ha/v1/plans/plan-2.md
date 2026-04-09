# Plan 2: Analyze Segment — Reference Site Extraction

## Overview

Implement the analyze segment (FR-4) that extracts a reference website's visual design into canonical JSON artifacts. Pure logic (catalog building, measurement reconciliation, token merging, validation) is separated from IO (file reads/writes, Playwright browser automation, agent calls). Registered with `id: "analyze"`, `depends: []`.

## Architecture: Pure Core / IO Shell

```
src/segments/analyze/
  index.ts              ← segment registration (SegmentDef, imports phases)
  phases.io.ts          ← IO shell: step definitions that read/write files + call agents
  catalog.ts            ← pure: build page catalog from structure data
  catalog.test.ts       ← unit tests for catalog logic
  merge.ts              ← pure: reconcile extraction results into canonical JSONs
  merge.test.ts         ← unit tests for merge/reconciliation logic
  validate.ts           ← pure: analyze-specific validation rules
  validate.test.ts      ← unit tests for validation rules
```

## Changes

### 1. Segment Registration — `src/segments/analyze/index.ts`

```typescript
const analyzeSegment: SegmentDef = {
  id: "analyze",
  depends: [],
  phases: [identifyPhase, extractPhase, mergePhase, validatePhase],
  mergeInputs: async () => {},  // no-op
  extractOutput: async (workdir, outputDir) => { /* copy 3 JSONs + patterns/ */ }
};
registry.register(analyzeSegment);
```

Import in `src/index.ts`: `import "./segments/analyze/index.js";`

### 2. Pure: Catalog Builder — `src/segments/analyze/catalog.ts`

```typescript
// Extract unique page types from structure data
export function extractPageTypes(structure: StructureData): string[];

// Build extraction catalog with confidence-based filtering
export function buildCatalog(
  pageTypes: string[],
  scoutResult: ScoutResult
): Catalog;

export interface ScoutResult {
  mappings: Array<{
    sourceType: string;
    referenceUrl: string;
    confidence: number;
  }>;
}

export interface Catalog {
  matched: Array<{ sourceType: string; referenceUrl: string; confidence: number }>;
  unmatched: string[];        // source types with no reference match
  generic: string[];          // reference pages not tied to a type
  lowConfidence: string[];    // 0.4–0.7 flagged types
  skipped: string[];          // <0.4 confidence
}

// Filter catalog entries by confidence threshold
export function filterByConfidence(
  mappings: ScoutResult["mappings"],
  thresholds: { full: number; low: number; skip: number }
): { matched: typeof mappings; lowConfidence: typeof mappings; skipped: typeof mappings };
```

**Tests** (`src/segments/analyze/catalog.test.ts`):
- `extractPageTypes`: deduplicates, sorts alphabetically
- `filterByConfidence`: ≥0.7 → matched, 0.4–0.7 → lowConfidence, <0.4 → skipped
- `buildCatalog`: integrates extraction + filtering; handles empty scout result; handles all-skipped

### 3. Pure: Merge & Reconciliation — `src/segments/analyze/merge.ts`

```typescript
// Cluster spacing values into a normalized scale
export function clusterSpacing(
  measurements: MeasurementData[]
): Record<string, string>;

// Deduplicate color roles across pages
export function deduplicateColors(
  measurements: MeasurementData[]
): Record<string, string>;

// Build typography scale from measured font sizes
export function buildTypographyScale(
  measurements: MeasurementData[]
): { fontFamily: Record<string, string>; fontSize: Record<string, string>; fontWeight: Record<string, number> };

// Deduplicate component patterns across pages
export function deduplicateComponents(
  measurements: MeasurementData[]
): ComponentRecipes;

// Weighted aggregation of fingerprint dimensions
export function aggregateFingerprint(
  perPageFingerprints: Array<{ dimensions: Record<string, number>; weight: number }>
): StyleFingerprint["style"]["dimensions"];

// Assemble complete design tokens from reconciled data
export function assembleDesignTokens(parts: {
  colors: Record<string, string>;
  typography: ReturnType<typeof buildTypographyScale>;
  spacing: Record<string, string>;
  // ... other layers
}): DesignTokensV2;

// Organize visual markdown + screenshots into patterns structure
export function buildPatternsManifest(
  extractions: Array<{ pageId: string; pageType: string; visualMd: string; screenshotPaths: string[] }>
): PatternsManifest;
```

**Tests** (`src/segments/analyze/merge.test.ts`):
- `clusterSpacing`: [4px, 5px, 8px, 15px, 16px, 32px] → clusters to [4, 8, 16, 32] (nearest power-of-2 or common scale)
- `deduplicateColors`: same OKLCH within ΔE threshold → merged; distinct → preserved
- `buildTypographyScale`: extracts unique sizes, sorts, deduplicates within tolerance
- `deduplicateComponents`: same structure different pages → single recipe with variants
- `aggregateFingerprint`: weighted average across pages; single page → passthrough
- `assembleDesignTokens`: all layers present and correctly structured
- `buildPatternsManifest`: groups by page type, deterministic file naming

### 4. Pure: Validation Rules — `src/segments/analyze/validate.ts`

```typescript
// Run all analyze output validation checks
export function validateAnalyzeOutputs(outputs: {
  fingerprint: unknown;
  tokens: unknown;
  recipes: unknown;
}): { valid: boolean; errors: string[] };
```

Internally calls validators from `src/lib/validators.ts` (Zod schemas + `validateSpacingScale`, `validateTypographyScale`, `validateOklchValues`). This function composes them and returns a flat error list.

**Tests** (`src/segments/analyze/validate.test.ts`):
- Valid complete outputs → `{ valid: true, errors: [] }`
- Missing fingerprint dimension → specific error
- Empty spacing layer → "spacing must have ≥4 steps"
- Invalid OKLCH value → "unparseable OKLCH: ..."
- Recipes without `base` → "component X missing base recipe"

### 5. IO Shell: Phase Definitions — `src/segments/analyze/phases.io.ts`

Thin wiring that reads files, calls agents, calls pure functions, writes results:

**Phase 1: Identify + Scout**
- Step 1a (`programmaticStep`): read `structure.json` → `extractPageTypes()` → write `page-types.json`
- Step 1b (`agentStep`): prompt with reference URL + page types → parse result → `buildCatalog()` → write `catalog.json`

**Phase 2: Extract (fan-out)**
- Single `programmaticStep` that reads `catalog.json`, spawns parallel `agentQuery` calls (visual + measurement per page via semaphore), writes results to `extraction/{pageId}/`

**Phase 3: Merge**
- Step 3a (`agentStep`): reads all extraction data, agent synthesizes → parse JSON → validate with `assembleDesignTokens()` → write 3 JSONs
- Step 3b (`programmaticStep`): reads extraction markdown/screenshots → `buildPatternsManifest()` → write `patterns/`

**Phase 4: Validate**
- Step 4a (`programmaticStep`): reads 3 JSONs → `validateAnalyzeOutputs()` → pass/reject
- Step 4b (`reviewerStep`): vision AI review using `visionReviewer` from plan 1

### 6. Registration — `src/index.ts`

Add `import "./segments/analyze/index.js";`

## Spec Adherence

| Requirement | Coverage |
|---|---|
| FR-4: Segment 1 — Analyze | Full — all 4 phases, pure logic extracted |
| FR-8: Segment Registration | Registered, appears in `list` |
| NFR-1: Linting | All files pass `bun run check` |
| NFR-3: Unit Testing | High coverage on catalog, merge, validate modules |
| NFR-8: Invariant Checking | Zod + domain validation in Phase 4 |
| NFR-10: Performance | Fan-out capped by semaphore |
| NFR-14: Retry Semantics | maxRetries: 2 on Phase 4 |

## Acceptance Criteria

### Functional Checks
- `bun src/index.ts list` shows analyze with 4 phases, correct step counts
- `extractPageTypes` correctly deduplicates from structure data
- `filterByConfidence` correctly buckets at 0.4/0.7 thresholds
- `clusterSpacing` produces normalized scale from raw measurements
- `deduplicateColors` merges within OKLCH ΔE threshold
- `aggregateFingerprint` produces weighted average dimensions
- `validateAnalyzeOutputs` catches all specified validation failures
- Phase 4 gate rejects on Zod failure; retries with context

### Non-Functional Checks
- `bun run check` passes clean
- Unit tests pass: catalog.test.ts, merge.test.ts, validate.test.ts
- Coverage >90% on pure modules

## Validation Approach

- **Immediate automated**: `bun run check` clean; `bun test` on analyze pure modules; Zod fixture tests
- **Manual immediate**: Run analyze against vercel.com, verify 3 output JSONs are valid
- **Post-release**: Visual inspection of extracted tokens against reference site

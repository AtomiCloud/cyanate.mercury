# Plan 4: Design Segment — Styled Output with Visual QA

## Overview

Implement the design segment (FR-6) — the fan-in convergence point that applies analyze's design tokens to wireframe's unstyled Astro project. All programmatic logic (token-to-CSS conversion, WCAG contrast checking, layer isolation verification, quality score aggregation) extracted as pure functions. IO shell handles file reads/writes, agent calls, Playwright screenshots, and process execution.

## Architecture: Pure Core / IO Shell

```
src/segments/design/
  index.ts                ← segment registration
  phases.io.ts            ← IO shell: step definitions
  tokens.ts               ← pure: design token → CSS custom property conversion
  tokens.test.ts
  color.ts                ← pure: color system generation, WCAG contrast, auto-fix
  color.test.ts
  layers.ts               ← pure: CSS layer isolation checking, layer file generation
  layers.test.ts
  quality.ts              ← pure: quality score aggregation, threshold checks
  quality.test.ts
  merge-inputs.ts         ← pure: merge plan for combining analyze + wireframe outputs
  merge-inputs.test.ts
```

## Changes

### 1. Segment Registration — `src/segments/design/index.ts`

```typescript
const designSegment: SegmentDef = {
  id: "design",
  depends: ["analyze", "wireframe"],
  phases: [tokenPhase, layoutPhase, typographyPhase, colorPhase, motionPhase, qaPhase],
  mergeInputs: async (workdir, deps) => {
    // Plan computed by pure function, executed by IO
    const plan = buildMergePlan(deps);
    await executeMergePlan(workdir, plan);
  },
  extractOutput: async (workdir, outputDir) => { /* copy styled project + quality-scores.json */ }
};
registry.register(designSegment);
```

Import in `src/index.ts`: `import "./segments/design/index.js";`

### 2. Pure: Merge Input Planning — `src/segments/design/merge-inputs.ts`

```typescript
// Compute what needs to be copied where (pure plan, no IO)
export function buildMergePlan(
  deps: Record<string, string>
): MergePlan;

export interface MergePlan {
  copies: Array<{
    from: string;   // relative to dep output dir
    to: string;     // relative to workdir
    depId: string;
  }>;
  errors: string[]; // missing expected files
}

// Validate merge plan: all expected inputs present
export function validateMergePlan(
  plan: MergePlan,
  expectedAnalyzeOutputs: string[],
  expectedWireframeOutputs: string[]
): { valid: boolean; missing: string[] };
```

**Tests** (`src/segments/design/merge-inputs.test.ts`):
- `buildMergePlan`: correct copy entries for analyze (3 JSONs + patterns/) and wireframe (Astro project + manifests)
- `validateMergePlan`: all present → valid; missing `design-tokens.json` → reported

### 3. Pure: Token-to-CSS Conversion — `src/segments/design/tokens.ts`

```typescript
// Convert 7-layer design tokens to CSS custom properties
export function tokensToCssProperties(tokens: DesignTokensV2): CssPropertyMap;

export type CssPropertyMap = Record<string, string>;  // e.g., "--color-primary": "oklch(0.7 0.15 250)"

// Generate globals.css :root block from property map
export function generateRootBlock(properties: CssPropertyMap): string;

// Generate font loading declarations from token font families
export function generateFontDeclarations(
  fontFamilies: Record<string, string>
): { links: string[]; fontFaceRules: string[] };

// Map component manifest to Shadcn component names
export function mapToShadcnComponents(
  manifest: ComponentManifestOutput
): string[];

// Generate layers.css content
export function generateLayersFile(): string;

// Generate the import statement to add to Layout.astro
export function generateLayersImport(): string;
```

**Tests** (`src/segments/design/tokens.test.ts`):
- `tokensToCssProperties`: maps all 7 layers correctly
  - `atomic.colors.primary: "oklch(0.7 0.15 250)"` → `"--color-primary": "oklch(0.7 0.15 250)"`
  - `atomic.spacing.sm: "0.5rem"` → `"--spacing-sm": "0.5rem"`
  - `layout.breakpoints.md: "768px"` → `"--breakpoint-md": "768px"`
  - Handles nested token paths: `motion.duration.fast` → `"--motion-duration-fast"`
- `generateRootBlock`: produces valid CSS `:root { ... }` block with sorted properties
- `generateFontDeclarations`: Google Fonts → `<link>` tags; local fonts → `@font-face` rules
- `mapToShadcnComponents`: maps manifest component types to Shadcn names
- `generateLayersFile`: correct `@layer` declaration order
- `generateLayersImport`: correct `@import` statement

### 4. Pure: Color System — `src/segments/design/color.ts`

```typescript
// Generate :root and .dark CSS color variables from design tokens
export function generateColorSystem(
  colorTokens: DesignTokensV2["atomic"]["colors"],
  visualIdentity: DesignTokensV2["visualIdentity"]
): { light: CssPropertyMap; dark: CssPropertyMap };

// Check WCAG AA contrast ratio between two OKLCH colors
export function checkContrast(
  foreground: string,
  background: string
): { ratio: number; passesAA: boolean; passesAALarge: boolean };

// Find all failing contrast pairs in a color system
export function findContrastViolations(
  colorPairs: Array<{ foreground: string; background: string; context: string }>
): Array<{ context: string; ratio: number; required: number }>;

// Auto-fix a color to meet contrast ratio by adjusting OKLCH lightness
export function autoFixContrast(
  foreground: string,
  background: string,
  targetRatio: number
): { fixed: string; adjustment: number };

// Apply auto-fixes to a color system, returning adjusted map + changelog
export function applyContrastFixes(
  colorSystem: { light: CssPropertyMap; dark: CssPropertyMap },
  violations: ReturnType<typeof findContrastViolations>
): { fixed: { light: CssPropertyMap; dark: CssPropertyMap }; changes: string[] };
```

**Tests** (`src/segments/design/color.test.ts`):
- `generateColorSystem`: produces light + dark maps from tokens
- `checkContrast`: black on white → ~21:1, passes AA; light gray on white → ~1.5:1, fails
- `checkContrast`: OKLCH values correctly converted to relative luminance
- `findContrastViolations`: identifies specific failing pairs with context
- `autoFixContrast`: adjusts lightness to meet 4.5:1; preserves hue and chroma
- `autoFixContrast`: already-passing pair → no adjustment
- `applyContrastFixes`: applies fixes and produces human-readable changelog

### 5. Pure: CSS Layer Isolation — `src/segments/design/layers.ts`

```typescript
// Verify that file changes only touch the owned @layer
export function checkLayerIsolation(
  fileContents: Record<string, string>,
  ownedLayer: string,
  allLayers: string[]
): { isolated: boolean; violations: Array<{ file: string; line: number; layer: string; snippet: string }> };

// Check that a CSS file only writes within its owned @layer block
export function findLayerViolations(
  cssContent: string,
  ownedLayer: string,
  allLayers: string[]
): Array<{ line: number; layer: string; snippet: string }>;

// Verify @layer declaration order in layers.css
export function validateLayerOrder(
  layersContent: string,
  expectedOrder: string[]
): { valid: boolean; actual: string[]; expected: string[] };

// Check that properties outside @layer blocks belong to allowed categories
export function findUnlayeredProperties(
  cssContent: string
): Array<{ line: number; property: string; snippet: string }>;
```

**Tests** (`src/segments/design/layers.test.ts`):
- `checkLayerIsolation`: file writes only to `@layer layout` when owned is "layout" → isolated
- `checkLayerIsolation`: file writes to `@layer color` when owned is "layout" → violation with file+line+snippet
- `findLayerViolations`: `@layer layout { ... }` in layout phase → ok; `@layer typography { ... }` in layout phase → violation
- `validateLayerOrder`: correct order → valid; swapped → invalid with actual vs expected
- `findUnlayeredProperties`: CSS custom properties in `:root` → allowed; `color: red` outside any layer → flagged

### 6. Pure: Quality Scoring — `src/segments/design/quality.ts`

```typescript
// Aggregate dimension scores into overall quality score
export function computeOverallScore(
  dimensions: QualityScores["dimensions"]
): number;

// Check quality thresholds
export function checkQualityThresholds(
  scores: QualityScores,
  thresholds: { overall: number; perDimension?: number }
): { passes: boolean; failures: string[] };

// Check design fidelity thresholds
export function checkFidelityThresholds(
  fidelityScores: Record<string, number>,
  threshold: number
): { passes: boolean; failures: string[] };

// Compose final gate result from all Phase 6 checks
export function composeFinalGate(input: {
  buildSuccess: boolean;
  overflowFree: boolean;
  darkModeWorks: boolean;
  reducedMotionRespected: boolean;
  qualityScores: QualityScores;
  fidelityScores: Record<string, number>;
  layerIsolation: boolean;
  qualityThreshold: number;
  fidelityThreshold: number;
}): { passed: boolean; errors: string[] };
```

**Tests** (`src/segments/design/quality.test.ts`):
- `computeOverallScore`: average of 7 dimensions; all 8.0 → 8.0; mixed → weighted average
- `checkQualityThresholds`: overall 7.5 with threshold 7.0 → passes; overall 6.5 → fails
- `checkQualityThresholds`: per-dimension threshold check
- `checkFidelityThresholds`: all ≥0.6 → passes; one at 0.4 → fails with specific dimension
- `composeFinalGate`: all pass → passed; build failed → error; dark mode broken → error; multiple failures → all listed

### 7. IO Shell: Phase Definitions — `src/segments/design/phases.io.ts`

**Phase 1: Token Injection + Shadcn Setup**
- Step 1a (`programmaticStep`): reads `design-tokens.json` → `tokensToCssProperties()` → `generateRootBlock()` → writes `globals.css`; `generateLayersFile()` → writes `layers.css`; `generateLayersImport()` → patches Layout.astro
- Step 1b (`agentStep`): reads component manifest → `mapToShadcnComponents()` → agent runs `npx shadcn@latest add`
- Step 1c (`programmaticStep`): `generateFontDeclarations()` → patches Layout.astro `<head>`
- Step 1d (`programmaticStep`): runs `astro build` (IO), checks Shadcn files exist (IO), validates layers import

**Phase 2: Layout** (maxRetries: 3)
- Step 2a: global layout agent → writes to `@layer layout`
- Step 2b: fan-out per page type agent → writes to `@layer layout`
- Step 2c: Playwright screenshots (IO) + `checkLayerIsolation(files, "layout", allLayers)` (pure)

**Phase 3: Typography + Surfaces** (maxRetries: 3)
- Steps 3a-3c: agents for typography, Shadcn customization, surface treatment
- Step 3d: `checkLayerIsolation(files, "typography", ...)` + `checkLayerIsolation(files, "surfaces", ...)` + vision review

**Phase 4: Color + Dark Mode** (maxRetries: 2)
- Step 4a (`programmaticStep`): reads tokens → `generateColorSystem()` → writes to `@layer color` in globals.css
- Step 4b (`agentStep`): component color application + dark mode toggle
- Step 4c (`programmaticStep`): reads color pairs from generated CSS (IO) → `findContrastViolations()` → `applyContrastFixes()` → writes fixed CSS
- Step 4d: vision review (light + dark × 3 viewports) + `checkLayerIsolation(files, "color", ...)`

**Phase 5: Motion** (maxRetries: 2)
- Steps 5a-5b: agents for global motion + per-component states
- Step 5c: `checkLayerIsolation(files, "motion", ...)` + vision review

**Phase 6: Final Visual QA** (maxRetries: 3)
- Step 6a: all 4 reviewer types from plan 1
- Step 6b (`agentStep`): quality scoring → parse → writes `quality-scores.json`
- Step 6c (`agentStep`): fidelity scoring (vision) → appends to `quality-scores.json`
- Step 6d (`programmaticStep`): reads scores + runs build (IO) → `composeFinalGate()` (pure) → pass/reject

## Spec Adherence

| Requirement | Coverage |
|---|---|
| FR-6: Segment 3 — Design | Full — all 6 phases, pure logic extracted |
| FR-8: Segment Registration | Registered with `depends: ["analyze", "wireframe"]` |
| NFR-1: Linting | All files pass `bun run check` |
| NFR-3: Unit Testing | High coverage: tokens, color, layers, quality, merge-inputs |
| NFR-8: Invariant Checking | Layer isolation enforced at every phase gate |
| NFR-10: Performance | Fan-out capped by semaphore |
| NFR-12: Accessibility | WCAG contrast validation + pure auto-fix |
| NFR-13: CSS Layer Isolation | Pure `checkLayerIsolation` at every gate |
| NFR-14: Retry Semantics | Layout: 3, Typography: 3, Color: 2, Motion: 2, QA: 3 |

## Acceptance Criteria

### Functional Checks
- `bun src/index.ts list` shows design with `depends: ["analyze", "wireframe"]`, 6 phases
- `buildMergePlan` correctly maps analyze + wireframe outputs
- `tokensToCssProperties` converts all 7 token layers to CSS custom properties
- `generateColorSystem` produces light + dark maps
- `checkContrast` correctly computes WCAG ratio from OKLCH values
- `autoFixContrast` adjusts lightness to meet target ratio without changing hue
- `checkLayerIsolation` detects cross-layer violations with file + line + snippet
- `composeFinalGate` correctly evaluates all sub-checks
- Phase gates reject when layer isolation broken; retries with context

### Non-Functional Checks
- `bun run check` passes clean
- Unit tests pass: tokens.test.ts, color.test.ts, layers.test.ts, quality.test.ts, merge-inputs.test.ts
- Coverage >90% on pure modules
- WCAG AA contrast met for all generated color pairs

## Validation Approach

- **Immediate automated**: `bun run check` clean; `bun test` on design pure modules; WCAG contrast unit tests with known color pairs
- **Manual immediate**: Run design with pre-computed analyze + wireframe outputs; inspect styled site at 3 viewports; verify dark mode; spot-check quality scores
- **Manual post-release**: Full 3-segment pipeline run; visual comparison against reference

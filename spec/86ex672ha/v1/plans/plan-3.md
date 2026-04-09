# Plan 3: Wireframe Segment — Unstyled Astro Project Generation

## Overview

Implement the wireframe segment (FR-5) that transforms scraper output into a working unstyled Astro project. Heavy on programmatic data transforms (reduce, classify cross-validation, transform+seed, final validation) — all extracted as pure functions with high unit test coverage. IO shell handles file reads/writes, image downloads, agent calls, and process execution.

## Architecture: Pure Core / IO Shell

```
src/segments/wireframe/
  index.ts                ← segment registration
  phases.io.ts            ← IO shell: step definitions
  reduce.ts               ← pure: grouping, sampling, link rewriting, manifest building
  reduce.test.ts
  classify.ts             ← pure: cross-validation, conflict detection, merge logic
  classify.test.ts
  seed.ts                 ← pure: content collection generation, Zod schema codegen, route generation
  seed.test.ts
  wireframe-validate.ts   ← pure: final validation checks (content coverage, asset integrity, etc.)
  wireframe-validate.test.ts
```

## Changes

### 1. Segment Registration — `src/segments/wireframe/index.ts`

```typescript
const wireframeSegment: SegmentDef = {
  id: "wireframe",
  depends: [],
  phases: [reducePhase, classifyPhase, seedPhase, generatePhase, validatePhase],
  mergeInputs: async () => {},
  extractOutput: async (workdir, outputDir) => { /* copy Astro project + JSON manifests */ }
};
registry.register(wireframeSegment);
```

Import in `src/index.ts`: `import "./segments/wireframe/index.js";`

### 2. Pure: Reduce Logic — `src/segments/wireframe/reduce.ts`

```typescript
// Group pages by pagetype, count instances
export function groupByPageType(
  pages: PageStructure[]
): Map<string, PageStructure[]>;

// Select richest + simplest sample per type (by content key count)
export function selectSamples(
  grouped: Map<string, PageStructure[]>,
  contentByPageId: Map<string, PageContent>
): Map<string, { richest: PageContent; simplest: PageContent }>;

// Build content-addressed filename from URL (SHA256 hash)
export function contentAddressedName(url: string, ext: string): string;

// Build asset manifest from content pages (original URL → local path)
export function buildAssetManifest(
  pages: PageContent[],
  imageUrls: string[]
): Record<string, string>;

// Rewrite internal links to relative Astro routes
export function rewriteInternalLinks(
  content: Record<string, unknown>,
  siteUrl: string,
  routeMap: Map<string, string>
): Record<string, unknown>;

// Classify URLs: internal, external, CMS-specific
export function classifyUrls(
  urls: string[],
  siteUrl: string,
  cmsPatterns?: string[]
): { internal: string[]; external: string[]; cms: string[] };

// Build reduced directory structure (returns a virtual file tree, not written to disk)
export function buildReducedTree(
  samples: Map<string, { richest: PageContent; simplest: PageContent }>,
  rewrittenContent: Map<string, Record<string, unknown>>,
  assetManifest: Record<string, string>
): Array<{ path: string; content: string }>;
```

**Tests** (`src/segments/wireframe/reduce.test.ts`):
- `groupByPageType`: 5 pages with 3 types → correct grouping
- `selectSamples`: richest = most keys, simplest = fewest keys; tie-breaking deterministic
- `contentAddressedName`: stable hash, correct extension; same URL → same name
- `buildAssetManifest`: extracts image URLs from nested content; deduplicates
- `rewriteInternalLinks`: `https://original.com/about` → `/about`; external links preserved; nested objects traversed
- `classifyUrls`: mixes of internal/external/CMS → correct buckets
- `buildReducedTree`: correct file paths and content serialization

### 3. Pure: Classify Logic — `src/segments/wireframe/classify.ts`

```typescript
// Cross-validate classifier outputs: all page types exist, relationships resolve
export function crossValidateClassifiers(
  architecture: ArchitectureClassification,
  contentModel: ContentModelClassification,
  interaction: InteractionClassification,
  knownPageTypes: string[]
): { valid: boolean; errors: string[] };

// Detect conflicts between classifier outputs
export function detectConflicts(
  architecture: ArchitectureClassification,
  contentModel: ContentModelClassification
): ConflictReport;

// Validate route patterns don't conflict
export function validateRoutePatterns(
  routes: Array<{ pattern: string; pageType: string }>
): { valid: boolean; conflicts: Array<{ a: string; b: string; reason: string }> };

// Validate registry completeness: every page type accounted for
export function validateRegistryCompleteness(
  registry: Registry,
  knownPageTypes: string[]
): { covered: string[]; missing: string[] };

// Validate content-model references: all collections/listings reference valid entities
export function validateContentModelRefs(
  contentModel: ContentModelOutput,
  registry: Registry
): { valid: boolean; orphans: string[] };

// Validate component-manifest references
export function validateComponentManifestRefs(
  manifest: ComponentManifestOutput,
  registry: Registry,
  contentModel: ContentModelOutput
): { valid: boolean; orphans: string[] };
```

**Tests** (`src/segments/wireframe/classify.test.ts`):
- `crossValidateClassifiers`: all types present → valid; missing type → specific error
- `detectConflicts`: same page type different layout → conflict reported
- `validateRoutePatterns`: `/blog/[slug]` and `/blog/[id]` → conflict; `/blog/[slug]` and `/about` → ok
- `validateRegistryCompleteness`: all covered → []; missing "contact" → reported
- `validateContentModelRefs`: orphan collection → reported; all refs resolve → valid
- `validateComponentManifestRefs`: component references missing collection → reported

### 4. Pure: Seed Logic — `src/segments/wireframe/seed.ts`

```typescript
// Generate Astro content collection file entries from registry + content
export function generateCollectionEntries(
  registry: Registry,
  contentModel: ContentModelOutput,
  pageContents: PageContent[]
): Array<{ path: string; content: string; format: "md" | "json" }>;

// Generate singleton/global data files
export function generateGlobals(
  contentModel: ContentModelOutput,
  pageContents: PageContent[]
): Array<{ path: string; content: string }>;

// Generate content.config.ts source code (Zod schemas + loaders)
export function generateContentConfig(
  registry: Registry,
  contentModel: ContentModelOutput
): string;

// Generate route files (src/pages/*.astro) from registry
export function generateRouteFiles(
  registry: Registry
): Array<{ path: string; content: string }>;

// Validate seed completeness: every source page accounted for
export function validateSeedCompleteness(
  sourcePages: PageContent[],
  generatedEntries: Array<{ path: string }>
): { complete: boolean; missing: string[] };
```

**Tests** (`src/segments/wireframe/seed.test.ts`):
- `generateCollectionEntries`: blog type with 5 pages → 5 entries with correct frontmatter
- `generateGlobals`: site-wide data → `src/data/` files
- `generateContentConfig`: produces valid TypeScript with `defineCollection`, `glob()`, `file()` (Astro v6 API)
- `generateRouteFiles`: `/blog/[slug]` → `src/pages/blog/[slug].astro`; static routes → static files
- `validateSeedCompleteness`: all accounted → complete; missing page → listed

### 5. Pure: Wireframe Validation — `src/segments/wireframe/wireframe-validate.ts`

```typescript
// Composite validation for wireframe Phase 5
export function validateWireframeOutput(input: {
  sourcePages: PageContent[];
  generatedRoutes: string[];
  assetManifest: Record<string, string>;
  existingImageFiles: string[];
  componentFileContents: Record<string, string>;
  astroFileContents: Record<string, string>;
  originalSiteUrl: string;
  pagefindExists: boolean;
}): { valid: boolean; errors: string[] };
```

Internally calls from `src/lib/validators.ts`:
- `validateContentCoverage(sourcePages, generatedRoutes)`
- `validateAssetIntegrity(assetManifest, existingImageFiles)`
- `findLeakedAbsoluteUrls(astroFileContents, originalSiteUrl)`
- `findTailwindClasses(componentFileContents)`
- Checks `pagefindExists`

**Tests** (`src/segments/wireframe/wireframe-validate.test.ts`):
- All checks pass → `{ valid: true, errors: [] }`
- Missing route → error about content coverage
- Missing image → error about asset integrity
- Leaked absolute URL → error with file + line
- Tailwind class in component → error with file + line + classes
- No pagefind dir → error
- Multiple failures → all errors collected

### 6. IO Shell: Phase Definitions — `src/segments/wireframe/phases.io.ts`

**Phase 1: Reduce**
- `programmaticStep`: reads `structure.json`, `schema.json`, `content.json` → calls `groupByPageType()`, `selectSamples()`, `buildAssetManifest()`, `rewriteInternalLinks()`, `buildReducedTree()` → downloads images (IO) → writes `reduced/` + `asset-manifest.json`

**Phase 2: Classify**
- Step 2a: spawns 3 parallel `agentQuery` calls for architecture/content/interaction classifiers
- Step 2b: `programmaticStep` calls `crossValidateClassifiers()`, `validateRoutePatterns()`
- Step 2c: `reviewerStep` for semantic consistency
- Steps 2d-1 through 2d-5: sequential agent steps for incremental merge, with `programmaticStep` for cross-validation (2d-4) calling `validateRegistryCompleteness()`, `validateContentModelRefs()`, `validateComponentManifestRefs()`
- Step 2d-5: conflict resolution agent only if 2d-4 found issues

**Phase 3: Transform + Seed**
- `programmaticStep`: copies template, calls `generateCollectionEntries()`, `generateGlobals()`, `generateContentConfig()`, `generateRouteFiles()`, `validateSeedCompleteness()` → writes all files to workdir

**Phase 4: Generate Wireframe**
- Steps 4a-4d: agent steps for components, layouts, page stubs, content fill
- Step 4e: two-pass reviewers from plan 1 (`staticChecksReviewer`, `consoleErrorReviewer`, `visionReviewer`, `traceReviewer`)

**Phase 5: Final Validation**
- `programmaticStep`: runs `astro build`, `bun run check`, `lychee dist/` (IO), then reads generated files and calls `validateWireframeOutput()` (pure) with results → pass/reject

## Spec Adherence

| Requirement | Coverage |
|---|---|
| FR-5: Segment 2 — Wireframe | Full — all 5 phases, pure logic extracted |
| FR-8: Segment Registration | Registered, appears in `list` |
| NFR-1: Linting | All files pass `bun run check` |
| NFR-3: Unit Testing | High coverage: reduce, classify, seed, wireframe-validate |
| NFR-5: E2E Testing | Phase 5 is comprehensive E2E gate |
| NFR-8: Invariant Checking | Content coverage, asset integrity, no absolute URLs, no Tailwind |
| NFR-10: Performance | Fan-out capped by semaphore |
| NFR-14: Retry Semantics | Phase 2: maxRetries 2, Phase 4: maxRetries 3, Phase 5: maxRetries 2 |
| NFR-15: Fan-out Step Support | Phase 2a (3 classifiers), Phase 4a (per-component), Phase 4d (per-page-type) |

## Acceptance Criteria

### Functional Checks
- `bun src/index.ts list` shows wireframe with 5 phases
- `groupByPageType` / `selectSamples`: correct grouping and richest/simplest selection
- `rewriteInternalLinks`: internal → relative, external preserved, nested traversal
- `crossValidateClassifiers`: catches missing types and conflicting routes
- `generateContentConfig`: produces valid Astro v6 TypeScript
- `validateWireframeOutput`: catches all 5 failure modes (coverage, assets, URLs, Tailwind, pagefind)
- Phase 5 gate rejects if any check fails

### Non-Functional Checks
- `bun run check` passes clean
- Unit tests pass: reduce.test.ts, classify.test.ts, seed.test.ts, wireframe-validate.test.ts
- Coverage >90% on pure modules
- Generated Astro project passes `bun run check`

## Validation Approach

- **Immediate automated**: `bun run check` clean; `bun test` on wireframe pure modules
- **Manual immediate**: Run wireframe against `example/` input; inspect generated project structure
- **Post-release**: Full pipeline combining wireframe + analyze into design segment

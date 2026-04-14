# Wireframe Segment Spec

> **Purpose:** Generate a working unstyled Astro project from the classified content model.
> **Depends:** `["classify"]`
> **Status:** Architecture finalized. Ready for implementation.

---

## 1. Position in Pipeline

```
analyze  ──────────────────────────┐
                                   ├──► design
prepare ──► classify ──► wireframe ─┘
```

`wireframe` receives all classify + prepare outputs. It produces a complete, buildable Astro project with all CMS content rendered — unstyled, semantic HTML only.

---

## 2. Input / Output

**Input:** All classify + prepare outputs + Astro template:

From prepare:
- `pages.json` — flat page list with resolved schemas
- `page-type-meta.json` — page type names, final URL patterns, counts, all URLs
- `prepared-content.json` — all content with final URLs + localized images
- `asset-manifest.json` — original image URL → local path

From classify:
- `registry.json` — page types classified as singleton/collection/listing with listing pairings
- `globals.json` — global content with canonical content
- `shared-components.json` — shared content blocks with interaction types
- `field-classifications.json` — per-field type classification across all scopes
- `render-maps.json` — richtext field → HTML element mappings
- `content-model-classified.json` — enriched with ComposeNode trees
- `content-model.json` — CMS CollectionDefs with typed FieldDefs

From template:
- `template/astro-project/` — base Astro template (React, Tailwind v4, Shadcn, Biome)

**Output:** Complete Astro project in `project/` directory.

---

## 3. Design Principles

1. **Every AI step that can be validated programmatically, must be.** Static checks (`bun run check` + `astro build`) gate every AI phase.
2. **Fork isolation.** One page type's failure doesn't contaminate others. Each page type gets its own agent in Phase 4.
3. **Content-gate is a hard assertion.** If all upstream phases pass, the final content gate should hold. Failure means a pipeline bug — no recovery.
4. **Unstyled, semantic HTML.** Wireframe produces structure only. Design segment adds visual styling later.

---

## 4. Phases

```
Phase 1: seed                 (programmatic)
Phase 2: generate-layouts     (agent + static checks)
Phase 3: generate-components  (agent fan-out + static checks)
Phase 4: generate-pages       (agent fork per page + static checks + LLM content judge)
Phase 5: content-gate         (fuzzy match + LLM judge — hard fail, no recovery)
```

3 AI phases (2, 3, 4). 2 programmatic (1, 5).

---

## 5. Phase Definitions

### Phase 1: seed

**Type:** Programmatic | **maxRetries:** 0

Generates Astro project scaffold from classify output:
- Content collections (`src/content/{collection}/{slug}.json`)
- Global data files (navigation, header, site metadata)
- `src/content.config.ts` with Zod schemas
- Route files at final paths (`src/pages/blogs/[slug].astro`, not `src/pages/[slug].astro`)
- Component manifest (which components to generate, mapped to collections + interaction types)
- Copies downloaded images to `project/public/images/`

Uses final URL patterns from `page-type-meta.json` (set by prepare) and page type
classifications from `registry.json` (set by classify).

**On failure:** Hard fail.

---

### Phase 2: generate-layouts

**Type:** Agent + static checks | **maxRetries:** 3

Agent generates layout files (`src/layouts/`):
- Base layout with global content slots (header, footer, nav)
- Page-type-specific layouts if needed
- Semantic HTML, no styles

**Gate:** `bun run check` + `astro build` must pass.

---

### Phase 3: generate-components

**Type:** Agent fan-out + static checks | **maxRetries:** 3

One agent per component category:
- Navigation, header, footer (from globals)
- Shared components (booking_cta, testimonials, etc.)
- Collection cards (for listing pages)
- Content blocks (for detail pages)
- Interactive components (carousel, accordion, tabs, search)

**Gate:** `bun run check` + `astro build` must pass.

---

### Phase 4: generate-pages

**Type:** Agent fork per page type + static checks + LLM content judge | **maxRetries:** 3

One agent per page type generates page route files:
- Import and compose components + layouts
- Wire content queries (`getCollection`, `getStaticPaths`)
- Handle listing pagination
- Ensure ALL CMS content is rendered

**Two gates:**
1. Static checks: `bun run check` + `astro build`
2. LLM content judge: verifies every CMS field is referenced in the template

Fork isolation — one page type's failure doesn't contaminate others.

---

### Phase 5: content-gate

**Type:** Fuzzy match + LLM judge | **maxRetries:** 0 (hard fail — no recovery)

Pipeline-level assertion:
1. `astro build`
2. Playwright visits every route
3. Extract rendered text from DOM
4. Fuzzy match against source content (90% threshold, images exempt)
5. LLM judge for borderline cases

**On failure:** Hard fail. Pipeline bug — needs investigation, not retry.

---

## 6. Data Flow

```
FROM PREPARE:
  pages.json, page-type-meta.json, prepared-content.json, asset-manifest.json

FROM CLASSIFY:
  registry.json, globals.json, shared-components.json,
  field-classifications.json, render-maps.json,
  content-model-classified.json, content-model.json

FROM TEMPLATE:
  template/astro-project/
                    │
                    ▼

Phase 1:  seed ─────────────────► Astro project scaffold (final routes from page-type-meta)
          │
Phase 2:  generate-layouts ─────► Layout .astro files (+ static checks)
          │
Phase 3:  generate-components ──► Component .astro files (+ static checks)
          │
Phase 4:  generate-pages ───────► Page route files (+ static checks + LLM judge)
          │  (fork per page type)
          │
Phase 5:  content-gate ─────────► PASS or HARD FAIL (no recovery)
          │
          ▼
      project/ (complete Astro project)
```

---

## 7. Retry Flow

| Phase | maxRetries | On failure |
|-------|-----------|------------|
| 1: seed | 0 | Hard fail (deterministic) |
| 2: generate-layouts | 3 | Retry with build errors |
| 3: generate-components | 3 | Retry with build errors per component |
| 4: generate-pages | 3 | Retry with per-page-type rejection |
| 5: content-gate | 0 | Hard fail — pipeline bug, no recovery |

---

## 8. Files to Create / Modify

### Modified files

| File | Changes |
|------|---------|
| `src/segments/wireframe/index.ts` | `depends: ["classify"]`, updated phase list |
| `src/segments/wireframe/phases.io.ts` | Replace old phases with 5 new phases |
| `src/segments/wireframe/seed.ts` | Consume classify + prepare output, use final routes from page-type-meta |
| `src/segments/wireframe/content-model.ts` | Types shared, composition engine used by classify too |

### Files NOT changed

| File | Reason |
|------|--------|
| `src/engine/*` | Engine handles all segment/phase/step contracts as-is |
| `src/steps/step.ts` | Existing step builders work |
| `template/astro-project/cms/adapter.ts` | CMS adapter types already sufficient |
| `template/astro-project/cms/sonicjs.ts` | Push/pull implementation already works |

---

## 9. Implementation Order

1. **Update wireframe/index.ts** — `depends: ["classify"]`
2. **Phase 1: seed** — consume prepare + classify output, use final routes from page-type-meta
3. **Phase 2: generate-layouts** — agent + static checks
4. **Phase 3: generate-components** — fan-out + static checks
5. **Phase 4: generate-pages** — fork per page type + static checks + LLM judge
6. **Phase 5: content-gate** — fuzzy match + LLM judge (hard fail)
7. **Run full pipeline** — end-to-end convergence

---

## 10. What Was Explicitly Ruled Out

| Approach | Why rejected |
|----------|-------------|
| Content-gate as retry loop | Pipeline bug, not recoverable |
| Single monolithic generate phase | Layout → components → pages must be sequential |

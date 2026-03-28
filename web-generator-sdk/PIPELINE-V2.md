# Pipeline Architecture v2

## Definition of Done (Per Phase — Generated Site)

A phase is **complete** when ALL of the following are true:

1. **Implementation delivered** — the implementer has written all required output files for this phase
2. **Evidence folder populated** — `evidence/` contains all required artifacts (see Per-Phase Evidence below)
3. **All reviewers pass** — every reviewer in `reviews/` for this phase has approved, no rejections
4. **Generated project passes build** — the template/project builds without errors at this phase boundary
5. **Review folder deleted** — after all reviewers pass, `reviews/` is deleted so fixed issues don't persist across phases

On any reviewer rejection: loop back to the implementer with the rejection context. Up to 3 retries per phase.

---

## Definition of Done (This Spec — SDK Implementation)

This spec (`PIPELINE-V2.md`) is **implemented** when ALL of the following are true:

1. **`bun run typecheck` passes** — SDK has no TypeScript errors
2. **`bun run build` succeeds** — SDK builds without errors (output to `dist/`)
3. **`bun src/index.ts --help` or 10s smoke test passes** — the pipeline runner starts and runs for ≥10s without crashing or throwing unhandled errors to stdout; actual full pipeline execution is validated by evidence/reviewer loop
4. **All pipeline steps orchestrated** — `src/steps/` contains all step implementations (analyze, reduce, classify, seed, layout, design, color, motion, polish) wired into the runner
5. **Evidence folder spec implemented** — `src/` has code/prompts that produce `evidence/` with all required artifacts (biome.json, astro-check.json, build.json, console-errors.json, broken-links.json, broken-images.json, screenshots/, page-links.json, responsive.json) for every phase step
6. **Reviewer agents spec implemented** — `src/` has prompts/code that spawn reviewer agents, each writing its own `reviews/reviewer-X.md` verdict file, with semaphore-controlled parallelism (max 5 concurrent)
7. **Per-phase reviewer matrix implemented** — the correct reviewers are called for each phase (Phase-Specific × 2 models + Generic × 2 models)
8. **Generic reviewer implemented** — runs `npm run check` (biome + astro check + knip) against the generated project; `npm run build` also available as standalone build check
9. **Phase-specific reviewer implemented** — runs the phase-specific checklist for each phase (M1 + M2, same checklist, different models)
10. **Loop-back implemented** — on any reviewer rejection, control returns to the implementer with rejection context; up to 3 retries per phase
11. **Review folder cleanup implemented** — after all reviewers pass, `reviews/` is deleted
12. **`reviewer-quality-score` implemented** — produces 7-dimension quality scores (≥ 8.5 overall threshold)
13. **`reviewer-fingerprint-fidelity` implemented** — cosine similarity check against style fingerprint dimensions (≤ 0.2 divergence)
14. **Per-page reviewers implemented** — links, images, console errors, responsive: one reviewer agent per page per check type
15. **Visual regression checks implemented** — screenshots per phase, compare against previous phase

The SDK repo itself (`web-generator-sdk`) must always pass `bun run typecheck` and `bun run build` as baseline health checks.

---

## What Makes This Much Better

### Current Pipeline Problems

1. **Monolithic codegen** — layout, content, styling, and color all happen in one step. A color fix can break layout.
2. **Flat tokens** — only atomic CSS values. No understanding of how values *compose* (a button is not just a color, it's a recipe).
3. **No style awareness** — the pipeline doesn't know if the reference site is minimalist, brutalist, or corporate. It treats all sites the same.
4. **String interpolation handoffs** — data passes between steps as truncated text blobs (15k char limit). No structured contracts.
5. **No independent validation** — can't validate layout without color, can't fix animation without risking layout regression.
6. **Design brief is prose** — `designDirection` is a text blob, not structured/consumable by codegen.
7. **No motion extraction** — zero animation, hover, or easing information captured.

### v2 Improvements

| Problem | v2 Solution |
|---------|-------------|
| Monolithic codegen | 7 independent phases, each with its own validator |
| Flat tokens | 7-layer token architecture (atomic → gradients → layout → recipes → states → motion → identity) |
| No style awareness | Style fingerprint extracted in Phase 0, drives all downstream decisions |
| String handoffs | Structured JSON files between every phase |
| No independent validation | Phase-specific linters + approval gates |
| Prose design brief | Structured output per phase, consumable by codegen |
| No motion | Dedicated Phase 6 for animation, easing, interaction states |

---

## Pipeline Overview

```
                         EXTERNAL                           THIS SDK
                         ─────────                           ────────

structure.json ──────────┐
schema.json   ──────────┼──────┐
content.json  ──────────┘      │
                               ▼
reference URL ─────────────────┼──► Phase 0: ANALYZE
                               │    ├── Extract style fingerprint
                               │    ├── Extract 7-layer design tokens
                               │    ├── Extract component recipes
                               │    └── Output: style-fingerprint.json
                               │             design-tokens.json (layered)
                               │             component-recipes.json
                               │    ✅ Gate: tokens valid, style classified
                               │
                               ▼
                        Phase 1: STRUCTURE
                               │    ├── 1a REDUCE (code): group, detect, sample
                               │    │   Output: reduced/meta.json, types/, global/
                               │    │   ✅ Gate: sum(counts) === total_pages
                               │    │
                               │    ├── 1b CLASSIFY (AI): collections, routing, layouts
                               │    │   Output: reduced/registry.json
                               │    │   ✅ Gate: no orphan page types
                               │    │
                               │    └── 1c SEED (code): write content collections
                               │        Output: src/content/<collection>/*.json
                               │                 src/data/static-pages.json
                               │        ✅ Gate: all 100 pages represented
                               │
                               ▼
                        Phase 2: LAYOUT
                               │    ├── Grid/flex structure
                               │    ├── Section spacing, vertical rhythm
                               │    ├── Responsive breakpoints (375/768/1280)
                               │    ├── Container widths, density
                               │    └── Gray-box wireframes (no color)
                               │    ✅ Gate: responsive at all breakpoints
                               │
                               ▼
                        Phase 3: DESIGN
                               │    ├── Typography (fonts, scale, hierarchy)
                               │    ├── Component styling (radius, shadows, cards)
                               │    ├── Surface treatment (gradients, glass, textures)
                               │    ├── Component variants (button primary/secondary/ghost)
                               │    └── Neutral palette (grays only)
                               │    ✅ Gate: components render, no visual regressions
                               │
                               ▼
                        Phase 4: COLOR
                               │    ├── Apply token colors → CSS variables
                               │    ├── Theme system (light + dark)
                               │    ├── Contrast validation (WCAG 4.5:1+)
                               │    └── Visual weight distribution
                               │    ✅ Gate: WCAG contrast, dark mode works
                               │
                               ▼
                        Phase 5: MOTION
                               │    ├── Hover/focus/active/disabled states
                               │    ├── Transition durations + easing curves
                               │    ├── Scroll reveals, staggered animations
                               │    └── prefers-reduced-motion support
                               │    ✅ Gate: no jank, reduced-motion respected
                               │
                               ▼
                        Phase 6: POLISH
                               ├── Cross-browser check
                               ├── Full build validation
                               ├── Quality scoring
                               └── ✅ Done
```

---

## Phase 0: ANALYZE

**Purpose:** Understand what we're building *before* writing any code.

### What it does

Runs a Playwright script against the reference URL to extract:

1. **Style fingerprint** — classifies the site's visual personality
2. **7-layer design tokens** — structured token set, not flat values
3. **Component recipes** — how CSS properties combine per component type

### Outputs

```
style-fingerprint.json      ← from DESIGN-STYLE-CLASSIFICATION.md research
design-tokens.json          ← from DESIGN-TOKEN-RESEARCH.md 7-layer architecture
component-recipes.json      ← component-level style bundles
```

### style-fingerprint.json

```json
{
  "$schema": "style-fingerprint/v1",
  "style": {
    "primary": "minimalist",
    "secondary": ["glassmorphism"],
    "dimensions": {
      "ornament": 0.15,
      "playfulness": 0.30,
      "warmth": 0.55,
      "density": 0.25,
      "motion": 0.40,
      "depth": 0.60,
      "darkness": 0.20,
      "formality": 0.70
    },
    "treatments": {
      "surface": "frosted-glass",
      "corners": "rounded-large",
      "shadows": "layered-soft",
      "borders": "subtle",
      "gradients": "background-subtle",
      "blur": true,
      "transparency": true,
      "animation_style": "spring-gentle"
    }
  },
  "confidence": 0.85
}
```

### design-tokens.json (7-layer)

```json
{
  "atomic": {
    "colors": { "primary": "...", "background": "...", "foreground": "..." },
    "typography": { "fontFamily": {...}, "fontSize": {...}, "fontWeight": {...} },
    "spacing": { "xs": "4px", "sm": "8px", "md": "16px", "lg": "24px", "xl": "32px" },
    "borderRadius": { "sm": "4px", "md": "8px", "lg": "16px", "full": "9999px" },
    "shadows": { "sm": "...", "md": "...", "lg": "..." }
  },
  "gradients": {
    "hero-primary": { "type": "linear", "angle": "135deg", "stops": [...] },
    "surface": { "type": "radial", "stops": [...] }
  },
  "layout": {
    "grid": { "columns": {...}, "gutter": {...} },
    "container": { "maxWidth": {"narrow": "720px", "default": "1200px"} },
    "breakpoints": { "sm": "640px", "md": "768px", "lg": "1024px", "xl": "1280px" },
    "sections": { "hero": {"top": "96px", "bottom": "80px"}, "default": {...} },
    "density": { "mode": "comfortable" },
    "rhythm": { "baseUnit": "8px", "verticalRhythm": {...} }
  },
  "componentSpacing": {
    "inset": {...},
    "insetSquish": {...},
    "insetStretch": {...},
    "stack": {...},
    "inline": {...},
    "grid": {...}
  },
  "motion": {
    "duration": { "instant": "50ms", "fast": "150ms", "base": "200ms", "moderate": "300ms" },
    "easing": { "default": "...", "out": "...", "brand": "..." },
    "state": { "hover": {...}, "focus": {...}, "active": {...}, "disabled": {...} },
    "scroll": { "reveal": {...} },
    "skeleton": {...}
  },
  "surfaces": {
    "glass": { "panel": {...}, "panel-dark": {...} },
    "texture": { "grain-subtle": {...} },
    "imageTreatment": { "card": {...}, "avatar": {...} }
  },
  "visualIdentity": {
    "colorDistribution": { "dominant": {...}, "secondary": {...}, "accent": {...} },
    "borders": { "default": {...}, "subtle": {...}, "divider": {...} }
  }
}
```

### component-recipes.json

```json
{
  "button": {
    "base": {
      "paddingX": "20px", "paddingY": "8px",
      "fontWeight": "600", "borderRadius": "9999px",
      "fontSize": "14px", "lineHeight": "1.25"
    },
    "variants": {
      "primary": { "bg": "token:primary", "color": "token:on-primary", "shadow": "sm" },
      "secondary": { "bg": "transparent", "border": "1px solid token:border", "color": "token:text" },
      "ghost": { "bg": "transparent", "color": "token:text" },
      "destructive": { "bg": "token:destructive", "color": "token:white" },
      "link": { "bg": "transparent", "color": "token:primary", "underline": true }
    },
    "states": {
      "hover": { "transform": "translateY(-1px)", "shadow": "md" },
      "focus": { "ring": "2px token:focus-ring", "ringOffset": "2px" },
      "active": { "transform": "scale(0.98)", "shadow": "none" },
      "disabled": { "opacity": "0.5", "cursor": "not-allowed" }
    }
  },
  "card": {
    "base": { "padding": "24px", "borderRadius": "token:radius-lg" },
    "variants": {
      "elevated": { "shadow": "token:shadow-md", "border": "none" },
      "outlined": { "border": "1px solid token:border", "shadow": "none" },
      "filled": { "bg": "token:muted", "border": "none" }
    },
    "states": {
      "hover": { "transform": "translateY(-2px)", "shadow": "token:shadow-lg" }
    }
  },
  "navigation": {
    "sticky": { "position": "sticky", "backdropBlur": "12px", "bg": "rgba(255,255,255,0.8)" },
    "mobileMenu": "slide-drawer",
    "activeIndicator": "background-highlight"
  },
  "input": {
    "height": "44px", "paddingX": "12px",
    "border": "1px solid token:border", "borderRadius": "token:radius-md",
    "focus": { "ring": "2px token:focus-ring", "shadow": "0 0 0 3px rgba(token:primary, 0.1)" },
    "error": { "border": "token:destructive", "label": "token:destructive" }
  },
  "badge": {
    "base": { "paddingX": "12px", "paddingY": "4px", "fontSize": "12px", "fontWeight": "500" },
    "variants": {
      "default": { "bg": "token:muted", "color": "token:text" },
      "primary": { "bg": "token:primary", "color": "token:on-primary" }
    }
  }
}
```

### Validation & Fix

**Reviewers:** `reviewer-json-validity`, `reviewer-token-completeness`, `reviewer-style-confidence`, `reviewer-phase-specific-M1`, `reviewer-phase-specific-M2`, `reviewer-generic-M1`, `reviewer-generic-M2`

**Phase-specific checklist (M1 + M2):**
- Style fingerprint has a primary category with confidence > 0.6
- All 7 token layers have non-empty values (no null/undefined)
- Component recipes have `base` + at least 2 `variants`
- All color values are valid CSS (parseable by CSS.supports or color parser)
- `prefers-reduced-motion` plan exists if `motion.dimension > 0.5`
- JSON files are valid (JSON.parse succeeds on all 3 outputs)

**On any reviewer rejection:** Implementer re-runs extraction with error context, up to 3 retries. If still failing, fall back to default tokens + "minimalist" style fingerprint.

---

## Phase 1: STRUCTURE

**Purpose:** Transform raw scraper output (2.1M) into a reduced, classified package (~50-100K) that AI steps can reason about without truncation. Then seed Astro content collections so every page renders with correct content.

**Why this phase exists:** The current pipeline truncates `structure.json` to 15K chars, `schema.json` to 15K chars, and `content.json` to 15K chars before feeding to AI. This means the AI never sees the full picture. Phase 1 solves this by: (1) programmatically reducing the data, (2) having AI classify the architecture, (3) seeding Astro content collections so downstream steps work with proper `[slug]` routing and `getStaticPaths()` instead of a flat `content.json` blob.

### Phase 1a: REDUCE (Code — No AI)

**Purpose:** Programmatic reduction of raw scraper output into a per-page-type package.

#### What it does

1. **Group** all content entries by `pagetype`
2. **Detect** multi vs single — `count > 1` means multi
3. **Extract route patterns** — normalize `{slug}` → `[slug]`, `{page}` → `[page]`
4. **Detect global chrome** — schema keys present in >90% of page types (e.g., `header`, `footer`, `floating_widgets`)
5. **Compute own sections** — `schema_keys - global_keys` (page-type-specific content)
6. **Detect pagination** — schema has `pagination` property OR URL has `{page}` param
7. **Pick samples** — per type: richest (most non-null leaf fields) + simplest (fewest)
8. **Extract global content** — navigation, footer, floating_widgets from landing page

#### Input

```
structure.json          ← scraper output (73K)
schema.json             ← scraper output (136K)
content.json            ← scraper output (1.9M)
```

#### Output

```
<step>/output/reduced/
  meta.json                        ← page type registry
  global/
    navigation.json                ← extracted from landing page content
    footer.json                    ← extracted from landing page content
    floating_widgets.json          ← if present on >90% of page types
  types/
    landing/
      schema.json                  ← copied from schema.json["landing"]
      samples/
        richest.json               ← instance with most non-null leaf fields
        simplest.json              ← instance with fewest
    doctor_profile/
      schema.json
      samples/
        richest.json
        simplest.json
    ... (one directory per pagetype)
```

#### meta.json format

```jsonc
{
  "source": {
    "total_pages": 100,
    "page_types": 13,
    "scraped_at": "2026-03-03T15:15:59.216Z",
    "site_url": "https://royal-healthcare.com/"
  },
  "global_keys": ["header", "navigation", "footer", "floating_widgets"],
  "page_types": [
    {
      "pagetype": "landing",
      "route": "/",
      "count": 1,
      "multi": false,
      "has_pagination": false,
      "schema_keys": ["header", "navigation", "hero_section", ...],
      "own_keys": ["hero_section", "value_proposition", "services", ...]
    },
    {
      "pagetype": "doctor_profile",
      "route": "/doctor/[slug]",
      "count": 48,
      "multi": true,
      "slug_param": "slug",
      "has_pagination": false,
      "schema_keys": ["header", "profile_header", "sidebar", ...],
      "own_keys": ["profile_header", "sidebar", "doctor_profile"]
    }
  ],
  "pagination_candidates": [
    {
      "pagetype": "blog_listing",
      "evidence": "URL pattern contains {page}, paginated URLs exist in structure"
    }
  ]
}
```

#### Detection rules (all programmatic)

| Detection | Method |
|-----------|--------|
| Multi vs single | `count > 1` in grouped content |
| Route pattern | URL from first instance; `{slug}` → `[slug]`, `{page}` → `[page]` |
| Slug parameter | URL segment containing `{slug}` |
| Global sections | Schema key present in >90% of page types |
| Own sections | `schema_keys - global_keys` |
| Pagination | Schema has `pagination` property OR URL has `{page}` param |
| Sample selection | Sort instances by non-null leaf field count (recursive); richest = max, simplest = min |
| Global content | Extract sections from landing page content matching `global_keys` |

#### Validation

**Reviewers:** `reviewer-json-validity`, `reviewer-reduce-invariant`, `reviewer-reduced-schema-coverage`, `reviewer-phase-specific-M1`, `reviewer-phase-specific-M2`, `reviewer-generic-M1`, `reviewer-generic-M2`

**Phase-specific checklist (M1 + M2):**
- Page count invariant: `sum(page_types[].count) === source.total_pages`
- No missing schemas: every pagetype in content has a matching schema entry
- Sample coverage: richest sample has ≥ 80% of schema keys populated
- Output completeness: `meta.json` + `types/*/schema.json` + `types/*/samples/` all written

**On any reviewer rejection:** Fix reduction logic and retry. No AI retry — this is deterministic code.

---

### Phase 1b: CLASSIFY (AI)

**Purpose:** Classify page types and define the site architecture — collections, routing, layouts.

#### What it does

The AI reads `reduced/meta.json` + all `types/*/schema.json` + all `types/*/samples/` and decides:

1. **Page vs listing classification** — should `team_listing` query a collection or keep items inline?
2. **Content collection definitions** — what collections to create, which pagetype is the source, how to extract slugs
3. **Listing → collection query mapping** — which listings query which collections, with what filters
4. **Layout grouping** — which page types share a layout template
5. **Route hierarchy** — flat routes vs nested (`/our-services/[slug]` vs `/specialist-care/`)
6. **Pagination strategy** — which listings paginate, page size

#### Input

```
reduced/meta.json                     ← Phase 1a output
reduced/types/*/schema.json           ← Phase 1a output
reduced/types/*/samples/*.json        ← Phase 1a output
```

#### Output

```
<step>/output/reduced/
  registry.json                       ← site architecture blueprint
```

#### registry.json format

```jsonc
{
  "layouts": {
    "base": {
      "description": "Standard page with header, nav, footer",
      "page_types": ["landing", "about", "services", "page", "legal", "blog_listing", "event_listing", "blog_category", "date_archive"]
    },
    "profile": {
      "description": "Doctor profile with sidebar",
      "page_types": ["doctor_profile"]
    }
  },
  "collections": {
    "doctors": {
      "source_pagetype": "doctor_profile",
      "slug_field": "profile_url",
      "listable_by": ["team_listing", "doctor_listing"],
      "filterable_by": "specialty"
    },
    "blog_posts": {
      "source_pagetype": "blog_post",
      "slug_field": "url",
      "listable_by": ["blog_listing", "blog_category", "date_archive"],
      "filterable_by": "category"
    }
  },
  "listings": {
    "team_listing": {
      "route": "/meet-our-team/",
      "queries": [{ "collection": "doctors", "group_by": "category" }],
      "paginated": false
    },
    "blog_listing": {
      "route": "/news-events/",
      "queries": [{ "collection": "blog_posts" }],
      "paginated": true
    },
    "blog_category": {
      "route": "/category/[slug]/",
      "queries": [{ "collection": "blog_posts", "filter_by_param": "slug" }],
      "paginated": true
    },
    "doctor_listing": {
      "route": "/doctor-category/[slug]/",
      "queries": [{ "collection": "doctors", "filter_by_param": "slug" }],
      "paginated": false
    },
    "date_archive": {
      "route": "/[year]/[month]/[day]/",
      "queries": [{ "collection": "blog_posts", "filter_by_param": "date" }],
      "paginated": false
    }
  },
  "static_pages": [
    { "pagetype": "landing", "route": "/" },
    { "pagetype": "about", "route": "/about-us/" },
    { "pagetype": "services", "route": "/our-services/" },
    { "pagetype": "page", "route": "/patient-journey/" },
    { "pagetype": "page", "route": "/specialist-care/" },
    { "pagetype": "page", "route": "/diagnostics-imaging/" },
    { "pagetype": "page", "route": "/our-services/longevity-wellness/" },
    { "pagetype": "page", "route": "/our-services/concierge-services/" },
    { "pagetype": "legal", "route": "/privacy-policy/" },
    { "pagetype": "legal", "route": "/terms-conditions/" }
  ],
  "navigation": {
    "source": "global/navigation.json",
    "structure": "extracted from landing page nav"
  }
}
```

#### Validation

**Reviewers:** `reviewer-json-validity`, `reviewer-classify-coverage`, `reviewer-classify-architecture`, `reviewer-phase-specific-M1`, `reviewer-phase-specific-M2`, `reviewer-generic-M1`, `reviewer-generic-M2`

**Phase-specific checklist (M1 + M2):**
- Every pagetype accounted for: each type in `meta.json` appears in exactly one of: `layouts.*.page_types`, `collections.*`, or `static_pages`
- Collection sources match: every collection's `source_pagetype` exists in `meta.json` with `multi: true`
- Listing routes valid: every listing route matches a pagetype's route pattern from `meta.json`
- Static page routes valid: every static page route matches a single-instance pagetype from `meta.json`
- No orphans: `sum(static_pages.length) + sum(collections[*].source count) === total_pages`

**On any reviewer rejection:** Re-run with error context, up to 3 retries.

---

**Purpose:** Write scraped content into Astro content collections and static data files.

#### What it does

1. **Write collection entries** — for each collection in `registry.json`, find matching content entries, extract slug from `slug_field`, write individual JSON files to `src/content/<collection>/`
2. **Write static page data** — remaining single-instance pages → `src/data/static-pages.json`
3. **Write global content** — copy `reduced/global/*.json` → `src/data/`
4. **Generate content config** — write `src/content/config.ts` with Zod schemas derived from collection type schemas

#### Input

```
content.json                            ← scraper output
reduced/registry.json                   ← Phase 1b output
reduced/types/*/schema.json             ← Phase 1a output (for Zod schema generation)
reduced/global/*.json                   ← Phase 1a output
site/                                   ← from setup step (Astro project template)
```

#### Output

```
site/src/
  content/
    config.ts                            ← define collections with Zod schemas
    doctors/
      dr-john-smith.json                 ← one file per doctor_profile entry
      dr-jane-doe.json
      ... (48 files)
    blog/
      notice-of-closure.json             ← one file per blog_post entry
      long-article.json
      ... (24 files)
  data/
    static-pages.json                    ← all non-collection page content
    navigation.json                      ← from reduced/global/navigation.json
    footer.json                          ← from reduced/global/footer.json
```

#### Validation

**Reviewers:** Uses Phase 1 reviewers (see Phase 1: Validation & Fix above). Seed is validated as part of the Phase 1 approval gate.

**On any reviewer rejection:** Fix seeding logic and retry. No AI retry — this is deterministic code.

---

### Phase 1: Style fingerprint influence

The style fingerprint's `formality` and `playfulness` dimensions guide component naming and structure:
- High formality → standard nav patterns, structured footer columns
- High playfulness → animated hamburger menu, unconventional nav placement
- The `density` dimension influences how much content appears per section preview

### Validation & Fix

**Reviewers:** `reviewer-links-page-N` (×N pages), `reviewer-images-page-N` (×N pages), `reviewer-console-page-N` (×N pages), `reviewer-semantic-html`, `reviewer-phase-specific-M1`, `reviewer-phase-specific-M2`, `reviewer-generic-M1`, `reviewer-generic-M2`

**Phase-specific checklist (M1 + M2):**
- Every URL in `structure.json` has a corresponding route in the build output
- Content collections are properly defined and loadable
- No missing pages: build output contains all original URLs
- No duplicate slugs: each `[slug]` route generates unique pages
- Collection queries return data: listing pages show items, not empty states
- Static pages render: single-instance pages display their content correctly
- Every page has `<header>`, `<main>`, appropriate `<footer>`
- Heading hierarchy correct (h1 > h2 > h3, no skipping levels)
- No duplicate h1s per page
- Images have `alt` attributes
- Forms have associated `<label>` elements

**On any reviewer rejection:** Implementer re-runs the failing sub-phase with error context, up to 3 retries.

---

## Phase 2: LAYOUT

**Purpose:** Establish the spatial structure — where things go, how they flow, how they respond to screen size.

### What it does

1. Apply grid/flex layout to all sections
2. Set section spacing from `design-tokens.json → layout.sections` (hero: 96px/80px, default: 80px/64px)
3. Set container widths from `design-tokens.json → layout.container` (narrow: 720px, default: 1200px)
4. Set grid gutters from `design-tokens.json → layout.grid.gutter`
5. Implement responsive breakpoints from `design-tokens.json → layout.breakpoints`
6. Apply vertical rhythm from `design-tokens.json → layout.rhythm`
7. Apply density mode from `design-tokens.json → layout.density`
8. Use component spacing vocabulary from `design-tokens.json → componentSpacing`

### Input

```
style-fingerprint.json     ← Phase 0 output
design-tokens.json (layout layer) ← Phase 0 output
Phase 1 output files       ← structured HTML from Phase 1
```

### Output

Same files from Phase 1, now with Tailwind layout classes:
- `max-w-7xl mx-auto` (container width)
- `grid grid-cols-1 md:grid-cols-3 gap-8` (grid structure)
- `py-20 md:py-24` (section spacing from rhythm tokens)
- `px-4 md:px-6 lg:px-8` (container padding)

### Style fingerprint influence

The style fingerprint drives layout decisions directly:

| Dimension | Low (< 0.3) | High (> 0.7) |
|-----------|-------------|-------------|
| **density** | `py-24` sections, `gap-12` grids, `max-w-4xl` content | `py-12` sections, `gap-6` grids, `max-w-7xl` content |
| **formality** | Asymmetric layouts, organic flow | Strict grid, aligned columns, consistent structure |
| **ornament** | Clean, minimal structure | More decorative dividers, decorative sections |
| **depth** | Single-column, flat flow | Layered sections, overlapping elements, z-index stacking |

**Treatments map directly:**
- `surface: "frosted-glass"` → plan for backdrop-blur containers in Phase 3
- `corners: "sharp"` → all border-radius set to 0
- `corners: "pill"` → border-radius set to 9999px for interactive elements

### Validation & Fix

**Reviewers:** `reviewer-margins`, `reviewer-responsive-page-N` (×N pages), `reviewer-links-page-N` (×N pages), `reviewer-console-page-N` (×N pages), `reviewer-semantic-html`, `reviewer-phase-specific-M1`, `reviewer-phase-specific-M2`, `reviewer-generic-M1`, `reviewer-generic-M2`

**Phase-specific checklist (M1 + M2):**
- No `overflow-x: hidden` on body (layout shouldn't rely on hidden overflow)
- Tailwind classes reference only layout utilities (grid, flex, gap, padding, margin, max-w, mx-auto, px, py) — no color, font, or shadow classes yet
- Grid items have consistent gutters matching `design-tokens.json → layout.grid.gutter`
- Section spacing follows the rhythm scale (multiples of `layout.rhythm.baseUnit`)
- Container widths match `design-tokens.json → layout.container.maxWidth`
- No `!important` on layout properties
- Mobile-first approach verified: base styles are for mobile, `md:` and `lg:` add desktop styles
- Gray-box screenshots match Phase 1 — same content, same sections, now with correct spacing
- No horizontal scrollbar at any breakpoint (375px, 768px, 1280px)
- No overlapping elements at any breakpoint
- Content reflows correctly (multi-column → single-column on mobile)

**On any reviewer rejection:** Implementer re-runs Phase 2 with error context, up to 3 retries.

---

## Phase 3: DESIGN

**Purpose:** Apply the visual design system — typography, component styling, surfaces, textures — without color.

### What it does

1. Apply typography from `design-tokens.json → atomic.typography`:
   - Font families, font sizes, font weights
   - Line heights, letter spacing
   - Heading hierarchy scale
2. Apply component recipes from `component-recipes.json`:
   - Button shape properties (padding, radius, weight, height)
   - Card patterns (elevated/outlined/filled)
   - Input styling (height, padding, border)
   - Badge styling
3. Apply surface treatment from `design-tokens.json → surfaces`:
   - Glass/blur effects (backdrop-filter, semi-transparent bg)
   - Texture overlays (noise/grain)
   - Image treatment (aspect-ratio, object-fit, overlay gradients)
4. Apply gradient structure from `design-tokens.json → gradients`:
   - Gradient angle, stop positions, color space
   - (Colors still neutral — using gray scale placeholders)
5. Apply shadows from `design-tokens.json → atomic.shadows`
6. Apply border radius from `design-tokens.json → atomic.borderRadius`
7. Apply border styles from `design-tokens.json → visualIdentity.borders`

### Input

```
style-fingerprint.json         ← Phase 0
design-tokens.json (atomic, gradients, surfaces, visualIdentity layers) ← Phase 0
component-recipes.json         ← Phase 0
Phase 2 output files           ← layout from Phase 2
```

### Output

- `src/styles/globals.css` — typography, component base styles, surface effects
- `src/components/ui/` — Shadcn components with custom styling
- All `.astro` files updated with typography classes and component classes

### Style fingerprint influence

The treatments from the style fingerprint map directly to CSS:

| Treatment | CSS Implementation |
|-----------|-------------------|
| `surface: "frosted-glass"` | `backdrop-filter: blur(12px); background: rgba(255,255,255,0.25); border: 1px solid rgba(255,255,255,0.2)` |
| `surface: "textured"` | `::before` pseudo-element with SVG noise `feTurbulence` |
| `corners: "sharp"` | `border-radius: 0` on all elements |
| `corners: "squircle"` | `border-radius: 16px` with continuous corner |
| `shadows: "hard-offset"` | `box-shadow: 4px 4px 0 #000` (neobrutalist) |
| `shadows: "layered-soft"` | Multiple box-shadows with large blur (material) |
| `shadows: "dual-light-dark"` | Neumorphic pair (light highlight + dark shadow) |
| `borders: "thick"` | `border: 2-3px solid #000` |
| `borders: "none"` | Remove all borders, rely on shadow/elevation |
| `gradients: "mesh"` | CSS mesh or WebGL MiniGL |
| `gradients: "none"` | Solid colors only |

### Validation & Fix

**Reviewers:** `reviewer-typography`, `reviewer-component-recipes`, `reviewer-margins`, `reviewer-responsive-page-N` (×N pages), `reviewer-links-page-N` (×N pages), `reviewer-console-page-N` (×N pages), `reviewer-phase-specific-M1`, `reviewer-phase-specific-M2`, `reviewer-generic-M1`, `reviewer-generic-M2`

**Phase-specific checklist (M1 + M2):**
- `globals.css` contains typography variables (font-family, font-size scale, line-height, letter-spacing)
- Component recipes are followed: button padding/radius/weight match `component-recipes.json`
- No hardcoded font sizes or weights in `.astro` files (all from CSS variables or Tailwind utilities)
- Font loading: no FOUT (Flash of Unstyled Text), fonts load before content renders
- Typography scale: h1 > h2 > h3 sizes follow `design-tokens.json → atomic.typography.fontSize`
- Surface effects render: `backdrop-filter: blur()` visible on glass components, no visual artifacts
- Texture overlays: noise/grain pseudo-elements render without blocking content
- Image treatment: `aspect-ratio`, `object-fit` applied correctly to media elements
- Shadcn components installed: all referenced components in `component-recipes.json` are present in `src/components/ui/`
- Neutral palette screenshots verify structure + design visible without color influence
- Screenshot screenshots match Phase 2 — same layout, now with typography/design visible

**On any reviewer rejection:** Implementer re-runs Phase 3 with error context, up to 3 retries.

---

## Phase 4: COLOR

**Purpose:** Apply the color system — the final layer that brings the design to life.

### What it does

1. Map atomic colors → CSS custom properties in `globals.css`
2. Build semantic color tokens (primary → button bg, muted → card bg, etc.)
3. Apply 60-30-10 color distribution from `visualIdentity.colorDistribution`
4. Apply contrast pairs from `visualIdentity.contrastPairs`
5. Set up dark mode theme variant
6. Apply gradient colors (replace neutral placeholders with actual colors)
7. Apply border colors from `visualIdentity.borders`

### Input

```
design-tokens.json (atomic.colors, visualIdentity layers) ← Phase 0
style-fingerprint.json (dimensions.darkness)               ← Phase 0
Phase 3 output files                                       ← design from Phase 3
```

### Output

- `src/styles/globals.css` — full color system with `:root` and `.dark` variants
- All components now render with actual colors

### Style fingerprint influence

| Dimension | Low (< 0.3) | High (> 0.7) |
|-----------|-------------|-------------|
| **darkness** | Light theme primary, no dark mode needed | Dark theme primary, light mode secondary |
| **warmth** | Cool palette (blue, gray, neutral) | Warm palette (amber, earth tones, warm neutrals) |
| **playfulness** | Restrained accent usage, professional palette | Vibrant accents, multiple brand colors |
| **ornament** | Minimal color usage, monochrome tendencies | Rich color palette, decorative color usage |

### Color Distribution Rules (from research)

- 60% dominant color (backgrounds, large surfaces)
- 30% secondary color (cards, sections, navigation)
- 10% accent color (CTAs, highlights, active states)
- Contrast pairs validated against WCAG: normal text 4.5:1, large text 3:1, UI components 3:1

### Validation & Fix

**Reviewers:** `reviewer-color-contrast`, `reviewer-palette`, `reviewer-links-page-N` (×N pages), `reviewer-images-page-N` (×N pages), `reviewer-console-page-N` (×N pages), `reviewer-phase-specific-M1`, `reviewer-phase-specific-M2`, `reviewer-generic-M1`, `reviewer-generic-M2`

**Phase-specific checklist (M1 + M2):**
- `globals.css` `:root` block contains all color CSS variables (primary, secondary, accent, background, foreground, muted, border, destructive, card, popover, ring, input)
- `globals.css` `.dark` block exists with dark mode color overrides
- All color values are in OKLCH format (parseable, no hex/rgb mixed in)
- No hardcoded color values in `.astro` files (all from CSS variables)
- WCAG contrast ratios: normal text ≥ 4.5:1, large text ≥ 3.1:1, UI components ≥ 3:1 (test on light and dark themes)
- No invalid colors: all CSS variables resolve to valid OKLCH values (no NaN, no out-of-range lightness)
- 60-30-10 color distribution: dominant (60%) on backgrounds/surfaces, secondary (30%) on cards/sections/nav, accent (10%) on CTAs/highlights
- Gradient rendering: no banding or color space errors
- Border colors: visible and appropriate contrast against their background
- Link colors: distinguishable from body text (color + underline for clarity)
- Dark mode: all text remains readable, no elements invisible against dark background
- Screenshot screenshots match Phase 3 — only color should differ (no layout or typography regressions)

**On any reviewer rejection:** Implementer re-runs Phase 4 with error context, up to 3 retries.

---

## Phase 5: MOTION

**Purpose:** Add the interactive feel — hover states, transitions, scroll animations, easing personality.

### What it does

1. Apply transition durations from `design-tokens.json → motion.duration`
2. Apply easing curves from `design-tokens.json → motion.easing` (including brand-specific curve)
3. Apply interaction states from `design-tokens.json → motion.state`:
   - Hover: bg shift, elevation delta, translateY
   - Focus: ring width, ring offset, ring color
   - Active: scale reduction, shadow collapse
   - Disabled: opacity, cursor
4. Apply scroll reveals from `design-tokens.json → motion.scroll`:
   - Fade-in, slide-up patterns
   - Staggered children (50-100ms per item)
5. Add skeleton loading states from `design-tokens.json → motion.skeleton`
6. Add `prefers-reduced-motion` media query support
7. Apply brand easing archetype from style fingerprint `treatments.animation_style`

### Input

```
design-tokens.json (motion layer)     ← Phase 0
style-fingerprint.json (motion dimension, animation_style treatment) ← Phase 0
component-recipes.json (states)       ← Phase 0
Phase 4 output files                  ← colored site from Phase 4
```

### Output

- `src/styles/globals.css` — transition/easing variables, reduced-motion styles
- `src/components/` — components with hover/focus/active/disabled states
- `src/components/ui/` — Shadcn components with motion applied

### Style fingerprint influence

The `motion` dimension (0.0-1.0) directly controls animation density:
- 0.0-0.2 → Only essential interactions (hover color, focus ring). No scroll animations.
- 0.2-0.4 → Subtle transitions (200ms ease), gentle scroll reveals
- 0.4-0.6 → Standard modern (spring-gentle, staggered reveals, card hover lifts)
- 0.6-0.8 → Expressive (bouncy easings, staggered grids, parallax elements)
- 0.8-1.0 → Cinematic (slow transitions >400ms, dramatic scroll effects, morphing nav)

The `animation_style` treatment maps to easing:

| Treatment | Easing | Personality |
|-----------|--------|-------------|
| `subtle` | `ease`, 150-200ms | Professional, corporate |
| `spring-gentle` | `cubic-bezier(0.34, 1.56, 0.64, 1)`, 200-300ms | Friendly, modern SaaS |
| `spring-bouncy` | `cubic-bezier(0.68, -0.6, 0.32, 1.6)`, 200-400ms | Playful, consumer apps |
| `snappy` | `cubic-bezier(0.16, 1, 0.3, 1)`, 100-200ms | Fast, technical, dev tools |
| `cinematic` | `ease-in-out`, 400-600ms | Luxury, editorial, storytelling |

### Validation & Fix

**Reviewers:** `reviewer-motion`, `reviewer-reduced-motion`, `reviewer-links-page-N` (×N pages), `reviewer-console-page-N` (×N pages), `reviewer-phase-specific-M1`, `reviewer-phase-specific-M2`, `reviewer-generic-M1`, `reviewer-generic-M2`

**Phase-specific checklist (M1 + M2):**
- `globals.css` contains transition/easing CSS variables (duration, timing-function)
- `prefers-reduced-motion` media query exists in `globals.css`
- No `transition: all` anywhere (each transition lists explicit properties)
- No `!important` on transition properties
- No layout shift: animations only use `transform` and `opacity` (no `width`/`height`/`top`/`left` in transitions)
- No jank: animations run at 60fps
- Animation duration limits: scroll-triggered reveals max 600ms, hover transitions max 300ms
- Scroll animations fire once and don't re-trigger
- Easing curves match `design-tokens.json → motion.easing` values (not default `ease`)
- `prefers-reduced-motion: reduce`: all scroll-triggered animations disabled, hover/focus transitions instant or subtle
- No auto-playing animations
- Screenshot screenshots match Phase 4 — no visible difference (motion invisible in static screenshots)

**On any reviewer rejection:** Implementer re-runs Phase 5 with error context, up to 3 retries.

---

## Phase 6: POLISH

**Purpose:** Final validation and quality assurance.

### What it does

1. Full `astro build` — no TypeScript errors, no build warnings
2. Functional check — all pages load, all links work, all buttons clickable
3. Responsive audit — screenshots at 375/768/1280, compare against style fingerprint
4. Quality scoring — layout consistency, design token usage, component composition, semantic HTML, visual appeal
5. Cross-reference against style fingerprint — does the output match the classified style?

### Input

```
All Phase 0-5 outputs
style-fingerprint.json ← reference for quality comparison
```

### Output

```
projects/<site>/
  quality-scores.json
  test-report.json
```

### Quality Score Dimensions

| Dimension | Weight | What it checks |
|-----------|--------|---------------|
| Layout consistency | 20% | Spacing follows rhythm, grid alignment, section padding |
| Design token usage | 20% | All values from tokens, no hardcoded magic numbers |
| Component composition | 15% | Variants render, recipes followed, shared components used |
| Responsive design | 15% | Works at 3 breakpoints, no overflow, correct grid shifts |
| Semantic HTML | 10% | Correct heading hierarchy, ARIA labels, landmark elements |
| Visual appeal | 10% | Style-appropriate aesthetics, no visual regressions |
| Motion quality | 10% | Smooth transitions, correct easing, reduced-motion support |

### Validation & Fix

**Reviewers:** `reviewer-links-page-N` (×N pages), `reviewer-images-page-N` (×N pages), `reviewer-console-page-N` (×N pages), `reviewer-responsive-page-N` (×N pages), `reviewer-semantic-html`, `reviewer-quality-score`, `reviewer-fingerprint-fidelity`, `reviewer-phase-specific-M1`, `reviewer-phase-specific-M2`, `reviewer-generic-M1`, `reviewer-generic-M2`

**Phase-specific checklist (M1 + M2):**
- All pages load without crash, no console errors
- All links across all pages verified (no 404/500)
- All buttons on all pages are interactive
- Forms: all inputs accept focus, submit action works (or proper `action` attribute)
- Screenshot at 375px: no horizontal scrollbar, single-column reflow, mobile nav accessible, no overlapping elements
- Screenshot at 768px: layout transitions correct, no horizontal scrollbar
- Screenshot at 1280px: full layout, content not stretched, all grid columns visible
- Quality score ≥ 8.5 overall across all 7 dimensions
- Style fingerprint fidelity: cosine similarity within 0.2 of reference across all dimensions

---

## Data Flow: Per-Phase File Tree

Below is the exact state of every file on disk at each phase boundary. Arrows show what each phase **reads** (input) and **writes** (output). Files without arrows are carried through unchanged.

### Before Phase 0 — External Inputs

```
projects/<site>/
  └── (empty or doesn't exist yet)

scratch/<site>/                          ← working directory for phase outputs
  └── (empty)
```

External data (from scraper + reference URL):
```
<scraper-output>/                        ← provided by external scraper
  ├── structure.json                     page sitemap, sections, references
  ├── schema.json                        field definitions per page type
  └── content.json                       actual content (text, images, CTAs)

reference URL                            ← live website to extract style from
```

---

### After Phase 0: ANALYZE

**Reads:** `reference URL` (via Playwright), `structure.json` (page types)

**Writes:** 3 new analysis files in `scratch/<site>/`

```
scratch/<site>/
  ├── style-fingerprint.json             ← NEW: style classification + dimensions + treatments
  ├── design-tokens.json                 ← NEW: 7-layer token set (replaces flat tokens)
  └── component-recipes.json             ← NEW: per-component CSS property bundles
```

Claude receives: the 3 JSON files above (not truncated — full structured data)
Claude prompt: "Analyze this reference site and extract design tokens"

---

### After Phase 1: STRUCTURE

**Reads:** `structure.json`, `schema.json`, `content.json` (from scraper)
**No design token files read** — this phase is content-only, zero styling

**Writes:** entire Astro project scaffold + page files + content wiring

```
projects/<site>/                         ← generated project directory
  ├── package.json                       ← from template
  ├── astro.config.mjs                   ← from template
  ├── tsconfig.json                      ← from template
  ├── tailwind.config.ts                 ← from template (default config, no customization)
  ├── components.json                    ← shadcn config, from template
  ├── src/
  │   ├── layouts/
  │   │   └── Layout.astro               ← base shell: <html><head></head><body><slot/></body></html>
  │   ├── components/
  │   │   ├── Header.astro               ← NEW: nav links from structure.json
  │   │   ├── Footer.astro               ← NEW: footer links from structure.json
  │   │   └── ui/                        ← shadcn components, from template (not customized yet)
  │   │       ├── button.tsx
  │   │       ├── card.tsx
  │   │       └── ... (other shadcn defaults)
  │   ├── pages/
  │   │   ├── index.astro                ← NEW: homepage, sections from structure.json
  │   │   ├── about.astro                ← NEW: about page
  │   │   ├── blog/
  │   │   │   └── [slug].astro           ← NEW: dynamic blog page
  │   │   └── contact.astro              ← NEW: contact page
  │   ├── lib/
  │   │   └── content.ts                 ← NEW: getPageByUrl(), getAllPages(), getSection() helpers
  │   ├── data/
  │   │   └── content.json               ← COPIED: from scraper content.json
  │   └── styles/
  │       └── globals.css                ← from template (minimal — CSS variable shells only)
  └── public/
      └── (empty)

scratch/<site>/                           ← unchanged from Phase 0
  ├── style-fingerprint.json
  ├── design-tokens.json
  └── component-recipes.json
```

Claude receives: `structure.json` + `schema.json` + `content.json` (full, not truncated)
Claude prompt: "Create page files matching the sitemap. Wire content. Semantic HTML only. Zero styling."
Validation: typecheck, build, Playwright (all pages render, no 404s, zero CSS)

---

### After Phase 2: LAYOUT

**Reads:** `style-fingerprint.json`, `design-tokens.json → layout` layer, `componentSpacing` layer
**Also reads:** all Phase 1 `.astro` files (existing project state)

**Writes:** updates to `.astro` files — adds Tailwind layout utilities only

```
projects/<site>/
  ├── src/
  │   ├── layouts/
  │   │   └── Layout.astro               ← UPDATED: container class (max-w-7xl mx-auto)
  │   ├── components/
  │   │   ├── Header.astro               ← UPDATED: flex layout, responsive breakpoints
  │   │   ├── Footer.astro               ← UPDATED: grid columns, gap from tokens
  │   │   └── ui/                        ← unchanged (still template defaults)
  │   ├── pages/
  │   │   ├── index.astro                ← UPDATED: grid/flex per section, spacing from tokens
  │   │   ├── about.astro                ← UPDATED: layout classes, responsive grid
  │   │   ├── blog/[slug].astro          ← UPDATED: content layout
  │   │   └── contact.astro              ← UPDATED: form layout, grid structure
  │   ├── lib/
  │   │   └── content.ts                 ← unchanged
  │   ├── data/
  │   │   └── content.json               ← unchanged
  │   └── styles/
  │       └── globals.css                ← UPDATED: spacing/sizing CSS variables (no color, no font)
  └── ...

scratch/<site>/                           ← unchanged
  ├── style-fingerprint.json
  ├── design-tokens.json
  └── component-recipes.json
```

Claude receives: `style-fingerprint.json` + `design-tokens.json` (layout + componentSpacing layers only) + all `.astro` file contents
Claude prompt: "Apply grid/flex layout, spacing, responsive breakpoints. Gray-box mode. No color, no typography."
Validation: typecheck, build, Playwright responsive (375/768/1280), gray-box screenshots, no overflow

---

### After Phase 3: DESIGN

**Reads:** `style-fingerprint.json`, `design-tokens.json → atomic`, `gradients`, `surfaces`, `visualIdentity` layers, `component-recipes.json` (base + variants)
**Also reads:** all Phase 2 `.astro` files + `globals.css`

**Writes:** updates to `.astro` files (typography classes, component variants) + `globals.css` (typography, surfaces, shadows, borders)

```
projects/<site>/
  ├── src/
  │   ├── layouts/
  │   │   └── Layout.astro               ← UPDATED: font imports, body font class
  │   ├── components/
  │   │   ├── Header.astro               ← UPDATED: typography, shadow, border from tokens
  │   │   ├── Footer.astro               ← UPDATED: font sizes, typography scale
  │   │   └── ui/
  │   │       ├── button.tsx             ← UPDATED: shape from component-recipes (padding, radius, weight)
  │   │       ├── card.tsx               ← UPDATED: variants (elevated/outlined/filled)
  │   │       ├── input.tsx              ← UPDATED: height, padding, border from recipes
  │   │       └── badge.tsx              ← UPDATED: padding, font size, variants
  │   ├── pages/
  │   │   ├── index.astro                ← UPDATED: heading classes, text hierarchy
  │   │   ├── about.astro                ← UPDATED: typography applied to all text
  │   │   ├── blog/[slug].astro          ← UPDATED: typography for blog content
  │   │   └── contact.astro              ← UPDATED: form element styling
  │   ├── lib/
  │   │   └── content.ts                 ← unchanged
  │   ├── data/
  │   │   └── content.json               ← unchanged
  │   └── styles/
  │       └── globals.css                ← UPDATED: typography vars, surface effects, shadows,
  │                                        borders, gradient structure (colors = neutral placeholders)
  └── ...

scratch/<site>/                           ← unchanged
  ├── style-fingerprint.json
  ├── design-tokens.json
  └── component-recipes.json
```

Claude receives: `style-fingerprint.json` + `design-tokens.json` (atomic + gradients + surfaces + visualIdentity) + `component-recipes.json` + all `.astro` + `globals.css`
Claude prompt: "Apply typography, component styling, surfaces, shadows. Neutral palette (grays only). No real colors yet."
Validation: typecheck, build, Playwright (component variants render), neutral palette screenshots, font loading, visual regression vs Phase 2

---

### After Phase 4: COLOR

**Reads:** `design-tokens.json → atomic.colors`, `visualIdentity` layers, `style-fingerprint.json → darkness` dimension
**Also reads:** `globals.css` from Phase 3

**Writes:** updates to `globals.css` only (color CSS variables + dark mode theme)

```
projects/<site>/
  ├── src/
  │   ├── layouts/
  │   │   └── Layout.astro               ← unchanged (font import already done)
  │   ├── components/
  │   │   ├── Header.astro               ← unchanged
  │   │   ├── Footer.astro               ← unchanged
  │   │   └── ui/                        ← unchanged (shape already set)
  │   ├── pages/
  │   │   ├── index.astro                ← unchanged
  │   │   ├── about.astro                ← unchanged
  │   │   ├── blog/[slug].astro          ← unchanged
  │   │   └── contact.astro              ← unchanged
  │   ├── lib/
  │   │   └── content.ts                 ← unchanged
  │   ├── data/
  │   │   └── content.json               ← unchanged
  │   └── styles/
  │       └── globals.css                ← UPDATED: :root color vars (OKLCH), .dark theme vars,
  │                                        gradient colors, border colors
  └── ...

scratch/<site>/                           ← unchanged
  ├── style-fingerprint.json
  ├── design-tokens.json
  └── component-recipes.json
```

Claude receives: `design-tokens.json` (atomic.colors + visualIdentity) + `style-fingerprint.json` (darkness) + `globals.css`
Claude prompt: "Apply color system. Map atomic colors → CSS variables. Add dark mode. WCAG contrast."
Validation: typecheck, build, Playwright (dark mode), WCAG contrast ratios, visual regression vs Phase 3 (only color should differ)

**Key property of Phase 4:** Only `globals.css` is modified. No `.astro` or `.tsx` files change. This means layout (Phase 2) and design (Phase 3) are physically impossible to regress.

---

### After Phase 5: MOTION

**Reads:** `design-tokens.json → motion` layer, `style-fingerprint.json → motion` dimension + `animation_style` treatment, `component-recipes.json → states`
**Also reads:** all `.astro` and `.tsx` component files from Phase 4

**Writes:** updates to component files (hover/focus/active/disabled transitions) + `globals.css` (transition vars, reduced-motion)

```
projects/<site>/
  ├── src/
  │   ├── layouts/
  │   │   └── Layout.astro               ← UPDATED: scroll reveal wrapper if needed
  │   ├── components/
  │   │   ├── Header.astro               ← UPDATED: mobile menu transition, nav hover states
  │   │   ├── Footer.astro               ← unchanged or subtle hover on links
  │   │   └── ui/
  │   │       ├── button.tsx             ← UPDATED: hover/focus/active/disabled transitions + easing
  │   │       ├── card.tsx               ← UPDATED: hover lift transition
  │   │       ├── input.tsx              ← UPDATED: focus ring transition
  │   │       └── badge.tsx              ← unchanged (no interactive states)
  │   ├── pages/
  │   │   ├── index.astro                ← UPDATED: scroll reveal classes on sections
  │   │   ├── about.astro                ← UPDATED: staggered reveal on content blocks
  │   │   ├── blog/[slug].astro          ← unchanged
  │   │   └── contact.astro              ← unchanged
  │   ├── lib/
  │   │   └── content.ts                 ← unchanged
  │   ├── data/
  │   │   └── content.json               ← unchanged
  │   └── styles/
  │       └── globals.css                ← UPDATED: transition-duration vars, easing vars,
  │                                        prefers-reduced-motion overrides
  └── ...

scratch/<site>/                           ← unchanged
  ├── style-fingerprint.json
  ├── design-tokens.json
  └── component-recipes.json
```

Claude receives: `design-tokens.json` (motion layer) + `style-fingerprint.json` (motion dim + animation_style) + `component-recipes.json` (states) + all component files
Claude prompt: "Add transitions, hover/focus/active states, scroll reveals. Match easing to brand personality. Support reduced-motion."
Validation: typecheck, build, Playwright (hover/focus/active/disabled), no layout shift, reduced-motion, animation density vs fingerprint

---

### After Phase 6: POLISH

**Reads:** everything — all project files + `style-fingerprint.json` (reference for fidelity check)

**Writes:** 2 new report files (does not modify any source files)

```
projects/<site>/
  ├── src/                               ← UNCHANGED from Phase 5
  │   └── ... (all files as Phase 5 left them)
  ├── quality-scores.json                ← NEW: 7-dimension quality scores
  └── test-report.json                   ← NEW: functional test results, responsive results

scratch/<site>/                           ← unchanged
  ├── style-fingerprint.json
  ├── design-tokens.json
  └── component-recipes.json
```

Claude receives: all project files + `style-fingerprint.json`
Claude prompt: "Run full validation. Score quality across 7 dimensions. Compare output against style fingerprint."
Validation: full typecheck + build, Playwright (all pages, all links, all buttons, responsive 375/768/1280), quality scoring, style fingerprint fidelity

**Key property of Phase 6:** Phase 6 is read-only on source files. If it finds issues, it reports them but does NOT auto-fix — issues are surfaced to the user.

---

### Data Flow Summary

```
                    ┌──────────────────────────────────────────────────────┐
                    │                scratch/<site>/                       │
                    │                                                      │
  Phase 0 writes ──►│  style-fingerprint.json  ◄── read by Phase 2,3,4,5,6│
                    │  design-tokens.json      ◄── read by Phase 2,3,4,5  │
                    │  component-recipes.json  ◄── read by Phase 3,5      │
                    └──────────────────────────────────────────────────────┘

                    ┌──────────────────────────────────────────────────────┐
                    │           runs/<id>/steps/reduce/output/             │
                    │                                                      │
  Phase 1a writes ─►│  reduced/meta.json      ◄── read by 1b, 2          │
                    │  reduced/types/*/schema  ◄── read by 1b, 2, 1c      │
                    │  reduced/types/*/samples ◄── read by 1b, 2          │
                    │  reduced/global/*.json   ◄── read by 1c             │
                    │                                                      │
  Phase 1b writes ─►│  reduced/registry.json   ◄── read by 1c, 2         │
                    └──────────────────────────────────────────────────────┘

                    ┌──────────────────────────────────────────────────────┐
                    │               projects/<site>/                       │
                    │                                                      │
                    │  src/content/config.ts ── Phase 1c writes           │
                    │  src/content/doctors/*.json ── Phase 1c writes       │
                    │  src/content/blog/*.json ── Phase 1c writes          │
                    │  src/data/static-pages.json ── Phase 1c writes       │
                    │  src/data/navigation.json ── Phase 1c writes         │
                    │  src/data/footer.json ── Phase 1c writes             │
                    │                                                      │
                    │  globals.css ──────────────────────────────────────  │
                    │    Phase 2: spacing/sizing CSS vars                 │
                    │    Phase 3: typography, surfaces, shadows, borders   │
                    │    Phase 4: color vars (:root + .dark)              │
                    │    Phase 5: transition/easing vars, reduced-motion   │
                    │                                                      │
                    │  .astro pages ─────────────────────────────────────  │
                    │    Phase 1c: content collection wiring + static pages │
                    │    Phase 2: layout classes (grid/flex/spacing)       │
                    │    Phase 3: typography + component classes           │
                    │    Phase 5: scroll reveal classes                    │
                    │                                                      │
                    │  .tsx components (ui/) ────────────────────────────  │
                    │    Phase 3: shape from recipes (padding/radius/etc)  │
                    │    Phase 5: hover/focus/active/disabled transitions  │
                    │                                                      │
                    │  quality-scores.json ── Phase 6 writes (read-only)  │
                    │  test-report.json    ── Phase 6 writes (read-only)  │
                    └──────────────────────────────────────────────────────┘
```

### Key Differences from Current Pipeline

| Current Pipeline | v2 Pipeline |
|------------------|-------------|
| All data in one `design-brief.json` (truncated to 15k chars) | 3 independent JSON files, never truncated |
| `JSON.stringify(scraperOutput).slice(0, 15000)` passed as string | Structured files read from disk, Claude gets full content |
| `content.json` (1.9M) dumped as flat blob, queried with `getPageByUrl()` | Content collections with `[slug]` routing and `getStaticPaths()` |
| No content collection architecture | Phase 1: reduce → classify → seed produces collections |
| Layout + design + color in one codegen step | 5 separate steps, each touches different properties |
| No validation between steps | Per-phase validation gates with targeted re-fix |
| Fix loop modifies everything at once | Fix loop targets only the properties that phase owns |
| Pagination pages treated as separate pages | Astro `paginate()` for computed pagination |
| Listings bake all items inline | Listing pages query content collections at build time |

---

## Approval Gates: Implementer + Reviewer Pattern

Every phase has **two steps**:

```
Step 1: IMPLEMENTER
  → produces all phase output files
  → creates evidence/ folder with all check artifacts

Step 2: REVIEWERS (parallel, semaphore-controlled)
  → each reviewer is a separate agent
  → each reviewer writes its own file to reviews/
  → any rejection → loop back to implementer with rejection context
  → all pass → DELETE reviews/ folder → next phase begins
```

### Evidence Folder (implementer creates)

The implementer populates `evidence/` at the end of every phase:

```
<step>/evidence/
  biome.json              ← bun run biome check . --formatter-enabled=false --write=false
  astro-check.json        ← bunx astro check (tsc + astro type checking)
  build.json              ← bun run build (full astro build)
  console-errors.json     ← Playwright: visit every page, collect console errors
  broken-links.json       ← Playwright: collect all <a href>, visit each, report 404/500
  broken-images.json      ← Playwright: find all <img>, verify src loads (no 404)
  screenshots/            ← one screenshot per page at desktop/tablet/mobile
    home-desktop.png
    home-tablet.png
    home-mobile.png
    about-desktop.png
    ...
  page-links.json         ← adjacency list: for each page, which pages it links to
  responsive.json         ← Playwright: check no horizontal scroll at 375/768/1280
```

Evidence files are **append-only per attempt** — the implementer writes evidence fresh on each retry so the folder always reflects the latest attempt.

### Reviews Folder (reviewers create, implementer reads)

Each reviewer is a separate agent writing its verdict to `reviews/`:

```
<step>/reviews/
  reviewer-quality.md              ← biome + astro + build all pass
  reviewer-links-page-1.md         ← all links on page 1 work
  reviewer-links-page-2.md         ← all links on page 2 work
  reviewer-images-page-1.md        ← all images on page 1 load
  reviewer-images-page-2.md        ← all images on page 2 load
  reviewer-console-page-1.md        ← no console errors on page 1
  reviewer-console-page-2.md       ← no console errors on page 2
  reviewer-responsive-home.md      ← home page responsive at 375/768/1280
  reviewer-typography.md            ← fonts load, hierarchy correct
  reviewer-color-contrast.md        ← WCAG ratios pass, colors applied
  reviewer-motion.md               ← no layout shift, easing correct
  reviewer-reduced-motion.md        ← prefers-reduced-motion respected
  reviewer-margins.md               ← spacing matches design tokens
  reviewer-palette.md              ← 60-30-10 color distribution
  reviewer-fingerprint-fidelity.md  ← output matches style fingerprint
  reviewer-json-validity.md         ← all JSON outputs parse + schema-valid
  reviewer-token-completeness.md    ← all 7 token layers populated
  reviewer-reduce-invariant.md      ← sum(counts) === total_pages
  reviewer-classify-coverage.md     ← all page types accounted for
  reviewer-component-recipes.md     ← components match recipe specs
  reviewer-semantic-html.md         ← correct heading hierarchy, landmark elements
  reviewer-quality-score.md         ← 7-dimension quality scores above threshold
```

Each reviewer file contains:
```
# Review: reviewer-X

## Verdict: PASS | REJECT

## Evidence
... what this reviewer checked and how ...

## Findings
... what passed and/or what failed ...

## Rejection Context (if rejected)
... specific error, file, line, element, screenshot annotation ...
```

The implementer reads `reviews/` on retry to understand what needs fixing. On pass, the orchestrator **deletes the entire `reviews/` folder** so stale rejections don't accumulate across phases.

### Per-Phase Reviewer Matrix

| Phase | Phase-Specific Reviewers | Generic Reviewers |
|-------|------------------------|-------------------|
| **0: Analyze** | `reviewer-json-validity`, `reviewer-token-completeness`, `reviewer-style-confidence`, `reviewer-phase-specific-M1`, `reviewer-phase-specific-M2` | `reviewer-generic-M1`, `reviewer-generic-M2` |
| **1a: Reduce** | `reviewer-json-validity`, `reviewer-reduce-invariant`, `reviewer-reduced-schema-coverage`, `reviewer-phase-specific-M1`, `reviewer-phase-specific-M2` | `reviewer-generic-M1`, `reviewer-generic-M2` |
| **1b: Classify** | `reviewer-json-validity`, `reviewer-classify-coverage`, `reviewer-classify-architecture`, `reviewer-phase-specific-M1`, `reviewer-phase-specific-M2` | `reviewer-generic-M1`, `reviewer-generic-M2` |
| **1c: Seed** | `reviewer-links-page-N` (×N pages), `reviewer-images-page-N` (×N pages), `reviewer-console-page-N` (×N pages), `reviewer-semantic-html`, `reviewer-phase-specific-M1`, `reviewer-phase-specific-M2` | `reviewer-generic-M1`, `reviewer-generic-M2` |
| **2: Layout** | `reviewer-margins`, `reviewer-responsive-page-N` (×N pages), `reviewer-links-page-N` (×N pages), `reviewer-console-page-N` (×N pages), `reviewer-semantic-html`, `reviewer-phase-specific-M1`, `reviewer-phase-specific-M2` | `reviewer-generic-M1`, `reviewer-generic-M2` |
| **3: Design** | `reviewer-typography`, `reviewer-component-recipes`, `reviewer-margins`, `reviewer-responsive-page-N` (×N pages), `reviewer-links-page-N` (×N pages), `reviewer-console-page-N` (×N pages), `reviewer-phase-specific-M1`, `reviewer-phase-specific-M2` | `reviewer-generic-M1`, `reviewer-generic-M2` |
| **4: Color** | `reviewer-color-contrast`, `reviewer-palette`, `reviewer-links-page-N` (×N pages), `reviewer-images-page-N` (×N pages), `reviewer-console-page-N` (×N pages), `reviewer-phase-specific-M1`, `reviewer-phase-specific-M2` | `reviewer-generic-M1`, `reviewer-generic-M2` |
| **5: Motion** | `reviewer-motion`, `reviewer-reduced-motion`, `reviewer-links-page-N` (×N pages), `reviewer-console-page-N` (×N pages), `reviewer-phase-specific-M1`, `reviewer-phase-specific-M2` | `reviewer-generic-M1`, `reviewer-generic-M2` |
| **6: Polish** | `reviewer-links-page-N` (×N pages), `reviewer-images-page-N` (×N pages), `reviewer-console-page-N` (×N pages), `reviewer-responsive-page-N` (×N pages), `reviewer-semantic-html`, `reviewer-quality-score`, `reviewer-fingerprint-fidelity`, `reviewer-phase-specific-M1`, `reviewer-phase-specific-M2` | `reviewer-generic-M1`, `reviewer-generic-M2` |

**Generic checklist** (M1 + M2 — same checklist, different model):

- `npm run check` — runs `biome check . --formatter-enabled=false --write=false && astro check && knip` in sequence; any failure is a rejection

Both models run the same checklist independently. Either model rejecting any item = rejection.

### Reviewer Semantics

**Parallelism:** Reviewers run in parallel, controlled by a semaphore (default max 5 concurrent). Each reviewer is independent — order does not matter.

**Pass condition:** ALL reviewers for the phase return PASS. Any single REJECT → the entire phase fails.

**Rejection handling:**
1. Reviewer writes rejection context to `reviews/reviewer-X.md`
2. Implementer reads all `reviews/` files before retrying
3. Implementer fixes the issues and writes new evidence
4. Reviewers re-run fresh (old `reviews/` was deleted on prior pass)
5. Up to 3 retries per phase

**No partial credit:** A phase cannot proceed with known rejections. The implementer must achieve all-pass verdicts before the next phase begins.

### Static Checks (Combined Command)

For phases that need quality review, run all three in sequence — any failure is a rejection:

```bash
bun run biome check . --formatter-enabled=false --write=false && \
bunx astro check && \
bun run build
```

This is the `reviewer-quality` check's evidence command. The combined output goes into `evidence/biome.json`, `evidence/astro-check.json`, `evidence/build.json`.

### Visual Regression Between Phases

Each phase takes screenshots and compares against the previous phase to ensure no unintended changes:

```
Phase 1c evidence/screenshots/ → baseline (semantic HTML, zero styling)
Phase 2 evidence/screenshots/ → compare with Phase 1c → only layout should differ
Phase 3 evidence/screenshots/ → compare with Phase 2 → only typography/design should differ
Phase 4 evidence/screenshots/ → compare with Phase 3 → only color should differ
Phase 5 evidence/screenshots/ → compare with Phase 4 → no visible difference (motion invisible in static screenshots)
```

`reviewer-color-contrast` handles this as part of its verdict — if screenshots show regressions from prior phases, it's a rejection.

### Iteration & Fix

When any reviewer rejects:

1. The reviews folder contains the full rejection context (file, line, element, expected vs actual)
2. The implementer reads `reviews/` — all rejection files, not just one
3. The implementer fixes targeted issues, writes new evidence
4. The reviews folder is deleted; reviewers re-run fresh
5. Up to 3 retries per phase

This means:
- A color issue in Phase 4 never touches Phase 2's layout
- A layout issue in Phase 2 never touches Phase 1's content structure
- Each phase is independently fixable and independently reviewable

---

## Why This Is Fundamentally Better

### 1. Style-aware generation

The current pipeline has no concept of "style." It extracts flat tokens and applies them uniformly. A brutalist site and a luxury site get the same treatment. The style fingerprint means every downstream decision — layout density, corner radius, shadow type, animation style — is driven by the classified personality of the reference site.

### 2. Layered independence

The current pipeline mixes layout + content + styling in one step. If colors break, layout might regress. Here, Phase 2 produces a known-good gray-box layout that never changes. Phase 4 only touches color CSS variables. Phase 5 only touches transition/animation properties. No cross-phase regression.

### 3. Component recipes vs atomic tokens

The current pipeline knows the primary color is `#3b82f6` but doesn't know the button uses `padding: 8px 20px` + `font-weight: 600` + `border-radius: 9999px` + `hover: translateY(-1px)`. Component recipes capture the *combination* of properties that make a button feel like *that site's* button, not just any blue button.

### 4. Measurable quality

The style fingerprint dimensions are numeric (0.0-1.0). The generated site can be measured against the same dimensions and compared. If the reference site has `density: 0.25` (airy) but the generated site measures `density: 0.7` (dense), you know exactly what to fix.

### 5. Matches real design workflow

No designer picks colors before layout works. No designer adds animations before the component library is styled. The pipeline mirrors the real design process: structure → layout → design → color → motion → polish.

### 6. Each phase is independently reviewable

After Phase 2, you see gray-box wireframes. You can say "the hero needs more whitespace" before any color is applied. After Phase 3, you see the design in neutral grays — you can say "the buttons should be pill-shaped" before color obscures the structure. After Phase 4, you see the full visual — you can say "the blue is too dark" without worrying about layout or animation.

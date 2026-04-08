# PIPELINE-V3.md — Mecury Pipeline Specification

## Overview

Mecury regenerates a complete website from scraped content using a reference site's design. Given scraper output (structure.json, schema.json, content.json) and a reference URL, it produces a CMS-ready Astro.js site with the original content but the reference site's visual design.

The pipeline decomposes this into three segments that form a fan-in DAG:

```
analyze ────┐
            ├──→ design
wireframe ──┘
```

## Three Segments

| Segment | Depends On | Input | Output | Purpose |
|---------|-----------|-------|--------|---------|
| **analyze** | — | Reference URL + target page types | Token JSONs + pattern library | Extract the reference site's visual DNA |
| **wireframe** | — | Scraper output | Working unstyled Astro project | Build a structurally correct, CMS-ready site |
| **design** | analyze, wireframe | Tokens + patterns + unstyled project | Final styled Astro project | Apply all visual treatment |

### Why This Shape

**Analyze and wireframe are independent.** Analyze reads only the reference URL. Wireframe reads only the scraper output. Neither needs the other's output. The DAG executor runs them concurrently.

**Design is the fan-in point.** It merges both branches: wireframe's structural project provides the component tree and content bindings; analyze's tokens provide the visual system. Design has full context to make holistic visual decisions.

**No phase independence violations.** Wireframe produces semantic HTML with zero visual styling. Design applies ALL visual treatment (grid, spacing, typography, color, motion) in one segment. There is no ownership conflict between segments — wireframe owns structure, design owns presentation.

---

## Segment 1: Analyze

**Purpose:** Extract the reference site's visual design system — exact token values, style personality, component patterns, and design intent — organized as a reusable library that the design segment can apply to any content structure.

**Input:**
- Reference URL from `cui.yaml`
- Target site's page types (read from scraper output's structure.json — just the unique pagetype set)

### Output Contract

**Hard outputs (required — design segment depends on these):**

- `style-fingerprint.json` — 8-dimension style personality (ornament, playfulness, warmth, density, motion, depth, darkness, formality, each 0-1) + treatments (surface, corners, shadows, borders, gradients, blur, transparency, animation_style). Machine-readable. Drives downstream branching logic.

- `design-tokens.json` — 7-layer token architecture with exact values:
  1. Atomic: colors, typography (families, sizes, weights), spacing scale, border-radius, shadows
  2. Gradients: gradient definitions (type, angle, stops)
  3. Layout: grid (columns, gutters), containers (max-widths), breakpoints, section spacing, density, rhythm
  4. Component spacing: per-component padding/margin/gap
  5. Motion: durations, easing curves, state transitions (hover/focus/active/disabled), scroll, skeleton
  6. Surfaces: glass, texture, image treatment
  7. Visual identity: color distribution (60-30-10), border styles

- `component-recipes.json` — per-component CSS bundles covering both atomic components (button, card, input, badge, avatar) AND section-level patterns (hero-section, card-grid, prose-block, sidebar-layout, testimonial-row). Each recipe has: base styles + variants + states.

**Weak outputs (optional — design segment references if present, never depends on):**

- `patterns/` directory — markdown descriptions + screenshots per reference page type. Design guidance in natural language. Visual reference material for the design agent. If the scout couldn't find a matching page type on the reference site, no file is generated for that type — design falls back to global tokens and fingerprint.

```
output/
  style-fingerprint.json          <- hard, structured
  design-tokens.json              <- hard, structured
  component-recipes.json          <- hard, structured
  patterns/
    overview.md                   <- weak, site-wide design principles
    screenshots/                  <- weak, full-page captures
    per-type/
      landing.md                  <- weak, matched from ref /
      blog-post.md               <- weak, matched from ref /blog/x
      listing.md                  <- weak, matched from ref /blog
      ...                         <- only types that had a match
```

### Phases

#### Phase 1: Identify + Scout (sequential)

**Step 1a: Identify target page types** (programmatic)
- Read structure.json from scraper output
- Extract unique page types: `new Set(pages.map(p => p.pagetype))`
- Output: list of page types we need to find on the reference site

**Step 1b: Scout reference site** (agent)
- One agent navigates the reference URL
- For each target page type, find the closest matching page on the reference site
- For unmatched types, note them — they'll use generic extraction only
- Also identify 1-2 "generic" pages (homepage, about) for baseline extraction
- Output: catalog mapping target types → reference URLs + list of generic pages

**Confidence thresholds:**
- `≥ 0.7` — full extraction (both agents)
- `0.4–0.7` — extract, but flag as `low_confidence` in merge input (merge step weighs these lower during reconciliation)
- `< 0.4` — skip extraction, type falls back to generic tokens + fingerprint only (same as unmatched)

```json
{
  "matched": [
    { "target_type": "blog_post", "ref_url": "/blog/some-post", "confidence": 0.9 },
    { "target_type": "doctor_profile", "ref_url": "/team/jane-doe", "confidence": 0.7 },
    { "target_type": "faq", "ref_url": "/help", "confidence": 0.5, "low_confidence": true }
  ],
  "unmatched": ["contact", "legal"],
  "generic": ["/", "/about"]
}
```

#### Phase 2: Extract (full fan-out)

For EACH page in the catalog (matched + generic), run 2 extraction agents in parallel. All pages also run in parallel with each other.

```
page-1: visual | measurement    ← both concurrent
page-2: visual | measurement    ← all pages concurrent
page-3: visual | measurement
generic: visual | measurement
```

N pages × 2 agents, all concurrent. For a site with 5 matched types + 2 generic = 14 parallel agents. Provider concurrency limit: cap at 45 concurrent LLM calls, queue the rest. Circuit-break after 3 consecutive provider errors.

| Agent | Tool | Extracts |
|-------|------|----------|
| **Visual** | Screenshots (3 viewports: 375px, 768px, 1440px) + vision model | Style fingerprint dimensions, design intent, section patterns, visual hierarchy, responsive layout shifts. Produces per-page markdown + screenshots (the weak pattern output). |
| **Measurement** | Playwright computed styles + state triggering | Colors (converted to OKLCH — see note), typography (families, scale, weights), spacing values, border-radius, shadows, grid structures, container widths, section spacing rhythm, component identification, variant discovery (hover/focus/active/disabled style diffs), section-level composition patterns. Measures at 3 viewports (375px, 768px, 1440px) to capture responsive breakpoint behavior. |

**Computed style limitations and mitigations:**

- `getComputedStyle` returns resolved pixels, not authored values. The merge step must infer the design scale (e.g., cluster `[8, 16, 24, 32, 48]px` → `8px base, 2×/3×/4×/6× scale`).
- CSS custom properties (`--spacing-4`) are invisible in computed styles. The measurement agent should also extract `document.styleSheets` rules to recover variable names where possible.
- Pseudo-elements (`::before`, `::after`) require explicit `getComputedStyle(el, '::before')` calls. The agent must check for decorative pseudo-elements on key components.
- Transitions/animations: the measurement agent captures `transition` and `animation` shorthand properties from stylesheets, not computed snapshots.

**OKLCH conversion:** Playwright returns `rgb()`/`rgba()`. The measurement agent converts to OKLCH using `culori` (or equivalent) within the Playwright context. Note: sRGB→OKLCH is lossless for in-gamut colors. Out-of-gamut values (rare in web CSS) are clipped with a warning logged.

#### Phase 3: Merge (agent — LLM-driven)

An LLM synthesizes all per-page extraction results into the 3 canonical JSONs. This is the hardest reasoning task in the segment — reconciling noisy, sometimes contradictory measurements into a coherent design system.

**Reconciliation rules (the merge agent's decision framework):**

- **Spacing scale:** Cluster all measured spacing values (e.g., `[7, 8, 9, 15, 16, 17, 23, 24, 32, 48]`) into a clean scale using nearest-neighbor clustering. Pick the median of each cluster. Infer the base unit and multipliers (e.g., `8px base → 1×, 2×, 3×, 4×, 6×`). Values from `low_confidence` pages are included in clustering but don't anchor clusters.
- **Color roles:** A color appearing on ≥3 pages in similar contexts (buttons, links, headings) is a semantic role. A color on 1 page is page-specific and excluded from the global palette. When two candidates compete for the same role (e.g., two "primary" blues), prefer the one from the homepage/generic pages. All colors reported as OKLCH — preserve lightness/chroma relationships.
- **Typography scale:** Same clustering approach as spacing. Font families appearing on ≥2 pages become the canonical set. A family on 1 page only is noted as a variant, not promoted.
- **Component dedup:** Same component type found on N pages → one canonical recipe. Variants are unified: if page-1's button has `size: sm/md` and page-3 has `size: md/lg`, the recipe gets `sm/md/lg`. State styles (hover, focus, etc.) are merged with the most complete page's version winning ties.
- **Fingerprint aggregation:** Each dimension is the weighted mean across pages (generic pages weighted 2×, matched pages 1×, low-confidence pages 0.5×). Per-dimension variance is reported — high variance (>0.3) signals the site has intentionally different moods per section.
- **Conflict resolution default:** When no rule above applies, prefer data from the homepage. The homepage is the most intentional expression of the brand.

**Merge sub-tasks:**

- **Token synthesis:** Apply reconciliation rules above. Build the 7-layer hierarchy from clustered measurements.
- **Recipe synthesis:** Deduplicate components, merge variants, promote repeated section patterns into section-level recipes.
- **Fingerprint synthesis:** Weighted aggregation with variance tracking.
- **Pattern compilation:** Organize the visual agents' markdown + screenshots into the `patterns/` directory. (Programmatic — no LLM needed.)

### Validation

**Programmatic (required — gate):**
- Zod validation of all 3 JSON outputs against their TypeScript interfaces
- All color values parseable as OKLCH
- All 7 token layers non-empty
- Component recipes have base + at least 1 variant each
- Spacing scale has ≥4 steps and a detectable base unit
- Typography scale has ≥3 distinct sizes

**Semantic AI review (required — gate):**
- Given: the reference site screenshots (from visual extraction) + the 3 output JSONs
- Question: "If these tokens were applied to a blank site, would the result look like these screenshots?"
- Checks: token completeness (are major visual features represented?), coherence (do the tokens form a consistent system?), fidelity (do values match what's visible in screenshots?)
- On failure: return specific deficiencies to merge agent for targeted re-synthesis (max 2 retries)

**Retry policy:** Programmatic failures → re-run merge with error context. Semantic review failures → re-run merge with reviewer feedback. Max 2 retries total. If still failing after retries, emit a warning and proceed — downstream design segment can compensate with its own visual reference.

### Profile Recommendations

All LLM steps run on the configured provider pool (minimax, glm, kimi). For critical singleton steps (merge, semantic review), use multi-provider consensus from the reviewer matrix.

| Step | Provider strategy | Rationale |
|------|-------------------|-----------|
| Scout | Single provider | Navigation + page matching — focused task, one provider sufficient |
| Visual extraction | Single provider (vision-capable: kimi) | Screenshot analysis — fan-out step, cost-sensitive |
| Measurement extraction | Single provider | Playwright + computed style extraction — narrow task |
| Merge | Multi-provider consensus | Hardest reasoning task — run on all 3 providers, reconcile |
| Semantic reviewer | Multi-provider (vision-capable subset) | Fidelity check — consensus catches more gaps |
| Programmatic checks | N/A | No LLM needed |

### Cost Estimate

Rough per-run token budget for analyze segment (7 pages):

| Step | Calls | Est. tokens per call | Subtotal |
|------|-------|---------------------|----------|
| Scout | 1 | ~10k in, ~3k out | ~13k |
| Visual extraction | 7 | ~5k in (images), ~4k out | ~63k |
| Measurement extraction | 7 | ~3k in, ~6k out | ~63k |
| Merge | 1 (+up to 2 retries) | ~40k in (all extractions), ~15k out | ~55k–165k |
| Semantic review | 1 (+up to 2 retries) | ~10k in (images + JSONs), ~2k out | ~12k–36k |
| **Total** | | | **~200k–340k tokens** |

Provider concurrency: cap at 45 simultaneous LLM calls. Queue overflow with FIFO ordering.

---

## Evidence + Review System (All Segments)

Cross-cutting architecture for quality gates. Applies to analyze, wireframe, and design.

### Principle

Each reviewer is an **autonomous agent** with tools (Bash, Read, Playwright, vision). It runs its own checks, writes evidence, writes a review, and returns VERDICT: PASS or REJECT. No orchestration layer passing data between steps — each reviewer owns its entire workflow end to end.

### Folder Structure

Evidence and reviews live inside the workdir, indexed by iteration number:

```
workdir/
  src/                          ← project files
  public/
  evidence/
    1/                          ← first attempt
      build.json
      biome.json
      typecheck.json
      knip.json
      link-check.json
      console-errors/
        landing.json
        blog-post-1.json
        ...
      screenshots/
        landing-desktop.png
        landing-tablet.png
        landing-mobile.png
        ...
    2/                          ← retry after rejection
      build.json
      ...
  reviews/
    1/
      static-checks.md
      console-review.md
      vision-review.md
      trace-review.md
    2/
      ...
```

The workdir IS the project. Evidence and reviews accumulate inside it. When a phase passes and the next phase starts, it inherits the same workdir — project files, evidence trail, everything carries forward. Reviewers from iteration 2 can read iteration 1's evidence to see what changed.

### Reviewer Types

**Static checks reviewer** (agent with Bash)
- Runs: `bun run check` (biome + tsc + knip), `astro build`, `lychee dist/` (link + image checking)
- Writes all command output to `evidence/<iteration>/`
- Interprets results, writes `reviews/<iteration>/static-checks.md`
- Returns VERDICT

**Console error reviewer** (agent with headless isolated Playwright)
- Visits every page in the built site
- Captures all console errors/warnings per page
- Writes to `evidence/<iteration>/console-errors/`
- Summarizes patterns, writes `reviews/<iteration>/console-review.md`
- Returns VERDICT

**Vision reviewer** (agent with headless isolated Playwright + vision model)
- Takes full-page screenshots at 375px, 768px, 1440px
- Samples 1-3 pages per page type (not all pages)
- Vision model analyzes for: broken layout, overflow, missing content, empty sections, broken image icons, overlapping elements
- Writes screenshots to `evidence/<iteration>/screenshots/`
- Writes `reviews/<iteration>/vision-review.md`
- Returns VERDICT

**Trace reviewer** (agent with Read)
- Reads other reviewers' evidence (link-check.json, build errors, console errors)
- Traces each error back to source `.astro` file + line number
- Determines: content data bug vs template binding bug vs missing asset
- Writes `reviews/<iteration>/trace-review.md` with exact file:line + fix instructions
- Returns VERDICT

### Playwright Isolation

Each reviewer that needs a browser gets its own headless browser context — no shared state, no port conflicts. Multiple Playwright reviewers can run in parallel safely.

### Rejection Flow

If any reviewer returns REJECT:
1. All `reviews/<iteration>/*.md` files are aggregated into `rejectionContext`
2. Next iteration's implementer agent reads the reviews
3. Implementer fixes the identified issues in the workdir
4. New reviewer run writes to `evidence/<iteration+1>/` and `reviews/<iteration+1>/`
5. Full paper trail preserved across all attempts

### Multi-Provider Reviewer Matrix

For singleton reviewers (single instance, not fanned out) and critical merge steps, run the same task across multiple providers in parallel. Different models have different blind spots — consensus catches more issues.

**Aggregation rule:** Any single REJECT from any provider = REJECT. Rejection context merges all findings from all providers. PASS requires unanimous agreement.

**Configuration in `cui.yaml`:**

```yaml
# Provider pool — all LLM work runs on these models
providers:
  minimax: { provider: minimax, model: minimax-latest }
  glm: { provider: glm, model: glm-latest }
  kimi: { provider: kimi, model: kimi-latest }        # only kimi has vision capability

# Reviewer matrix — configure which providers run for each step
reviewer_matrix:
  # Default: single provider (used for fan-out steps where cost matters)
  default:
    providers: [minimax]

  # Critical singleton steps — multi-provider for consensus
  critical:
    providers: [minimax, glm, kimi]
    aggregation: any_reject  # any REJECT = REJECT, PASS requires unanimity

  # Vision steps — only providers with vision capability
  vision:
    providers: [kimi]        # expand when other providers add vision
    aggregation: any_reject

  # Vision + consensus — critical steps needing vision
  vision_critical:
    providers: [kimi, minimax]   # minimax reviews text artifacts, kimi reviews screenshots
    aggregation: any_reject

# Per-step overrides — assign a matrix to specific steps
step_matrix:
  # Analyze segment
  analyze.extract.visual: vision           # needs vision
  analyze.extract.measurement: default     # fan-out, cost-sensitive
  analyze.merge: critical                  # hardest reasoning — all 3 providers
  analyze.semantic-review: vision_critical # needs screenshots + consensus

  # Wireframe Phase 2d sub-merges
  wireframe.classify.reconcile-registry: critical
  wireframe.classify.reconcile-content-model: critical
  wireframe.classify.reconcile-component-manifest: critical

  # Wireframe reviewers
  wireframe.generate.static-checks: default
  wireframe.generate.console-reviewer: default
  wireframe.generate.vision-reviewer: vision
  wireframe.generate.content-completeness: default    # programmatic tier is free, LLM tier uses default
  wireframe.generate.trace-reviewer: critical         # pass 2, critical

  # Design reviewers
  design.generate.vision-reviewer: vision
  design.generate.fidelity-reviewer: vision_critical
```

This lets you tune the provider mix per step without code changes. Add or remove providers, change models, adjust which steps get multi-provider treatment — all in config.

### Per-Segment Reviewer Configuration

| Segment | Static checks | Console errors | Vision | Trace | Segment-specific |
|---------|:---:|:---:|:---:|:---:|---|
| **Analyze** | Zod validation | — | — | — | Token completeness reviewer, Vision fidelity reviewer (compares screenshots vs tokens) |
| **Wireframe** | build + biome + tsc + knip + lychee | All pages | 1-3 per type (multi-provider) | Yes (multi-provider) | Content coverage check |
| **Design** | build + biome + tsc + knip + lychee | All pages | 1-3 per type (multi-provider) | Yes (multi-provider) | WCAG contrast reviewer, Design fidelity reviewer (multi-provider) |

---

## Segment 2: Wireframe

**Purpose:** Transform scraper output into a working, unstyled Astro.js project with CMS-ready content, exportable schema, and component inventory.

**Input:** Scraper output directory (structure.json, schema.json, content.json)

### Output Contract

| Artifact | Purpose | Used by |
|----------|---------|---------|
| `content-model.json` | CMS schema — typed fields, exportable to Directus/SonicJS | CMS setup, design segment |
| `component-manifest.json` | Component inventory + data sources + where each is used | Design segment |
| `registry.json` | Page type → collection/singleton/listing/taxonomy/archive + routes | Design segment |
| `asset-manifest.json` | Original image URL → sanitized local path mapping | Content transform, design segment |
| `src/content/` | CMS-ready JSON content files (richtext as HTML strings, typed fields) | Astro build, CMS import |
| `src/data/` | Singletons + globals (navigation, footer, site settings) | Astro build, CMS import |
| `src/content.config.ts` | Astro v6 content config — Zod schemas + loaders for all collections | Astro build (type safety + validation) |
| `src/pages/` | Route files using query layer (`queryCollection`, `getAdjacent`, etc.) | Astro build |
| `src/components/` | Unstyled semantic HTML components + React island stubs | Design segment styles these |
| `public/images/` | Downloaded + sanitized image assets (local build) | Astro build |

### Content Type Taxonomy

| Type | What it is | CMS concept | Astro pattern | Example |
|------|-----------|-------------|---------------|---------|
| **Collection** | Repeated entries, same schema | Document type | `getCollection()` + `[slug].astro` | Blog posts, doctors, services |
| **Singleton** | One-off page, unique schema | Singleton document | `src/data/<pagetype>.json` | About, contact, home |
| **Listing** | Renders filtered/sorted collection query | View (no own content) | Page calling `getCollection()` + filter/sort | Blog index, team directory |
| **Taxonomy** | Listing filtered by category/tag | Taxonomy term | `[category].astro` with filtered query | Blog categories, service areas |
| **Archive** | Listing filtered by date | Date-based view | `[year]/[month].astro` | Monthly blog archives |
| **Global** | Shared across all pages | Settings / globals | `src/data/globals/` | Nav, footer, site settings |
| **Fragment** | Reusable content block embedded in pages | Snippet / block | Shared component with data prop | CTA banner, testimonial row |

### Content Architecture

Three layers + pre-built search.

```
┌─────────────────────────────────────────────────────┐
│  src/content.config.ts          DATA LAYER           │
│  Astro Content Collections + Zod schemas             │
│  → validation, typing, file-based loading            │
├─────────────────────────────────────────────────────┤
│  src/lib/content.ts             QUERY LAYER          │
│  Cached queries, indexed lookups, taxonomy helpers   │
│  → templates import from here, not astro:content     │
├─────────────────────────────────────────────────────┤
│  src/lib/cms/                   CMS SYNC LAYER       │
│  Swappable adapter: push/pull between files and CMS  │
│  → see CMS-ADAPTER-SPEC.md                           │
└─────────────────────────────────────────────────────┘

Search: Pagefind is pre-built in the template (src/components/Search.tsx + build script).
No pipeline work needed — it indexes automatically on `bun run build`.
```

**Flow:**
1. Pipeline generates content as Astro content collection JSON files + `content.config.ts` Zod schemas
2. Initial CMS seed: `bun run cms:push` reads `src/content/` → pushes to CMS via adapter
3. Ongoing: content editors work in CMS → webhook triggers `bun run cms:pull:build` → overwrites `src/content/*.json` → `astro build` (includes Pagefind indexing)
4. Astro project never changes — only the JSON data files change

**Separate spec:**
- **[CMS-ADAPTER-SPEC.md](CMS-ADAPTER-SPEC.md)** — adapter interface, SonicJS implementation, field type mapping, push/pull flows, swapping CMS guide

#### Query Layer (`src/lib/content.ts`)

Thin helpers over Astro's native API. Adds caching (one load per collection per build) and indexed lookups (O(1) instead of O(N) at 10k entries). ~80 lines, generated by Phase 3.

**Public API:**

| Function | Purpose | Performance |
|----------|---------|-------------|
| `queryCollection(name, { filter, sort, limit, offset })` | Filtered + sorted collection query. Cached. | O(N) filter, O(1) cache hit |
| `getByField(name, field, value)` | Lookup by field value. Indexed. | O(1) after first call |
| `getAdjacent(name, id, sort)` | Prev/next navigation in sorted collection. | O(N log N) sort, cached |
| `getTaxonomy(name, field)` | Distinct field values with counts. Indexed. | O(1) after first call |
| `getEntry(collection, id)` | Re-export of Astro's native `getEntry`. | O(1) |
| `getEntries(references)` | Re-export of Astro's native `getEntries`. | O(N) |

**Performance at 10k entries:** First call loads + caches (~10ms). All subsequent calls are instant. Build with 10k pages: ~2-5 min (Astro parallelizes page generation).

### Astro Content Collection Constraints

These constraints affect how Phase 4 templates are written:

- **No cross-collection queries.** To get "all posts by author X", you must `getCollection('blog')` then `.filter()`. Every listing/taxonomy page does its own filtering.
- **No built-in pagination.** `getCollection()` returns all entries. Use `paginate()` in `getStaticPaths()` for paginated routes.
- **Sort order is non-deterministic.** Always sort explicitly after `getCollection()`.
- **No singletons.** Use `getEntry('about', 'site')` pattern for single-entry collections.
- **`reference()` is not auto-resolved.** Must call `getEntry()` / `getEntries()` to resolve references. No eager loading.
- **JSON entries have no `render()`.** Only Markdown/MDX entries support `render()` → `<Content />`. HTML richtext uses `set:html` instead.
- **Astro v6: config at `src/content.config.ts`** (not `src/content/config.ts`). Uses `glob()` / `file()` loaders, no `type` property.

### Template Pre-built Features

The Astro template ships with these features already implemented. Phase 4 agents must USE them, not recreate them.

| Feature | File | What it does |
|---------|------|-------------|
| **Search component** | `src/components/Search.tsx` | React island using Pagefind JS API. Renders search input + dropdown results. Use as `<Search client:load />` in Layout. |
| **Query layer** | `src/lib/content.ts` | Cached collection access, indexed field lookups, taxonomy helpers. All page templates import from here — never from `astro:content` directly. |
| **Pagefind build** | `package.json` `build` script | `astro build && pagefind --site dist` — search index is generated automatically on every build. |
| **CMS sync** | `src/lib/cms/adapter.ts`, `sonicjs.ts`, `cli.ts` | Push/pull between Astro content files and CMS. Scripts: `cms:push`, `cms:pull`, `cms:pull:build`. |
| **Build scripts** | `package.json` | `build`, `build:astro`, `build:search`, `cms:push`, `cms:pull`, `cms:pull:build` |

**Pagefind attributes** — Phase 4 agents must apply these to generated templates:

| Element | Attribute | Purpose |
|---------|-----------|---------|
| Main content (`<article>`, `<main>`) | `data-pagefind-body` | Index this content |
| Nav, footer, sidebar chrome | `data-pagefind-ignore` | Exclude from search |
| Page type indicator | `data-pagefind-meta="type:{pagetype}"` | Type-filtered search |
| Collection detail pages | `data-pagefind-meta="collection:{name}"` | Collection-filtered search |
| Tag/category elements | `data-pagefind-filter="tag:{value}"` | Faceted filtering |

### Phases

#### Phase 1: Reduce (programmatic)

Zero AI. Prepares the scraper data for classification.

- Group pages by pagetype, count instances (multi vs single)
- Extract richest + simplest sample per page type
- Download all referenced images:
  - Content-addressed naming: `/images/<collection>/<slug>/<field>.ext`
  - For repeater items: `/images/<collection>/<slug>/<field>-<index>.ext`
  - For singletons: `/images/<pagetype>/<field>.ext`
  - Path encodes content location, so conflicts are structurally impossible
  - If genuinely identical content location has multiple images, disambiguate with content-derived differentiator (e.g., platform name for social icons) or array index
  - Build `asset-manifest.json` mapping original URL → sanitized local path
  - Flag failed downloads (404, timeout) as warnings
- Rewrite internal links from absolute to relative (matching against structure.json URLs → Astro route patterns)
- Flag CMS-specific URLs (Elementor popups, WordPress admin links) for removal
- Flag explicitly external links (social media, app stores) to preserve as absolute
- Output: `reduced/` directory + `asset-manifest.json`

#### Phase 2: Classify (AI — 3 parallel classifiers + programmatic checks + review + merge)

**Step 2a: Three classifiers in parallel (one sample per page type each)**

| Classifier | Reads | Produces |
|-----------|-------|----------|
| **Architecture** | structure.json + schema.json | Page type classifications: collection, singleton, listing, taxonomy, archive. Routing patterns. Slug fields. **Global content identification:** which sections are layout components (navbar, footer, header chrome, floating widgets, cookie consent) shared across pages — extracted to `src/data/globals/`. |
| **Content Model** | schema.json + content.json samples | Per-field classification: scalar, richtext, media, repeater, relationship. **Richtext composition specs:** which nested objects compose into single richtext blocks, field ordering, render_as (paragraph/heading/image) per constituent field. |
| **Interaction + Components** | schema.json + content.json samples + structure.json | Interactive patterns: forms (with field schemas), search, filters, tabs, accordions, carousels, modals. **Component identification:** which repeaters → which component types, shared vs page-specific components, global vs page-specific, component hierarchy. |

**Step 2b: Programmatic validation of classifier outputs**

Cross-reference checks (Zod + code):
- Every pagetype from structure.json appears exactly once across classifiers
- No orphan page types (in source but not classified) or phantom types (classified but not in source)
- Collection types must have `count > 1` in source data; singletons must have `count === 1`
- Listing/taxonomy types must reference a valid collection
- Richtext composition specs: all `compose_from` field names exist in the source schema
- Relationship targets point to collections that exist in the architecture classification
- All route patterns are valid Astro routes (no duplicates, valid `[slug]` params)
- Component names don't collide
- At least one global nav + footer identified

**Step 2c: Review (AI)**
- Cross-check consistency across all three classifier outputs
- Verify the programmatic checks passed
- Semantic review: do the classifications make sense? Is a "services" page really a collection or should it be a singleton with repeater blocks?

**Step 2d: Reconcile (incremental multi-provider merge)**

The merge is too critical for a single LLM call. Break it into three sequential sub-merges, each producing one artifact, with programmatic validation between each. Each sub-merge runs on multiple providers in parallel for consensus.

**Step 2d-1: Build `registry.json`**
- Primary source: Architecture classifier
- Enriched by: Content Model (slug fields), Interaction (listing/filter patterns)
- Multi-provider: run on N providers (configured in `cui.yaml` reviewer matrix), compare outputs
- Programmatic diff: same page types? Same classifications? Same routes?
- Where providers agree → take it. Where they disagree → flag for conflict resolution.
- Programmatic check after merge: every pagetype accounted for, routes valid, collection counts match source data
- Output: `registry.json`

**Step 2d-2: Build `content-model.json`**
- Primary source: Content Model classifier
- Validated against: `registry.json` (relationships must point to real collections)
- Multi-provider: same N providers, compare outputs
- Programmatic diff: same field types? Same composition specs? Same relationships?
- Programmatic check: every field classified, composition specs reference real schema fields, no contradictions
- Output: `content-model.json`

**Step 2d-3: Build `component-manifest.json`**
- Primary source: Interaction + Components classifier
- Validated against: `registry.json` (page types exist) + `content-model.json` (field names exist)
- Multi-provider: same N providers, compare outputs
- Programmatic check: no orphan components, globals present, `used_by` matches real page types
- Output: `component-manifest.json`

**Step 2d-4: Cross-validation (programmatic)**
- Every collection in registry is referenced by at least one relationship or listing
- Every relationship in content-model points to a collection in registry
- Every component in manifest references page types in registry and fields in content-model
- Every field in every pagetype's schema.json has a classification in content-model
- No orphans anywhere across all three artifacts

**Step 2d-5: Conflict resolution (AI, only if needed)**
- If any provider disagreements remain after programmatic checks
- Single agent sees all provider outputs + the specific conflicts flagged
- Resolves each conflict with full context
- Final programmatic validation pass

Example `component-manifest.json`:

```json
{
  "global": {
    "MainNav": { "data_source": "globals.navigation", "type": "astro" },
    "Footer": { "data_source": "globals.footer", "type": "astro" },
    "BookingForm": { "data_source": "globals.booking_form", "type": "react-island" }
  },
  "shared": {
    "DoctorCard": { "used_by": ["doctor_listing", "landing"], "fields": ["image", "name", "titles", "url"] },
    "ServiceCard": { "used_by": ["services", "landing"], "fields": ["title", "description", "image", "link"] },
    "TestimonialCard": { "used_by": ["landing", "about"], "fields": ["quote", "author", "role"] }
  },
  "page_specific": {
    "DoctorSidebar": { "page_type": "doctor_profile", "type": "dynamic", "queries": "doctors_by_category" }
  },
  "interactive": {
    "ContactForm": { "type": "react-island", "fields": ["name", "email", "phone", "date", "time", "description"] },
    "WhatsAppWidget": { "type": "react-island", "trigger": "floating" },
    "SearchFilter": { "type": "react-island", "page_type": "doctor_listing" }
  }
}
```

#### Phase 3: Transform + Seed (programmatic, zero AI)

Applies Phase 2 specs to all pages mechanically:

- Copy Astro template into workdir
- For each collection in registry:
  - Iterate all pages of that type in content.json
  - Apply content-model composition specs:
    - Richtext fields: walk `compose_from` fields in order, emit HTML (`<p>`, `<h2>`, `<img>` with local paths from asset manifest)
    - Scalar/media fields: copy as typed values, rewrite image URLs via asset manifest
    - Repeater fields: copy as typed JSON arrays
    - Relationships: resolve to target collection slugs
  - Write to `src/content/<collection>/<slug>.json`
- For each singleton: same transform → `src/data/<pagetype>.json`
- Extract globals (nav, footer, settings, floating widgets) per architecture classifier → `src/data/globals/`
- Generate `src/content.config.ts` with Zod schemas + loaders derived from content-model.json (see generated example below)
- Relationship fields must be written as the target entry's slug string (Astro's `reference()` resolves by ID, not by nested object or URL)
- **Pre-built in template (do NOT generate):** `src/lib/content.ts` (query layer), `src/lib/cms/` (adapter + SonicJS + CLI), `src/components/Search.tsx` (Pagefind), build scripts. These ship with the template and work with any collection.
- Validate: every source page accounted for, no orphans, asset manifest complete, all referenced images exist in `public/images/`

**`src/content.config.ts` generation (Astro v6 format):**

Phase 3 programmatically generates the content config from `content-model.json`. Example output:

```typescript
// src/content.config.ts — GENERATED, do not edit
import { defineCollection, reference } from 'astro:content';
import { glob, file } from 'astro/loaders';
import { z } from 'astro/zod';

const doctors = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/doctors' }),
  schema: z.object({
    name: z.string(),
    titles: z.array(z.string()),
    bio: z.string(),                    // richtext — raw HTML, render with set:html
    image: z.string(),                  // /images/doctors/jane-doe/avatar.jpg
    category: z.string(),
    phone: z.string().optional(),
    email: z.string().optional(),
  }),
});

const blog = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    body: z.string(),                   // richtext
    date: z.coerce.date(),
    author: reference('doctors'),       // resolves to doctor entry by slug
    tags: z.array(z.string()),
    image: z.string().optional(),
  }),
});

// Singletons — single-entry file() collections
const about = defineCollection({
  loader: file('./src/data/about.json'),
  schema: z.object({
    title: z.string(),
    body: z.string(),                   // richtext
    team_intro: z.string(),
  }),
});

// Globals
const navigation = defineCollection({
  loader: file('./src/data/globals/navigation.json'),
  schema: z.object({
    items: z.array(z.object({
      label: z.string(),
      url: z.string(),
      children: z.array(z.object({
        label: z.string(),
        url: z.string(),
      })).optional(),
    })),
  }),
});

export const collections = { doctors, blog, about, navigation /* ... */ };
```

**How templates use the query layer:**

```astro
---
// Collection listing page: src/pages/doctors/index.astro
import { queryCollection } from '@/lib/content';
const doctors = await queryCollection('doctors', {
  sort: (a, b) => a.data.name.localeCompare(b.data.name),
});
---

// Collection detail page: src/pages/doctors/[...slug].astro
import { queryCollection, getAdjacent, getEntry } from '@/lib/content';
export async function getStaticPaths() {
  const doctors = await queryCollection('doctors');
  return doctors.map(doc => ({ params: { slug: doc.id }, props: { doctor: doc } }));
}
const { doctor } = Astro.props;
const { prev, next } = await getAdjacent('doctors', doctor.id,
  (a, b) => a.data.name.localeCompare(b.data.name));

// Resolve reference
const author = await getEntry(post.data.author);

// Singleton: src/pages/about.astro
import { getEntry } from '@/lib/content';
const about = await getEntry('about', 'site');

// Global: src/components/MainNav.astro
import { getEntry } from '@/lib/content';
const nav = await getEntry('navigation', 'site');

// Richtext: render raw HTML
<div set:html={doctor.data.bio} />

// Taxonomy page: src/pages/blog/tags/[tag].astro
import { getTaxonomy, getByField } from '@/lib/content';
export async function getStaticPaths() {
  const tags = await getTaxonomy('blog', 'tags');
  return tags.map(t => ({ params: { tag: t.value }, props: { tag: t.value, count: t.count } }));
}
const posts = await getByField('blog', 'tags', Astro.props.tag);

// Paginated listing: src/pages/blog/[...page].astro
import { queryCollection } from '@/lib/content';
export async function getStaticPaths({ paginate }) {
  const posts = await queryCollection('blog', {
    sort: (a, b) => b.data.date.getTime() - a.data.date.getTime(),
  });
  return paginate(posts, { pageSize: 10 });
}

// Filtered listing: doctors by category
import { getByField } from '@/lib/content';
const cardiologists = await getByField('doctors', 'category', 'cardiology');  // O(1) indexed
```

Templates must apply Pagefind attributes (Search component + indexer are pre-built in template):
- `data-pagefind-body` on main content areas (`<main>`, `<article>`)
- `data-pagefind-ignore` on nav, footer, chrome
- `data-pagefind-meta="type:{pagetype}"` for filtered search

#### Phase 4: Generate Wireframe (AI + programmatic — 4 sequential steps)

With less capable models, each generation step must be narrowly scoped. The sequence is: components → layouts → page stubs (programmatic) → per-page content fill. Each step builds on the previous step's concrete output (not manifest descriptions — actual generated code).

**Step 4a: Components** (fan-out — all components in parallel)

Generate all components from the manifest as unstyled semantic HTML. Each agent gets ONE component to build.

- **Global components** (MainNav, Footer, etc.): agent receives `globals/*.json` sample data + component manifest entry
- **Shared components** (DoctorCard, ServiceCard, etc.): agent receives sample content entry showing the fields + manifest entry with `used_by` context
- **Page-specific components**: agent receives page type's content-model + manifest entry
- **Interactive components** → React island stubs (`.tsx`) with `client:load` or `client:visible`, typed props matching content-model fields
- **Rules:** semantic HTML only (`<nav>`, `<article>`, `<section>`, `<aside>`, `<ul>`, `<dl>`). No `<div>` with layout intent. No `class` attributes. No Tailwind. Props must use exact field names from content-model.
- **Pagefind attributes:** add `data-pagefind-body` on main content areas, `data-pagefind-ignore` on nav/footer/chrome, `data-pagefind-meta="type:{pagetype}"` on page wrappers. Search component + indexer are pre-built in the template.

Each component agent also emits a `ComponentAPI` block at the top of the file as a comment:

```astro
---
/**
 * @component DoctorCard
 * @props { image: string; name: string; titles: string[]; url: string }
 * @usage <DoctorCard image={entry.image} name={entry.name} titles={entry.titles} url={entry.url} />
 */
interface Props {
  image: string;
  name: string;
  titles: string[];
  url: string;
}
const { image, name, titles, url } = Astro.props;
---
```

**Step 4a gate (programmatic):** After all component agents complete:

1. **Parse check:** every `.astro` and `.tsx` file must parse without syntax errors (use Astro's parser / TypeScript compiler API). Files that fail parsing are rejected with the exact error — the component agent retries with the parse error in context. Max 2 retries per component.
2. **Props extraction:** extract `interface Props` from each component via TypeScript AST parsing (not comment parsing — comments from weak models are unreliable). Build `component-apis.json` mapping component name → prop types + file path. If a component has no `interface Props`, extraction fails — reject back to agent.
3. **Manifest cross-check:** every component in `component-manifest.json` has a generated file. Every generated file's props include the fields listed in the manifest. Flag mismatches.

Output: `component-apis.json` — the concrete interface contract for all downstream steps.

**Step 4b: Layouts** (sequential — small number of layouts)

Generate layout templates. Each layout agent receives:
- `component-apis.json` (exact props for every component)
- `registry.json` (which page types use which layout)
- `globals/*.json` (for nav/footer placement)
- The actual generated global component files (Layout agent reads them, not the manifest)

Generates:
- `Layout.astro` — HTML shell, `<head>` meta, `<slot/>`, global components (MainNav, Footer) wired with real data from `src/data/globals/`. Include `<Search client:load />` in the nav/header area (Search component is pre-built in the template at `src/components/Search.tsx`).
- Collection layout (if needed): wraps `<slot/>` with collection-level chrome
- Listing layout (if needed): pagination wrapper, filter slots

**Rules:** Layouts wire global components with actual data bindings (`import navigation from '../data/globals/navigation.json'`). No placeholder data. No styling. Import Search from `@/components/Search`.

**Step 4c: Page stubs** (programmatic — zero AI)

Generates all route files as working skeletons. Each stub already has Layout, imports, `getStaticPaths()`, and the query layer wired — so the per-page AI agent in 4d only needs to place components and bind content fields.

For each page type in `registry.json`, generate:

- **Collection detail** (`src/pages/<collection>/[...slug].astro`):
  ```astro
  ---
  import Layout from '@/layouts/Layout.astro';
  import { queryCollection, getAdjacent } from '@/lib/content';
  export async function getStaticPaths() {
    const entries = await queryCollection('<collection>');
    return entries.map(e => ({ params: { slug: e.id }, props: { entry: e } }));
  }
  const { entry } = Astro.props;
  const { prev, next } = await getAdjacent('<collection>', entry.id,
    (a, b) => a.data.<sort_field>.localeCompare(b.data.<sort_field>));
  ---
  <Layout title={entry.data.<title_field>}>
    <!-- CONTENT: place components here -->
  </Layout>
  ```
- **Listing** (`src/pages/<collection>/index.astro` or `[...page].astro` for paginated):
  ```astro
  ---
  import Layout from '@/layouts/Layout.astro';
  import { queryCollection } from '@/lib/content';
  const entries = await queryCollection('<collection>', {
    sort: (a, b) => /* from registry sort spec */,
  });
  ---
  <Layout title="<listing_title>">
    <!-- CONTENT: place list components here -->
  </Layout>
  ```
- **Taxonomy** (`src/pages/<collection>/[tag].astro`): `getTaxonomy()` in `getStaticPaths()`, `getByField()` in page
- **Singleton** (`src/pages/<pagetype>.astro`): `getEntry()` call, Layout wrapper
- **Paginated listing**: uses `paginate()` in `getStaticPaths()`

Sort field and title field are derived from `content-model.json` (first `date` field for sort, first `title`/`name` field for title). Route patterns from `registry.json`.

**Output:** Every page in the site has a working route file that builds successfully (Layout + query layer + empty content area). Running `astro build` at this point produces real pages with nav/footer but no page-specific content.

**Step 4d: Per-page-type content fill** (fan-out — all page types in parallel)

Each parallel agent receives (as concrete files, not descriptions):
- The actual generated stub file for its page type (from 4c) — agent edits this file, does NOT rewrite from scratch
- `component-apis.json` (exact props — agent MUST use these, not invent its own)
- Content-model for its page type
- Sample content entry (1 real entry from `src/content/`)
- The actual generated shared component files relevant to this page type

The agent's job is focused: fill the `<!-- CONTENT -->` area of the stub with components and content bindings. The stub already has Layout, imports, `getStaticPaths()`, and query calls.

Generates (within the existing stub):
- Component imports and placement using exact prop signatures from `component-apis.json`
- Content bindings: `entry.data.<field>` for detail pages, iteration over entries for listings
- Richtext rendering: `<div set:html={entry.data.<richtext_field>} />`
- Additional query calls if needed: `getByField()` for related items, `getAdjacent()` for prev/next links
- Pagefind attributes: `data-pagefind-body` on `<main>`/`<article>`, `data-pagefind-meta` on page wrapper
- Page-specific components from manifest (if not already generated in 4a)

**Rules:** Agent must import from `@/lib/content` (NOT `astro:content` directly). Must import components and call them with exact props from `component-apis.json`. Any prop name mismatch is a build error caught in review. No inline component definitions — use generated components. Do NOT rewrite the stub's `getStaticPaths()` or Layout wrapper — only fill the content area.

**Step 4e: Reviewers** (two passes)

**Pass 1 — parallel, agentic:**

| Reviewer | What it does | Sampling |
|----------|-------------|----------|
| **Static checks** | Runs `bun run check` + `astro build` + `lychee dist/`. Writes evidence, interprets results, writes review. | Exhaustive (all files) |
| **Console errors** | Headless isolated Playwright. Visits every page, captures console errors/warnings. Writes evidence + review. | Exhaustive (all pages) |
| **Vision** | Headless isolated Playwright. Screenshots at 375/768/1440px. Vision model analyzes for broken layout, overflow, missing content, empty sections, broken images. | Sampled: 2-3 pages per page type |
| **Content completeness** | Programmatic + LLM-as-judge (see below). | Sampled: 2-3 pages per page type |

**Pass 2 — after Pass 1 completes:**

| Reviewer | What it does | Sampling |
|----------|-------------|----------|
| **Trace** | Reads Pass 1 evidence (link-check.json, build errors, console errors, content completeness). Traces each error to source `.astro` file + line. Determines: content data bug vs template binding bug vs missing asset. Writes `reviews/<iteration>/trace-review.md` with exact `file:line` + fix instructions. | All errors from Pass 1 |

**Content completeness reviewer (detail):**

Two-tier check — programmatic first (cheap, fast), LLM-as-judge second (catches semantic gaps).

*Tier 1 — Programmatic text match:*
1. For each sampled page: build the site, extract the rendered HTML from `dist/`
2. Strip all HTML tags, collapse whitespace → raw visible text
3. Load the corresponding content JSON entry
4. Extract all string/richtext field values, strip HTML from richtext → raw text
5. For each content field value: fuzzy-match against the rendered text (normalized Levenshtein or token overlap)
6. Score: `matched_fields / total_fields` per page. Threshold: ≥ 0.9 = PASS, < 0.9 = flag for Tier 2
7. Missing fields are listed by name: "field `phone_number` not found in rendered output"

*Tier 2 — LLM-as-judge (only for flagged pages):*
1. Agent receives: the content JSON entry + the rendered HTML (not screenshot — raw HTML is cheaper and more precise for content checking)
2. Question: "Does this HTML contain all the information from this JSON? List any fields whose content is missing or significantly altered."
3. Returns: list of missing/altered fields with severity (critical = main content missing, minor = metadata like dates/tags)

**On REJECT — fix loop (max 3 iterations):**

The fix loop runs in two sub-phases to prevent component bugs from cascading into every page:

**Fix sub-phase 1: Component fixes** (only if trace review identifies component-level errors)
- Fan-out: one fix agent per broken component
- Agent receives: the component file + trace review entries for that component + `component-manifest.json` entry + sample content showing expected props
- Agent edits the component file in place
- After all component fixes: re-run the 4a gate (parse check + Props extraction + manifest cross-check)
- Update `component-apis.json` if props changed

**Fix sub-phase 2: Page fixes** (fan-out — mirrors Step 4d structure)
- One fix agent per page type that has errors
- Agent receives: its page file + trace review entries for that page type + `component-apis.json` (possibly updated from sub-phase 1) + content-model + sample content entry
- Agent edits the page file in place — does NOT rewrite from scratch
- If the trace says "content data bug" (wrong field in JSON, not template): flag for Phase 3 re-run on that collection. Page fix agent cannot modify `src/content/` files.

**Build-breaking short circuit:** If `astro build` fails in Pass 1, the vision/content/console reviewers cannot run (no `dist/` to inspect). In this case, Pass 1 produces only static checks + build errors. The trace reviewer (Pass 2) runs on build errors alone. The fix loop addresses build errors first. After the fix, the full Pass 1 re-runs.

**Context escalation:** Each retry iteration, the fix agent sees the original review + all previous fix attempts + the new review. This accumulates context so the agent doesn't repeat failed fixes. If iteration 3 still fails, the segment halts with the full review history for human inspection.

All evidence is versioned: `reviews/1/`, `reviews/2/`, `reviews/3/`. Each iteration's fix agents write to the same source files (not copies).

#### Phase 5: Final Validation (programmatic gate)

Non-negotiable checks that must all pass:

- `astro build && pagefind --site dist` exits clean (no errors, search index generated)
- `bun run check` passes (biome + tsc + knip)
- `lychee dist/` reports zero broken internal links and zero broken images
- Playwright visits every route — no HTTP 500s, no uncaught exceptions
- Content coverage: every page from content.json has a rendered route
- No remaining original-site absolute URLs (grep for source domain — these are rewrite bugs)
- No Tailwind utility classes in components (grep for `class=` with Tailwind patterns — wireframe must be unstyled)
- All images in asset manifest exist in `public/images/` (local build) or are valid CMS URLs (after `cms:pull`)
- `dist/pagefind/` exists and contains index files

### Profile Recommendations

All steps use the provider pool (minimax, glm, kimi). Multi-provider consensus for critical steps compensates for individual model limitations.

| Step | Provider strategy | Rationale |
|------|-------------------|-----------|
| Architecture classifier | Single provider | Focused on page types + routes — narrow enough for one model |
| Content Model classifier | Single provider | Field-level semantics — narrow task |
| Interaction + Components classifier | Single provider | Pattern recognition — narrow task |
| Review (2c) | Multi-provider consensus | Cross-check consistency — consensus catches blind spots |
| Reconcile sub-merges (2d) | Multi-provider consensus | Critical artifacts — each sub-merge on all 3 providers |
| Component generation (4a) | Single provider | Per-component — fan-out, narrow task |
| Layout generation (4b) | Single provider | Small number of layouts, reads concrete files |
| Page stubs (4c) | N/A | Programmatic — no LLM needed |
| Per-page content fill (4d) | Single provider | Fan-out, fills stubs with components — narrow task |
| Static checks reviewer | Single provider | Interprets build/lint output — straightforward |
| Console error reviewer | Single provider | Captures + summarizes errors — straightforward |
| Vision reviewer | Vision-capable provider (configurable) | Screenshot analysis — needs vision capability |
| Content completeness | Programmatic + single provider (Tier 2 only) | Tier 1 is free; Tier 2 LLM only for flagged pages |
| Trace reviewer | Multi-provider consensus | Pass 2, reads all evidence — critical for fix quality |
| Programmatic steps | N/A | No LLM needed |

---

## Segment 3: Design

**Purpose:** Apply all visual treatment to the unstyled wireframe project, transforming semantic HTML into a fully styled site that replicates the reference design. This is the fan-in point: it merges wireframe's structural project with analyze's design tokens, component recipes, and style fingerprint.

**Depends on:** analyze, wireframe

**Input:**

From analyze segment (output directory):
- `style-fingerprint.json` — 8 style dimensions + treatments
- `design-tokens.json` — 7-layer token architecture (atomic, gradients, layout, componentSpacing, motion, surfaces, visualIdentity)
- `component-recipes.json` — per-component CSS bundles (base + variants + states)
- `patterns/` — optional markdown + screenshots per page type

From wireframe segment (output directory):
- Working unstyled Astro project: `src/content/`, `src/content.config.ts`, `src/components/`, `src/pages/`, `src/layouts/Layout.astro`, `src/lib/content.ts`, `src/lib/utils.ts`
- `component-manifest.json` — component inventory with data sources and usage
- `registry.json` — page type registry with routes and classifications
- `content-model.json` — CMS schema
- `asset-manifest.json` — image URL mapping
- `public/images/` — downloaded assets

From template (carried through wireframe):
- `src/styles/globals.css` — Tailwind v4 CSS-first config with Shadcn CSS variable structure, `:root` and `.dark` blocks
- `components.json` — Shadcn configuration (new-york style, TSX, OKLCH base)
- PostCSS pipeline (Tailwind v4)

### Output Contract

| Artifact | Description |
|----------|-------------|
| Complete styled Astro project | All wireframe files + visual treatment applied |
| `src/styles/globals.css` | Fully populated: @layer declarations, design token CSS custom properties, typography system, color system (light + dark), motion variables |
| `src/styles/layers.css` | CSS `@layer` definitions for layout, typography, surfaces, color, motion |
| `src/components/ui/` | Shadcn components installed and customized per component-recipes |
| `src/components/*.astro` | Wireframe components with Tailwind classes applied |
| `src/pages/*.astro` | Page files with section-level layout classes |
| `src/layouts/Layout.astro` | Updated with font loading, theme script, meta |
| `quality-scores.json` | 7-dimension quality assessment |

### Merge Inputs

The `mergeInputs` function copies the wireframe's final workdir as the base, then overlays the analyze segment's output into a `tokens/` directory at the project root:

```
workdir/
  tokens/
    style-fingerprint.json
    design-tokens.json
    component-recipes.json
    patterns/             (if present)
  src/
    content/
    components/
    pages/
    layouts/
    styles/globals.css    (template default)
    lib/
  public/images/
  component-manifest.json
  registry.json
  content-model.json
  asset-manifest.json
  components.json         (shadcn config)
  package.json
  astro.config.mjs
  tsconfig.json
```

### CSS Layer Architecture

All visual treatment is organized into CSS cascade layers. Layers are declared once and populated across phases:

```css
@layer layout, typography, surfaces, color, motion;
```

Layer ordering matters: later layers win in cascade conflicts. This ordering means motion can override color (e.g., hover state color changes), color can override surfaces (e.g., themed surface tints), and so on. Each phase in the design segment owns exactly one layer, enforcing phase independence within the segment itself.

### Phase Ordering Rationale

| Phase | CSS Layer | Why this order |
|-------|-----------|----------------|
| 1: Token Injection + Shadcn | (none — setup) | Precondition: CSS custom properties and component primitives must exist before any phase can reference them |
| 2: Layout | `@layer layout` | Grid, spacing, and responsive structure must be established first. All other phases style elements *within* the spatial structure layout creates. Without layout, typography cannot set correct line-lengths, surfaces cannot size correctly, and responsive behavior is undefined. |
| 3: Typography + Surfaces | `@layer typography`, `@layer surfaces` | Typography establishes visual hierarchy (heading scale, body readability, weight contrast). Surfaces establish component shapes (radius, shadows, borders, glass effects). Both are structural-visual properties that must exist before color fills them in. Grouped because they are independent of each other and can be applied in parallel at the component level. |
| 4: Color + Dark Mode | `@layer color` | Color is purely decorative fill applied on top of existing structure. All Shadcn CSS variables (`:root` and `.dark`) are populated here. WCAG contrast validation happens at this boundary. Color MUST come after typography (to validate text contrast) and surfaces (to validate border/shadow contrast). |
| 5: Motion | `@layer motion` | Motion is the final layer. It adds transitions, hover states, scroll reveals. Motion depends on the final visual state (color + surfaces) to know what properties to animate. It must be last because animations reference the computed values from all prior layers. |

### Phases

#### Phase 1: Token Injection + Shadcn Setup (programmatic + single agent)

**Purpose:** Convert analyze outputs into CSS custom properties and install Shadcn component primitives. This is the foundation phase — every subsequent phase references these tokens and components.

**Step 1a: Token-to-CSS conversion** (programmatic — zero AI)

Read `tokens/design-tokens.json` and generate CSS custom properties. This is a deterministic transformation.

**Conversion rules:**

1. **Atomic colors** → Shadcn CSS variable slots in `:root` and `.dark`:
   - Map `tokens.atomic.colors.primary` → `--primary: <oklch value>`
   - Map `tokens.atomic.colors.background` → `--background: <oklch value>`
   - Map all Shadcn semantic slots: primary, secondary, accent, muted, destructive, background, foreground, card, popover, border, input, ring, chart-1..5
   - If a token color has no obvious Shadcn mapping, create an additional `--color-<name>` custom property
   - Dark mode values: if `design-tokens.json` provides dark variants, use those. If not, auto-derive dark variants using OKLCH lightness inversion (L → 1-L, clamp chroma to prevent over-saturation). Flag auto-derived values for Phase 4 review.

2. **Typography** → `--font-family-*`, `--font-size-*`, `--font-weight-*`:
   - `tokens.atomic.typography.fontFamily.heading` → `--font-heading`
   - `tokens.atomic.typography.fontFamily.body` → `--font-body`
   - `tokens.atomic.typography.fontSize.*` → `--text-xs` through `--text-6xl` (map to Tailwind scale names by size order)
   - `tokens.atomic.typography.fontWeight.*` → `--font-weight-*`

3. **Spacing** → `--spacing-*`:
   - `tokens.atomic.spacing.*` → `--spacing-xs`, `--spacing-sm`, etc.
   - Also emit Tailwind v4 `@theme` spacing overrides if the token scale differs from Tailwind defaults

4. **Border radius** → `--radius` (Shadcn base) + `--radius-sm/md/lg/xl`:
   - Map the token's medium radius to `--radius` (Shadcn's base)
   - Compute sm/md/lg/xl as ratios of the base (matching the template's existing `calc(var(--radius) * N)` pattern)

5. **Shadows** → `--shadow-*`:
   - `tokens.atomic.shadows.*` → `--shadow-sm`, `--shadow-md`, `--shadow-lg`

6. **Layout tokens** → `--container-*`, `--grid-*`, `--section-*`, `--rhythm-*`:
   - `tokens.layout.container.maxWidth.*` → `--container-narrow`, `--container-default`, `--container-wide`
   - `tokens.layout.grid.columns.*` → `--grid-cols-*` per breakpoint
   - `tokens.layout.grid.gutter.*` → `--grid-gap-*` per breakpoint
   - `tokens.layout.sections.*` → `--section-<name>-top`, `--section-<name>-bottom`
   - `tokens.layout.rhythm.*` → `--rhythm-base`, `--rhythm-*`
   - `tokens.layout.breakpoints.*` — NOT as CSS custom properties (breakpoints are used in media queries, not property values). Instead emit as comments in `globals.css` for agent reference.

7. **Motion tokens** → `--duration-*`, `--easing-*`:
   - `tokens.motion.duration.*` → `--duration-instant`, `--duration-fast`, `--duration-base`, `--duration-moderate`
   - `tokens.motion.easing.*` → `--easing-default`, `--easing-out`, `--easing-brand`

8. **Gradient tokens** → `--gradient-*`:
   - `tokens.gradients.*` → `--gradient-<name>` as full `linear-gradient()` / `radial-gradient()` values

9. **Surface tokens** → `--glass-*`, `--texture-*`:
   - `tokens.surfaces.glass.*` → `--glass-blur`, `--glass-bg`, `--glass-border`
   - `tokens.surfaces.texture.*` → `--texture-<name>-*`

**Output:** Updated `src/styles/globals.css` with all CSS custom properties populated in `:root` and `.dark` blocks. The `@theme inline` block is updated to reference the new custom properties. A `src/styles/layers.css` file is created with the `@layer` declaration (imported before `globals.css`).

Also output: `tokens/css-variable-map.json` — maps every token path to its CSS custom property name. Downstream agents reference this map, never raw token values.

**Step 1b: Shadcn component installation** (single agent with Bash)

Install Shadcn UI components needed by the project. The agent determines which components to install by cross-referencing `component-manifest.json` and `component-recipes.json` against a built-in mapping table:

| Wireframe pattern | Shadcn components to install |
|-------------------|------------------------------|
| Card, DoctorCard, ServiceCard, etc. | `card` |
| Button, CTA, link-button | `button` |
| Form, ContactForm | `input`, `label`, `textarea`, `select` |
| Navigation, MainNav | `navigation-menu`, `sheet` (mobile drawer) |
| Tabs | `tabs` |
| Accordion, FAQ | `accordion` |
| Modal, Dialog | `dialog` |
| Badge, Tag | `badge` |
| Avatar | `avatar` |
| Dropdown | `dropdown-menu` |
| Carousel | `carousel` |
| Search (already pre-built) | — do NOT install, use existing `src/components/Search.tsx` |

**Installation process:**
1. Agent reads `component-manifest.json` and `component-recipes.json`
2. For each wireframe component, determine which Shadcn primitives are needed
3. Run `bunx shadcn@latest add <component> --yes` for each
4. Shadcn installs to `src/components/ui/` per `components.json` config
5. Agent verifies each installed component file exists

**Rules:**
- Do NOT modify the installed Shadcn component files in this step. Customization happens in Phase 3.
- Do NOT install components that have no corresponding wireframe usage.
- The Search component is pre-built at `src/components/Search.tsx`. Do NOT install a Shadcn search component.

**Step 1c: Font loading setup** (programmatic)

1. Read `tokens/design-tokens.json` → `atomic.typography.fontFamily`
2. For each custom font family (not system fonts): add Google Fonts `<link>` tags to `Layout.astro` `<head>` (with `display=swap`)
3. Update `@theme inline` in `globals.css` with `--font-family-*` references

**Step 1d: Gate** (programmatic)

1. `astro build` must pass (token injection should not break the build)
2. Parse `globals.css` with PostCSS — all custom properties must have valid values, no syntax errors
3. Every installed Shadcn component exists in `src/components/ui/` and parses without errors
4. `css-variable-map.json` has entries for all 7 token layers (at minimum: 1 color, 1 font-family, 1 spacing, 1 radius, 1 shadow, 1 duration, 1 easing)
5. If custom fonts declared, `Layout.astro` contains Google Fonts `<link>` tags

**Retry:** On build failure, fix in code (not AI). If Shadcn install fails, retry specific component (max 2). If font link fails, fall back to system font stack.

---

#### Phase 2: Layout (agent — fan-out per page type, 3 breakpoints)

**Purpose:** Apply spatial structure — grid, flexbox, spacing, containers, responsive breakpoints — to all pages and components. This is the hardest phase (lesson from v2). Uses divide-and-conquer.

**CSS ownership:** `@layer layout` only. Properties: `display`, `grid-template-*`, `flex-*`, `gap`, `padding`, `margin`, `max-width`, `width`, `height`, `min-height`, `aspect-ratio`, `position`, `top/right/bottom/left`, `z-index`, `overflow`, `order`, `place-*`, `align-*`, `justify-*`, responsive variants of all the above.

**Forbidden in this phase:** `color`, `background-color`, `font-*`, `text-*` (except `text-center/left/right`), `border-color`, `shadow`, `opacity` (except `opacity-0` for layout hiding), `transition`, `animation`, `transform` (except for layout shifts), `border-radius`, `backdrop-filter`.

**Mobile-first approach:** Base styles target 375px (mobile). `md:` for 768px (tablet). `lg:` for 1440px (desktop). All three are first-class layouts, not afterthoughts.

**Step 2a: Global layout skeleton** (single agent)

The agent establishes the page-level layout framework that all pages share.

**Receives:**
- `tokens/css-variable-map.json`
- `tokens/design-tokens.json` → layout layer
- `tokens/style-fingerprint.json` → density, formality dimensions
- `src/layouts/Layout.astro`
- `src/components/` — global components (MainNav, Footer)
- `registry.json` — page types and routes

**Produces:**
- Updated `Layout.astro` with container structure, main content area spacing
- `@layer layout { ... }` rules for:
  - Container: `max-width: var(--container-default)`, `margin: 0 auto`, responsive padding (full-bleed on mobile, padded on tablet, max-width on desktop)
  - Section default spacing: `padding-top/bottom` from `--section-default-top/bottom`
  - Body/page-level flex column for sticky footer pattern
- Global component layout: MainNav (sticky/fixed positioning on desktop, hamburger/drawer on mobile), Footer (margin-top: auto)

**Fingerprint influence:**
- `density < 0.3` → generous section spacing, narrow containers (`--container-narrow`)
- `density > 0.7` → compact spacing, wider containers (`--container-wide`)
- `formality > 0.7` → strict grid alignment, consistent column structure across all pages
- `formality < 0.3` → allow asymmetric layouts, varied section structures
- `depth > 0.5` → plan z-index layering for overlapping sections

**Rules:**
- All spacing values MUST reference CSS custom properties from `css-variable-map.json`. No magic pixel values.
- Mobile-first: base styles = 375px. `md:` = 768px. `lg:` = 1440px.
- No `overflow-x: hidden` on `<body>` or `<html>`.

**Step 2b: Per-page-type layout** (fan-out — all page types in parallel)

Each agent applies layout to one page type's files: its page template(s) and page-specific components.

**Receives:**
- The actual page file(s) for its page type (from `src/pages/`)
- The actual components used by this page type (from `src/components/`)
- `tokens/css-variable-map.json`
- `tokens/design-tokens.json` → layout layer + componentSpacing layer
- `tokens/style-fingerprint.json`
- `registry.json` entry for this page type
- `tokens/component-recipes.json` — ONLY the `base` layout-relevant properties (padding, margin, gap) from each recipe
- `tokens/patterns/<page-type>.md` (if present) — visual reference for section structure

**Each agent produces layout for ALL 3 breakpoints:**
- **Mobile (375px)**: single-column stack, full-width cards, collapsed sidebars, touch-friendly spacing (min 44px tap targets)
- **Tablet (768px)**: 2-column grids where appropriate, sidebar may appear, balanced whitespace
- **Desktop (1440px)**: full grid (2-4 columns), sidebars, generous spacing, wide containers

**Shared component conflict resolution:** Shared components (e.g., `DoctorCard`) get their internal layout from the global step (2a). Per-page agents use wrapper `<div>` elements with layout classes to control how shared components are arranged within their page (e.g., grid columns around cards), but do NOT add layout classes to the shared component file itself.

**Step 2c: Three-breakpoint validation gate** (programmatic + vision)

**Programmatic checks (Playwright visits every page at 375px, 768px, AND 1440px):**

1. **Overflow check:** `document.documentElement.scrollWidth > window.innerWidth` at each breakpoint → REJECT. Identify offending elements with `getBoundingClientRect().right > window.innerWidth`.
2. **Touch targets (mobile):** Playwright measures all clickable elements at 375px — all must be ≥ 44×44px.
3. **Token usage audit:** Grep all `.astro` files for hardcoded pixel values in layout properties (`gap-[14px]`, `p-[23px]`). Allow only values that map to a token step. Flag violations.
4. **Layer isolation check:** Grep for forbidden CSS properties (color, font-size, background-color, etc.) in changes made by this phase. Any violations → REJECT with exact file:line.
5. **No `!important`:** Grep for `!important` in any layout rules.

**Vision checks (Playwright + kimi):**
- **Mobile stacking (375px):** Vision model verifies single-column layout — no side-by-side elements that cause tiny text or horizontal scroll.
- **Tablet reflow (768px):** Vision model verifies grid reflows from 1-col to 2-col appropriately.
- **Desktop grid (1440px):** Vision model verifies full grid layout with consistent gutters and aligned content.
- **Nav behavior:** Mobile has hamburger/drawer (not horizontal nav that wraps), desktop has full nav.
- If `patterns/<page-type>.md` exists, compare section structure against the reference screenshots.

**On REJECT:** Fan-out fix: one fix agent per failing page type. Agent receives the specific failing checks + screenshots. Max 3 iterations.

---

#### Phase 3: Typography + Surfaces (agent — fan-out per component + global)

**Purpose:** Apply the visual design system: font families, sizes, weights, heading hierarchy, component shapes (border-radius, shadows, borders), surface treatments (glass, texture, image effects), and gradient structure. Operates on neutral/token-referenced colors — not final color application.

**CSS ownership:** `@layer typography` owns: `font-family`, `font-size`, `font-weight`, `line-height`, `letter-spacing`, `text-transform`, `text-decoration`, `white-space`, `word-break`, `hyphens`. `@layer surfaces` owns: `border-radius`, `box-shadow`, `border-width`, `border-style`, `backdrop-filter`, `background-image` (gradients, textures), `background-size`, `background-repeat`, `opacity` (for overlays), `object-fit`, `object-position`, `aspect-ratio` (on media elements), `outline`, `ring`, pseudo-element `::before`/`::after` for decorative overlays.

**Forbidden in this phase:** `color`, `background-color` (solid fills), `border-color`, `transition`, `animation`, `transform`.

**Step 3a: Global typography** (single agent)

**Receives:**
- `tokens/css-variable-map.json`
- `tokens/design-tokens.json` → atomic.typography
- `tokens/style-fingerprint.json`
- `src/styles/globals.css`

**Produces:**
- `@layer typography { ... }` rules:
  - Base body font: `font-family: var(--font-body); font-size: var(--text-base); line-height: var(--leading-normal);`
  - Heading scale: `h1` through `h6` with sizes from tokens, weights from tokens, line-heights calculated
  - Prose/richtext styling: `.prose` class for `set:html` content (lists, paragraphs, links, blockquotes)
  - Small text, caption, label sizes

**Fingerprint influence:**
- `formality > 0.7` → tight letter-spacing, strict heading weight hierarchy
- `formality < 0.3` → looser spacing, playful weight mixing
- `ornament > 0.5` → decorative heading treatments (e.g., italics on subheadings, small-caps)

**Step 3b: Shadcn component customization** (fan-out — per Shadcn component)

Each agent customizes ONE installed Shadcn component to match its recipe from `component-recipes.json`.

**Receives:**
- The installed Shadcn component file (e.g., `src/components/ui/button.tsx`)
- The corresponding recipe from `component-recipes.json`
- `tokens/css-variable-map.json`
- `tokens/style-fingerprint.json` → treatments (corners, shadows, borders)

**Produces:**
- Modified Shadcn component file with:
  - `cva()` variants updated to match recipe variants
  - Base styles updated: padding, font-weight, font-size from recipe's `base` object
  - Border-radius from recipe or fingerprint treatment (`corners`)
  - Shadow from recipe or token reference
  - Size variants if recipe specifies (sm, md, lg)

**Recipe → Tailwind mapping:** The recipe's `base` object maps to the `cva()` base string. Recipe `variants` map to `cva()` variant entries. For values that match token custom properties, use Tailwind arbitrary values: `rounded-[var(--radius-lg)]`, `shadow-[var(--shadow-md)]`.

**Rules:**
- Preserve the Shadcn component's React structure and prop interface. Only modify class strings and `cva()` definitions.
- Shadcn components reference CSS variables like `bg-primary`, `text-primary-foreground` — these are allowed because they reference the custom properties set in Phase 1. Do not hardcode hex/rgb/oklch values.

**Step 3c: Astro component surface treatment** (fan-out — per component)

Each agent applies surface treatment to one wireframe Astro component that is NOT a Shadcn primitive.

**Receives:**
- The Astro component file
- The matching section-level recipe from `component-recipes.json`
- `tokens/css-variable-map.json`
- `tokens/design-tokens.json` → surfaces layer
- `tokens/style-fingerprint.json` → treatments

**Produces:**
- Updated component with Tailwind classes for: `border-radius`, `box-shadow`, `border`, glass/blur effects, gradient overlays, image treatments, texture pseudo-elements

**Fingerprint treatment mapping:**

| Treatment | CSS Implementation |
|-----------|-------------------|
| `surface: "frosted-glass"` | `backdrop-filter: blur(12px); border: 1px solid` (+ alpha values from tokens) |
| `surface: "textured"` | `::before` pseudo-element with SVG noise pattern |
| `corners: "sharp"` | `border-radius: 0` on all elements |
| `corners: "rounded-large"` | `border-radius: var(--radius-xl)` on cards/containers |
| `corners: "pill"` | `border-radius: 9999px` on buttons/badges |
| `shadows: "hard-offset"` | `box-shadow: 4px 4px 0` (neobrutalist) |
| `shadows: "layered-soft"` | Multiple `box-shadow` layers with large blur |
| `shadows: "none"` | No box-shadow anywhere |
| `borders: "thick"` | `border-width: 2px` or `3px` |
| `borders: "subtle"` | `border-width: 1px` |
| `borders: "none"` | No borders, rely on shadow/elevation |

**Step 3d: Typography + Surfaces review gate** (programmatic + vision)

**Programmatic checks:**
1. `astro build` passes
2. Layer isolation: grep for forbidden properties in Phase 3 changes. REJECT on violations.
3. Token usage: all font-size, border-radius, shadow values reference CSS custom properties or Tailwind utilities mapped to tokens. No hardcoded pixel values.
4. Typography hierarchy: parse generated CSS, verify `h1` font-size > `h2` > `h3` (resolved values).
5. Shadcn component integrity: each modified component still exports same named exports and prop types. `tsc --noEmit` passes.

**Vision check:**
- Screenshot 1-2 pages per page type at 1440px
- Vision model assesses: typography readable, heading hierarchy clear, component shapes consistent (all cards same radius, all buttons same shape), surface effects rendering, no visual artifacts
- Compare against `patterns/` screenshots if available

**On REJECT:** Fix agent per failing component/file. Max 3 iterations.

---

#### Phase 4: Color + Dark Mode (single agent + programmatic)

**Purpose:** Populate the full color system. Replace template-default neutral Shadcn colors with the reference site's palette. Build dark mode. Validate WCAG contrast.

**CSS ownership:** `@layer color` owns: `color`, `background-color`, `border-color`, `outline-color`, `text-decoration-color`, `fill`, `stroke`, `caret-color`, `accent-color`, `--tw-ring-color`. Also modifies `:root` and `.dark` CSS variable blocks (variable definitions are layerless).

**Forbidden in this phase:** `font-*`, `padding`, `margin`, `gap`, `grid-*`, `flex-*`, `border-radius`, `box-shadow` (shadow *values* were set in Phase 3; Phase 4 only adds shadow-color if needed), `transition`, `animation`.

**Step 4a: Color system generation** (programmatic)

Mostly programmatic because color token → CSS variable mapping is deterministic.

1. **Populate `:root` color variables** from `tokens/design-tokens.json` → `atomic.colors`:
   - Apply 60-30-10 distribution from `tokens.visualIdentity.colorDistribution`:
     - Dominant (60%) → `--background`, `--card`, `--popover`
     - Secondary (30%) → `--secondary`, `--muted`, `--accent`
     - Accent (10%) → `--primary`, `--destructive`
   - Foreground colors: compute from background colors using OKLCH contrast:
     - `--foreground`: if `--background` L > 0.5, use L=0.145; else L=0.985
     - Apply same logic for `--card-foreground`, `--primary-foreground`, etc.

2. **Populate `.dark` color variables:**
   - If analyze extracted explicit dark mode values, use those
   - Otherwise, derive using OKLCH manipulation:
     - Background: L → clamp(1 - L, 0.1, 0.2) (dark backgrounds)
     - Foreground: L → clamp(1 - L, 0.9, 0.98) (light text on dark)
     - Primary: keep hue and chroma, adjust L for dark background contrast
     - Borders: `oklch(1 0 0 / 10%)` (subtle white borders)
     - Muted: L → 0.25-0.30 range

3. **Gradient color injection:** Update `--gradient-*` variables with actual color values
4. **Border color assignment:** `--border` from `tokens.visualIdentity.borders.default`. Ensure border colors have ≥ 3:1 contrast against background.

**Step 4b: Component color application** (single agent)

A single agent applies color utility classes to components and pages where the Shadcn CSS variable system does not automatically reach.

**Receives:**
- `tokens/css-variable-map.json`
- `tokens/component-recipes.json` — variant color assignments
- `tokens/style-fingerprint.json` → warmth, darkness, playfulness dimensions
- All `src/components/` files
- `src/styles/globals.css`

**Produces:**
- Updated Astro components with color classes:
  - Section backgrounds: `bg-background`, `bg-secondary`, `bg-muted` following the 60-30-10 rule
  - Alternating section colors for visual rhythm (e.g., `bg-background` / `bg-muted`)
  - Text colors where defaults are insufficient: `text-muted-foreground` for captions, `text-primary` for links
  - Decorative color: colored dividers, accent bars, highlight backgrounds
- Dark mode toggle script in `Layout.astro` `<head>`:
  ```html
  <script is:inline>
    if (localStorage.theme === 'dark' || (!localStorage.theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark');
    }
  </script>
  ```

**Fingerprint influence:**
- `darkness > 0.6` → default to dark theme (add `.dark` to `<html>` by default)
- `warmth > 0.6` → ensure warm tones dominate (amber/earth as secondary, not cool gray)
- `playfulness > 0.6` → more accent color usage, colored badges/tags
- `ornament > 0.5` → gradient section backgrounds, decorative colored borders

**Rules:**
- All color values MUST use Tailwind semantic classes (`bg-primary`, `text-foreground`, `border-border`) or CSS variables. No hardcoded `oklch()` or `rgb()` in component files.
- Never modify Phase 2 layout properties or Phase 3 typography/surface properties.

**Step 4c: WCAG contrast validation** (programmatic)

1. Extract all text-on-background pairs from `:root` CSS variables
2. For each Shadcn semantic pair: compute WCAG 2.1 contrast ratio using OKLCH relative luminance
3. Check thresholds: normal text ≥ 4.5:1, large text ≥ 3:1, UI components ≥ 3:1. Check BOTH `:root` and `.dark`.
4. Auto-fix failing pairs: adjust foreground OKLCH lightness (max 0.15 L shift per iteration, 3 iterations). Re-validate after fix.
5. Output: `evidence/<iteration>/contrast-report.json`

**Step 4d: Color review gate** (programmatic + vision)

**Programmatic checks:**
1. `astro build` passes
2. WCAG report: all pairs pass, zero failures
3. No hardcoded color values in `.astro` files (grep for `#[0-9a-f]`, `rgb(`, `oklch(` in components)
4. Dark mode functional: Playwright adds `.dark` class, screenshots at 375/768/1440 confirm text readable, no invisible elements
5. Layer isolation: no layout or typography properties modified
6. Gradient rendering: Playwright checks gradient backgrounds render (no solid fallback)

**Vision check (vision_critical):**
- Screenshot 2-3 pages in light mode + dark mode at 375px, 768px, AND 1440px
- Vision model assesses: palette cohesive, 60-30-10 visible, text readable in both themes, dark mode is a proper dark theme (not just inverted), color mood matches reference
- Compare against `patterns/` screenshots if available

**On REJECT:** Single-agent fix with specific color issues identified. Max 3 iterations.

---

#### Phase 5: Motion (agent — single global + fan-out per component)

**Purpose:** Add transitions, hover/focus/active/disabled states, scroll reveals, and reduced-motion support. The final visual layer.

**CSS ownership:** `@layer motion` owns: `transition`, `transition-property`, `transition-duration`, `transition-timing-function`, `transition-delay`, `animation`, `animation-*`, `transform` (for motion effects: translateY, scale), `will-change`. Also: `:hover`, `:focus`, `:focus-visible`, `:active`, `:disabled` pseudo-class style changes for `opacity`, `transform`, `box-shadow` elevation changes, `background-color` shifts.

**Step 5a: Global motion styles** (single agent)

**Receives:**
- `tokens/css-variable-map.json`
- `tokens/design-tokens.json` → motion layer
- `tokens/style-fingerprint.json` → motion dimension, animation_style treatment
- `tokens/component-recipes.json` → states (hover/focus/active/disabled)
- `src/styles/globals.css`

**Produces:**
- `@layer motion { ... }` rules:
  - Default transition: `transition-property: color, background-color, border-color, box-shadow, opacity, transform; transition-duration: var(--duration-base); transition-timing-function: var(--easing-default);`
  - Focus-visible ring: `outline: 2px solid var(--ring); outline-offset: 2px;`
  - Disabled state: `opacity: 0.5; pointer-events: none;`
  - Scroll reveal utility: `.reveal` class with `@keyframes` for fade-in-up
  - `@media (prefers-reduced-motion: reduce)` block: disable all animations, set transitions to instant
- Inline `<script>` for scroll reveal observer (IntersectionObserver-based) in `Layout.astro`

**Motion dimension calibration:**

| Dimension range | Behavior |
|-----------------|----------|
| `motion < 0.2` | Only focus ring and disabled state. No hover transforms, no scroll reveals. |
| `motion 0.2–0.4` | Subtle: `200ms ease` transitions on hover (color/opacity only). Simple scroll fade-in. |
| `motion 0.4–0.6` | Standard: hover lifts (`translateY(-2px)`), shadow elevation changes, staggered scroll reveals. |
| `motion 0.6–0.8` | Expressive: bouncy easing, card hover effects, parallax-lite on hero, staggered grid animations. |
| `motion > 0.8` | Cinematic: `400ms+` transitions, dramatic scroll effects, morphing navigation. |

**Animation style → easing mapping:**

| `animation_style` | Easing curve | Duration range |
|-------------------|-------------|----------------|
| `subtle` | `ease` | 150–200ms |
| `spring-gentle` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 200–300ms |
| `spring-bouncy` | `cubic-bezier(0.68, -0.6, 0.32, 1.6)` | 200–400ms |
| `snappy` | `cubic-bezier(0.16, 1, 0.3, 1)` | 100–200ms |
| `cinematic` | `ease-in-out` | 400–600ms |

**Step 5b: Per-component state application** (fan-out — per component type)

Each agent applies interaction states to one component type (Astro or Shadcn).

**Receives:**
- The component file
- Its recipe from `component-recipes.json` → `states` (hover, focus, active, disabled)
- `tokens/css-variable-map.json`
- `tokens/style-fingerprint.json` → motion dimension

**Produces:**
- Updated component with state classes:
  - Hover: `hover:shadow-md hover:translate-y-[-2px]` (from recipe states.hover)
  - Focus: `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2` (from recipe states.focus)
  - Active: `active:scale-[0.98]` (from recipe states.active)
  - Disabled: `disabled:opacity-50 disabled:pointer-events-none` (from recipe states.disabled)
- If the component is a card/link with hover: add `transition` class
- If the component is a section with scroll reveal: add `reveal` class to animated children

**Rules:**
- `transition: all` is FORBIDDEN. Always list explicit properties.
- No `!important` on any motion properties
- Animations MUST use only `transform` and `opacity` for GPU compositing (no `width`, `height`, `top`, `left`)
- Hover transition max duration: 300ms. Scroll reveal max duration: 600ms.
- Stagger delay for list items: `style="transition-delay: calc(var(--stagger-index, 0) * 80ms)"`

**Step 5c: Motion review gate** (programmatic + vision)

**Programmatic checks:**
1. `astro build` passes
2. Layer isolation: no layout, typography, surface, or color properties modified
3. No `transition: all` (grep). REJECT if found.
4. `globals.css` contains `@media (prefers-reduced-motion: reduce)` block. Playwright with `prefers-reduced-motion: reduce` — no animations fire.
5. No `will-change` on more than 5 elements per page
6. No `transition-duration` or `animation-duration` exceeds 800ms

**Vision check:**
- Playwright hover over interactive elements, screenshot mid-transition. Vision model confirms hover state visible.
- Screenshot comparison: Phase 5 static screenshots should match Phase 4 (motion causes no layout shifts in static state).

**On REJECT:** Single-agent fix. Max 2 iterations (motion is low-risk for cascading failures).

---

#### Phase 6: Final Visual QA (reviewers — parallel)

**Purpose:** Comprehensive quality validation. Produces final quality scores and design fidelity report. This is the segment's equivalent of wireframe's Phase 5.

**Step 6a: Full reviewer sweep** (parallel — all reviewer types)

**Pass 1 — parallel, agentic:**

| Reviewer | What it checks | Sampling |
|----------|---------------|----------|
| **Static checks** | `bun run check` + `astro build` + `lychee dist/` | Exhaustive |
| **Console errors** | Headless Playwright, all pages, console errors | Exhaustive |
| **Vision** | Screenshots at 375/768/1440px. Checks: broken layout, overflow, unreadable text, overlapping, broken images, mobile stacking, tablet reflow, desktop grid | 2-3 per page type |
| **WCAG contrast** | Re-run Step 4c contrast check on final build | Exhaustive |
| **Design fidelity** | Compare final screenshots against `patterns/screenshots/`. Rate similarity on 5 dimensions: color mood, typography feel, component shape, layout structure, overall impression | 1 per page type |
| **Content completeness** | Programmatic text-match (Tier 1) + LLM-as-judge (Tier 2) — same as wireframe | 2-3 per page type |

**Pass 2 — after Pass 1:**

| Reviewer | What it checks |
|----------|---------------|
| **Trace** | Reads all Pass 1 evidence. Traces errors to source file:line. Categorizes: CSS bug, token bug, component bug, content bug. |

**Step 6b: Quality scoring** (programmatic + single agent)

| Dimension | Weight | How scored |
|-----------|--------|-----------|
| Layout consistency | 20% | Programmatic: spacing values all from tokens, grid alignment, section padding consistent |
| Design token usage | 20% | Programmatic: grep for hardcoded values, count token references vs raw values |
| Component composition | 15% | Programmatic: all Shadcn components render, recipe variants present, shared components reused |
| Responsive design | 15% | Programmatic: overflow check results, 3-breakpoint pass rate, touch target compliance |
| Semantic HTML | 10% | Programmatic: heading hierarchy, ARIA labels, landmark elements |
| Visual appeal | 10% | Vision model: rate aesthetics on 1-10 scale across sampled pages |
| Motion quality | 10% | Programmatic: reduced-motion present, no `transition: all`, duration limits respected |

Threshold: overall score ≥ 7.0.

**Step 6c: Design fidelity score** (vision-capable agent)

1. Load `tokens/style-fingerprint.json`
2. For each of the 8 dimensions: vision model rates the generated site's expression (0-1)
3. Compute delta: `|reference_score - generated_score|`
4. Fidelity score: `1 - mean(deltas)`. Threshold: ≥ 0.6.
5. If fidelity < 0.6: identify top 3 dimensions with largest delta → targeted fix instructions.

**Step 6d: Final gate**

Non-negotiable checks:

- `astro build && pagefind --site dist` exits clean
- `bun run check` passes (biome + tsc + knip)
- `lychee dist/` reports zero broken internal links and images
- Playwright visits every route — no HTTP 500s, no uncaught exceptions
- All WCAG contrast pairs pass (≥ 4.5:1 normal text, ≥ 3:1 large text / UI)
- No horizontal overflow at ANY of the 3 breakpoints (375/768/1440)
- Mobile layout is single-column (vision verified)
- Tablet layout reflows correctly (vision verified)
- Desktop grid aligned with consistent gutters (vision verified)
- Touch targets ≥ 44px on mobile
- Dark mode renders correctly at all 3 breakpoints
- `prefers-reduced-motion` is respected
- No `transition: all` anywhere in the codebase
- No hardcoded color values in `.astro` component files
- Quality score ≥ 7.0 overall
- Design fidelity ≥ 0.6
- Content coverage from wireframe preserved (≥ 0.9 field match rate)

**On REJECT — fix loop (max 3 iterations):**

Same two-sub-phase fix structure as wireframe:
1. **Component fixes:** fan-out per broken component. Agent receives trace review entries.
2. **Page fixes:** fan-out per failing page type. Agent receives trace review entries.
3. After fixes: full reviewer sweep re-runs (Step 6a), new evidence at `evidence/<iteration+1>/`.

Context escalation: each retry, fix agent sees original review + all previous fix attempts + new review.

### Retry Semantics and @layer Isolation

**Phase-level retry** is safe because each phase writes to its own CSS `@layer`. If Phase 4 (color) is retried:
- Phase 2's layout classes in `@layer layout` are untouched
- Phase 3's typography/surface classes in `@layer typography` and `@layer surfaces` are untouched
- Phase 4 re-applies color changes to `@layer color` and `:root`/`.dark` variable blocks

**Cross-phase regression detection:** Between each phase, a programmatic diff check verifies that no CSS properties owned by previous phases were modified. This uses a grep-based approach:
1. After Phase N completes, snapshot all files modified by Phase N
2. For each modified file, check that only Phase N's allowed CSS properties changed
3. If a forbidden property was modified → REJECT with exact property + file:line

**In-place workdir:** Unlike the wireframe segment where each phase iteration copies the workdir, the design segment works in-place on a single workdir. CSS layers provide the isolation guarantee instead of filesystem copies. Evidence and reviews accumulate as usual in `evidence/<iteration>/` and `reviews/<iteration>/`.

### Responsive Design Validation Strategy

Responsive validation runs at three checkpoints, not just at the end:

| Checkpoint | Breakpoints | What's checked |
|------------|-------------|----------------|
| Phase 2 gate | 375, 768, 1440 | Overflow, element positions, grid reflow, nav behavior, touch targets |
| Phase 4 gate | 375, 768, 1440 (light + dark) | Color readability on all sizes, dark mode on all breakpoints |
| Phase 6 gate | 375, 768, 1440 | Full visual pass (layout + design + color + motion), final sign-off |

**Overflow detection script (Playwright, reusable across phases):**
```javascript
const overflow = await page.evaluate(() => {
  const docWidth = document.documentElement.scrollWidth;
  const winWidth = window.innerWidth;
  if (docWidth > winWidth) {
    const all = document.querySelectorAll('*');
    const offenders = [];
    for (const el of all) {
      const rect = el.getBoundingClientRect();
      if (rect.right > winWidth + 1) {
        offenders.push({
          tag: el.tagName,
          class: el.className,
          width: rect.width,
          right: rect.right,
        });
      }
    }
    return { overflow: true, offenders };
  }
  return { overflow: false };
});
```

### Dark Mode Strategy

Dark mode is primarily token-driven, minimizing manual work:

1. **Phase 1:** CSS variables for `:root` and `.dark` are both populated from tokens (or auto-derived)
2. **Phase 4:** Colors refined, dark mode values adjusted for WCAG compliance
3. **Phase 4b:** Toggle script added. Default theme chosen based on `darkness` fingerprint dimension.
4. **Phase 6:** Dark mode validated via Playwright at all 3 breakpoints

**Token-driven (automatic):** All Shadcn component colors (they reference CSS variables which change between `:root` and `.dark`). Background, foreground, card, popover, border, input, ring, destructive, muted, accent, primary, secondary.

**Needs agent attention (Phase 4b):** Section-level color alternation patterns, gradient color adjustments for dark mode, image overlay opacity adjustments, decorative brand color elements.

### Profile Recommendations

All steps use the provider pool (minimax, glm, kimi). Multi-provider consensus for critical steps.

| Step | Provider strategy | Rationale |
|------|-------------------|-----------|
| Token injection, fonts, WCAG | Programmatic | Deterministic |
| Shadcn install | Single provider | Shell commands, narrow task |
| Global layout / typography | Single provider | Small scope, reads concrete files |
| Per-page layout | Single provider per page type | Fan-out, cost-sensitive |
| Shadcn customization | Single provider per component | Fan-out, narrow task |
| Surface treatment | Single provider per component | Fan-out, narrow task |
| Component colors | Single provider | Holistic color decisions |
| Motion (global + per-component) | Single provider | Narrow scope |
| Vision reviews (layout, typo, motion) | kimi (vision) | Screenshot analysis |
| Color vision review | kimi + minimax (vision_critical) | Color fidelity critical |
| Design fidelity (Phase 6) | kimi + minimax (vision_critical) | Aesthetic judgment |
| Trace reviewer | Multi-provider consensus (critical) | Fix quality depends on accuracy |
| Programmatic steps | N/A | No LLM needed |

### Cost Estimate

Rough per-run token budget for design segment (7 page types, 15 components):

| Step | Calls | Est. tokens per call | Subtotal |
|------|-------|---------------------|----------|
| Phase 1 (token injection + shadcn) | 1 agent + programmatic | ~8k in, ~5k out | ~13k |
| Phase 2a (global layout) | 1 | ~10k in, ~5k out | ~15k |
| Phase 2b (per-page layout) | 7 | ~8k in, ~4k out | ~84k |
| Phase 2c (vision review) | 7 screenshots × 3 breakpoints | ~5k in, ~2k out | ~147k |
| Phase 3a (global typography) | 1 | ~6k in, ~3k out | ~9k |
| Phase 3b (shadcn customization) | ~8 | ~4k in, ~3k out | ~56k |
| Phase 3c (surface treatment) | ~12 | ~5k in, ~3k out | ~96k |
| Phase 3d (vision review) | 7 screenshots | ~5k in, ~2k out | ~49k |
| Phase 4 (color + WCAG) | 1 agent + programmatic | ~12k in, ~8k out | ~20k |
| Phase 4d (vision: light+dark × 3bp) | 14+ screenshots | ~5k in, ~2k out | ~98k |
| Phase 5 (motion) | 1 + ~15 components | ~4k in, ~2k out | ~96k |
| Phase 6 (final QA) | ~20 reviewer calls | ~8k in, ~3k out | ~220k |
| **Total** | | | **~900k–1.3M tokens** |

With retries (avg 1.5×): ~1.3M–2.0M tokens per run.

Provider concurrency: cap at 45 simultaneous LLM calls. Queue overflow with FIFO ordering.

### Step Matrix Configuration (for `cui.yaml`)

```yaml
step_matrix:
  # Design Phase 1
  design.tokens.shadcn-install: default

  # Design Phase 2
  design.layout.global: default
  design.layout.per-page: default           # fan-out
  design.layout.vision-review: vision

  # Design Phase 3
  design.typography.global: default
  design.typography.shadcn-customize: default  # fan-out
  design.typography.surface-treatment: default # fan-out
  design.typography.vision-review: vision

  # Design Phase 4
  design.color.component-colors: default
  design.color.vision-review: vision_critical  # color fidelity is critical

  # Design Phase 5
  design.motion.global: default
  design.motion.per-component: default       # fan-out
  design.motion.vision-review: vision

  # Design Phase 6
  design.final.static-checks: default
  design.final.console-reviewer: default
  design.final.vision-reviewer: vision
  design.final.design-fidelity: vision_critical
  design.final.content-completeness: default
  design.final.trace-reviewer: critical
```

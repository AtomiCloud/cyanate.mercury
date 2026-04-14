# Pipeline V3: Three-Segment Architecture Spec (v4)

> **Source:** v3 spec + architecture discussion
> **Target:** Three segments with clean boundaries:
> (1) **Prepare** — fully programmatic: downloads assets, resolves routes heuristically, produces self-contained dataset
> (2) **Classify** — AI classification: page types, listings, global/shared/owned → detect richtext → compose richtext
> (3) **Wireframe** — generates working Astro project from classified content model
> **Status:** Architecture finalized. Ready for implementation.

---

## 1. Changes from v3

| Change | Reason |
|--------|--------|
| Added prepare segment | Separate IO-heavy data prep from AI-heavy classification |
| Removed reduce concept | No sampling/reduction — all data kept, all images downloaded |
| Prepare is fully programmatic (zero AI) | Route resolution uses scraper-provided URL patterns + page type names as heuristic |
| Route map is internal to prepare | Prepared content contains final URLs; no `route-map.json` output — downstream never sees original URLs |
| Page type classification moved to classify | Singleton/collection/listing is a semantic judgment — belongs with other AI classification |
| Listing pairing moved to classify | Listing → collection pairing is semantic; not needed for route resolution |
| Classify simplified | Pure semantic analysis on clean data — no IO, no downloads |
| Globals relaxed | "Most pages" not "all pages" — some pages may skip layout |
| Listing pairings allow no-owner | Orphan listings (no collection target) are valid |

---

## 2. Design Principles

1. **Every AI step that can be validated programmatically, must be.** No trusting
   agent output without a gate.

2. **Validation merges into internal loops.** The agent prompt asks the agent to
   self-check before declaring completion. But we still run a programmatic validator
   to gate the output. If the gate rejects, the phase runner retries the phase with
   rejection context — the agent gets told exactly what it missed.

3. **100% completeness coverage.** Every field classified. Every richtext path mapped.
   No heuristic fallbacks. Missing = retry.

4. **Failed checks feed back into retry loops.** Rejection context includes the
   specific fields/paths that failed, not generic "some things are wrong."

5. **If all upstream gates pass, downstream assertions should hold.** Content
   completeness is a hard assertion. If it fails with 100% upstream coverage, it
   implies a bug in the validators — hard fail with diagnostics.

---

## 3. Segment Architecture

### DAG Layout

```
analyze  ──────────────────────────┐
                                   ├──► design
prepare ──► classify ──► wireframe ─┘
```

`analyze` and `prepare` run in parallel (no dependency between them).
`classify` depends on `prepare`. `wireframe` depends on `classify`.
`design` depends on both `analyze` and `wireframe`.

---

### Prepare Segment

**ID:** `prepare`
**Purpose:** Download all assets, heuristically resolve route conflicts, rewrite all
references, produce a self-contained dataset with no unresolved references and
structural hints for classify. Fully programmatic — zero AI.
**Depends:** `[]` (runs in parallel with analyze)

**Input:** `structure.json`, `schema.json`, `content.json` (raw scraper output)

**Output:** A fully self-contained dataset:
| Artifact | Description |
|----------|-------------|
| `pages.json` | Flat page list with resolved schemas (no `$ref`) |
| `page-type-meta.json` | Per-page-type: name, final URL pattern, count, all URLs |
| `prepared-content.json` | All content with images localized + internal links rewritten to final URLs |
| `asset-manifest.json` | Original image URL → local content-addressed path |
| `structure-map.json` | Compact structural trees per page type |
| `heuristics.json` | Page counts, avg content lengths, field frequency, structural hints |

**Internal (not exported):** The original→final URL map is built during route
resolution and consumed immediately by apply-rewrites. It is **not** emitted as an
artifact — prepared-content already carries final URLs. Downstream segments never see
the original URLs.

**Not produced by prepare (moved to classify):**
- Page type classification (singleton/collection/listing) — semantic judgment
- Listing → collection pairing — semantic judgment

**Guarantee:** Classify never needs to fetch anything external. All images are local.
All internal links resolve to final URLs. All schema refs are resolved. External
links to other websites are left untouched (they're legitimate content data).

---

### Classify Segment

**ID:** `classify`
**Purpose:** AI classification of clean data — page type classification, listing pairing,
global/shared/owned → detect richtext → compose richtext.
**Depends:** `["prepare"]`

**Input:** All prepare segment outputs (self-contained dataset)

**Output:**
| Artifact | Description |
|----------|-------------|
| `registry.json` | Page types classified as singleton/collection/listing with listing pairings |
| `globals.json` | Global content (header, footer, nav) with canonical content |
| `shared-components.json` | Shared content blocks with interaction types |
| `field-classifications.json` | Per-field type classification across all scopes |
| `render-maps.json` | Richtext field → HTML element mappings |
| `content-model-classified.json` | Enriched with ComposeNode trees per richtext field |
| `content-model.json` | CMS CollectionDefs with typed FieldDefs (adapter format) |

---

### Wireframe Segment

**ID:** `wireframe`
**Purpose:** Generate a working unstyled Astro project from the classified content model.
**Depends:** `["classify"]`

**Input:** All classify + prepare outputs + Astro template

**Output:** Complete Astro project in `project/` directory

---

## 4. Prepare Segment — 6 Phases

```
Phase 1: ingest             (programmatic — parse + validate schemas)
Phase 2: download-assets    (programmatic — download ALL images, build manifest)
Phase 3: resolve-routes     (programmatic — heuristic conflict detection, prefix rewrites)
Phase 4: apply-rewrites     (programmatic — rewrite links + images in content)
Phase 5: build-heuristics   (programmatic — structure maps, stats, field frequency)
Phase 6: validate-dataset   (programmatic assertion — self-contained, referentially complete)
```

0 AI phases. 6 programmatic. Prepare is fully deterministic.

---

## 5. Prepare Phase Definitions

### Phase 1: ingest

**Type:** Programmatic | **maxRetries:** 0

| Step | Type | What it does |
|------|------|-------------|
| parse-and-validate | programmatic | Parses structure.json, schema.json, content.json. Resolves all `$ref` pointers in schemas. Validates content matches schemas. |

- Flatten grouped content into page list
- Resolve JSON Schema `$ref` pointers to inline definitions
- Validate every page's content against its schema
- Extract page type metadata (counts, URL patterns, pagination flags)

**Output contract:**
```typescript
// pages.json — flat list of all pages with resolved schemas
interface PreparedPage {
  url: string;
  pagetype: string;
  content: Record<string, unknown>;   // raw content
  schema: Record<string, unknown>;    // resolved schema (no $ref)
}

// page-type-meta.json
interface PageTypeMeta {
  pagetype: string;
  urlPattern: string;          // e.g., "/team/{slug}/"
  count: number;
  urls: string[];
  hasPagination: boolean;
}
```

**On failure:** Hard fail. Scraper output is malformed.

---

### Phase 2: download-assets

**Type:** Programmatic | **maxRetries:** 0

| Step | Type | What it does |
|------|------|-------------|
| download-all-images | programmatic | Scans ALL content for image URLs, downloads every image, builds asset manifest |

- Scan every page's content recursively for image URLs
- Download ALL images (not samples — everything)
- Content-address filenames (SHA256 of URL + extension)
- Build asset manifest mapping original URL → local path
- Verify all downloads succeeded (retry individual failures up to 3 times)

**Output contract:**
```typescript
// asset-manifest.json
interface AssetManifest {
  entries: {
    originalUrl: string;       // https://cdn.example.com/photo.jpg
    localPath: string;         // images/a1b2c3d4.jpg (content-addressed)
    downloaded: boolean;       // must be true for all entries
  }[];
}

// All images written to workdir/images/
// Validation: entries.every(e => e.downloaded === true)
```

**On failure:** Hard fail. Images that can't be downloaded after retries are logged
but don't block — they get `downloaded: false` and downstream phases handle gracefully.

---

### Phase 3: resolve-routes

**Type:** Programmatic | **maxRetries:** 0

| Step | Type | What it does |
|------|------|-------------|
| resolve-routes | programmatic | Extracts common prefix per page type from scraper URLs, detects conflicts between dynamic route patterns at the same depth, adds page-type-name prefix for conflicts. Builds internal url-map for Phase 4. |

**Fully heuristic — no AI needed.** The scraper output (`structure.json`) already
provides page type names, URL patterns, and all concrete URLs. This is enough signal
for unambiguous route resolution.

**Algorithm:**

1. **Extract common prefix per page type** from actual URLs:
   ```
   blog_post URLs:  /post/knee-pain..., /post/best-pillow...
   → common prefix: /post/
   → final pattern: /post/{slug}/

   team_member URLs: /team/muhd-nash/, /team/lorrian-lim/
   → common prefix: /team/
   → final pattern: /team/{slug}/
   ```

2. **Detect root-level dynamic conflicts:**
   ```
   service URLs:    /home-physiotherapy/, /sports-massage/, ...
   → url_pattern: /{service}/ — root-level dynamic
   blog_post URLs:  /the-path-to-longevity/...
   → url_pattern: /{slug}/ — root-level dynamic
   → CONFLICT: both are /{dynamic}/ at root level
   ```

3. **Disambiguate conflicts using page type name as prefix:**
   ```
   service:   /{service}/   → /services/{slug}/
   blog_post: /{slug}/      → /blog-post/{slug}/
   legal:     /{legal}/     → /legal/{slug}/
   ```
   Pages that already have a prefix from the original site keep it (no rewrite).

4. **Build internal url-map** (original URL → final URL) for every page:
   ```
   /home-physiotherapy/  → /services/home-physiotherapy/
   /post/knee-pain/      → /post/knee-pain/  (no change — already prefixed)
   /about-us/            → /about-us/  (singleton — no change)
   ```

**The three cases:**

| Case | Example | Action |
|------|---------|--------|
| Already prefixed | `/post/my-post/` | Keep — no rewrite |
| Root-level singleton | `/about-us/` | Keep — fixed route, no conflict |
| Root-level dynamic + conflict | `/{slug}/` | Page type name becomes prefix |

**Internal output (consumed by Phase 4, not exported):**
```typescript
// Internal url-map — used only by apply-rewrites
interface InternalUrlMap {
  urlMap: Record<string, string>;  // "/my-post" → "/blog-post/my-post"
  patternMap: Record<string, {     // per page type
    pageType: string;
    originalPattern: string;       // from scraper: "/{slug}/"
    finalPattern: string;          // resolved: "/blog-post/{slug}/"
    rewritten: boolean;            // true if prefix was added
  }>;
}
```

**Updates page-type-meta.json:** The `urlPattern` and `urls` fields are updated to
reflect final routes. Downstream phases only see final URLs.

**On failure:** Hard fail. Scraper URL patterns are unambiguous or the algorithm has a bug.

---

### Phase 4: apply-rewrites

**Type:** Programmatic | **maxRetries:** 0

| Step | Type | What it does |
|------|------|-------------|
| rewrite-content | programmatic | Rewrites all internal links and image URLs in content using the internal url-map from Phase 3 and asset-manifest from Phase 2 |

- Rewrite all internal site links using the url-map from Phase 3 (original → final)
- Rewrite all image URLs using `asset-manifest.json` (original → local path)
- Classify remaining URLs:
  - Internal links → rewritten (verified against url-map)
  - External links → left untouched, tagged as external
  - Image URLs → rewritten to local paths
  - Embedded media (YouTube, Vimeo) → left untouched, tagged as external-media
- Also updates the per-page URL in `pages.json` to the final URL (so downstream
  sees final URLs only)

**Output contract:**
```typescript
// prepared-content.json — all pages with rewritten content + final URLs
interface PreparedContent {
  pages: PreparedPage[];        // URLs and content both carry final routes
  externalLinks: {              // inventory of external links (left untouched)
    url: string;
    pageType: string;
    fieldPath: string;
    type: "external" | "external-media";
  }[];
}

// Validation: no internal site URLs remain unrewritten
// (every link to the original site domain is either rewritten or flagged)
```

**On failure:** Hard fail. Url-map or asset manifest is incomplete.

---

### Phase 5: build-heuristics

**Type:** Programmatic | **maxRetries:** 0

| Step | Type | What it does |
|------|------|-------------|
| build-structure-maps | programmatic | Walks richest sample per page type, produces compact structural trees |
| build-heuristics | programmatic | Generates page stats, field frequency, content length analysis |

**Structure maps** — compact trees replacing raw JSON in all downstream prompts:
```
article_content (object)
  sections (array[3])
    heading (string, 12 chars)
    body (string, 850 chars)
    images (array[2])
      src (local-image)
      alt (string, 7 chars)
author (string, 8 chars)
```

Note: image URLs now show as `local-image` type (since all images are localized).

**Heuristics** — structural analysis for classify to consume:
```typescript
// heuristics.json
interface Heuristics {
  totalPages: number;
  totalPageTypes: number;
  pageTypes: PageTypeHeuristic[];
  fieldFrequency: Record<string, string[]>;  // field name → which page types have it
  // e.g., "header" → ["landing", "about", "team_listing", ...] (structural hint for globals)
}

interface PageTypeHeuristic {
  pagetype: string;
  pageCount: number;
  avgContentLength: number;     // chars
  topLevelFieldCount: number;
  richestSampleUrl: string;     // URL of the page with most content
  simplestSampleUrl: string;    // URL of the page with least content
}
```

**On failure:** Hard fail. Prepared content is unreadable.

---

### Phase 6: validate-dataset

**Type:** Programmatic assertion | **maxRetries:** 0

| Step | Type | What it does |
|------|------|-------------|
| validate-completeness | programmatic | Verifies the dataset is self-contained and referentially complete |

**Checks (hard assertions — catch bugs in Phases 1-5):**
1. Every image URL in content points to a local path that exists in asset-manifest
2. Every internal link in content resolves to a final URL present in page-type-meta
3. Every schema `$ref` is resolved (no dangling references)
4. Every page type in page-type-meta has at least one content page
5. No original site domain URLs remain in content (except tagged external links)
6. All downloaded image files exist on disk
7. No two page types have conflicting final URL patterns (e.g., two `/{slug}/` at root)
8. All final patterns are valid Astro file-based routing patterns

**On failure:** Hard fail. This is a bug in our code or an edge case we didn't
consider — not an AI/retry scenario. Diagnostics point to which check failed and
which phase likely dropped correctness.

---

## 6. Classify Segment — 9 Phases

```
Phase 1: classify-page-types     (agent + gate — singleton/collection/listing + listing pairings)
Phase 2: detect-globals          (agent + gate)
Phase 3: detect-shared           (agent + gate — includes interaction patterns)
Phase 4: classify-fields         (agent fan-out + 100% gate — all scopes)
Phase 5: map-render-as           (agent fan-out + 100% gate — richtext fields)
Phase 6: compose-trees           (programmatic — build ComposeNode trees)
Phase 7: content-completeness    (programmatic assertion)
Phase 8: assemble-registry       (programmatic — merge into CMS adapter format)
Phase 9: cms-integration-test    (programmatic — SonicJS push+pull round-trip)
```

5 AI phases (1, 2, 3, 4, 5). 4 programmatic (6, 7, 8, 9).

---

## 7. Classify Phase Definitions

### Phase 1: classify-page-types

**Type:** Agent + programmatic gate | **maxRetries:** 3

| Step | Type | What it does |
|------|------|-------------|
| classify-page-types | agent | Sees page-type-meta (names, final URL patterns, counts) + structure maps + heuristics. Classifies each page type as singleton/collection/listing. Pairs listings to collections. |
| validate-page-types | programmatic | Every page type classified. Listing targets exist or are null. Classifications consistent with page counts. |

**Moved from prepare.** Page type classification and listing pairing are semantic
judgments that belong alongside other AI classification, not in data prep.

**The agent classifies:**

1. **Page type classification:** singleton / collection / listing for each page type.
   - Singleton: single instance (landing, about, patient_journey)
   - Collection: multiple instances with slug (blog_post, team_member, doctor_profile)
   - Listing: displays entries from a collection (blog_listing, team_listing, news_listing)

2. **Listing → collection pairing:** Which listing displays which collection's entries.
   - `collection: null` is valid (orphan listing — no associated collection)
   - A collection can exist without a listing (directly linked, no index page)

**Agent receives:**
- `page-type-meta.json` (names, final URL patterns, page counts, all URLs)
- `structure-map.json` (compact structural trees per page type)
- `heuristics.json` (field frequency, content length stats)

**Output contract:**
```typescript
// registry.json
interface Registry {
  pageTypes: Record<string, {
    type: "singleton" | "collection" | "listing";
    route: string;              // final URL pattern (from prepare)
    count: number;
    slugParam?: string;         // for dynamic routes: "slug"
  }>;
  listingPairings: {
    listing: string;            // page type id
    collection: string | null;  // paired collection, or null for orphan listing
    paginated: boolean;
  }[];
}

// Validation rules:
// - Every page type in page-type-meta has a classification
// - count == 1 + classified as singleton → consistent (warn if count > 1 but classified singleton)
// - Listing targets (if non-null) exist as a collection in the same registry
// - No page type is both a listing and a collection
```

**On gate failure:** Retry with rejection context listing which page types failed
validation and why.

---

### Phase 2: detect-globals

**Type:** Agent + programmatic gate | **maxRetries:** 3

| Step | Type | What it does |
|------|------|-------------|
| detect-globals | agentFanOut | Agent sees all structure maps + content samples + field frequency heuristics. Identifies global content (site-wide, typically in layout). Spawns subagents to verify candidates across page types. |
| validate-globals | programmatic | Each global field appears on most page types (threshold determined by agent). Canonical content is non-empty. |

**Relaxed definition:** Globals are site-wide content typically rendered in the layout
(header, footer, nav). They do NOT need to appear on ALL pages — some pages may skip
the layout (e.g., a special landing page, an API endpoint, a maintenance page). The
agent determines which page types participate and which are exceptions.

**Agent receives:**
- All structure maps
- Content samples for each page type
- `fieldFrequency` from heuristics.json (structural hint: "header" appears on 8/10 page types)

**Output contract:**
```typescript
// globals.json
interface GlobalField {
  name: string;                    // e.g., "header", "footer", "nav"
  fieldPaths: string[];            // JSON paths where this appears
  canonicalContent: unknown;       // extracted content (representative sample)
  presentOnPageTypes: string[];    // page types that have this global
  absentFromPageTypes: string[];   // page types that DON'T have it (exceptions)
}

// Validation rules:
// - presentOnPageTypes.length > totalPageTypes / 2 (majority threshold)
// - canonicalContent is non-empty
// - absentFromPageTypes is explicitly listed (not silently omitted)
```

**CMS mapping:** `CollectionDef type: "global"`, fetched in Astro layout.

**On gate failure:** Retry with rejection context listing which candidates failed validation.

---

### Phase 3: detect-shared + interaction patterns

**Type:** Agent + programmatic gate | **maxRetries:** 3

| Step | Type | What it does |
|------|------|-------------|
| detect-shared | agentFanOut | Agent sees structure maps with globals stripped. Detects shared content blocks AND shared interaction patterns. Spawns subagents for semantic judgment. |
| validate-shared | programmatic | Each shared component on >= 2 page types, not a global. Interaction types are valid. |

**Interaction pattern detection:** The agent identifies content blocks with interactive
rendering behavior. Interaction types:
```
carousel | accordion | tabs | search | modal | none
```

A testimonials carousel on 3 pages = shared component with `interactionType: "carousel"`.

**Decision rules:**
- "Would a CMS editor edit this once?" → shared
- "Does this block have interactive behavior?" → set interactionType
- Shared + interactive = both (e.g., testimonials carousel)

**Output contract:**
```typescript
// shared-components.json
interface SharedComponent {
  name: string;                    // e.g., "booking_cta", "testimonials_carousel"
  fieldSchema: Record<string, string>;
  canonicalContent: unknown;
  sourcePageTypes: string[];       // >= 2, not a global
  interactionType: "carousel" | "accordion" | "tabs" | "search" | "modal" | "none";
}

// Validation rules:
// - sourcePageTypes.length >= 2
// - not a global (not in globals.json)
// - canonicalContent is non-empty
// - interactionType is a valid enum value
```

**On gate failure:** Retry with specific rejection context.

---

### Phase 4: classify-fields

**Type:** Agent fan-out + 100% coverage gate | **maxRetries:** 3

| Step | Type | What it does |
|------|------|-------------|
| classify-field-types | agentFanOut | Fan-out agents classify fields across three scopes: page-owned fields, global internal fields, shared component internal fields. |
| validate-field-coverage | programmatic | 100% coverage check across all three scopes. |

**Three classification scopes:**

**Scope A — Page-owned fields (one agent per page type):**
Classifies every remaining field after globals and shared are stripped.

**Scope B — Global internal fields (one agent per global):**
Classifies every field within each global (e.g., header → logo, nav_items, cta_button).

**Scope C — Shared component internal fields (one agent per shared component):**
Classifies every field within each component (e.g., booking_cta → headline, button_text).

All agents classify using existing FieldType:
```
string | number | boolean | datetime | richtext | image | select | relationship | repeater | object
```

Array/repeater fields get an optional interaction annotation:
```
interaction?: "carousel" | "accordion" | "tabs" | "none"
```

For page-owned fields:
- Global keys at page level → `relationship` (to global collection)
- Shared keys at page level → `relationship` (to shared collection)

**Output contract:**
```typescript
interface FieldClassifications {
  pageTypes: PageFieldClassifications[];
  globals: ComponentFieldClassifications[];
  shared: ComponentFieldClassifications[];
}

interface PageFieldClassifications {
  pagetype: string;
  fields: FieldClassification[];  // { field_path, type, compose_spec?, target_collection? }
  interactions: Record<string, "carousel" | "accordion" | "tabs" | "none">;
}

interface ComponentFieldClassifications {
  name: string;
  fields: FieldClassification[];
  interactions: Record<string, "carousel" | "accordion" | "tabs" | "none">;
}

// Validation: 100% coverage across ALL scopes
// relationship fields must have target_collection
// interaction annotations only on repeater/array fields
```

**On gate failure:** Retry with per-unit rejection context (e.g., "page:landing:
hero_section.features missing", "global:header: nav_items[].icon missing").

---

### Phase 5: map-render-as

**Type:** Agent fan-out + 100% coverage gate | **maxRetries:** 3

| Step | Type | What it does |
|------|------|-------------|
| map-render-as | agentFanOut | One agent per richtext field (identified from Phase 3). Maps every child path to an HTML element. |
| validate-render-maps | programmatic | 100% coverage: every leaf path has a render_as mapping. |

Fan-out: one agent per richtext field across all scopes (page-owned, global, shared).

Maps every child path → RenderAs value:
```
p | h1 | h2 | h3 | h4 | img | a | li | ul | ol | blockquote | div | section | span | raw
```

**Output contract:**
```typescript
interface RenderMap {
  fieldPath: string;
  scope: "page" | "global" | "shared";
  scopeName: string;             // page type name, global name, or shared component name
  mappings: Record<string, RenderAs>;
}

// 100% leaf coverage. NO heuristic fallbacks. Missing = reject.
```

**On gate failure:** Retry with per-field unmapped paths.

---

### Phase 6: compose-trees

**Type:** Programmatic | **maxRetries:** 0

| Step | Type | What it does |
|------|------|-------------|
| build-compose-trees | programmatic | Assembles ComposeNode trees from render-maps. Generates body_compose for richtext-dominant page types. |

Uses existing ComposeNode format:
```typescript
interface ComposeNode {
  field: string;           // JSON field name to read
  render_as: RenderAs;     // HTML element to emit
  is_array?: boolean;      // iterate array items
  children?: ComposeNode[];
}
```

**On failure:** Hard fail. If Phase 5 passed, this cannot fail unless there's a bug.

---

### Phase 7: content-completeness

**Type:** Programmatic assertion | **maxRetries:** 0 (hard fail)

| Step | Type | What it does |
|------|------|-------------|
| verify-content-completeness | programmatic | Per-page-type content verification with sampling. Fuzzy match + AI judge for borderline cases. |

**Assertion, not retry loop.** Uses rewritten content from prepare segment (all links
and images already resolved).

**Sampling:** Singletons: all. Collections: 2 random samples each.

**Per-sample:** Strip globals + shared, normalize images (local paths), strip HTML,
fuzzy match at 90% threshold. AI judge for borderline cases (85-95%).

**On failure:** Hard fail with diagnostics pointing to which upstream phase dropped content.

---

### Phase 8: assemble-registry

**Type:** Programmatic | **maxRetries:** 0

| Step | Type | What it does |
|------|------|-------------|
| assemble-registry | programmatic | Merges registry.json (from Phase 1) + globals + shared + field-classifications + render-maps into content-model.json (CMS adapter format) |

Produces `content-model.json` conforming to CMS adapter:
```typescript
// ContentModel = { collections: CollectionDef[] }
// CollectionDef = { name, type: "collection"|"singleton"|"global", fields: FieldDef[], slugField? }
// FieldDef = { name, type: FieldType, required, options?, target?, fields? }
```

Uses final routes already present in page-type-meta (set by prepare).

```
Globals:      header, footer       → CollectionDef type: "global"
Shared:       booking_cta, ...     → CollectionDef type: "global"
Collections:  blog_post, team, ... → CollectionDef type: "collection"
Singletons:   landing, about, ...  → CollectionDef type: "singleton"
```

**On failure:** Hard fail. All inputs validated upstream.

---

### Phase 9: cms-integration-test

**Type:** Programmatic | **maxRetries:** 0

| Step | Type | What it does |
|------|------|-------------|
| generate-seed-entries | programmatic | Generates CMS entry data from prepared content + field classifications + compose trees |
| push-to-sonicjs | programmatic | Pushes content model + entries + assets to local SonicJS |
| pull-and-compare | programmatic | Pulls entries back, compares field-by-field against what was pushed |

**Push+pull round-trip test.** Pulled data must match pushed data field by field.

**Image exemption:** Pushed images have local paths (`/images/abc123.jpg`), pulled images
have CMS media URLs (`https://r2.../abc123.jpg`). For image fields at any depth,
verify only that the pulled value is a non-empty URL.

**Compare rules:**
- String, number, boolean, datetime, richtext, select: exact match
- Relationship: verify target slug exists in pulled target collection
- Repeater/object: recursive comparison (images exempt at any depth)
- Extra fields in pull: ignore (CMS metadata)

**Output contract:**
```typescript
interface CmsTestResult {
  status: "pass" | "fail";
  pushResult: PushResult;
  pullResult: PullResult;
  comparison: CollectionComparison[];
}

interface CollectionComparison {
  collection: string;
  pushedCount: number;
  pulledCount: number;
  missingEntries: string[];
  fieldMismatches: FieldMismatch[];
}

interface FieldMismatch {
  slug: string;
  fieldPath: string;
  pushed: unknown;
  pulled: unknown;
  reason: "missing" | "value_differs" | "type_coerced";
}
```

**On failure:** Hard fail with per-field mismatch details.

---

## 8. Wireframe Segment — 5 Phases

**ID:** `wireframe`
**Depends:** `["classify"]`

```
Phase 1: seed                 (programmatic)
Phase 2: generate-layouts     (agent + static checks)
Phase 3: generate-components  (agent fan-out + static checks)
Phase 4: generate-pages       (agent fork per page + static checks + LLM content judge)
Phase 5: content-gate         (fuzzy match + LLM judge — hard fail, no recovery)
```

### Phase 1: seed

**Type:** Programmatic | **maxRetries:** 0

Generates Astro project scaffold from classify output:
- Content collections (`src/content/{collection}/{slug}.json`)
- Global data files (navigation, header, site metadata)
- `src/content.config.ts` with Zod schemas
- Route files at **rewritten** paths (`src/pages/blogs/[slug].astro`, not `src/pages/[slug].astro`)
- Component manifest (which components to generate, mapped to collections + interaction types)
- Copies downloaded images to `project/public/images/`

**On failure:** Hard fail.

### Phase 2: generate-layouts

**Type:** Agent + static checks | **maxRetries:** 3

Agent generates layout files (`src/layouts/`):
- Base layout with global content slots (header, footer, nav)
- Page-type-specific layouts if needed
- Semantic HTML, no styles

**Gate:** `bun run check` + `astro build` must pass.

### Phase 3: generate-components

**Type:** Agent fan-out + static checks | **maxRetries:** 3

One agent per component category:
- Navigation, header, footer (from globals)
- Shared components (booking_cta, testimonials, etc.)
- Collection cards (for listing pages)
- Content blocks (for detail pages)
- Interactive components (carousel, accordion, tabs, search)

**Gate:** `bun run check` + `astro build` must pass.

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

## 9. Data Flow

```
structure.json ─────┐
schema.json ────────┤
content.json ───────┤
                    ▼
PREPARE SEGMENT (fully programmatic):

Phase 1:  ingest ───────────────► pages.json, page-type-meta.json
          │
Phase 2:  download-assets ──────► asset-manifest.json, images/
          │
Phase 3:  resolve-routes ───────► (internal url-map; updates page-type-meta final patterns)
          │  (heuristic)
          │
Phase 4:  apply-rewrites ───────► prepared-content.json (all links + images rewritten)
          │
Phase 5:  build-heuristics ─────► structure-map.json, heuristics.json
          │
Phase 6:  validate-dataset ─────► PASS or HARD FAIL
          │
          ▼
CLASSIFY SEGMENT (depends: ["prepare"]):

Phase 1:  classify-page-types ──► registry.json (singleton/collection/listing + pairings)
          │  (agent + gate)
          │
Phase 2:  detect-globals ───────► globals.json
          │  (agent + gate)        ↓ strips globals from context
          │
Phase 3:  detect-shared ────────► shared-components.json (with interactionType)
          │  (agent + gate)        ↓ strips shared from context
          │
Phase 4:  classify-fields ──────► field-classifications.json
          │  (fan-out + 100% gate) ↓ identifies richtext fields
          │
Phase 5:  map-render-as ────────► render-maps.json
          │  (fan-out + 100% gate)
          │
Phase 6:  compose-trees ────────► content-model-classified.json
          │
Phase 7:  content-completeness ─► PASS or HARD FAIL
          │
Phase 8:  assemble-registry ────► content-model.json (registry.json already produced)
          │
Phase 9:  cms-integration-test ─► PASS or HARD FAIL
          │
          ▼
WIREFRAME SEGMENT (depends: ["classify"]):

Phase 1:  seed ─────────────────► Astro project scaffold (rewritten routes)
          │
Phase 2:  generate-layouts ─────► Layout .astro files (+ static checks)
          │
Phase 3:  generate-components ──► Component .astro files (+ static checks)
          │
Phase 4:  generate-pages ───────► Page route files (+ static checks + LLM judge)
          │  (fork per page type)
          │
Phase 5:  content-gate ─────────► PASS or HARD FAIL (no recovery)
```

---

## 10. Retry Flow

**Prepare segment (all programmatic — no retries):**

| Phase | maxRetries | On failure |
|-------|-----------|------------|
| 1: ingest | 0 | Hard fail (malformed input) |
| 2: download-assets | 0 | Hard fail (per-image retries internal) |
| 3: resolve-routes | 0 | Hard fail (deterministic heuristic) |
| 4: apply-rewrites | 0 | Hard fail (deterministic) |
| 5: build-heuristics | 0 | Hard fail (deterministic) |
| 6: validate-dataset | 0 | Hard fail — bug in phases 1-5 or unconsidered edge case |

**Classify segment:**

| Phase | maxRetries | On failure |
|-------|-----------|------------|
| 1: classify-page-types | 3 | Retry with rejection context |
| 2: detect-globals | 3 | Retry with rejection context |
| 3: detect-shared | 3 | Retry with rejection context |
| 4: classify-fields | 3 | Retry with per-scope rejection |
| 5: map-render-as | 3 | Retry with per-field rejection |
| 6: compose-trees | 0 | Hard fail (deterministic) |
| 7: content-completeness | 0 | Hard fail with diagnostics |
| 8: assemble-registry | 0 | Hard fail (deterministic) |
| 9: cms-integration-test | 0 | Hard fail with push/pull errors |

**Wireframe segment:**

| Phase | maxRetries | On failure |
|-------|-----------|------------|
| 1: seed | 0 | Hard fail (deterministic) |
| 2: generate-layouts | 3 | Retry with build errors |
| 3: generate-components | 3 | Retry with build errors per component |
| 4: generate-pages | 3 | Retry with per-page-type rejection |
| 5: content-gate | 0 | Hard fail — pipeline bug, no recovery |

---

## 11. Structure Map Format

Compact structural trees replace raw JSON in all downstream prompts.

```
article_content (object)
  sections (array[3])
    heading (string, 12 chars)
    body (string, 850 chars)
    images (array[2])
      src (local-image)
      alt (string, 7 chars)
author (string, 8 chars)
published_date (string, 10 chars)
```

Image URLs show as `local-image` type (all images localized by prepare segment).
Value-size hints distinguish richtext candidates (`string, 850 chars` = prose)
from labels (`string, 12 chars` = title).

---

## 12. Files to Create / Modify

### New files (prepare segment)

| File | Purpose |
|------|---------|
| `src/segments/prepare/index.ts` | SegmentDef registration, mergeInputs, extractOutput |
| `src/segments/prepare/phases.io.ts` | PhaseDef array — IO shell for 6 phases |
| `src/segments/prepare/ingest.ts` | Schema parsing, $ref resolution, validation |
| `src/segments/prepare/ingest.test.ts` | Tests |
| `src/segments/prepare/download.ts` | Image scanning, downloading, manifest building |
| `src/segments/prepare/download.test.ts` | Tests |
| `src/segments/prepare/routes.ts` | Route conflict detection, rewrite validation |
| `src/segments/prepare/routes.test.ts` | Tests |
| `src/segments/prepare/rewrites.ts` | Link rewriting, image URL replacement |
| `src/segments/prepare/rewrites.test.ts` | Tests |
| `src/segments/prepare/heuristics.ts` | Structure map builder, stats generation |
| `src/segments/prepare/heuristics.test.ts` | Tests |
| `src/segments/prepare/validate.ts` | Dataset completeness validation |
| `src/segments/prepare/validate.test.ts` | Tests |

### New files (classify segment)

| File | Purpose |
|------|---------|
| `src/segments/classify/index.ts` | SegmentDef registration, mergeInputs, extractOutput |
| `src/segments/classify/phases.io.ts` | PhaseDef array — IO shell for 9 phases |
| `src/segments/classify/page-types.ts` | Page type classification + listing pairing + validation gate |
| `src/segments/classify/page-types.test.ts` | Tests |
| `src/segments/classify/detect-globals.ts` | Global detection + validation gate |
| `src/segments/classify/detect-globals.test.ts` | Tests |
| `src/segments/classify/detect-shared.ts` | Shared + interaction detection + validation gate |
| `src/segments/classify/detect-shared.test.ts` | Tests |
| `src/segments/classify/classify-fields.ts` | Field classification + 100% coverage gate |
| `src/segments/classify/classify-fields.test.ts` | Tests |
| `src/segments/classify/render-maps.ts` | Render-as mapping + 100% coverage gate |
| `src/segments/classify/render-maps.test.ts` | Tests |
| `src/segments/classify/compose-trees.ts` | ComposeNode tree builder |
| `src/segments/classify/compose-trees.test.ts` | Tests |
| `src/segments/classify/content-completeness.ts` | Content completeness assertion |
| `src/segments/classify/content-completeness.test.ts` | Tests |
| `src/segments/classify/cms-test.ts` | CMS integration test |
| `src/segments/classify/cms-test.test.ts` | Tests |

### Modified files

| File | Changes |
|------|---------|
| `src/segments/wireframe/index.ts` | `depends: ["classify"]`, updated phase list |
| `src/segments/wireframe/phases.io.ts` | Replace old phases with 5 new phases |
| `src/segments/wireframe/seed.ts` | Consume classify + prepare output, use rewritten routes |
| `src/segments/wireframe/content-model.ts` | Types shared, composition engine used by classify too |
| `src/index.ts` | Register prepare + classify segments |

### Reusable from existing wireframe

| File | Reuse |
|------|-------|
| `src/segments/wireframe/reduce.ts` | Asset manifest, link rewriting logic → adapt for prepare |
| `src/segments/wireframe/adapter.ts` | Schema resolution → adapt for prepare/ingest |
| `src/segments/wireframe/classify.ts` | Route validation logic → adapt for prepare/routes |

### Files NOT changed

| File | Reason |
|------|--------|
| `src/engine/*` | Engine handles all segment/phase/step contracts as-is |
| `src/steps/step.ts` | Existing step builders work |
| `template/astro-project/cms/adapter.ts` | CMS adapter types already sufficient |
| `template/astro-project/cms/sonicjs.ts` | Push/pull implementation already works |

---

## 13. Implementation Order

### Prepare Segment (implement first)

1. **Scaffold:** `prepare/index.ts` — register segment
2. **Phase 1:** ingest.ts — parse, resolve $ref, validate
3. **Phase 2:** download.ts — scan images, download all, build manifest
4. **Phase 3:** routes.ts — heuristic route conflict detection + prefix rewrites (programmatic)
5. **Phase 4:** rewrites.ts — apply link + image rewrites to content
6. **Phase 5:** heuristics.ts — structure maps + stats
7. **Phase 6:** validate.ts — self-contained dataset assertion (catches bugs in 1-5)
8. **Wire phases.io.ts** — connect all phases
9. **Run `bun run check`** + test with both example datasets

### Classify Segment

10. **Scaffold:** `classify/index.ts` — register segment, depends on prepare
11. **Phase 1:** page-types.ts — agent classifies singleton/collection/listing + listing pairing
12. **Phase 2:** detect-globals.ts — agent + relaxed validation gate
13. **Phase 3:** detect-shared.ts — agent + interaction patterns
14. **Phase 4:** classify-fields.ts — fan-out + 100% coverage gate
15. **Phase 5:** render-maps.ts — fan-out + 100% coverage gate
16. **Phase 6:** compose-trees.ts — deterministic tree builder
17. **Phase 7:** content-completeness.ts — assertion
18. **Phase 8:** assemble-registry — merge into CMS format
19. **Phase 9:** cms-test.ts — SonicJS push+pull round-trip
20. **Wire phases.io.ts** + `bun run check`

### Wireframe Segment

21. **Update wireframe/index.ts** — `depends: ["classify"]`
22. **Phase 1: seed** — consume prepare + classify output, use final routes from page-type-meta
23. **Phase 2: generate-layouts** — agent + static checks
24. **Phase 3: generate-components** — fan-out + static checks
25. **Phase 4: generate-pages** — fork per page type + static checks + LLM judge
26. **Phase 5: content-gate** — fuzzy match + LLM judge (hard fail)
27. **Run full pipeline** — end-to-end convergence

---

## 14. What Was Explicitly Ruled Out

| Approach | Why rejected |
|----------|-------------|
| Reduce/sampling concept | All data kept, all images downloaded — no reduction |
| Programmatic global_keys/own_keys | AI decides ownership; structural hints advisory only |
| Globals must appear on ALL pages | Some pages skip layout; "most pages" is sufficient |
| Listing must have owner | Orphan listings (no collection target) are valid |
| Link rewriting before route resolution | Routes must be resolved first; rewrites propagate everywhere |
| AI-based route conflict resolution | Scraper URL patterns + page type names are enough signal — fully heuristic |
| Route map as downstream artifact | Internal to prepare; prepared-content carries final URLs so classify/wireframe never see original URLs |
| Page type classification in prepare | Semantic judgment (singleton/collection/listing) belongs with other AI classification |
| Listing pairing in prepare | Doesn't affect route resolution; pure semantic judgment → classify |
| Classification in data prep segment | Clean separation: prepare = IO/data, classify = AI/semantics |
| New ComposeNode format `{tag, path}` | Existing `{field, render_as, is_array}` carries traversal metadata |
| Content completeness as retry loop | If upstream gates pass, failure = bug, not AI error |
| Content-gate as retry loop | Pipeline bug, not recoverable |
| Heuristic fallbacks for render_as | Silent fallbacks mask errors; missing = must retry |
| CMS test with mock adapter | Real SonicJS catches schema issues a mock would miss |
| Single monolithic generate phase | Layout → components → pages must be sequential |

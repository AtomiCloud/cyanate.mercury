# Prepare Segment Spec

> **Purpose:** Download all assets, heuristically resolve route conflicts, rewrite all references, produce a self-contained dataset with no unresolved references and structural hints for classify. **Fully programmatic — zero AI.**
> **Depends:** `[]` (runs in parallel with analyze)
> **Status:** Architecture finalized. Ready for implementation.

---

## 1. Position in Pipeline

```
analyze  ──────────────────────────┐
                                   ├──► design
prepare ──► classify ──► wireframe ─┘
```

`prepare` and `analyze` run in parallel. `classify` consumes prepare output. Wireframe consumes classify + prepare outputs.

---

## 2. Input / Output

**Input:** `structure.json`, `schema.json`, `content.json` (raw scraper output).

**Output:** A fully self-contained dataset:

| Artifact | Description |
|----------|-------------|
| `pages.json` | Flat page list with resolved schemas (no `$ref`) |
| `page-type-meta.json` | Per-page-type: name, final URL pattern, count, all URLs |
| `prepared-content.json` | All content with images localized + internal links rewritten to final URLs |
| `asset-manifest.json` | Original image URL → local content-addressed path |
| `structure-map.json` | Compact structural trees per page type |
| `heuristics.json` | Page counts, avg content lengths, field frequency, structural hints |

**Internal (not exported):** The original→final URL map is built during route resolution and consumed immediately by apply-rewrites. It is **not** emitted as an artifact — prepared-content already carries final URLs. Downstream segments never see the original URLs.

**Not produced by prepare (moved to classify):**
- Page type classification (singleton/collection/listing) — semantic judgment
- Listing → collection pairing — semantic judgment

**Guarantee:** Classify never needs to fetch anything external. All images are local. All internal links resolve to final URLs. All schema refs are resolved. External links to other websites are left untouched (they're legitimate content data).

---

## 3. Design Principles

1. **Prepare is fully deterministic.** No AI calls. If a phase fails, it's a bug in our code or an unconsidered edge case.
2. **No sampling. No reduction.** All pages kept, all images downloaded.
3. **Downstream interface is minimal.** Classify/wireframe consume final URLs only — no route-map, no original URLs leaking through.
4. **Validation catches our bugs, not AI errors.** Phase 6 is a hard assertion that upstream phases did the right thing.

---

## 4. Phases

```
Phase 1: ingest             (programmatic — parse + validate schemas)
Phase 2: download-assets    (programmatic — download ALL images, build manifest)
Phase 3: resolve-routes     (programmatic — heuristic conflict detection, prefix rewrites)
Phase 4: apply-rewrites     (programmatic — rewrite links + images in content)
Phase 5: build-heuristics   (programmatic — structure maps, stats, field frequency)
Phase 6: validate-dataset   (programmatic assertion — self-contained, referentially complete)
```

0 AI phases. 6 programmatic.

---

## 5. Phase Definitions

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

**On failure:** Hard fail. Images that can't be downloaded after retries are logged but don't block — they get `downloaded: false` and downstream phases handle gracefully.

---

### Phase 3: resolve-routes

**Type:** Programmatic | **maxRetries:** 0

| Step | Type | What it does |
|------|------|-------------|
| resolve-routes | programmatic | Extracts common prefix per page type from scraper URLs, detects conflicts between dynamic route patterns at the same depth, adds page-type-name prefix for conflicts. Builds internal url-map for Phase 4. |

**Fully heuristic — no AI needed.** The scraper output (`structure.json`) already provides page type names, URL patterns, and all concrete URLs. This is enough signal for unambiguous route resolution.

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

**Updates page-type-meta.json:** The `urlPattern` and `urls` fields are updated to reflect final routes. Downstream phases only see final URLs.

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
- Also updates the per-page URL in `pages.json` to the final URL (so downstream sees final URLs only)

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

**On failure:** Hard fail. This is a bug in our code or an edge case we didn't consider — not an AI/retry scenario. Diagnostics point to which check failed and which phase likely dropped correctness.

---

## 6. Data Flow

```
structure.json ─────┐
schema.json ────────┤
content.json ───────┤
                    ▼

Phase 1: ingest ───────────────► pages.json, page-type-meta.json
         │
Phase 2: download-assets ──────► asset-manifest.json, images/
         │
Phase 3: resolve-routes ───────► (internal url-map; updates page-type-meta final patterns)
         │
Phase 4: apply-rewrites ───────► prepared-content.json (all links + images rewritten)
         │
Phase 5: build-heuristics ─────► structure-map.json, heuristics.json
         │
Phase 6: validate-dataset ─────► PASS or HARD FAIL
         │
         ▼
      (to classify)
```

---

## 7. Retry Flow

| Phase | maxRetries | On failure |
|-------|-----------|------------|
| 1: ingest | 0 | Hard fail (malformed input) |
| 2: download-assets | 0 | Hard fail (per-image retries internal) |
| 3: resolve-routes | 0 | Hard fail (deterministic heuristic) |
| 4: apply-rewrites | 0 | Hard fail (deterministic) |
| 5: build-heuristics | 0 | Hard fail (deterministic) |
| 6: validate-dataset | 0 | Hard fail — bug in phases 1-5 or unconsidered edge case |

---

## 8. Structure Map Format

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

Image URLs show as `local-image` type (all images localized by prepare segment). Value-size hints distinguish richtext candidates (`string, 850 chars` = prose) from labels (`string, 12 chars` = title).

---

## 9. Files to Create / Modify

### New files

| File | Purpose |
|------|---------|
| `src/segments/prepare/index.ts` | SegmentDef registration, mergeInputs, extractOutput |
| `src/segments/prepare/phases.io.ts` | PhaseDef array — IO shell for 6 phases |
| `src/segments/prepare/ingest.ts` | Schema parsing, $ref resolution, validation |
| `src/segments/prepare/ingest.test.ts` | Tests |
| `src/segments/prepare/download.ts` | Image scanning, downloading, manifest building |
| `src/segments/prepare/download.test.ts` | Tests |
| `src/segments/prepare/routes.ts` | Route conflict detection, prefix rewrite generation |
| `src/segments/prepare/routes.test.ts` | Tests |
| `src/segments/prepare/rewrites.ts` | Link rewriting, image URL replacement |
| `src/segments/prepare/rewrites.test.ts` | Tests |
| `src/segments/prepare/heuristics.ts` | Structure map builder, stats generation |
| `src/segments/prepare/heuristics.test.ts` | Tests |
| `src/segments/prepare/validate.ts` | Dataset completeness validation |
| `src/segments/prepare/validate.test.ts` | Tests |

### Modified files

| File | Changes |
|------|---------|
| `src/index.ts` | Register prepare segment |

### Reusable from existing wireframe

| File | Reuse |
|------|-------|
| `src/segments/wireframe/reduce.ts` | Asset manifest, link rewriting logic → adapt for prepare |
| `src/segments/wireframe/adapter.ts` | Schema resolution → adapt for prepare/ingest |
| `src/segments/wireframe/classify.ts` | Route validation logic → adapt for prepare/routes |

---

## 10. Implementation Order

1. **Scaffold:** `prepare/index.ts` — register segment
2. **Phase 1:** ingest.ts — parse, resolve $ref, validate
3. **Phase 2:** download.ts — scan images, download all, build manifest
4. **Phase 3:** routes.ts — heuristic route conflict detection + prefix rewrites (programmatic)
5. **Phase 4:** rewrites.ts — apply link + image rewrites to content
6. **Phase 5:** heuristics.ts — structure maps + stats
7. **Phase 6:** validate.ts — self-contained dataset assertion (catches bugs in 1-5)
8. **Wire phases.io.ts** — connect all phases
9. **Run `bun run check`** + test with both example datasets (`example/`, `example/royal/`)

---

## 11. What Was Explicitly Ruled Out

| Approach | Why rejected |
|----------|-------------|
| Reduce/sampling concept | All data kept, all images downloaded — no reduction |
| AI-based route conflict resolution | Scraper URL patterns + page type names are enough signal — fully heuristic |
| Route map as downstream artifact | Internal to prepare; prepared-content carries final URLs so classify/wireframe never see original URLs |
| Page type classification in prepare | Semantic judgment (singleton/collection/listing) belongs with other AI classification → classify |
| Listing pairing in prepare | Doesn't affect route resolution; pure semantic judgment → classify |
| Classification in data prep segment | Clean separation: prepare = IO/data, classify = AI/semantics |
| Link rewriting before route resolution | Routes must be resolved first; rewrites propagate everywhere |

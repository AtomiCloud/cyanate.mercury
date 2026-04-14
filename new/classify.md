# Classify Segment Spec

> **Purpose:** AI classification of clean data — page type classification, listing pairing, global/shared/owned detection, richtext detection, richtext composition.
> **Depends:** `["prepare"]`
> **Status:** Architecture finalized. Ready for implementation.

---

## 1. Position in Pipeline

```
analyze  ──────────────────────────┐
                                   ├──► design
prepare ──► classify ──► wireframe ─┘
```

`classify` receives all prepare outputs (self-contained dataset with final URLs, localized images, structure maps, heuristics). It produces the classified content model that wireframe uses to generate the Astro project.

---

## 2. Input / Output

**Input:** All prepare segment outputs (self-contained dataset):
- `pages.json` — flat page list with resolved schemas
- `page-type-meta.json` — page type names, final URL patterns, counts, all URLs
- `prepared-content.json` — all content with final URLs + localized images
- `asset-manifest.json` — original image URL → local path
- `structure-map.json` — compact structural trees per page type
- `heuristics.json` — page counts, field frequency, content length stats

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

## 3. Design Principles

1. **Every AI step that can be validated programmatically, must be.** No trusting agent output without a gate.
2. **Validation merges into internal loops.** The agent prompt asks the agent to self-check before declaring completion. But we still run a programmatic validator to gate the output. If the gate rejects, the phase runner retries with rejection context — the agent gets told exactly what it missed.
3. **100% completeness coverage.** Every field classified. Every richtext path mapped. No heuristic fallbacks. Missing = retry.
4. **Failed checks feed back into retry loops.** Rejection context includes the specific fields/paths that failed, not generic "some things are wrong."
5. **If all upstream gates pass, downstream assertions should hold.** Content completeness is a hard assertion. If it fails with 100% upstream coverage, it implies a bug in the validators — hard fail with diagnostics.

---

## 4. Phases

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

## 5. Phase Definitions

### Phase 1: classify-page-types

**Type:** Agent + programmatic gate | **maxRetries:** 3

| Step | Type | What it does |
|------|------|-------------|
| classify-page-types | agent | Sees page-type-meta (names, final URL patterns, counts) + structure maps + heuristics. Classifies each page type as singleton/collection/listing. Pairs listings to collections. |
| validate-page-types | programmatic | Every page type classified. Listing targets exist or are null. Classifications consistent with page counts. |

**Moved from prepare.** Page type classification and listing pairing are semantic judgments that belong alongside other AI classification, not in data prep.

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

**On gate failure:** Retry with rejection context listing which page types failed validation and why.

---

### Phase 2: detect-globals

**Type:** Agent + programmatic gate | **maxRetries:** 3

| Step | Type | What it does |
|------|------|-------------|
| detect-globals | agentFanOut | Agent sees all structure maps + content samples + field frequency heuristics. Identifies global content (site-wide, typically in layout). Spawns subagents to verify candidates across page types. |
| validate-globals | programmatic | Each global field appears on most page types (threshold determined by agent). Canonical content is non-empty. |

**Relaxed definition:** Globals are site-wide content typically rendered in the layout (header, footer, nav). They do NOT need to appear on ALL pages — some pages may skip the layout (e.g., a special landing page, an API endpoint, a maintenance page). The agent determines which page types participate and which are exceptions.

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

**Interaction pattern detection:** The agent identifies content blocks with interactive rendering behavior. Interaction types:
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

**On gate failure:** Retry with per-unit rejection context (e.g., "page:landing: hero_section.features missing", "global:header: nav_items[].icon missing").

---

### Phase 5: map-render-as

**Type:** Agent fan-out + 100% coverage gate | **maxRetries:** 3

| Step | Type | What it does |
|------|------|-------------|
| map-render-as | agentFanOut | One agent per richtext field (identified from Phase 4). Maps every child path to an HTML element. |
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

**Assertion, not retry loop.** Uses rewritten content from prepare segment (all links and images already resolved).

**Sampling:** Singletons: all. Collections: 2 random samples each.

**Per-sample:** Strip globals + shared, normalize images (local paths), strip HTML, fuzzy match at 90% threshold. AI judge for borderline cases (85-95%).

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

**Image exemption:** Pushed images have local paths (`/images/abc123.jpg`), pulled images have CMS media URLs (`https://r2.../abc123.jpg`). For image fields at any depth, verify only that the pulled value is a non-empty URL.

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

## 6. Data Flow

```
FROM PREPARE:
  pages.json, page-type-meta.json, prepared-content.json,
  asset-manifest.json, structure-map.json, heuristics.json
                    │
                    ▼

Phase 1:  classify-page-types ──► registry.json (singleton/collection/listing + pairings)
          │
Phase 2:  detect-globals ───────► globals.json
          │                        ↓ strips globals from context
          │
Phase 3:  detect-shared ────────► shared-components.json (with interactionType)
          │                        ↓ strips shared from context
          │
Phase 4:  classify-fields ──────► field-classifications.json
          │                        ↓ identifies richtext fields
          │
Phase 5:  map-render-as ────────► render-maps.json
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
      (to wireframe)
```

---

## 7. Retry Flow

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

---

## 8. Files to Create / Modify

### New files

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
| `src/index.ts` | Register classify segment |

---

## 9. Implementation Order

1. **Scaffold:** `classify/index.ts` — register segment, depends on prepare
2. **Phase 1:** page-types.ts — agent classifies singleton/collection/listing + listing pairing
3. **Phase 2:** detect-globals.ts — agent + relaxed validation gate
4. **Phase 3:** detect-shared.ts — agent + interaction patterns
5. **Phase 4:** classify-fields.ts — fan-out + 100% coverage gate
6. **Phase 5:** render-maps.ts — fan-out + 100% coverage gate
7. **Phase 6:** compose-trees.ts — deterministic tree builder
8. **Phase 7:** content-completeness.ts — assertion
9. **Phase 8:** assemble-registry — merge into CMS format
10. **Phase 9:** cms-test.ts — SonicJS push+pull round-trip
11. **Wire phases.io.ts** + `bun run check`

---

## 10. What Was Explicitly Ruled Out

| Approach | Why rejected |
|----------|-------------|
| Programmatic global_keys/own_keys | AI decides ownership; structural hints advisory only |
| Globals must appear on ALL pages | Some pages skip layout; "most pages" is sufficient |
| Listing must have owner | Orphan listings (no collection target) are valid |
| New ComposeNode format `{tag, path}` | Existing `{field, render_as, is_array}` carries traversal metadata |
| Content completeness as retry loop | If upstream gates pass, failure = bug, not AI error |
| Heuristic fallbacks for render_as | Silent fallbacks mask errors; missing = must retry |
| CMS test with mock adapter | Real SonicJS catches schema issues a mock would miss |

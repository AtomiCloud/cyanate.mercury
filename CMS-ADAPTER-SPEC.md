# CMS Adapter Spec

## Overview

Swappable adapter pattern for syncing content between Astro Content Collections (the canonical data format) and any headless CMS. The Astro project is CMS-agnostic — only the adapter implementation changes when switching CMS.

```
Pipeline generates content
        ↓
Astro Content Collections (src/content/*.json, src/data/*.json)
        ↕  CMS Adapter (push / pull)
Headless CMS (SonicJS, Directus, Strapi, Payload, etc.)
        ↓
Editors make changes in CMS
        ↓
cms:pull → astro build → deploy
```

### Lifecycle

1. **Pipeline runs** — generates `content-model.json`, Zod schemas, JSON content files, asset manifest
2. **Initial seed** — `bun run cms:push` creates CMS schemas, uploads images to R2, creates entries
3. **Ongoing editing** — editors work in CMS UI
4. **Sync back** — `bun run cms:pull` fetches CMS entries, overwrites `src/content/` and `src/data/` JSON files
5. **Deploy** — `bun run cms:pull:build` pulls + builds + indexes search

---

## Architecture

The CMS sync tool lives at `cms/` in the project root — **outside `src/`**. It is not part of the Astro app. Nothing in `src/` imports from `cms/`. The adapter runs standalone via `tsx cms/cli.ts`.

```
project-root/
  cms/                        ← CMS sync tool (standalone CLI, not part of Astro app)
    adapter.ts                ← interface + types
    sonicjs.ts                ← SonicJS implementation (default)
    cli.ts                    ← entry point: bun run cms push | pull
  cms.config.json             ← CMS connection config (gitignored)
  content-model.json          ← shared contract (pipeline output)
  asset-manifest.json         ← image paths (pipeline output)
  src/                        ← Astro app — zero CMS imports
    content/                  ← collections (one JSON per entry)
      doctors/
        jane-doe.json
        john-smith.json
      blog/
        my-first-post.json
    data/                     ← singletons + globals
      about.json
      globals/
        navigation.json
        footer.json
        settings.json
    content.config.ts         ← Zod schemas (generated from content-model.json)
    lib/
      content.ts              ← query layer (cached, indexed — already exists)
  tests/
    cms-integration/          ← integration tests (see Testing Strategy)
```

**Why `cms/` is outside `src/`:**
- It's a CLI tool, not app code — should not be in the Astro build graph
- Clear boundary: `src/` is the app, `cms/` is the sync tool
- No risk of accidentally importing adapter types into a `.astro` file
- `tsx cms/cli.ts push` reads naturally

**Separation of concerns:**

| Layer | Location | Responsibility |
|-------|----------|----------------|
| Data | `src/content/*.json`, `src/data/*.json` | Canonical content storage |
| Schema | `src/content.config.ts` | Zod validation + glob loaders |
| Query | `src/lib/content.ts` | Cached reads, indexed lookups |
| Sync | `cms/*` | Push/pull between files and CMS API |
| Config | `cms.config.json` | CMS connection (URL, adapter name, API key) |

---

## Content Model

The content model is the shared contract between the pipeline, the adapter, and the CMS. It lives in `content-model.json` at the project root.

### Types

```typescript
export type FieldType =
  | 'string' | 'number' | 'boolean' | 'datetime'
  | 'richtext' | 'image' | 'select' | 'relationship'
  | 'repeater' | 'object';

export interface FieldDef {
  name: string;
  type: FieldType;
  required: boolean;
  options?: string[];           // for select
  target?: string;              // for relationship — target collection name
  fields?: FieldDef[];          // for repeater/object — nested fields
}

export interface CollectionDef {
  name: string;
  type: 'collection' | 'singleton' | 'global';
  fields: FieldDef[];
  slugField?: string;           // which field is the slug (default: 'slug')
}

export interface ContentModel {
  collections: CollectionDef[];
}
```

### Field Type Mapping

| content-model type | Astro Zod | SonicJS | Storage format |
|---|---|---|---|
| `string` | `z.string()` | `type: 'string'` | `"value"` |
| `number` | `z.number()` | `type: 'number'` | `123` |
| `boolean` | `z.boolean()` | `type: 'boolean'` | `true` |
| `datetime` | `z.coerce.date()` | `type: 'datetime'` | `"2024-01-15T..."` |
| `richtext` | `z.string()` | `type: 'richtext'` | `"<p>HTML</p>"` |
| `image` | `z.string()` | `type: 'media'` | push: local path -> R2; pull: CMS URL |
| `select` | `z.enum([...])` | `type: 'select'` | `"published"` |
| `relationship` | `reference('coll')` | `type: 'reference'` | entry slug |
| `repeater` | `z.array(z.object())` | `type: 'array'` | `[{...}]` |
| `object` | `z.object()` | `type: 'object'` | `{...}` |

---

## Adapter Interface

```typescript
export interface CmsAdapter {
  name: string;

  /**
   * Push: Astro content files -> CMS
   *
   * Used for initial seed after pipeline generates content.
   * Creates CMS schemas/collections, uploads images, creates entries.
   */
  push(opts: {
    contentModel: ContentModel;
    collections: CollectionData[];
    assetManifest: AssetManifest;
    config: Record<string, string>;
  }): Promise<PushResult>;

  /**
   * Pull: CMS -> Astro content files
   *
   * Used for ongoing sync when content editors update the CMS.
   * Fetches all entries, transforms to Astro format, writes JSON files.
   */
  pull(opts: {
    contentModel: ContentModel;
    contentDir: string;   // absolute path to src/content/
    dataDir: string;      // absolute path to src/data/
    config: Record<string, string>;
  }): Promise<PullResult>;
}
```

### Data Types

```typescript
export interface EntryData {
  slug: string;
  data: Record<string, unknown>;
}

export interface CollectionData {
  name: string;
  type: 'collection' | 'singleton' | 'global';
  entries: EntryData[];
}

export interface AssetManifest {
  entries: { localPath: string; originalUrl: string }[];
}
```

### Result Types

```typescript
export interface PushResult {
  entriesPushed: number;
  imagesUploaded: number;
  schemasCreated: number;
  errors: SyncError[];
}

export interface PullResult {
  entriesPulled: number;
  filesWritten: string[];
  errors: SyncError[];
}

export interface SyncError {
  collection: string;
  slug?: string;
  field?: string;
  error: string;
}
```

---

## CLI

Entry point: `cms/cli.ts`. Subcommand pattern — `bun run cms <command>`.

```typescript
// cms/cli.ts — reads cms.config.json, loads adapter by name, dispatches subcommand.

const adapters: Record<string, () => Promise<CmsAdapter>> = {
  sonicjs: () => import('./sonicjs').then(m => m.sonicjs),
  // directus: () => import('./directus').then(m => m.directus),
};

// Usage: tsx cms/cli.ts push | pull
```

**Config file** (`cms.config.json`, gitignored):

```json
{
  "adapter": "sonicjs",
  "url": "https://your-sonicjs-instance.workers.dev",
  "apiKey": "your-api-token"
}
```

**package.json scripts:**

```json
{
  "cms": "tsx cms/cli.ts",
  "cms:pull:build": "tsx cms/cli.ts pull && astro build && pagefind --site dist"
}
```

**Usage:**

```bash
bun run cms push          # content files → CMS
bun run cms pull          # CMS → content files
bun run cms:pull:build    # pull + build + pagefind index
```

---

## SonicJS Adapter (Default)

### Push Flow

1. **Create schemas** — convert `content-model.json` field defs to SonicJS schema format
2. **Upload images** — read local files from asset manifest, POST to `/api/media/upload`, build `localPath -> cmsUrl` map
3. **Push entries** — for each collection entry: rewrite image fields using media map, POST to `/api/content`

### Pull Flow

1. **Fetch entries** — for each collection in content model, GET `/api/collections/{name}/content?limit=10000`
2. **Write files** — determine output path by collection type, write JSON:
   - `collection` -> `src/content/{name}/{slug}.json`
   - `singleton` -> `src/data/{name}.json`
   - `global` -> `src/data/globals/{name}.json`
3. **Images stay as CMS URLs** — CDN-served from R2, no downloading

### SonicJS Schema Field Types

SonicJS's schema system supports all 10 content-model field types. The mapping:

| content-model type | SonicJS schema type | Notes |
|---|---|---|
| `string` | `string` | |
| `number` | `number` | |
| `boolean` | `boolean` | |
| `datetime` | `datetime` | |
| `richtext` | `richtext` | |
| `image` | `media` | Files stored in R2; metadata in separate `media` table; field stores media ID |
| `select` | `select` | |
| `relationship` | `reference` | Set `collection` property to bind to target collection |
| `repeater` | `array` | Use `items` config for element schema; supports `blocks` for discriminated unions |
| `object` | `object` | Use `properties` config for nested field definitions |

All types have admin UI rendering (pickers, nested editors, media grids). The adapter must use these schema types when creating collections via the API so editors get proper UI controls.

### Known SonicJS Constraints

- **No singletons** — use single-entry collections as workaround
- **No many-to-many** — use arrays of slugs, one-directional only
- **No GraphQL** — REST only
- **No i18n** — not on SonicJS roadmap
- **Cloudflare-only deployment**
- **Single `content` table** — all collections share one table with JSON `data` column; no DB-level foreign keys. This is a **storage** limitation, not a schema limitation — the schema system and admin UI fully support all field types above, but the underlying D1 database stores all content as JSON blobs without relational joins or foreign key enforcement

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Astro content files are canonical | CMS is a UI layer; files are the source of truth the build reads |
| Push uploads images to R2 | One-time seed; CMS editors need to see/manage images in the CMS UI |
| Pull keeps CMS URLs for images | CDN-served, no downloading, no local `public/images/` bloat |
| Non-image fields are identity transforms | Richtext stays HTML, scalars copy as-is, no lossy conversion |
| Slugs are the shared identifier | Not UUIDs, not file paths — human-readable, URL-safe |
| Adapter registry is a plain object | No plugin system, no framework — just import and register |
| No CMS types leak into Astro | Templates import from `astro:content` and `src/lib/content.ts`, never from `cms/*` |
| CMS tool lives outside `src/` | `cms/` is a standalone CLI, not in the Astro build graph |

---

## Implementing a New Adapter

1. Create `cms/<cms-name>.ts` implementing `CmsAdapter`
2. Add to the registry in `cms/cli.ts`
3. Update `cms.config.json` to set `"adapter": "<cms-name>"`
4. No Astro template changes needed — content collections are the interface

The adapter only needs to:
- **Push:** Create schemas/collections in the CMS, upload images, create entries
- **Pull:** Fetch entries, write JSON to `src/content/` and `src/data/`

Everything else (Zod validation, content queries, routing, Pagefind indexing) stays the same.

---

## Definition of Done

### Functional Requirements

#### F1: Adapter Interface (`cms/adapter.ts`)

- [ ] Exports all types: `FieldType`, `FieldDef`, `CollectionDef`, `ContentModel`, `EntryData`, `CollectionData`, `AssetManifest`, `PushResult`, `PullResult`, `SyncError`, `CmsAdapter`
- [ ] `CmsAdapter` interface defines `name`, `push()`, `pull()` with the signatures specified above
- [ ] No CMS-specific types in this file — it is the abstract contract

#### F2: CLI (`cms/cli.ts`)

- [ ] `bun run cms push` reads `cms.config.json`, `content-model.json`, `asset-manifest.json`, walks `src/content/` and `src/data/`, calls `adapter.push()`
- [ ] `bun run cms pull` reads `cms.config.json`, `content-model.json`, calls `adapter.pull()` with absolute paths to `src/content/` and `src/data/`
- [ ] Exits with code 0 on success, code 1 on errors
- [ ] Prints summary to stdout: entries pushed/pulled, images uploaded, files written
- [ ] Prints errors to stderr with collection name, slug, and field context
- [ ] Fails fast with a clear message if `cms.config.json` is missing or adapter name is unknown

#### F3: Push — Content Files to CMS

- [ ] Creates CMS collection schemas matching every collection in `content-model.json`
- [ ] Uploads every image in `asset-manifest.json` to CMS media storage
- [ ] Builds a `localPath -> cmsUrl` map from upload responses
- [ ] Creates one CMS entry per JSON file in `src/content/{collection}/` and `src/data/`
- [ ] Rewrites image fields (including nested inside `repeater` and `object` fields) from local paths to CMS URLs before pushing
- [ ] Sets entry status to `published`
- [ ] Reports accurate counts in `PushResult` (entries, images, schemas)
- [ ] Collects per-entry errors without aborting the entire push — partial success is acceptable

#### F4: Pull — CMS to Content Files

- [ ] Fetches all entries for every collection defined in `content-model.json`
- [ ] Writes `collection` entries to `src/content/{name}/{slug}.json`
- [ ] Writes `singleton` entries to `src/data/{name}.json`
- [ ] Writes `global` entries to `src/data/globals/{name}.json`
- [ ] Creates directories as needed (`mkdir -p` equivalent)
- [ ] Output JSON is pretty-printed (2-space indent, trailing newline)
- [ ] Image fields retain CMS URLs as-is (no downloading)
- [ ] Non-image fields are identity-transformed (no lossy conversion)
- [ ] Written files pass Zod validation defined in `content.config.ts` (schema-conformant)
- [ ] Reports accurate counts in `PullResult` (entries pulled, files written)
- [ ] Collects per-collection errors without aborting — partial success is acceptable

#### F5: Content Model Fidelity

- [ ] All 10 field types (`string`, `number`, `boolean`, `datetime`, `richtext`, `image`, `select`, `relationship`, `repeater`, `object`) round-trip correctly through push then pull
- [ ] Nested fields inside `repeater` and `object` are handled recursively (arbitrary depth)
- [ ] `select` fields preserve their allowed options
- [ ] `relationship` fields store target entry slugs, not CMS internal IDs
- [ ] `required` field constraint is respected in the CMS schema

#### F6: Adapter Swappability

- [ ] Switching adapter requires only: (a) new `.ts` file in `cms/` implementing `CmsAdapter`, (b) one line in `cms/cli.ts` registry, (c) `cms.config.json` adapter name change
- [ ] No file in `src/` imports from `cms/` — the CMS tool is completely outside the Astro app
- [ ] `src/lib/content.ts` (query layer) has no CMS adapter imports

---

### Non-Functional Requirements

#### NF1: Correctness

- [ ] **Round-trip integrity**: push then immediately pull produces JSON files byte-identical to the originals (modulo image URLs which change from local paths to CMS URLs)
- [ ] **Idempotent push**: running push twice with the same content produces no duplicates (upsert by slug)
- [ ] **Idempotent pull**: running pull twice writes identical files (deterministic output)
- [ ] **No data loss**: every field in every entry survives the round-trip; no silent drops

#### NF2: Error Handling

- [ ] **Partial failure**: a single entry or image failure does not abort the entire operation
- [ ] **Structured errors**: every error in `SyncError[]` includes `collection` and `error` message; `slug` and `field` are included when applicable
- [ ] **Exit codes**: CLI exits 0 when `errors.length === 0`, exits 1 otherwise
- [ ] **Network errors**: adapter handles fetch failures gracefully (timeout, 4xx, 5xx) and reports them as `SyncError` entries
- [ ] **Missing config**: CLI fails fast with a human-readable message, not an uncaught exception

#### NF3: Performance

- [ ] **Image uploads**: parallelized (configurable concurrency, default 5) — not sequential
- [ ] **Entry push**: batched or parallelized where CMS API allows
- [ ] **Pull**: all collections fetched in parallel
- [ ] **Target**: push completes within 5 minutes for a 100-entry, 50-image site; pull completes within 30 seconds for same

#### NF4: Security

- [ ] `cms.config.json` is in `.gitignore` — API keys never committed
- [ ] API key passed via `Authorization: Bearer` header, never in URL query params
- [ ] No secrets logged to stdout/stderr (mask API keys in error messages if needed)

#### NF5: Maintainability

- [ ] Adapter implementation is a single file (no class hierarchy, no base class)
- [ ] No runtime dependencies beyond `node:fs`, `node:path`, and `fetch` (available in Bun/Node 18+)
- [ ] Types are self-documenting — field names match their purpose, no abbreviations
- [ ] Helpers (`rewriteImageFields`, `writeJsonFile`, etc.) are private to the adapter file, not shared

#### NF6: Observability

- [ ] Push prints progress: `Uploading images... (12/50)`, `Pushing entries... (45/100)`
- [ ] Pull prints progress: `Pulling collection "doctors"... (15 entries)`
- [ ] Final summary printed on completion: `Pushed 100 entries, 50 images, 8 schemas (0 errors)`
- [ ] Errors printed with enough context to diagnose without reading code: `Error in doctors/jane-doe [heroImage]: 413 Payload Too Large`

#### NF7: Compatibility

- [ ] Runs under Bun (primary) and Node.js 18+ (fallback)
- [ ] Uses ESM imports (`import`, not `require`)
- [ ] TypeScript strict mode compatible
- [ ] No Astro runtime dependency — CLI runs standalone (not inside `astro dev` or `astro build`)

---

## Testing Strategy

### Approach: Full Local Integration via wrangler dev

Skip unit and contract test layers. Test against a **real local SonicJS instance** to prove the adapter actually works end-to-end. `wrangler dev` runs entirely local — no Cloudflare account, no uploading, no internet required.

| Production | Local (`wrangler dev`) |
|------------|----------------------|
| Cloudflare Workers | Local Workers runtime on `localhost:8787` |
| D1 (edge SQLite) | Local SQLite files in `.wrangler/state/v3/d1/` |
| R2 (object storage) | Local filesystem in `.wrangler/state/v3/r2/` |

### Local SonicJS Setup

SonicJS is scaffolded via `npx create-sonicjs@latest` and runs locally with wrangler. The test harness manages this as a sidecar.

```
tests/
  cms-integration/
    sonicjs-app/              ← scaffolded SonicJS instance (gitignored)
    fixtures/
      content-model.json      ← 3 collections, 1 singleton, 1 global
      asset-manifest.json     ← 3 test images
      src/
        content/
          doctors/
            jane-doe.json     ← exercises: string, image, richtext, relationship
            john-smith.json
          blog/
            hello-world.json  ← exercises: datetime, select, repeater, object
        data/
          about.json          ← singleton
          globals/
            navigation.json   ← global with nested repeater (nav items)
      images/
        hero.jpg              ← small test images (1x1 px placeholders are fine)
        portrait-jane.jpg
        portrait-john.jpg
    cms.config.json           ← points to localhost:8787
    run.ts                    ← test runner script
```

**Fixture requirements:** every fixture entry must exercise at least one field of each of the 10 field types across the full fixture set. Nested `repeater` and `object` fields must go at least 2 levels deep.

### Setup Script (`tests/cms-integration/setup.sh`)

```bash
#!/bin/bash
set -euo pipefail

SONICJS_DIR="tests/cms-integration/sonicjs-app"

# 1. Scaffold SonicJS if not already present
if [ ! -d "$SONICJS_DIR" ]; then
  echo "Scaffolding SonicJS..."
  npx create-sonicjs@latest "$SONICJS_DIR" --defaults
fi

# 2. Install deps (wrangler comes with create-sonicjs)
cd "$SONICJS_DIR"
bun install

# 3. Run D1 migrations
bunx wrangler d1 migrations apply DB --local

echo "SonicJS ready. Run: cd $SONICJS_DIR && bunx wrangler dev"
```

### Test Runner (`tests/cms-integration/run.ts`)

The test runner is a single script that starts SonicJS, runs the full push/pull cycle, and asserts correctness. Run with `bun run test:cms`.

**Sequence:**

```
1. Start SonicJS
   └─ bunx wrangler dev (background, wait for localhost:8787 to respond)

2. Push fixtures
   └─ bun run cms push (using fixtures/ as content source, cms.config.json pointing to localhost)
   └─ Assert: PushResult.errors is empty
   └─ Assert: PushResult.entriesPushed === expected count
   └─ Assert: PushResult.imagesUploaded === 3

3. Pull to temp directory
   └─ bun run cms pull (output to a temp dir, not fixtures/)
   └─ Assert: PullResult.errors is empty
   └─ Assert: PullResult.entriesPulled === expected count

4. Diff: fixture vs pulled output
   For each pulled JSON file:
   └─ Assert: file exists at correct path (collection/singleton/global routing)
   └─ Assert: every non-image field matches fixture value (deep equality)
   └─ Assert: image fields are valid URLs (not local paths)
   └─ Assert: JSON is pretty-printed (2-space indent, trailing newline)

5. Idempotent push
   └─ bun run cms push again (same fixtures)
   └─ Assert: no duplicate entries created (pull count unchanged)

6. Idempotent pull
   └─ bun run cms pull again to a second temp dir
   └─ Assert: output is byte-identical to first pull

7. Error handling
   └─ Push an entry with a deliberately broken image path
   └─ Assert: PushResult.errors contains exactly 1 SyncError with correct collection/slug/field
   └─ Assert: other entries still pushed successfully (partial failure)

8. Cleanup
   └─ Kill wrangler dev
   └─ Remove temp directories
   └─ Report pass/fail summary
```

### package.json Scripts

```json
{
  "cms": "tsx cms/cli.ts",
  "cms:pull:build": "tsx cms/cli.ts pull && astro build && pagefind --site dist",
  "test:cms:setup": "bash tests/cms-integration/setup.sh",
  "test:cms": "tsx tests/cms-integration/run.ts"
}
```

```bash
# One-time setup (scaffolds local SonicJS, installs wrangler, runs migrations)
bun run test:cms:setup

# Run tests (starts wrangler dev, runs push/pull cycle, asserts, kills wrangler)
bun run test:cms
```

### What the Tests Prove

| Test step | DoD items covered |
|-----------|-------------------|
| Push succeeds with 0 errors | F3 (push), NF2 (error reporting) |
| Pull succeeds with 0 errors | F4 (pull), NF2 (error reporting) |
| File path routing correct | F4 (collection/singleton/global paths) |
| Non-image fields round-trip | F5 (all 10 field types), NF1 (round-trip integrity) |
| Image fields rewritten to URLs | F3 (image rewriting), F4 (URLs retained) |
| Nested repeater/object fields survive | F5 (recursive nesting) |
| Push idempotent | NF1 (idempotent push) |
| Pull deterministic | NF1 (idempotent pull) |
| Partial failure collected | NF2 (partial failure, structured errors) |
| Pretty-printed JSON output | F4 (output format) |

### What's NOT Testable Locally

- **R2 production behavior** — local R2 is filesystem-based; production R2 has size limits, eventual consistency, and CDN caching
- **Rate limits** — `wrangler dev` has no rate limiting; production Cloudflare Workers do
- **Payload size limits** — local D1 may accept larger payloads than production D1 (max 1MB row size)
- **SonicJS version drift** — pin `create-sonicjs` version in setup script to avoid surprises

### .gitignore Additions

```
tests/cms-integration/sonicjs-app/
tests/cms-integration/tmp/
```

---

## Out of Scope

These are explicitly **not** part of this spec:

- **Incremental sync** — pull fetches everything; no diffing, no delta sync, no timestamps
- **Webhook receiver** — pull is CLI-triggered (cron or CI), not push-based from CMS
- **Conflict resolution** — last write wins; no merging, no locking
- **Schema migration** — content model changes require re-push; no diffing of old vs new schemas
- **Multi-environment** — one `cms.config.json` per project; no staging/production split
- **Media optimization** — images pushed as-is; no resizing, no format conversion
- **i18n / localization** — single locale only
- **User/role management** — adapter does not create CMS users or set permissions
- **Content validation on pull** — Zod validation happens at Astro build time, not in the adapter

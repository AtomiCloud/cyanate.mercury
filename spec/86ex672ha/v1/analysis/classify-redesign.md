# Classify Phase Redesign: Analysis & Design Decisions

> Status: Design phase -- open questions remain (see Section 5).
> Context: Wireframe segment `classify` phase fails repeatedly due to architectural
> limitations. This document captures the full analysis, discussion, and proposed
> redesign so a new session can continue without losing context.

---

## 1. Background: The Problem

### Triggering failure

Run `20260413-033138` failed. The wireframe segment exhausted 8 retries on the
classify phase (iterations 2-9).

| Segment | Result | Cost | Duration | Steps | Turns |
|---------|--------|------|----------|-------|-------|
| analyze | completed | $4.40 | ~5.4min | 75 | 208 |
| wireframe | **failed** | $8.21 | ~18min | 172 | 523 |
| design | skipped (fan-in dependency failed) | -- | -- | -- | -- |
| **Total** | | **$12.61** | **17m56s** | | |

The prior run (`20260412-234806`) also took 6 retries on classify before passing,
confirming this is a **recurring issue**, not a one-off.

### How the current classify phase works

The classify phase has 5 sequential steps:

1. **build-registry** (programmatic) -- reads `reduced-meta.json` + `structure.json`,
   produces `registry-draft.json`.
2. **pair-listings** (agent) -- pairs listing pages to collections
   (e.g., `blog_listing` -> `blog_post`).
3. **classify-content-model** (agent, fan-out) -- the core step. Fans out one agent
   call per page type (up to 5 concurrent via semaphore). Each agent receives the
   page type's schema + a sample of the richest page content (truncated to 3000
   chars), and must output:
   - `field_classifications[]` -- type for every field
     (`string`/`image`/`richtext`/`relationship`/`object`/`repeater`)
   - `compose_spec` for richtext fields -- a `ComposeNode` tree that walks nested
     JSON to emit HTML
   - `body_compose` for richtext-dominant page types -- a top-level compose tree for
     the page body
   - `target_collection` for relationship fields
4. **verify-content-transformers** (programmatic) -- simulates the seed transform via
   `buildEntryJson()` on 2 random sample pages per type, measures content
   completeness via `extractLeafStrings()` comparison. Threshold: 90%. Failures go
   through an LLM-as-judge to confirm real content loss.
5. **assemble-registry** (programmatic) -- merges classifications + pairings into the
   final registry.

On rejection, the segment runner (`src/engine/segment-runner.ts:200-303`) retries
the **ENTIRE phase**, copying the failed iteration's workdir and passing aggregated
rejection context to ALL steps.

### Key source files

| File | Lines | Purpose |
|------|-------|---------|
| `src/segments/wireframe/phases.io.ts` | 302-370 | `buildClassifySinglePageTypePrompt` -- prompt builder |
| `src/segments/wireframe/phases.io.ts` | 277-298 | `buildPageTypeSampleContext` -- sample context builder |
| `src/segments/wireframe/phases.io.ts` | 950-1103 | Classify fan-out orchestration |
| `src/segments/wireframe/phases.io.ts` | 1107-1184 | Verify step |
| `src/segments/wireframe/phases.io.ts` | 194-196 | Image exclusion (or lack thereof) in coverage |
| `src/segments/wireframe/content-model.ts` | 343-375 | `validateContentModelClassification` |
| `src/segments/wireframe/content-model.ts` | 472-521 | `verifyContentCompleteness` |
| `src/segments/wireframe/content-model.ts` | 389-444 | `extractLeafStrings`, `walkLeaves` |
| `src/segments/wireframe/content-model.ts` | 126-150 | `resolveImageUrl` |
| `src/segments/wireframe/seed.ts` | 84-117 | `buildEntryJson` -- seed transform |
| `src/segments/wireframe/reduce.ts` | 331-379 | `buildReducedMeta` -- reduced meta builder |
| `src/engine/segment-runner.ts` | 200-303 | Retry mechanism |
| `template/astro-project/cms/adapter.ts` | -- | `CollectionDef` has `type: "collection" \| "singleton" \| "global"` |
| `template/astro-project/cms/sonicjs.ts` | -- | Supports `global` type already |

### The retry pattern (run 20260413-033138)

| Iter | Failing Step | Error |
|------|-------------|-------|
| 2 | classify-content-model | `testimonials.header/footer` is relationship, no `target_collection` |
| 3 | verify-content-transformers | Coverage: landing 32%, team 72%, testimonials 34%, blog_post 41% |
| 4 | classify-content-model | `team_listing`: invalid JSON format |
| 5 | classify-content-model | `testimonials/team_member` header/footer: missing `target_collection` |
| 6 | classify-content-model | `landing`: invalid JSON format |
| 7 | classify-content-model | `blog_post.article_content`: richtext, no `compose_spec` |
| 8 | classify-content-model | `landing.header`: missing `target_collection` |
| 9 | verify-content-transformers | Coverage: landing 32%, blog_listing 65%, testimonials 34%, blog_post 56% |

**Pattern:** Oscillation across different error types and different page types.
Never converges.

---

## 2. Identified Problems (6 total)

### P1: Cross-page retry contamination (Micro)

**Location:** `src/segments/wireframe/phases.io.ts:978-980`

The rejection context from ALL page types is passed identically to EVERY page type's
agent on retry:

```typescript
const retryContext = ctx.rejectionContext
    ? `\n\nPREVIOUS ATTEMPT REJECTED. Fix these issues:\n${ctx.rejectionContext}`
    : "";
```

This `retryContext` is computed once and passed to all 10 page-type prompts. The
`landing` agent sees complaints about `testimonials.header`, tries to compensate,
breaks itself. **This is the primary driver of oscillation.**

### P2: Missing ownership metadata in prompt (Micro)

**Location:** `src/segments/wireframe/phases.io.ts:277-298` and `950-1003`

`reduced-meta.json` already has `global_keys: ["header", "footer"]` and per-type
`own_keys` (e.g., `landing.own_keys = ["hero_section", "services_preview", ...]`).
But the classify step only reads `page_types[].{pagetype, count, route, multi}` --
it never passes `global_keys` or `own_keys` to the prompt. The agent guesses which
fields are shared vs page-owned.

The actual `reduced-meta.json` for this run has:

- `global_keys: ["footer", "header"]`
- 10 page types, each with `own_keys`
- Example: `landing.own_keys = ["approach_section", "approach_steps", "cta_section",
  "hero_section", "services_preview", "team_preview", "testimonials_section"]`

### P3: No explicit validation rules in prompt (Micro)

**Location:** prompt at `phases.io.ts:311-369` vs validator at
`content-model.ts:343-375`

The prompt describes field types in prose but never states the exact rules the code
enforces:

- `type === "relationship"` MUST have `target_collection`
- `type === "richtext"` MUST have `compose_spec`

6 of 8 rejections were from these missing fields.

### P4: Image URLs penalize coverage metric (Micro)

**Location:** `phases.io.ts:194-196` and `content-model.ts:472-521`

The completeness verifier excludes relationship fields but NOT image fields from the
coverage check. `buildEntryJson()` rewrites image URLs via the asset manifest
(`resolveImageUrl` in `content-model.ts:126-150`): Wix URL ->
`/images/local-name.jpg`. The original Wix URL is in
`extractLeafStrings(original)` but not in `extractLeafStrings(cmsJson)` -- counted
as "missing."

The reduce phase produces `asset-manifest.json` (28.1K) which is available in the
classify workdir. For a Wix site with 25+ images per page, this drops coverage
20-40%. **The landing page's 32% coverage is substantially caused by this.**

### P5: body_compose is too complex for one-shot agent generation (Macro)

**Location:** `phases.io.ts:328-342`

The agent must simultaneously: decide field types, produce compose trees for richtext
fields, name relationship targets. Schema is truncated to 2000 chars, content to
3000 chars (`phases.io.ts:289-293`). For pages with deep nesting (blog_post: 633
lines of JSON), the truncated sample doesn't show the full structure, so compose
trees miss subtrees.

### P6: Rejection context for coverage is not actionable (Micro)

**Location:** `phases.io.ts:1159-1167`

The rejection message dumps raw Wix URLs:
`"missing 52 items: https://static.wixstatic.com/media/..."` rather than identifying
which field paths in the JSON tree are missing from the compose tree.

---

## 3. Design Discussion & Decisions

### Decision: Split global/shared detection from per-page classification

**Rationale:** A field is "global" because it is the same ACROSS page types. Fan-out
agents (one per type) cannot see this -- they only see one type. Global/shared
detection needs cross-page-type context.

**Global** = layout content (header, footer, nav). Lives in the Astro layout, not in
page CMS entries. Fetched once, passed to all pages.

**Shared** = reusable components (forms, booking widgets, calendars, interactive
stuff). The LLM judges semantically -- "would a CMS editor manage this as one
reusable entry?"

**CMS representation:** Both become `CollectionDef` with `type: "global"` -- already
supported by the adapter interface (`template/astro-project/cms/adapter.ts`) and
SonicJS (`template/astro-project/cms/sonicjs.ts`).

### Decision: Progressive exploration with subagents for global/shared detection

**Pattern:** Main agent sees all structure trees side-by-side. Hypothesizes
candidates. Spawns subagents to read actual content and make SEMANTIC judgments (not
mechanical comparison).

Example subagent task: "Read `cta_section` on landing vs about vs service -- is this
the same booking widget (shared), or different CTAs with the same field structure
(page-specific)?"

The main agent reviews evidence, makes the call. Can spawn more subagents if
uncertain. Iterates.

### Decision: Build a structure map as foundation

**What:** A programmatic step that walks every page type's richest sample JSON and
produces a compact structural representation -- no raw values, just shape with
value-size hints.

Example:

```
hero_section (object)
  headline (string, 24 chars)
  image (url)
  features (array[5])
    title (string, 12 chars)
    icon (url)
    description (string, 85 chars)
```

**Why:** The current prompt truncates content to 3000 chars. The structure map shows
the FULL tree of a 633-line `blog_post` in ~40 lines. Every downstream step (global
detection, classification, `render_as` mapping) uses this.

**Value-size hints included?** YES -- helps distinguish richtext candidates
(`string, 180 chars` = probably prose) from labels (`string, 10 chars` = probably
title).

### Decision: Split field type classification from render_as mapping

These are different cognitive tasks:

- "What kind of field is this?" (`richtext` vs `object` vs `string`) --
  structural/CMS decision.
- "What HTML element does this render as?" (`h2` vs `p` vs `img`) --
  semantic/visual decision.

Different verification, different retry granularity. A `render_as` mistake should
not force reclassification of the field type.

### Decision: render_as mapping is per-richtext-field, not per-page-type

One agent per richtext field. Very focused -- "map every child path in
`article_content` to an HTML element." Easy to verify (structure map gives all
paths), easy to retry in isolation. More expensive than per-page-type but higher
accuracy.

### Decision: No heuristic fallbacks for missing render_as

If the classifier misses a field path's `render_as`, it should NOT fall back to
heuristics. Send it back to the agent with specific feedback about what is missing.
Silent fallbacks mask errors.

### Decision: Programmatic compose building from verified render_maps

After `render_as` is validated, a purely programmatic step assembles `ComposeNode`
trees. No LLM needed. If all paths are mapped, coverage is guaranteed by
construction.

### Decision: Content completeness check strips globals, shared, normalizes images

The verification should:

1. Strip global content (layout).
2. Strip shared content (components).
3. Normalize images (asset manifest URLs count as "found").
4. Strip syntax differences (HTML tags, whitespace).
5. Then compare own content vs CMS output.

### Decision: Every step has its own verify-fix loop

No whole-phase retries. No broadcasting errors to unrelated page types. Each step
handles its own failures internally:

- `detect-globals`: own retry budget
- `classify-content` (compound): internal loop, per-page-type retry for
  classification, can re-detect shared if needed
- `map-render-as`: per-richtext-field retry
- `build-and-verify`: routes failures to the right upstream step

### Decision: Sampling per page type, not 2 random across all

For globals: verify with 1 sample from EACH page type that has the global field. If
`header` appears on all 10 types, check 10 samples. For shared: 1 sample from each
type that has the shared field. Catches cases where a field looks shared from 2
samples but varies on type 7.

### Decision: Phase runner does not need to change

Steps implement their own retry loops internally. A "compound step" like
`classify-content` appears as one step to the phase runner but handles sub-step
sequencing and targeted retries internally.

---

## 4. Proposed Architecture

### Step overview

```
Existing (unchanged):
  Step 1: build-registry (programmatic)
  Step 2: pair-listings (agent)

New:
  Step 3: build-structure-map (programmatic)

  Step 4: detect-globals
          (single agent + subagents, own verify-fix loop)
          Budget: own retry count (e.g., 3)
          Verify: 1 sample per page type, original = global + remainder
          Output: globals.json, content stripped of globals

  Step 5: classify-content (compound step, internal loop)
          Sub-step A: detect-shared (single agent + subagents)
          Sub-step B: classify field types (fan-out, per page type, own_keys only,
                      full structure tree)
          Sub-step C: validate field coverage (every own_key path classified?)
          On fail: retry specific page type, or re-detect shared if repeated
                   failures suggest wrong boundary
          Budget: own retry count
          Output: shared-components.json, field-classifications.json

  Step 6: map-render-as (per richtext field, own verify-fix loop)
          Per richtext field:
            Agent maps every child path -> HTML element
            Validate: every leaf path in subtree has render_as?
            On fail: retry that field's agent with specific missing paths
          Budget: per-field retry count
          Output: render-maps.json

  Step 7: build-and-verify (programmatic compose + content completeness)
          Build ComposeNode trees from render-maps (deterministic)
          Simulate seed transform, 1 sample per page type
          Strip globals, strip shared, normalize images, strip syntax
          Check: 90% content preserved?
          On fail: determine cause:
            - missing content under richtext field -> loop to step 6
              (render_as issue)
            - missing content under non-richtext field -> loop to step 5
              (classification issue)
          Output: content-model-classified.json

  Step 8: assemble-registry (programmatic)
          Merge: globals (type:global) + shared (type:global) + page
          collections/singletons
          Validate: all relationship targets exist, all listing->collection
          pairings valid
          On fail: -> loop to step 5 (bad reference = bad classification)
          Output: registry.json, content-model.json
```

8 total steps. 3 with LLM agents (4, 5, 6). 5 programmatic (3, 7, 8, plus
sub-steps within 5).

### CMS representation

```
CMS Dashboard:
+-- Globals
|   +-- Header (edit once -> appears on all pages via layout)
|   +-- Footer (edit once -> appears on all pages via layout)
+-- Shared Components
|   +-- Booking CTA (edit once -> appears where placed)
+-- Collections
|   +-- Blog Posts (multi, 4 entries)
|   +-- Team Members (multi, 9 entries)
|   +-- Services (multi, 5 entries)
+-- Singletons
    +-- Landing Page
    +-- About Page
    +-- Testimonials Page
```

In Astro: globals fetched in layout, shared fetched in components,
collections/singletons fetched per route.

### Retry/fix loop summary

| Step | Loop type | On failure |
|------|-----------|------------|
| 3. structure-map | None (deterministic) | Hard fail -> reduce phase issue |
| 4. detect-globals | Internal: agent re-explores with subagents | Reclassify global boundary |
| 5. classify-content | Internal: per-page-type or re-detect shared | Reclassify specific type or shared boundary |
| 6. map-render-as | Internal: per-richtext-field | Retry specific field's agent |
| 7. build-and-verify | Routes to step 5 or 6 | Depends on where content was lost |
| 8. assemble-registry | Routes to step 5 | Bad reference = bad classification |

No step retries the whole phase. No step broadcasts errors to unrelated page types.

---

## 5. Open Questions (Unresolved)

### Q1: Should detect-shared be a separate sub-step within step 5?

Current design: step 5 is a compound step with detect-shared as sub-step A, then
classify as sub-step B.

Open question raised at end of discussion: what does detect-shared actually produce?
Is it fundamentally different from the classifier marking a field as `relationship`
to a global collection?

The classifier is fan-out (per page type), so no single agent sees cross-type
context. But if the structure map annotates "this field appears on N page types" --
the per-type agent might have enough signal to classify it as relationship to a
shared collection.

Counter-argument: the classifier needs to know what the shared collections ARE
before it can reference them. Detect-shared creates those collections, then the
classifier can point relationships at them.

**This needs resolution before implementation.**

### Q2: How does step 7 distinguish render_as issue from classification issue?

When content completeness fails, step 7 needs to route the failure:

- Missing content under a richtext field -> `render_as` mapping missed a path ->
  step 6
- Missing content under a non-richtext field -> field was misclassified or
  unclassified -> step 5

The structure map gives field paths, so this should be deterministic: look up the
missing content's field path, check if its ancestor is classified as richtext. If
yes -> step 6. If no -> step 5.

### Q3: Shared component with per-page variations

What if `cta_section` has the same structure but different text on different pages?
From CMS perspective: if a CMS editor would manage it as one entry, it is shared. If
the text differs per page, it is page-specific content with a common structure --
NOT shared.

Decision rule for the agent: "Would a CMS editor edit this once and have it appear
everywhere? Or would they customize it per page?" If the latter, it is not shared.

### Q4: Retry budgets per step

Each step needs its own `maxRetries`. Suggested:

- Step 4 (detect-globals): 3
- Step 5 (classify-content): 3 per page type, 2 for shared re-detection
- Step 6 (map-render-as): 3 per richtext field
- Step 7 -> 5 or 6 escalation: counts against step 5/6 budgets

**Not yet finalized.**

### Q5: Does the LLM judge for content completeness still need LLM?

With globals/shared/images stripped from the comparison, the coverage metric should
be much more accurate. The LLM judge was needed when the metric was noisy. It may be
unnecessary now -- pure programmatic 90% threshold might suffice. This saves cost on
every verification pass.

---

## 6. What Was Ruled Out

### Wave 1 micro fixes alone

Initially proposed: just fix the prompt (add validation checklist, inject `own_keys`,
per-page-type retry context, exclude images from coverage). This would help but does
not address the fundamental architecture -- one step doing too much, no ability to
verify intermediate results, fan-out agents cannot detect cross-cutting content.

### Heuristic fallbacks for render_as

Proposed then rejected: if `render_as` is missing, fall back to heuristics
(`title` -> `h2`, etc.). Rejected because silent fallbacks mask errors. Missing
`render_as` should loop back to the agent.

### Per-page-type render_as mapping

Proposed then rejected in favor of per-richtext-field. Per-field is more focused,
easier to verify, easier to retry in isolation. Worth the extra agent calls.

### Merging detect-globals and detect-shared

Considered: one step to detect all cross-cutting content. Rejected because globals
are clear-cut (all pages) while shared is fuzzier (subset). Globals must be settled
before shared can work (shared looks at what is left).

### Changing the phase runner

Considered: modify phase runner to support per-step retry. Rejected because steps
can implement their own retry loops internally. Less invasive.

# Ubiquitous Language (UL)

Shared vocabulary for the Mecury pipeline. Use these terms exactly. If a concept isn't here, flag it as "not yet defined" and agree on a definition before using it — don't invent synonyms.

A single **block** gets classified on multiple axes simultaneously. Examples:

- site header → `chrome · global · content`
- contact form → `chrome · global · interactive`
- article body → `body · per-page · content`
- breadcrumb → `chrome · per-page-type · dynamic`

## Terms

| Term | Definition |
|---|---|
| **chrome** | Blocks that structurally wrap every page: header, footer, persistent nav, site-wide banner. "The frame." |
| **body** | Non-chrome blocks. The content inside the frame. |
| **global** | Block appears on every page of the site. Defined once, referenced everywhere. Materializes as the Astro layout template (header + content-slot + footer). Aliases: **per-site**, **layout**. |
| **per-page-type** | Block's *shape* is shared across all pages of a given `page_type`; its *content* varies per instance. |
| **per-page** | Unique to one page. Both shape and content specific. Body-only. |
| **content** | Editor-authored values stored in CMS fields; typed in, rendered as-is. Wireframe picks layout later. |
| **dynamic** | Values derived at render time from state (page hierarchy, collection query, session). Not editor-authored. E.g. breadcrumbs, next/prev, related posts. |
| **interactive** | Root purpose is a widget — accepts input, changes state, runs behavior. Produces a component file. Labels/placeholders inside are widget config (fate stays interactive). E.g. contact form, search bar, booking button. |
| **noise** | UI-state / tracking / debug leaks scraped into content. Dropped before CMS. |
| **leaf** | Primitive value in the content tree (string, number, bool, null, empty `[]`/`{}`). Atomic unit of partition. |
| **block** | Named group of leaves treated as ONE downstream unit (one CMS record, one widget, one derivation, one noise cluster). |
| **path** | Content-tree location of a leaf or block root (e.g. `footer.form_fields[0].label`). |
| **excludePaths** | Sub-paths under a block's root that are explicitly NOT in the block (a sibling owns them). |
| **yank** | Move a path (a leaf OR a subtree) out of its natural prefix into a block that doesn't cover it. Bidirectional: `yanks[]` entry + receiver block's `remap`. |
| **remap** | Receiver-side `fromPath` declaring "this block absorbs the path via yank". |
| **page_type** | Cluster of pages sharing the same structural shape (`team-member-detail`, `service-landing`, `home`). Assigned by the `prepare` segment. Two pages with the same `page_type` must ultimately produce the same block schema. Alias: **pagetype**. |
| **normalize** | Shape cleanup on a SINGLE artifact — trim whitespace, lowercase keys, sort fields, strip markers. Per-artifact; no cross-page view. |
| **harmonize** | CROSS-page pass that enforces consistent block shapes/labels for same-scope or same-pagetype blocks. Can re-partition. Operates over multiple pages at once. |
| **canonicalize** | Pick ONE name when synonyms exist across pages (`awards` ↔ `accolades`). Pure rename; no shape change. Strict subset of harmonize. |
| **segment** | Top-level pipeline unit (`prepare`, `classify`, `wireframe`, `design`, `analyze`). Has its own output directory; runs in DAG order. |
| **phase** | Ordered sub-unit within a segment (`classify-prepare`, `per-page-chunk-and-fate`). A segment executes its phases in sequence. |
| **step** | Finest-grained unit within a phase (`chunk-and-fate-agent`, `apply-blocks`). Profile cascade key format: `segment.phase.step`. |
| **fan-out** | A step that runs N parallel step-instances (one per page, one per block). Each branch is independent and has its own attempt sequence. |
| **iteration** | One attempt of a phase — implementer steps + gates + reviewers for all fan-out branches. Reject → new iteration of the same phase starts with accumulated rejectionContext. |
| **attempt** | One try of a single step-instance inside an iteration (e.g. one page's chunk-and-fate call). Lives in `attempt-N/` under its fan-out branch's workdir. |
| **workdir** | Directory assigned to an iteration or fan-out branch. All artifacts (prompts, responses, verdicts) for that unit live here. |
| **artifact** | Concrete output file from a step or attempt (`prompt.txt`, `response.txt`, `verdict.json`, `gate-verdict.json`). |
| **implementer** | LLM call that produces an artifact (e.g. `chunk-and-fate-agent`). |
| **reviewer** | LLM call that accepts or rejects an artifact. Runs per-attempt after the implementer. |
| **gate** | Deterministic (non-LLM) check on structural validity (e.g. "every leaf covered by exactly one block"). Runs before the reviewer. |
| **verdict** | Pass/reject result from a gate or reviewer. Reject accumulates `rejectionContext` and triggers a retry (new attempt or new iteration). |
| **rejectionContext** | Accumulated reject findings from prior attempts/iterations, fed into the next implementer prompt so it can avoid the same mistakes. |

## Transformation terms — compared side-by-side

The three transformation terms cause the most confusion. Layering:

| | Scope of view | Can rename? | Can re-partition? | Can re-classify fate? |
|---|---|---|---|---|
| **normalize** | 1 artifact | ✓ (within artifact) | — | — |
| **canonicalize** | N artifacts | ✓ (across artifacts) | — | — |
| **harmonize** | N artifacts | ✓ | ✓ | ✓ (if shape demands it) |

Rule of thumb: if the operation can finish without looking at any other page, it's `normalize`. If it needs the whole set to pick a winner name, it's `canonicalize`. If it rewrites block boundaries or fates to match a peer page, it's `harmonize`.

## Harmonize — by scope

`harmonize` takes a scope argument. Two distinct flavors, one per scope that can share shape across pages:

|  | View (input) | Target (output) | Winner count |
|---|---|---|---|
| **harmonize layout** | all pages across the site | one layout template (shared chrome: header, footer, persistent nav) | 1 |
| **harmonize page-type** | one `page_type` cluster at a time | one body schema per `page_type` (e.g. `team-member-detail` schema, `service-landing` schema) | N — one per page_type |

**Composition order: layout first, page-type second.** Layout harmonize pulls the shared chrome off every page; whatever's left is body, which then gets harmonized per `page_type`. Running page-type first wastes work — each page_type call contends with header/footer noise that isn't actually part of that page_type.

**Per-page content is NOT harmonized** (it's unique by definition). It skips both passes and only gets `normalize` + `canonicalize` for label cleanup.

## Open questions (add to table once agreed)

- Is **scope** (`global` / `per-page-type` / `per-page`) determined by the LLM, or inferred deterministically (leaf byte-identical across all pages → `global`)?
- Does `pagetype-chrome` exist as a concept — chrome that varies by `page_type` (e.g. admin vs public nav) — or is chrome always `global`?
- Can `noise` carry a scope (global tracking pixel vs per-page leak), or is it always `per-page`?

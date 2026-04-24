/**
 * Shared types for the per-pagetype harmonize split (Stage 3 rewrite).
 *
 * The four phases (harmonize-prepare, harmonize-align-names, harmonize-verdicts,
 * harmonize-assemble) hand off via these shapes. See `CLASSIFY-PLAN.md` Stage 3
 * for the design rationale — the LLM names values in `Verdict`; the assembler
 * builds the canonical tree from them so decision/tree divergence is structurally
 * impossible.
 */

/**
 * One distinct value observed for a candidate field, plus every page that
 * exhibited it. `null` is a valid value and gets its own bucket; missing
 * pages are tracked in `absentFrom` on the parent CandidateDigest.
 */
export interface DistinctValue {
	value: unknown;
	pageHashes: string[];
}

/**
 * The per-candidate surface the two LLM phases reason over. Pre-rename —
 * keyed by `suggestedCanonical ?? sourcePath` from the per-page classify
 * output. harmonize-verdicts applies the rename table before feeding this
 * into its prompt.
 */
export interface CandidateDigest {
	candidatePath: string;
	distinctValues: DistinctValue[];
	presentOn: string[];
	absentFrom: string[];
}

/** One pagetype bundle — output of harmonize-prepare, input to 3b/3c/3d. */
export interface PageTypeDigest {
	pagetype: string;
	totalPages: number;
	pageHashes: string[];
	candidates: CandidateDigest[];
}

/**
 * Flat view of the same data, written alongside the digest for operator
 * inspection. One row per (candidatePath, pageHash) tuple with the source
 * path it came from and the raw observed value.
 */
export interface OccurrenceRow {
	candidatePath: string;
	pageHash: string;
	sourcePath: string;
	value: unknown;
}

export interface OccurrenceTable {
	pagetype: string;
	totalPages: number;
	rows: OccurrenceRow[];
}

// ---------------------------------------------------------------------------
// Structural signals — Phase 1 sidecar (harmonize.md §Phase 1)
// ---------------------------------------------------------------------------

/**
 * Per-candidate metadata used by phases 2, 3, and 4 to calibrate prompts.
 * Populated only for array candidates (path contains `[*]`); scalars get
 * `{ isArray: false }` and no further fields.
 */
export interface CandidateSignals {
	isArray: boolean;
	elementShape?: "primitive" | "object" | "mixed";
	/** Ordered per-page value sequences — preserves slot order within a page. */
	perPageSequences?: Record<string, unknown[]>;
	/** Union of observed object keys across all element occurrences. */
	childKeys?: string[];
	/**
	 * Ordered pairs `[a, b]` where `a` appeared before `b` on at least one
	 * page (primitive-element arrays only). Feeds Phase 5 topological sort
	 * when canonicalOrder isn't supplied directly. Deduped across pages.
	 */
	pairwiseOrderConstraints?: Array<[unknown, unknown]>;
	/**
	 * Mean pairwise Jaccard of per-page element *sets* (not sequences) —
	 * scalar in `[0, 1]`, `1` = same membership across pages,
	 * `0` = completely disjoint. Pages with zero elements are skipped.
	 * Hints "rotation (high) vs. rewrite (low) vs. stable (1.0)".
	 */
	elementSetJaccard?: number;
	/**
	 * For object-element arrays: fraction of elements that share the modal
	 * key set — `1.0` = every element has the same shape, low values = motley
	 * records. Only populated when `elementShape === "object"`.
	 */
	childKeyUniformity?: number;
}

export interface StructuralSignals {
	pagetype: string;
	perCandidate: Record<string, CandidateSignals>;
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

export interface RenameEntry {
	from: string;
	to: string;
	reason: string;
}

export type RenameTable = RenameEntry[];

/**
 * Rich rename ops emitted by the harmonize-align-names agent. `flat` passes
 * through untouched; `subtree` expands to N flat renames at compile time;
 * `element-key` is persisted as a sidecar (it does not rename paths, it
 * normalizes element identity values for Phase 3 array-resolve).
 */
export type RichRenameOp =
	| { kind: "flat"; from: string; to: string; reason: string }
	| {
			kind: "subtree";
			fromPrefix: string;
			toPrefix: string;
			reason: string;
	  }
	| {
			kind: "element-key";
			arrayPath: string;
			identifyBy: string;
			/** observed label value → canonical label value */
			renames: Record<string, string>;
			reason: string;
	  };

/**
 * Per-pagetype sidecar collecting `element-key` ops from every align layer.
 * Phase 3 (array-resolve) reads this to normalize element identity before
 * reasoning about canonical order. Not consumed by Phase 4 (scalar verdicts)
 * — scalars don't have element identity.
 */
export interface ElementKeyRenameEntry {
	arrayPath: string;
	identifyBy: string;
	renames: Record<string, string>;
	reason: string;
}

export type ElementKeyRenameSidecar = ElementKeyRenameEntry[];

// ---------------------------------------------------------------------------
// Cluster suggestions — wire format between the `./suggest` sub-agent and the
// outer align agent's accept/reject flow.
// ---------------------------------------------------------------------------

export interface RejectEntry {
	paths: string[];
	reason: string;
}

export interface ClusterEvidence {
	sharedValueCount?: number;
	jaccard?: number;
	reasoning?: string;
}

export interface ClusterSuggestion {
	paths: string[];
	evidence: ClusterEvidence;
	suggestedCanonical: string;
}

export type SuggestResult =
	| { done: true; reason: string }
	| { done: false; note: string };

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/**
 * `candidatePath` is post-rename (i.e. the canonical name after applying
 * rename_table).
 *
 * `keep-static` names one shared chrome value (possibly a normalized form when
 * `observed === false`). `keep-dynamic` is chrome whose value varies per page
 * by design (breadcrumbs, pagination, related posts, …) — the canonical leaf
 * gets a sentinel; per-page values are materialized separately.
 */
export type Verdict =
	| {
			candidatePath: string;
			kind: "keep-static";
			value: unknown;
			observed: boolean;
			absentFrom: string[];
			rationale?: string;
	  }
	| {
			candidatePath: string;
			kind: "keep-dynamic";
			pattern?: string;
			rationale: string;
	  }
	| {
			candidatePath: string;
			kind: "demote";
			rationale: string;
	  }
	| {
			candidatePath: string;
			kind: "defer-to-operator";
			rationale: string;
	  };

export type VerdictTable = Verdict[];

// ---------------------------------------------------------------------------
// chrome-dynamic sidecar — per-pagetype aggregate for keep-dynamic verdicts
// ---------------------------------------------------------------------------

export interface ChromeDynamicSlot {
	rationale: string;
	pattern?: string;
	values: Array<{ pageHash: string; value: unknown }>;
	absentFrom: string[];
}

export type ChromeDynamic = Record<string, ChromeDynamicSlot>;

export const CHROME_DYNAMIC_SENTINEL = "<dynamic>";

// ---------------------------------------------------------------------------
// Canonical tree + per-page mappers (output of harmonize-assemble)
// ---------------------------------------------------------------------------

export type CanonicalTree = Record<string, unknown>;

export interface PageMapperEntry {
	sourcePath: string;
	canonicalField: string;
}

export interface PageMapper {
	hash: string;
	/** Optional — set by harmonize-assemble, not required by chrome-verify. */
	pagetype?: string;
	entries: PageMapperEntry[];
	demotedSourcePaths: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

/**
 * Rename table utilities for harmonize-align-names + harmonize-verdicts.
 *
 * A rename maps one candidate name (`from`) to a chosen canonical name (`to`).
 * Validation answers "did the LLM hallucinate?" and nothing else. Application
 * folds aliased candidates together in the digest so downstream stages see a
 * single normalized candidate per concept.
 */

import { stableValueHash } from "./harmonize-occurrence.js";
import type {
	CandidateDigest,
	DistinctValue,
	PageTypeDigest,
	RenameTable,
	ValidationResult,
} from "./harmonize-types.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a rename table against the pagetype's pre-rename candidate set.
 *
 * Rules (all enforced; violations become one-line findings):
 *  - Every `from` appears as a candidate path in the digest.
 *  - No `from === to`.
 *  - No `from` collision: the same `from` can't map to two different `to`s.
 *  - No cycles: applying renames repeatedly must terminate.
 *  - A rename may not fuse structurally-incompatible shapes — if `from` is a
 *    string on one page and the target `to` already exists as an object on
 *    another, flag it rather than silently collapse.
 *  - `from` must not be a strict dotted ancestor of `to` (or vice versa).
 *    A rename like `header.logo → header.logo.src` tries to turn a scalar
 *    leaf into a sub-property of itself — the compiled tree would need a
 *    fabricated parent object on any page that supplied the scalar form.
 *    This is the "prefix-extension" anti-pattern called out in the prompt.
 *  - A primitive-array leaf may not be renamed into an object-array
 *    sub-property. `from = X[*]` with no sibling candidates under `X[*].*`
 *    and primitive values cannot target a path containing `[*].` — the
 *    post-rename digest would hold bare values in a slot that other pages
 *    populate with object sub-properties, an incoherent shape.
 *  - Synthetic terminal targets (a `to` not observed as a candidate) must
 *    have ≥2 distinct observed sources reaching them (directly or through
 *    a chain). A lone synthetic target is gratuitous invention — use an
 *    observed variant or keep the source name.
 *
 * Path traceability (every source page hash lands in its terminal bucket)
 * is enforced post-apply by `assertAppliedCoverage`, not here.
 */
export function validateRenameTable(
	digest: PageTypeDigest,
	table: RenameTable,
): ValidationResult {
	const errors: string[] = [];
	const candidatePaths = new Set(digest.candidates.map((c) => c.candidatePath));
	const seenFrom = collectSeenFrom(table, candidatePaths, errors);
	collectCycleErrors(table, seenFrom, errors);
	collectShapeFusionErrors(digest, table, seenFrom, errors);
	collectPrimitiveToObjectLeafErrors(digest, candidatePaths, seenFrom, errors);
	collectSyntheticTargetErrors(candidatePaths, seenFrom, errors);
	return { valid: errors.length === 0, errors };
}

/**
 * Validate each entry's shape in isolation (existence, self-rename,
 * prefix-extension, from-uniqueness) and return the `from → to` map of
 * accepted entries. Rejected entries are dropped from subsequent cycle/shape
 * checks to avoid cascading noise from a single bad row.
 */
function collectSeenFrom(
	table: RenameTable,
	candidatePaths: Set<string>,
	errors: string[],
): Map<string, string> {
	const seenFrom = new Map<string, string>();
	for (const entry of table) {
		const err = validateEntryShape(entry, candidatePaths, seenFrom);
		if (err) {
			errors.push(err);
			continue;
		}
		seenFrom.set(entry.from, entry.to);
	}
	return seenFrom;
}

function validateEntryShape(
	entry: RenameTable[number],
	candidatePaths: Set<string>,
	seenFrom: Map<string, string>,
): string | null {
	if (entry.from === entry.to) {
		return `Redundant rename_table entry (from === to): "${entry.from}"`;
	}
	if (!candidatePaths.has(entry.from)) {
		return `rename_table "from" not observed as a candidate: "${entry.from}"`;
	}
	if (isDottedAncestor(entry.from, entry.to)) {
		return `rename_table entry "${entry.from}" → "${entry.to}" fuses a scalar leaf into a sub-property of itself (prefix-extension)`;
	}
	if (isDottedAncestor(entry.to, entry.from)) {
		return `rename_table entry "${entry.from}" → "${entry.to}" renames a sub-property into its own ancestor (prefix-extension)`;
	}
	const existing = seenFrom.get(entry.from);
	if (existing !== undefined && existing !== entry.to) {
		return `rename_table "from" mapped to two different "to" values: "${entry.from}" → "${existing}" and → "${entry.to}"`;
	}
	return null;
}

/**
 * Walk each accepted rename chain looking for cycles. Terminal `to` values
 * that are not themselves renamed are fine (they may be synthetic); the
 * post-apply coverage check catches chains that fail to resolve.
 */
function collectCycleErrors(
	table: RenameTable,
	seenFrom: Map<string, string>,
	errors: string[],
): void {
	for (const entry of table) {
		if (!seenFrom.has(entry.from)) continue;
		if (chainHasCycle(entry, seenFrom, table.length)) {
			errors.push(`rename_table cycle involving "${entry.from}"`);
		}
	}
}

function chainHasCycle(
	entry: RenameTable[number],
	seenFrom: Map<string, string>,
	tableLen: number,
): boolean {
	const seen = new Set<string>([entry.from]);
	let cursor = entry.to;
	let steps = 0;
	while (seenFrom.has(cursor)) {
		if (seen.has(cursor)) return true;
		seen.add(cursor);
		cursor = seenFrom.get(cursor) as string;
		if (++steps > tableLen + 1) return true;
	}
	return false;
}

/**
 * Structural compatibility: all candidates that end up at the same target
 * (through one or more renames, or as the target itself if it's an observed
 * candidate) must agree on value shape. Fusing string-valued paths with
 * object-valued paths is a lie, not a rename.
 */
function collectShapeFusionErrors(
	digest: PageTypeDigest,
	table: RenameTable,
	seenFrom: Map<string, string>,
	errors: string[],
): void {
	const digestByPath = new Map(
		digest.candidates.map((c) => [c.candidatePath, c]),
	);
	const byTarget = groupCandidatesByTarget(table, seenFrom, digestByPath);
	for (const [target, cands] of byTarget) {
		if (cands.length < 2) continue;
		const shapes = new Set(
			cands.flatMap((c) => c.distinctValues.map((dv) => shapeTagOf(dv.value))),
		);
		if (shapes.size > 1) {
			errors.push(
				`rename_table collapses structurally-incompatible candidates into "${target}": shapes observed = ${[...shapes].sort().join(", ")}`,
			);
		}
	}
}

function groupCandidatesByTarget(
	table: RenameTable,
	seenFrom: Map<string, string>,
	digestByPath: Map<string, CandidateDigest>,
): Map<string, CandidateDigest[]> {
	const byTarget = new Map<string, CandidateDigest[]>();
	for (const entry of table) {
		if (!seenFrom.has(entry.from)) continue;
		const fromCand = digestByPath.get(entry.from);
		if (fromCand) pushUnique(byTarget, entry.to, fromCand);
		// If the target is itself an observed candidate (not being renamed
		// away), include its shape in the fusion check too.
		const toCand = digestByPath.get(entry.to);
		if (toCand && !seenFrom.has(entry.to)) {
			pushUnique(byTarget, entry.to, toCand);
		}
	}
	return byTarget;
}

function pushUnique<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const existing = map.get(key);
	if (!existing) {
		map.set(key, [value]);
	} else if (!existing.includes(value)) {
		existing.push(value);
	}
}

function shapeTagOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	const t = typeof value;
	if (t === "object") return "object";
	return t; // "string" | "number" | "boolean" | "undefined"
}

/**
 * Reject renames that fuse a primitive-array leaf into an object-array
 * sub-property — e.g. `footer.form.fields[*]` (bare strings at array slots)
 * renamed to `footer.contact_form.fields[*].name` (a named field of object
 * elements). Post-rename the same bucket would hold bare primitives from
 * one source and object sub-properties from another — structurally
 * incoherent. `collectShapeFusionErrors` doesn't catch this when both
 * sides happen to be string-typed at the leaf; the defect lives in the
 * parent array's element shape, not the leaf values.
 *
 * Detection:
 *  - `from` ends in `[*]` (array element slot).
 *  - No candidate path starts with `from + "."` or `from + "["` — so the
 *    array has no observed object/nested structure on any page, making
 *    it a primitive-array leaf.
 *  - `from`'s observed distinctValues are all primitives.
 *  - `to` contains `[*].` — the target lands inside an object element.
 */
function collectPrimitiveToObjectLeafErrors(
	digest: PageTypeDigest,
	candidatePaths: Set<string>,
	seenFrom: Map<string, string>,
	errors: string[],
): void {
	const byPath = new Map(digest.candidates.map((c) => [c.candidatePath, c]));
	for (const [from, to] of seenFrom) {
		if (!from.endsWith("[*]")) continue;
		const hasObjectChildren = [...candidatePaths].some(
			(p) => p.startsWith(`${from}.`) || p.startsWith(`${from}[`),
		);
		if (hasObjectChildren) continue;
		const cand = byPath.get(from);
		if (!cand) continue;
		const allPrimitive = cand.distinctValues.every((dv) => {
			const t = shapeTagOf(dv.value);
			return t === "string" || t === "number" || t === "boolean";
		});
		if (!allPrimitive) continue;
		if (!to.includes("[*].")) continue;
		errors.push(
			`rename_table entry "${from}" → "${to}" fuses a primitive-array leaf into an object-array sub-property (source values are bare primitives; target requires them to occupy a named property slot of an object element)`,
		);
	}
}

/**
 * Reject synthetic terminal targets reached by fewer than 2 distinct
 * observed sources. A synthetic `to` (not observed as a candidate) is only
 * justified when it unifies ≥2 real aliases — a single `from → invented`
 * is gratuitous and should either keep the source name or pick an observed
 * variant.
 *
 * "Terminal" = the end of any rename chain. If `X → Y → Z` and `Z` is
 * synthetic, both `X` and `Y` count as sources reaching `Z`, so the chain
 * easily clears the ≥2 bar. This matches downstream semantics:
 * `applyRenameTable` folds the whole chain onto the terminal.
 */
function collectSyntheticTargetErrors(
	candidatePaths: Set<string>,
	seenFrom: Map<string, string>,
	errors: string[],
): void {
	const sourcesByTerminal = new Map<string, Set<string>>();
	for (const from of seenFrom.keys()) {
		const terminal = resolveTerminal(from, seenFrom);
		if (terminal === from) continue;
		let sources = sourcesByTerminal.get(terminal);
		if (!sources) {
			sources = new Set<string>();
			sourcesByTerminal.set(terminal, sources);
		}
		sources.add(from);
	}
	for (const [terminal, sources] of sourcesByTerminal) {
		if (candidatePaths.has(terminal)) continue;
		if (sources.size >= 2) continue;
		errors.push(
			`rename_table target "${terminal}" is synthetic (not observed as a candidate) and has only ${sources.size} source reaching it — synthetic canonicals require ≥2 distinct sources; use an observed variant or keep the source name`,
		);
	}
}

/**
 * Walk the rename chain starting at `from` until we hit a path that is not
 * itself a `from` (or until we re-enter the walk, which means a cycle —
 * cycles are already flagged by `collectCycleErrors`, so bail gracefully).
 */
function resolveTerminal(from: string, seenFrom: Map<string, string>): string {
	let cursor = from;
	const visited = new Set<string>([cursor]);
	while (seenFrom.has(cursor)) {
		const next = seenFrom.get(cursor) as string;
		if (visited.has(next)) return cursor;
		visited.add(next);
		cursor = next;
	}
	return cursor;
}

/**
 * True when `ancestor` is a strict dotted-path ancestor of `descendant` — i.e.
 * `descendant` starts with `ancestor + "."` or `ancestor + "["`. The `[` form
 * covers "ancestor is an array indexed into by descendant". Equal paths are
 * not ancestors.
 */
function isDottedAncestor(ancestor: string, descendant: string): boolean {
	if (ancestor === descendant) return false;
	return (
		descendant.startsWith(`${ancestor}.`) ||
		descendant.startsWith(`${ancestor}[`)
	);
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

/**
 * Apply a (validated) rename table to a digest. Aliased candidates are folded
 * together — their distinct-value buckets and presence sets are merged. The
 * returned digest has one candidate per post-rename canonical name.
 *
 * Does NOT re-validate the rename table; callers must validate first.
 */
export function applyRenameTable(
	digest: PageTypeDigest,
	table: RenameTable,
): PageTypeDigest {
	const renameMap = buildRenameMap(table);
	const merged = foldCandidates(digest, renameMap);
	const candidates = materializeBuckets(merged, digest.pageHashes);
	return {
		pagetype: digest.pagetype,
		totalPages: digest.totalPages,
		pageHashes: [...digest.pageHashes],
		candidates,
	};
}

type Bucket = {
	distinctValues: Map<string, DistinctValue>;
	presentOn: Set<string>;
};

function buildRenameMap(table: RenameTable): Map<string, string> {
	const map = new Map<string, string>();
	for (const entry of table) map.set(entry.from, entry.to);
	return map;
}

function resolveRenameTarget(
	path: string,
	renameMap: Map<string, string>,
): string {
	let cursor = path;
	const seen = new Set<string>();
	while (renameMap.has(cursor)) {
		if (seen.has(cursor)) break;
		seen.add(cursor);
		cursor = renameMap.get(cursor) as string;
	}
	return cursor;
}

function foldCandidates(
	digest: PageTypeDigest,
	renameMap: Map<string, string>,
): Map<string, Bucket> {
	const merged = new Map<string, Bucket>();
	for (const cand of digest.candidates) {
		const canonical = resolveRenameTarget(cand.candidatePath, renameMap);
		const bucket = getOrCreateBucket(merged, canonical);
		mergeDistinctValues(bucket, cand.distinctValues);
		for (const h of cand.presentOn) bucket.presentOn.add(h);
	}
	return merged;
}

function getOrCreateBucket(
	merged: Map<string, Bucket>,
	canonical: string,
): Bucket {
	const existing = merged.get(canonical);
	if (existing) return existing;
	const bucket: Bucket = {
		distinctValues: new Map(),
		presentOn: new Set(),
	};
	merged.set(canonical, bucket);
	return bucket;
}

function mergeDistinctValues(
	bucket: Bucket,
	distinctValues: DistinctValue[],
): void {
	for (const dv of distinctValues) {
		const hash = stableValueHash(dv.value);
		const existing = bucket.distinctValues.get(hash);
		if (existing) {
			for (const h of dv.pageHashes) existing.pageHashes.push(h);
		} else {
			bucket.distinctValues.set(hash, {
				value: dv.value,
				pageHashes: [...dv.pageHashes],
			});
		}
	}
}

function materializeBuckets(
	merged: Map<string, Bucket>,
	pageHashes: string[],
): CandidateDigest[] {
	const candidates: CandidateDigest[] = [];
	for (const [canonical, bucket] of merged) {
		candidates.push({
			candidatePath: canonical,
			distinctValues: sortedDistinctValues(bucket),
			presentOn: [...bucket.presentOn].sort(),
			absentFrom: pageHashes.filter((h) => !bucket.presentOn.has(h)),
		});
	}
	candidates.sort((a, b) => stringCompare(a.candidatePath, b.candidatePath));
	return candidates;
}

function sortedDistinctValues(bucket: Bucket): DistinctValue[] {
	return [...bucket.distinctValues.values()]
		.map((dv) => ({ value: dv.value, pageHashes: [...dv.pageHashes].sort() }))
		.sort((a, b) => {
			const diff = b.pageHashes.length - a.pageHashes.length;
			if (diff !== 0) return diff;
			return stringCompare(stableValueHash(a.value), stableValueHash(b.value));
		});
}

function stringCompare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Batch coverage — every candidate is untouched or is a valid rename source
// ---------------------------------------------------------------------------

/**
 * Redundant with validateRenameTable (which walks every rename and verifies
 * its `to` resolves); we reassert the "every candidate is either untouched or
 * is a valid rename source" rule here as a loud gate so a future refactor
 * can't silently drop the invariant.
 */
export function assertBatchCoverage(
	batchDigest: PageTypeDigest,
	table: RenameTable,
): ValidationResult {
	const tableByFrom = new Map(table.map((e) => [e.from, e]));
	const errors: string[] = [];
	for (const cand of batchDigest.candidates) {
		const entry = tableByFrom.get(cand.candidatePath);
		if (entry === undefined) continue; // untouched
		if (entry.from !== cand.candidatePath) {
			errors.push(
				`candidate "${cand.candidatePath}" tracked as rename source but absent from rename_table`,
			);
		}
	}
	return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Post-apply trace coverage
// ---------------------------------------------------------------------------

/**
 * Verify that an applied digest is a faithful image of the original under the
 * rename table. Runs AFTER applyRenameTable and is the safety net that lets
 * validateRenameTable permit synthetic terminal `to` targets: even if the
 * agent invents a name, every original page hash must still end up in a
 * bucket the rename chain produces — and no bucket may appear that wasn't
 * produced by some chain.
 *
 * The check is pure set algebra and is redundant with applyRenameTable's
 * fold semantics when the implementation is correct. It exists so that any
 * future refactor that accidentally drops a candidate or manufactures a
 * spurious bucket fails loudly at the batch boundary.
 */
export function assertAppliedCoverage(
	originalDigest: PageTypeDigest,
	table: RenameTable,
	appliedDigest: PageTypeDigest,
): ValidationResult {
	const errors: string[] = [];
	const renameMap = buildRenameMap(table);
	const expectedByTarget = computeExpectedByTarget(originalDigest, renameMap);
	const appliedByPath = new Map(
		appliedDigest.candidates.map((c) => [c.candidatePath, c]),
	);
	checkExpectedBuckets(expectedByTarget, appliedByPath, errors);
	checkUnexpectedBuckets(expectedByTarget, appliedDigest, errors);
	return { valid: errors.length === 0, errors };
}

function computeExpectedByTarget(
	originalDigest: PageTypeDigest,
	renameMap: Map<string, string>,
): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	for (const cand of originalDigest.candidates) {
		const target = resolveRenameTarget(cand.candidatePath, renameMap);
		let set = out.get(target);
		if (!set) {
			set = new Set();
			out.set(target, set);
		}
		for (const h of cand.presentOn) set.add(h);
	}
	return out;
}

function checkExpectedBuckets(
	expectedByTarget: Map<string, Set<string>>,
	appliedByPath: Map<string, CandidateDigest>,
	errors: string[],
): void {
	for (const [target, expectedHashes] of expectedByTarget) {
		const bucket = appliedByPath.get(target);
		if (!bucket) {
			errors.push(
				`applied digest missing bucket "${target}" expected from rename chain`,
			);
			continue;
		}
		const bucketHashes = new Set(bucket.presentOn);
		for (const h of expectedHashes) {
			if (!bucketHashes.has(h)) {
				errors.push(
					`applied bucket "${target}" missing page hash "${h}" traced from an original candidate`,
				);
			}
		}
	}
}

function checkUnexpectedBuckets(
	expectedByTarget: Map<string, Set<string>>,
	appliedDigest: PageTypeDigest,
	errors: string[],
): void {
	for (const c of appliedDigest.candidates) {
		if (expectedByTarget.has(c.candidatePath)) continue;
		errors.push(
			`applied digest has unexpected bucket "${c.candidatePath}" not produced by any rename chain`,
		);
	}
}

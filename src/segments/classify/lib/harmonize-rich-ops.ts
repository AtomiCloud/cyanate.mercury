/**
 * Rich rename-op vocabulary for harmonize-align-names (Phase 2).
 *
 * The agent emits `RichRenameOp[]` — a union of `flat | subtree | element-key`.
 * We validate against the pagetype digest + signals, then compile to
 *   1. a flat `RenameTable` (consumed by the existing applyRenameTable path +
 *      Phase 4 verdicts), and
 *   2. an `ElementKeyRenameSidecar` (consumed by Phase 3 array-resolve).
 *
 * See `harmonize.md` §Phase 2 rename vocabulary.
 */

import type {
	CandidateSignals,
	ElementKeyRenameEntry,
	ElementKeyRenameSidecar,
	PageTypeDigest,
	RenameEntry,
	RenameTable,
	RichRenameOp,
	StructuralSignals,
	ValidationResult,
} from "./harmonize-types.js";
import { countWildcards } from "./path-utils.js";

export interface ValidateRichOpsInput {
	digest: PageTypeDigest;
	signals?: StructuralSignals;
	ops: RichRenameOp[];
}

export interface CompileRichOpsResult {
	flat: RenameTable;
	elementKey: ElementKeyRenameSidecar;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate rich rename ops against the pagetype digest (+ optional signals).
 *
 * Rules enforced here are **op-shape**: unknown candidates, invalid prefixes,
 * unknown array paths, unknown identity keys. The shape-fusion / cycle /
 * from-uniqueness rules live on the *compiled* flat RenameTable and are run
 * by `validateRenameTable` after `compileRichOps`. In particular, subtree
 * rewrites whose target already exists are **allowed** — that's the alias-
 * merge case the phase is built to handle; the compiled flat row gets the
 * same downstream checks as an explicit `flat` op.
 */
export function validateRichRenameOps(
	input: ValidateRichOpsInput,
): ValidationResult {
	const errors: string[] = [];
	const candidatePaths = new Set(
		input.digest.candidates.map((c) => c.candidatePath),
	);

	for (let i = 0; i < input.ops.length; i++) {
		const op = input.ops[i];
		const tag = `rename_ops[${i}]`;
		switch (op.kind) {
			case "flat":
				validateFlatOp(op, tag, candidatePaths, errors);
				break;
			case "subtree":
				validateSubtreeOp(op, tag, input.digest, errors);
				break;
			case "element-key":
				validateElementKeyOp(op, tag, candidatePaths, input.signals, errors);
				break;
			default: {
				const exhaustive: never = op;
				errors.push(`unknown rename op kind: ${JSON.stringify(exhaustive)}`);
			}
		}
	}
	return { valid: errors.length === 0, errors };
}

type FlatOp = Extract<RichRenameOp, { kind: "flat" }>;
type SubtreeOp = Extract<RichRenameOp, { kind: "subtree" }>;
type ElementKeyOp = Extract<RichRenameOp, { kind: "element-key" }>;

function validateFlatOp(
	op: FlatOp,
	tag: string,
	candidatePaths: Set<string>,
	errors: string[],
): void {
	if (!candidatePaths.has(op.from)) {
		errors.push(`${tag}: flat.from "${op.from}" is not an observed candidate`);
	}
	if (op.from === op.to) {
		errors.push(`${tag}: flat.from === flat.to ("${op.from}")`);
	}
	const fromStars = countWildcards(op.from);
	const toStars = countWildcards(op.to);
	if (fromStars !== toStars) {
		errors.push(
			`${tag}: flat wildcard-count mismatch — from="${op.from}" has ${fromStars} [*], to="${op.to}" has ${toStars}. The materializer binds the k-th [*] in "from" to the k-th [*] in "to" positionally; counts must be equal.`,
		);
	}
}

function validateSubtreeOp(
	op: SubtreeOp,
	tag: string,
	digest: PageTypeDigest,
	errors: string[],
): void {
	const fromNorm = normalizePrefix(op.fromPrefix);
	const toNorm = normalizePrefix(op.toPrefix);
	if (fromNorm === "") {
		errors.push(`${tag}: subtree.fromPrefix must not be empty`);
		return;
	}
	if (fromNorm === toNorm) {
		errors.push(
			`${tag}: subtree.fromPrefix === subtree.toPrefix ("${fromNorm}")`,
		);
		return;
	}
	const matches = matchingCandidates(digest, fromNorm);
	if (matches.length === 0) {
		errors.push(
			`${tag}: subtree.fromPrefix "${fromNorm}" matches no candidate paths`,
		);
		return;
	}
	// Rewrites that land on an existing candidate are a MERGE — the whole
	// point of alignment is to collapse alias families like
	// `footer.contact_info.* → footer.contact_information.*` when both appear
	// on different pages. The resulting flat row (`from → to`) has the same
	// semantics as an explicit `flat` op, which also has no `to`-existence
	// check. Real hazards (from-uniqueness, cycles, structurally-incompatible
	// fusion, spurious/missing buckets) are caught downstream by
	// validateRenameTable + assertAppliedCoverage.
}

function validateElementKeyOp(
	op: ElementKeyOp,
	tag: string,
	candidatePaths: Set<string>,
	signals: StructuralSignals | undefined,
	errors: string[],
): void {
	const reachability = checkArrayPathReachable(op, tag, candidatePaths, errors);
	if (!reachability.valid) return;
	if (!checkArrayPathShape(op, tag, errors)) return;
	if (!checkIdentifyByPresent(op, tag, errors)) return;

	const sig = signals?.perCandidate[op.arrayPath];
	if (sig) {
		if (!validateElementKeySignals(op, tag, sig, errors)) return;
	} else if (reachability.hasChildCandidate) {
		validateIdentifyByFromLeaves(op, tag, candidatePaths, errors);
	}
	validateRenamesNonEmpty(op, tag, errors);
}

interface ReachabilityResult {
	valid: boolean;
	hasChildCandidate: boolean;
}

function checkArrayPathReachable(
	op: ElementKeyOp,
	tag: string,
	candidatePaths: Set<string>,
	errors: string[],
): ReachabilityResult {
	// arrayPath is valid if it is itself an observed candidate OR if it is a
	// boundary-preserving ancestor of one — `footer.contact_form.fields[*]` is
	// valid when leaves like `footer.contact_form.fields[*].name` exist, even
	// though the digest only emits leaf-level candidate paths.
	const directCandidate = candidatePaths.has(op.arrayPath);
	const hasChildCandidate =
		!directCandidate &&
		[...candidatePaths].some((p) => p.startsWith(`${op.arrayPath}.`));
	if (!directCandidate && !hasChildCandidate) {
		errors.push(
			`${tag}: element-key.arrayPath "${op.arrayPath}" is not an observed candidate`,
		);
		return { valid: false, hasChildCandidate: false };
	}
	return { valid: true, hasChildCandidate };
}

function checkArrayPathShape(
	op: ElementKeyOp,
	tag: string,
	errors: string[],
): boolean {
	if (op.arrayPath.endsWith("[*]")) return true;
	errors.push(
		`${tag}: element-key.arrayPath "${op.arrayPath}" is not an array path (must end in [*])`,
	);
	return false;
}

function checkIdentifyByPresent(
	op: ElementKeyOp,
	tag: string,
	errors: string[],
): boolean {
	if (op.identifyBy && typeof op.identifyBy === "string") return true;
	errors.push(`${tag}: element-key.identifyBy must be a non-empty string`);
	return false;
}

function validateIdentifyByFromLeaves(
	op: ElementKeyOp,
	tag: string,
	candidatePaths: Set<string>,
	errors: string[],
): void {
	// No direct signal for the array node — derive identifyBy validity from the
	// leaf candidates instead. The array has children `<arrayPath>.<key>`;
	// identifyBy must be one of those first-segment `<key>`s.
	const observedKeys = collectLeafFirstKeys(op.arrayPath, candidatePaths);
	if (observedKeys.size === 0 || observedKeys.has(op.identifyBy)) return;
	errors.push(
		`${tag}: element-key.identifyBy "${op.identifyBy}" is not an observed key on elements of "${op.arrayPath}" (observed: ${[...observedKeys].sort().join(", ")})`,
	);
}

function collectLeafFirstKeys(
	arrayPath: string,
	candidatePaths: Set<string>,
): Set<string> {
	const prefix = `${arrayPath}.`;
	const out = new Set<string>();
	for (const p of candidatePaths) {
		if (!p.startsWith(prefix)) continue;
		const rest = p.slice(prefix.length);
		const firstBreak = rest.search(/[.[]/);
		out.add(firstBreak < 0 ? rest : rest.slice(0, firstBreak));
	}
	return out;
}

function validateRenamesNonEmpty(
	op: ElementKeyOp,
	tag: string,
	errors: string[],
): void {
	if (Object.keys(op.renames).length === 0) {
		errors.push(`${tag}: element-key.renames is empty — nothing to do`);
	}
	for (const [k, v] of Object.entries(op.renames)) {
		if (k === v) {
			errors.push(`${tag}: element-key rename is a no-op ("${k}" → "${v}")`);
		}
	}
}

function validateElementKeySignals(
	op: ElementKeyOp,
	tag: string,
	sig: CandidateSignals,
	errors: string[],
): boolean {
	if (sig.elementShape !== "object" && sig.elementShape !== "mixed") {
		errors.push(
			`${tag}: element-key on non-object array "${op.arrayPath}" (shape "${sig.elementShape}")`,
		);
		return false;
	}
	if (sig.childKeys && !sig.childKeys.includes(op.identifyBy)) {
		errors.push(
			`${tag}: element-key.identifyBy "${op.identifyBy}" is not an observed key on elements of "${op.arrayPath}" (observed: ${sig.childKeys.join(", ")})`,
		);
	}
	if (sig.perPageSequences) {
		const observedValues = collectIdentityValues(
			sig.perPageSequences,
			op.identifyBy,
		);
		for (const key of Object.keys(op.renames)) {
			if (!observedValues.has(key)) {
				errors.push(
					`${tag}: element-key rename source "${key}" was not observed as a value of "${op.identifyBy}"`,
				);
			}
		}
	}
	return true;
}

function normalizePrefix(prefix: string): string {
	// Strip trailing "." or ".*" — both are natural ways for a prompt to write
	// "everything under X". We canonicalize to the bare prefix.
	let p = prefix;
	while (p.endsWith(".*")) p = p.slice(0, -2);
	while (p.endsWith(".")) p = p.slice(0, -1);
	return p;
}

function matchingCandidates(digest: PageTypeDigest, prefix: string): string[] {
	const out: string[] = [];
	for (const c of digest.candidates) {
		// Boundary-preserving match: `prefix` matches itself exactly, OR extends
		// into a candidate across a path-segment boundary (`.` for objects,
		// `[` for arrays). "footer" matches "footer.copyright" and
		// "footer[*].x", but NOT "footer_legal". "" matches nothing by contract
		// (caller guards).
		if (c.candidatePath === prefix) {
			out.push(c.candidatePath);
		} else if (
			c.candidatePath.startsWith(`${prefix}.`) ||
			c.candidatePath.startsWith(`${prefix}[`)
		) {
			out.push(c.candidatePath);
		}
	}
	return out;
}

function collectIdentityValues(
	perPageSequences: Record<string, unknown[]>,
	identifyBy: string,
): Set<string> {
	const out = new Set<string>();
	for (const values of Object.values(perPageSequences)) {
		for (const v of values) {
			if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
			const entry = (v as Record<string, unknown>)[identifyBy];
			if (typeof entry === "string") out.add(entry);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/**
 * Compile validated rich rename ops to (flat RenameTable, element-key sidecar).
 *
 * Caller is expected to call `validateRichRenameOps` first; we still guard
 * against structural bugs but assume op shapes are well-formed.
 */
export function compileRichOps(
	digest: PageTypeDigest,
	ops: RichRenameOp[],
): CompileRichOpsResult {
	const flat: RenameEntry[] = [];
	const elementKey: ElementKeyRenameEntry[] = [];

	for (const op of ops) {
		switch (op.kind) {
			case "flat":
				flat.push({ from: op.from, to: op.to, reason: op.reason });
				break;
			case "subtree": {
				const fromNorm = normalizePrefix(op.fromPrefix);
				const toNorm = normalizePrefix(op.toPrefix);
				for (const cand of matchingCandidates(digest, fromNorm)) {
					const suffix = cand.slice(fromNorm.length);
					const to = toNorm + suffix;
					if (cand === to) continue; // no-op slice
					flat.push({
						from: cand,
						to,
						reason: `${op.reason} (expanded from subtree ${fromNorm} → ${toNorm})`,
					});
				}
				break;
			}
			case "element-key":
				elementKey.push({
					arrayPath: op.arrayPath,
					identifyBy: op.identifyBy,
					renames: { ...op.renames },
					reason: op.reason,
				});
				break;
		}
	}

	// Dedupe flat entries — a subtree expansion and an explicit flat op may
	// target the same (from, to) pair. Conflicts (same `from`, different `to`)
	// surface via `validateRenameTable` downstream.
	const seen = new Map<string, RenameEntry>();
	for (const entry of flat) {
		const key = `${entry.from}\u0000${entry.to}`;
		if (!seen.has(key)) seen.set(key, entry);
	}
	return { flat: [...seen.values()], elementKey };
}

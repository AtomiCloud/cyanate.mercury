/**
 * Validator for the verdicts phase output.
 *
 * The LLM emits one verdict per post-rename candidate. The validator enforces
 * structural invariants so that the assembler (3d) can build the canonical
 * tree without any branch that says "if the LLM forgot this, guess." Every
 * defect here is precise and actionable as rejection context for retry.
 */

import type {
	CandidateDigest,
	PageTypeDigest,
	ValidationResult,
	Verdict,
	VerdictTable,
} from "./harmonize-types.js";

const KINDS: ReadonlySet<string> = new Set([
	"keep-static",
	"keep-dynamic",
	"demote",
	"defer-to-operator",
]);

export function validateVerdicts(
	renamedDigest: PageTypeDigest,
	verdicts: VerdictTable,
): ValidationResult {
	const errors: string[] = [];

	const digestByPath = new Map<string, CandidateDigest>(
		renamedDigest.candidates.map((c) => [c.candidatePath, c]),
	);

	const seenVerdicts = new Map<string, Verdict>();
	for (const v of verdicts) {
		if (!KINDS.has(v.kind)) {
			errors.push(
				`verdict for "${v.candidatePath}" has unsupported kind "${String(v.kind)}". Must be one of: keep-static | keep-dynamic | demote | defer-to-operator.`,
			);
			continue;
		}
		const existing = seenVerdicts.get(v.candidatePath);
		if (existing) {
			errors.push(
				`duplicate verdict for "${v.candidatePath}" (first: "${existing.kind}", second: "${v.kind}"). Each candidate must have exactly one verdict.`,
			);
			continue;
		}
		seenVerdicts.set(v.candidatePath, v);

		const cand = digestByPath.get(v.candidatePath);
		if (!cand) {
			errors.push(
				`verdict for "${v.candidatePath}" does not correspond to any observed candidate (after rename).`,
			);
			continue;
		}

		validateVerdictShape(v, cand, errors);
	}

	for (const cand of renamedDigest.candidates) {
		if (!seenVerdicts.has(cand.candidatePath)) {
			errors.push(
				`missing verdict for "${cand.candidatePath}". Every candidate must have a verdict.`,
			);
		}
	}

	return { valid: errors.length === 0, errors };
}

function validateVerdictShape(
	v: Verdict,
	cand: CandidateDigest,
	errors: string[],
): void {
	const raw = v as unknown as Record<string, unknown>;
	const path = v.candidatePath;
	switch (v.kind) {
		case "keep-static":
			validateKeepStaticShape(raw, cand, path, errors);
			break;
		case "keep-dynamic":
			validateKeepDynamicShape(raw, path, errors);
			break;
		case "demote":
		case "defer-to-operator":
			if (!stringIsNonEmpty(raw.rationale)) {
				errors.push(
					`verdict "${v.kind}" for "${path}" is missing a rationale string.`,
				);
			}
			break;
	}
}

function validateKeepStaticShape(
	raw: Record<string, unknown>,
	cand: CandidateDigest,
	path: string,
	errors: string[],
): void {
	checkKeepStaticRequiredFields(raw, path, errors);
	checkKeepStaticAbsentFrom(raw, cand, path, errors);
	checkKeepStaticObservedFlag(raw, cand, path, errors);
}

function checkKeepStaticRequiredFields(
	raw: Record<string, unknown>,
	path: string,
	errors: string[],
): void {
	if (!("value" in raw)) {
		errors.push(
			`verdict "keep-static" for "${path}" is missing a "value" field. Set an explicit value (null is valid — write it, don't omit).`,
		);
	}
	if (typeof raw.observed !== "boolean") {
		errors.push(
			`verdict "keep-static" for "${path}" is missing a boolean "observed" field. Set true if the value is byte-equal to one of the observed distinct values, false if it is a normalized form.`,
		);
	}
}

function checkKeepStaticAbsentFrom(
	raw: Record<string, unknown>,
	cand: CandidateDigest,
	path: string,
	errors: string[],
): void {
	if (!Array.isArray(raw.absentFrom)) {
		errors.push(
			`verdict "keep-static" for "${path}" is missing an "absentFrom" array. Provide an empty array if every page had the field.`,
		);
		return;
	}
	const candAbsent = new Set(cand.absentFrom);
	for (const ph of raw.absentFrom as unknown[]) {
		if (typeof ph !== "string" || !candAbsent.has(ph)) {
			errors.push(
				`verdict "keep-static" for "${path}" lists page "${String(ph)}" as absent, but that page did contribute this field (or isn't in the pagetype).`,
			);
		}
	}
}

function checkKeepStaticObservedFlag(
	raw: Record<string, unknown>,
	cand: CandidateDigest,
	path: string,
	errors: string[],
): void {
	if (
		raw.observed === true &&
		"value" in raw &&
		!valueIsObservedOnCandidate(raw.value, cand)
	) {
		errors.push(
			`verdict "keep-static" for "${path}" is marked observed=true but "value" is not byte-equal to any observed distinctValue. Either set observed=false with a rationale (normalization), or pick one of the observed values.`,
		);
	}
	if (raw.observed === false && !stringIsNonEmpty(raw.rationale)) {
		errors.push(
			`verdict "keep-static" for "${path}" has observed=false but no rationale. Explain why the canonical value is not one of the observed distinct values (e.g. normalized phone/address/name).`,
		);
	}
}

function validateKeepDynamicShape(
	raw: Record<string, unknown>,
	path: string,
	errors: string[],
): void {
	if ("value" in raw) {
		errors.push(
			`verdict "keep-dynamic" for "${path}" must NOT carry a "value" key — dynamic chrome has a per-page value, not a shared one.`,
		);
	}
	if ("observed" in raw) {
		errors.push(
			`verdict "keep-dynamic" for "${path}" must NOT carry an "observed" key — that flag is only meaningful for keep-static.`,
		);
	}
	if (!stringIsNonEmpty(raw.rationale)) {
		errors.push(
			`verdict "keep-dynamic" for "${path}" is missing a rationale string. Explain what pattern makes this chrome-shaped with per-page values (e.g. breadcrumb, pagination, related-posts).`,
		);
	}
	if ("pattern" in raw && raw.pattern !== undefined) {
		if (typeof raw.pattern !== "string" || raw.pattern.trim().length === 0) {
			errors.push(
				`verdict "keep-dynamic" for "${path}" has a non-string "pattern". Use a short label (e.g. "breadcrumb") or omit the key.`,
			);
		}
	}
}

function stringIsNonEmpty(s: unknown): s is string {
	return typeof s === "string" && s.trim().length > 0;
}

function valueIsObservedOnCandidate(
	value: unknown,
	cand: CandidateDigest,
): boolean {
	for (const dv of cand.distinctValues) {
		if (deepEqual(dv.value, value)) return true;
	}
	return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return a === b;
	if (typeof a !== typeof b) return false;
	if (Array.isArray(a) && Array.isArray(b)) return deepEqualArrays(a, b);
	if (typeof a === "object" && typeof b === "object") {
		return deepEqualObjects(
			a as Record<string, unknown>,
			b as Record<string, unknown>,
		);
	}
	return false;
}

function deepEqualArrays(a: unknown[], b: unknown[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (!deepEqual(a[i], b[i])) return false;
	}
	return true;
}

function deepEqualObjects(
	a: Record<string, unknown>,
	b: Record<string, unknown>,
): boolean {
	const ak = Object.keys(a).sort();
	const bk = Object.keys(b).sort();
	if (ak.length !== bk.length) return false;
	for (let i = 0; i < ak.length; i++) {
		if (ak[i] !== bk[i]) return false;
		if (!deepEqual(a[ak[i]], b[bk[i]])) return false;
	}
	return true;
}

/**
 * End-to-end validator for an align batch's rename ops.
 *
 * Composes every programmatic check the align step runs:
 *   1. `validateRichRenameOps` — op-shape rules
 *   2. `compileRichOps`        — expand subtree / split element-key
 *   3. `validateRenameTable`   — cycles, shape fusion, from-uniqueness,
 *                                prefix-extension on the compiled flat
 *   4. `assertBatchCoverage`   — every candidate is untouched or a source
 *   5. `applyRenameTable`      — fold the digest
 *   6. `assertAppliedCoverage` — set algebra over page hashes
 *
 * Both the `./validate` CLI (invoked by the align agent in its tool-use
 * loop) and the runner's post-agent safety net call this function — single
 * source of truth, no drift risk.
 *
 * On success returns the compiled flat + element-key sidecar + post-apply
 * digest; callers wanting only the verdict can ignore those fields.
 */

import {
	applyRenameTable,
	assertAppliedCoverage,
	assertBatchCoverage,
	validateRenameTable,
} from "./harmonize-rename.js";
import { compileRichOps, validateRichRenameOps } from "./harmonize-rich-ops.js";
import type {
	ElementKeyRenameSidecar,
	PageTypeDigest,
	RenameTable,
	RichRenameOp,
	StructuralSignals,
	ValidationResult,
} from "./harmonize-types.js";

export type AlignValidateResult =
	| {
			valid: true;
			errors: [];
			flat: RenameTable;
			elementKey: ElementKeyRenameSidecar;
			postDigest: PageTypeDigest;
	  }
	| {
			valid: false;
			errors: string[];
	  };

export function validateAlignOps(
	digest: PageTypeDigest,
	signals: StructuralSignals | undefined,
	ops: RichRenameOp[],
): AlignValidateResult {
	// Empty ops is valid — "no aliases needed" is the correct answer when
	// no renames apply.
	if (ops.length === 0) {
		return {
			valid: true,
			errors: [],
			flat: [],
			elementKey: [],
			postDigest: digest,
		};
	}

	const rich = validateRichRenameOps({ digest, signals, ops });
	if (!rich.valid) return tagFailure(rich, "rich-validator");

	const compiled = compileRichOps(digest, ops);

	const table = validateRenameTable(digest, compiled.flat);
	if (!table.valid) return tagFailure(table, "rename-validator");

	const coverage = assertBatchCoverage(digest, compiled.flat);
	if (!coverage.valid) return tagFailure(coverage, "coverage");

	let postDigest: PageTypeDigest;
	try {
		postDigest = applyRenameTable(digest, compiled.flat);
	} catch (err) {
		return { valid: false, errors: [`apply: ${String(err)}`] };
	}

	const trace = assertAppliedCoverage(digest, compiled.flat, postDigest);
	if (!trace.valid) return tagFailure(trace, "applied-coverage");

	return {
		valid: true,
		errors: [],
		flat: compiled.flat,
		elementKey: compiled.elementKey,
		postDigest,
	};
}

function tagFailure(
	result: ValidationResult,
	tag: string,
): { valid: false; errors: string[] } {
	return {
		valid: false,
		errors: result.errors.map((e) => `${tag}: ${e}`),
	};
}

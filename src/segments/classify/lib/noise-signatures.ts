/**
 * Deterministic noise classifier used by `deterministic-normalize.ts` during
 * the merged phase 2 (`per-page-value-normalize`) pass.
 *
 * Returns a tag describing why a leaf is noise, or `null` if the value is
 * substantive. Only pure data-shape rules live here; ambiguous leaves and
 * scraper-artifact detection are handled by the LLM batch in the same phase.
 */

export type NoiseSignature =
	| "empty-string"
	| "whitespace-only"
	| "null-literal"
	| "null-string"
	| "undefined-string"
	| "na-string"
	| "no-data-string";

export function detectNoiseSignature(value: unknown): NoiseSignature | null {
	if (value === null) return "null-literal";
	if (typeof value !== "string") return null;
	if (value === "") return "empty-string";
	const trimmed = value.trim();
	if (trimmed === "") return "whitespace-only";
	const lower = trimmed.toLowerCase();
	if (lower === "null") return "null-string";
	if (lower === "undefined") return "undefined-string";
	if (lower === "n/a") return "na-string";
	if (lower === "(no data)") return "no-data-string";
	return null;
}

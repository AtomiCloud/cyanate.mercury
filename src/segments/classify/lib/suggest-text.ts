import type { CandidateDigest, PageTypeDigest } from "./harmonize-types.js";

export interface StrippedCandidateDigest {
	candidatePath: string;
	coverage: number;
	values: unknown[];
}

export interface StrippedPageTypeDigest {
	pagetype: string;
	candidates: StrippedCandidateDigest[];
}

export function stripDigestForSuggest(
	digest: PageTypeDigest,
): StrippedPageTypeDigest {
	return {
		pagetype: digest.pagetype,
		candidates: digest.candidates.map((candidate) =>
			stripCandidateForSuggest(candidate, digest.totalPages),
		),
	};
}

export function stripCandidateForSuggest(
	candidate: CandidateDigest,
	totalPages: number,
): StrippedCandidateDigest {
	return {
		candidatePath: candidate.candidatePath,
		coverage: coverageRatio(candidate.presentOn.length, totalPages),
		values: candidate.distinctValues.map((dv) =>
			compactValueForSuggest(dv.value),
		),
	};
}

export function coverageRatio(
	presentCount: number,
	totalPages: number,
): number {
	if (totalPages <= 0) return 0;
	return Number((presentCount / totalPages).toFixed(3));
}

export function compactValueForSuggest(value: unknown): unknown {
	if (typeof value === "string") return truncate(value, 240);
	if (value === null) return null;
	if (Array.isArray(value)) {
		const items = value.slice(0, 5).map(compactValueForSuggest);
		return value.length > 5
			? [...items, `... ${value.length - 5} more item(s)`]
			: items;
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		const out: Record<string, unknown> = {};
		for (const [key, nested] of entries.slice(0, 12)) {
			out[key] = compactValueForSuggest(nested);
		}
		if (entries.length > 12) {
			out.__truncatedKeys = entries.length - 12;
		}
		return out;
	}
	return value;
}

export function interpretSuggestionsText(
	raw: string,
): { done: true; reason: string } | { done: false } {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return { done: true, reason: "suggestions.txt was empty" };
	}
	const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
	if (/^DONE\s*:/i.test(firstLine)) {
		return {
			done: true,
			reason: firstLine.replace(/^DONE\s*:/i, "").trim() || "done",
		};
	}
	return { done: false };
}

export function isDoneSuggestionText(raw: string): boolean {
	return /^DONE\s*:/i.test(raw.trim());
}

function truncate(value: string, maxLen: number): string {
	if (value.length <= maxLen) return value;
	return `${value.slice(0, maxLen - 3)}...`;
}

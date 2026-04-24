import type { RejectEntry } from "./harmonize-types.js";

export interface RejectInput {
	paths: string[];
	reason?: string;
}

export function normalizeRejectEntry(input: RejectInput): RejectEntry {
	const paths = [...new Set(input.paths)].sort();
	if (paths.length < 2) {
		throw new Error("reject entry must contain at least 2 distinct paths");
	}
	return {
		paths,
		reason: input.reason ?? "agent rejected cluster",
	};
}

export function appendRejectEntry(
	existing: readonly RejectEntry[],
	input: RejectInput,
): RejectEntry[] {
	return [...existing, normalizeRejectEntry(input)];
}

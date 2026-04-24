/**
 * Convert an accepted cluster from `./suggest` into rename ops for the
 * align agent's ops.json. Pure function.
 *
 * Emits the correct op shape:
 *   - Subtree: when all cluster paths share the same prefix EXCEPT at one
 *     wildcard-tail position where the non-canonical sources differ from
 *     the canonical. Produces one `{kind: "subtree", fromPrefix, toPrefix, reason}`
 *     op per non-canonical source.
 *   - Flat: otherwise — one `{kind: "flat", from, to, reason}` op per
 *     non-canonical source.
 *
 * The "one op per non-canonical" shape keeps the validator's existing
 * single-source-per-op invariant. Multi-source clusters produce multiple
 * ops all pointing at the same canonical target.
 */

import type { ClusterSuggestion, RichRenameOp } from "./harmonize-types.js";

export interface OpsifyInput {
	paths: string[];
	suggestedCanonical: string;
	reason?: string;
}

export function clusterToOps(
	input: ClusterSuggestion | OpsifyInput,
): RichRenameOp[] {
	const canonical = input.suggestedCanonical;
	const reason =
		"reason" in input && input.reason
			? input.reason
			: `accepted cluster; canonical=${canonical}`;
	const sources = input.paths.filter((p) => p !== canonical);
	if (sources.length === 0) {
		throw new Error(
			`clusterToOps: cluster has no non-canonical sources (paths=${input.paths.join(", ")}, canonical=${canonical})`,
		);
	}
	const ops: RichRenameOp[] = [];
	for (const source of sources) {
		ops.push(buildOpForPair(source, canonical, reason));
	}
	return ops;
}

function buildOpForPair(
	source: string,
	canonical: string,
	reason: string,
): RichRenameOp {
	const subtreePair = deriveSubtreePair(source, canonical);
	if (subtreePair) {
		return {
			kind: "subtree",
			fromPrefix: subtreePair.fromPrefix,
			toPrefix: subtreePair.toPrefix,
			reason,
		};
	}
	return { kind: "flat", from: source, to: canonical, reason };
}

/**
 * If `source` and `canonical` differ only in a prefix segment — and the
 * shared suffix is non-empty and begins with a wildcard (`[*]`) — we can
 * express the rename as a subtree op. Example:
 *
 *   source    = "header.nav[*].submenu[*].href"
 *   canonical = "header.nav[*].children[*].href"
 *   → fromPrefix = "header.nav[*].submenu"
 *     toPrefix   = "header.nav[*].children"
 *     (shared suffix "[*].href" is implicit)
 *
 * Returns null when a flat op is more appropriate.
 */
function deriveSubtreePair(
	source: string,
	canonical: string,
): { fromPrefix: string; toPrefix: string } | null {
	const segsA = splitSegmentsKeepWildcard(source);
	const segsB = splitSegmentsKeepWildcard(canonical);
	// Find the first differing segment.
	let diffIdx = 0;
	while (
		diffIdx < segsA.length &&
		diffIdx < segsB.length &&
		segsA[diffIdx] === segsB[diffIdx]
	) {
		diffIdx++;
	}
	// After the differing segment, the remaining segments must be identical
	// AND the next segment after the diff must be "[*]" for subtree to be
	// a net simplification (it reduces N wildcard-expanded flat ops to one).
	if (diffIdx >= segsA.length || diffIdx >= segsB.length) return null;
	if (diffIdx === segsA.length - 1 && diffIdx === segsB.length - 1) return null; // flat rename at terminal
	const tailA = segsA.slice(diffIdx + 1);
	const tailB = segsB.slice(diffIdx + 1);
	if (tailA.length !== tailB.length) return null;
	for (let i = 0; i < tailA.length; i++) {
		if (tailA[i] !== tailB[i]) return null;
	}
	if (tailA.length === 0 || tailA[0] !== "[*]") return null;
	return {
		fromPrefix: segsToPath(segsA.slice(0, diffIdx + 1)),
		toPrefix: segsToPath(segsB.slice(0, diffIdx + 1)),
	};
}

function splitSegmentsKeepWildcard(path: string): string[] {
	const out: string[] = [];
	if (!path) return out;
	for (const raw of path.split(".")) {
		if (!raw) continue;
		const match = raw.match(/^([^[]*)((?:\[\*\])*)$/);
		if (!match) {
			out.push(raw);
			continue;
		}
		const [, key, brackets] = match;
		if (key) out.push(key);
		for (const _ of brackets.matchAll(/\[\*\]/g)) out.push("[*]");
	}
	return out;
}

function segsToPath(segs: string[]): string {
	let out = "";
	for (const seg of segs) {
		if (seg === "[*]") {
			out += "[*]";
		} else {
			out += out === "" ? seg : `.${seg}`;
		}
	}
	return out;
}

/**
 * Compose per-layer rename tables into a single chained table with provenance.
 *
 * Each align layer emits its own `rename-table.json` that renames among the
 * candidates visible AT THAT LAYER (post-prior-layer reductions). Downstream
 * consumers (verdicts, assemble) want a single flat table that resolves every
 * original candidate to its final canonical name in one hop, plus enough
 * metadata to trace how it got there.
 *
 * Pure — no filesystem, no judgment.
 */

import type { RenameEntry, RenameTable } from "./harmonize-types.js";

export interface LayerRenameInput {
	/** Layer number (1, 2, 3). Used only for provenance in hops. */
	layer: number;
	/** Optional batch index for per-iteration fan-out provenance. */
	batchIndex?: number;
	table: RenameTable;
}

export interface ComposedHop {
	layer: number;
	batchIndex?: number;
	from: string;
	to: string;
	reason: string;
}

export interface ComposedEntry {
	/** Original candidate name (pre any rename). */
	original: string;
	/** Final canonical name after chaining every layer's renames. */
	final: string;
	/** Per-layer hops that moved this original to its final name. */
	hops: ComposedHop[];
}

export interface ComposedRenameTable {
	entries: ComposedEntry[];
	/**
	 * Flat rename list equivalent to `entries`, in the legacy
	 * `{from, to, reason}` shape. The `reason` is synthesised as
	 * `"layered: L<a>..L<b>"` describing which layers contributed hops.
	 * Lets the existing verdicts/assemble plumbing read a single-layer table
	 * unchanged.
	 */
	flat: RenameTable;
}

export interface TraceState {
	layer: number;
	batchIndex?: number;
	path: string;
}

export interface RenameTraceEntry {
	original: string;
	final: string;
	states: TraceState[];
	hops: ComposedHop[];
}

export interface ComposedRenameTrace {
	entries: RenameTraceEntry[];
	finalToOriginals: Record<string, string[]>;
}

/**
 * Chain a sequence of per-layer rename tables. Layers are applied in order —
 * later layers see the post-prior-layer candidate set.
 *
 * Cycle detection: each individual layer's table is pre-validated acyclic
 * before being handed to us, and layer N's `from`s can only reference
 * post-layer-(N-1) candidates (prior `from`s were renamed away, so they
 * shouldn't appear as a layer-N `from`). A cycle across layers would require
 * an original's final to re-appear as a downstream `from` — we defensively
 * detect and throw, but the per-layer validators prevent this from happening
 * in practice.
 */
export function composeRenameTables(
	layers: readonly LayerRenameInput[],
): ComposedRenameTable {
	const edges = layers.flatMap(({ layer, batchIndex, table }) =>
		table.map((entry) => ({
			layer,
			batchIndex,
			from: entry.from,
			to: entry.to,
			reason: entry.reason,
		})),
	);
	if (edges.length === 0) return { entries: [], flat: [] };

	const outgoing = new Map<string, ComposedHop[]>();
	for (const edge of edges) {
		const list = outgoing.get(edge.from);
		if (list) list.push(edge);
		else outgoing.set(edge.from, [edge]);
	}

	const entries: ComposedEntry[] = [];
	const originals = [...new Set(edges.map((e) => e.from))].sort();
	for (const original of originals) {
		const terminals = new Set<string>();
		const hopByKey = new Map<string, ComposedHop>();
		collectRoutes(original, outgoing, terminals, hopByKey, []);
		if (terminals.size === 0) continue;
		if (terminals.size > 1) {
			throw new Error(
				`composeRenameTables: ambiguous terminal for "${original}" — ${[...terminals].sort().join(", ")}`,
			);
		}
		const final = [...terminals][0] as string;
		if (original === final) continue;
		entries.push({
			original,
			final,
			hops: [...hopByKey.values()].sort(compareHops),
		});
	}

	entries.sort((a, b) => (a.original < b.original ? -1 : 1));
	const flat: RenameTable = entries.map((e) => ({
		from: e.original,
		to: e.final,
		reason: describeHops(e.hops),
	}));
	return { entries, flat };
}

export function buildComposedRenameTrace(
	composed: ComposedRenameTable,
): ComposedRenameTrace {
	const entries = composed.entries.map((entry) => ({
		original: entry.original,
		final: entry.final,
		states: traceStatesForEntry(entry),
		hops: entry.hops,
	}));
	const finalToOriginals = Object.fromEntries(
		groupByFinal(entries).map(([final, originals]) => [final, originals]),
	);
	return { entries, finalToOriginals };
}

function traceStatesForEntry(entry: ComposedEntry): TraceState[] {
	const outgoing = new Map<string, ComposedHop[]>();
	for (const hop of entry.hops) {
		const list = outgoing.get(hop.from);
		if (list) list.push(hop);
		else outgoing.set(hop.from, [hop]);
	}
	for (const hops of outgoing.values()) hops.sort(compareHops);

	const states: TraceState[] = [];
	const seenEdges = new Set<string>();
	const seenStates = new Set<string>();

	const visit = (cursor: string): void => {
		for (const hop of outgoing.get(cursor) ?? []) {
			const edgeKey = hopKey(hop);
			if (seenEdges.has(edgeKey)) continue;
			seenEdges.add(edgeKey);

			const stateKey = [hop.layer, hop.batchIndex ?? "", hop.to].join("\u0000");
			if (!seenStates.has(stateKey)) {
				seenStates.add(stateKey);
				states.push({
					layer: hop.layer,
					batchIndex: hop.batchIndex,
					path: hop.to,
				});
			}
			visit(hop.to);
		}
	};

	visit(entry.original);
	return states;
}

function groupByFinal(
	entries: readonly RenameTraceEntry[],
): Array<[string, string[]]> {
	const byFinal = new Map<string, string[]>();
	for (const entry of entries) {
		const list = byFinal.get(entry.final);
		if (list) list.push(entry.original);
		else byFinal.set(entry.final, [entry.original]);
	}
	return [...byFinal.entries()]
		.map(
			([final, originals]) => [final, originals.sort()] as [string, string[]],
		)
		.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function collectRoutes(
	cursor: string,
	outgoing: Map<string, ComposedHop[]>,
	terminals: Set<string>,
	hopByKey: Map<string, ComposedHop>,
	stack: string[],
): void {
	if (stack.includes(cursor)) {
		throw new Error(
			`composeRenameTables: cycle detected — ${[...stack, cursor].join(" -> ")}`,
		);
	}
	const edges = outgoing.get(cursor) ?? [];
	if (edges.length === 0) {
		terminals.add(cursor);
		return;
	}
	const nextStack = [...stack, cursor];
	for (const edge of edges) {
		hopByKey.set(hopKey(edge), edge);
		collectRoutes(edge.to, outgoing, terminals, hopByKey, nextStack);
	}
}

function describeHops(hops: readonly ComposedHop[]): string {
	if (hops.length === 0) return "";
	if (hops.length === 1) {
		const h = hops[0];
		const prefix =
			h.batchIndex === undefined
				? `layer-${h.layer}`
				: `layer-${h.layer}/batch-${h.batchIndex}`;
		return `${prefix}: ${h.reason}`.trim().replace(/:\s*$/, "");
	}
	const layersDesc = hops
		.map((h) =>
			h.batchIndex === undefined
				? `L${h.layer}`
				: `L${h.layer}B${h.batchIndex}`,
		)
		.join("→");
	// Keep any hop that carried a non-empty reason — after stripping the
	// "L<n>: " prefix, "non-empty" is `reason.trim().length > 0`, which we
	// check on the raw field before formatting so a 1–3-char reason isn't
	// silently dropped.
	const reasons = hops
		.filter((h) => h.reason.trim().length > 0)
		.map((h) => {
			const prefix =
				h.batchIndex === undefined
					? `L${h.layer}`
					: `L${h.layer}B${h.batchIndex}`;
			return `${prefix}: ${h.reason.trim()}`;
		})
		.join(" | ");
	return reasons.length > 0
		? `${layersDesc} (${reasons})`
		: `layered: ${layersDesc}`;
}

function hopKey(hop: ComposedHop): string {
	return [hop.layer, hop.batchIndex ?? "", hop.from, hop.to, hop.reason].join(
		"\u0000",
	);
}

function compareHops(a: ComposedHop, b: ComposedHop): number {
	if (a.layer !== b.layer) return a.layer - b.layer;
	const aBatch = a.batchIndex ?? -1;
	const bBatch = b.batchIndex ?? -1;
	if (aBatch !== bBatch) return aBatch - bBatch;
	if (a.from !== b.from) return a.from < b.from ? -1 : 1;
	if (a.to !== b.to) return a.to < b.to ? -1 : 1;
	if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
	return 0;
}

/**
 * Assert that every original candidate (names in `originalPaths`) either
 * survives unchanged or resolves in `composed.flat` to a name in the final
 * candidate set (`finalPaths`). Loud failure of this check means an align
 * layer dropped a candidate silently — a structural regression.
 */
export function assertComposedCoverage(
	composed: ComposedRenameTable,
	originalPaths: readonly string[],
	finalPaths: readonly string[],
): { valid: boolean; errors: string[] } {
	const errors: string[] = [];
	const flatByFrom = new Map(
		composed.flat.map((e: RenameEntry) => [e.from, e.to]),
	);
	const finalSet = new Set(finalPaths);
	for (const orig of originalPaths) {
		const resolved = flatByFrom.get(orig) ?? orig;
		if (!finalSet.has(resolved)) {
			errors.push(
				`original candidate "${orig}" resolves to "${resolved}" but that name is not in the final digest`,
			);
		}
	}
	return { valid: errors.length === 0, errors };
}

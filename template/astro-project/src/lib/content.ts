/**
 * Query layer — cached collection access with indexed lookups.
 *
 * Wraps Astro's native content collection API with:
 * - Per-build caching (each collection loaded once, reused across all pages)
 * - Indexed field lookups (O(1) after first call)
 * - Taxonomy helpers (distinct values with counts)
 *
 * Templates import from here, not from 'astro:content' directly.
 * Phase 3 (Transform + Seed) regenerates this file with typed collection names.
 */

// biome-ignore-all lint/suspicious/noExplicitAny: generic query layer works with any collection shape

import { getCollection, getEntries, getEntry } from "astro:content";

type CollectionEntry = { id: string; data: Record<string, unknown> };

// ---- Cache: load each collection once per build ----
const cache = new Map<string, CollectionEntry[]>();

async function getCached(collection: string): Promise<CollectionEntry[]> {
	if (!cache.has(collection)) {
		const entries = await getCollection(collection as never);
		cache.set(collection, entries as CollectionEntry[]);
	}
	// biome-ignore lint/style/noNonNullAssertion: guaranteed by set above
	return cache.get(collection)!;
}

// ---- Indexed lookups: O(1) by field value ----
const indexes = new Map<string, Map<string, CollectionEntry[]>>();

function getIndex(
	entries: CollectionEntry[],
	collection: string,
	field: string,
): Map<string, CollectionEntry[]> {
	const key = `${collection}:${field}`;
	if (!indexes.has(key)) {
		const idx = new Map<string, CollectionEntry[]>();
		for (const entry of entries) {
			const raw = entry.data[field];
			const vals = Array.isArray(raw) ? raw : [raw];
			for (const v of vals) {
				if (v == null) continue;
				const k = String(v);
				if (!idx.has(k)) idx.set(k, []);
				idx.get(k)?.push(entry);
			}
		}
		indexes.set(key, idx);
	}
	// biome-ignore lint/style/noNonNullAssertion: guaranteed by set above
	return indexes.get(key)!;
}

// ---- Public API ----

/** Query a collection with filter, sort, pagination. Cached. */
export async function queryCollection(
	collection: string,
	opts?: {
		filter?: (entry: CollectionEntry) => boolean;
		sort?: (a: CollectionEntry, b: CollectionEntry) => number;
		limit?: number;
		offset?: number;
	},
): Promise<CollectionEntry[]> {
	let entries = await getCached(collection);
	if (opts?.filter) entries = entries.filter(opts.filter);
	if (opts?.sort) entries = [...entries].sort(opts.sort);
	if (opts?.offset) entries = entries.slice(opts.offset);
	if (opts?.limit) entries = entries.slice(0, opts.limit);
	return entries;
}

/** Get entries by a field value. Indexed — O(1) after first call. */
export async function getByField(
	collection: string,
	field: string,
	value: string,
): Promise<CollectionEntry[]> {
	const entries = await getCached(collection);
	const idx = getIndex(entries, collection, field);
	return idx.get(value) ?? [];
}

/** Get prev/next entries in a sorted collection. */
export async function getAdjacent(
	collection: string,
	currentId: string,
	sort: (a: CollectionEntry, b: CollectionEntry) => number,
): Promise<{ prev: CollectionEntry | null; next: CollectionEntry | null }> {
	const all = [...(await getCached(collection))].sort(sort);
	const idx = all.findIndex((e) => e.id === currentId);
	return {
		prev: idx > 0 ? all[idx - 1] : null,
		next: idx < all.length - 1 ? all[idx + 1] : null,
	};
}

/** Get distinct values of a field with counts. Indexed. */
export async function getTaxonomy(
	collection: string,
	field: string,
): Promise<{ value: string; count: number }[]> {
	const entries = await getCached(collection);
	const idx = getIndex(entries, collection, field);
	return [...idx.entries()]
		.map(([value, items]) => ({ value, count: items.length }))
		.sort((a, b) => b.count - a.count);
}

// Re-export Astro's native APIs for direct use
export { getEntries, getEntry };

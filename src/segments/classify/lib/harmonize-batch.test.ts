import { describe, expect, it } from "bun:test";
import {
	batchItems,
	chunkFromBatchDigest,
	digestFromChunks,
	mergeDigests,
	PAGES_PER_BATCH,
	pageChunks,
	unionRenameTables,
} from "./harmonize-batch.js";
import type { PageTypeDigest, RenameTable } from "./harmonize-types.js";

describe("batchItems", () => {
	it("returns zero batches for empty input", () => {
		expect(batchItems([], 20)).toEqual([]);
	});

	it("packs a short array into one batch (< batch size)", () => {
		const items = ["a", "b", "c"];
		expect(batchItems(items, 20)).toEqual([items]);
	});

	it("packs exactly batch-size items into one batch", () => {
		const items = Array.from({ length: 20 }, (_, i) => i);
		const out = batchItems(items, 20);
		expect(out).toHaveLength(1);
		expect(out[0]).toHaveLength(20);
	});

	it("splits 21 items into two batches (20 + 1)", () => {
		const items = Array.from({ length: 21 }, (_, i) => i);
		const out = batchItems(items, 20);
		expect(out).toHaveLength(2);
		expect(out[0]).toHaveLength(20);
		expect(out[1]).toEqual([20]);
	});

	it("splits 400 items into 20 batches of 20", () => {
		const items = Array.from({ length: 400 }, (_, i) => i);
		const out = batchItems(items, 20);
		expect(out).toHaveLength(20);
		for (const batch of out) expect(batch).toHaveLength(20);
	});

	it("throws on non-positive size", () => {
		expect(() => batchItems([1, 2, 3], 0)).toThrow();
		expect(() => batchItems([1, 2, 3], -1)).toThrow();
	});

	it("exports the PAGES_PER_BATCH default as 5", () => {
		expect(PAGES_PER_BATCH).toBe(5);
	});
});

// ---------------------------------------------------------------------------
// Helpers for building digests for tests
// ---------------------------------------------------------------------------

function mkDigest(
	pagetype: string,
	perPage: Record<string, Array<{ path: string; value: unknown }>>,
): PageTypeDigest {
	const pageHashes = Object.keys(perPage).sort();
	const byCandidate = new Map<
		string,
		{
			distinctValues: Map<string, { value: unknown; pageHashes: string[] }>;
			presentOn: Set<string>;
		}
	>();
	for (const h of pageHashes) {
		for (const { path, value } of perPage[h]) {
			let bucket = byCandidate.get(path);
			if (!bucket) {
				bucket = { distinctValues: new Map(), presentOn: new Set() };
				byCandidate.set(path, bucket);
			}
			bucket.presentOn.add(h);
			const key = JSON.stringify(value);
			const dv = bucket.distinctValues.get(key);
			if (dv) dv.pageHashes.push(h);
			else bucket.distinctValues.set(key, { value, pageHashes: [h] });
		}
	}
	return {
		pagetype,
		totalPages: pageHashes.length,
		pageHashes,
		candidates: [...byCandidate.entries()].map(([path, bucket]) => ({
			candidatePath: path,
			distinctValues: [...bucket.distinctValues.values()].map((dv) => ({
				value: dv.value,
				pageHashes: [...dv.pageHashes].sort(),
			})),
			presentOn: [...bucket.presentOn].sort(),
			absentFrom: pageHashes.filter((h) => !bucket.presentOn.has(h)),
		})),
	};
}

describe("pageChunks", () => {
	it("returns one chunk per page with that page's contributions", () => {
		const d = mkDigest("t", {
			p0: [
				{ path: "a", value: "x" },
				{ path: "b", value: 1 },
			],
			p1: [{ path: "a", value: "y" }],
		});
		const chunks = pageChunks(d);
		expect(chunks).toHaveLength(2);
		const p0 = chunks.find((c) => c.itemId === "p0");
		expect(p0?.candidates).toHaveLength(2);
		const p0a = p0?.candidates.find((c) => c.candidatePath === "a");
		expect(p0a?.distinctValues[0].value).toBe("x");
		const p1 = chunks.find((c) => c.itemId === "p1");
		expect(p1?.candidates).toHaveLength(1);
		expect(p1?.candidates[0].distinctValues[0].value).toBe("y");
	});

	it("throws when a candidate references a pageHash outside digest.pageHashes", () => {
		const bad: PageTypeDigest = {
			pagetype: "t",
			totalPages: 1,
			pageHashes: ["p0"],
			candidates: [
				{
					candidatePath: "a",
					distinctValues: [{ value: 1, pageHashes: ["p0", "ghost"] }],
					presentOn: ["p0", "ghost"],
					absentFrom: [],
				},
			],
		};
		expect(() => pageChunks(bad)).toThrow(/unknown pageHash/);
	});

	it("returns an empty chunk for a page with no contributed candidates", () => {
		const d = mkDigest("t", {
			p0: [{ path: "a", value: 1 }],
			p1: [],
		});
		const chunks = pageChunks(d);
		const p1 = chunks.find((c) => c.itemId === "p1");
		expect(p1).toBeDefined();
		expect(p1?.candidates).toHaveLength(0);
	});
});

describe("digestFromChunks", () => {
	it("round-trips: pageChunks → digestFromChunks reproduces the candidate set", () => {
		const d = mkDigest("t", {
			p0: [
				{ path: "a", value: "x" },
				{ path: "b", value: 1 },
			],
			p1: [
				{ path: "a", value: "x" },
				{ path: "c", value: true },
			],
		});
		const out = digestFromChunks(pageChunks(d), "t");
		expect(out.candidates.map((c) => c.candidatePath).sort()).toEqual([
			"a",
			"b",
			"c",
		]);
		const a = out.candidates.find((c) => c.candidatePath === "a");
		// both pages share the same value → one distinct value, 2 pageHashes
		expect(a?.distinctValues).toHaveLength(1);
		expect(a?.distinctValues[0].pageHashes.sort()).toEqual(["p0", "p1"]);
	});

	it("merges chunks that contribute the same path with different values", () => {
		const d = mkDigest("t", {
			p0: [{ path: "a", value: "x" }],
			p1: [{ path: "a", value: "y" }],
		});
		const out = digestFromChunks(pageChunks(d), "t");
		const a = out.candidates.find((c) => c.candidatePath === "a");
		expect(a?.distinctValues).toHaveLength(2);
	});
});

describe("chunkFromBatchDigest", () => {
	it("wraps a batch's post-apply sub-digest with a stable itemId", () => {
		const d = mkDigest("t", {
			p0: [{ path: "a", value: 1 }],
		});
		const chunk = chunkFromBatchDigest(3, d);
		expect(chunk.itemId).toBe("batch-3");
		expect(chunk.candidates.map((c) => c.candidatePath)).toEqual(["a"]);
	});
});

describe("mergeDigests", () => {
	it("merges batch digests while preserving real page hashes", () => {
		const d1 = mkDigest("t", {
			p0: [{ path: "a", value: "x" }],
			p1: [{ path: "b", value: 1 }],
		});
		const d2 = mkDigest("t", {
			p2: [{ path: "a", value: "x" }],
			p3: [{ path: "c", value: true }],
		});
		const out = mergeDigests([d1, d2]);
		expect(out.totalPages).toBe(4);
		expect(out.pageHashes).toEqual(["p0", "p1", "p2", "p3"]);
		expect(out.candidates.map((c) => c.candidatePath).sort()).toEqual([
			"a",
			"b",
			"c",
		]);
		const a = out.candidates.find((c) => c.candidatePath === "a");
		expect(a?.presentOn).toEqual(["p0", "p2"]);
	});

	it("throws when digests from different pagetypes are merged", () => {
		const d1 = mkDigest("a", { p0: [{ path: "x", value: 1 }] });
		const d2 = mkDigest("b", { p1: [{ path: "x", value: 1 }] });
		expect(() => mergeDigests([d1, d2])).toThrow(/pagetype mismatch/);
	});
});

describe("unionRenameTables", () => {
	it("concatenates disjoint tables", () => {
		const t1: RenameTable = [{ from: "a", to: "x", reason: "" }];
		const t2: RenameTable = [{ from: "b", to: "y", reason: "" }];
		expect(unionRenameTables([t1, t2])).toEqual([
			{ from: "a", to: "x", reason: "" },
			{ from: "b", to: "y", reason: "" },
		]);
	});

	it("de-duplicates identical (from, to) pairs silently", () => {
		const t: RenameTable = [{ from: "a", to: "x", reason: "dup" }];
		expect(unionRenameTables([t, t])).toEqual([
			{ from: "a", to: "x", reason: "dup" },
		]);
	});

	it("throws on conflicting renames (same from → different to)", () => {
		const t1: RenameTable = [{ from: "a", to: "x", reason: "" }];
		const t2: RenameTable = [{ from: "a", to: "y", reason: "" }];
		expect(() => unionRenameTables([t1, t2])).toThrow(/conflicting/i);
	});
});

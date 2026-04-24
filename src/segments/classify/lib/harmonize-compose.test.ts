import { describe, expect, it } from "bun:test";
import {
	assertComposedCoverage,
	buildComposedRenameTrace,
	composeRenameTables,
} from "./harmonize-compose.js";
import type { RenameTable } from "./harmonize-types.js";

describe("composeRenameTables", () => {
	it("single-layer passthrough — composed.flat matches the input table", () => {
		const t: RenameTable = [
			{ from: "header.nav", to: "header.navigation", reason: "alias" },
		];
		const c = composeRenameTables([{ layer: 1, table: t }]);
		expect(c.entries).toHaveLength(1);
		expect(c.entries[0].original).toBe("header.nav");
		expect(c.entries[0].final).toBe("header.navigation");
		expect(c.entries[0].hops).toHaveLength(1);
		expect(c.entries[0].hops[0].layer).toBe(1);
		expect(c.flat).toHaveLength(1);
		expect(c.flat[0].from).toBe("header.nav");
		expect(c.flat[0].to).toBe("header.navigation");
	});

	it("no renames → empty composed output", () => {
		const c = composeRenameTables([{ layer: 1, table: [] }]);
		expect(c.entries).toEqual([]);
		expect(c.flat).toEqual([]);
	});

	it("two-layer chain — original hops through intermediate to final", () => {
		const L1: RenameTable = [{ from: "a", to: "b", reason: "L1 alias" }];
		const L2: RenameTable = [{ from: "b", to: "c", reason: "L2 realignment" }];
		const c = composeRenameTables([
			{ layer: 1, table: L1 },
			{ layer: 2, table: L2 },
		]);
		const a = c.entries.find((e) => e.original === "a");
		expect(a?.final).toBe("c");
		expect(a?.hops).toHaveLength(2);
		expect(a?.hops[0].layer).toBe(1);
		expect(a?.hops[1].layer).toBe(2);
		// "b" also appears as an original at layer 2 — renamed to "c"
		const b = c.entries.find((e) => e.original === "b");
		expect(b?.final).toBe("c");
		// flat table: both originals resolve to "c"
		expect(c.flat.map((e) => [e.from, e.to]).sort()).toEqual([
			["a", "c"],
			["b", "c"],
		]);
	});

	it("three-layer chain — x → y → z → w", () => {
		const c = composeRenameTables([
			{ layer: 1, table: [{ from: "x", to: "y", reason: "" }] },
			{ layer: 2, table: [{ from: "y", to: "z", reason: "" }] },
			{ layer: 3, table: [{ from: "z", to: "w", reason: "" }] },
		]);
		const x = c.entries.find((e) => e.original === "x");
		expect(x?.final).toBe("w");
		expect(x?.hops).toHaveLength(3);
		// All four "original"s (x, y, z) resolve to "w" in the flat table
		expect(c.flat.map((e) => [e.from, e.to]).sort()).toEqual([
			["x", "w"],
			["y", "w"],
			["z", "w"],
		]);
	});

	it("independent renames across layers — each stays on its own chain", () => {
		const c = composeRenameTables([
			{ layer: 1, table: [{ from: "a", to: "b", reason: "" }] },
			{ layer: 2, table: [{ from: "c", to: "d", reason: "" }] },
		]);
		const entries = c.flat.map((e) => [e.from, e.to]).sort();
		expect(entries).toEqual([
			["a", "b"],
			["c", "d"],
		]);
	});

	it("in-layer chain — a→b and b→c within one layer both resolve to c", () => {
		// Regression for run 20260422-132336: per-batch convergence produced a
		// subtree op (footer.contact_info → footer.contact_information) and a
		// flat op (footer.contact_information.* → footer.*) in the same iter.
		// Compose must resolve the chain so the flat table's `to`s land on
		// names that exist in the final digest.
		const c = composeRenameTables([
			{
				layer: 1,
				table: [
					{ from: "a", to: "b", reason: "L1 subtree-expand" },
					{ from: "b", to: "c", reason: "L1 flat" },
				],
			},
		]);
		const a = c.entries.find((e) => e.original === "a");
		expect(a?.final).toBe("c");
		// Provenance preserves both sub-steps.
		expect(a?.hops).toHaveLength(2);
		const b = c.entries.find((e) => e.original === "b");
		expect(b?.final).toBe("c");
		// Flat table maps both originals directly to the terminal.
		expect(c.flat.map((e) => [e.from, e.to]).sort()).toEqual([
			["a", "c"],
			["b", "c"],
		]);
		// assertComposedCoverage passes: originals a, b both resolve to c ∈ finals.
		const cov = assertComposedCoverage(c, ["a", "b"], ["c"]);
		expect(cov.valid).toBe(true);
	});

	it("collapses multiple originals onto a shared target (a → c, b → c)", () => {
		const c = composeRenameTables([
			{
				layer: 1,
				table: [
					{ from: "a", to: "c", reason: "" },
					{ from: "b", to: "c", reason: "" },
				],
			},
		]);
		const targets = new Set(c.flat.map((e) => e.to));
		expect(targets.size).toBe(1);
		expect([...targets]).toEqual(["c"]);
		expect(c.flat).toHaveLength(2);
	});

	it("allows sibling-batch divergence when later layers reconcile to one terminal", () => {
		const c = composeRenameTables([
			{
				layer: 1,
				batchIndex: 0,
				table: [{ from: "book_now", to: "book.now", reason: "batch-0" }],
			},
			{
				layer: 1,
				batchIndex: 1,
				table: [
					{
						from: "book_now_link",
						to: "book_now.link",
						reason: "batch-1",
					},
				],
			},
			{
				layer: 2,
				batchIndex: 0,
				table: [
					{ from: "book.now", to: "canonical", reason: "finalize" },
					{ from: "book_now.link", to: "book.now", reason: "reconcile" },
				],
			},
		]);
		expect(c.flat.map((e) => [e.from, e.to]).sort()).toEqual([
			["book.now", "canonical"],
			["book_now", "canonical"],
			["book_now.link", "canonical"],
			["book_now_link", "canonical"],
		]);
	});

	it("omits identity rows (original === final) from flat output", () => {
		const c = composeRenameTables([{ layer: 1, table: [] }]);
		expect(c.flat).toEqual([]);
	});

	it("detects a direct cycle within a single layer (a → a)", () => {
		expect(() =>
			composeRenameTables([
				{ layer: 1, table: [{ from: "a", to: "a", reason: "" }] },
			]),
		).toThrow(/cycle/i);
	});

	it("detects a cross-layer cycle (a → b then b → a)", () => {
		expect(() =>
			composeRenameTables([
				{ layer: 1, table: [{ from: "a", to: "b", reason: "" }] },
				{ layer: 2, table: [{ from: "b", to: "a", reason: "" }] },
			]),
		).toThrow(/cycle/i);
	});

	it("fails when sibling divergence never converges to one terminal", () => {
		expect(() =>
			composeRenameTables([
				{
					layer: 1,
					batchIndex: 0,
					table: [{ from: "a", to: "b", reason: "" }],
				},
				{
					layer: 1,
					batchIndex: 1,
					table: [{ from: "a", to: "c", reason: "" }],
				},
			]),
		).toThrow(/ambiguous terminal/i);
	});
});

describe("assertComposedCoverage", () => {
	it("passes when every original resolves to a final name in the digest", () => {
		const c = composeRenameTables([
			{ layer: 1, table: [{ from: "a", to: "b", reason: "" }] },
		]);
		const result = assertComposedCoverage(c, ["a", "b", "c"], ["b", "c"]);
		expect(result.valid).toBe(true);
	});

	it("fails when an original resolves to a name not in the final digest", () => {
		const c = composeRenameTables([
			{ layer: 1, table: [{ from: "a", to: "b", reason: "" }] },
		]);
		const result = assertComposedCoverage(c, ["a"], ["c"]);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("a");
	});

	it("passes when there are no renames and all originals are in the final set", () => {
		const c = composeRenameTables([{ layer: 1, table: [] }]);
		const result = assertComposedCoverage(c, ["x", "y"], ["x", "y"]);
		expect(result.valid).toBe(true);
	});
});

describe("buildComposedRenameTrace", () => {
	it("records per-layer states and final-to-original lineage", () => {
		const composed = composeRenameTables([
			{
				layer: 1,
				batchIndex: 0,
				table: [{ from: "book_now", to: "book.now", reason: "batch-0" }],
			},
			{
				layer: 1,
				batchIndex: 1,
				table: [
					{ from: "book_now_link", to: "book_now.link", reason: "batch-1" },
				],
			},
			{
				layer: 2,
				batchIndex: 0,
				table: [
					{ from: "book.now", to: "canonical", reason: "finalize" },
					{ from: "book_now.link", to: "book.now", reason: "reconcile" },
				],
			},
		]);
		const trace = buildComposedRenameTrace(composed);
		expect(trace.finalToOriginals).toEqual({
			canonical: ["book.now", "book_now", "book_now.link", "book_now_link"],
		});
		const bookNow = trace.entries.find((e) => e.original === "book_now");
		expect(bookNow?.states).toEqual([
			{ layer: 1, batchIndex: 0, path: "book.now" },
			{ layer: 2, batchIndex: 0, path: "canonical" },
		]);
		const link = trace.entries.find((e) => e.original === "book_now_link");
		expect(link?.states).toEqual([
			{ layer: 1, batchIndex: 1, path: "book_now.link" },
			{ layer: 2, batchIndex: 0, path: "book.now" },
			{ layer: 2, batchIndex: 0, path: "canonical" },
		]);
	});
});

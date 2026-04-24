import { describe, expect, it } from "bun:test";
import {
	applyRenameToChrome,
	applyWildcardRename,
	buildCompressedChrome,
	enumerateLeafPaths,
	indexRenameTable,
	setAtPath,
	verifyRoundTrip,
} from "./chrome-materialize.js";
import type { RenameTable } from "./harmonize-types.js";

describe("enumerateLeafPaths", () => {
	it("enumerates primitives and records wildcard-generalized path", () => {
		const obj = {
			header: { logo: { src: "/logo", alt: "Acme" } },
			footer: { items: [{ href: "/a" }, { href: "/b" }] },
		};
		const leaves = enumerateLeafPaths(obj);
		const paths = leaves.map((l) => [l.concretePath, l.generalPath, l.value]);
		expect(paths).toEqual([
			["header.logo.src", "header.logo.src", "/logo"],
			["header.logo.alt", "header.logo.alt", "Acme"],
			["footer.items[0].href", "footer.items[*].href", "/a"],
			["footer.items[1].href", "footer.items[*].href", "/b"],
		]);
	});

	it("treats empty containers as leaves", () => {
		const obj = { empty: {}, list: [] };
		const leaves = enumerateLeafPaths(obj);
		expect(leaves.map((l) => l.concretePath)).toEqual(["empty", "list"]);
	});

	it("treats null as a leaf", () => {
		const obj = { x: null };
		const leaves = enumerateLeafPaths(obj);
		expect(leaves).toEqual([
			{ concretePath: "x", generalPath: "x", value: null },
		]);
	});
});

describe("applyWildcardRename", () => {
	it("handles flat rename with no wildcards", () => {
		expect(
			applyWildcardRename("footer.mobile", "footer.mobile", "footer.phone"),
		).toBe("footer.phone");
	});

	it("substitutes concrete indices into target wildcards positionally", () => {
		expect(
			applyWildcardRename(
				"header.nav[0].submenu[2].href",
				"header.nav[*].submenu[*].href",
				"header.nav[*].children[*].href",
			),
		).toBe("header.nav[0].children[2].href");
	});

	it("throws when wildcard counts differ", () => {
		expect(() => applyWildcardRename("a[0]", "a[*]", "a[*].b[*]")).toThrow();
	});

	it("throws when concrete doesn't match from pattern", () => {
		expect(() =>
			applyWildcardRename("header.x", "footer.x", "footer.y"),
		).toThrow();
	});
});

describe("setAtPath", () => {
	it("sets a value at a simple key path", () => {
		const root: Record<string, unknown> = {};
		setAtPath(root, "a.b.c", 42);
		expect(root).toEqual({ a: { b: { c: 42 } } });
	});

	it("creates arrays for numeric bracket segments", () => {
		const root: Record<string, unknown> = {};
		setAtPath(root, "items[0].name", "first");
		setAtPath(root, "items[1].name", "second");
		expect(root).toEqual({
			items: [{ name: "first" }, { name: "second" }],
		});
	});

	it("preserves existing siblings when setting new paths", () => {
		const root: Record<string, unknown> = { header: { existing: 1 } };
		setAtPath(root, "header.new", 2);
		expect(root).toEqual({ header: { existing: 1, new: 2 } });
	});
});

describe("applyRenameToChrome", () => {
	it("identity — empty rename table produces equivalent tree with empty reverse", () => {
		const chrome = { header: { logo: "/l" }, footer: { phone: "123" } };
		const result = applyRenameToChrome(chrome, indexRenameTable([]));
		expect(result.aligned).toEqual(chrome);
		expect(result.reverseMap).toEqual({});
		expect(result.dedupeNotes).toEqual([]);
		expect(result.conflicts).toEqual([]);
	});

	it("applies a flat rename and records reverse", () => {
		const chrome = { footer: { mobile: "+1 555" } };
		const table: RenameTable = [
			{ from: "footer.mobile", to: "footer.phone", reason: "alias" },
		];
		const result = applyRenameToChrome(chrome, indexRenameTable(table));
		expect(result.aligned).toEqual({ footer: { phone: "+1 555" } });
		expect(result.reverseMap).toEqual({ "footer.phone": "footer.mobile" });
	});

	it("applies a wildcard rename across multiple array indices", () => {
		const chrome = {
			header: {
				nav: [
					{ submenu: [{ href: "/a" }, { href: "/b" }] },
					{ submenu: [{ href: "/c" }] },
				],
			},
		};
		const table: RenameTable = [
			{
				from: "header.nav[*].submenu[*].href",
				to: "header.nav[*].children[*].href",
				reason: "alias",
			},
		];
		const result = applyRenameToChrome(chrome, indexRenameTable(table));
		expect(result.aligned).toEqual({
			header: {
				nav: [
					{ children: [{ href: "/a" }, { href: "/b" }] },
					{ children: [{ href: "/c" }] },
				],
			},
		});
		// Three concrete leaves renamed → three reverse entries.
		expect(Object.keys(result.reverseMap).sort()).toEqual([
			"header.nav[0].children[0].href",
			"header.nav[0].children[1].href",
			"header.nav[1].children[0].href",
		]);
	});

	it("dedupes same-value collision: source and target both present with same value", () => {
		const chrome = {
			footer: { mobile: "+65 123", phone: "+65 123" },
		};
		const table: RenameTable = [
			{ from: "footer.mobile", to: "footer.phone", reason: "alias" },
		];
		const result = applyRenameToChrome(chrome, indexRenameTable(table));
		expect(result.aligned).toEqual({ footer: { phone: "+65 123" } });
		expect(result.dedupeNotes).toEqual([
			{
				canonical: "footer.phone",
				sourcePath: "footer.mobile",
				value: "+65 123",
			},
		]);
		expect(result.conflicts).toEqual([]);
		// Source value was preserved (by coincidence equal); reverseMap empty because canonical already existed.
		expect(result.reverseMap).toEqual({});
	});

	it("records conflict when source and target both present with different values", () => {
		const chrome = {
			footer: { mobile: "+65 111", phone: "+65 222" },
		};
		const table: RenameTable = [
			{ from: "footer.mobile", to: "footer.phone", reason: "alias" },
		];
		const result = applyRenameToChrome(chrome, indexRenameTable(table));
		expect(result.aligned).toEqual({ footer: { phone: "+65 222" } });
		expect(result.conflicts).toEqual([
			{
				canonical: "footer.phone",
				sourcePath: "footer.mobile",
				canonicalValue: "+65 222",
				sourceValue: "+65 111",
				reason: "rename target already present on page with differing value",
			},
		]);
		expect(result.dedupeNotes).toEqual([]);
		expect(result.reverseMap).toEqual({});
	});

	it("leaves untouched leaves at their original paths", () => {
		const chrome = {
			header: { logo: "/l", title: "Acme" },
			footer: { mobile: "+1" },
		};
		const table: RenameTable = [
			{ from: "footer.mobile", to: "footer.phone", reason: "alias" },
		];
		const result = applyRenameToChrome(chrome, indexRenameTable(table));
		expect(result.aligned).toEqual({
			header: { logo: "/l", title: "Acme" },
			footer: { phone: "+1" },
		});
	});
});

describe("verifyRoundTrip", () => {
	it("passes when reverse map entries invert correctly", () => {
		const original = { footer: { mobile: "+1" } };
		const aligned = { footer: { phone: "+1" } };
		const reverseMap = { "footer.phone": "footer.mobile" };
		expect(verifyRoundTrip(original, aligned, reverseMap).ok).toBe(true);
	});

	it("fails when values don't match", () => {
		const original = { footer: { mobile: "+1" } };
		const aligned = { footer: { phone: "+2" } };
		const reverseMap = { "footer.phone": "footer.mobile" };
		const r = verifyRoundTrip(original, aligned, reverseMap);
		expect(r.ok).toBe(false);
		expect(r.mismatches).toHaveLength(1);
	});

	it("round-trips after applyRenameToChrome for clean renames", () => {
		const original = {
			header: {
				nav: [{ submenu: [{ href: "/a" }] }],
				logo: "/logo",
			},
			footer: { mobile: "+1" },
		};
		const table: RenameTable = [
			{
				from: "header.nav[*].submenu[*].href",
				to: "header.nav[*].children[*].href",
				reason: "alias",
			},
			{ from: "footer.mobile", to: "footer.phone", reason: "alias" },
		];
		const result = applyRenameToChrome(original, indexRenameTable(table));
		expect(
			verifyRoundTrip(original, result.aligned, result.reverseMap).ok,
		).toBe(true);
	});
});

describe("buildCompressedChrome", () => {
	it("aggregates per-page aligned chromes by wildcard-generalized path", () => {
		const perPage = {
			page1: { footer: { phone: "+65 111" } },
			page2: { footer: { phone: "+65 111" } },
			page3: { footer: { phone: "+65 222" } },
		};
		const c = buildCompressedChrome(perPage);
		expect(c.paths["footer.phone"]).toBeDefined();
		const entry = c.paths["footer.phone"];
		expect(entry.presentOn).toEqual(["page1", "page2", "page3"]);
		expect(entry.distinctValues).toHaveLength(2);
		const v1 = entry.distinctValues.find((v) => v.value === "+65 111");
		expect(v1?.pageHashes).toEqual(["page1", "page2"]);
		const v2 = entry.distinctValues.find((v) => v.value === "+65 222");
		expect(v2?.pageHashes).toEqual(["page3"]);
	});

	it("collapses array indices so all navs bucket together", () => {
		const perPage = {
			p1: { nav: [{ href: "/a" }, { href: "/b" }] },
			p2: { nav: [{ href: "/c" }] },
		};
		const c = buildCompressedChrome(perPage);
		expect(c.paths["nav[*].href"]).toBeDefined();
		expect(c.paths["nav[*].href"].distinctValues).toHaveLength(3);
	});

	it("reports conflict/dedupe summary in _meta", () => {
		const perPage = { p1: { a: 1 } };
		const c = buildCompressedChrome(perPage, {
			p1: {
				conflicts: [
					{
						canonical: "x",
						sourcePath: "y",
						canonicalValue: 1,
						sourceValue: 2,
						reason: "r",
					},
				],
				dedupes: [],
			},
		});
		expect(c._meta.conflictSummary.pagesWithConflicts).toBe(1);
		expect(c._meta.conflictSummary.pagesWithDedupes).toBe(0);
	});
});

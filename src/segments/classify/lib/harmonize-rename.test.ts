import { describe, expect, it } from "bun:test";
import {
	applyRenameTable,
	assertAppliedCoverage,
	validateRenameTable,
} from "./harmonize-rename.js";
import type { PageTypeDigest, RenameTable } from "./harmonize-types.js";

function digest(
	cands: Array<{ path: string; values: unknown[] }>,
): PageTypeDigest {
	return {
		pagetype: "test",
		totalPages: cands[0]?.values.length ?? 0,
		pageHashes: cands[0]?.values.map((_, i) => `p${i}`) ?? [],
		candidates: cands.map(({ path, values }) => ({
			candidatePath: path,
			distinctValues: values.map((v, i) => ({
				value: v,
				pageHashes: [`p${i}`],
			})),
			presentOn: values.map((_, i) => `p${i}`),
			absentFrom: [],
		})),
	};
}

describe("validateRenameTable", () => {
	it("accepts a valid rename between two observed candidates", () => {
		const d = digest([
			{ path: "header.nav", values: ["x"] },
			{ path: "header.navigation", values: ["x"] },
		]);
		const table: RenameTable = [
			{ from: "header.nav", to: "header.navigation", reason: "alias" },
		];
		expect(validateRenameTable(d, table).valid).toBe(true);
	});

	it("rejects redundant from === to", () => {
		const d = digest([{ path: "header.nav", values: ["x"] }]);
		const result = validateRenameTable(d, [
			{ from: "header.nav", to: "header.nav", reason: "" },
		]);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("from === to");
	});

	it("rejects a from that wasn't observed", () => {
		const d = digest([{ path: "header.nav", values: ["x"] }]);
		const result = validateRenameTable(d, [
			{ from: "header.sidebar", to: "header.nav", reason: "" },
		]);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("not observed");
	});

	it("permits a synthetic terminal to target (post-apply coverage is the safety net)", () => {
		const d = digest([
			{ path: "header.nav", values: ["x"] },
			{ path: "header.navigation", values: ["x"] },
		]);
		const result = validateRenameTable(d, [
			{ from: "header.nav", to: "header.menu", reason: "alias" },
			{ from: "header.navigation", to: "header.menu", reason: "alias" },
		]);
		expect(result.valid).toBe(true);
	});

	it("rejects ambiguous mapping (same from → two different to)", () => {
		const d = digest([
			{ path: "a", values: ["x"] },
			{ path: "b", values: ["x"] },
			{ path: "c", values: ["x"] },
		]);
		const result = validateRenameTable(d, [
			{ from: "a", to: "b", reason: "" },
			{ from: "a", to: "c", reason: "" },
		]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("two different"))).toBe(true);
	});

	it("rejects cycles", () => {
		const d = digest([
			{ path: "a", values: ["x"] },
			{ path: "b", values: ["x"] },
		]);
		const result = validateRenameTable(d, [
			{ from: "a", to: "b", reason: "" },
			{ from: "b", to: "a", reason: "" },
		]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("cycle"))).toBe(true);
	});

	it("rejects prefix-extension renames (scalar fused into a sub-property of itself)", () => {
		// `header.logo` is a scalar on 1 page; `header.logo.src` is a leaf of
		// an object on 7 pages. Fusing the scalar into the sub-property would
		// fabricate a parent on the scalar pages.
		const d = digest([
			{ path: "header.logo", values: ["x"] },
			{ path: "header.logo.src", values: ["x"] },
		]);
		const result = validateRenameTable(d, [
			{ from: "header.logo", to: "header.logo.src", reason: "" },
		]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("prefix-extension"))).toBe(
			true,
		);
	});

	it("rejects prefix-extension renames in the reverse direction (sub-property into ancestor)", () => {
		const d = digest([
			{ path: "header.logo", values: ["x"] },
			{ path: "header.logo.src", values: ["x"] },
		]);
		const result = validateRenameTable(d, [
			{ from: "header.logo.src", to: "header.logo", reason: "" },
		]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("prefix-extension"))).toBe(
			true,
		);
	});

	it("allows renames that share a prefix but are not ancestor/descendant (sibling paths)", () => {
		const d = digest([
			{ path: "header.logo.url", values: ["x"] },
			{ path: "header.logo.src", values: ["x"] },
		]);
		const result = validateRenameTable(d, [
			{ from: "header.logo.url", to: "header.logo.src", reason: "alias" },
		]);
		expect(result.valid).toBe(true);
	});

	it("rejects structurally-incompatible fusions", () => {
		const d = digest([
			{ path: "a", values: ["x"] }, // string
			{ path: "b", values: [{ nested: true }] }, // object
		]);
		const result = validateRenameTable(d, [{ from: "a", to: "b", reason: "" }]);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) => e.includes("structurally-incompatible")),
		).toBe(true);
	});

	it("rejects primitive-array leaf renamed into an object-array sub-property", () => {
		// from=footer.form.fields[*] is a bare string array on one page
		// (["name","email",...]); to=footer.contact_form.fields[*].name is a
		// leaf of an object array on other pages. Collapsing them would fuse
		// bare primitives into a named slot — incoherent post-apply shape.
		const d = digest([
			{ path: "footer.form.fields[*]", values: ["name", "email"] },
			{ path: "footer.contact_form.fields[*].name", values: ["Name", "Email"] },
		]);
		const result = validateRenameTable(d, [
			{
				from: "footer.form.fields[*]",
				to: "footer.contact_form.fields[*].name",
				reason: "",
			},
		]);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) =>
				e.includes("primitive-array leaf into an object-array sub-property"),
			),
		).toBe(true);
	});

	it("accepts a primitive-array-to-primitive-array rename (no object sub-property)", () => {
		// Renaming one primitive array to another primitive array is fine —
		// no `[*].` in the target means we're not navigating into an object.
		const d = digest([
			{ path: "footer.tags[*]", values: ["x"] },
			{ path: "footer.keywords[*]", values: ["x"] },
		]);
		const result = validateRenameTable(d, [
			{ from: "footer.tags[*]", to: "footer.keywords[*]", reason: "alias" },
		]);
		expect(result.valid).toBe(true);
	});

	it("accepts renames from arrays that have observed object children (not primitive)", () => {
		// When X[*] is emitted alongside X[*].name/X[*].href, the array holds
		// objects (or mixed shapes). The primitive-leaf rule must not fire
		// because `from` is not a primitive leaf. This keeps the door open
		// for legitimate subtree merges where both sides are object arrays.
		const d = digest([
			{ path: "footer.items[*]", values: ["x"] }, // emitted as primitive on some pages
			{ path: "footer.items[*].name", values: ["x"] }, // object child observed
			{ path: "footer.contact.fields[*].name", values: ["x"] },
		]);
		const result = validateRenameTable(d, [
			{
				from: "footer.items[*]",
				to: "footer.contact.fields[*].name",
				reason: "",
			},
		]);
		// Structurally-incompatible fusion may still fire for shape reasons;
		// we only want to confirm the primitive-leaf rule does NOT.
		expect(
			result.errors.some((e) =>
				e.includes("primitive-array leaf into an object-array sub-property"),
			),
		).toBe(false);
	});

	it("accepts renames when from=X[*] has object-valued elements (not primitives)", () => {
		// If X[*] holds object values directly (rare but possible), the
		// primitive-leaf rule must not fire even when `to` contains `[*].`.
		// Shape-fusion is the correct mechanism to catch object/object
		// incompatibilities.
		const d = digest([
			{ path: "footer.items[*]", values: [{ name: "a" }] },
			{ path: "footer.other[*].name", values: ["b"] },
		]);
		const result = validateRenameTable(d, [
			{ from: "footer.items[*]", to: "footer.other[*].name", reason: "" },
		]);
		expect(
			result.errors.some((e) =>
				e.includes("primitive-array leaf into an object-array sub-property"),
			),
		).toBe(false);
	});

	it("rejects a subtree-style expansion into a fresh namespace (every target synthetic, one source each)", () => {
		// Documents the intentional behavior: a subtree op `X → Y` that
		// hoists items into a namespace with NO observed candidates produces
		// N expanded flat entries, each a single-source → synthetic rename.
		// The synthetic-target rule rejects them all. Real alignments must
		// either target observed canonicals or fold ≥2 aliases together.
		const d = digest([
			{ path: "footer.legal.copyright", values: ["x"] },
			{ path: "footer.legal.privacy", values: ["y"] },
		]);
		const result = validateRenameTable(d, [
			{ from: "footer.legal.copyright", to: "footer.copyright", reason: "" },
			{ from: "footer.legal.privacy", to: "footer.privacy", reason: "" },
		]);
		expect(result.valid).toBe(false);
		expect(result.errors.filter((e) => e.includes("synthetic")).length).toBe(2);
	});

	it("rejects a synthetic terminal target reached by only one source", () => {
		const d = digest([
			{ path: "footer.social_media[*].handle", values: ["@foo"] },
			{ path: "footer.social_links[*].href", values: ["http://x"] },
		]);
		const result = validateRenameTable(d, [
			{
				from: "footer.social_media[*].handle",
				to: "footer.social_links[*].handle",
				reason: "",
			},
		]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("synthetic"))).toBe(true);
	});

	it("accepts a synthetic terminal when ≥2 sources reach it through a chain", () => {
		// a → b (observed) → synthetic_c: both a and b count as sources
		// reaching synthetic_c, clearing the ≥2 bar without requiring the
		// agent to list three direct flat ops.
		const d = digest([
			{ path: "header.a", values: ["x"] },
			{ path: "header.b", values: ["x"] },
		]);
		const result = validateRenameTable(d, [
			{ from: "header.a", to: "header.b", reason: "" },
			{ from: "header.b", to: "header.menu", reason: "" },
		]);
		expect(result.valid).toBe(true);
	});

	it("accepts a synthetic terminal reached by ≥2 direct sources", () => {
		const d = digest([
			{ path: "header.nav", values: ["x"] },
			{ path: "header.navigation", values: ["x"] },
			{ path: "header.nav_items", values: ["x"] },
		]);
		const result = validateRenameTable(d, [
			{ from: "header.nav", to: "header.menu", reason: "" },
			{ from: "header.navigation", to: "header.menu", reason: "" },
			{ from: "header.nav_items", to: "header.menu", reason: "" },
		]);
		expect(result.valid).toBe(true);
	});
});

describe("applyRenameTable", () => {
	it("folds aliased candidates into one, merging distinct values", () => {
		const d = digest([
			{ path: "header.nav", values: ["home"] },
			{ path: "header.navigation", values: ["home"] },
		]);
		const result = applyRenameTable(d, [
			{ from: "header.nav", to: "header.navigation", reason: "" },
		]);
		expect(result.candidates.length).toBe(1);
		expect(result.candidates[0].candidatePath).toBe("header.navigation");
		expect(result.candidates[0].distinctValues[0].pageHashes.length).toBe(2);
	});

	it("preserves unrenamed candidates", () => {
		const d = digest([
			{ path: "a", values: ["x"] },
			{ path: "b", values: ["y"] },
		]);
		const result = applyRenameTable(d, []);
		expect(result.candidates.map((c) => c.candidatePath).sort()).toEqual([
			"a",
			"b",
		]);
	});

	it("chases multi-hop renames (a → b → c)", () => {
		const d = digest([
			{ path: "a", values: ["x"] },
			{ path: "b", values: ["x"] },
			{ path: "c", values: ["x"] },
		]);
		const result = applyRenameTable(d, [
			{ from: "a", to: "b", reason: "" },
			{ from: "b", to: "c", reason: "" },
		]);
		expect(result.candidates.length).toBe(1);
		expect(result.candidates[0].candidatePath).toBe("c");
		expect(result.candidates[0].distinctValues[0].pageHashes.length).toBe(3);
	});

	it("folds divergent variants into a synthetic canonical name", () => {
		const d: PageTypeDigest = {
			pagetype: "t",
			totalPages: 3,
			pageHashes: ["p0", "p1", "p2"],
			candidates: [
				{
					candidatePath: "header.nav[1].href",
					distinctValues: [{ value: "/about/", pageHashes: ["p0"] }],
					presentOn: ["p0"],
					absentFrom: ["p1", "p2"],
				},
				{
					candidatePath: "header.nav_items[1].href",
					distinctValues: [{ value: "/about/", pageHashes: ["p1"] }],
					presentOn: ["p1"],
					absentFrom: ["p0", "p2"],
				},
				{
					candidatePath: "header.navigation[1].href",
					distinctValues: [{ value: "/about/", pageHashes: ["p2"] }],
					presentOn: ["p2"],
					absentFrom: ["p0", "p1"],
				},
			],
		};
		const result = applyRenameTable(d, [
			{ from: "header.nav[1].href", to: "header.menu[1].href", reason: "" },
			{
				from: "header.nav_items[1].href",
				to: "header.menu[1].href",
				reason: "",
			},
			{
				from: "header.navigation[1].href",
				to: "header.menu[1].href",
				reason: "",
			},
		]);
		expect(result.candidates.length).toBe(1);
		expect(result.candidates[0].candidatePath).toBe("header.menu[1].href");
		expect(result.candidates[0].presentOn).toEqual(["p0", "p1", "p2"]);
	});
});

describe("assertAppliedCoverage", () => {
	it("passes when applied digest faithfully reflects the rename chain", () => {
		const d = digest([
			{ path: "a", values: ["x"] },
			{ path: "b", values: ["x"] },
		]);
		const table: RenameTable = [{ from: "a", to: "c", reason: "" }];
		const applied = applyRenameTable(d, table);
		const result = assertAppliedCoverage(d, table, applied);
		expect(result.valid).toBe(true);
	});

	it("passes when folding variants onto a synthetic canonical", () => {
		const d = digest([
			{ path: "header.nav", values: ["home"] },
			{ path: "header.navigation", values: ["home"] },
		]);
		const table: RenameTable = [
			{ from: "header.nav", to: "header.menu", reason: "" },
			{ from: "header.navigation", to: "header.menu", reason: "" },
		];
		const applied = applyRenameTable(d, table);
		const result = assertAppliedCoverage(d, table, applied);
		expect(result.valid).toBe(true);
	});

	it("flags missing buckets (applied digest lost a candidate)", () => {
		const d = digest([
			{ path: "a", values: ["x"] },
			{ path: "b", values: ["x"] },
		]);
		const applied: PageTypeDigest = {
			pagetype: d.pagetype,
			totalPages: d.totalPages,
			pageHashes: d.pageHashes,
			candidates: d.candidates.filter((c) => c.candidatePath === "a"),
		};
		const result = assertAppliedCoverage(d, [], applied);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes('missing bucket "b"'))).toBe(
			true,
		);
	});

	it("flags unexpected buckets (applied digest manufactured a new path)", () => {
		const d = digest([{ path: "a", values: ["x"] }]);
		const applied: PageTypeDigest = {
			pagetype: d.pagetype,
			totalPages: d.totalPages,
			pageHashes: d.pageHashes,
			candidates: [
				...d.candidates,
				{
					candidatePath: "ghost",
					distinctValues: [{ value: "y", pageHashes: ["p0"] }],
					presentOn: ["p0"],
					absentFrom: [],
				},
			],
		};
		const result = assertAppliedCoverage(d, [], applied);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) => e.includes('unexpected bucket "ghost"')),
		).toBe(true);
	});
});

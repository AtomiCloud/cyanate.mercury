import { describe, expect, it } from "bun:test";
import {
	buildPageTypeDigest,
	stableValueHash,
} from "./harmonize-occurrence.js";

describe("stableValueHash", () => {
	it("returns identical hashes for semantically identical values regardless of key order", () => {
		expect(stableValueHash({ a: 1, b: 2 })).toBe(
			stableValueHash({ b: 2, a: 1 }),
		);
	});

	it("hashes null as distinct from undefined-like values", () => {
		expect(stableValueHash(null)).not.toBe(stableValueHash("null"));
	});
});

describe("buildPageTypeDigest — candidate collapse + grouping", () => {
	it("groups candidates by suggestedCanonical ?? sourcePath", () => {
		const { digest } = buildPageTypeDigest({
			pagetype: "about",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: { header: { nav: "x" } },
					chromePaths: [
						{
							sourcePath: "header.nav",
							suggestedCanonical: "header.navigation",
						},
					],
				},
				{
					hash: "p2",
					url: "/b",
					content: { header: { navigation: "x" } },
					chromePaths: [{ sourcePath: "header.navigation" }],
				},
			],
		});

		expect(digest.candidates.map((c) => c.candidatePath)).toEqual([
			"header.navigation",
		]);
	});

	it("collapses positional [N] indices to [*]", () => {
		const { digest } = buildPageTypeDigest({
			pagetype: "post",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: {
						share_buttons: [{ label: "Twitter" }, { label: "Facebook" }],
					},
					chromePaths: [
						{ sourcePath: "share_buttons[0].label" },
						{ sourcePath: "share_buttons[1].label" },
					],
				},
				{
					hash: "p2",
					url: "/b",
					content: {
						share_buttons: [
							{ label: "Facebook" },
							{ label: "Twitter" },
							{ label: "Copy Link" },
						],
					},
					chromePaths: [
						{ sourcePath: "share_buttons[0].label" },
						{ sourcePath: "share_buttons[1].label" },
						{ sourcePath: "share_buttons[2].label" },
					],
				},
			],
		});

		expect(digest.candidates.map((c) => c.candidatePath)).toEqual([
			"share_buttons[*].label",
		]);
		const cand = digest.candidates[0];
		expect(cand.distinctValues.map((d) => d.value).sort()).toEqual([
			"Copy Link",
			"Facebook",
			"Twitter",
		]);
		expect(cand.presentOn).toEqual(["p1", "p2"]);
	});

	it("collapses every index in nested array paths", () => {
		const { digest } = buildPageTypeDigest({
			pagetype: "about",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: { nav: [{ items: [{ href: "/a/" }] }] },
					chromePaths: [{ sourcePath: "nav[0].items[0].href" }],
				},
			],
		});
		expect(digest.candidates[0].candidatePath).toEqual("nav[*].items[*].href");
	});

	it("records absentFrom for pages missing a candidate", () => {
		const { digest } = buildPageTypeDigest({
			pagetype: "team",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: { footer: { copyright: "© 2025" } },
					chromePaths: [{ sourcePath: "footer.copyright" }],
				},
				{
					hash: "p2",
					url: "/b",
					content: {},
					chromePaths: [],
				},
				{
					hash: "p3",
					url: "/c",
					content: { footer: { copyright: "© 2025" } },
					chromePaths: [{ sourcePath: "footer.copyright" }],
				},
			],
		});

		const cand = digest.candidates.find(
			(c) => c.candidatePath === "footer.copyright",
		);
		expect(cand).toBeDefined();
		expect(cand?.presentOn).toEqual(["p1", "p3"]);
		expect(cand?.absentFrom).toEqual(["p2"]);
	});

	it("treats null as a valid distinct value (not merged with missing)", () => {
		const { digest } = buildPageTypeDigest({
			pagetype: "team",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: { header: { nav: [{ href: null }] } },
					chromePaths: [{ sourcePath: "header.nav[0].href" }],
				},
				{
					hash: "p2",
					url: "/b",
					content: { header: { nav: [{ href: "/home/" }] } },
					chromePaths: [{ sourcePath: "header.nav[0].href" }],
				},
			],
		});
		const cand = digest.candidates[0];
		const vals = cand.distinctValues
			.map((d) => d.value)
			.sort((a, b) => {
				const ka = a === null ? "\u0000" : String(a);
				const kb = b === null ? "\u0000" : String(b);
				return ka < kb ? -1 : ka > kb ? 1 : 0;
			});
		expect(vals).toEqual([null, "/home/"]);
	});

	it("emits occurrence rows with collapsed candidate path and original sourcePath", () => {
		const { occurrenceTable } = buildPageTypeDigest({
			pagetype: "post",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: {
						share_buttons: [{ label: "Twitter" }, { label: "Facebook" }],
					},
					chromePaths: [
						{ sourcePath: "share_buttons[0].label" },
						{ sourcePath: "share_buttons[1].label" },
					],
				},
			],
		});
		expect(occurrenceTable.rows).toHaveLength(2);
		for (const row of occurrenceTable.rows) {
			expect(row.candidatePath).toBe("share_buttons[*].label");
			expect(row.pageHash).toBe("p1");
		}
		expect(occurrenceTable.rows.map((r) => r.sourcePath).sort()).toEqual([
			"share_buttons[0].label",
			"share_buttons[1].label",
		]);
	});

	it("sorts distinct values by descending occurrence count", () => {
		const { digest } = buildPageTypeDigest({
			pagetype: "landing",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: { foo: "A" },
					chromePaths: [{ sourcePath: "foo" }],
				},
				{
					hash: "p2",
					url: "/b",
					content: { foo: "A" },
					chromePaths: [{ sourcePath: "foo" }],
				},
				{
					hash: "p3",
					url: "/c",
					content: { foo: "B" },
					chromePaths: [{ sourcePath: "foo" }],
				},
			],
		});
		const cand = digest.candidates[0];
		expect(cand.distinctValues[0]?.value).toBe("A");
		expect(cand.distinctValues[0]?.pageHashes.length).toBe(2);
		expect(cand.distinctValues[1]?.value).toBe("B");
	});
});

describe("buildPageTypeDigest — structural signals", () => {
	it("marks scalar candidates as non-array with no extra metadata", () => {
		const { signals } = buildPageTypeDigest({
			pagetype: "about",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: { footer: { copyright: "©" } },
					chromePaths: [{ sourcePath: "footer.copyright" }],
				},
			],
		});
		expect(signals.perCandidate["footer.copyright"]).toEqual({
			isArray: false,
		});
	});

	it("emits perPageSequences preserving within-page slot order for primitive arrays", () => {
		const { signals } = buildPageTypeDigest({
			pagetype: "post",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: { tags: ["react", "typescript"] },
					chromePaths: [{ sourcePath: "tags[0]" }, { sourcePath: "tags[1]" }],
				},
				{
					hash: "p2",
					url: "/b",
					content: { tags: ["typescript", "react", "bun"] },
					chromePaths: [
						{ sourcePath: "tags[0]" },
						{ sourcePath: "tags[1]" },
						{ sourcePath: "tags[2]" },
					],
				},
			],
		});
		const s = signals.perCandidate["tags[*]"];
		expect(s.isArray).toBe(true);
		expect(s.elementShape).toBe("primitive");
		expect(s.perPageSequences).toEqual({
			p1: ["react", "typescript"],
			p2: ["typescript", "react", "bun"],
		});
		expect(s.childKeys).toBeUndefined();
	});

	it("reports object element shape and union of childKeys", () => {
		const { signals } = buildPageTypeDigest({
			pagetype: "post",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: {
						share_buttons: [
							{ label: "Twitter", url: "/t" },
							{ label: "Facebook", url: "/f" },
						],
					},
					chromePaths: [
						{ sourcePath: "share_buttons[0]" },
						{ sourcePath: "share_buttons[1]" },
					],
				},
				{
					hash: "p2",
					url: "/b",
					content: {
						share_buttons: [{ label: "Twitter", url: "/t", icon: "tw" }],
					},
					chromePaths: [{ sourcePath: "share_buttons[0]" }],
				},
			],
		});
		const s = signals.perCandidate["share_buttons[*]"];
		expect(s.isArray).toBe(true);
		expect(s.elementShape).toBe("object");
		expect(s.childKeys).toEqual(["icon", "label", "url"]);
	});

	it("marks mixed-shape arrays as 'mixed'", () => {
		const { signals } = buildPageTypeDigest({
			pagetype: "post",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: { items: ["raw", { label: "rich" }] },
					chromePaths: [{ sourcePath: "items[0]" }, { sourcePath: "items[1]" }],
				},
			],
		});
		expect(signals.perCandidate["items[*]"].elementShape).toBe("mixed");
	});

	it("collects pairwiseOrderConstraints for primitive arrays, deduped across pages", () => {
		const { signals } = buildPageTypeDigest({
			pagetype: "post",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: { tags: ["a", "b", "c"] },
					chromePaths: [
						{ sourcePath: "tags[0]" },
						{ sourcePath: "tags[1]" },
						{ sourcePath: "tags[2]" },
					],
				},
				{
					hash: "p2",
					url: "/b",
					content: { tags: ["a", "b"] },
					chromePaths: [{ sourcePath: "tags[0]" }, { sourcePath: "tags[1]" }],
				},
			],
		});
		const pairs = signals.perCandidate["tags[*]"].pairwiseOrderConstraints;
		expect(pairs).toBeDefined();
		// From p1: (a,b) (a,c) (b,c); from p2: (a,b) dup. Expect 3 unique pairs.
		expect(pairs?.length).toBe(3);
		const asStrings = pairs?.map((p) => `${p[0]}→${p[1]}`).sort();
		expect(asStrings).toEqual(["a→b", "a→c", "b→c"]);
	});

	it("omits pairwiseOrderConstraints for object-element arrays", () => {
		const { signals } = buildPageTypeDigest({
			pagetype: "post",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: { share: [{ label: "T" }, { label: "F" }] },
					chromePaths: [{ sourcePath: "share[0]" }, { sourcePath: "share[1]" }],
				},
			],
		});
		expect(
			signals.perCandidate["share[*]"].pairwiseOrderConstraints,
		).toBeUndefined();
	});

	it("reports elementSetJaccard = 1.0 when every page has the same element set", () => {
		const { signals } = buildPageTypeDigest({
			pagetype: "post",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: { share: ["Twitter", "Facebook"] },
					chromePaths: [{ sourcePath: "share[0]" }, { sourcePath: "share[1]" }],
				},
				{
					hash: "p2",
					url: "/b",
					content: { share: ["Facebook", "Twitter"] },
					chromePaths: [{ sourcePath: "share[0]" }, { sourcePath: "share[1]" }],
				},
			],
		});
		expect(signals.perCandidate["share[*]"].elementSetJaccard).toBe(1);
	});

	it("reports fractional elementSetJaccard for partial overlap", () => {
		const { signals } = buildPageTypeDigest({
			pagetype: "post",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: { tags: ["a", "b"] },
					chromePaths: [{ sourcePath: "tags[0]" }, { sourcePath: "tags[1]" }],
				},
				{
					hash: "p2",
					url: "/b",
					content: { tags: ["b", "c"] },
					chromePaths: [{ sourcePath: "tags[0]" }, { sourcePath: "tags[1]" }],
				},
			],
		});
		// |{a,b} ∩ {b,c}| / |{a,b,c}| = 1/3
		expect(signals.perCandidate["tags[*]"].elementSetJaccard).toBeCloseTo(
			1 / 3,
			10,
		);
	});

	it("omits elementSetJaccard for single-page pagetypes", () => {
		const { signals } = buildPageTypeDigest({
			pagetype: "post",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: { tags: ["a"] },
					chromePaths: [{ sourcePath: "tags[0]" }],
				},
			],
		});
		expect(signals.perCandidate["tags[*]"].elementSetJaccard).toBeUndefined();
	});

	it("reports childKeyUniformity = 1.0 when every object element has the same keys", () => {
		const { signals } = buildPageTypeDigest({
			pagetype: "post",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: {
						share: [
							{ label: "T", url: "/t" },
							{ label: "F", url: "/f" },
						],
					},
					chromePaths: [{ sourcePath: "share[0]" }, { sourcePath: "share[1]" }],
				},
			],
		});
		expect(signals.perCandidate["share[*]"].childKeyUniformity).toBe(1);
	});

	it("reports fractional childKeyUniformity when element shapes differ", () => {
		const { signals } = buildPageTypeDigest({
			pagetype: "post",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: {
						share: [
							{ label: "T", url: "/t" },
							{ label: "F", url: "/f" },
							{ label: "X", url: "/x", icon: "ic" },
						],
					},
					chromePaths: [
						{ sourcePath: "share[0]" },
						{ sourcePath: "share[1]" },
						{ sourcePath: "share[2]" },
					],
				},
			],
		});
		// 2 of 3 share {label,url}; modal / total = 2/3
		expect(signals.perCandidate["share[*]"].childKeyUniformity).toBeCloseTo(
			2 / 3,
			10,
		);
	});

	it("omits childKeyUniformity for primitive arrays", () => {
		const { signals } = buildPageTypeDigest({
			pagetype: "post",
			pages: [
				{
					hash: "p1",
					url: "/a",
					content: { tags: ["a", "b"] },
					chromePaths: [{ sourcePath: "tags[0]" }, { sourcePath: "tags[1]" }],
				},
			],
		});
		expect(signals.perCandidate["tags[*]"].childKeyUniformity).toBeUndefined();
	});
});

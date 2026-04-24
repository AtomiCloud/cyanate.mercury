import { describe, expect, it } from "bun:test";
import { compileRichOps, validateRichRenameOps } from "./harmonize-rich-ops.js";
import type {
	PageTypeDigest,
	RichRenameOp,
	StructuralSignals,
} from "./harmonize-types.js";

function digestOf(paths: string[]): PageTypeDigest {
	return {
		pagetype: "t",
		totalPages: 1,
		pageHashes: ["p1"],
		candidates: paths.map((path) => ({
			candidatePath: path,
			distinctValues: [{ value: "x", pageHashes: ["p1"] }],
			presentOn: ["p1"],
			absentFrom: [],
		})),
	};
}

describe("validateRichRenameOps — flat", () => {
	it("accepts a flat op whose from is observed", () => {
		const d = digestOf(["a", "b"]);
		const ops: RichRenameOp[] = [
			{ kind: "flat", from: "a", to: "b", reason: "" },
		];
		expect(validateRichRenameOps({ digest: d, ops }).valid).toBe(true);
	});

	it("rejects a flat op with unobserved from", () => {
		const d = digestOf(["a"]);
		const ops: RichRenameOp[] = [
			{ kind: "flat", from: "ghost", to: "a", reason: "" },
		];
		const r = validateRichRenameOps({ digest: d, ops });
		expect(r.valid).toBe(false);
		expect(r.errors[0]).toContain("not an observed candidate");
	});

	it("rejects a flat op whose from and to have mismatched wildcard counts (scalar → array)", () => {
		const d = digestOf([
			"cta_section.button_href",
			"cta_section.links[*].href",
		]);
		const ops: RichRenameOp[] = [
			{
				kind: "flat",
				from: "cta_section.button_href",
				to: "cta_section.links[*].href",
				reason: "same value",
			},
		];
		const r = validateRichRenameOps({ digest: d, ops });
		expect(r.valid).toBe(false);
		expect(r.errors[0]).toContain("wildcard-count mismatch");
	});

	it("rejects a flat op whose from and to have mismatched wildcard counts (array → scalar)", () => {
		const d = digestOf(["cards[*].headline", "hero.headline"]);
		const ops: RichRenameOp[] = [
			{
				kind: "flat",
				from: "cards[*].headline",
				to: "hero.headline",
				reason: "",
			},
		];
		const r = validateRichRenameOps({ digest: d, ops });
		expect(r.valid).toBe(false);
		expect(r.errors[0]).toContain("wildcard-count mismatch");
	});
});

describe("validateRichRenameOps — subtree", () => {
	it("accepts a subtree op that matches at least one candidate", () => {
		const d = digestOf([
			"footer.legal.copyright",
			"footer.legal.privacy",
			"footer.social.twitter",
		]);
		const ops: RichRenameOp[] = [
			{
				kind: "subtree",
				fromPrefix: "footer.legal",
				toPrefix: "footer",
				reason: "flatten",
			},
		];
		expect(validateRichRenameOps({ digest: d, ops }).valid).toBe(true);
	});

	it("rejects a subtree op that matches no candidates", () => {
		const d = digestOf(["header.nav", "footer.copyright"]);
		const ops: RichRenameOp[] = [
			{
				kind: "subtree",
				fromPrefix: "sidebar",
				toPrefix: "aside",
				reason: "",
			},
		];
		const r = validateRichRenameOps({ digest: d, ops });
		expect(r.valid).toBe(false);
		expect(r.errors[0]).toContain("matches no candidate paths");
	});

	it("accepts a subtree op whose rewrite lands on an existing candidate (merge)", () => {
		// This is the alias-merge case the phase is built for:
		// `footer.legal.*` and `footer.*` are parallel families observed on
		// different pages; the rewrite MERGES them. The compiled flat row
		// behaves identically to an explicit flat op.
		const d = digestOf([
			"footer.legal.copyright",
			"footer.copyright", // already exists at the destination
		]);
		const ops: RichRenameOp[] = [
			{
				kind: "subtree",
				fromPrefix: "footer.legal",
				toPrefix: "footer",
				reason: "merge legal.* into parent footer.*",
			},
		];
		const r = validateRichRenameOps({ digest: d, ops });
		expect(r.valid).toBe(true);
		const { flat } = compileRichOps(d, ops);
		expect(flat.map((e) => `${e.from}→${e.to}`)).toEqual([
			"footer.legal.copyright→footer.copyright",
		]);
	});

	it("accepts trailing-dot or trailing-.* prefix forms as equivalent", () => {
		const d = digestOf(["footer.legal.copyright"]);
		const variants: Array<[string, string]> = [
			["footer.legal", "footer"],
			["footer.legal.", "footer."],
			["footer.legal.*", "footer.*"],
		];
		for (const [from, to] of variants) {
			const ops: RichRenameOp[] = [
				{ kind: "subtree", fromPrefix: from, toPrefix: to, reason: "" },
			];
			expect(validateRichRenameOps({ digest: d, ops }).valid).toBe(true);
		}
	});

	it("accepts a subtree prefix that extends into an array via [*]", () => {
		// This is the real-world pattern from team_member — leaves use `[*]`
		// right after the collection node, so the prefix must be allowed to
		// extend via `[` as well as `.`.
		const d = digestOf([
			"header.nav[*].children[*].href",
			"header.nav[*].children[*].label",
		]);
		const ops: RichRenameOp[] = [
			{
				kind: "subtree",
				fromPrefix: "header.nav[*].children[*]",
				toPrefix: "header.navigation[*].children[*]",
				reason: "",
			},
		];
		const r = validateRichRenameOps({ digest: d, ops });
		expect(r.valid).toBe(true);
		const { flat } = compileRichOps(d, ops);
		expect(flat.map((e) => `${e.from}→${e.to}`).sort()).toEqual([
			"header.nav[*].children[*].href→header.navigation[*].children[*].href",
			"header.nav[*].children[*].label→header.navigation[*].children[*].label",
		]);
	});

	it("accepts a subtree prefix that is the array node itself (extends via [)", () => {
		const d = digestOf(["footer.awards[*].name", "footer.awards[*].url"]);
		const ops: RichRenameOp[] = [
			{
				kind: "subtree",
				fromPrefix: "footer.awards",
				toPrefix: "footer.accolades",
				reason: "",
			},
		];
		const r = validateRichRenameOps({ digest: d, ops });
		expect(r.valid).toBe(true);
		const { flat } = compileRichOps(d, ops);
		expect(flat.map((e) => `${e.from}→${e.to}`).sort()).toEqual([
			"footer.awards[*].name→footer.accolades[*].name",
			"footer.awards[*].url→footer.accolades[*].url",
		]);
	});
});

describe("validateRichRenameOps — element-key", () => {
	it("accepts an element-key op against an object-array candidate with signals", () => {
		const d = digestOf(["share_buttons[*]"]);
		const signals: StructuralSignals = {
			pagetype: "t",
			perCandidate: {
				"share_buttons[*]": {
					isArray: true,
					elementShape: "object",
					childKeys: ["label", "url"],
					perPageSequences: {
						p1: [
							{ label: "Share on Twitter", url: "/t" },
							{ label: "Share on FB", url: "/f" },
						],
					},
				},
			},
		};
		const ops: RichRenameOp[] = [
			{
				kind: "element-key",
				arrayPath: "share_buttons[*]",
				identifyBy: "label",
				renames: {
					"Share on Twitter": "Twitter",
					"Share on FB": "Facebook",
				},
				reason: "canonicalize",
			},
		];
		expect(validateRichRenameOps({ digest: d, signals, ops }).valid).toBe(true);
	});

	it("rejects element-key on a non-array candidate", () => {
		const d = digestOf(["header.title"]);
		const ops: RichRenameOp[] = [
			{
				kind: "element-key",
				arrayPath: "header.title",
				identifyBy: "label",
				renames: { x: "y" },
				reason: "",
			},
		];
		const r = validateRichRenameOps({ digest: d, ops });
		expect(r.valid).toBe(false);
		expect(r.errors[0]).toContain("not an array path");
	});

	it("rejects element-key when identifyBy is not an observed key", () => {
		const d = digestOf(["share[*]"]);
		const signals: StructuralSignals = {
			pagetype: "t",
			perCandidate: {
				"share[*]": {
					isArray: true,
					elementShape: "object",
					childKeys: ["label", "url"],
					perPageSequences: {},
				},
			},
		};
		const ops: RichRenameOp[] = [
			{
				kind: "element-key",
				arrayPath: "share[*]",
				identifyBy: "name",
				renames: { a: "b" },
				reason: "",
			},
		];
		const r = validateRichRenameOps({ digest: d, signals, ops });
		expect(r.valid).toBe(false);
		expect(r.errors.some((e) => e.includes("not an observed key"))).toBe(true);
	});

	it("accepts element-key on an object-array whose leaves are candidates (no direct array candidate)", () => {
		// Real-world case from the service pagetype — the digest only emits
		// leaf candidates like `footer.contact_form.fields[*].name`, not the
		// array node itself. Element-key has to reach it via the leaves.
		const d = digestOf([
			"footer.contact_form.fields[*].name",
			"footer.contact_form.fields[*].type",
			"footer.contact_form.fields[*].placeholder",
		]);
		const ops: RichRenameOp[] = [
			{
				kind: "element-key",
				arrayPath: "footer.contact_form.fields[*]",
				identifyBy: "name",
				renames: { Subject: "subject", Email: "email" },
				reason: "canonicalize field names",
			},
		];
		const r = validateRichRenameOps({ digest: d, ops });
		expect(r.valid).toBe(true);
	});

	it("rejects element-key whose identifyBy is not an observed leaf key", () => {
		const d = digestOf([
			"footer.contact_form.fields[*].name",
			"footer.contact_form.fields[*].type",
		]);
		const ops: RichRenameOp[] = [
			{
				kind: "element-key",
				arrayPath: "footer.contact_form.fields[*]",
				identifyBy: "label",
				renames: { a: "b" },
				reason: "",
			},
		];
		const r = validateRichRenameOps({ digest: d, ops });
		expect(r.valid).toBe(false);
		expect(r.errors.some((e) => e.includes("not an observed key"))).toBe(true);
	});

	it("rejects element-key when a rename key wasn't observed", () => {
		const d = digestOf(["share[*]"]);
		const signals: StructuralSignals = {
			pagetype: "t",
			perCandidate: {
				"share[*]": {
					isArray: true,
					elementShape: "object",
					childKeys: ["label"],
					perPageSequences: { p1: [{ label: "Twitter" }] },
				},
			},
		};
		const ops: RichRenameOp[] = [
			{
				kind: "element-key",
				arrayPath: "share[*]",
				identifyBy: "label",
				renames: { "Share on Pinterest": "Pinterest" },
				reason: "",
			},
		];
		const r = validateRichRenameOps({ digest: d, signals, ops });
		expect(r.valid).toBe(false);
		expect(r.errors.some((e) => e.includes("was not observed"))).toBe(true);
	});

	it("rejects element-key with an empty rename map", () => {
		const d = digestOf(["share[*]"]);
		const signals: StructuralSignals = {
			pagetype: "t",
			perCandidate: {
				"share[*]": {
					isArray: true,
					elementShape: "object",
					childKeys: ["label"],
				},
			},
		};
		const ops: RichRenameOp[] = [
			{
				kind: "element-key",
				arrayPath: "share[*]",
				identifyBy: "label",
				renames: {},
				reason: "",
			},
		];
		const r = validateRichRenameOps({ digest: d, signals, ops });
		expect(r.valid).toBe(false);
		expect(r.errors.some((e) => e.includes("nothing to do"))).toBe(true);
	});
});

describe("compileRichOps", () => {
	it("passes flat ops through unchanged", () => {
		const d = digestOf(["a", "b"]);
		const { flat, elementKey } = compileRichOps(d, [
			{ kind: "flat", from: "a", to: "b", reason: "alias" },
		]);
		expect(flat).toEqual([{ from: "a", to: "b", reason: "alias" }]);
		expect(elementKey).toEqual([]);
	});

	it("expands a subtree op to N flat renames", () => {
		const d = digestOf([
			"footer.legal.copyright",
			"footer.legal.privacy",
			"footer.social.twitter",
		]);
		const { flat } = compileRichOps(d, [
			{
				kind: "subtree",
				fromPrefix: "footer.legal",
				toPrefix: "footer",
				reason: "flatten",
			},
		]);
		expect(flat.map((e) => `${e.from}→${e.to}`).sort()).toEqual([
			"footer.legal.copyright→footer.copyright",
			"footer.legal.privacy→footer.privacy",
		]);
	});

	it("collects element-key ops into the sidecar (not the flat table)", () => {
		const d = digestOf(["share[*]"]);
		const { flat, elementKey } = compileRichOps(d, [
			{
				kind: "element-key",
				arrayPath: "share[*]",
				identifyBy: "label",
				renames: { "Share on Twitter": "Twitter" },
				reason: "canonicalize",
			},
		]);
		expect(flat).toEqual([]);
		expect(elementKey.length).toBe(1);
		expect(elementKey[0].arrayPath).toBe("share[*]");
		expect(elementKey[0].renames).toEqual({ "Share on Twitter": "Twitter" });
	});

	it("dedupes (from, to) pairs when a subtree expansion overlaps an explicit flat op", () => {
		const d = digestOf(["footer.legal.copyright", "footer.legal.privacy"]);
		const { flat } = compileRichOps(d, [
			{
				kind: "subtree",
				fromPrefix: "footer.legal",
				toPrefix: "footer",
				reason: "flatten",
			},
			{
				kind: "flat",
				from: "footer.legal.copyright",
				to: "footer.copyright",
				reason: "explicit",
			},
		]);
		const pairs = flat.map((e) => `${e.from}→${e.to}`).sort();
		expect(pairs).toEqual([
			"footer.legal.copyright→footer.copyright",
			"footer.legal.privacy→footer.privacy",
		]);
	});
});

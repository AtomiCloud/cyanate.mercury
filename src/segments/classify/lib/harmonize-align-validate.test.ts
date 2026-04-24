import { describe, expect, it } from "bun:test";
import { validateAlignOps } from "./harmonize-align-validate.js";
import type { PageTypeDigest, RichRenameOp } from "./harmonize-types.js";

function digestOf(paths: string[]): PageTypeDigest {
	return {
		pagetype: "t",
		totalPages: 1,
		pageHashes: ["p1"],
		candidates: paths.map((path) => ({
			candidatePath: path,
			distinctValues: [{ value: "v", pageHashes: ["p1"] }],
			presentOn: ["p1"],
			absentFrom: [],
		})),
	};
}

describe("validateAlignOps", () => {
	it("empty ops → valid with empty flat and digest unchanged", () => {
		const d = digestOf(["a", "b"]);
		const r = validateAlignOps(d, undefined, []);
		expect(r.valid).toBe(true);
		if (!r.valid) return;
		expect(r.flat).toEqual([]);
		expect(r.elementKey).toEqual([]);
		expect(r.postDigest).toBe(d);
	});

	it("valid flat op → returns flat + postDigest", () => {
		const d = digestOf(["nav", "navigation"]);
		const ops: RichRenameOp[] = [
			{ kind: "flat", from: "nav", to: "navigation", reason: "" },
		];
		const r = validateAlignOps(d, undefined, ops);
		expect(r.valid).toBe(true);
		if (!r.valid) return;
		expect(r.flat).toHaveLength(1);
		expect(r.flat[0]).toEqual({ from: "nav", to: "navigation", reason: "" });
		expect(r.postDigest.candidates.map((c) => c.candidatePath)).toEqual([
			"navigation",
		]);
	});

	it("unobserved flat.from → fails with rich-validator tag", () => {
		const d = digestOf(["a"]);
		const ops: RichRenameOp[] = [
			{ kind: "flat", from: "ghost", to: "a", reason: "" },
		];
		const r = validateAlignOps(d, undefined, ops);
		expect(r.valid).toBe(false);
		if (r.valid) return;
		expect(r.errors[0]).toMatch(/^rich-validator: /);
		expect(r.errors[0]).toContain("not an observed candidate");
	});

	it("subtree expansion produces valid flat table", () => {
		// Realistic alignment scenario: one page emits `footer.legal.copyright`
		// / `footer.legal.privacy`, another emits the flat `footer.copyright`
		// / `footer.privacy`. The subtree op collapses the legal-prefixed
		// variants onto the already-observed flat canonicals.
		const d = digestOf([
			"footer.legal.copyright",
			"footer.legal.privacy",
			"footer.copyright",
			"footer.privacy",
		]);
		const ops: RichRenameOp[] = [
			{
				kind: "subtree",
				fromPrefix: "footer.legal",
				toPrefix: "footer",
				reason: "",
			},
		];
		const r = validateAlignOps(d, undefined, ops);
		expect(r.valid).toBe(true);
		if (!r.valid) return;
		expect(r.flat.map((e) => `${e.from}→${e.to}`).sort()).toEqual([
			"footer.legal.copyright→footer.copyright",
			"footer.legal.privacy→footer.privacy",
		]);
	});

	it("cycle in the compiled flat → fails with rename-validator tag", () => {
		const d = digestOf(["a", "b"]);
		const ops: RichRenameOp[] = [
			{ kind: "flat", from: "a", to: "b", reason: "" },
			{ kind: "flat", from: "b", to: "a", reason: "" },
		];
		const r = validateAlignOps(d, undefined, ops);
		expect(r.valid).toBe(false);
		if (r.valid) return;
		expect(r.errors.some((e) => e.startsWith("rename-validator: "))).toBe(true);
		expect(r.errors.some((e) => e.toLowerCase().includes("cycle"))).toBe(true);
	});

	it("subtree matching no candidates → fails with rich-validator tag", () => {
		const d = digestOf(["header.nav"]);
		const ops: RichRenameOp[] = [
			{
				kind: "subtree",
				fromPrefix: "sidebar",
				toPrefix: "aside",
				reason: "",
			},
		];
		const r = validateAlignOps(d, undefined, ops);
		expect(r.valid).toBe(false);
		if (r.valid) return;
		expect(r.errors[0]).toMatch(/^rich-validator: /);
		expect(r.errors[0]).toContain("matches no candidate paths");
	});

	// Single-source bucket whose canonical IS observed in the digest is a
	// legitimate alias merge — the "synthetic canonical" prohibition only
	// applies when the target is genuinely invented (not in candidates).
	// Locks in the fix for the blog_post/batch-0 oscillating-reviewer bug:
	// both `footer.copyright` and `footer.footer_text` were observed paths
	// yet the LLM reviewer flipped between calling each "invented" on
	// consecutive attempts.
	it("single-source rename onto observed canonical → valid", () => {
		const d = digestOf(["footer.copyright", "footer.footer_text"]);
		const ops: RichRenameOp[] = [
			{
				kind: "flat",
				from: "footer.footer_text",
				to: "footer.copyright",
				reason: "alias",
			},
		];
		const r = validateAlignOps(d, undefined, ops);
		expect(r.valid).toBe(true);
	});

	it("single-source rename onto unobserved canonical → rejects as synthetic", () => {
		const d = digestOf(["footer.footer_text"]);
		const ops: RichRenameOp[] = [
			{
				kind: "flat",
				from: "footer.footer_text",
				to: "footer.invented",
				reason: "",
			},
		];
		const r = validateAlignOps(d, undefined, ops);
		expect(r.valid).toBe(false);
		if (r.valid) return;
		expect(r.errors.some((e) => e.startsWith("rename-validator: "))).toBe(true);
		expect(r.errors.some((e) => e.toLowerCase().includes("synthetic"))).toBe(
			true,
		);
	});
});

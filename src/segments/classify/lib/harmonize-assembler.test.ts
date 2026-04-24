import { describe, expect, it } from "bun:test";
import { assemble, validateAssembled } from "./harmonize-assembler.js";
import type { PageTypeDigest, VerdictTable } from "./harmonize-types.js";

function emptyDigest(pt: string, pages: string[]): PageTypeDigest {
	return {
		pagetype: pt,
		totalPages: pages.length,
		pageHashes: pages,
		candidates: [],
	};
}

describe("assemble", () => {
	it("places keep-static values at nested paths (including null leaves)", () => {
		const pages = ["p1", "p2"];
		const renamed: PageTypeDigest = {
			pagetype: "team_member",
			totalPages: 2,
			pageHashes: pages,
			candidates: [
				{
					candidatePath: "header.navigation[7].href",
					distinctValues: [{ value: null, pageHashes: pages }],
					presentOn: pages,
					absentFrom: [],
				},
				{
					candidatePath: "header.navigation[7].label",
					distinctValues: [{ value: "More", pageHashes: pages }],
					presentOn: pages,
					absentFrom: [],
				},
			],
		};
		const verdicts: VerdictTable = [
			{
				candidatePath: "header.navigation[7].href",
				kind: "keep-static",
				value: null,
				observed: true,
				absentFrom: [],
			},
			{
				candidatePath: "header.navigation[7].label",
				kind: "keep-static",
				value: "More",
				observed: true,
				absentFrom: [],
			},
		];
		const result = assemble({
			pagetype: "team_member",
			renamedDigest: renamed,
			verdicts,
			preRenameDigest: renamed,
			renameTable: [],
			pageContents: new Map(),
		});
		const nav = (result.canonical as Record<string, Record<string, unknown[]>>)
			.header.navigation;
		expect(nav[7]).toEqual({ href: null, label: "More" });
		expect(result.chromeFields["header.navigation[7].href"]).toBe(null);
	});

	it("keep-static observed=false places the normalized value", () => {
		const pages = ["p1", "p2"];
		const renamed: PageTypeDigest = {
			pagetype: "x",
			totalPages: 2,
			pageHashes: pages,
			candidates: [
				{
					candidatePath: "footer.phone",
					distinctValues: [
						{ value: "(555) 100-2300", pageHashes: ["p1"] },
						{ value: "555.100.2300", pageHashes: ["p2"] },
					],
					presentOn: pages,
					absentFrom: [],
				},
			],
		};
		const verdicts: VerdictTable = [
			{
				candidatePath: "footer.phone",
				kind: "keep-static",
				value: "+1-555-100-2300",
				observed: false,
				absentFrom: [],
				rationale: "normalized phone",
			},
		];
		const result = assemble({
			pagetype: "x",
			renamedDigest: renamed,
			verdicts,
			preRenameDigest: renamed,
			renameTable: [],
			pageContents: new Map(),
		});
		expect(result.chromeFields["footer.phone"]).toBe("+1-555-100-2300");
		expect(result.valueConflicts.length).toBe(1);
		expect(result.valueConflicts[0].chosenValue).toBe("+1-555-100-2300");
	});

	it("excludes demoted candidates from canonical + chromeFields", () => {
		const renamed: PageTypeDigest = {
			pagetype: "x",
			totalPages: 1,
			pageHashes: ["p1"],
			candidates: [
				{
					candidatePath: "page_title",
					distinctValues: [{ value: "Welcome", pageHashes: ["p1"] }],
					presentOn: ["p1"],
					absentFrom: [],
				},
			],
		};
		const verdicts: VerdictTable = [
			{ candidatePath: "page_title", kind: "demote", rationale: "per-page" },
		];
		const result = assemble({
			pagetype: "x",
			renamedDigest: renamed,
			verdicts,
			preRenameDigest: renamed,
			renameTable: [],
			pageContents: new Map(),
		});
		expect(result.chromeFields).toEqual({});
		expect(result.canonical).toEqual({});
		expect(result.chromeDynamic).toEqual({});
	});

	it("emits per-page mappers with source→canonical entries and demotion list", () => {
		const pages = ["p1"];
		const renamed: PageTypeDigest = {
			pagetype: "x",
			totalPages: 1,
			pageHashes: pages,
			candidates: [
				{
					candidatePath: "header.logo",
					distinctValues: [{ value: "logo.png", pageHashes: pages }],
					presentOn: pages,
					absentFrom: [],
				},
				{
					candidatePath: "hero.title",
					distinctValues: [{ value: "Hi", pageHashes: pages }],
					presentOn: pages,
					absentFrom: [],
				},
			],
		};
		const verdicts: VerdictTable = [
			{
				candidatePath: "header.logo",
				kind: "keep-static",
				value: "logo.png",
				observed: true,
				absentFrom: [],
			},
			{ candidatePath: "hero.title", kind: "demote", rationale: "per-page" },
		];
		const pageContents = new Map([
			[
				"p1",
				{
					url: "/",
					content: { header: { logo: "logo.png" }, hero: { title: "Hi" } },
					sourcePaths: [
						{ sourcePath: "header.logo", candidatePath: "header.logo" },
						{ sourcePath: "hero.title", candidatePath: "hero.title" },
					],
				},
			],
		]);
		const result = assemble({
			pagetype: "x",
			renamedDigest: renamed,
			verdicts,
			preRenameDigest: renamed,
			renameTable: [],
			pageContents,
		});
		expect(result.pageMappers[0].entries).toEqual([
			{ sourcePath: "header.logo", canonicalField: "header.logo" },
		]);
		expect(result.pageMappers[0].demotedSourcePaths).toEqual(["hero.title"]);
	});

	it("keep-dynamic places sentinel, builds chrome-dynamic slot, routes per-page mappers", () => {
		const pages = ["p1", "p2"];
		const digest: PageTypeDigest = {
			pagetype: "article",
			totalPages: 2,
			pageHashes: pages,
			candidates: [
				{
					candidatePath: "breadcrumb.trail",
					distinctValues: [
						{ value: ["Home", "Blog", "Post 1"], pageHashes: ["p1"] },
						{ value: ["Home", "Blog", "Post 2"], pageHashes: ["p2"] },
					],
					presentOn: pages,
					absentFrom: [],
				},
			],
		};
		const verdicts: VerdictTable = [
			{
				candidatePath: "breadcrumb.trail",
				kind: "keep-dynamic",
				pattern: "breadcrumb",
				rationale: "per-page trail",
			},
		];
		const pageContents = new Map([
			[
				"p1",
				{
					url: "/post-1",
					content: { breadcrumb: { trail: ["Home", "Blog", "Post 1"] } },
					sourcePaths: [
						{
							sourcePath: "breadcrumb.trail",
							candidatePath: "breadcrumb.trail",
						},
					],
				},
			],
			[
				"p2",
				{
					url: "/post-2",
					content: { breadcrumb: { trail: ["Home", "Blog", "Post 2"] } },
					sourcePaths: [
						{
							sourcePath: "breadcrumb.trail",
							candidatePath: "breadcrumb.trail",
						},
					],
				},
			],
		]);
		const result = assemble({
			pagetype: "article",
			renamedDigest: digest,
			verdicts,
			preRenameDigest: digest,
			renameTable: [],
			pageContents,
		});

		expect(
			(result.canonical as Record<string, Record<string, unknown>>).breadcrumb
				.trail,
		).toBe("<dynamic>");
		expect(result.chromeFields["breadcrumb.trail"]).toBe("<dynamic>");

		const slot = result.chromeDynamic["breadcrumb.trail"];
		expect(slot).toBeDefined();
		expect(slot.pattern).toBe("breadcrumb");
		expect(slot.rationale).toBe("per-page trail");
		expect(slot.absentFrom).toEqual([]);
		expect(slot.values).toEqual([
			{ pageHash: "p1", value: ["Home", "Blog", "Post 1"] },
			{ pageHash: "p2", value: ["Home", "Blog", "Post 2"] },
		]);

		const p1Mapper = result.pageMappers.find((m) => m.hash === "p1");
		const p2Mapper = result.pageMappers.find((m) => m.hash === "p2");
		expect(p1Mapper?.entries).toEqual([
			{
				sourcePath: "breadcrumb.trail",
				canonicalField: "breadcrumb.trail",
			},
		]);
		expect(p1Mapper?.demotedSourcePaths).toEqual([]);
		expect(p2Mapper?.entries).toEqual([
			{
				sourcePath: "breadcrumb.trail",
				canonicalField: "breadcrumb.trail",
			},
		]);
		expect(p2Mapper?.demotedSourcePaths).toEqual([]);
	});

	it("folds a multi-hop rename chain into a single keep-dynamic slot", () => {
		const pages = ["p1", "p2"];
		const preRenameDigest: PageTypeDigest = {
			pagetype: "article",
			totalPages: 2,
			pageHashes: pages,
			candidates: [
				{
					candidatePath: "breadcrumbs",
					distinctValues: [{ value: ["Home", "A"], pageHashes: ["p1"] }],
					presentOn: ["p1"],
					absentFrom: ["p2"],
				},
				{
					candidatePath: "breadcrumb_trail",
					distinctValues: [{ value: ["Home", "B"], pageHashes: ["p2"] }],
					presentOn: ["p2"],
					absentFrom: ["p1"],
				},
			],
		};
		const renameTable = [
			{ from: "breadcrumbs", to: "breadcrumb.alt", reason: "alias" },
			{ from: "breadcrumb.alt", to: "breadcrumb.trail", reason: "alias" },
			{ from: "breadcrumb_trail", to: "breadcrumb.trail", reason: "alias" },
		];
		const renamedDigest: PageTypeDigest = {
			pagetype: "article",
			totalPages: 2,
			pageHashes: pages,
			candidates: [
				{
					candidatePath: "breadcrumb.trail",
					distinctValues: [
						{ value: ["Home", "A"], pageHashes: ["p1"] },
						{ value: ["Home", "B"], pageHashes: ["p2"] },
					],
					presentOn: pages,
					absentFrom: [],
				},
			],
		};
		const verdicts: VerdictTable = [
			{
				candidatePath: "breadcrumb.trail",
				kind: "keep-dynamic",
				rationale: "per-page trail",
			},
		];
		const pageContents = new Map([
			[
				"p1",
				{
					url: "/a",
					content: { breadcrumbs: ["Home", "A"] },
					sourcePaths: [
						{ sourcePath: "breadcrumbs", candidatePath: "breadcrumbs" },
					],
				},
			],
			[
				"p2",
				{
					url: "/b",
					content: { breadcrumb_trail: ["Home", "B"] },
					sourcePaths: [
						{
							sourcePath: "breadcrumb_trail",
							candidatePath: "breadcrumb_trail",
						},
					],
				},
			],
		]);
		const result = assemble({
			pagetype: "article",
			renamedDigest,
			verdicts,
			preRenameDigest,
			renameTable,
			pageContents,
		});

		const slot = result.chromeDynamic["breadcrumb.trail"];
		expect(slot).toBeDefined();
		expect(slot.absentFrom).toEqual([]);
		expect(slot.values).toEqual([
			{ pageHash: "p1", value: ["Home", "A"] },
			{ pageHash: "p2", value: ["Home", "B"] },
		]);

		const p1Mapper = result.pageMappers.find((m) => m.hash === "p1");
		const p2Mapper = result.pageMappers.find((m) => m.hash === "p2");
		expect(p1Mapper?.entries).toEqual([
			{ sourcePath: "breadcrumbs", canonicalField: "breadcrumb.trail" },
		]);
		expect(p2Mapper?.entries).toEqual([
			{ sourcePath: "breadcrumb_trail", canonicalField: "breadcrumb.trail" },
		]);
	});

	it("keep-dynamic with partial contribution records absentFrom on the slot", () => {
		const pages = ["p1", "p2", "p3"];
		const digest: PageTypeDigest = {
			pagetype: "article",
			totalPages: 3,
			pageHashes: pages,
			candidates: [
				{
					candidatePath: "breadcrumb.trail",
					distinctValues: [
						{ value: ["Home", "A"], pageHashes: ["p1"] },
						{ value: ["Home", "B"], pageHashes: ["p2"] },
					],
					presentOn: ["p1", "p2"],
					absentFrom: ["p3"],
				},
			],
		};
		const verdicts: VerdictTable = [
			{
				candidatePath: "breadcrumb.trail",
				kind: "keep-dynamic",
				rationale: "per-page trail",
			},
		];
		const result = assemble({
			pagetype: "article",
			renamedDigest: digest,
			verdicts,
			preRenameDigest: digest,
			renameTable: [],
			pageContents: new Map(),
		});
		const slot = result.chromeDynamic["breadcrumb.trail"];
		expect(slot.values.map((e) => e.pageHash).sort()).toEqual(["p1", "p2"]);
		expect(slot.absentFrom).toEqual(["p3"]);
	});

	it("dedups per-page entries when multiple pre-rename candidates carry the same pageHash", () => {
		// Same pageHash appears in two pre-rename candidates that fold to the
		// same canonical — the slot must have exactly one entry for that page.
		const pages = ["p1"];
		const preRenameDigest: PageTypeDigest = {
			pagetype: "x",
			totalPages: 1,
			pageHashes: pages,
			candidates: [
				{
					candidatePath: "breadcrumbs",
					distinctValues: [{ value: ["a"], pageHashes: ["p1"] }],
					presentOn: ["p1"],
					absentFrom: [],
				},
				{
					candidatePath: "breadcrumb_trail",
					distinctValues: [{ value: ["b"], pageHashes: ["p1"] }],
					presentOn: ["p1"],
					absentFrom: [],
				},
			],
		};
		const renameTable = [
			{ from: "breadcrumbs", to: "breadcrumb.trail", reason: "alias" },
			{ from: "breadcrumb_trail", to: "breadcrumb.trail", reason: "alias" },
		];
		const renamedDigest: PageTypeDigest = {
			pagetype: "x",
			totalPages: 1,
			pageHashes: pages,
			candidates: [
				{
					candidatePath: "breadcrumb.trail",
					distinctValues: [
						{ value: ["a"], pageHashes: ["p1"] },
						{ value: ["b"], pageHashes: ["p1"] },
					],
					presentOn: pages,
					absentFrom: [],
				},
			],
		};
		const verdicts: VerdictTable = [
			{
				candidatePath: "breadcrumb.trail",
				kind: "keep-dynamic",
				rationale: "per-page",
			},
		];
		const result = assemble({
			pagetype: "x",
			renamedDigest,
			verdicts,
			preRenameDigest,
			renameTable,
			pageContents: new Map(),
		});
		const slot = result.chromeDynamic["breadcrumb.trail"];
		expect(slot.values.filter((e) => e.pageHash === "p1").length).toBe(1);
	});
});

describe("validateAssembled", () => {
	it("flags canonical tree missing a leaf that a keep-static verdict named", () => {
		const renamed: PageTypeDigest = {
			pagetype: "t",
			totalPages: 1,
			pageHashes: ["p1"],
			candidates: [
				{
					candidatePath: "a.b",
					distinctValues: [{ value: 1, pageHashes: ["p1"] }],
					presentOn: ["p1"],
					absentFrom: [],
				},
			],
		};
		const verdicts: VerdictTable = [
			{
				candidatePath: "a.b",
				kind: "keep-static",
				value: 1,
				observed: true,
				absentFrom: [],
			},
		];
		const result = assemble({
			pagetype: "t",
			renamedDigest: renamed,
			verdicts,
			preRenameDigest: renamed,
			renameTable: [],
			pageContents: new Map(),
		});
		result.canonical = {};
		const v = validateAssembled(result, verdicts, new Map());
		expect(v.valid).toBe(false);
		expect(v.errors[0]).toContain("canonical tree missing");
	});

	it("empty digest + no verdicts assembles to {}", () => {
		const renamed = emptyDigest("y", []);
		const result = assemble({
			pagetype: "y",
			renamedDigest: renamed,
			verdicts: [],
			preRenameDigest: renamed,
			renameTable: [],
			pageContents: new Map(),
		});
		expect(result.canonical).toEqual({});
		expect(result.chromeDynamic).toEqual({});
		expect(result.pageMappers).toEqual([]);
	});
});

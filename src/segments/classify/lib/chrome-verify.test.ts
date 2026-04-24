import { describe, expect, it } from "bun:test";
import { verifyOnePage, verifyPageType } from "./chrome-verify.js";
import type { ChromeDynamic, PageMapper } from "./harmonize-types.js";

const content = {
	header: { logo: "/logo.svg", nav: { home: "/" } },
	title: "Welcome",
	body: { copy: "hello" },
};

const canonical = {
	header: { logo: "/logo.svg", nav: { home: "/" } },
};

const emptyDynamic: ChromeDynamic = {};

const goodMapper: PageMapper = {
	hash: "a",
	entries: [
		{ sourcePath: "header.logo", canonicalField: "header.logo" },
		{ sourcePath: "header.nav.home", canonicalField: "header.nav.home" },
	],
	demotedSourcePaths: [],
};

describe("verifyOnePage", () => {
	it("passes when every entry matches and resolves", () => {
		const result = verifyOnePage({
			hash: "a",
			content,
			mapper: goodMapper,
			canonical,
			chromeDynamic: emptyDynamic,
		});
		expect(result.status).toBe("pass");
		expect(result.errors).toEqual([]);
		expect(result.chromeEntryCount).toBe(2);
		expect(result.body).toEqual({ title: "Welcome", body: { copy: "hello" } });
	});

	it("fails when sourcePath doesn't resolve on content", () => {
		const mapper: PageMapper = {
			hash: "a",
			entries: [{ sourcePath: "missing.path", canonicalField: "header.logo" }],
			demotedSourcePaths: [],
		};
		const result = verifyOnePage({
			hash: "a",
			content,
			mapper,
			canonical,
			chromeDynamic: emptyDynamic,
		});
		expect(result.status).toBe("fail");
		expect(
			result.errors.some((e) => e.includes("does not resolve on page content")),
		).toBe(true);
	});

	it("fails when canonicalField doesn't resolve", () => {
		const mapper: PageMapper = {
			hash: "a",
			entries: [{ sourcePath: "header.logo", canonicalField: "missing.field" }],
			demotedSourcePaths: [],
		};
		const result = verifyOnePage({
			hash: "a",
			content,
			mapper,
			canonical,
			chromeDynamic: emptyDynamic,
		});
		expect(result.status).toBe("fail");
		expect(
			result.errors.some((e) => e.includes("does not resolve on canonical")),
		).toBe(true);
	});

	it("fails on value mismatch", () => {
		const tamperedCanonical = {
			header: { logo: "/TAMPERED.svg", nav: { home: "/" } },
		};
		const result = verifyOnePage({
			hash: "a",
			content,
			mapper: goodMapper,
			canonical: tamperedCanonical,
			chromeDynamic: emptyDynamic,
		});
		expect(result.status).toBe("fail");
		expect(result.errors.some((e) => e.includes("value mismatch"))).toBe(true);
	});

	it("flags duplicate sourcePath entries", () => {
		const mapper: PageMapper = {
			hash: "a",
			entries: [
				{ sourcePath: "header.logo", canonicalField: "header.logo" },
				{ sourcePath: "header.logo", canonicalField: "header.logo" },
			],
			demotedSourcePaths: [],
		};
		const result = verifyOnePage({
			hash: "a",
			content,
			mapper,
			canonical,
			chromeDynamic: emptyDynamic,
		});
		expect(result.status).toBe("fail");
		expect(result.errors.some((e) => e.includes("duplicate sourcePath"))).toBe(
			true,
		);
	});

	it("flags sourcePath appearing in both entries and demotedSourcePaths", () => {
		const mapper: PageMapper = {
			hash: "a",
			entries: [{ sourcePath: "header.logo", canonicalField: "header.logo" }],
			demotedSourcePaths: ["header.logo"],
		};
		const result = verifyOnePage({
			hash: "a",
			content,
			mapper,
			canonical,
			chromeDynamic: emptyDynamic,
		});
		expect(result.status).toBe("fail");
		expect(
			result.errors.some((e) =>
				e.includes(
					"appears in both mapper.entries and mapper.demotedSourcePaths",
				),
			),
		).toBe(true);
	});

	it("flags demoted sourcePath that doesn't resolve on content", () => {
		const mapper: PageMapper = {
			hash: "a",
			entries: [],
			demotedSourcePaths: ["missing.path"],
		};
		const result = verifyOnePage({
			hash: "a",
			content,
			mapper,
			canonical,
			chromeDynamic: emptyDynamic,
		});
		expect(result.status).toBe("fail");
		expect(
			result.errors.some((e) =>
				e.includes('demoted sourcePath "missing.path"'),
			),
		).toBe(true);
	});

	it("emits body with chrome paths removed (via splitByChromePaths)", () => {
		const result = verifyOnePage({
			hash: "a",
			content,
			mapper: goodMapper,
			canonical,
			chromeDynamic: emptyDynamic,
		});
		expect(result.body).toEqual({ title: "Welcome", body: { copy: "hello" } });
	});

	it("treats demoted paths as body (stays in content)", () => {
		const mapper: PageMapper = {
			hash: "a",
			entries: [{ sourcePath: "header.logo", canonicalField: "header.logo" }],
			demotedSourcePaths: ["header.nav.home"],
		};
		const result = verifyOnePage({
			hash: "a",
			content,
			mapper,
			canonical,
			chromeDynamic: emptyDynamic,
		});
		expect(result.status).toBe("pass");
		expect(result.body).toEqual({
			header: { nav: { home: "/" } },
			title: "Welcome",
			body: { copy: "hello" },
		});
	});
});

// ---------------------------------------------------------------------------
// verifyPageType
// ---------------------------------------------------------------------------

describe("verifyPageType", () => {
	it("aggregates per-page pass/fail counts", () => {
		const result = verifyPageType({
			pagetype: "p",
			canonical,
			chromeDynamic: emptyDynamic,
			pages: [
				{ hash: "a", content, mapper: goodMapper },
				{
					hash: "b",
					content,
					mapper: {
						hash: "b",
						entries: [{ sourcePath: "missing", canonicalField: "header.logo" }],
						demotedSourcePaths: [],
					},
				},
			],
		});
		expect(result.status).toBe("fail");
		expect(result.passCount).toBe(1);
		expect(result.failCount).toBe(1);
	});

	it("passes when all pages pass", () => {
		const result = verifyPageType({
			pagetype: "p",
			canonical,
			chromeDynamic: emptyDynamic,
			pages: [{ hash: "a", content, mapper: goodMapper }],
		});
		expect(result.status).toBe("pass");
		expect(result.passCount).toBe(1);
		expect(result.failCount).toBe(0);
	});
});

describe("verifyOnePage — keep-dynamic round-trip", () => {
	const dynamicCanonical = {
		breadcrumb: { trail: "<dynamic>" },
		header: { logo: "/logo.svg" },
	};
	const dynamicChrome: ChromeDynamic = {
		"breadcrumb.trail": {
			rationale: "per-page",
			pattern: "breadcrumb",
			values: [
				{ pageHash: "a", value: ["Home", "Blog", "Post 1"] },
				{ pageHash: "b", value: ["Home", "Blog", "Post 2"] },
			],
			absentFrom: ["c"],
		},
	};

	it("passes when per-page value matches chrome-dynamic slot", () => {
		const pageContent = {
			breadcrumb: { trail: ["Home", "Blog", "Post 1"] },
			header: { logo: "/logo.svg" },
		};
		const mapper: PageMapper = {
			hash: "a",
			entries: [
				{ sourcePath: "header.logo", canonicalField: "header.logo" },
				{ sourcePath: "breadcrumb.trail", canonicalField: "breadcrumb.trail" },
			],
			demotedSourcePaths: [],
		};
		const result = verifyOnePage({
			hash: "a",
			content: pageContent,
			mapper,
			canonical: dynamicCanonical,
			chromeDynamic: dynamicChrome,
		});
		expect(result.errors).toEqual([]);
		expect(result.status).toBe("pass");
	});

	it("fails when dynamic per-page value mismatches", () => {
		const pageContent = {
			breadcrumb: { trail: ["Home", "Blog", "Tampered"] },
			header: { logo: "/logo.svg" },
		};
		const mapper: PageMapper = {
			hash: "a",
			entries: [
				{ sourcePath: "breadcrumb.trail", canonicalField: "breadcrumb.trail" },
			],
			demotedSourcePaths: [],
		};
		const result = verifyOnePage({
			hash: "a",
			content: pageContent,
			mapper,
			canonical: dynamicCanonical,
			chromeDynamic: dynamicChrome,
		});
		expect(result.status).toBe("fail");
		expect(
			result.errors.some((e) => e.includes("dynamic value mismatch")),
		).toBe(true);
	});

	it("fails when a page mapped to a dynamic slot is listed as absent", () => {
		const pageContent = { breadcrumb: { trail: ["x"] } };
		const mapper: PageMapper = {
			hash: "c",
			entries: [
				{ sourcePath: "breadcrumb.trail", canonicalField: "breadcrumb.trail" },
			],
			demotedSourcePaths: [],
		};
		const result = verifyOnePage({
			hash: "c",
			content: pageContent,
			mapper,
			canonical: dynamicCanonical,
			chromeDynamic: dynamicChrome,
		});
		expect(result.status).toBe("fail");
		expect(
			result.errors.some((e) => e.includes('lists page "c" as absent')),
		).toBe(true);
	});

	it('sentinel never participates in value-hash equality (page value happens to be the string "<dynamic>")', () => {
		// If a page literally contains the string "<dynamic>" at the sourcePath
		// and the canonical leaf is also the sentinel, a naive implementation
		// would hash-compare the two and erroneously pass. chrome-verify must
		// route through chrome-dynamic even when the page value textually
		// matches the sentinel.
		const pageContent = {
			breadcrumb: { trail: "<dynamic>" },
			header: { logo: "/logo.svg" },
		};
		const mapper: PageMapper = {
			hash: "a",
			entries: [
				{ sourcePath: "breadcrumb.trail", canonicalField: "breadcrumb.trail" },
			],
			demotedSourcePaths: [],
		};
		const result = verifyOnePage({
			hash: "a",
			content: pageContent,
			mapper,
			canonical: dynamicCanonical,
			chromeDynamic: dynamicChrome,
		});
		expect(result.status).toBe("fail");
		expect(
			result.errors.some((e) => e.includes("dynamic value mismatch")),
		).toBe(true);
	});

	it("absent page with no mapper entry round-trips cleanly", () => {
		const pageContent = { header: { logo: "/logo.svg" }, other: "x" };
		const mapper: PageMapper = {
			hash: "c",
			entries: [{ sourcePath: "header.logo", canonicalField: "header.logo" }],
			demotedSourcePaths: [],
		};
		const result = verifyOnePage({
			hash: "c",
			content: pageContent,
			mapper,
			canonical: dynamicCanonical,
			chromeDynamic: dynamicChrome,
		});
		expect(result.errors).toEqual([]);
		expect(result.status).toBe("pass");
		expect(result.body).toEqual({ other: "x" });
	});
});

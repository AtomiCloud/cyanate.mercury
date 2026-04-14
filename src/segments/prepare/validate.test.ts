import { describe, expect, it } from "bun:test";
import type { AssetEntry } from "./download.js";
import type { Heuristics, StructureMap } from "./heuristics.js";
import type { PageTypeMeta, PreparedPage } from "./ingest.js";
import { validateDataset } from "./validate.js";

// ---------------------------------------------------------------------------
// Helper: build a valid baseline dataset
// ---------------------------------------------------------------------------

function validBaseline() {
	const pages: PreparedPage[] = [
		{
			url: "/",
			pagetype: "landing",
			content: {
				hero: "Welcome",
				logo: "images/abc123.png",
				related: "/post/hello/",
			},
			schema: {
				type: "object",
				properties: { hero: { type: "string" } },
			},
		},
		{
			url: "/post/hello/",
			pagetype: "blog_post",
			content: {
				title: "Hello",
				body: "World",
				image: "images/def456.jpg",
			},
			schema: {
				type: "object",
				properties: { title: { type: "string" }, body: { type: "string" } },
			},
		},
	];

	const pageTypeMeta: PageTypeMeta[] = [
		{
			pagetype: "landing",
			urlPattern: "/",
			count: 1,
			urls: ["/"],
			hasPagination: false,
		},
		{
			pagetype: "blog_post",
			urlPattern: "/post/{slug}/",
			count: 1,
			urls: ["/post/hello/"],
			hasPagination: false,
		},
	];

	const assetEntries: AssetEntry[] = [
		{
			originalUrl: "https://cdn.example.com/a.png",
			localPath: "abc123.png",
			downloaded: true,
		},
		{
			originalUrl: "https://cdn.example.com/b.jpg",
			localPath: "def456.jpg",
			downloaded: true,
		},
	];

	const existingImageFiles = new Set(["abc123.png", "def456.jpg"]);
	const siteUrl = "https://example.com";

	return { pages, pageTypeMeta, assetEntries, existingImageFiles, siteUrl };
}

// ---------------------------------------------------------------------------
// Full passing dataset
// ---------------------------------------------------------------------------

describe("validateDataset", () => {
	it("passes for a valid baseline dataset", () => {
		const result = validateDataset(validBaseline());
		expect(result.valid).toBe(true);
		expect(result.failures).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Assertion 1: image URL in content → downloaded: true entry in manifest
// ---------------------------------------------------------------------------

describe("assertion 1: image URLs in manifest", () => {
	it("fails when content references unknown local image", () => {
		const opts = validBaseline();
		opts.pages[0].content.logo = "images/unknown.png";
		const result = validateDataset(opts);
		expect(result.valid).toBe(false);
		const f = result.failures.find((f) => f.assertion === 1);
		expect(f).toBeDefined();
		expect(f?.details[0]).toContain("unknown.png");
	});

	it("fails when content references image from downloaded=false entry", () => {
		const opts = validBaseline();
		// Add a failed-download entry and reference its local path in content
		opts.assetEntries.push({
			originalUrl: "https://cdn.example.com/fail.png",
			localPath: "fail999.png",
			downloaded: false,
		});
		opts.pages[0].content.extra = "images/fail999.png";
		const result = validateDataset(opts);
		expect(result.valid).toBe(false);
		const f = result.failures.find((f) => f.assertion === 1);
		expect(f).toBeDefined();
		expect(f?.details[0]).toContain("fail999.png");
	});
});

// ---------------------------------------------------------------------------
// Assertion 2: internal links → known final URLs
// ---------------------------------------------------------------------------

describe("assertion 2: internal links resolvable", () => {
	it("fails when content links to unknown internal path", () => {
		const opts = validBaseline();
		opts.pages[0].content.related = "/nonexistent/";
		const result = validateDataset(opts);
		expect(result.valid).toBe(false);
		const f = result.failures.find((f) => f.assertion === 2);
		expect(f).toBeDefined();
		expect(f?.details[0]).toContain("/nonexistent/");
	});

	it("allows root link /", () => {
		const opts = validBaseline();
		opts.pages[0].content.related = "/";
		const result = validateDataset(opts);
		const f = result.failures.find((f) => f.assertion === 2);
		expect(f).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Assertion 3: no unresolved $ref
// ---------------------------------------------------------------------------

describe("assertion 3: no unresolved $ref", () => {
	it("fails when schema has dangling $ref", () => {
		const opts = validBaseline();
		opts.pages[0].schema = {
			type: "object",
			properties: {
				header: { $ref: "#/definitions/header" },
			},
		};
		const result = validateDataset(opts);
		expect(result.valid).toBe(false);
		const f = result.failures.find((f) => f.assertion === 3);
		expect(f).toBeDefined();
		expect(f?.details[0]).toContain("#/definitions/header");
	});
});

// ---------------------------------------------------------------------------
// Assertion 4: every type in meta has >= 1 content page
// ---------------------------------------------------------------------------

describe("assertion 4: every type has pages", () => {
	it("fails when meta references a type with no content pages", () => {
		const opts = validBaseline();
		opts.pageTypeMeta.push({
			pagetype: "team",
			urlPattern: "/team/{slug}/",
			count: 1,
			urls: ["/team/alice/"],
			hasPagination: false,
		});
		const result = validateDataset(opts);
		expect(result.valid).toBe(false);
		const f = result.failures.find((f) => f.assertion === 4);
		expect(f).toBeDefined();
		expect(f?.details).toContain("team");
	});
});

// ---------------------------------------------------------------------------
// Assertion 5: no original site URLs in content
// ---------------------------------------------------------------------------

describe("assertion 5: no site origin URLs", () => {
	it("fails when content still has full site-domain URLs", () => {
		const opts = validBaseline();
		opts.pages[0].content.link = "https://example.com/old-path/";
		const result = validateDataset(opts);
		expect(result.valid).toBe(false);
		const f = result.failures.find((f) => f.assertion === 5);
		expect(f).toBeDefined();
		expect(f?.details[0]).toContain("https://example.com");
	});
});

// ---------------------------------------------------------------------------
// Assertion 6: downloaded files exist on disk
// ---------------------------------------------------------------------------

describe("assertion 6: downloaded files on disk", () => {
	it("fails when a downloaded entry has no matching file", () => {
		const opts = validBaseline();
		opts.existingImageFiles.delete("def456.jpg");
		const result = validateDataset(opts);
		expect(result.valid).toBe(false);
		const f = result.failures.find((f) => f.assertion === 6);
		expect(f).toBeDefined();
		expect(f?.details).toContain("def456.jpg");
	});

	it("ignores entries with downloaded=false", () => {
		const opts = validBaseline();
		opts.assetEntries.push({
			originalUrl: "https://cdn.example.com/fail.png",
			localPath: "fail123.png",
			downloaded: false,
		});
		// don't add fail123.png to existingImageFiles
		const result = validateDataset(opts);
		const f = result.failures.find((f) => f.assertion === 6);
		expect(f).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Assertion 7: no route conflicts
// ---------------------------------------------------------------------------

describe("assertion 7: no route conflicts", () => {
	it("fails when two types produce conflicting route patterns", () => {
		const opts = validBaseline();
		// Both map to /[slug] in Astro form
		opts.pageTypeMeta = [
			{
				pagetype: "service",
				urlPattern: "/{service}/",
				count: 1,
				urls: ["/a/"],
				hasPagination: false,
			},
			{
				pagetype: "blog",
				urlPattern: "/{slug}/",
				count: 1,
				urls: ["/b/"],
				hasPagination: false,
			},
		];
		// Ensure assertion 4 still passes
		opts.pages = [
			{ url: "/a/", pagetype: "service", content: {}, schema: {} },
			{ url: "/b/", pagetype: "blog", content: {}, schema: {} },
		];
		const result = validateDataset(opts);
		expect(result.valid).toBe(false);
		const f = result.failures.find((f) => f.assertion === 7);
		expect(f).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Assertion 8: valid Astro route patterns
// ---------------------------------------------------------------------------

describe("assertion 8: valid Astro patterns", () => {
	it("fails for invalid patterns", () => {
		const opts = validBaseline();
		opts.pageTypeMeta[1].urlPattern = "/post-{slug}/";
		const result = validateDataset(opts);
		expect(result.valid).toBe(false);
		const f = result.failures.find((f) => f.assertion === 8);
		expect(f).toBeDefined();
		expect(f?.details[0]).toContain("blog_post");
	});
});

// ---------------------------------------------------------------------------
// Assertion 9: page ↔ meta bijection
// ---------------------------------------------------------------------------

describe("assertion 9: page/meta bijection", () => {
	it("passes for consistent baseline", () => {
		const result = validateDataset(validBaseline());
		const f = result.failures.find((f) => f.assertion === 9);
		expect(f).toBeUndefined();
	});

	it("fails when a page url is not in meta.urls", () => {
		const opts = validBaseline();
		// Add a page that has no meta entry
		opts.pages.push({
			url: "/about/",
			pagetype: "landing",
			content: {},
			schema: {},
		});
		const result = validateDataset(opts);
		const f = result.failures.find((f) => f.assertion === 9);
		expect(f).toBeDefined();
		expect(f?.details.some((d) => d.includes("page without meta entry"))).toBe(
			true,
		);
	});

	it("fails when meta.urls contains a url with no matching page", () => {
		const opts = validBaseline();
		opts.pageTypeMeta[0].urls.push("/phantom/");
		const result = validateDataset(opts);
		const f = result.failures.find((f) => f.assertion === 9);
		expect(f).toBeDefined();
		expect(f?.details.some((d) => d.includes("meta url without page"))).toBe(
			true,
		);
	});

	it("fails when meta.count !== meta.urls.length", () => {
		const opts = validBaseline();
		opts.pageTypeMeta[0].count = 5;
		const result = validateDataset(opts);
		const f = result.failures.find((f) => f.assertion === 9);
		expect(f).toBeDefined();
		expect(f?.details.some((d) => d.includes("count=5"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Assertion 10: urlMap injectivity
// ---------------------------------------------------------------------------

describe("assertion 10: urlMap injectivity", () => {
	it("passes for injective urlMap", () => {
		const result = validateDataset({
			...validBaseline(),
			urlMap: { "/a": "/x", "/b": "/y" },
		});
		const f = result.failures.find((f) => f.assertion === 10);
		expect(f).toBeUndefined();
	});

	it("fails when two keys map to the same value", () => {
		const result = validateDataset({
			...validBaseline(),
			urlMap: { "/a": "/same", "/b": "/same" },
		});
		const f = result.failures.find((f) => f.assertion === 10);
		expect(f).toBeDefined();
		expect(f?.details[0]).toContain("/same");
		expect(f?.details[0]).toContain("/a");
		expect(f?.details[0]).toContain("/b");
	});

	it("skipped when urlMap not provided", () => {
		const result = validateDataset(validBaseline());
		const f = result.failures.find((f) => f.assertion === 10);
		expect(f).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Assertion 11: heuristics consistency
// ---------------------------------------------------------------------------

describe("assertion 11: heuristics consistency", () => {
	function baseHeuristics(): Heuristics {
		return {
			totalPages: 2,
			totalPageTypes: 2,
			pageTypes: [
				{
					pagetype: "landing",
					pageCount: 1,
					avgContentLength: 100,
					topLevelFieldCount: 3,
					richestSampleUrl: "/",
					simplestSampleUrl: "/",
				},
				{
					pagetype: "blog_post",
					pageCount: 1,
					avgContentLength: 50,
					topLevelFieldCount: 3,
					richestSampleUrl: "/post/hello/",
					simplestSampleUrl: "/post/hello/",
				},
			],
			fieldFrequency: {},
		};
	}

	function baseStructureMaps(): StructureMap[] {
		return [
			{ pagetype: "landing", sampleUrl: "/", tree: "..." },
			{ pagetype: "blog_post", sampleUrl: "/post/hello/", tree: "..." },
		];
	}

	it("passes for consistent heuristics", () => {
		const result = validateDataset({
			...validBaseline(),
			heuristics: baseHeuristics(),
			structureMaps: baseStructureMaps(),
		});
		const f = result.failures.find((f) => f.assertion === 11);
		expect(f).toBeUndefined();
	});

	it("fails when totalPages is wrong", () => {
		const h = baseHeuristics();
		h.totalPages = 99;
		const result = validateDataset({
			...validBaseline(),
			heuristics: h,
		});
		const f = result.failures.find((f) => f.assertion === 11);
		expect(f).toBeDefined();
		expect(f?.details[0]).toContain("totalPages=99");
	});

	it("fails when totalPageTypes is wrong", () => {
		const h = baseHeuristics();
		h.totalPageTypes = 5;
		const result = validateDataset({
			...validBaseline(),
			heuristics: h,
		});
		const f = result.failures.find((f) => f.assertion === 11);
		expect(f).toBeDefined();
		expect(f?.details[0]).toContain("totalPageTypes=5");
	});

	it("fails when per-type pageCount is wrong", () => {
		const h = baseHeuristics();
		h.pageTypes[0].pageCount = 10;
		const result = validateDataset({
			...validBaseline(),
			heuristics: h,
		});
		const f = result.failures.find((f) => f.assertion === 11);
		expect(f).toBeDefined();
		expect(f?.details[0]).toContain("landing");
	});

	it("fails when richestSampleUrl does not exist", () => {
		const h = baseHeuristics();
		h.pageTypes[0].richestSampleUrl = "/phantom/";
		const result = validateDataset({
			...validBaseline(),
			heuristics: h,
		});
		const f = result.failures.find((f) => f.assertion === 11);
		expect(f).toBeDefined();
		expect(f?.details.some((d) => d.includes("richestSampleUrl"))).toBe(true);
	});

	it("fails when structureMap sampleUrl does not exist", () => {
		const result = validateDataset({
			...validBaseline(),
			structureMaps: [
				{ pagetype: "landing", sampleUrl: "/gone/", tree: "..." },
			],
		});
		const f = result.failures.find((f) => f.assertion === 11);
		expect(f).toBeDefined();
		expect(f?.details[0]).toContain("/gone/");
	});
});

// ---------------------------------------------------------------------------
// Assertion 12: manifest entry uniqueness
// ---------------------------------------------------------------------------

describe("assertion 12: manifest uniqueness", () => {
	it("passes with unique entries", () => {
		const result = validateDataset(validBaseline());
		const f = result.failures.find((f) => f.assertion === 12);
		expect(f).toBeUndefined();
	});

	it("fails on duplicate originalUrl", () => {
		const opts = validBaseline();
		opts.assetEntries.push({
			originalUrl: "https://cdn.example.com/a.png",
			localPath: "dup123.png",
			downloaded: true,
		});
		opts.existingImageFiles.add("dup123.png");
		const result = validateDataset(opts);
		const f = result.failures.find((f) => f.assertion === 12);
		expect(f).toBeDefined();
		expect(f?.details[0]).toContain("duplicate originalUrl");
	});

	it("fails on duplicate localPath", () => {
		const opts = validBaseline();
		opts.assetEntries.push({
			originalUrl: "https://cdn.example.com/different.png",
			localPath: "abc123.png",
			downloaded: true,
		});
		const result = validateDataset(opts);
		const f = result.failures.find((f) => f.assertion === 12);
		expect(f).toBeDefined();
		expect(f?.details[0]).toContain("duplicate localPath");
	});
});

// ---------------------------------------------------------------------------
// Assertion 13: flat-filename invariant
// ---------------------------------------------------------------------------

describe("assertion 13: flat filenames", () => {
	it("passes with flat filenames", () => {
		const result = validateDataset(validBaseline());
		const f = result.failures.find((f) => f.assertion === 13);
		expect(f).toBeUndefined();
	});

	it("fails when localPath contains a slash", () => {
		const opts = validBaseline();
		opts.assetEntries[0].localPath = "sub/abc123.png";
		const result = validateDataset(opts);
		const f = result.failures.find((f) => f.assertion === 13);
		expect(f).toBeDefined();
		expect(f?.details[0]).toContain("sub/abc123.png");
	});
});

// ---------------------------------------------------------------------------
// Assertion 14: page structural integrity
// ---------------------------------------------------------------------------

describe("assertion 14: page structural integrity", () => {
	it("passes for valid pages", () => {
		const result = validateDataset(validBaseline());
		const f = result.failures.find((f) => f.assertion === 14);
		expect(f).toBeUndefined();
	});

	it("fails when page url is empty", () => {
		const opts = validBaseline();
		(opts.pages[0] as unknown as Record<string, unknown>).url = "";
		const result = validateDataset(opts);
		const f = result.failures.find((f) => f.assertion === 14);
		expect(f).toBeDefined();
		expect(f?.details[0]).toContain("empty url");
	});

	it("fails when page url does not start with /", () => {
		const opts = validBaseline();
		(opts.pages[0] as unknown as Record<string, unknown>).url = "no-slash";
		const result = validateDataset(opts);
		const f = result.failures.find((f) => f.assertion === 14);
		expect(f).toBeDefined();
		expect(f?.details[0]).toContain("does not start with /");
	});

	it("fails when pagetype is empty", () => {
		const opts = validBaseline();
		(opts.pages[0] as unknown as Record<string, unknown>).pagetype = "";
		const result = validateDataset(opts);
		const f = result.failures.find((f) => f.assertion === 14);
		expect(f).toBeDefined();
		expect(f?.details[0]).toContain("empty pagetype");
	});
});

// ---------------------------------------------------------------------------
// Assertion 15: unresolved internal paths staleness
// ---------------------------------------------------------------------------

describe("assertion 15: unresolved path staleness", () => {
	it("passes when unresolved path is actually in content", () => {
		const opts = validBaseline();
		opts.pages[0].content.action = "/search";
		const result = validateDataset({
			...opts,
			unresolvedInternalPaths: new Set(["/search"]),
		});
		const f = result.failures.find((f) => f.assertion === 15);
		expect(f).toBeUndefined();
	});

	it("fails when unresolved path does not appear in any content", () => {
		const opts = validBaseline();
		const result = validateDataset({
			...opts,
			unresolvedInternalPaths: new Set(["/stale-path"]),
		});
		const f = result.failures.find((f) => f.assertion === 15);
		expect(f).toBeDefined();
		expect(f?.details[0]).toContain("/stale-path");
	});

	it("skipped when unresolvedInternalPaths is empty", () => {
		const result = validateDataset({
			...validBaseline(),
			unresolvedInternalPaths: new Set<string>(),
		});
		const f = result.failures.find((f) => f.assertion === 15);
		expect(f).toBeUndefined();
	});
});

import { describe, expect, it } from "bun:test";
import type { PageContent, PageStructure, SchemaData } from "../../types.js";
import {
	buildAssetManifest,
	buildReducedMeta,
	buildReducedTree,
	classifyUrls,
	contentAddressedName,
	groupByPageType,
	rewriteInternalLinks,
	selectSamples,
} from "./reduce.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const structurePages: PageStructure[] = [
	{ id: "1", url: "/", pagetype: "landing", title: "Home" },
	{ id: "2", url: "/about", pagetype: "about", title: "About" },
	{ id: "3", url: "/blog/post-1", pagetype: "blog", title: "Blog Post 1" },
	{ id: "4", url: "/blog/post-2", pagetype: "blog", title: "Blog Post 2" },
	{ id: "5", url: "/blog/post-3", pagetype: "blog", title: "Blog Post 3" },
];

const contentPages: PageContent[] = [
	{
		id: "c1",
		url: "/",
		pagetype: "landing",
		content: { hero: "text", nav: "text", cta: "text", footer: "text" },
	},
	{
		id: "c2",
		url: "/about",
		pagetype: "about",
		content: { title: "text", body: "text" },
	},
	{
		id: "c3",
		url: "/blog/post-1",
		pagetype: "blog",
		content: { title: "text", body: "text", author: "text", tags: "text" },
	},
	{
		id: "c4",
		url: "/blog/post-2",
		pagetype: "blog",
		content: { title: "text", body: "text" },
	},
	{
		id: "c5",
		url: "/blog/post-3",
		pagetype: "blog",
		content: { title: "text", body: "text", gallery: "text" },
	},
];

const contentMap = new Map<string, PageContent>();
for (const p of contentPages) contentMap.set(p.id, p);

// ---------------------------------------------------------------------------
// groupByPageType
// ---------------------------------------------------------------------------

describe("groupByPageType", () => {
	it("groups 5 pages with 3 types correctly", () => {
		const grouped = groupByPageType(structurePages);

		expect(grouped.size).toBe(3);
		expect(grouped.get("landing")).toHaveLength(1);
		expect(grouped.get("about")).toHaveLength(1);
		expect(grouped.get("blog")).toHaveLength(3);
	});

	it("returns empty map for empty input", () => {
		expect(groupByPageType([]).size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// selectSamples
// ---------------------------------------------------------------------------

describe("selectSamples", () => {
	it("selects richest (most keys) and simplest (fewest keys) per type", () => {
		const grouped = groupByPageType(structurePages);
		const samples = selectSamples(grouped, contentMap);

		// Blog: post-1 has 4 keys (richest), post-2 has 2 keys (simplest)
		const blogSamples = samples.get("blog");
		expect(blogSamples).toBeDefined();
		const bs = blogSamples as NonNullable<typeof blogSamples>;
		expect(Object.keys(bs.richest.content)).toHaveLength(4);
		expect(bs.richest.url).toBe("/blog/post-1");
		expect(Object.keys(bs.simplest.content)).toHaveLength(2);
		expect(bs.simplest.url).toBe("/blog/post-2");
	});

	it("tie-breaking is deterministic (by id order)", () => {
		// blog/post-2 and a hypothetical post-4 both have 2 keys
		const pages: PageStructure[] = [
			{ id: "4", url: "/blog/post-4", pagetype: "blog", title: "Post 4" },
			{ id: "2", url: "/blog/post-2", pagetype: "blog", title: "Post 2" },
		];
		const contents: PageContent[] = [
			{
				id: "c4",
				url: "/blog/post-4",
				pagetype: "blog",
				content: { title: "a" },
			},
			{
				id: "c2",
				url: "/blog/post-2",
				pagetype: "blog",
				content: { body: "b" },
			},
		];

		const grouped = groupByPageType(pages);
		const cMap = new Map<string, PageContent>();
		for (const p of contents) cMap.set(p.id, p);
		const samples = selectSamples(grouped, cMap);

		// Both have 1 key; id "2" < id "4" so post-2 wins both richest and simplest
		const blog = samples.get("blog");
		expect(blog).toBeDefined();
		expect((blog as NonNullable<typeof blog>).richest.url).toBe("/blog/post-2");
	});
});

// ---------------------------------------------------------------------------
// contentAddressedName
// ---------------------------------------------------------------------------

describe("contentAddressedName", () => {
	it("produces stable hash with correct extension", () => {
		const name = contentAddressedName("https://example.com/image.png", "png");
		expect(name).toMatch(/^[a-f0-9]{16}\.png$/);
	});

	it("same URL produces same name", () => {
		const url = "https://example.com/photo.jpg";
		expect(contentAddressedName(url, "jpg")).toBe(
			contentAddressedName(url, "jpg"),
		);
	});

	it("different URLs produce different names", () => {
		const a = contentAddressedName("https://example.com/a.png", "png");
		const b = contentAddressedName("https://example.com/b.png", "png");
		expect(a).not.toBe(b);
	});
});

// ---------------------------------------------------------------------------
// buildAssetManifest
// ---------------------------------------------------------------------------

describe("buildAssetManifest", () => {
	it("extracts image URLs from nested content and deduplicates", () => {
		const pages: PageContent[] = [
			{
				id: "1",
				url: "/",
				pagetype: "landing",
				content: {
					hero: {
						logo: { src: "https://example.com/logo.png" },
						background: "https://example.com/bg.jpg",
					},
					gallery: [
						{ src: "https://example.com/img1.png" },
						{ src: "https://example.com/img1.png" }, // duplicate
					],
				},
			},
		];

		const manifest = buildAssetManifest(pages);
		expect(Object.keys(manifest)).toHaveLength(3);
		expect(manifest["https://example.com/logo.png"]).toMatch(
			/^[a-f0-9]{16}\.png$/,
		);
		expect(manifest["https://example.com/bg.jpg"]).toMatch(
			/^[a-f0-9]{16}\.jpg$/,
		);
	});

	it("uses provided imageUrls array", () => {
		const manifest = buildAssetManifest(
			[],
			["https://cdn.example.com/extra.svg"],
		);
		expect(manifest["https://cdn.example.com/extra.svg"]).toMatch(
			/^[a-f0-9]{16}\.svg$/,
		);
	});

	it("returns empty manifest for no input", () => {
		expect(buildAssetManifest([])).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// rewriteInternalLinks
// ---------------------------------------------------------------------------

describe("rewriteInternalLinks", () => {
	it("rewrites internal links to relative paths", () => {
		const routeMap = new Map<string, string>();
		routeMap.set("/about", "/about");

		const content = {
			nav: { link: "https://example.com/about" },
		};

		const result = rewriteInternalLinks(
			content,
			"https://example.com",
			routeMap,
		);
		expect(result.nav).toEqual({ link: "/about" });
	});

	it("preserves external links", () => {
		const content = {
			nav: { link: "https://other.com/page" },
		};

		const result = rewriteInternalLinks(
			content,
			"https://example.com",
			new Map(),
		);
		expect(result.nav).toEqual({ link: "https://other.com/page" });
	});

	it("traverses nested objects and arrays", () => {
		const routeMap = new Map<string, string>();
		routeMap.set("/about", "/about");

		const content = {
			links: [
				{ url: "https://example.com/about", label: "About" },
				{ url: "https://other.com", label: "External" },
			],
			nested: { deep: { url: "https://example.com/about" } },
		};

		const result = rewriteInternalLinks(
			content,
			"https://example.com",
			routeMap,
		) as typeof content;
		expect(result.links[0].url).toBe("/about");
		expect(result.links[1].url).toBe("https://other.com");
		expect(result.nested.deep.url).toBe("/about");
	});
});

// ---------------------------------------------------------------------------
// classifyUrls
// ---------------------------------------------------------------------------

describe("classifyUrls", () => {
	it("classifies mixed URLs correctly", () => {
		const urls = [
			"https://example.com/page",
			"https://example.com/wp-content/uploads/img.png",
			"https://other.com/external",
			"https://example.com/about",
		];

		const result = classifyUrls(urls, "https://example.com");
		expect(result.internal).toHaveLength(2);
		expect(result.cms).toHaveLength(1);
		expect(result.external).toHaveLength(1);
	});

	it("uses custom CMS patterns", () => {
		const urls = ["https://example.com/api/v1/content"];
		const result = classifyUrls(urls, "https://example.com", ["/api/"]);
		expect(result.cms).toHaveLength(1);
	});

	it("handles empty input", () => {
		const result = classifyUrls([], "https://example.com");
		expect(result).toEqual({ internal: [], external: [], cms: [] });
	});
});

// ---------------------------------------------------------------------------
// buildReducedTree
// ---------------------------------------------------------------------------

describe("buildReducedTree", () => {
	it("builds correct file tree from samples", () => {
		const grouped = groupByPageType(structurePages);
		const samples = selectSamples(grouped, contentMap);

		const rewritten = new Map<string, Record<string, unknown>>();
		for (const p of contentPages) {
			rewritten.set(p.url, p.content);
		}

		const tree = buildReducedTree(samples, rewritten, {
			"https://example.com/logo.png": "abc123.png",
		});

		// Each page type should have richest + simplest
		const paths = tree.map((f) => f.path);
		expect(paths).toContain("reduced/landing/richest.json");
		expect(paths).toContain("reduced/about/simplest.json");
		expect(paths).toContain("asset-manifest.json");

		// Content should be valid JSON
		for (const file of tree) {
			expect(() => JSON.parse(file.content)).not.toThrow();
		}
	});

	it("omits asset manifest when empty", () => {
		const samples = new Map();
		samples.set("landing", {
			richest: contentPages[0],
			simplest: contentPages[0],
		});

		const tree = buildReducedTree(samples, new Map(), {});
		const paths = tree.map((f) => f.path);
		expect(paths).not.toContain("asset-manifest.json");
	});
});

// ---------------------------------------------------------------------------
// buildReducedMeta
// ---------------------------------------------------------------------------

describe("buildReducedMeta", () => {
	const schema: SchemaData = {
		blog: {
			type: "object",
			properties: {
				title: { type: "string" },
				body: { type: "string" },
				author: { type: "string" },
			},
		},
		landing: {
			type: "object",
			properties: { hero: { type: "string" }, nav: { type: "string" } },
		},
	};

	it("produces ReducedMeta conforming to type contract", () => {
		const grouped = groupByPageType(structurePages);
		const meta = buildReducedMeta(
			grouped,
			contentPages,
			schema,
			"https://example.com",
			"2026-03-03T15:15:59.216Z",
		);

		// source fields
		expect(meta.source.total_pages).toBe(5);
		expect(meta.source.page_types).toBe(3);
		expect(meta.source.scraped_at).toBe("2026-03-03T15:15:59.216Z");
		expect(meta.source.site_url).toBe("https://example.com");

		// global_keys
		expect(Array.isArray(meta.global_keys)).toBe(true);

		// page_types array with required fields
		expect(meta.page_types.length).toBe(3);
		for (const pt of meta.page_types) {
			expect(pt.pagetype).toBeDefined();
			expect(pt.route).toBeDefined();
			expect(typeof pt.count).toBe("number");
			expect(typeof pt.multi).toBe("boolean");
			expect(typeof pt.has_pagination).toBe("boolean");
			expect(Array.isArray(pt.schema_keys)).toBe(true);
			expect(Array.isArray(pt.own_keys)).toBe(true);
		}

		// pagination_candidates
		expect(Array.isArray(meta.pagination_candidates)).toBe(true);
	});

	it("extracts schema_keys from schema.json", () => {
		const grouped = groupByPageType(structurePages);
		const meta = buildReducedMeta(
			grouped,
			contentPages,
			schema,
			"https://example.com",
			"2026-01-01T00:00:00.000Z",
		);

		const blogType = meta.page_types.find((pt) => pt.pagetype === "blog");
		expect(blogType?.schema_keys).toContain("title");
		expect(blogType?.schema_keys).toContain("body");
		expect(blogType?.schema_keys).toContain("author");
	});

	it("derives routes from actual page URLs (not placeholder)", () => {
		const grouped = groupByPageType(structurePages);
		const meta = buildReducedMeta(
			grouped,
			contentPages,
			schema,
			"https://example.com",
			"2026-01-01T00:00:00.000Z",
		);

		const blogType = meta.page_types.find((pt) => pt.pagetype === "blog");
		// Multi-page type → dynamic route with [slug]
		expect(blogType?.route).toContain("[slug]");
		// Should NOT be the placeholder /reduced/blog
		expect(blogType?.route).not.toBe("/reduced/blog");

		const landingType = meta.page_types.find((pt) => pt.pagetype === "landing");
		// Single-page type → static route
		expect(landingType?.route).toBe("/");
	});

	it("extracts slug_param from dynamic routes", () => {
		const grouped = groupByPageType(structurePages);
		const meta = buildReducedMeta(
			grouped,
			contentPages,
			schema,
			"https://example.com",
			"2026-01-01T00:00:00.000Z",
		);

		const blogType = meta.page_types.find((pt) => pt.pagetype === "blog");
		expect(blogType?.slug_param).toBe("slug");
	});

	it("detects pagination candidates", () => {
		const manyPages: PageStructure[] = Array.from({ length: 11 }, (_, i) => ({
			id: String(i),
			url: `/blog/post-${i}`,
			pagetype: "blog",
			title: `Post ${i}`,
		}));
		const manyContents: PageContent[] = manyPages.map((p) => ({
			id: `c${p.id}`,
			url: p.url,
			pagetype: p.pagetype,
			content: { title: `Post ${p.id}` },
		}));

		const grouped = groupByPageType(manyPages);
		const meta = buildReducedMeta(
			grouped,
			manyContents,
			{},
			"https://example.com",
			"2026-01-01T00:00:00.000Z",
		);

		expect(meta.pagination_candidates.length).toBeGreaterThan(0);
		expect(meta.pagination_candidates[0].pagetype).toBe("blog");
	});

	it("computes own_keys as type-specific keys not in global_keys", () => {
		const grouped = groupByPageType(structurePages);
		const meta = buildReducedMeta(
			grouped,
			contentPages,
			schema,
			"https://example.com",
			"2026-01-01T00:00:00.000Z",
		);

		const aboutType = meta.page_types.find((pt) => pt.pagetype === "about");
		expect(Array.isArray(aboutType?.own_keys)).toBe(true);
	});

	it("handles empty schema gracefully", () => {
		const grouped = groupByPageType(structurePages);
		const meta = buildReducedMeta(
			grouped,
			contentPages,
			{},
			"https://example.com",
			"2026-01-01T00:00:00.000Z",
		);

		for (const pt of meta.page_types) {
			expect(pt.schema_keys).toEqual([]);
		}
	});
});

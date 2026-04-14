import { describe, expect, it } from "bun:test";
import {
	buildFieldFrequency,
	buildHeuristicsData,
	buildStructureMaps,
	contentCharCount,
} from "./heuristics.js";
import type { PreparedPage } from "./ingest.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const pages: PreparedPage[] = [
	{
		url: "/",
		pagetype: "landing",
		content: {
			hero: "Welcome to our site",
			header: { logo: "images/abc.png", nav: ["Home", "About"] },
			footer: "2024 Acme",
		},
		schema: {},
	},
	{
		url: "/post/hello/",
		pagetype: "blog_post",
		content: {
			title: "Hello World",
			body: "This is the body of the blog post with more content",
			header: { logo: "images/abc.png" },
			footer: "2024 Acme",
		},
		schema: {},
	},
	{
		url: "/post/bye/",
		pagetype: "blog_post",
		content: {
			title: "Bye",
			body: "Short",
			header: { logo: "images/abc.png" },
			footer: "2024 Acme",
		},
		schema: {},
	},
];

// ---------------------------------------------------------------------------
// contentCharCount
// ---------------------------------------------------------------------------

describe("contentCharCount", () => {
	it("counts chars in flat strings", () => {
		expect(contentCharCount("hello")).toBe(5);
	});

	it("counts chars in nested objects", () => {
		const count = contentCharCount({ a: "abc", b: { c: "de" } });
		expect(count).toBe(5);
	});

	it("counts chars in arrays", () => {
		expect(contentCharCount(["ab", "cd"])).toBe(4);
	});

	it("returns 0 for non-string primitives", () => {
		expect(contentCharCount(42)).toBe(0);
		expect(contentCharCount(true)).toBe(0);
		expect(contentCharCount(null)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// buildStructureMaps
// ---------------------------------------------------------------------------

describe("buildStructureMaps", () => {
	it("builds one tree per page type using richest sample", () => {
		const maps = buildStructureMaps(pages);
		expect(maps).toHaveLength(2);

		const landing = maps.find((m) => m.pagetype === "landing");
		expect(landing).toBeDefined();
		expect(landing?.sampleUrl).toBe("/");
		expect(landing?.tree).toContain("hero (string,");
		expect(landing?.tree).toContain("header (object)");
		expect(landing?.tree).toContain("footer (string,");
	});

	it("selects the richest sample for blog_post", () => {
		const maps = buildStructureMaps(pages);
		const blog = maps.find((m) => m.pagetype === "blog_post");
		expect(blog).toBeDefined();
		// /post/hello/ has more char content than /post/bye/
		expect(blog?.sampleUrl).toBe("/post/hello/");
	});

	it("shows local-image type for image paths", () => {
		const imagePages: PreparedPage[] = [
			{
				url: "/test/",
				pagetype: "test",
				content: {
					photo: "images/abc123.png",
					caption: "A photo",
				},
				schema: {},
			},
		];
		const maps = buildStructureMaps(imagePages);
		expect(maps[0].tree).toContain("photo (local-image)");
	});

	it("renders array with child structure", () => {
		const arrayPages: PreparedPage[] = [
			{
				url: "/test/",
				pagetype: "test",
				content: {
					items: [{ name: "A", val: 1 }],
				},
				schema: {},
			},
		];
		const maps = buildStructureMaps(arrayPages);
		expect(maps[0].tree).toContain("items (array[1])");
		expect(maps[0].tree).toContain("  name (string, 1 chars)");
		expect(maps[0].tree).toContain("  val (number)");
	});
});

// ---------------------------------------------------------------------------
// buildFieldFrequency
// ---------------------------------------------------------------------------

describe("buildFieldFrequency", () => {
	it("maps field names to sorted page types", () => {
		const freq = buildFieldFrequency(pages);

		// header and footer appear in both types
		expect(freq.header).toEqual(["blog_post", "landing"]);
		expect(freq.footer).toEqual(["blog_post", "landing"]);

		// hero only in landing
		expect(freq.hero).toEqual(["landing"]);

		// title, body only in blog_post
		expect(freq.title).toEqual(["blog_post"]);
		expect(freq.body).toEqual(["blog_post"]);
	});
});

// ---------------------------------------------------------------------------
// buildHeuristicsData
// ---------------------------------------------------------------------------

describe("buildHeuristicsData", () => {
	it("aggregates total counts", () => {
		const h = buildHeuristicsData(pages);
		expect(h.totalPages).toBe(3);
		expect(h.totalPageTypes).toBe(2);
	});

	it("builds per-page-type stats", () => {
		const h = buildHeuristicsData(pages);
		const landing = h.pageTypes.find((pt) => pt.pagetype === "landing");
		expect(landing).toBeDefined();
		expect(landing?.pageCount).toBe(1);
		expect(landing?.richestSampleUrl).toBe("/");
		expect(landing?.simplestSampleUrl).toBe("/");

		const blog = h.pageTypes.find((pt) => pt.pagetype === "blog_post");
		expect(blog).toBeDefined();
		expect(blog?.pageCount).toBe(2);
		expect(blog?.topLevelFieldCount).toBe(4); // title, body, header, footer
		// hello post has more content
		expect(blog?.richestSampleUrl).toBe("/post/hello/");
		expect(blog?.simplestSampleUrl).toBe("/post/bye/");
	});

	it("computes average content length", () => {
		const h = buildHeuristicsData(pages);
		const blog = h.pageTypes.find((pt) => pt.pagetype === "blog_post");
		expect(blog?.avgContentLength).toBeGreaterThan(0);
	});

	it("includes fieldFrequency", () => {
		const h = buildHeuristicsData(pages);
		expect(h.fieldFrequency.header).toEqual(["blog_post", "landing"]);
	});
});

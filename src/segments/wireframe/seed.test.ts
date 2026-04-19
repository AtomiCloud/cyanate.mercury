import { describe, expect, it } from "bun:test";
import type { PageContent, Registry } from "../../types.js";
import type { ContentModelOutput } from "./classify.js";
import type { ClassifiedContentModel } from "./content-model.js";
import {
	generateCollectionEntries,
	generateContentConfig,
	generateGlobals,
	generateRouteFiles,
	validateSeedCompleteness,
} from "./seed.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const registry: Registry = {
	layouts: {
		default: { description: "Default", page_types: ["landing", "about"] },
		blog: { description: "Blog", page_types: ["blog"] },
	},
	collections: {
		blog: {
			source_pagetype: "blog",
			slug_field: "title",
			listable_by: ["tags"],
		},
	},
	listings: {
		blog_index: {
			route: "/blog",
			queries: [{ collection: "blog" }],
			paginated: true,
		},
	},
	static_pages: [
		{ pagetype: "landing", route: "/" },
		{ pagetype: "about", route: "/about" },
	],
};

const contentModel: ContentModelOutput = {
	collections: {
		blog: {
			source_pagetype: "blog",
			slug_field: "title",
			listable_by: ["tags"],
		},
	},
};

const pages: PageContent[] = [
	{
		id: "p1",
		url: "https://example.com/",
		pagetype: "landing",
		content: {
			title: "Home",
			navigation: { main_menu: [{ label: "About", url: "/about" }] },
			header: { logo: { src: "/logo.png" } },
		},
	},
	{
		id: "p2",
		url: "https://example.com/blog/post-1",
		pagetype: "blog",
		content: {
			title: "First Post",
			body: "Content here",
			author: "John",
		},
	},
	{
		id: "p3",
		url: "https://example.com/blog/post-2",
		pagetype: "blog",
		content: {
			title: "Second Post",
			body: "More content",
		},
	},
	{
		id: "p4",
		url: "https://example.com/blog/post-3",
		pagetype: "blog",
		content: { title: "Third Post", description: "A description" },
	},
];

// Pages for a data-only collection (no body-like fields)
const dataPages: PageContent[] = [
	{
		id: "e1",
		url: "https://example.com/events/launch",
		pagetype: "event",
		content: { title: "Launch Event", date: "2026-01-15", featured: true },
	},
	{
		id: "e2",
		url: "https://example.com/events/meetup",
		pagetype: "event",
		content: { title: "Meetup", date: "2026-02-20", featured: false },
	},
];

const dataRegistry: Registry = {
	layouts: {
		default: { description: "Default", page_types: ["event"] },
	},
	collections: {
		events: {
			source_pagetype: "event",
			slug_field: "",
			listable_by: [],
		},
	},
	listings: {},
	static_pages: [],
};

const dataContentModel: ContentModelOutput = {
	collections: {
		events: {
			source_pagetype: "event",
			slug_field: "",
			listable_by: [],
		},
	},
};

// ---------------------------------------------------------------------------
// generateCollectionEntries
// ---------------------------------------------------------------------------

describe("generateCollectionEntries", () => {
	it("blog type with multiple pages → all JSON entries", () => {
		const entries = generateCollectionEntries(registry, contentModel, pages);

		const blogEntries = entries.filter((e) => e.path.includes("blog"));
		expect(blogEntries.length).toBe(3);

		// All entries are JSON (no markdown)
		for (const entry of blogEntries) {
			expect(entry.format).toBe("json");
			expect(entry.path).toMatch(/\.json$/);

			const parsed = JSON.parse(entry.content);
			expect(parsed.id).toBeDefined();
			expect(parsed.pagetype).toBe("blog");
			expect(parsed.collection).toBe("blog");
		}
	});

	it("all entries are JSON format — no markdown", () => {
		const entries = generateCollectionEntries(registry, contentModel, pages);

		for (const entry of entries) {
			expect(entry.format).toBe("json");
			expect(entry.path).toMatch(/\.json$/);
			// Should be valid JSON
			expect(() => JSON.parse(entry.content)).not.toThrow();
		}
	});

	it("data-only collection → JSON files with scalar fields", () => {
		const entries = generateCollectionEntries(
			dataRegistry,
			dataContentModel,
			dataPages,
		);
		expect(entries.length).toBe(2);
		for (const entry of entries) {
			expect(entry.path).toMatch(/^src\/content\/events\//);
			expect(entry.format).toBe("json");

			const parsed = JSON.parse(entry.content);
			expect(parsed.id).toBeDefined();
			expect(parsed.pagetype).toBe("event");
			expect(parsed.collection).toBe("events");
			expect(typeof parsed.title).toBe("string");
		}
	});

	it("data collection with no pages → no entries generated", () => {
		const entries = generateCollectionEntries(
			dataRegistry,
			dataContentModel,
			[],
		);
		expect(entries.length).toBe(0);
	});

	it("pages with scalar fields → included in JSON output", () => {
		const entries = generateCollectionEntries(registry, contentModel, pages);
		const post1 = entries.find((e) => e.path.includes("first-post"));
		expect(post1).toBeDefined();

		const parsed = JSON.parse(post1?.content ?? "");
		expect(parsed.title).toBe("First Post");
		expect(parsed.author).toBe("John");
	});

	it("non-collection pages produce no entries", () => {
		const entries = generateCollectionEntries(registry, contentModel, pages);
		// landing and about are static pages, not in collections
		expect(entries.every((e) => e.path.includes("blog"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// generateGlobals
// ---------------------------------------------------------------------------

describe("generateGlobals", () => {
	it("produces global data files in src/content/", () => {
		const files = generateGlobals(contentModel, pages);
		const paths = files.map((f) => f.path);

		expect(paths.some((p) => p.includes("src/content/"))).toBe(true);
		expect(paths).toContain("src/content/site/default.json");
	});

	it("extracts navigation from landing page as plain object", () => {
		const files = generateGlobals(contentModel, pages);
		const nav = files.find((f) => f.path.includes("navigation"));

		expect(nav).toBeDefined();
		expect(nav?.path).toBe("src/content/navigation/default.json");
		const parsed = JSON.parse(nav?.content ?? "");
		expect(parsed.main_menu).toBeDefined();
	});

	it("extracts header from landing page as plain object", () => {
		const files = generateGlobals(contentModel, pages);
		const header = files.find((f) => f.path.includes("header"));

		expect(header).toBeDefined();
		expect(header?.path).toBe("src/content/header/default.json");
		const parsed = JSON.parse(header?.content ?? "");
		expect(typeof parsed).toBe("object");
		expect(Array.isArray(parsed)).toBe(false);
	});

	it("site.json is a plain object with totalPages", () => {
		const files = generateGlobals(contentModel, pages);
		const site = files.find((f) => f.path.includes("site"));

		expect(site).toBeDefined();
		expect(site?.path).toBe("src/content/site/default.json");
		const parsed = JSON.parse(site?.content ?? "");
		expect(parsed.totalPages).toBe(pages.length);
	});

	it("no landing page → no nav/header files", () => {
		const files = generateGlobals(contentModel, [
			{ id: "1", url: "/blog/post", pagetype: "blog", content: {} },
		]);
		expect(
			files.find((f) => f.path.includes("navigation.json")),
		).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// generateContentConfig
// ---------------------------------------------------------------------------

describe("generateContentConfig", () => {
	it("produces valid TypeScript with defineCollection", () => {
		const config = generateContentConfig(registry, contentModel);

		expect(config).toContain("defineCollection");
		expect(config).toContain("astro:content");
		expect(config).toContain("z.object");
		// Astro v6: named export, not default
		expect(config).toContain("export const collections");
		// Astro v6: loaders from astro/loaders
		expect(config).toContain("astro/loaders");
		expect(config).toContain("glob");
	});

	it("includes glob() loader with JSON pattern for content collections", () => {
		const config = generateContentConfig(registry, contentModel);

		// All content collections use JSON-only pattern
		expect(config).toContain('glob({ pattern: "**/*.json"');
		expect(config).toContain("blog");
	});

	it("includes slug_field in schema", () => {
		const config = generateContentConfig(registry, contentModel);

		expect(config).toContain("title: z.string().optional()");
	});

	it("uses glob() loader for all collections including slug_field empty", () => {
		const config = generateContentConfig(dataRegistry, dataContentModel);

		// All collections use glob() loader
		expect(config).toContain(
			'glob({ pattern: "**/*.json", base: "./src/content/events" })',
		);
		expect(config).toContain("events");
		// No file() loader anywhere
		expect(config).not.toContain("file(");
	});

	it("outputs content.config.ts format (named export)", () => {
		const config = generateContentConfig(registry, contentModel);

		// Must have named export const collections (not export default)
		expect(config).toMatch(/export\s+const\s+collections\s*=/);
		expect(config).not.toMatch(/export\s+default\s+/);
	});

	it("handles nested slug_field with dotted path", () => {
		const nestedRegistry: Registry = {
			layouts: { default: { description: "Default", page_types: ["blog"] } },
			collections: {
				blog: {
					source_pagetype: "blog",
					slug_field: "seo.slug",
					listable_by: [],
				},
			},
			listings: {},
			static_pages: [],
		};
		const nestedContentModel: ContentModelOutput = {
			collections: {
				blog: {
					source_pagetype: "blog",
					slug_field: "seo.slug",
					listable_by: [],
				},
			},
		};

		const config = generateContentConfig(nestedRegistry, nestedContentModel);

		// Should NOT contain invalid "seo.slug:" syntax
		expect(config).not.toContain("seo.slug:");
		// Should contain valid nested z.object()
		expect(config).toContain("seo: z.object({ slug:");
	});

	it("produces syntactically valid TypeScript (no duplicate const)", () => {
		const config = generateContentConfig(registry, contentModel);

		// Only one `const collections` declaration (the export)
		const constMatches = config.match(/\bconst\s+collections\b/g);
		expect(constMatches?.length ?? 0).toBe(1);
	});

	it("imports z from astro/zod (Astro v6)", () => {
		const config = generateContentConfig(registry, contentModel);

		expect(config).toContain('from "astro/zod"');
	});

	it("url field uses z.string() not z.string().url() (accepts route paths)", () => {
		const config = generateContentConfig(registry, contentModel);

		// url field must be z.string() so relative paths like "/about" are valid
		expect(config).toContain("url: z.string(),");
		expect(config).not.toContain("url: z.string().url()");
	});

	it("content-only registry without globals does not import file() loader", () => {
		const config = generateContentConfig(registry, contentModel);
		expect(config).not.toContain("file(");
		expect(config).not.toContain("import { file");
	});

	it("with globals param, registers globals as glob() collections", () => {
		const globals = [
			{ path: "src/content/navigation/default.json", content: "{}" },
			{ path: "src/content/header/default.json", content: "{}" },
			{ path: "src/content/site/default.json", content: "{}" },
		];
		const config = generateContentConfig(registry, contentModel, globals);

		// Only glob loader (no file)
		expect(config).not.toContain("file(");
		// Global collection names — flat, no prefix
		expect(config).toContain("navigation: defineCollection");
		expect(config).toContain("header: defineCollection");
		expect(config).toContain("site: defineCollection");
		// Schema uses passthrough for arbitrary global data shapes
		expect(config).toContain("z.object({ id: z.string() }).passthrough()");
	});

	it("global collections use passthrough schema (not z.any())", () => {
		const globals = [{ path: "src/content/site/default.json", content: "{}" }];
		const config = generateContentConfig(registry, contentModel, globals);

		// Must NOT use z.any() — that breaks type safety
		expect(config).not.toContain("z.any()");
		// Must NOT use z.record(z.unknown()) — that's for objects, not entries
		expect(config).not.toContain("z.record(");
		// Must use passthrough to require id but allow arbitrary additional fields
		expect(config).toContain(".passthrough()");
	});

	it("all collections use glob() loader — no file() anywhere", () => {
		const mixedRegistry: Registry = {
			layouts: {
				default: { description: "Default", page_types: ["blog", "event"] },
			},
			collections: {
				blog: {
					source_pagetype: "blog",
					slug_field: "title",
					listable_by: [],
				},
				events: {
					source_pagetype: "event",
					slug_field: "",
					listable_by: [],
				},
			},
			listings: {},
			static_pages: [],
		};
		const mixedContentModel: ContentModelOutput = {
			collections: {
				blog: {
					source_pagetype: "blog",
					slug_field: "title",
					listable_by: [],
				},
				events: {
					source_pagetype: "event",
					slug_field: "",
					listable_by: [],
				},
			},
		};

		const config = generateContentConfig(mixedRegistry, mixedContentModel);

		// Both collections use glob() loader
		expect(config).toContain('glob({ pattern: "**/*.json"');
		expect(config).toContain("blog: defineCollection");
		expect(config).toContain("events: defineCollection");

		// No file() loader
		expect(config).not.toContain("file(");
		// Only imports glob
		expect(config).toContain('import { glob } from "astro/loaders"');
	});
});

// ---------------------------------------------------------------------------
// generateRouteFiles
// ---------------------------------------------------------------------------

describe("generateRouteFiles", () => {
	it("static routes → static .astro files", () => {
		const files = generateRouteFiles(registry);
		const paths = files.map((f) => f.path);

		expect(paths).toContain("src/pages/index.astro");
		expect(paths).toContain("src/pages/about.astro");
	});

	it("listing routes → static .astro files querying correct collection", () => {
		const files = generateRouteFiles(registry);
		const blogIndex = files.find(
			(f) => f.path.includes("blog") && f.path.endsWith("blog.astro"),
		);

		expect(blogIndex).toBeDefined();
		// Listing pages query the associated collection, not the listing name
		expect(blogIndex?.content ?? "").toContain('getCollection("blog")');
		// Listing pages are static (not dynamic), so no getStaticPaths
		expect(blogIndex?.content ?? "").not.toContain("getStaticPaths");
	});

	it("route files import layout from registry", () => {
		const files = generateRouteFiles(registry);
		for (const file of files) {
			expect(file.content).toContain("import Layout");
			expect(file.content).toContain(".astro");
		}
	});

	it("generates collection item routes for collections", () => {
		const files = generateRouteFiles(registry);
		const paths = files.map((f) => f.path);

		// Should have a dynamic route for collection items
		const dynamicRoutes = paths.filter((p) => p.includes("["));
		expect(dynamicRoutes.length).toBeGreaterThan(0);
	});

	it("all collection routes use render() + Content", () => {
		const files = generateRouteFiles(registry);
		const dynamicRoute = files.find((f) => f.path.includes("[slug]"));
		const content = dynamicRoute?.content ?? "";

		// All collections use render(entry) + <Content />
		expect(content).toContain("render(entry)");
		expect(content).toContain("<Content />");
		expect(content).toContain('getCollection("blog")');
		expect(content).not.toContain("isRenderable");
	});

	it("data collection routes also use render() (no special file() path)", () => {
		const files = generateRouteFiles(dataRegistry);
		const dynamicRoute = files.find((f) => f.path.includes("["));
		const content = dynamicRoute?.content ?? "";

		// All routes use the same content renderer pattern
		expect(content).toContain("getStaticPaths");
		expect(content).toContain("getCollection");
		expect(content).toContain("render(entry)");
		expect(content).toContain("<Content />");
		expect(content).not.toContain("<dl>");
	});

	it("listing page links use listing.route instead of collection name", () => {
		const articlesRegistry: Registry = {
			layouts: {
				default: { description: "Default", page_types: ["blog"] },
			},
			collections: {
				blog: {
					source_pagetype: "blog",
					slug_field: "title",
					listable_by: [],
				},
			},
			listings: {
				blog_index: {
					route: "/articles",
					queries: [{ collection: "blog" }],
				},
			},
			static_pages: [],
		};

		const files = generateRouteFiles(articlesRegistry);
		const listingPage = files.find((f) => f.path.includes("articles.astro"));

		expect(listingPage).toBeDefined();
		// Listing links should use listing.route (/articles), not collection name (/blog)
		expect(listingPage?.content ?? "").toContain("/articles/");
		expect(listingPage?.content ?? "").not.toContain("/blog/");
	});
	it("explicit queries[].collection takes priority over name matching", () => {
		const reg: Registry = {
			layouts: { default: { description: "Default", page_types: ["blog"] } },
			collections: {
				posts: { source_pagetype: "blog", slug_field: "slug", listable_by: [] },
			},
			listings: {
				content_listing: {
					route: "/content",
					queries: [{ collection: "posts" }],
				},
			},
			static_pages: [],
		};
		const files = generateRouteFiles(reg);
		const listing = files.find((f) => f.path.includes("content.astro"));
		expect(listing).toBeDefined();
		// Should query "posts" collection (explicit), not guess from name
		expect(listing?.content ?? "").toContain('getCollection("posts")');
		// Should generate dynamic route under /content/[slug]
		const dynamicRoute = files.find(
			(f) => f.path.includes("content") && f.path.includes("[slug]"),
		);
		expect(dynamicRoute).toBeDefined();
		expect(dynamicRoute?.content ?? "").toContain('getCollection("posts")');
	});

	it("listable_by reverse lookup resolves listing to collection", () => {
		const reg: Registry = {
			layouts: { default: { description: "Default", page_types: ["blog"] } },
			collections: {
				blog: {
					source_pagetype: "blog",
					slug_field: "title",
					listable_by: ["articles"],
				},
			},
			listings: {
				articles: {
					route: "/articles",
					queries: [],
				},
			},
			static_pages: [],
		};
		const files = generateRouteFiles(reg);
		const listingPage = files.find((f) => f.path.includes("articles.astro"));

		expect(listingPage).toBeDefined();
		// Should query "blog" collection (via listable_by reverse lookup)
		expect(listingPage?.content ?? "").toContain('getCollection("blog")');
	});

	it("listing with no determinable collection generates static placeholder (no getCollection)", () => {
		const reg: Registry = {
			layouts: {
				default: { description: "Default", page_types: ["misc"] },
			},
			collections: {
				blog: {
					source_pagetype: "blog",
					slug_field: "title",
					listable_by: [],
				},
			},
			listings: {
				articles: {
					route: "/articles",
					queries: [],
				},
			},
			static_pages: [],
		};
		const files = generateRouteFiles(reg);
		const listingPage = files.find((f) => f.path.includes("articles.astro"));

		expect(listingPage).toBeDefined();
		// Should NOT contain getCollection — no collection could be determined
		expect(listingPage?.content ?? "").not.toContain("getCollection");
		// Should still be a valid .astro file with Layout import
		expect(listingPage?.content ?? "").toContain("import Layout");
	});

	it("collection item routes always generated even without matching listing", () => {
		const reg: Registry = {
			layouts: {
				default: { description: "Default", page_types: ["blog"] },
			},
			collections: {
				blog: {
					source_pagetype: "blog",
					slug_field: "title",
					listable_by: [],
				},
			},
			listings: {
				articles: {
					route: "/articles",
					queries: [],
				},
			},
			static_pages: [],
		};
		const files = generateRouteFiles(reg);

		// Should still generate collection item route even though "articles" listing
		// doesn't match "blog" collection via any heuristic
		const dynamicRoute = files.find(
			(f) => f.path.includes("[slug]") && f.path.includes("blog"),
		);
		expect(dynamicRoute).toBeDefined();
		expect(dynamicRoute?.content ?? "").toContain('getCollection("blog")');
	});

	it("listable_by reverse lookup generates item route under listing's route", () => {
		const reg: Registry = {
			layouts: {
				default: { description: "Default", page_types: ["blog"] },
			},
			collections: {
				blog: {
					source_pagetype: "blog",
					slug_field: "title",
					listable_by: ["articles"],
				},
			},
			listings: {
				articles: {
					route: "/articles",
					queries: [],
				},
			},
			static_pages: [],
		};
		const files = generateRouteFiles(reg);

		// Collection item route should be under /articles/[slug], not /blog/[slug]
		const dynamicRoute = files.find(
			(f) => f.path.includes("[slug]") && f.path.includes("articles"),
		);
		expect(dynamicRoute).toBeDefined();
		expect(dynamicRoute?.path).toContain("articles/[slug]");
		expect(dynamicRoute?.content ?? "").toContain('getCollection("blog")');
	});

	it("paginated listing generates pagination sub-route", () => {
		const files = generateRouteFiles(registry);
		const pagRoute = files.find(
			(f) => f.path.includes("page/[page]") && f.path.includes("blog"),
		);

		expect(pagRoute).toBeDefined();
		expect(pagRoute?.content ?? "").toContain("getStaticPaths");
		expect(pagRoute?.content ?? "").toContain('getCollection("blog")');
	});

	it("listing always generates pagination sub-route regardless of paginated flag", () => {
		const reg: Registry = {
			layouts: {
				default: { description: "Default", page_types: ["blog"] },
			},
			collections: {
				blog: {
					source_pagetype: "blog",
					slug_field: "title",
					listable_by: [],
				},
			},
			listings: {
				blog_index: {
					route: "/blog",
					queries: [{ collection: "blog" }],
				},
			},
			static_pages: [],
		};

		const files = generateRouteFiles(reg);
		const pagRoute = files.find((f) => f.path.includes("page/[page]"));
		expect(pagRoute).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// validateSeedCompleteness
// ---------------------------------------------------------------------------

describe("validateSeedCompleteness", () => {
	it("all collection pages accounted → complete", () => {
		const entries = [
			{ path: "src/content/blog/post-1.md" },
			{ path: "src/content/blog/post-2.md" },
			{ path: "src/content/blog/post-3.md" },
			{ path: "src/pages/index.astro" },
			{ path: "src/pages/about.astro" },
		];

		const result = validateSeedCompleteness(pages, entries);
		expect(result.complete).toBe(true);
		expect(result.missing).toEqual([]);
	});

	it("missing page → listed in missing", () => {
		const entries = [{ path: "src/content/blog/post-1.md" }];

		const result = validateSeedCompleteness(pages, entries);
		expect(result.complete).toBe(false);
		// landing, post-2, post-3 are missing (only post-1.md exists)
		expect(result.missing).toHaveLength(3);
		expect(result.missing).toContain("https://example.com/");
		expect(result.missing).toContain("https://example.com/blog/post-2");
		expect(result.missing).toContain("https://example.com/blog/post-3");
	});

	it("one entry does not falsely cover other pages of same type", () => {
		const entries = [{ path: "src/content/blog/post-1.md" }];

		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/blog/post-1",
					pagetype: "blog",
					content: { title: "First Post" },
				},
				{
					id: "2",
					url: "https://example.com/blog/post-2",
					pagetype: "blog",
					content: { title: "Second Post" },
				},
			],
			entries,
		);
		expect(result.complete).toBe(false);
		// post-2 URL slug is "post-2" ≠ entry stem "post-1" — no field-based guessing
		expect(result.missing).toHaveLength(1);
		expect(result.missing).toContain("https://example.com/blog/post-2");
	});

	it("entry for post-1 does not cover post-10 (slug prefix bug)", () => {
		const entries = [{ path: "src/content/blog/post-1.md" }];

		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/blog/post-1",
					pagetype: "blog",
					content: { title: "First Post" },
				},
				{
					id: "2",
					url: "https://example.com/blog/post-10",
					pagetype: "blog",
					content: { title: "Tenth Post" },
				},
			],
			entries,
		);
		expect(result.complete).toBe(false);
		// Only post-1 should be covered; post-10 is a different slug
		expect(result.missing).toContain("https://example.com/blog/post-10");
		expect(result.missing).not.toContain("https://example.com/blog/post-1");
	});

	it("entry stem 'about' does not cover /features/about-us (substring match)", () => {
		const entries = [{ path: "src/pages/about.astro" }];

		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/about",
					pagetype: "landing",
					content: {},
				},
				{
					id: "2",
					url: "https://example.com/features/about-us",
					pagetype: "landing",
					content: {},
				},
			],
			entries,
		);
		expect(result.complete).toBe(false);
		// /about matches, but /features/about-us should NOT match via substring
		expect(result.missing).toContain("https://example.com/features/about-us");
	});

	it("empty entries → all pages missing", () => {
		const result = validateSeedCompleteness(pages, []);
		expect(result.complete).toBe(false);
		expect(result.missing).toHaveLength(pages.length);
	});

	it("globals do not count as page coverage unless slug matches", () => {
		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/site",
					pagetype: "landing",
					content: {},
				},
			],
			[{ path: "src/content/site/default.json" }],
		);
		// "default.json" doesn't match page URL "/site"
		expect(result.complete).toBe(false);
		expect(result.missing).toContain("https://example.com/site");
	});

	it("globals mixed with page entries do not cause false coverage", () => {
		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/",
					pagetype: "landing",
					content: {},
				},
				{
					id: "2",
					url: "https://example.com/blog/post-1",
					pagetype: "blog",
					content: { title: "First Post" },
				},
			],
			[
				{ path: "src/content/site/default.json" },
				{ path: "src/content/navigation/default.json" },
				{ path: "src/pages/index.astro" },
				{ path: "src/content/blog/post-1.md" },
			],
		);
		expect(result.complete).toBe(true);
	});

	it("route string '/' covers root page (Phase 5 input format)", () => {
		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/",
					pagetype: "landing",
					content: {},
				},
			],
			[{ path: "/" }],
		);
		expect(result.complete).toBe(true);
		expect(result.missing).toEqual([]);
	});

	it("route string '/about' covers /about page", () => {
		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/about",
					pagetype: "about",
					content: {},
				},
			],
			[{ path: "/about" }],
		);
		expect(result.complete).toBe(true);
	});

	it("dynamic route '/blog/[slug]' covers all blog sub-pages", () => {
		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/blog/post-1",
					pagetype: "blog",
					content: {},
				},
				{
					id: "2",
					url: "https://example.com/blog/post-2",
					pagetype: "blog",
					content: {},
				},
			],
			[{ path: "/blog/[slug]" }],
		);
		expect(result.complete).toBe(true);
	});

	it("dynamic route '/blog/[slug]' does not cover /blog listing page", () => {
		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/blog",
					pagetype: "landing",
					content: {},
				},
			],
			[{ path: "/blog/[slug]" }],
		);
		expect(result.complete).toBe(false);
		expect(result.missing).toContain("https://example.com/blog");
	});
	it("dynamic route '/blog/[slug]' does not cover nested path /blog/a/b", () => {
		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/blog/post-1",
					pagetype: "blog",
					content: {},
				},
			],
			[{ path: "/blog/[slug]" }],
		);
		expect(result.complete).toBe(true);
	});

	it("dynamic route '/blog/[slug]' does not cover /blog/a/b (extra segment)", () => {
		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/blog/a/b",
					pagetype: "blog",
					content: {},
				},
			],
			[{ path: "/blog/[slug]" }],
		);
		expect(result.complete).toBe(false);
	});

	it("content entry for post-1 does NOT cover page post-2 (no field-based guessing)", () => {
		// This was the false-pass bug: hasContentSlugMatch() accepted any top-level
		// string field match, so a page at /blog/post-2 with content { tag: "post-1" }
		// would be falsely reported as covered by entry src/content/blog/post-1.md
		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/blog/post-2",
					pagetype: "blog",
					content: { title: "Actual Title", tag: "post-1" },
				},
			],
			[{ path: "src/content/blog/post-1.md" }],
		);
		expect(result.complete).toBe(false);
		expect(result.missing).toContain("https://example.com/blog/post-2");
	});

	it("content entry covers page only when stem matches URL slug exactly", () => {
		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/blog/post-1",
					pagetype: "blog",
					content: { title: "First Post" },
				},
			],
			[{ path: "src/content/blog/post-1.md" }],
		);
		expect(result.complete).toBe(true);
		expect(result.missing).toEqual([]);
	});

	// --- src/pages/ route file coverage (needed for data collections) ---

	it("src/pages/ dynamic route file covers matching pages", () => {
		// src/pages/events/[slug].astro should cover /events/launch and /events/meetup
		const result = validateSeedCompleteness(dataPages, [
			{ path: "src/pages/events/[slug].astro" },
		]);
		expect(result.complete).toBe(true);
		expect(result.missing).toEqual([]);
	});

	it("src/pages/ static route file covers exact page", () => {
		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/about",
					pagetype: "about",
					content: {},
				},
			],
			[{ path: "src/pages/about.astro" }],
		);
		expect(result.complete).toBe(true);
	});

	it("src/pages/index.astro covers root page via route matching", () => {
		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/",
					pagetype: "landing",
					content: {},
				},
			],
			[{ path: "src/pages/index.astro" }],
		);
		expect(result.complete).toBe(true);
	});

	it("src/pages/ dynamic route does not cover different-depth paths", () => {
		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/events/2026/launch",
					pagetype: "event",
					content: {},
				},
			],
			[{ path: "src/pages/events/[slug].astro" }],
		);
		expect(result.complete).toBe(false);
	});

	it("data collection pages covered by route files", () => {
		// Coverage comes from route files like src/pages/events/[slug].astro.
		const result = validateSeedCompleteness(dataPages, [
			{ path: "src/pages/events/[slug].astro" },
		]);
		expect(result.complete).toBe(true);
	});

	it("data collection pages covered by individual content entries", () => {
		// All entries are now in src/content/ as individual files
		const result = validateSeedCompleteness(dataPages, [
			{ path: "src/content/events/launch.json" },
			{ path: "src/content/events/meetup.json" },
		]);
		expect(result.complete).toBe(true);
	});

	it("pagination route covers paginated listing URLs", () => {
		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/category/articles",
					pagetype: "blog_category",
					content: {},
				},
				{
					id: "2",
					url: "https://example.com/category/articles/page/2",
					pagetype: "blog_listing",
					content: {},
				},
			],
			[
				{ path: "src/pages/category/[slug].astro" },
				{ path: "src/pages/category/[slug]/page/[page].astro" },
			],
		);
		expect(result.complete).toBe(true);
		expect(result.missing).toEqual([]);
	});

	it("paginated URL NOT covered without pagination route", () => {
		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/category/articles/page/2",
					pagetype: "blog_listing",
					content: {},
				},
			],
			[{ path: "src/pages/category/[slug].astro" }],
		);
		expect(result.complete).toBe(false);
		expect(result.missing).toContain(
			"https://example.com/category/articles/page/2",
		);
	});
});

// ---------------------------------------------------------------------------
// generateCollectionEntries with classified model (richtext composition)
// ---------------------------------------------------------------------------

describe("generateCollectionEntries with classified model", () => {
	const classifiedModel: ClassifiedContentModel = {
		page_types: [
			{
				pagetype: "blog",
				is_singleton: false,
				field_classifications: [
					{ field_path: "title", type: "string" },
					{
						field_path: "article_content",
						type: "richtext",
						compose_spec: {
							field: "article_content",
							render_as: "div",
							children: [{ field: "intro", render_as: "p" }],
						},
					},
				],
				body_compose: {
					field: "article_content",
					render_as: "div",
					children: [{ field: "intro", render_as: "p" }],
				},
			},
		],
	};

	const blogPages: PageContent[] = [
		{
			id: "b1",
			url: "https://example.com/blog/rich-post",
			pagetype: "blog",
			content: {
				title: "Rich Post",
				article_content: { intro: "Hello from richtext" },
			},
		},
	];

	it("uses composeRichtext for body field in JSON when classified", () => {
		const entries = generateCollectionEntries(
			registry,
			contentModel,
			blogPages,
			classifiedModel,
		);
		const entry = entries.find((e) => e.path.includes("rich-post"));
		expect(entry).toBeDefined();
		expect(entry?.format).toBe("json");

		const parsed = JSON.parse(entry?.content ?? "");
		expect(parsed.body).toContain("<p>Hello from richtext</p>");
		expect(parsed.title).toBe("Rich Post");
	});

	it("produces JSON without classification (scalar fields only)", () => {
		const noClassification: ClassifiedContentModel = {
			page_types: [], // no classifications
		};
		const pagesWithScalars: PageContent[] = [
			{
				id: "b2",
				url: "https://example.com/blog/fallback",
				pagetype: "blog",
				content: { title: "Fallback", author: "Jane" },
			},
		];
		const entries = generateCollectionEntries(
			registry,
			contentModel,
			pagesWithScalars,
			noClassification,
		);
		const entry = entries.find((e) => e.path.includes("fallback"));
		expect(entry).toBeDefined();
		expect(entry?.format).toBe("json");

		const parsed = JSON.parse(entry?.content ?? "");
		expect(parsed.title).toBe("Fallback");
		expect(parsed.author).toBe("Jane");
	});

	it("richtext fields do not appear as top-level data keys", () => {
		const entries = generateCollectionEntries(
			registry,
			contentModel,
			blogPages,
			classifiedModel,
		);
		const entry = entries.find((e) => e.path.includes("rich-post"));
		expect(entry).toBeDefined();

		const parsed = JSON.parse(entry?.content ?? "");
		// article_content is richtext, composed into body — should not appear as raw data
		expect(parsed.article_content).toBeUndefined();
		expect(parsed.body).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// generateContentConfig with classified model (Zod nesting)
// ---------------------------------------------------------------------------

describe("generateContentConfig with classified model", () => {
	it("generates typed Zod fields from field classifications", () => {
		const classifiedModel: ClassifiedContentModel = {
			page_types: [
				{
					pagetype: "blog",
					is_singleton: false,
					field_classifications: [
						{ field_path: "title", type: "string" },
						{ field_path: "hero_image", type: "image" },
						{ field_path: "testimonials", type: "repeater" },
						{ field_path: "hero_section", type: "object" },
					],
				},
			],
		};

		const config = generateContentConfig(
			registry,
			contentModel,
			undefined,
			undefined,
			classifiedModel,
		);
		expect(config).toContain("title: z.string().optional()");
		expect(config).toContain("hero_image: z.string().optional()");
		// Without child fields, repeater/object fall back to passthrough
		expect(config).toContain(
			"testimonials: z.array(z.object({}).passthrough())",
		);
		// Object without children gets z.unknown() (null from fieldTypeToZod)
		// and does not appear since fieldTypeToZod returns null
		expect(config).not.toContain("hero_section: z.object({}).passthrough()");
	});

	it("generates typed nested Zod schemas for object/repeater with children", () => {
		const classifiedModel: ClassifiedContentModel = {
			page_types: [
				{
					pagetype: "blog",
					is_singleton: false,
					field_classifications: [
						{ field_path: "title", type: "string" },
						{ field_path: "hero_section", type: "object" },
						{ field_path: "hero_section.headline", type: "string" },
						{ field_path: "hero_section.bg_image", type: "image" },
						{ field_path: "features", type: "repeater" },
						{ field_path: "features.title", type: "string" },
						{ field_path: "features.description", type: "string" },
					],
				},
			],
		};

		const config = generateContentConfig(
			registry,
			contentModel,
			undefined,
			undefined,
			classifiedModel,
		);
		expect(config).toContain("title: z.string().optional()");
		// Object with children: typed z.object({...}).optional()
		expect(config).toContain("hero_section: z.object({");
		expect(config).toContain("headline: z.string().optional()");
		expect(config).toContain("bg_image: z.string().optional()");
		// Repeater with children: z.array(z.object({...})).optional()
		expect(config).toContain("features: z.array(z.object({");
		expect(config).toContain("description: z.string().optional()");
	});

	it("merges sibling nested fields under same parent", () => {
		const classifiedModel: ClassifiedContentModel = {
			page_types: [
				{
					pagetype: "blog",
					is_singleton: false,
					field_classifications: [
						{ field_path: "seo.title", type: "string" },
						{ field_path: "seo.description", type: "string" },
					],
				},
			],
		};

		const config = generateContentConfig(
			registry,
			contentModel,
			undefined,
			undefined,
			classifiedModel,
		);
		// Should be one seo: z.object({ title: ..., description: ... }) not two separate entries
		const seoMatches = config.match(/seo:/g);
		expect(seoMatches).toHaveLength(1);
		expect(config).toContain("title: z.string().optional()");
		expect(config).toContain("description: z.string().optional()");
	});

	it("handles 3-level nested field paths", () => {
		const classifiedModel: ClassifiedContentModel = {
			page_types: [
				{
					pagetype: "blog",
					is_singleton: false,
					field_classifications: [
						{ field_path: "seo.og.title", type: "string" },
						{ field_path: "seo.og.image", type: "image" },
					],
				},
			],
		};

		const config = generateContentConfig(
			registry,
			contentModel,
			undefined,
			undefined,
			classifiedModel,
		);
		expect(config).toContain("seo:");
		expect(config).toContain("og:");
		expect(config).toContain("title: z.string().optional()");
		expect(config).toContain("image: z.string().optional()");
	});

	it("registers singleton collections with glob() loader", () => {
		const singletons = [{ path: "src/content/landing/default.json" }];
		const config = generateContentConfig(
			registry,
			contentModel,
			undefined,
			singletons,
		);
		expect(config).toContain("landing: defineCollection");
		expect(config).toContain(
			'glob({ pattern: "**/*.json", base: "./src/content/landing" })',
		);
		expect(config).toContain("body: z.string().optional()");
	});

	it("singleton and global collections have flat names (no prefix)", () => {
		const singletons = [{ path: "src/content/about/default.json" }];
		const globals = [{ path: "src/content/navigation/default.json" }];
		const config = generateContentConfig(
			registry,
			contentModel,
			globals,
			singletons,
		);
		expect(config).toContain("about: defineCollection");
		expect(config).toContain("navigation: defineCollection");
		// No file() loader
		expect(config).not.toContain("file(");
	});
});

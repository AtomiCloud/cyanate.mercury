import { describe, expect, it } from "bun:test";
import type { PageContent, Registry } from "../../types.js";
import type { ContentModelOutput } from "./classify.js";
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
	it("blog type with multiple pages → correct entries with frontmatter", () => {
		const entries = generateCollectionEntries(registry, contentModel, pages);

		const blogEntries = entries.filter((e) => e.path.includes("blog"));
		expect(blogEntries.length).toBe(3);

		// Each entry should have valid YAML frontmatter (--- delimiters)
		for (const entry of blogEntries) {
			// Markdown entries: should start with --- delimiter
			expect(entry.content).toContain("---");
			// Frontmatter should have expected fields
			expect(entry.content).toContain("id:");
			expect(entry.content).toContain("pagetype: blog");
			expect(entry.content).toContain("collection: blog");
		}
	});

	it("pages with body field → markdown format", () => {
		const entries = generateCollectionEntries(registry, contentModel, pages);

		const blogEntries = entries.filter(
			(e) => e.path.includes("blog") && e.format === "md",
		);
		// post-1 and post-2 have "body" fields
		expect(blogEntries.length).toBeGreaterThanOrEqual(2);

		// Markdown entries should have frontmatter delimiters
		for (const entry of blogEntries) {
			expect(entry.content.startsWith("---")).toBe(true);
		}
	});

	it("pages without body → aggregated JSON file in src/data/ for data collections", () => {
		const entries = generateCollectionEntries(
			dataRegistry,
			dataContentModel,
			dataPages,
		);
		// Data collections (slug_field: "") aggregate all entries into one file
		expect(entries.length).toBe(1);
		expect(entries[0].path).toBe("src/data/events.json");
		expect(entries[0].format).toBe("json");

		// Content must be a valid JSON array
		const parsed = JSON.parse(entries[0].content);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(2);

		// Each entry must have required fields
		for (const item of parsed) {
			expect(item.id).toBeDefined();
			expect(item.pagetype).toBe("event");
			expect(item.collection).toBe("events");
			expect(typeof item.title).toBe("string");
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

	it("pages with description field → markdown format (description is body-like)", () => {
		// post-3 has description which extractBody considers body-like
		const entries = generateCollectionEntries(registry, contentModel, pages);
		const post3 = entries.find((e) => e.path.includes("third-post"));
		if (post3) {
			expect(post3.format).toBe("md");
		}
	});

	it("non-collection pages produce no entries", () => {
		const entries = generateCollectionEntries(registry, contentModel, pages);
		// landing and about are static pages, not in collections
		expect(entries.every((e) => e.path.includes("blog"))).toBe(true);
	});

	it("markdown entries have YAML frontmatter with --- delimiters", () => {
		const entries = generateCollectionEntries(registry, contentModel, pages);
		const blogEntries = entries.filter((e) => e.format === "md");

		for (const entry of blogEntries) {
			const lines = entry.content.split("\n");
			// First line should be the opening --- delimiter
			expect(lines[0]).toBe("---");
			// Second line should be the first frontmatter key
			expect(lines[1]).toMatch(/^[a-z_]+:/i);
			// Content should have matching closing delimiter after frontmatter
			const closingDelimiterIndex = lines.indexOf("---", 1);
			expect(closingDelimiterIndex).toBeGreaterThan(1);
		}
	});
});

// ---------------------------------------------------------------------------
// generateGlobals
// ---------------------------------------------------------------------------

describe("generateGlobals", () => {
	it("produces global data files in src/data/", () => {
		const files = generateGlobals(contentModel, pages);
		const paths = files.map((f) => f.path);

		expect(paths.some((p) => p.includes("src/data/"))).toBe(true);
		expect(paths).toContain("src/data/site.json");
	});

	it("extracts navigation from landing page as array with id: default", () => {
		const files = generateGlobals(contentModel, pages);
		const nav = files.find((f) => f.path.includes("navigation.json"));

		expect(nav).toBeDefined();
		const parsed = JSON.parse(nav?.content ?? "");
		// Global data is wrapped in a single-element array for file() loader
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].id).toBe("default");
		expect(parsed[0].main_menu).toBeDefined();
	});

	it("extracts header from landing page as array with id: default", () => {
		const files = generateGlobals(contentModel, pages);
		const header = files.find((f) => f.path.includes("header.json"));

		expect(header).toBeDefined();
		const parsed = JSON.parse(header?.content ?? "");
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].id).toBe("default");
	});

	it("site.json is array-wrapped with id: default", () => {
		const files = generateGlobals(contentModel, pages);
		const site = files.find((f) => f.path.includes("site.json"));

		expect(site).toBeDefined();
		const parsed = JSON.parse(site?.content ?? "");
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].id).toBe("default");
		expect(parsed[0].totalPages).toBe(pages.length);
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

	it("includes glob() loader with dual extension for content collections", () => {
		const config = generateContentConfig(registry, contentModel);

		// Content collections use {md,json} to handle mixed Markdown/JSON pages
		expect(config).toContain('glob({ pattern: "**/*.{md,json}"');
		expect(config).toContain("blog");
	});

	it("includes slug_field in schema", () => {
		const config = generateContentConfig(registry, contentModel);

		expect(config).toContain("title: z.string().optional()");
	});

	it("uses file() loader for data collections (slug_field empty)", () => {
		const config = generateContentConfig(dataRegistry, dataContentModel);

		// Data collections use file() loader, not glob()
		expect(config).toContain('file("./src/data/events.json")');
		expect(config).not.toContain('glob({ pattern: "**/*.{md,json}"');
		expect(config).toContain("events");
		// Data collections use passthrough schema (arbitrary data shapes)
		expect(config).toContain("z.object({ id: z.string() }).passthrough()");
	});

	it("data collections import file() loader even without globals", () => {
		const config = generateContentConfig(dataRegistry, dataContentModel);

		// Should import file because data collections use it
		expect(config).toContain("import { file, glob }");
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

	it("content-only registry without globals does not import file() loader", () => {
		const config = generateContentConfig(registry, contentModel);
		expect(config).not.toContain("file(");
		expect(config).not.toContain("import { file");
	});

	it("with globals param, imports file() and registers globals as file() collections", () => {
		const globals = [
			{ path: "src/data/navigation.json", content: "[]" },
			{ path: "src/data/header.json", content: "[]" },
			{ path: "src/data/site.json", content: "[]" },
		];
		const config = generateContentConfig(registry, contentModel, globals);

		// Should import both file and glob
		expect(config).toContain("import { file, glob }");
		// Should register globals with file() loader
		expect(config).toContain('file("./src/data/navigation.json")');
		expect(config).toContain('file("./src/data/header.json")');
		expect(config).toContain('file("./src/data/site.json")');
		// Global collection names use globals_ prefix
		expect(config).toContain("globals_navigation: defineCollection");
		expect(config).toContain("globals_header: defineCollection");
		expect(config).toContain("globals_site: defineCollection");
		// Schema uses passthrough for arbitrary global data shapes
		expect(config).toContain("z.object({ id: z.string() }).passthrough()");
	});

	it("global collections use passthrough schema (not z.any())", () => {
		const globals = [{ path: "src/data/site.json", content: "[]" }];
		const config = generateContentConfig(registry, contentModel, globals);

		// Must NOT use z.any() — that breaks type safety
		expect(config).not.toContain("z.any()");
		// Must NOT use z.record(z.unknown()) — that's for objects, not entries
		expect(config).not.toContain("z.record(");
		// Must use passthrough to require id but allow arbitrary additional fields
		expect(config).toContain(".passthrough()");
	});

	it("does not use deprecated global_ prefixed collection names (no s)", () => {
		const globals = [{ path: "src/data/site.json", content: "[]" }];
		const config = generateContentConfig(registry, contentModel, globals);
		// Old naming was "global_site" (no s). New naming is "globals_site".
		expect(config).not.toContain("global_site:");
		expect(config).toContain("globals_site:");
	});

	it("mixed content and data collections use correct loaders", () => {
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

		// blog (content collection) → glob() loader
		expect(config).toContain('glob({ pattern: "**/*.{md,json}"');
		expect(config).toContain("blog: defineCollection");

		// events (data collection) → file() loader
		expect(config).toContain('file("./src/data/events.json")');
		expect(config).toContain("events: defineCollection");

		// Must import both loaders
		expect(config).toContain("import { file, glob }");
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

	it("collection item routes use render() for glob() collections (content)", () => {
		const files = generateRouteFiles(registry, contentModel);
		const dynamicRoute = files.find((f) => f.path.includes("["));
		const content = dynamicRoute?.content ?? "";

		// glob() loader → content collection → use render(entry) + <Content />
		expect(content).toContain("render(entry)");
		expect(content).toContain("<Content />");
		// Should use getCollection, not getEntry
		expect(content).toContain('getCollection("blog")');
		// No runtime isRenderable check
		expect(content).not.toContain("isRenderable");
	});

	it("data collection (slug_field empty) uses getStaticPaths + getCollection + entry.data", () => {
		// dataRegistry has an "events" collection with slug_field: ""
		// This signals a data-only collection → file() loader → getCollection() + entry.data path
		const files = generateRouteFiles(dataRegistry, dataContentModel);
		const dynamicRoute = files.find((f) => f.path.includes("["));
		const content = dynamicRoute?.content ?? "";

		// Must have getStaticPaths (Astro requires this for dynamic routes)
		expect(content).toContain("getStaticPaths");
		// Uses getCollection (not getEntry) because file() with JSON array
		// creates multiple entries keyed by id — getCollection retrieves them
		expect(content).toContain("getCollection");
		expect(content).not.toContain("getEntry");
		// Should use entry.data directly (no render)
		expect(content).not.toContain("render(entry)");
		// Should have <dl> for data rendering
		expect(content).toContain("<dl>");
		// No runtime isRenderable check
		expect(content).not.toContain("isRenderable");
		// Gets entry from Astro.props (set by getStaticPaths), not from params
		expect(content).toContain("Astro.props");
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
					paginated: false,
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
					paginated: false,
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
					paginated: false,
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
					paginated: false,
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
					paginated: false,
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
					paginated: false,
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

	it("globals in src/data/ do not count as page coverage", () => {
		const result = validateSeedCompleteness(
			[
				{
					id: "1",
					url: "https://example.com/site",
					pagetype: "landing",
					content: {},
				},
			],
			[{ path: "src/data/site.json" }],
		);
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
				{ path: "src/data/site.json" },
				{ path: "src/data/navigation.json" },
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

	it("data collection pages covered by route files, not src/data/ aggregate", () => {
		// Data collection entries are in src/data/events.json (skipped by validation).
		// Coverage must come from route files like src/pages/events/[slug].astro.
		const result = validateSeedCompleteness(dataPages, [
			{ path: "src/data/events.json" },
			{ path: "src/pages/events/[slug].astro" },
		]);
		expect(result.complete).toBe(true);
	});

	it("data collection pages NOT covered without route files", () => {
		// src/data/events.json is skipped (src/data/ prefix).
		// Without route files, data collection pages are uncovered.
		const result = validateSeedCompleteness(dataPages, [
			{ path: "src/data/events.json" },
		]);
		expect(result.complete).toBe(false);
		expect(result.missing).toHaveLength(2);
	});
});

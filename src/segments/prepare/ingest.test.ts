import { describe, expect, it } from "bun:test";
import type {
	ContentData,
	PageContent,
	SchemaData,
	StructureData,
} from "../../types.js";
import {
	buildPageTypeMeta,
	buildPreparedPages,
	convertUrlPattern,
	extractSlugParam,
	flattenContent,
	resolveSchemaPages,
	validateContentAgainstSchema,
} from "./ingest.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const contentData: ContentData = {
	page_types: {
		landing: {
			entries: [{ url: "/", content: { hero: "Welcome", footer: "copy" } }],
		},
		blog_post: {
			entries: [
				{
					url: "/post/hello/",
					content: { title: "Hello", body: "world", footer: "copy" },
				},
				{
					url: "/post/bye/",
					content: { title: "Bye", body: "later", footer: "copy" },
				},
			],
		},
	},
};

const schemaData: SchemaData = {
	pages: {
		landing: {
			type: "object",
			properties: {
				hero: { type: "string" },
				header: { $ref: "#/definitions/header" },
				footer: { $ref: "#/definitions/footer" },
			},
			required: ["hero"],
		},
		blog_post: {
			type: "object",
			properties: {
				title: { type: "string" },
				body: { type: "string" },
			},
			required: ["title", "body"],
		},
	},
	definitions: {
		header: {
			type: "object",
			properties: { logo: { type: "string" } },
		},
		footer: {
			type: "object",
			properties: { copy: { type: "string" } },
		},
	},
};

const structure: StructureData = {
	site_url: "https://example.com",
	page_types: [
		{
			name: "landing",
			url_pattern: "/",
			description: "Homepage",
			sample_urls: ["/"],
			urls: ["/"],
		},
		{
			name: "blog_post",
			url_pattern: "/post/{slug}/",
			description: "Blog posts",
			sample_urls: ["/post/hello/"],
			urls: ["/post/hello/", "/post/bye/"],
		},
		{
			name: "team_member",
			url_pattern: "/team/{slug}/",
			description: "Team",
			sample_urls: ["/team/alice/", "/team/bob/"],
			urls: ["/team/alice/", "/team/bob/", "/team/charlie/"],
		},
	],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("flattenContent", () => {
	it("flattens grouped entries into a flat array with pagetype and id", () => {
		const pages = flattenContent(contentData);
		expect(pages).toHaveLength(3);

		expect(pages[0]).toEqual({
			id: "landing-0",
			url: "/",
			pagetype: "landing",
			content: { hero: "Welcome", footer: "copy" },
		});

		expect(pages[1]).toEqual({
			id: "blog_post-0",
			url: "/post/hello/",
			pagetype: "blog_post",
			content: { title: "Hello", body: "world", footer: "copy" },
		});

		expect(pages[2]).toEqual({
			id: "blog_post-1",
			url: "/post/bye/",
			pagetype: "blog_post",
			content: { title: "Bye", body: "later", footer: "copy" },
		});
	});

	it("handles empty page_types", () => {
		expect(flattenContent({ page_types: {} })).toEqual([]);
	});
});

describe("resolveSchemaPages", () => {
	it("resolves $ref pointers to inline definitions", () => {
		const resolved = resolveSchemaPages(schemaData);

		expect(resolved.landing.properties.header).toEqual({
			type: "object",
			properties: { logo: { type: "string" } },
		});
		expect(resolved.landing.properties.footer).toEqual({
			type: "object",
			properties: { copy: { type: "string" } },
		});
	});

	it("preserves non-$ref properties", () => {
		const resolved = resolveSchemaPages(schemaData);
		expect(resolved.landing.properties.hero).toEqual({ type: "string" });
	});

	it("handles schemas without definitions", () => {
		const noDefSchema: SchemaData = {
			pages: {
				simple: {
					type: "object",
					properties: { title: { type: "string" } },
				},
			},
		};
		const resolved = resolveSchemaPages(noDefSchema);
		expect(resolved.simple.properties.title).toEqual({ type: "string" });
	});

	it("resolves $ref nested inside property objects", () => {
		const nestedSchema: SchemaData = {
			pages: {
				page: {
					type: "object",
					properties: {
						hero: {
							type: "object",
							properties: {
								image: { $ref: "#/definitions/image" },
							},
						},
					},
				},
			},
			definitions: {
				image: { type: "object", properties: { src: { type: "string" } } },
			},
		};
		const resolved = resolveSchemaPages(nestedSchema);
		expect(resolved.page.properties.hero).toEqual({
			type: "object",
			properties: {
				image: {
					type: "object",
					properties: { src: { type: "string" } },
				},
			},
		});
	});

	it("resolves $ref inside arrays", () => {
		const arraySchema: SchemaData = {
			pages: {
				page: {
					type: "object",
					properties: {
						gallery: {
							type: "array",
							items: { $ref: "#/definitions/image" },
						},
					},
				},
			},
			definitions: {
				image: { type: "object", properties: { src: { type: "string" } } },
			},
		};
		const resolved = resolveSchemaPages(arraySchema);
		const gallery = resolved.page.properties.gallery as Record<string, unknown>;
		expect(gallery.items).toEqual({
			type: "object",
			properties: { src: { type: "string" } },
		});
	});

	it("resolves chained $refs (ref points to another ref)", () => {
		const chainedSchema: SchemaData = {
			pages: {
				page: {
					type: "object",
					properties: {
						thumb: { $ref: "#/definitions/thumbnail" },
					},
				},
			},
			definitions: {
				thumbnail: { $ref: "#/definitions/image" },
				image: { type: "object", properties: { src: { type: "string" } } },
			},
		};
		const resolved = resolveSchemaPages(chainedSchema);
		expect(resolved.page.properties.thumb).toEqual({
			type: "object",
			properties: { src: { type: "string" } },
		});
	});

	it("guards against circular $refs", () => {
		const circularSchema: SchemaData = {
			pages: {
				page: {
					type: "object",
					properties: {
						self: { $ref: "#/definitions/a" },
					},
				},
			},
			definitions: {
				a: { $ref: "#/definitions/b" },
				b: { $ref: "#/definitions/a" },
			},
		};
		// Should not infinite-loop; leaves the unresolvable cycle as a $ref.
		const resolved = resolveSchemaPages(circularSchema);
		expect(resolved.page.properties.self).toBeDefined();
	});

	it("keeps $ref intact when definition is missing", () => {
		const badRefSchema: SchemaData = {
			pages: {
				page: {
					type: "object",
					properties: {
						missing: { $ref: "#/definitions/nonexistent" },
					},
				},
			},
			definitions: {},
		};
		const resolved = resolveSchemaPages(badRefSchema);
		expect(resolved.page.properties.missing).toEqual({
			$ref: "#/definitions/nonexistent",
		});
	});
});

describe("buildPreparedPages", () => {
	it("attaches resolved schema per page type", () => {
		const pages = flattenContent(contentData);
		const schemas = resolveSchemaPages(schemaData);
		const prepared = buildPreparedPages(pages, schemas);

		expect(prepared).toHaveLength(3);
		expect(prepared[0].pagetype).toBe("landing");
		expect(prepared[0].schema).toHaveProperty("type", "object");
		expect(prepared[0].schema).toHaveProperty("properties");
	});

	it("uses empty object for missing schema", () => {
		const pages: PageContent[] = [
			{ id: "x-0", url: "/x/", pagetype: "unknown_type", content: {} },
		];
		const prepared = buildPreparedPages(pages, {});
		expect(prepared[0].schema).toEqual({});
	});
});

describe("buildPageTypeMeta", () => {
	it("builds meta from structure page types", () => {
		const meta = buildPageTypeMeta(structure);
		expect(meta).toHaveLength(3);

		const landing = meta.find((m) => m.pagetype === "landing");
		expect(landing).toEqual({
			pagetype: "landing",
			urlPattern: "/",
			count: 1,
			urls: ["/"],
			hasPagination: false,
		});

		const blog = meta.find((m) => m.pagetype === "blog_post");
		expect(blog?.count).toBe(2);
		expect(blog?.hasPagination).toBe(false);

		const team = meta.find((m) => m.pagetype === "team_member");
		expect(team?.count).toBe(3);
		expect(team?.hasPagination).toBe(true);
	});
});

describe("validateContentAgainstSchema", () => {
	it("passes when all required fields present", () => {
		const pages = flattenContent(contentData);
		const schemas = resolveSchemaPages(schemaData);
		const result = validateContentAgainstSchema(pages, schemas);
		expect(result.valid).toBe(true);
		expect(result.warnings).toHaveLength(0);
	});

	it("warns on missing required fields", () => {
		const pages: PageContent[] = [
			{
				id: "blog_post-0",
				url: "/post/incomplete/",
				pagetype: "blog_post",
				content: { title: "Has title but no body" },
			},
		];
		const schemas = resolveSchemaPages(schemaData);
		const result = validateContentAgainstSchema(pages, schemas);
		expect(result.valid).toBe(false);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0].missingField).toBe("body");
	});

	it("skips pages with no matching schema", () => {
		const pages: PageContent[] = [
			{ id: "x-0", url: "/x/", pagetype: "unknown_type", content: {} },
		];
		const schemas = resolveSchemaPages(schemaData);
		const result = validateContentAgainstSchema(pages, schemas);
		expect(result.valid).toBe(true);
	});
});

describe("convertUrlPattern", () => {
	it("converts {param} to [param]", () => {
		expect(convertUrlPattern("/team/{slug}/")).toBe("/team/[slug]");
		expect(convertUrlPattern("/{service}/")).toBe("/[service]");
	});

	it("preserves root", () => {
		expect(convertUrlPattern("/")).toBe("/");
	});

	it("strips trailing slash", () => {
		expect(convertUrlPattern("/about/")).toBe("/about");
	});
});

describe("extractSlugParam", () => {
	it("extracts from dynamic patterns", () => {
		expect(extractSlugParam("/team/{slug}/")).toBe("slug");
		expect(extractSlugParam("/{service}/")).toBe("service");
		expect(extractSlugParam("/post/{slug}/")).toBe("slug");
	});

	it("returns undefined for static patterns", () => {
		expect(extractSlugParam("/")).toBeUndefined();
		expect(extractSlugParam("/about/")).toBeUndefined();
	});
});

import { describe, expect, it } from "bun:test";
import type { ContentData, SchemaData } from "../../types.js";
import {
	convertUrlPattern,
	extractSlugParam,
	flattenContent,
	resolveSchemaPages,
} from "./adapter.js";

// ---------------------------------------------------------------------------
// flattenContent
// ---------------------------------------------------------------------------

describe("flattenContent", () => {
	it("flattens grouped content into PageContent[]", () => {
		const data: ContentData = {
			page_types: {
				landing: {
					entries: [{ url: "/", content: { hero: "Welcome" } }],
				},
				blog_post: {
					entries: [
						{ url: "/post/first/", content: { title: "First" } },
						{ url: "/post/second/", content: { title: "Second" } },
					],
				},
			},
		};

		const result = flattenContent(data);

		expect(result).toHaveLength(3);
		expect(result[0]).toEqual({
			id: "landing-0",
			url: "/",
			pagetype: "landing",
			content: { hero: "Welcome" },
		});
		expect(result[1]).toEqual({
			id: "blog_post-0",
			url: "/post/first/",
			pagetype: "blog_post",
			content: { title: "First" },
		});
		expect(result[2]).toEqual({
			id: "blog_post-1",
			url: "/post/second/",
			pagetype: "blog_post",
			content: { title: "Second" },
		});
	});

	it("handles empty page_types", () => {
		const data: ContentData = { page_types: {} };
		expect(flattenContent(data)).toEqual([]);
	});

	it("handles page type with no entries", () => {
		const data: ContentData = {
			page_types: {
				landing: { entries: [] },
			},
		};
		expect(flattenContent(data)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// resolveSchemaPages
// ---------------------------------------------------------------------------

describe("resolveSchemaPages", () => {
	it("resolves top-level $ref pointers", () => {
		const schema: SchemaData = {
			pages: {
				landing: {
					type: "object",
					properties: {
						header: { $ref: "#/definitions/header" },
						hero: { type: "string" },
					},
				},
			},
			definitions: {
				header: {
					type: "object",
					properties: { logo: { type: "string" } },
				},
			},
		};

		const result = resolveSchemaPages(schema);

		expect(result.landing.properties.header).toEqual({
			type: "object",
			properties: { logo: { type: "string" } },
		});
		expect(result.landing.properties.hero).toEqual({ type: "string" });
	});

	it("preserves non-ref properties unchanged", () => {
		const schema: SchemaData = {
			pages: {
				about: {
					type: "object",
					properties: {
						title: { type: "string" },
						sections: { type: "array", items: { type: "object" } },
					},
				},
			},
		};

		const result = resolveSchemaPages(schema);

		expect(result.about.properties.title).toEqual({ type: "string" });
		expect(result.about.properties.sections).toEqual({
			type: "array",
			items: { type: "object" },
		});
	});

	it("handles missing definition gracefully", () => {
		const schema: SchemaData = {
			pages: {
				landing: {
					type: "object",
					properties: {
						footer: { $ref: "#/definitions/footer" },
					},
				},
			},
			definitions: {},
		};

		const result = resolveSchemaPages(schema);
		// Falls back to the $ref object itself when definition is missing
		expect(result.landing.properties.footer).toEqual({
			$ref: "#/definitions/footer",
		});
	});

	it("handles schema with no definitions", () => {
		const schema: SchemaData = {
			pages: {
				landing: {
					type: "object",
					properties: {
						title: { type: "string" },
					},
				},
			},
		};

		const result = resolveSchemaPages(schema);
		expect(result.landing.properties.title).toEqual({ type: "string" });
	});
});

// ---------------------------------------------------------------------------
// convertUrlPattern
// ---------------------------------------------------------------------------

describe("convertUrlPattern", () => {
	it("converts {param} to [param]", () => {
		expect(convertUrlPattern("/team/{slug}/")).toBe("/team/[slug]");
	});

	it("handles root-level dynamic param", () => {
		expect(convertUrlPattern("/{service}/")).toBe("/[service]");
	});

	it("preserves root path", () => {
		expect(convertUrlPattern("/")).toBe("/");
	});

	it("preserves static paths and strips trailing slash", () => {
		expect(convertUrlPattern("/about/")).toBe("/about");
	});

	it("handles nested dynamic params", () => {
		expect(convertUrlPattern("/archive/{year}/{month}/")).toBe(
			"/archive/[year]/[month]",
		);
	});

	it("handles path without trailing slash", () => {
		expect(convertUrlPattern("/team/{slug}")).toBe("/team/[slug]");
	});
});

// ---------------------------------------------------------------------------
// extractSlugParam
// ---------------------------------------------------------------------------

describe("extractSlugParam", () => {
	it("extracts slug from pattern", () => {
		expect(extractSlugParam("/team/{slug}/")).toBe("slug");
	});

	it("extracts named param", () => {
		expect(extractSlugParam("/{service}/")).toBe("service");
	});

	it("returns undefined for static pattern", () => {
		expect(extractSlugParam("/about/")).toBeUndefined();
	});

	it("returns undefined for root", () => {
		expect(extractSlugParam("/")).toBeUndefined();
	});

	it("returns first param for multi-param patterns", () => {
		expect(extractSlugParam("/archive/{year}/{month}/")).toBe("year");
	});
});

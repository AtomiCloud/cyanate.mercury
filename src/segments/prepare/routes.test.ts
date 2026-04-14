import { describe, expect, it } from "bun:test";
import type { StructureData } from "../../types.js";
import type { PageTypeMeta } from "./ingest.js";
import {
	classifyPattern,
	extractSlugFromUrl,
	isRootLevelDynamic,
	isValidAstroRoutePattern,
	pageTypeToPrefix,
	resolveAllRoutes,
	updatePageTypeMeta,
	validateRoutePatterns,
} from "./routes.js";

// ---------------------------------------------------------------------------
// classifyPattern
// ---------------------------------------------------------------------------

describe("classifyPattern", () => {
	it("classifies root as singleton", () => {
		expect(classifyPattern("/")).toBe("singleton");
	});

	it("classifies static paths as singleton", () => {
		expect(classifyPattern("/about/")).toBe("singleton");
		expect(classifyPattern("/about-us/")).toBe("singleton");
		expect(classifyPattern("/contact/us/")).toBe("singleton");
	});

	it("classifies single root-level dynamic as root_dynamic", () => {
		expect(classifyPattern("/{slug}/")).toBe("root_dynamic");
		expect(classifyPattern("/{service}/")).toBe("root_dynamic");
	});

	it("classifies prefixed dynamic as prefixed_dynamic", () => {
		expect(classifyPattern("/post/{slug}/")).toBe("prefixed_dynamic");
		expect(classifyPattern("/team/{id}/")).toBe("prefixed_dynamic");
		expect(classifyPattern("/blog/{year}/{slug}/")).toBe("prefixed_dynamic");
	});
});

// ---------------------------------------------------------------------------
// isRootLevelDynamic
// ---------------------------------------------------------------------------

describe("isRootLevelDynamic", () => {
	it("returns true only for root-level dynamic patterns", () => {
		expect(isRootLevelDynamic("/{slug}/")).toBe(true);
		expect(isRootLevelDynamic("/{service}/")).toBe(true);
		expect(isRootLevelDynamic("/post/{slug}/")).toBe(false);
		expect(isRootLevelDynamic("/about/")).toBe(false);
		expect(isRootLevelDynamic("/")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// pageTypeToPrefix
// ---------------------------------------------------------------------------

describe("pageTypeToPrefix", () => {
	it("kebab-cases names", () => {
		expect(pageTypeToPrefix("service")).toBe("service");
		expect(pageTypeToPrefix("blog_post")).toBe("blog-post");
		expect(pageTypeToPrefix("team_member")).toBe("team-member");
		expect(pageTypeToPrefix("service_detail")).toBe("service-detail");
	});
});

// ---------------------------------------------------------------------------
// extractSlugFromUrl
// ---------------------------------------------------------------------------

describe("extractSlugFromUrl", () => {
	it("extracts slug from root-level dynamic", () => {
		expect(extractSlugFromUrl("/home-physiotherapy/", "/{service}/")).toBe(
			"home-physiotherapy",
		);
	});

	it("extracts slug from prefixed dynamic", () => {
		expect(extractSlugFromUrl("/post/knee-pain/", "/post/{slug}/")).toBe(
			"knee-pain",
		);
	});

	it("returns undefined for static pattern", () => {
		expect(extractSlugFromUrl("/about/", "/about/")).toBeUndefined();
	});

	it("returns undefined when segment count mismatches", () => {
		expect(extractSlugFromUrl("/foo/bar/", "/{slug}/")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// resolveAllRoutes — no conflict
// ---------------------------------------------------------------------------

describe("resolveAllRoutes (no conflict)", () => {
	it("keeps single root-level dynamic unchanged", () => {
		const structure: StructureData = {
			site_url: "https://example.com",
			page_types: [
				{
					name: "landing",
					url_pattern: "/",
					description: "",
					sample_urls: [],
					urls: ["/"],
				},
				{
					name: "service",
					url_pattern: "/{service}/",
					description: "",
					sample_urls: [],
					urls: ["/home-physio/", "/sports-physio/"],
				},
			],
		};
		const resolved = resolveAllRoutes(structure);

		expect(resolved.patternMap.service.rewritten).toBe(false);
		expect(resolved.patternMap.service.finalPattern).toBe("/{service}/");
		expect(resolved.urlMap["/home-physio/"]).toBe("/home-physio/");
		expect(resolved.urlMap["/sports-physio/"]).toBe("/sports-physio/");
		expect(resolved.urlMap["/"]).toBe("/");
	});

	it("keeps prefixed dynamics unchanged", () => {
		const structure: StructureData = {
			site_url: "https://example.com",
			page_types: [
				{
					name: "blog_post",
					url_pattern: "/post/{slug}/",
					description: "",
					sample_urls: [],
					urls: ["/post/hello/", "/post/bye/"],
				},
			],
		};
		const resolved = resolveAllRoutes(structure);

		expect(resolved.patternMap.blog_post.rewritten).toBe(false);
		expect(resolved.urlMap["/post/hello/"]).toBe("/post/hello/");
	});
});

// ---------------------------------------------------------------------------
// resolveAllRoutes — conflict (physio-like)
// ---------------------------------------------------------------------------

describe("resolveAllRoutes (conflict: physio example)", () => {
	it("prefixes both root-level dynamics with their page-type names", () => {
		const structure: StructureData = {
			site_url: "https://example.com",
			page_types: [
				{
					name: "landing",
					url_pattern: "/",
					description: "",
					sample_urls: [],
					urls: ["/"],
				},
				{
					name: "service",
					url_pattern: "/{service}/",
					description: "",
					sample_urls: [],
					urls: ["/home-physio/", "/sports-physio/"],
				},
				{
					name: "condition",
					url_pattern: "/{condition}/",
					description: "",
					sample_urls: [],
					urls: ["/knee-pain/", "/back-pain/"],
				},
			],
		};
		const resolved = resolveAllRoutes(structure);

		expect(resolved.patternMap.service.rewritten).toBe(true);
		expect(resolved.patternMap.service.finalPattern).toBe("/service/{slug}/");
		expect(resolved.urlMap["/home-physio/"]).toBe("/service/home-physio/");
		expect(resolved.urlMap["/sports-physio/"]).toBe("/service/sports-physio/");

		expect(resolved.patternMap.condition.rewritten).toBe(true);
		expect(resolved.patternMap.condition.finalPattern).toBe(
			"/condition/{slug}/",
		);
		expect(resolved.urlMap["/knee-pain/"]).toBe("/condition/knee-pain/");
		expect(resolved.urlMap["/back-pain/"]).toBe("/condition/back-pain/");

		expect(resolved.patternMap.landing.rewritten).toBe(false);
		expect(resolved.urlMap["/"]).toBe("/");
	});
});

// ---------------------------------------------------------------------------
// resolveAllRoutes — conflict (royal-like, multiple conflicts + prefixed)
// ---------------------------------------------------------------------------

describe("resolveAllRoutes (conflict: royal example)", () => {
	it("prefixes conflicting root-dynamics; leaves prefixed dynamics untouched", () => {
		const structure: StructureData = {
			site_url: "https://example.com",
			page_types: [
				{
					name: "landing",
					url_pattern: "/",
					description: "",
					sample_urls: [],
					urls: ["/"],
				},
				{
					name: "about",
					url_pattern: "/about/",
					description: "",
					sample_urls: [],
					urls: ["/about/"],
				},
				{
					name: "blog_post",
					url_pattern: "/{post}/",
					description: "",
					sample_urls: [],
					urls: ["/first-article/", "/second-article/"],
				},
				{
					name: "legal",
					url_pattern: "/{doc}/",
					description: "",
					sample_urls: [],
					urls: ["/privacy/", "/terms/"],
				},
				{
					name: "service_detail",
					url_pattern: "/{service}/",
					description: "",
					sample_urls: [],
					urls: ["/vip-transfers/"],
				},
				{
					name: "team",
					url_pattern: "/team/{slug}/",
					description: "",
					sample_urls: [],
					urls: ["/team/alice/", "/team/bob/"],
				},
			],
		};
		const resolved = resolveAllRoutes(structure);

		expect(resolved.patternMap.blog_post.rewritten).toBe(true);
		expect(resolved.patternMap.blog_post.finalPattern).toBe(
			"/blog-post/{slug}/",
		);
		expect(resolved.urlMap["/first-article/"]).toBe(
			"/blog-post/first-article/",
		);

		expect(resolved.patternMap.legal.rewritten).toBe(true);
		expect(resolved.patternMap.legal.finalPattern).toBe("/legal/{slug}/");
		expect(resolved.urlMap["/privacy/"]).toBe("/legal/privacy/");

		expect(resolved.patternMap.service_detail.rewritten).toBe(true);
		expect(resolved.patternMap.service_detail.finalPattern).toBe(
			"/service-detail/{slug}/",
		);
		expect(resolved.urlMap["/vip-transfers/"]).toBe(
			"/service-detail/vip-transfers/",
		);

		// unchanged
		expect(resolved.patternMap.team.rewritten).toBe(false);
		expect(resolved.urlMap["/team/alice/"]).toBe("/team/alice/");
		expect(resolved.patternMap.about.rewritten).toBe(false);
		expect(resolved.urlMap["/about/"]).toBe("/about/");
	});
});

// ---------------------------------------------------------------------------
// updatePageTypeMeta
// ---------------------------------------------------------------------------

describe("updatePageTypeMeta", () => {
	it("applies finalPattern and maps urls through the urlMap", () => {
		const meta: PageTypeMeta[] = [
			{
				pagetype: "service",
				urlPattern: "/{service}/",
				count: 2,
				urls: ["/home-physio/", "/sports-physio/"],
				hasPagination: false,
			},
			{
				pagetype: "landing",
				urlPattern: "/",
				count: 1,
				urls: ["/"],
				hasPagination: false,
			},
		];

		const resolved = {
			urlMap: {
				"/home-physio/": "/service/home-physio/",
				"/sports-physio/": "/service/sports-physio/",
				"/": "/",
			},
			patternMap: {
				service: {
					pageType: "service",
					originalPattern: "/{service}/",
					finalPattern: "/service/{slug}/",
					rewritten: true,
				},
				landing: {
					pageType: "landing",
					originalPattern: "/",
					finalPattern: "/",
					rewritten: false,
				},
			},
		};

		const updated = updatePageTypeMeta(meta, resolved);
		expect(updated[0].urlPattern).toBe("/service/{slug}/");
		expect(updated[0].urls).toEqual([
			"/service/home-physio/",
			"/service/sports-physio/",
		]);
		expect(updated[1].urlPattern).toBe("/");
		expect(updated[1].urls).toEqual(["/"]);
	});

	it("leaves meta untouched when no matching entry", () => {
		const meta: PageTypeMeta[] = [
			{
				pagetype: "orphan",
				urlPattern: "/orphan/",
				count: 0,
				urls: [],
				hasPagination: false,
			},
		];
		const updated = updatePageTypeMeta(meta, { urlMap: {}, patternMap: {} });
		expect(updated[0]).toEqual(meta[0]);
	});
});

// ---------------------------------------------------------------------------
// validateRoutePatterns
// ---------------------------------------------------------------------------

describe("validateRoutePatterns", () => {
	it("passes for disjoint patterns", () => {
		const result = validateRoutePatterns([
			{ pattern: "/", pageType: "landing" },
			{ pattern: "/about", pageType: "about" },
			{ pattern: "/post/[slug]", pageType: "blog_post" },
		]);
		expect(result.valid).toBe(true);
		expect(result.conflicts).toHaveLength(0);
	});

	it("flags duplicates", () => {
		const result = validateRoutePatterns([
			{ pattern: "/about", pageType: "a" },
			{ pattern: "/about", pageType: "b" },
		]);
		expect(result.valid).toBe(false);
		expect(result.conflicts).toHaveLength(1);
	});

	it("flags same-position dynamic conflict", () => {
		const result = validateRoutePatterns([
			{ pattern: "/blog/[slug]", pageType: "blog_post" },
			{ pattern: "/blog/[id]", pageType: "blog_id" },
		]);
		expect(result.valid).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// isValidAstroRoutePattern
// ---------------------------------------------------------------------------

describe("isValidAstroRoutePattern", () => {
	it("accepts root, static, and pure dynamic segments", () => {
		expect(isValidAstroRoutePattern("/")).toBe(true);
		expect(isValidAstroRoutePattern("/about/")).toBe(true);
		expect(isValidAstroRoutePattern("/{slug}/")).toBe(true);
		expect(isValidAstroRoutePattern("/post/{slug}/")).toBe(true);
	});

	it("rejects mixed static+dynamic segments", () => {
		expect(isValidAstroRoutePattern("/post-{slug}/")).toBe(false);
	});

	it("rejects missing leading slash", () => {
		expect(isValidAstroRoutePattern("about/")).toBe(false);
	});
});

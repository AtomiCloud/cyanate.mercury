import { describe, expect, it } from "bun:test";
import { convertUrlPattern, extractSlugParam } from "./adapter.js";

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

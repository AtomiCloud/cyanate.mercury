import { describe, expect, it } from "bun:test";
import type { PageContent } from "../../types.js";
import type { ValidateWireframeInput } from "./wireframe-validate.js";
import { validateWireframeOutput } from "./wireframe-validate.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sourcePages: PageContent[] = [
	{ id: "1", url: "https://example.com/", pagetype: "landing", content: {} },
	{ id: "2", url: "https://example.com/about", pagetype: "about", content: {} },
	{
		id: "3",
		url: "https://example.com/blog/post-1",
		pagetype: "blog",
		content: {},
	},
];

const validInput: ValidateWireframeInput = {
	sourcePages,
	generatedRoutes: ["/", "/about", "/blog/post-1"],
	assetManifest: {
		"https://example.com/logo.png": "abc123.png",
	},
	existingImageFiles: ["abc123.png"],
	astroFileContents: {
		"src/pages/index.astro": `<Layout pagetype="landing">Home</Layout>`,
	},
	originalSiteUrl: "https://example.com",
	pagefindExists: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateWireframeOutput", () => {
	it("all checks pass → { valid: true, errors: [] }", () => {
		const result = validateWireframeOutput(validInput);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("dynamic route pattern matches child pages", () => {
		const input = {
			...validInput,
			generatedRoutes: ["/", "/about", "/blog/[slug]"], // dynamic route for blog
		};
		const result = validateWireframeOutput(input);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("missing route → error about content coverage", () => {
		const input = {
			...validInput,
			generatedRoutes: ["/", "/about"], // missing blog route
		};
		const result = validateWireframeOutput(input);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("Content coverage"))).toBe(
			true,
		);
	});

	it("missing image → error about asset integrity", () => {
		const input = {
			...validInput,
			assetManifest: {
				"https://example.com/logo.png": "missing.png",
			},
			existingImageFiles: [],
		};
		const result = validateWireframeOutput(input);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("Asset integrity"))).toBe(true);
	});

	it("leaked absolute URL → error with file + line", () => {
		const input = {
			...validInput,
			astroFileContents: {
				"src/pages/about.astro": `<a href="https://example.com/contact">Link</a>`,
			},
		};
		const result = validateWireframeOutput(input);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some(
				(e) => e.includes("Leaked absolute URL") && e.includes("about.astro"),
			),
		).toBe(true);
	});

	it("Tailwind class in component → NOT flagged (wireframe phase does not check Tailwind)", () => {
		// componentFileContents removed from ValidateWireframeInput — component
		// content is not a wireframe-phase gate (design phase adds/removes classes freely).
		// Validation should still pass since no component-level checks are performed.
		const result = validateWireframeOutput(validInput);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("no pagefind dir → error", () => {
		const input = { ...validInput, pagefindExists: false };
		const result = validateWireframeOutput(input);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("Pagefind"))).toBe(true);
	});

	it("multiple failures → all errors collected", () => {
		const input: ValidateWireframeInput = {
			...validInput,
			generatedRoutes: ["/"], // missing 2 routes
			assetManifest: { "https://example.com/x.png": "missing.png" },
			existingImageFiles: [],
			pagefindExists: false,
		};
		const result = validateWireframeOutput(input);
		expect(result.valid).toBe(false);
		// At least: content coverage, asset integrity, pagefind
		expect(result.errors.length).toBeGreaterThanOrEqual(3);
	});

	it("trailing slash in source URL is normalized → matches route", () => {
		const input = {
			...validInput,
			sourcePages: [
				{
					id: "1",
					url: "https://example.com/about-us/",
					pagetype: "about",
					content: {},
				},
			],
			generatedRoutes: ["/", "/about-us"],
		};
		const result = validateWireframeOutput(input);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("asset manifest with bare name matches images/ prefixed existing file", () => {
		const input = {
			...validInput,
			assetManifest: {
				"https://example.com/logo.png": "abc123.png",
			},
			existingImageFiles: ["images/abc123.png"],
		};
		const result = validateWireframeOutput(input);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("empty source pages → valid (nothing to cover)", () => {
		const input = {
			...validInput,
			sourcePages: [],
			generatedRoutes: [],
		};
		const result = validateWireframeOutput(input);
		expect(result.valid).toBe(true);
	});

	it("leaked URL in comment → not flagged", () => {
		const input = {
			...validInput,
			astroFileContents: {
				"src/pages/about.astro": `<!-- Source: https://example.com/old -->\n<div>Content</div>`,
			},
		};
		const result = validateWireframeOutput(input);
		expect(result.valid).toBe(true);
	});

	it("multiple leaked URLs → all reported", () => {
		const input = {
			...validInput,
			astroFileContents: {
				"src/pages/about.astro": `<a href="https://example.com/contact">Link1</a>\n<a href="https://example.com/team">Link2</a>`,
			},
		};
		const result = validateWireframeOutput(input);
		expect(result.valid).toBe(false);
		expect(
			result.errors.filter((e) => e.includes("Leaked absolute URL")),
		).toHaveLength(2);
	});
});

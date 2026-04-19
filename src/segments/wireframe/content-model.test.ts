import { describe, expect, it } from "bun:test";
import {
	type ComposeNode,
	composeRichtext,
	getNestedValue,
	renderNode,
	resolveImageUrl,
} from "./content-model.js";

// ---------------------------------------------------------------------------
// resolveImageUrl
// ---------------------------------------------------------------------------

describe("resolveImageUrl", () => {
	it("resolves bare string URL", () => {
		expect(resolveImageUrl("https://example.com/img.jpg")).toBe(
			"https://example.com/img.jpg",
		);
	});

	it("resolves object with src field", () => {
		expect(resolveImageUrl({ src: "https://example.com/img.jpg" })).toBe(
			"https://example.com/img.jpg",
		);
	});

	it("resolves object with url field", () => {
		expect(resolveImageUrl({ url: "https://example.com/img.jpg" })).toBe(
			"https://example.com/img.jpg",
		);
	});

	it("resolves object with image field", () => {
		expect(resolveImageUrl({ image: "https://example.com/img.jpg" })).toBe(
			"https://example.com/img.jpg",
		);
	});

	it("rewrites via asset manifest", () => {
		const manifest = {
			"https://example.com/img.jpg": "abc123.jpg",
		};
		expect(resolveImageUrl("https://example.com/img.jpg", manifest)).toBe(
			"/images/abc123.jpg",
		);
	});

	it("returns original URL when not in manifest", () => {
		const manifest = {
			"https://other.com/img.jpg": "abc123.jpg",
		};
		expect(resolveImageUrl("https://example.com/img.jpg", manifest)).toBe(
			"https://example.com/img.jpg",
		);
	});

	it("returns empty string for null/undefined", () => {
		expect(resolveImageUrl(null)).toBe("");
		expect(resolveImageUrl(undefined)).toBe("");
	});

	it("returns empty string for empty object", () => {
		expect(resolveImageUrl({})).toBe("");
	});
});

// ---------------------------------------------------------------------------
// renderNode
// ---------------------------------------------------------------------------

describe("renderNode", () => {
	it("renders text as paragraph", () => {
		const node: ComposeNode = { field: "text", render_as: "p" };
		expect(renderNode("Hello world", node)).toBe("<p>Hello world</p>");
	});

	it("renders heading elements", () => {
		expect(renderNode("Title", { field: "t", render_as: "h1" })).toBe(
			"<h1>Title</h1>",
		);
		expect(renderNode("Sub", { field: "t", render_as: "h2" })).toBe(
			"<h2>Sub</h2>",
		);
		expect(renderNode("Sub3", { field: "t", render_as: "h3" })).toBe(
			"<h3>Sub3</h3>",
		);
	});

	it("renders image with src resolution", () => {
		const node: ComposeNode = { field: "img", render_as: "img" };
		expect(renderNode({ src: "https://example.com/photo.jpg" }, node)).toBe(
			'<img src="https://example.com/photo.jpg" alt="" />',
		);
	});

	it("renders image with alt text", () => {
		const node: ComposeNode = { field: "img", render_as: "img" };
		expect(
			renderNode(
				{ src: "https://example.com/photo.jpg", alt: "A photo" },
				node,
			),
		).toBe('<img src="https://example.com/photo.jpg" alt="A photo" />');
	});

	it("renders image with asset manifest rewriting", () => {
		const node: ComposeNode = { field: "img", render_as: "img" };
		const manifest = { "https://example.com/photo.jpg": "abc.jpg" };
		expect(
			renderNode({ src: "https://example.com/photo.jpg" }, node, manifest),
		).toBe('<img src="/images/abc.jpg" alt="" />');
	});

	it("renders link from object", () => {
		const node: ComposeNode = { field: "link", render_as: "a" };
		expect(
			renderNode({ href: "https://example.com", label: "Click here" }, node),
		).toBe('<a href="https://example.com">Click here</a>');
	});

	it("renders link from string", () => {
		const node: ComposeNode = { field: "link", render_as: "a" };
		expect(renderNode("https://example.com", node)).toBe(
			'<a href="https://example.com">https://example.com</a>',
		);
	});

	it("renders raw HTML as-is", () => {
		const node: ComposeNode = { field: "html", render_as: "raw" };
		expect(renderNode("<b>bold</b>", node)).toBe("<b>bold</b>");
	});

	it("renders array items", () => {
		const node: ComposeNode = {
			field: "items",
			render_as: "p",
			is_array: true,
		};
		expect(renderNode(["First", "Second", "Third"], node)).toBe(
			"<p>First</p>\n<p>Second</p>\n<p>Third</p>",
		);
	});

	it("renders array of li items wrapped in ul", () => {
		const node: ComposeNode = {
			field: "points",
			render_as: "li",
			is_array: true,
		};
		expect(renderNode(["One", "Two"], node)).toBe(
			"<ul>\n<li>One</li>\n<li>Two</li>\n</ul>",
		);
	});

	it("renders container with children", () => {
		const node: ComposeNode = {
			field: "section",
			render_as: "section",
			children: [
				{ field: "heading", render_as: "h2" },
				{ field: "text", render_as: "p" },
			],
		};
		expect(renderNode({ heading: "Title", text: "Body" }, node)).toBe(
			"<section>\n<h2>Title</h2>\n<p>Body</p>\n</section>",
		);
	});

	it("skips missing children gracefully", () => {
		const node: ComposeNode = {
			field: "section",
			render_as: "div",
			children: [
				{ field: "heading", render_as: "h2" },
				{ field: "missing", render_as: "p" },
				{ field: "text", render_as: "p" },
			],
		};
		expect(renderNode({ heading: "Title", text: "Body" }, node)).toBe(
			"<div>\n<h2>Title</h2>\n<p>Body</p>\n</div>",
		);
	});

	it("returns empty string for null value", () => {
		expect(renderNode(null, { field: "x", render_as: "p" })).toBe("");
	});

	it("returns empty string for undefined value", () => {
		expect(renderNode(undefined, { field: "x", render_as: "p" })).toBe("");
	});

	it("escapes HTML in text content", () => {
		expect(renderNode("a < b & c > d", { field: "x", render_as: "p" })).toBe(
			"<p>a &lt; b &amp; c &gt; d</p>",
		);
	});

	it("renders number values", () => {
		expect(renderNode(42, { field: "x", render_as: "span" })).toBe(
			"<span>42</span>",
		);
	});
});

// ---------------------------------------------------------------------------
// composeRichtext
// ---------------------------------------------------------------------------

describe("composeRichtext", () => {
	it("composes simple nested structure", () => {
		const spec: ComposeNode = {
			field: "body",
			render_as: "div",
			children: [
				{ field: "title", render_as: "h1" },
				{ field: "intro", render_as: "p" },
			],
		};

		const data = {
			body: {
				title: "Hello",
				intro: "Welcome to the site",
			},
		};

		expect(composeRichtext(data, spec)).toBe(
			"<div>\n<h1>Hello</h1>\n<p>Welcome to the site</p>\n</div>",
		);
	});

	it("composes blog-like article with sections and subsections", () => {
		const spec: ComposeNode = {
			field: "article_content",
			render_as: "div",
			children: [
				{
					field: "sections",
					render_as: "section",
					is_array: true,
					children: [
						{ field: "heading", render_as: "h2" },
						{
							field: "content_paragraphs",
							render_as: "p",
							is_array: true,
						},
						{
							field: "bullet_points",
							render_as: "li",
							is_array: true,
						},
					],
				},
			],
		};

		const data = {
			article_content: {
				sections: [
					{
						heading: "Introduction",
						content_paragraphs: ["First paragraph.", "Second paragraph."],
						bullet_points: ["Point A", "Point B"],
					},
					{
						heading: "Conclusion",
						content_paragraphs: ["Final thoughts."],
					},
				],
			},
		};

		const result = composeRichtext(data, spec);
		expect(result).toContain("<h2>Introduction</h2>");
		expect(result).toContain("<p>First paragraph.</p>");
		expect(result).toContain("<p>Second paragraph.</p>");
		expect(result).toContain("<ul>\n<li>Point A</li>\n<li>Point B</li>\n</ul>");
		expect(result).toContain("<h2>Conclusion</h2>");
		expect(result).toContain("<p>Final thoughts.</p>");
	});

	it("composes with images and asset manifest", () => {
		const spec: ComposeNode = {
			field: "hero",
			render_as: "div",
			children: [
				{ field: "headline", render_as: "h1" },
				{ field: "image", render_as: "img" },
			],
		};

		const manifest = { "https://cdn.example.com/hero.jpg": "hero-abc.jpg" };
		const data = {
			hero: {
				headline: "Welcome",
				image: { src: "https://cdn.example.com/hero.jpg", alt: "Hero" },
			},
		};

		const result = composeRichtext(data, spec, manifest);
		expect(result).toContain("<h1>Welcome</h1>");
		expect(result).toContain('/images/hero-abc.jpg"');
		expect(result).toContain('alt="Hero"');
	});

	it("resolves dot-path fields (the bug fix)", () => {
		const spec: ComposeNode = {
			field: "profile_section.bio",
			render_as: "div",
			children: [{ field: "text", render_as: "p" }],
		};

		const data = {
			profile_section: {
				bio: {
					text: "Dr. Smith is a specialist.",
				},
			},
		};

		const result = composeRichtext(data, spec);
		expect(result).toContain("<p>Dr. Smith is a specialist.</p>");
	});

	it("resolves deeply nested dot-path for article content", () => {
		const spec: ComposeNode = {
			field: "article_content.sections",
			render_as: "section",
			is_array: true,
			children: [
				{ field: "heading", render_as: "h2" },
				{ field: "content_paragraphs", render_as: "p", is_array: true },
			],
		};

		const data = {
			article_content: {
				sections: [
					{
						heading: "Introduction",
						content_paragraphs: ["First paragraph."],
					},
				],
			},
		};

		const result = composeRichtext(data, spec);
		expect(result).toContain("<h2>Introduction</h2>");
		expect(result).toContain("<p>First paragraph.</p>");
	});

	it("returns empty string for missing top-level field", () => {
		const spec: ComposeNode = {
			field: "nonexistent",
			render_as: "div",
			children: [{ field: "x", render_as: "p" }],
		};
		expect(composeRichtext({ other: "data" }, spec)).toBe("");
	});

	it("returns empty string for non-object data", () => {
		const spec: ComposeNode = { field: "x", render_as: "p" };
		expect(composeRichtext(null, spec)).toBe("");
		expect(composeRichtext("string", spec)).toBe("");
	});

	it("handles deeply nested subsections", () => {
		const spec: ComposeNode = {
			field: "content",
			render_as: "div",
			children: [
				{
					field: "sections",
					render_as: "section",
					is_array: true,
					children: [
						{ field: "heading", render_as: "h2" },
						{
							field: "subsections",
							render_as: "div",
							is_array: true,
							children: [
								{ field: "subheading", render_as: "h3" },
								{ field: "text", render_as: "p" },
							],
						},
					],
				},
			],
		};

		const data = {
			content: {
				sections: [
					{
						heading: "Chapter 1",
						subsections: [
							{ subheading: "1.1", text: "First sub" },
							{ subheading: "1.2", text: "Second sub" },
						],
					},
				],
			},
		};

		const result = composeRichtext(data, spec);
		expect(result).toContain("<h2>Chapter 1</h2>");
		expect(result).toContain("<h3>1.1</h3>");
		expect(result).toContain("<p>First sub</p>");
		expect(result).toContain("<h3>1.2</h3>");
		expect(result).toContain("<p>Second sub</p>");
	});
});

// ---------------------------------------------------------------------------
// getNestedValue
// ---------------------------------------------------------------------------

describe("getNestedValue", () => {
	it("resolves simple key", () => {
		expect(getNestedValue({ title: "Hello" }, "title")).toBe("Hello");
	});

	it("resolves dot-separated path", () => {
		expect(
			getNestedValue(
				{ article_content: { sections: [1, 2, 3] } },
				"article_content.sections",
			),
		).toEqual([1, 2, 3]);
	});

	it("returns undefined for missing path", () => {
		expect(getNestedValue({ a: 1 }, "b.c")).toBeUndefined();
	});

	it("handles deeply nested paths", () => {
		expect(getNestedValue({ a: { b: { c: { d: "deep" } } } }, "a.b.c.d")).toBe(
			"deep",
		);
	});
});

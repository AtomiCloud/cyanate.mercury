import { describe, expect, it } from "bun:test";
import type { PreparedPage } from "./ingest.js";
import {
	classifyExternalUrl,
	collectExternalLinks,
	rewriteAllContent,
	rewriteImageUrls,
	rewriteInternalLinks,
	updatePageUrls,
} from "./rewrites.js";

// ---------------------------------------------------------------------------
// classifyExternalUrl
// ---------------------------------------------------------------------------

describe("classifyExternalUrl", () => {
	it("tags youtube URLs as external-media", () => {
		expect(classifyExternalUrl("https://www.youtube.com/watch?v=abc")).toBe(
			"external-media",
		);
		expect(classifyExternalUrl("https://youtu.be/abc")).toBe("external-media");
	});

	it("tags vimeo URLs as external-media", () => {
		expect(classifyExternalUrl("https://vimeo.com/12345")).toBe(
			"external-media",
		);
		expect(classifyExternalUrl("https://player.vimeo.com/video/99")).toBe(
			"external-media",
		);
	});

	it("tags other URLs as external", () => {
		expect(classifyExternalUrl("https://google.com")).toBe("external");
		expect(classifyExternalUrl("https://github.com/acme/repo")).toBe(
			"external",
		);
	});

	it("falls back to external for unparseable URLs", () => {
		expect(classifyExternalUrl("not a url")).toBe("external");
	});
});

// ---------------------------------------------------------------------------
// rewriteInternalLinks
// ---------------------------------------------------------------------------

describe("rewriteInternalLinks", () => {
	const siteUrl = "https://example.com";
	const urlMap = {
		"/post/hello/": "/blog-post/hello/",
		"/about/": "/about/",
	};

	it("rewrites full-domain internal URLs via urlMap", () => {
		const content = { link: "https://example.com/post/hello/" };
		const result = rewriteInternalLinks(content, siteUrl, urlMap);
		expect(result.link).toBe("/blog-post/hello/");
	});

	it("keeps external URLs untouched", () => {
		const content = { link: "https://other.com/page" };
		const result = rewriteInternalLinks(content, siteUrl, urlMap);
		expect(result.link).toBe("https://other.com/page");
	});

	it("falls back to stripped path when not in urlMap", () => {
		const content = { link: "https://example.com/unmapped/" };
		const result = rewriteInternalLinks(content, siteUrl, urlMap);
		expect(result.link).toBe("/unmapped/");
	});

	it("handles nested arrays and objects", () => {
		const content = {
			nav: [
				{ href: "https://example.com/about/", label: "About" },
				{ href: "https://other.com/", label: "Other" },
			],
		};
		const result = rewriteInternalLinks(content, siteUrl, urlMap) as {
			nav: Array<{ href: string; label: string }>;
		};
		expect(result.nav[0].href).toBe("/about/");
		expect(result.nav[1].href).toBe("https://other.com/");
	});

	it("handles non-URL values (numbers, booleans, null)", () => {
		const content = {
			count: 42,
			active: true,
			note: null,
		};
		const result = rewriteInternalLinks(content, siteUrl, urlMap);
		expect(result.count).toBe(42);
		expect(result.active).toBe(true);
		expect(result.note).toBeNull();
	});

	it("rewrites relative internal paths via urlMap", () => {
		const content = { link: "/post/hello/" };
		const result = rewriteInternalLinks(content, siteUrl, urlMap);
		expect(result.link).toBe("/blog-post/hello/");
	});

	it("tolerates trailing-slash mismatch (path missing slash)", () => {
		const content = { link: "/post/hello" };
		const result = rewriteInternalLinks(content, siteUrl, urlMap);
		expect(result.link).toBe("/blog-post/hello/");
	});

	it("tolerates trailing-slash mismatch (urlMap missing slash)", () => {
		const content = { link: "/page/" };
		const result = rewriteInternalLinks(content, siteUrl, {
			"/page": "/final/",
		});
		expect(result.link).toBe("/final/");
	});

	it("leaves protocol-relative URLs untouched", () => {
		const content = { link: "//cdn.example.com/image.png" };
		const result = rewriteInternalLinks(content, siteUrl, urlMap);
		expect(result.link).toBe("//cdn.example.com/image.png");
	});

	it("leaves non-path strings (text) untouched", () => {
		const content = { title: "About Us", note: "Contact info" };
		const result = rewriteInternalLinks(content, siteUrl, urlMap);
		expect(result.title).toBe("About Us");
		expect(result.note).toBe("Contact info");
	});

	it("returns relative path unchanged when not in urlMap", () => {
		const content = { link: "/unmapped-relative/" };
		const result = rewriteInternalLinks(content, siteUrl, urlMap);
		expect(result.link).toBe("/unmapped-relative/");
	});
});

// ---------------------------------------------------------------------------
// rewriteImageUrls
// ---------------------------------------------------------------------------

describe("rewriteImageUrls", () => {
	const assetLookup = {
		"https://cdn.example.com/a.png": "abc123.png",
		"https://cdn.example.com/b.jpg": "def456.jpg",
	};

	it("rewrites known image URLs to local paths with images/ prefix", () => {
		const content = {
			hero: { src: "https://cdn.example.com/a.png" },
			logo: "https://cdn.example.com/b.jpg",
		};
		const result = rewriteImageUrls(content, assetLookup) as {
			hero: { src: string };
			logo: string;
		};
		expect(result.hero.src).toBe("images/abc123.png");
		expect(result.logo).toBe("images/def456.jpg");
	});

	it("leaves unknown URLs untouched", () => {
		const content = { src: "https://cdn.other.com/x.png" };
		const result = rewriteImageUrls(content, assetLookup);
		expect(result.src).toBe("https://cdn.other.com/x.png");
	});

	it("handles arrays and deep nesting", () => {
		const content = {
			gallery: [
				{ src: "https://cdn.example.com/a.png" },
				{ src: "https://cdn.example.com/b.jpg" },
			],
		};
		const result = rewriteImageUrls(content, assetLookup) as {
			gallery: Array<{ src: string }>;
		};
		expect(result.gallery[0].src).toBe("images/abc123.png");
		expect(result.gallery[1].src).toBe("images/def456.jpg");
	});
});

// ---------------------------------------------------------------------------
// collectExternalLinks
// ---------------------------------------------------------------------------

describe("collectExternalLinks", () => {
	const siteOrigin = "https://example.com";
	const urlMap = { "/about/": "/about/" };
	const assetLookup = {
		"https://cdn.example.com/photo.jpg": "abc.jpg",
	};

	it("collects plain external URLs", () => {
		const content = {
			twitter: "https://twitter.com/acme",
			link: "https://github.com/acme/repo",
		};
		const links = collectExternalLinks(
			content,
			"landing",
			siteOrigin,
			urlMap,
			assetLookup,
		);
		expect(links).toHaveLength(2);
		expect(links.every((l) => l.type === "external")).toBe(true);
	});

	it("tags youtube/vimeo URLs as external-media", () => {
		const content = {
			video: "https://www.youtube.com/watch?v=abc",
			demo: "https://vimeo.com/123",
		};
		const links = collectExternalLinks(
			content,
			"landing",
			siteOrigin,
			urlMap,
			assetLookup,
		);
		expect(links).toHaveLength(2);
		expect(links.every((l) => l.type === "external-media")).toBe(true);
	});

	it("excludes internal site URLs and image URLs", () => {
		const content = {
			self: "https://example.com/about/",
			image: "https://cdn.example.com/photo.jpg",
			external: "https://github.com/acme",
		};
		const links = collectExternalLinks(
			content,
			"landing",
			siteOrigin,
			urlMap,
			assetLookup,
		);
		expect(links).toHaveLength(1);
		expect(links[0].url).toBe("https://github.com/acme");
	});

	it("records pageType and fieldPath", () => {
		const content = {
			social: { twitter: "https://twitter.com/acme" },
			links: [{ href: "https://github.com/acme" }],
		};
		const links = collectExternalLinks(
			content,
			"landing",
			siteOrigin,
			urlMap,
			assetLookup,
		);
		expect(links).toHaveLength(2);
		const twitter = links.find((l) => l.url.includes("twitter"));
		expect(twitter?.pageType).toBe("landing");
		expect(twitter?.fieldPath).toBe("social.twitter");
		const github = links.find((l) => l.url.includes("github"));
		expect(github?.fieldPath).toBe("links[0].href");
	});
});

// ---------------------------------------------------------------------------
// updatePageUrls
// ---------------------------------------------------------------------------

describe("updatePageUrls", () => {
	it("updates page URLs via urlMap", () => {
		const pages: PreparedPage[] = [
			{ url: "/home-physio/", pagetype: "service", content: {}, schema: {} },
			{ url: "/about/", pagetype: "about", content: {}, schema: {} },
		];
		const urlMap = {
			"/home-physio/": "/service/home-physio/",
			"/about/": "/about/",
		};
		const updated = updatePageUrls(pages, urlMap);
		expect(updated[0].url).toBe("/service/home-physio/");
		expect(updated[1].url).toBe("/about/");
	});

	it("leaves URL unchanged when not in map", () => {
		const pages: PreparedPage[] = [
			{ url: "/orphan/", pagetype: "orphan", content: {}, schema: {} },
		];
		const updated = updatePageUrls(pages, {});
		expect(updated[0].url).toBe("/orphan/");
	});
});

// ---------------------------------------------------------------------------
// rewriteAllContent
// ---------------------------------------------------------------------------

describe("rewriteAllContent", () => {
	it("rewrites links, images, updates URLs, and collects externals per page", () => {
		const pages: PreparedPage[] = [
			{
				url: "/home-physio/",
				pagetype: "service",
				content: {
					hero: { src: "https://cdn.example.com/a.png" },
					body: "content",
					related: "https://example.com/about/",
					social: "https://twitter.com/acme",
					video: "https://www.youtube.com/watch?v=xyz",
				},
				schema: {},
			},
		];
		const siteUrl = "https://example.com";
		const urlMap = {
			"/home-physio/": "/service/home-physio/",
			"/about/": "/about/",
		};
		const assetLookup = {
			"https://cdn.example.com/a.png": "abc123.png",
		};

		const result = rewriteAllContent(pages, siteUrl, urlMap, assetLookup);

		expect(result.pages[0].url).toBe("/service/home-physio/");
		const c = result.pages[0].content as {
			hero: { src: string };
			related: string;
			social: string;
			video: string;
		};
		expect(c.hero.src).toBe("images/abc123.png");
		expect(c.related).toBe("/about/");
		expect(c.social).toBe("https://twitter.com/acme");
		expect(c.video).toBe("https://www.youtube.com/watch?v=xyz");

		expect(result.externalLinks).toHaveLength(2);
		const twitter = result.externalLinks.find((l) => l.url.includes("twitter"));
		const youtube = result.externalLinks.find((l) => l.url.includes("youtube"));
		expect(twitter?.type).toBe("external");
		expect(twitter?.pageType).toBe("service");
		expect(youtube?.type).toBe("external-media");
	});

	it("handles multiple pages and aggregates external links", () => {
		const pages: PreparedPage[] = [
			{
				url: "/a/",
				pagetype: "t1",
				content: { x: "https://github.com/1" },
				schema: {},
			},
			{
				url: "/b/",
				pagetype: "t2",
				content: { y: "https://github.com/2" },
				schema: {},
			},
		];
		const result = rewriteAllContent(pages, "https://example.com", {}, {});
		expect(result.externalLinks).toHaveLength(2);
		expect(result.externalLinks[0].pageType).toBe("t1");
		expect(result.externalLinks[1].pageType).toBe("t2");
	});
});

import { describe, expect, it } from "bun:test";
import {
	buildAssetEntries,
	buildAssetLookup,
	buildAssetManifest,
	collectImageUrls,
	contentAddressedName,
	inferExtension,
	isImageKey,
	looksLikeImageUrl,
	looksLikeUrl,
	scanAllImageUrls,
} from "./download.js";

// ---------------------------------------------------------------------------
// looksLikeUrl
// ---------------------------------------------------------------------------

describe("looksLikeUrl", () => {
	it("detects http/https/protocol-relative", () => {
		expect(looksLikeUrl("https://cdn.example.com/img.png")).toBe(true);
		expect(looksLikeUrl("http://example.com/img.png")).toBe(true);
		expect(looksLikeUrl("//cdn.example.com/img.png")).toBe(true);
	});

	it("rejects relative paths and non-URLs", () => {
		expect(looksLikeUrl("/images/local.png")).toBe(false);
		expect(looksLikeUrl("not a url")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// isImageKey
// ---------------------------------------------------------------------------

describe("isImageKey", () => {
	it("matches known image key names", () => {
		for (const key of [
			"src",
			"image",
			"icon",
			"background",
			"logo",
			"photo",
			"avatar",
		]) {
			expect(isImageKey(key)).toBe(true);
		}
	});

	it("is case insensitive", () => {
		expect(isImageKey("SRC")).toBe(true);
		expect(isImageKey("Logo")).toBe(true);
	});

	it("rejects non-image keys", () => {
		expect(isImageKey("href")).toBe(false);
		expect(isImageKey("title")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// looksLikeImageUrl
// ---------------------------------------------------------------------------

describe("looksLikeImageUrl", () => {
	it("detects common image extensions", () => {
		expect(looksLikeImageUrl("https://cdn.example.com/photo.jpg")).toBe(true);
		expect(looksLikeImageUrl("https://cdn.example.com/photo.png")).toBe(true);
		expect(looksLikeImageUrl("https://cdn.example.com/photo.webp")).toBe(true);
		expect(looksLikeImageUrl("https://cdn.example.com/photo.avif")).toBe(true);
		expect(looksLikeImageUrl("https://cdn.example.com/photo.svg")).toBe(true);
		expect(looksLikeImageUrl("https://cdn.example.com/photo.gif")).toBe(true);
		expect(looksLikeImageUrl("https://cdn.example.com/photo.ico")).toBe(true);
	});

	it("handles query strings after extension", () => {
		expect(
			looksLikeImageUrl("https://cdn.example.com/photo.jpg?w=200&q=80"),
		).toBe(true);
	});

	it("rejects non-image URLs", () => {
		expect(looksLikeImageUrl("https://example.com/page")).toBe(false);
		expect(looksLikeImageUrl("https://example.com/video.mp4")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// collectImageUrls
// ---------------------------------------------------------------------------

describe("collectImageUrls", () => {
	it("collects deeply nested image URLs", () => {
		const content = {
			header: {
				logo: "https://cdn.example.com/logo.png",
				navigation: [
					{ label: "Home", href: "https://example.com" },
					{ label: "About", href: "https://example.com/about" },
				],
			},
			hero: {
				background: "https://cdn.example.com/hero.jpg",
				title: "Welcome",
			},
			sections: [
				{
					images: [
						{
							src: "https://cdn.example.com/photo1.webp",
							alt: "Photo 1",
						},
					],
				},
			],
		};

		const urls: string[] = [];
		collectImageUrls(content, urls);

		expect(urls).toContain("https://cdn.example.com/logo.png");
		expect(urls).toContain("https://cdn.example.com/hero.jpg");
		expect(urls).toContain("https://cdn.example.com/photo1.webp");
		expect(urls).toHaveLength(3);
	});

	it("handles empty objects", () => {
		const urls: string[] = [];
		collectImageUrls({}, urls);
		expect(urls).toHaveLength(0);
	});

	it("handles null and primitives", () => {
		const urls: string[] = [];
		collectImageUrls(null, urls);
		collectImageUrls(undefined, urls);
		collectImageUrls("string", urls);
		collectImageUrls(42, urls);
		expect(urls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// contentAddressedName
// ---------------------------------------------------------------------------

describe("contentAddressedName", () => {
	it("produces deterministic names", () => {
		const a = contentAddressedName("https://example.com/img.png", "png");
		const b = contentAddressedName("https://example.com/img.png", "png");
		expect(a).toBe(b);
	});

	it("produces different names for different URLs", () => {
		const a = contentAddressedName("https://example.com/img1.png", "png");
		const b = contentAddressedName("https://example.com/img2.png", "png");
		expect(a).not.toBe(b);
	});

	it("uses the provided extension", () => {
		const name = contentAddressedName("https://example.com/img.png", "webp");
		expect(name.endsWith(".webp")).toBe(true);
	});

	it("hash is 16 chars", () => {
		const name = contentAddressedName("https://example.com/img.png", "png");
		const hash = name.split(".")[0];
		expect(hash).toHaveLength(16);
	});
});

// ---------------------------------------------------------------------------
// inferExtension
// ---------------------------------------------------------------------------

describe("inferExtension", () => {
	it("extracts extensions from URLs", () => {
		expect(inferExtension("https://cdn.example.com/photo.jpg")).toBe("jpg");
		expect(inferExtension("https://cdn.example.com/photo.png")).toBe("png");
		expect(inferExtension("https://cdn.example.com/photo.webp")).toBe("webp");
	});

	it("handles query strings", () => {
		expect(inferExtension("https://cdn.example.com/photo.jpg?w=200&q=80")).toBe(
			"jpg",
		);
	});

	it("defaults to png", () => {
		expect(inferExtension("https://cdn.example.com/image")).toBe("png");
		expect(inferExtension("https://cdn.example.com/video.mp4")).toBe("png");
	});
});

// ---------------------------------------------------------------------------
// scanAllImageUrls
// ---------------------------------------------------------------------------

describe("scanAllImageUrls", () => {
	it("scans multiple pages and deduplicates", () => {
		const pages = [
			{
				content: {
					logo: "https://cdn.example.com/logo.png",
					hero: { src: "https://cdn.example.com/hero.jpg" },
				},
			},
			{
				content: {
					logo: "https://cdn.example.com/logo.png",
					profile: { photo: "https://cdn.example.com/profile.webp" },
				},
			},
		];

		const urls = scanAllImageUrls(pages);
		expect(urls).toContain("https://cdn.example.com/logo.png");
		expect(urls).toContain("https://cdn.example.com/hero.jpg");
		expect(urls).toContain("https://cdn.example.com/profile.webp");
		expect(urls).toHaveLength(3); // logo deduplicated
	});
});

// ---------------------------------------------------------------------------
// buildAssetEntries
// ---------------------------------------------------------------------------

describe("buildAssetEntries", () => {
	it("creates entries with correct local paths and downloaded=false", () => {
		const urls = [
			"https://cdn.example.com/photo.jpg",
			"https://cdn.example.com/logo.png",
		];
		const entries = buildAssetEntries(urls);

		expect(entries).toHaveLength(2);
		for (const entry of entries) {
			expect(entry.downloaded).toBe(false);
			expect(entry.localPath).toMatch(/^[0-9a-f]{16}\.(jpg|png)$/);
		}
	});
});

// ---------------------------------------------------------------------------
// buildAssetManifest
// ---------------------------------------------------------------------------

describe("buildAssetManifest", () => {
	it("wraps entries in manifest envelope", () => {
		const entries = buildAssetEntries(["https://cdn.example.com/img.png"]);
		const manifest = buildAssetManifest(entries);
		expect(manifest.entries).toBe(entries);
	});
});

// ---------------------------------------------------------------------------
// buildAssetLookup
// ---------------------------------------------------------------------------

describe("buildAssetLookup", () => {
	it("builds originalUrl → localPath lookup for downloaded entries", () => {
		const entries = buildAssetEntries([
			"https://cdn.example.com/a.png",
			"https://cdn.example.com/b.jpg",
		]);
		// Simulate successful downloads
		for (const e of entries) e.downloaded = true;
		const lookup = buildAssetLookup(entries);

		expect(lookup["https://cdn.example.com/a.png"]).toBe(entries[0].localPath);
		expect(lookup["https://cdn.example.com/b.jpg"]).toBe(entries[1].localPath);
	});

	it("excludes entries with downloaded=false", () => {
		const entries = buildAssetEntries([
			"https://cdn.example.com/a.png",
			"https://cdn.example.com/b.jpg",
		]);
		entries[0].downloaded = true;
		entries[1].downloaded = false;
		const lookup = buildAssetLookup(entries);

		expect(lookup["https://cdn.example.com/a.png"]).toBe(entries[0].localPath);
		expect(lookup["https://cdn.example.com/b.jpg"]).toBeUndefined();
	});
});

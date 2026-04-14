/**
 * Pure: Phase 2 (download-assets) logic.
 *
 * Image URL scanning, asset manifest building, content-addressed naming.
 * The actual HTTP downloading is in phases.io.ts (IO layer).
 *
 * All functions are pure (data in → data out). No IO.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface AssetEntry {
	originalUrl: string;
	localPath: string;
	downloaded: boolean;
}

export interface AssetManifest {
	entries: AssetEntry[];
}

// ---------------------------------------------------------------------------
// URL detection helpers
// ---------------------------------------------------------------------------

export function looksLikeUrl(value: string): boolean {
	return (
		value.startsWith("http://") ||
		value.startsWith("https://") ||
		value.startsWith("//")
	);
}

export function isImageKey(key: string): boolean {
	return [
		"src",
		"image",
		"icon",
		"background",
		"logo",
		"photo",
		"avatar",
	].includes(key.toLowerCase());
}

export function looksLikeImageUrl(value: string): boolean {
	return /\.(png|jpe?g|gif|svg|webp|avif|ico)(\?.*)?$/i.test(value);
}

// ---------------------------------------------------------------------------
// collectImageUrls
// ---------------------------------------------------------------------------

/**
 * Recursively collect image URLs from nested content objects.
 * Uses both key-name heuristics (src, image, logo, ...) and extension-based
 * detection (.png, .jpg, .webp, ...).
 */
export function collectImageUrls(obj: unknown, accumulator: string[]): void {
	if (!obj || typeof obj !== "object") return;

	if (Array.isArray(obj)) {
		for (const item of obj) {
			collectImageUrls(item, accumulator);
		}
		return;
	}

	const record = obj as Record<string, unknown>;
	for (const [key, value] of Object.entries(record)) {
		if (
			typeof value === "string" &&
			looksLikeUrl(value) &&
			(isImageKey(key) || looksLikeImageUrl(value))
		) {
			accumulator.push(value);
		} else {
			collectImageUrls(value, accumulator);
		}
	}
}

// ---------------------------------------------------------------------------
// contentAddressedName
// ---------------------------------------------------------------------------

/**
 * Build a content-addressed filename from a URL using SHA256.
 * Produces a stable, deterministic name given the same URL.
 */
export function contentAddressedName(url: string, ext: string): string {
	const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
	return `${hash}.${ext}`;
}

// ---------------------------------------------------------------------------
// inferExtension
// ---------------------------------------------------------------------------

/**
 * Infer image file extension from a URL. Falls back to "png".
 */
export function inferExtension(url: string): string {
	const match = url.match(/\.(png|jpe?g|gif|svg|webp|avif|ico)(\?.*)?$/i);
	return match ? match[1].toLowerCase() : "png";
}

// ---------------------------------------------------------------------------
// scanAllImageUrls
// ---------------------------------------------------------------------------

/**
 * Scan all page content for image URLs. Returns a deduplicated list.
 */
export function scanAllImageUrls(
	pages: Array<{ content: Record<string, unknown> }>,
): string[] {
	const accumulator: string[] = [];
	for (const page of pages) {
		collectImageUrls(page.content, accumulator);
	}
	return [...new Set(accumulator)];
}

// ---------------------------------------------------------------------------
// buildAssetEntries
// ---------------------------------------------------------------------------

/**
 * Build AssetEntry[] from a list of unique image URLs.
 * All entries start with `downloaded: false` — the IO layer sets them to true
 * after successfully fetching.
 */
export function buildAssetEntries(imageUrls: string[]): AssetEntry[] {
	return imageUrls.map((url) => ({
		originalUrl: url,
		localPath: contentAddressedName(url, inferExtension(url)),
		downloaded: false,
	}));
}

// ---------------------------------------------------------------------------
// buildAssetManifest
// ---------------------------------------------------------------------------

/**
 * Build the asset manifest envelope from entries.
 */
export function buildAssetManifest(entries: AssetEntry[]): AssetManifest {
	return { entries };
}

/**
 * Build a lookup map from asset manifest entries: originalUrl → localPath.
 * Useful for downstream rewriting.
 *
 * Skips entries with `downloaded: false` — content referencing those URLs
 * will remain unrewritten so downstream doesn't point at missing files.
 */
export function buildAssetLookup(
	entries: AssetEntry[],
): Record<string, string> {
	const lookup: Record<string, string> = {};
	for (const entry of entries) {
		if (!entry.downloaded) continue;
		lookup[entry.originalUrl] = entry.localPath;
	}
	return lookup;
}

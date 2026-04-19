/**
 * IO shell: prepare segment phase definitions.
 *
 * Six fully programmatic phases — zero AI. Each phase reads JSON from the
 * workdir, calls pure functions, and writes results back.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PhaseDef } from "../../engine/types.js";
import { Semaphore } from "../../lib/semaphore.js";
import { programmaticStep } from "../../steps/step.js";
import type { ContentData, SchemaData, StructureData } from "../../types.js";
import {
	type AssetManifest,
	buildAssetEntries,
	buildAssetLookup,
	buildAssetManifest,
	scanAllImageUrls,
} from "./download.js";
import {
	buildHeuristicsData,
	buildStructureMaps,
	type Heuristics,
	type StructureMap,
} from "./heuristics.js";
import {
	buildPageTypeMeta,
	buildPreparedPages,
	flattenContent,
	normalizeStructurePatterns,
	type PageTypeMeta,
	type PreparedPage,
	reconcileMetaWithPages,
	resolveSchemaPages,
	validateContentAgainstSchema,
} from "./ingest.js";
import { rewriteAllContent } from "./rewrites.js";
import {
	type InternalUrlMap,
	resolveAllRoutes,
	updatePageTypeMeta,
} from "./routes.js";
import { validateDataset } from "./validate.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_DOWNLOADS = 10;
const MAX_DOWNLOAD_RETRIES = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJson<T>(workdir: string, filename: string): Promise<T> {
	const raw = await readFile(join(workdir, filename), "utf-8");
	return JSON.parse(raw) as T;
}

async function writeJson(
	workdir: string,
	filename: string,
	data: unknown,
): Promise<void> {
	await writeFile(join(workdir, filename), JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Phase 1: ingest
// ---------------------------------------------------------------------------

export const ingestPhase: PhaseDef = {
	id: "ingest",
	name: "Ingest",
	description:
		"Parse scraper output, resolve schema $ref pointers, validate content, build pages.json + page-type-meta.json",
	maxRetries: 0,
	steps: [
		programmaticStep({
			id: "parse-and-validate",
			name: "Parse and validate",
			description:
				"Flatten content, resolve schemas, validate, build PreparedPages + PageTypeMeta",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const [rawStructure, schema, content] = await Promise.all([
						readJson<StructureData>(ctx.workdir, "structure.json"),
						readJson<SchemaData>(ctx.workdir, "schema.json"),
						readJson<ContentData>(ctx.workdir, "content.json"),
					]);

					// Normalize placeholder names (e.g. "{service-path}" → "{service_path}")
					// so downstream regexes and Astro route params are identifier-safe.
					// Write the normalized structure back so all later phases see it.
					const structure = normalizeStructurePatterns(rawStructure);
					await writeJson(ctx.workdir, "structure.json", structure);

					const pages = flattenContent(content);
					const resolvedSchemas = resolveSchemaPages(schema);

					const validation = validateContentAgainstSchema(
						pages,
						resolvedSchemas,
					);
					if (!validation.valid) {
						ctx.logger.note(
							`[prepare:ingest] ${validation.warnings.length} content/schema warnings`,
						);
						for (const w of validation.warnings) {
							ctx.logger.note(
								`  ${w.pageType} ${w.url}: missing ${w.missingField}`,
							);
						}
					}

					const prepared = buildPreparedPages(pages, resolvedSchemas);
					const rawMeta = buildPageTypeMeta(structure);
					const meta = reconcileMetaWithPages(rawMeta, pages);

					// Log any URLs the scraper listed in structure but didn't scrape
					const droppedCount =
						rawMeta.reduce((sum, m) => sum + m.urls.length, 0) -
						meta.reduce((sum, m) => sum + m.urls.length, 0);
					if (droppedCount > 0) {
						ctx.logger.note(
							`[prepare:ingest] dropped ${droppedCount} meta url(s) with no matching content`,
						);
					}

					await Promise.all([
						writeJson(ctx.workdir, "pages.json", prepared),
						writeJson(ctx.workdir, "page-type-meta.json", meta),
					]);

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Ingest failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),
	],
};

// ---------------------------------------------------------------------------
// Phase 2: download-assets
// ---------------------------------------------------------------------------

export const downloadAssetsPhase: PhaseDef = {
	id: "download-assets",
	name: "Download Assets",
	description:
		"Scan all content for image URLs, download every image, build asset-manifest.json",
	maxRetries: 0,
	steps: [
		programmaticStep({
			id: "download-all-images",
			name: "Download all images",
			description:
				"Scan content, download images with concurrency limit, build manifest",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const content = await readJson<ContentData>(
						ctx.workdir,
						"content.json",
					);

					// Flatten to pages with content for scanning
					const pages = flattenContent(content);
					const pagesForScan = pages.map((p) => ({ content: p.content }));
					const imageUrls = scanAllImageUrls(pagesForScan);

					ctx.logger.note(
						`[prepare:download] Found ${imageUrls.length} unique image URLs`,
					);

					const entries = buildAssetEntries(imageUrls);

					// Create images directory
					const imagesDir = join(ctx.workdir, "images");
					await mkdir(imagesDir, { recursive: true });

					// Download with semaphore
					const semaphore = new Semaphore(MAX_CONCURRENT_DOWNLOADS);
					const tasks = entries.map(async (entry) => {
						const release = await semaphore.acquire();
						try {
							await downloadWithRetry(
								entry.originalUrl,
								join(imagesDir, entry.localPath),
							);
							entry.downloaded = true;
						} catch (err) {
							ctx.logger.note(
								`[prepare:download] Failed: ${entry.originalUrl}: ${String(err)}`,
							);
							entry.downloaded = false;
						} finally {
							release();
						}
					});

					await Promise.all(tasks);

					const manifest = buildAssetManifest(entries);
					await writeJson(ctx.workdir, "asset-manifest.json", manifest);

					const downloaded = entries.filter((e) => e.downloaded).length;
					ctx.logger.note(
						`[prepare:download] ${downloaded}/${entries.length} images downloaded`,
					);

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Download failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),
	],
};

async function downloadWithRetry(
	url: string,
	destPath: string,
	retries = MAX_DOWNLOAD_RETRIES,
): Promise<void> {
	const normalizedUrl = url.startsWith("//") ? `https:${url}` : url;
	for (let attempt = 0; attempt < retries; attempt++) {
		try {
			const resp = await fetch(normalizedUrl);
			if (!resp.ok) {
				throw new Error(`HTTP ${resp.status} for ${normalizedUrl}`);
			}
			const buffer = await resp.arrayBuffer();
			await writeFile(destPath, Buffer.from(buffer));
			return;
		} catch (err) {
			if (attempt < retries - 1) {
				// Linear backoff: 1s, 2s
				await new Promise((resolve) =>
					setTimeout(resolve, (attempt + 1) * 1000),
				);
			} else {
				throw err;
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Phase 3: resolve-routes
// ---------------------------------------------------------------------------

export const resolveRoutesPhase: PhaseDef = {
	id: "resolve-routes",
	name: "Resolve Routes",
	description:
		"Heuristic route conflict detection and prefix rewriting. Builds url-map and updates page-type-meta",
	maxRetries: 0,
	steps: [
		programmaticStep({
			id: "resolve-routes",
			name: "Resolve routes",
			description:
				"Classify page types, detect conflicts, prefix rewrites, build url-map",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const structure = await readJson<StructureData>(
						ctx.workdir,
						"structure.json",
					);
					const meta = await readJson<PageTypeMeta[]>(
						ctx.workdir,
						"page-type-meta.json",
					);

					const resolved = resolveAllRoutes(structure);
					const updatedMeta = updatePageTypeMeta(meta, resolved);

					// url-map.json is internal — consumed by Phase 4 only
					await Promise.all([
						writeJson(ctx.workdir, "url-map.json", resolved),
						writeJson(ctx.workdir, "page-type-meta.json", updatedMeta),
					]);

					const rewritten = Object.values(resolved.patternMap).filter(
						(p) => p.rewritten,
					);
					if (rewritten.length > 0) {
						ctx.logger.note(
							`[prepare:routes] ${rewritten.length} page type(s) rewritten:`,
						);
						for (const r of rewritten) {
							ctx.logger.note(
								`  ${r.pageType}: ${r.originalPattern} → ${r.finalPattern}`,
							);
						}
					} else {
						ctx.logger.note("[prepare:routes] No route conflicts detected");
					}

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Route resolution failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),
	],
};

// ---------------------------------------------------------------------------
// Phase 4: apply-rewrites
// ---------------------------------------------------------------------------

export const applyRewritesPhase: PhaseDef = {
	id: "apply-rewrites",
	name: "Apply Rewrites",
	description:
		"Rewrite internal links and image URLs in content, update page URLs to final",
	maxRetries: 0,
	steps: [
		programmaticStep({
			id: "rewrite-content",
			name: "Rewrite content",
			description:
				"Rewrite links via url-map, images via asset-manifest, collect external links",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const [pages, structure, urlMapData, manifest] = await Promise.all([
						readJson<PreparedPage[]>(ctx.workdir, "pages.json"),
						readJson<StructureData>(ctx.workdir, "structure.json"),
						readJson<InternalUrlMap>(ctx.workdir, "url-map.json"),
						readJson<AssetManifest>(ctx.workdir, "asset-manifest.json"),
					]);

					const assetLookup = buildAssetLookup(manifest.entries);
					const preparedContent = rewriteAllContent(
						pages,
						structure.site_url ?? "",
						urlMapData.urlMap,
						assetLookup,
					);

					// Update pages.json to final URLs + rewritten content
					await Promise.all([
						writeJson(ctx.workdir, "prepared-content.json", preparedContent),
						writeJson(ctx.workdir, "pages.json", preparedContent.pages),
					]);

					ctx.logger.note(
						`[prepare:rewrites] ${preparedContent.externalLinks.length} external links collected`,
					);

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Rewrite failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),
	],
};

// ---------------------------------------------------------------------------
// Phase 5: build-heuristics
// ---------------------------------------------------------------------------

export const buildHeuristicsPhase: PhaseDef = {
	id: "build-heuristics",
	name: "Build Heuristics",
	description:
		"Build structure maps (compact trees) and heuristics (stats, field frequency)",
	maxRetries: 0,
	steps: [
		programmaticStep({
			id: "build-structure-maps",
			name: "Build structure maps",
			description:
				"Walk richest sample per page type, produce compact structural trees",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const pages = await readJson<PreparedPage[]>(
						ctx.workdir,
						"pages.json",
					);

					const maps = buildStructureMaps(pages);
					await writeJson(ctx.workdir, "structure-map.json", maps);

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Structure map build failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),
		programmaticStep({
			id: "build-heuristics",
			name: "Build heuristics",
			description:
				"Generate page stats, field frequency, content length analysis",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const pages = await readJson<PreparedPage[]>(
						ctx.workdir,
						"pages.json",
					);

					const heuristics = buildHeuristicsData(pages);
					await writeJson(ctx.workdir, "heuristics.json", heuristics);

					ctx.logger.note(
						`[prepare:heuristics] ${heuristics.totalPages} pages, ${heuristics.totalPageTypes} types, ${Object.keys(heuristics.fieldFrequency).length} fields`,
					);

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Heuristics build failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),
	],
};

// ---------------------------------------------------------------------------
// Phase 6: validate-dataset
// ---------------------------------------------------------------------------

export const validateDatasetPhase: PhaseDef = {
	id: "validate-dataset",
	name: "Validate Dataset",
	description:
		"Hard assertions: self-contained, referentially complete, no dangling refs",
	maxRetries: 0,
	steps: [
		programmaticStep({
			id: "validate-completeness",
			name: "Validate completeness",
			description: "Run 15 assertions on the full prepare output",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const [
						pages,
						meta,
						manifest,
						preparedContent,
						urlMapData,
						heuristics,
						structureMaps,
					] = await Promise.all([
						readJson<PreparedPage[]>(ctx.workdir, "pages.json"),
						readJson<PageTypeMeta[]>(ctx.workdir, "page-type-meta.json"),
						readJson<AssetManifest>(ctx.workdir, "asset-manifest.json"),
						readJson<{
							unresolvedInternalLinks?: Array<{ path: string }>;
						}>(ctx.workdir, "prepared-content.json"),
						readJson<InternalUrlMap>(ctx.workdir, "url-map.json"),
						readJson<Heuristics>(ctx.workdir, "heuristics.json"),
						readJson<StructureMap[]>(ctx.workdir, "structure-map.json"),
					]);

					const structure = await readJson<StructureData>(
						ctx.workdir,
						"structure.json",
					);

					// Build the set of actually-existing image files for assertion 6
					const imagesDir = join(ctx.workdir, "images");
					let existingFiles: string[];
					try {
						existingFiles = await readdir(imagesDir);
					} catch {
						existingFiles = [];
					}

					const unresolvedInternalPaths = new Set(
						(preparedContent.unresolvedInternalLinks ?? []).map((u) => u.path),
					);

					const result = validateDataset({
						pages,
						pageTypeMeta: meta,
						assetEntries: manifest.entries,
						siteUrl: structure.site_url ?? "",
						existingImageFiles: new Set(existingFiles),
						unresolvedInternalPaths,
						urlMap: urlMapData.urlMap,
						heuristics,
						structureMaps,
					});

					if (!result.valid) {
						const details = result.failures
							.map(
								(f) =>
									`Assertion ${f.assertion} (${f.description}):\n${f.details.map((d) => `  - ${d}`).join("\n")}`,
							)
							.join("\n\n");

						ctx.logger.note(`[prepare:validate] FAILED\n${details}`);

						return {
							status: "fail",
							error: `Dataset validation failed:\n${details}`,
							duration: Date.now() - start,
						};
					}

					ctx.logger.note("[prepare:validate] All 15 assertions passed");
					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Validation failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),
	],
};

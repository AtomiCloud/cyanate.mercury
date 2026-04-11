/**
 * IO shell: wireframe segment phase definitions.
 *
 * Thin wiring that reads files, calls agents, calls pure functions, writes results.
 * Each phase is a PhaseDef consumed by the engine.
 */

import { exec as execCallback } from "node:child_process";
import {
	access,
	constants,
	copyFile,
	cp,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PhaseDef } from "../../engine/types.js";
import { agentQuery } from "../../lib/agent.js";
import {
	consoleErrorReviewer,
	contentReviewer,
	staticChecksReviewer,
	traceReviewer,
	visionReviewer,
} from "../../lib/reviewers.io.js";
import { Semaphore } from "../../lib/semaphore.js";
import { agentStep, programmaticStep, reviewerStep } from "../../steps/step.js";
import type { PageContent, SchemaData, StructureData } from "../../types.js";
import type {
	ArchitectureClassification,
	ConflictReport,
	ContentModelClassification,
	ContentModelOutput,
	InteractionClassification,
} from "./classify.js";
import {
	buildComponentManifestFromFiles,
	crossValidateClassifiers,
	detectConflicts,
	validateComponentManifestRefs,
	validateContentModelRefs,
	validateRegistryCompleteness,
	validateRoutePatterns,
} from "./classify.js";
import {
	buildAssetManifest,
	buildReducedMeta,
	buildReducedTree,
	groupByPageType,
	rewriteInternalLinks,
	selectSamples,
} from "./reduce.js";
import {
	generateCollectionEntries,
	generateContentConfig,
	generateGlobals,
	generateRouteFiles,
	validateSeedCompleteness,
} from "./seed.js";
import type { ValidateWireframeResult } from "./wireframe-validate.js";
import { validateWireframeOutput } from "./wireframe-validate.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_CLASSIFIERS = 3;
const MAX_CONCURRENT_GENERATORS = 3;
const classifierSemaphore = new Semaphore(MAX_CONCURRENT_CLASSIFIERS);
const generatorSemaphore = new Semaphore(MAX_CONCURRENT_GENERATORS);
const execAsync = promisify(execCallback);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read and parse a JSON file, returning null if missing or unparseable. */
async function readJson<T>(
	workdir: string,
	filename: string,
): Promise<T | null> {
	try {
		const raw = await readFile(join(workdir, filename), "utf-8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/** Write JSON to file in workdir. */
async function writeJson(
	workdir: string,
	filename: string,
	data: unknown,
): Promise<void> {
	await mkdir(join(workdir, filename).split("/").slice(0, -1).join("/"), {
		recursive: true,
	});
	await writeFile(
		join(workdir, filename),
		JSON.stringify(data, null, 2),
		"utf-8",
	);
}

/** Copy scraper input files to workdir if they don't already exist. */
async function copyInputFilesToWorkdir(
	inputDir: string,
	workdir: string,
): Promise<void> {
	for (const file of ["structure.json", "schema.json", "content.json"]) {
		const dest = join(workdir, file);
		const alreadyExists = await exists(dest);
		if (!alreadyExists) {
			try {
				await copyFile(join(inputDir, file), dest);
			} catch {
				// Input file may not exist
			}
		}
	}
}

/** Check if a file/directory exists. */
async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Phase 1: Reduce
// ---------------------------------------------------------------------------

export const reducePhase: PhaseDef = {
	id: "reduce",
	name: "Reduce",
	description:
		"Group pages by type, select samples, build asset manifest, rewrite links",
	maxRetries: 2,
	steps: [
		programmaticStep({
			id: "reduce-all",
			name: "Reduce scraper output",
			description:
				"Group pages, select samples, build manifest, rewrite links, write reduced tree",
			run: async (ctx) => {
				const start = Date.now();
				try {
					// Copy scraper input files to workdir if not present
					await copyInputFilesToWorkdir(ctx.config.input, ctx.workdir);

					// Read scraper output
					const structure = await readJson<StructureData>(
						ctx.workdir,
						"structure.json",
					);
					const content = await readJson<{ pages: PageContent[] }>(
						ctx.workdir,
						"content.json",
					);
					const schema = await readJson<SchemaData>(ctx.workdir, "schema.json");

					if (!structure || !content) {
						return {
							status: "fail",
							error: "Missing structure.json or content.json",
							duration: Date.now() - start,
						};
					}

					const pages = content.pages;
					const siteUrl = structure.site_url ?? ctx.config.input;

					// Build content map for selectSamples
					const contentMap = new Map<string, PageContent>();
					for (const p of pages) contentMap.set(p.id, p);

					// Pure: group by page type
					const grouped = groupByPageType(structure.pages);

					// Pure: select richest + simplest per type
					const samples = selectSamples(grouped, contentMap);

					// Pure: build asset manifest
					const assetManifest = buildAssetManifest(pages);

					// Pure: build route map for link rewriting
					const routeMap = new Map<string, string>();
					for (const page of structure.pages) {
						try {
							const path = new URL(page.url, siteUrl).pathname;
							routeMap.set(path, path);
						} catch {
							routeMap.set(page.url, page.url);
						}
					}

					// Pure: rewrite internal links
					const rewrittenContent = new Map<string, Record<string, unknown>>();
					for (const page of pages) {
						rewrittenContent.set(
							page.url,
							rewriteInternalLinks(page.content, siteUrl, routeMap),
						);
					}

					// Pure: build reduced tree
					const tree = buildReducedTree(
						samples,
						rewrittenContent,
						assetManifest,
					);

					// IO: write reduced tree to workdir
					const reducedDir = join(ctx.workdir, "reduced");
					await mkdir(reducedDir, { recursive: true });

					for (const file of tree) {
						const filePath = join(ctx.workdir, file.path);
						await mkdir(filePath.split("/").slice(0, -1).join("/"), {
							recursive: true,
						});
						await writeFile(filePath, file.content, "utf-8");
					}

					// IO: download images from asset manifest
					const imagesDir = join(ctx.workdir, "public", "images");
					await mkdir(imagesDir, { recursive: true });
					await downloadAssetImages(assetManifest, imagesDir);

					// Build reduced metadata (conforming to ReducedMeta type)
					const scrapedAt = structure.scraped_at ?? new Date().toISOString();
					const metadata = buildReducedMeta(
						grouped,
						pages,
						schema ?? {},
						siteUrl,
						scrapedAt,
					);

					await writeJson(ctx.workdir, "reduced-meta.json", metadata);

					ctx.logger.startStep(
						`Reduced ${pages.length} pages into ${grouped.size} types`,
					);

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Reduce failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),
	],
};

// ---------------------------------------------------------------------------
// Phase 2: Classify
// ---------------------------------------------------------------------------

export const classifyPhase: PhaseDef = {
	id: "classify",
	name: "Classify",
	description:
		"AI classifiers for architecture, content model, and interaction; cross-validation and incremental merge",
	maxRetries: 2,
	steps: [
		// Step 2a: Fan-out — 3 parallel classifiers
		programmaticStep({
			id: "run-classifiers",
			name: "Run classifiers",
			description:
				"Spawn 3 parallel AI classifiers: architecture, content model, interaction",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const structure = await readJson<StructureData>(
						ctx.workdir,
						"structure.json",
					);
					const schema = await readJson<Record<string, unknown>>(
						ctx.workdir,
						"schema.json",
					);
					const reducedMeta = await readJson<Record<string, unknown>>(
						ctx.workdir,
						"reduced-meta.json",
					);

					if (!structure || !schema || !reducedMeta) {
						return {
							status: "fail",
							error:
								"Missing structure.json, schema.json, or reduced-meta.json",
							duration: Date.now() - start,
						};
					}

					// Read sample content for context
					const reducedDir = join(ctx.workdir, "reduced");
					const sampleContexts: string[] = [];
					for (const pt of reducedMeta.page_types as Array<{
						pagetype: string;
					}>) {
						try {
							const richest = await readFile(
								join(reducedDir, pt.pagetype, "richest.json"),
								"utf-8",
							);
							sampleContexts.push(
								`## ${pt.pagetype}\n${richest.slice(0, 2000)}`,
							);
						} catch {
							sampleContexts.push(`## ${pt.pagetype}\n(No sample)`);
						}
					}

					const baseContext = `Site URL: ${structure.site_url ?? "unknown"}
Page types: ${(reducedMeta.page_types as Array<{ pagetype: string }>).map((p) => p.pagetype).join(", ")}
Schema: ${JSON.stringify(schema, null, 2).slice(0, 3000)}

Sample content:
${sampleContexts.join("\n\n")}`;

					// Fan-out 3 classifiers with semaphore
					const tasks = [
						classifierSemaphore.acquire().then(async (release) => {
							try {
								const output = await agentQuery({
									prompt: `You are an architecture classifier. Analyze the site structure and classify the architecture.

${baseContext}

Output a JSON object:
{
  "layouts": {
    "<layout_name>": {
      "description": "<what this layout is for>",
      "page_types": ["<pagetype1>", "<pagetype2>"]
    }
  },
  "routes": [
    { "pattern": "/<route>", "pageType": "<pagetype>" }
  ]
}

Use [slug] for dynamic segments. Output ONLY the JSON.`,
									cwd: ctx.workdir,
									profile: ctx.profile,
									stepName: "wireframe/classify/architecture",
									logger: ctx.logger,
									config: ctx.config,
								});

								const jsonMatch = output.match(/\{[\s\S]*\}/);
								return {
									type: "architecture",
									data: jsonMatch
										? (JSON.parse(jsonMatch[0]) as ArchitectureClassification)
										: null,
								};
							} finally {
								release();
							}
						}),

						classifierSemaphore.acquire().then(async (release) => {
							try {
								const output = await agentQuery({
									prompt: `You are a content model classifier. Analyze the content schema and classify the content model.

${baseContext}

Output a JSON object:
{
  "collections": {
    "<collection_name>": {
      "source_pagetype": "<pagetype>",
      "slug_field": "<field_name>"
    }
  },
  "listings": {
    "<listing_name>": {
      "route": "/<route>",
      "paginated": true
    }
  }
}

Output ONLY the JSON.`,
									cwd: ctx.workdir,
									profile: ctx.profile,
									stepName: "wireframe/classify/content-model",
									logger: ctx.logger,
									config: ctx.config,
								});

								const jsonMatch = output.match(/\{[\s\S]*\}/);
								return {
									type: "content-model",
									data: jsonMatch
										? (JSON.parse(jsonMatch[0]) as ContentModelClassification)
										: null,
								};
							} finally {
								release();
							}
						}),

						classifierSemaphore.acquire().then(async (release) => {
							try {
								const output = await agentQuery({
									prompt: `You are an interaction classifier. Analyze the site content and identify interactive UI patterns.

${baseContext}

Output a JSON object:
{
  "patterns": [
    {
      "id": "<pattern_id>",
      "type": "<fragment|modal|accordion|tabs|search|filter|form|popup|other>",
      "pageType": "<pagetype>",
      "description": "<what the pattern does>"
    }
  ]
}

Output ONLY the JSON.`,
									cwd: ctx.workdir,
									profile: ctx.profile,
									stepName: "wireframe/classify/interaction",
									logger: ctx.logger,
									config: ctx.config,
								});

								const jsonMatch = output.match(/\{[\s\S]*\}/);
								return {
									type: "interaction",
									data: jsonMatch
										? (JSON.parse(jsonMatch[0]) as InteractionClassification)
										: null,
								};
							} finally {
								release();
							}
						}),
					];

					const results = await Promise.all(tasks);
					const failures = results.filter((r) => r.data === null);

					if (failures.length > 0) {
						return {
							status: "fail",
							error: `${failures.length} classifiers failed: ${failures.map((f) => f.type).join(", ")}`,
							duration: Date.now() - start,
						};
					}

					// Write individual classifier outputs
					for (const r of results) {
						if (r.data) {
							await writeJson(ctx.workdir, `classifier-${r.type}.json`, r.data);
						}
					}

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Classifier fan-out failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),

		// Step 2b: Cross-validate classifier outputs
		programmaticStep({
			id: "cross-validate",
			name: "Cross-validate classifiers",
			description:
				"Validate classifier outputs for consistency and completeness",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const arch = await readJson<ArchitectureClassification>(
						ctx.workdir,
						"classifier-architecture.json",
					);
					const cm = await readJson<ContentModelClassification>(
						ctx.workdir,
						"classifier-content-model.json",
					);
					const interaction = await readJson<InteractionClassification>(
						ctx.workdir,
						"classifier-interaction.json",
					);
					const reducedMeta = await readJson<{
						page_types: Array<{ pagetype: string }>;
					}>(ctx.workdir, "reduced-meta.json");

					if (!arch || !cm || !interaction || !reducedMeta) {
						return {
							status: "fail",
							error: "Missing classifier output files",
							duration: Date.now() - start,
						};
					}

					const knownPageTypes = reducedMeta.page_types.map((p) => p.pagetype);
					const allErrors: string[] = [];

					// Cross-validate
					const cvResult = crossValidateClassifiers(
						arch,
						cm,
						interaction,
						knownPageTypes,
					);
					allErrors.push(...cvResult.errors);

					// Detect conflicts between classifiers
					const conflicts: ConflictReport = detectConflicts(arch, cm);
					for (const conflict of conflicts.conflicts) {
						allErrors.push(
							`Classifier conflict (${conflict.type}): ${conflict.description}`,
						);
					}

					// Validate route patterns
					if (arch.routes) {
						const routeResult = validateRoutePatterns(arch.routes);
						for (const conflict of routeResult.conflicts) {
							allErrors.push(
								`Route conflict: ${conflict.a} vs ${conflict.b}: ${conflict.reason}`,
							);
						}
					}

					if (allErrors.length > 0) {
						return {
							status: "reject",
							reviews: allErrors.map((err) => ({
								reviewerId: "cross-validator",
								verdict: "reject" as const,
								findings: err,
								rejectionContext: `Classification error: ${err}`,
							})),
							duration: Date.now() - start,
						};
					}

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Cross-validation failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),

		// Step 2c: Reviewer — semantic consistency
		reviewerStep({
			id: "semantic-review",
			name: "Semantic consistency review",
			description: "AI review of classifier outputs for semantic consistency",
			buildPrompt: async (ctx) => {
				const arch = await readJson<ArchitectureClassification>(
					ctx.workdir,
					"classifier-architecture.json",
				);
				const cm = await readJson<ContentModelClassification>(
					ctx.workdir,
					"classifier-content-model.json",
				);
				const interaction = await readJson<InteractionClassification>(
					ctx.workdir,
					"classifier-interaction.json",
				);

				return `You are a semantic consistency reviewer. Review these classifier outputs for coherence.

## Architecture
${JSON.stringify(arch, null, 2)}

## Content Model
${JSON.stringify(cm, null, 2)}

## Interaction
${JSON.stringify(interaction, null, 2)}

Check:
1. Layout assignments are semantically consistent (e.g., blog posts shouldn't use a landing layout)
2. Collection definitions match page types in architecture
3. Route patterns make sense for the content model
4. Interaction patterns are appropriate for their assigned page types

Respond with:
VERDICT: PASS — if all checks pass
VERDICT: REJECT — if any issues found

If rejecting, list specific issues and provide REJECTION CONTEXT with actionable fixes.`;
			},
		}),

		// Step 2d-1: Agent — merge layouts and routing into registry draft
		agentStep({
			id: "merge-layouts",
			name: "Merge layouts and routing",
			description:
				"Merge architecture classifier into registry layouts and routes",
			buildPrompt: async (ctx) => {
				const arch = await readJson<ArchitectureClassification>(
					ctx.workdir,
					"classifier-architecture.json",
				);
				const reducedMeta = await readJson<{
					page_types: Array<{
						pagetype: string;
						route: string;
						multi: boolean;
						has_pagination: boolean;
					}>;
				}>(ctx.workdir, "reduced-meta.json");

				return `You are a registry builder (step 1 of 5). Build the layouts and static_pages portion of a registry.

	## Architecture
	${JSON.stringify(arch, null, 2)}

	## Reduced Meta
	${JSON.stringify(reducedMeta, null, 2)}

	Build a partial registry JSON:
	{
	  "layouts": {
	    "<name>": { "description": "...", "page_types": ["..."] }
	  },
	  "static_pages": [
	    { "pagetype": "...", "route": "...", "layout": "..." }
	  ]
	}

	Rules:
	- Every layout from architecture must be included
	- Static pages get direct routes; collection pages (multi=true or has_pagination=true) should NOT be in static_pages
	- Layout assignments must match page types from the architecture

	Output ONLY the JSON.`;
			},
			validate: async (ctx, output) => {
				const jsonMatch = output.match(/\{[\s\S]*\}/);
				if (!jsonMatch) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "merge-layouts-parser",
								verdict: "reject",
								findings: "No JSON found in layouts merge output",
								rejectionContext:
									"Output must contain a valid JSON registry object.",
							},
						],
					};
				}
				try {
					const partial = JSON.parse(jsonMatch[0]);
					await writeJson(
						ctx.workdir,
						"registry-partial-layouts.json",
						partial,
					);
					return { status: "pass" };
				} catch (err) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "merge-layouts-parser",
								verdict: "reject",
								findings: `Invalid JSON: ${String(err)}`,
								rejectionContext: "Registry partial must be valid JSON.",
							},
						],
					};
				}
			},
		}),

		// Step 2d-2: Agent — build content-model.json (collections + listings)
		agentStep({
			id: "merge-content-model",
			name: "Build content model",
			description:
				"Build content-model.json with collections and listings from classifier output",
			buildPrompt: async (ctx) => {
				const cm = await readJson<ContentModelClassification>(
					ctx.workdir,
					"classifier-content-model.json",
				);
				const reducedMeta = await readJson<{
					page_types: Array<{
						pagetype: string;
						route: string;
						multi: boolean;
						has_pagination: boolean;
					}>;
				}>(ctx.workdir, "reduced-meta.json");

				return `You are a content model builder (step 2 of 5). Build the content-model.json file.

		## Content Model Classifier
		${JSON.stringify(cm, null, 2)}

		## Reduced Meta
		${JSON.stringify(reducedMeta, null, 2)}

		Build a content-model.json:
		{
		  "collections": {
		    "<name>": {
		      "source_pagetype": "...",
		      "slug_field": "...",
		      "listable_by": ["..."],
		      "filterable_by": ["..."],
		      "ordered": false
		    }
		  },
		  "listings": {
		    "<name>": {
		      "route": "...",
		      "queries": [...],
		      "paginated": true,
		      "searchable": false
		    }
		  }
		}

		Rules:
		- Every multi-page type should have a collection
		- Collections with multiple pages should have "paginated": true in their listing
		- Collection pages get dynamic routes with [slug]

		Output ONLY the JSON.`;
			},
			validate: async (ctx, output) => {
				const jsonMatch = output.match(/\{[\s\S]*\}/);
				if (!jsonMatch) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "cm-parser",
								verdict: "reject",
								findings: "No JSON found in content model output",
								rejectionContext:
									"Output must contain a valid JSON content model.",
							},
						],
					};
				}
				try {
					const contentModel = JSON.parse(jsonMatch[0]);
					await writeJson(ctx.workdir, "content-model.json", contentModel);
					return { status: "pass" };
				} catch (err) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "cm-parser",
								verdict: "reject",
								findings: `Invalid JSON: ${String(err)}`,
								rejectionContext: "Content model must be valid JSON.",
							},
						],
					};
				}
			},
		}),

		// Step 2d-3: Agent — build component-manifest.json
		agentStep({
			id: "build-component-manifest",
			name: "Build component manifest",
			description:
				"Build component-manifest.json mapping components to collections and page types",
			buildPrompt: async (ctx) => {
				const arch = await readJson<ArchitectureClassification>(
					ctx.workdir,
					"classifier-architecture.json",
				);
				const cm = await readJson<ContentModelClassification>(
					ctx.workdir,
					"classifier-content-model.json",
				);
				const interaction = await readJson<InteractionClassification>(
					ctx.workdir,
					"classifier-interaction.json",
				);

				return `You are a component manifest builder (step 3 of 5). Build the component-manifest.json file.

		## Architecture
		${JSON.stringify(arch, null, 2)}

		## Content Model
		${JSON.stringify(cm, null, 2)}

		## Interaction Patterns
		${JSON.stringify(interaction, null, 2)}

		Build a component-manifest.json:
		{
		  "components": {
		    "<component_name>": {
		      "file": "src/components/<name>.astro",
		      "collections": ["<collection_name>", ...],
		      "page_types": ["<pagetype>", ...],
		      "description": "<what the component does>"
		    }
		  },
		  "navigation": { ... },
		  "interactive_patterns": [
		    {
		      "id": "<pattern_id>",
		      "type": "<fragment|modal|accordion|tabs|search|filter|form|popup|other>",
		      "trigger": "...",
		      "target": "...",
		      "pageType": "<pagetype>",
		      "route": "<route>",
		      "description": "<what the pattern does>"
		    }
		  ]
		}

		Rules:
		- Identify all UI components needed based on the architecture and content model
		- Each component must list which collections it references (if any)
		- Navigation should define the site main nav structure
		- Interactive patterns must reference valid page types
		- Only include components and patterns that actually exist in the site

		Output ONLY the JSON.`;
			},
			validate: async (ctx, output) => {
				const jsonMatch = output.match(/\{[\s\S]*\}/);
				if (!jsonMatch) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "comp-manifest-parser",
								verdict: "reject",
								findings: "No JSON found in component manifest output",
								rejectionContext:
									"Output must contain a valid JSON component manifest.",
							},
						],
					};
				}
				try {
					const manifest = JSON.parse(jsonMatch[0]);
					await writeJson(ctx.workdir, "component-manifest.json", manifest);
					return { status: "pass" };
				} catch (err) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "comp-manifest-parser",
								verdict: "reject",
								findings: `Invalid JSON: ${String(err)}`,
								rejectionContext: "Component manifest must be valid JSON.",
							},
						],
					};
				}
			},
		}),

		// Step 2d-4: Programmatic — assemble final registry and cross-validate all artifacts
		programmaticStep({
			id: "validate-registry",
			name: "Assemble and validate merged registry",
			description:
				"Assemble partial registries into final registry.json and cross-validate content-model.json, component-manifest.json, and registry.json",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const layouts = await readJson<Record<string, unknown>>(
						ctx.workdir,
						"registry-partial-layouts.json",
					);
					const contentModelFile = await readJson<Record<string, unknown>>(
						ctx.workdir,
						"content-model.json",
					);
					const compManifestFile = await readJson<Record<string, unknown>>(
						ctx.workdir,
						"component-manifest.json",
					);
					const reducedMeta = await readJson<{
						page_types: Array<{ pagetype: string }>;
					}>(ctx.workdir, "reduced-meta.json");

					if (!layouts || !contentModelFile || !reducedMeta) {
						return {
							status: "fail",
							error:
								"Missing partial registry files, content-model.json, or reduced-meta.json",
							duration: Date.now() - start,
						};
					}

					// Assemble final registry from layouts + content-model + component-manifest
					const navigation =
						(compManifestFile as Record<string, unknown>).navigation ?? {};
					const interactivePatterns =
						(compManifestFile as Record<string, unknown>)
							.interactive_patterns ?? [];
					const registry = {
						...(navigation !== undefined ? { navigation } : {}),
						interactive_patterns: interactivePatterns,
						layouts: layouts.layouts ?? {},
						static_pages: layouts.static_pages ?? [],
						collections: contentModelFile.collections ?? {},
						listings: contentModelFile.listings ?? {},
					};
					await writeJson(ctx.workdir, "registry.json", registry);

					// Cross-validate
					const knownPageTypes = reducedMeta.page_types.map((p) => p.pagetype);
					const allErrors: string[] = [];

					// 1. Registry completeness
					const completeness = validateRegistryCompleteness(
						registry as import("../../types.js").Registry,
						knownPageTypes,
					);
					if (completeness.missing.length > 0) {
						allErrors.push(
							`Registry missing page types: ${completeness.missing.join(", ")}`,
						);
					}

					// 2. Content-model reference validation
					const cmOutput: ContentModelOutput = {
						collections: Object.fromEntries(
							Object.entries(
								(registry.collections ?? {}) as Record<
									string,
									{
										source_pagetype: string;
										slug_field: string;
										listable_by: string[];
									}
								>,
							).map(([k, v]) => [
								k,
								{
									source_pagetype: v.source_pagetype,
									slug_field: v.slug_field,
									listable_by: v.listable_by,
								},
							]),
						),
					};
					const cmRefs = validateContentModelRefs(
						cmOutput,
						registry as import("../../types.js").Registry,
					);
					allErrors.push(...cmRefs.orphans);

					// 3. Component-manifest reference validation
					if (compManifestFile) {
						const compComponents =
							(compManifestFile as Record<string, unknown>).components ?? {};
						const compManifest: import("./classify.js").ComponentManifestOutput =
							{
								components: Object.fromEntries(
									Object.entries(
										compComponents as Record<string, Record<string, unknown>>,
									).map(([name, comp]) => [
										name,
										{
											file: (comp.file as string) ?? name,
											collections: Array.isArray(comp.collections)
												? (comp.collections as string[])
												: [],
										},
									]),
								),
							};
						const compRefs = validateComponentManifestRefs(
							compManifest,
							registry as import("../../types.js").Registry,
							cmOutput,
						);
						allErrors.push(...compRefs.orphans);
					}

					if (allErrors.length > 0) {
						await writeJson(ctx.workdir, "registry-errors.json", allErrors);
						return {
							status: "reject",
							reviews: allErrors.map((err) => ({
								reviewerId: "registry-validator",
								verdict: "reject" as const,
								findings: err,
								rejectionContext: `Registry validation: ${err}`,
							})),
							duration: Date.now() - start,
						};
					}

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Registry assembly/validation failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),

		// Step 2d-5: Conflict resolution — only runs if 2d-4 found issues
		programmaticStep({
			id: "resolve-conflicts",
			name: "Resolve registry conflicts",
			description:
				"Fix registry validation errors found during cross-validation (skipped if no errors)",
			run: async (ctx) => {
				const start = Date.now();
				const errors = await readJson<string[]>(
					ctx.workdir,
					"registry-errors.json",
				);

				// No errors — skip entirely, do not spawn agent
				if (!errors || errors.length === 0) {
					ctx.logger.startStep(
						"No registry conflicts found — skipping conflict resolution",
					);
					return { status: "pass", duration: Date.now() - start };
				}

				ctx.logger.startStep(`Resolving ${errors.length} registry conflict(s)`);

				const registry = await readJson<Record<string, unknown>>(
					ctx.workdir,
					"registry.json",
				);
				const reducedMeta = await readJson<{
					page_types: Array<{ pagetype: string }>;
				}>(ctx.workdir, "reduced-meta.json");

				const prompt = `The registry has validation errors that need to be resolved.

Current registry:
${JSON.stringify(registry, null, 2)}

Known page types: ${(reducedMeta?.page_types ?? []).map((p) => p.pagetype).join(", ")}

Errors to fix:
${errors.join("\n")}

Produce a corrected registry.json that fixes ALL listed errors. Output ONLY the JSON.`;

				const output = await agentQuery({
					prompt,
					systemPrompt:
						"You are a conflict resolution agent. Fix registry issues by producing a corrected registry.json.",
					cwd: ctx.workdir,
					profile: ctx.profile,
					stepName: "classify/resolve-conflicts",
					logger: ctx.logger,
					config: ctx.config,
				});

				const jsonMatch = output.match(/\{[\s\S]*\}/);
				if (!jsonMatch) {
					return {
						status: "fail",
						error: "No JSON found in conflict resolution output",
						duration: Date.now() - start,
					};
				}

				try {
					const resolved = JSON.parse(jsonMatch[0]);
					await writeJson(ctx.workdir, "registry.json", resolved);
					await writeJson(ctx.workdir, "registry-errors.json", []);
					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Invalid JSON from conflict resolver: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),
	],
};

// ---------------------------------------------------------------------------
// Phase 3: Transform + Seed
// ---------------------------------------------------------------------------

export const seedPhase: PhaseDef = {
	id: "seed",
	name: "Transform + Seed",
	description:
		"Copy template, generate content collections, config, routes, and data files",
	maxRetries: 2,
	steps: [
		programmaticStep({
			id: "seed-all",
			name: "Seed Astro project",
			description:
				"Copy template and seed content collections, config, routes, and data",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const registry = await readJson<import("../../types.js").Registry>(
						ctx.workdir,
						"registry.json",
					);
					const content = await readJson<{ pages: PageContent[] }>(
						ctx.workdir,
						"content.json",
					);

					if (!registry || !content) {
						return {
							status: "fail",
							error: "Missing registry.json or content.json",
							duration: Date.now() - start,
						};
					}

					// Build content model output for seed functions
					const cmOutput: ContentModelOutput = {
						collections: Object.fromEntries(
							Object.entries(registry.collections).map(([k, v]) => [
								k,
								{
									source_pagetype: v.source_pagetype,
									slug_field: v.slug_field,
									listable_by: v.listable_by,
								},
							]),
						),
					};

					// Copy Astro template
					const templateDir = new URL(
						"../../../template/astro-project",
						import.meta.url,
					).pathname;
					try {
						await cp(templateDir, join(ctx.workdir, "project"), {
							recursive: true,
						});
					} catch (err) {
						ctx.logger.startStep(
							`Template copy warning: ${String(err)} — creating minimal project structure`,
						);
						// Fallback: create minimal project structure
						const projectDir = join(ctx.workdir, "project");
						await mkdir(join(projectDir, "src"), { recursive: true });
						await mkdir(join(projectDir, "src/content"), { recursive: true });
						await mkdir(join(projectDir, "src/pages"), { recursive: true });
						await mkdir(join(projectDir, "src/data"), { recursive: true });
						await mkdir(join(projectDir, "src/layouts"), { recursive: true });
						await mkdir(join(projectDir, "src/components"), {
							recursive: true,
						});
						await mkdir(join(projectDir, "public"), { recursive: true });
					}

					const projectDir = join(ctx.workdir, "project");

					// Pure: generate collection entries
					const collectionEntries = generateCollectionEntries(
						registry,
						cmOutput,
						content.pages,
					);

					// IO: write collection entries
					for (const entry of collectionEntries) {
						const filePath = join(projectDir, entry.path);
						await mkdir(filePath.split("/").slice(0, -1).join("/"), {
							recursive: true,
						});
						await writeFile(filePath, entry.content, "utf-8");
					}

					// Pure: generate globals
					const globals = generateGlobals(cmOutput, content.pages);

					// IO: write global data files
					for (const file of globals) {
						const filePath = join(projectDir, file.path);
						await mkdir(filePath.split("/").slice(0, -1).join("/"), {
							recursive: true,
						});
						await writeFile(filePath, file.content, "utf-8");
					}

					// Pure: generate content.config.ts (Astro v6: root-level src/content.config.ts)
					// glob() for page-content collections, file() for singleton globals.
					const contentConfig = generateContentConfig(
						registry,
						cmOutput,
						globals,
					);
					await writeFile(
						join(projectDir, "src", "content.config.ts"),
						contentConfig,
						"utf-8",
					);

					// Pure: generate route files
					const routeFiles = generateRouteFiles(registry, cmOutput);

					// IO: write route files
					for (const file of routeFiles) {
						const filePath = join(projectDir, file.path);
						await mkdir(filePath.split("/").slice(0, -1).join("/"), {
							recursive: true,
						});
						await writeFile(filePath, file.content, "utf-8");
					}

					// IO: copy downloaded images to project public/images/
					const sourceImagesDir = join(ctx.workdir, "public", "images");
					const destImagesDir = join(projectDir, "public", "images");
					try {
						await cp(sourceImagesDir, destImagesDir, {
							recursive: true,
						});
					} catch {
						// No images downloaded — that's ok for sites without images
						await mkdir(destImagesDir, { recursive: true });
					}

					// IO: copy asset manifest to project for reference
					const assetManifest = await readJson<Record<string, string>>(
						ctx.workdir,
						"asset-manifest.json",
					);
					if (assetManifest) {
						await writeJson(projectDir, "asset-manifest.json", assetManifest);
					}

					// Pure: validate seed completeness
					const seedResult = validateSeedCompleteness(content.pages, [
						...collectionEntries.map((e) => ({ path: e.path })),
						...routeFiles,
					]);

					if (!seedResult.complete) {
						return {
							status: "reject",
							reviews: [
								{
									reviewerId: "seed-completeness",
									verdict: "reject" as const,
									findings: `Seed completeness: ${seedResult.missing.length} source pages not seeded: ${seedResult.missing.slice(0, 5).join(", ")}${seedResult.missing.length > 5 ? "..." : ""}`,
									rejectionContext: `Missing seeded content for: ${seedResult.missing.join(", ")}`,
								},
							],
							duration: Date.now() - start,
						};
					}

					ctx.logger.startStep(
						`Seeded ${collectionEntries.length} collection entries, ${routeFiles.length} route files, ${globals.length} global data files`,
					);

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Seed failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),
	],
};

// ---------------------------------------------------------------------------
// Phase 4: Generate Wireframe
// ---------------------------------------------------------------------------

export const generatePhase: PhaseDef = {
	id: "generate",
	name: "Generate Wireframe",
	description:
		"Agent-driven wireframe generation: components, layouts, page stubs, content fill",
	maxRetries: 3,
	steps: [
		// Step 4a: Fan-out — generate components per category
		programmaticStep({
			id: "generate-components",
			name: "Generate components (fan-out)",
			description:
				"Fan-out per-component-category agent calls for parallel component generation",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const registry = await readJson<import("../../types.js").Registry>(
						ctx.workdir,
						"registry.json",
					);
					const designTokens = await readJson<Record<string, unknown>>(
						ctx.workdir,
						"design-tokens.json",
					);

					if (!registry) {
						return {
							status: "fail",
							error: "Missing registry.json",
							duration: Date.now() - start,
						};
					}

					// Build component categories from registry
					const categories: Array<{
						name: string;
						description: string;
					}> = [
						{
							name: "navigation",
							description: "Navigation component with menu items and links",
						},
						{
							name: "header",
							description:
								"Header component with logo and optional navigation slot",
						},
						{
							name: "footer",
							description: "Footer component with links and copyright",
						},
					];

					// Add a card component for each listing that has collections
					for (const [listingName] of Object.entries(registry.listings)) {
						categories.push({
							name: `card-${listingName}`,
							description: `Card component for ${listingName} listing items`,
						});
					}

					// Add a content section component per collection
					for (const collName of Object.keys(registry.collections)) {
						categories.push({
							name: `content-${collName}`,
							description: `Content section component for ${collName} pages`,
						});
					}

					// Fan-out per-category with semaphore
					const results = await Promise.all(
						categories.map((cat) =>
							generatorSemaphore.acquire().then(async (release) => {
								try {
									await agentQuery({
										prompt: `You are an Astro.js component generator. Generate a single reusable component for the wireframe.

## Component: ${cat.name}
${cat.description}

## Registry
${JSON.stringify(registry, null, 2)}

${designTokens ? `## Design Tokens (for reference only — do NOT apply colors/styles)\n${JSON.stringify(designTokens, null, 2).slice(0, 2000)}` : ""}

## Instructions
1. Generate the component in \`project/src/components/${cat.name}.astro\`
2. Use minimal wireframe HTML structure with semantic class names
3. DO NOT apply any Tailwind utility classes
4. DO NOT apply any colors, fonts, or styles
5. Accept props for dynamic content
6. Use slots where appropriate

Remember: NO Tailwind classes, NO inline styles, NO colors. Structure only.`,
										cwd: ctx.workdir,
										profile: ctx.profile,
										stepName: `wireframe/generate/component-${cat.name}`,
										logger: ctx.logger,
										config: ctx.config,
									});
									return { name: cat.name, ok: true };
								} catch (err) {
									return {
										name: cat.name,
										ok: false,
										error: err instanceof Error ? err.message : String(err),
									};
								} finally {
									release();
								}
							}),
						),
					);

					const failures = results.filter((r) => !r.ok);
					if (failures.length > 0) {
						return {
							status: "fail",
							error: `Component generation failed for: ${failures.map((f) => f.name).join(", ")}`,
							duration: Date.now() - start,
						};
					}

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: err instanceof Error ? err.message : String(err),
						duration: Date.now() - start,
					};
				}
			},
		}),

		// Step 4b: Generate layouts
		agentStep({
			id: "generate-layouts",
			name: "Generate layouts",
			description: "Generate Astro layout files from registry",
			buildPrompt: async (ctx) => {
				const registry = await readJson<import("../../types.js").Registry>(
					ctx.workdir,
					"registry.json",
				);

				return `You are an Astro.js layout generator. Generate layout files for the wireframe.

## Registry
${JSON.stringify(registry, null, 2)}

## Instructions
1. Generate one layout file per registry layout in \`project/src/layouts/\`
2. Each layout should be a minimal wireframe structure with:
   - DOCTYPE and HTML boilerplate
   - Head with meta tags
   - Slot for page content
   - Header/Footer imports
3. DO NOT apply any Tailwind classes — use semantic class names only
4. DO NOT apply any colors, fonts, or styles
5. Layouts should accept a \`pagetype\` prop

Write each layout file using your file writing tools.`;
			},
		}),

		// Step 4c: Generate page stubs
		agentStep({
			id: "generate-page-stubs",
			name: "Generate page stubs",
			description:
				"Fill page route files with proper content queries and component composition",
			buildPrompt: async (ctx) => {
				const registry = await readJson<import("../../types.js").Registry>(
					ctx.workdir,
					"registry.json",
				);

				// Read existing route files
				const pagesDir = join(ctx.workdir, "project", "src", "pages");
				const existingFiles: string[] = [];
				try {
					const files = await readdir(pagesDir, { recursive: true });
					for (const file of files) {
						if (String(file).endsWith(".astro")) {
							existingFiles.push(String(file));
						}
					}
				} catch {
					// pages dir may not exist yet
				}

				return `You are an Astro.js page generator. Update and complete page route files.

## Registry
${JSON.stringify(registry, null, 2)}

## Existing route files
${existingFiles.join("\n") || "(none)"}

## Instructions
1. Update existing route files in \`project/src/pages/\` with proper content:
   - Import correct layout
   - Add getStaticPaths for dynamic routes
   - Query content collections where appropriate
   - Compose components
2. DO NOT apply any Tailwind classes
3. DO NOT apply any styles
4. Use semantic HTML only

Write/update each page file using your file writing tools.`;
			},
		}),

		// Step 4d: Fan-out — fill content per page type
		programmaticStep({
			id: "fill-content",
			name: "Fill content (fan-out)",
			description:
				"Fan-out per-page-type agent calls for parallel content mapping",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const registry = await readJson<import("../../types.js").Registry>(
						ctx.workdir,
						"registry.json",
					);

					if (!registry) {
						return {
							status: "fail",
							error: "Missing registry.json",
							duration: Date.now() - start,
						};
					}

					// Collect unique page types from registry
					const pageTypes = new Set<string>();
					for (const sp of registry.static_pages) {
						pageTypes.add(sp.pagetype);
					}
					for (const coll of Object.values(registry.collections)) {
						pageTypes.add(coll.source_pagetype);
					}
					for (const listing of Object.values(registry.listings)) {
						for (const q of listing.queries) {
							const pt = (q as Record<string, unknown>).pagetype;
							if (typeof pt === "string") pageTypes.add(pt);
						}
					}

					// Fan-out per-page-type with semaphore
					const results = await Promise.all(
						[...pageTypes].map((pt) =>
							generatorSemaphore.acquire().then(async (release) => {
								try {
									await agentQuery({
										prompt: `You are an Astro.js content mapper. Ensure all ${pt} page content is properly wired.

## Registry
${JSON.stringify(registry, null, 2)}

## Instructions
1. For all ${pt} pages, ensure the correct content is queried and rendered
2. Implement getStaticPaths for dynamic routes of this page type
3. Ensure navigation links between ${pt} pages and other pages work correctly
4. DO NOT apply any Tailwind classes or styles
5. Use semantic HTML only

Check and update all ${pt} files in \`project/src/pages/\` as needed.`,
										cwd: ctx.workdir,
										profile: ctx.profile,
										stepName: `wireframe/generate/fill-${pt}`,
										logger: ctx.logger,
										config: ctx.config,
									});
									return { pagetype: pt, ok: true };
								} catch (err) {
									return {
										pagetype: pt,
										ok: false,
										error: err instanceof Error ? err.message : String(err),
									};
								} finally {
									release();
								}
							}),
						),
					);

					const failures = results.filter((r) => !r.ok);
					if (failures.length > 0) {
						return {
							status: "fail",
							error: `Content fill failed for: ${failures.map((f) => f.pagetype).join(", ")}`,
							duration: Date.now() - start,
						};
					}

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: err instanceof Error ? err.message : String(err),
						duration: Date.now() - start,
					};
				}
			},
		}),

		// Step 4e: Two-pass reviewers per spec
		// Pass 1: static + console + vision + content
		// Pass 2: trace
		// All reviewers target the generated project/ subdirectory
		staticChecksReviewer({
			id: "static-checks-review",
			name: "Static checks review",
			description: "Run bun check, astro build, and lychee link checking",
			projectDir: "project",
		}),

		consoleErrorReviewer({
			id: "console-error-review",
			name: "Console error review",
			description: "Launch Playwright and capture runtime console errors",
			baseUrl: "http://localhost:4321",
			projectDir: "project",
		}),

		visionReviewer({
			id: "vision-review",
			name: "Vision review",
			description:
				"Take screenshots and send to vision AI for visual quality assessment",
			baseUrl: "http://localhost:4321",
			projectDir: "project",
		}),

		contentReviewer({
			id: "content-review",
			name: "Content completeness review",
			description:
				"Verify all source content is properly represented in generated wireframe pages",
			projectDir: "project",
		}),

		traceReviewer({
			id: "trace-review",
			name: "Trace review",
			description:
				"Read generated .astro/.ts/.css files and send to AI for quality analysis",
			projectDir: "project",
		}),
	],
};

// ---------------------------------------------------------------------------
// Phase 5: Final Validation
// ---------------------------------------------------------------------------

export const validatePhase: PhaseDef = {
	id: "validate",
	name: "Final Validation",
	description:
		"Build validation, static checks, and wireframe invariant verification",
	maxRetries: 2,
	steps: [
		programmaticStep({
			id: "final-validation",
			name: "Final validation gate",
			description:
				"Run astro build, bun check, and validate all wireframe invariants",
			run: async (ctx) => {
				const start = Date.now();
				const allErrors: string[] = [];

				try {
					const projectDir = join(ctx.workdir, "project");
					const projectExists = await exists(projectDir);

					if (!projectExists) {
						return {
							status: "fail",
							error: "Project directory not found — seed phase may have failed",
							duration: Date.now() - start,
						};
					}

					// Run validation shell commands (astro build, bun check, lychee)
					const shellErrors = await runValidationShellCommands(projectDir);
					allErrors.push(...shellErrors);

					// IO: Read generated files for validation
					const content = await readJson<{ pages: PageContent[] }>(
						ctx.workdir,
						"content.json",
					);
					const structure = await readJson<StructureData>(
						ctx.workdir,
						"structure.json",
					);
					const assetManifest = await readJson<Record<string, string>>(
						ctx.workdir,
						"asset-manifest.json",
					);

					// Collect generated routes from actual .astro files in src/pages/
					const generatedRoutes = await collectGeneratedRoutesFromDisk(
						join(projectDir, "src", "pages"),
					);

					// Read component and astro file contents
					const componentFileContents: Record<string, string> = {};
					const astroFileContents: Record<string, string> = {};
					await collectAstroFiles(
						join(projectDir, "src"),
						join(projectDir, "src"),
						componentFileContents,
						astroFileContents,
					);

					// Collect existing image files
					const existingImageFiles =
						await collectExistingImageFiles(projectDir);

					// Check pagefind — built in dist/ after astro build
					const pagefindExists = await exists(
						join(projectDir, "dist", "pagefind"),
					);

					// Pure: validate seed completeness — all source pages accounted for
					const contentFiles: Array<{ path: string }> = [];
					const contentDir = join(projectDir, "src", "content");
					try {
						await collectContentEntries(contentDir, "", contentFiles);
					} catch {
						// content dir may not exist
					}
					const allGeneratedEntries = [
						...contentFiles,
						...generatedRoutes.map((r) => ({ path: r })),
					];
					const seedResult = validateSeedCompleteness(
						content?.pages ?? [],
						allGeneratedEntries,
					);
					if (!seedResult.complete) {
						allErrors.push(
							`Seed completeness: ${seedResult.missing.length} source pages not seeded: ${seedResult.missing.slice(0, 5).join(", ")}${seedResult.missing.length > 5 ? "..." : ""}`,
						);
					}

					// Pure: validate component manifest references
					const compManifest = buildComponentManifestFromFiles(
						componentFileContents,
					);
					const registry = await readJson<import("../../types.js").Registry>(
						ctx.workdir,
						"registry.json",
					);
					if (registry) {
						const cmOutput: ContentModelOutput = {
							collections: Object.fromEntries(
								Object.entries(
									(registry.collections ?? {}) as Record<
										string,
										{
											source_pagetype: string;
											slug_field: string;
											listable_by: string[];
										}
									>,
								).map(([k, v]) => [
									k,
									{
										source_pagetype: v.source_pagetype,
										slug_field: v.slug_field,
										listable_by: v.listable_by,
									},
								]),
							),
						};
						const compRefs = validateComponentManifestRefs(
							compManifest,
							registry,
							cmOutput,
						);
						if (!compRefs.valid) {
							allErrors.push(...compRefs.orphans);
						}
					}

					// Pure: validate wireframe output
					const validationResult: ValidateWireframeResult =
						validateWireframeOutput({
							sourcePages: content?.pages ?? [],
							generatedRoutes,
							assetManifest: assetManifest ?? {},
							existingImageFiles,
							astroFileContents,
							originalSiteUrl: structure?.site_url ?? "",
							pagefindExists,
						});

					allErrors.push(...validationResult.errors);

					if (allErrors.length > 0) {
						return {
							status: "reject",
							reviews: allErrors.map((err) => ({
								reviewerId: "wireframe-validator",
								verdict: "reject" as const,
								findings: err,
								rejectionContext: `Wireframe validation: ${err}`,
							})),
							duration: Date.now() - start,
						};
					}

					ctx.logger.startStep(
						"Wireframe validation passed — all invariants satisfied",
					);

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Final validation failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),
	],
};

/** Recursively collect .astro files into component and astro maps. */
async function collectAstroFiles(
	dir: string,
	baseDir: string,
	componentFileContents: Record<string, string>,
	astroFileContents: Record<string, string>,
): Promise<void> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				await collectAstroFiles(
					fullPath,
					baseDir,
					componentFileContents,
					astroFileContents,
				);
			} else if (entry.name.endsWith(".astro")) {
				const relPath = fullPath.slice(baseDir.length);
				try {
					const content = await readFile(fullPath, "utf-8");
					if (fullPath.includes("components") || fullPath.includes("layouts")) {
						componentFileContents[relPath] = content;
					}
					astroFileContents[relPath] = content;
				} catch {
					// Skip unreadable files
				}
			}
		}
	} catch {
		// Directory may not exist
	}
}

/** Download images from asset manifest to target directory. */
async function downloadAssetImages(
	assetManifest: Record<string, string>,
	imagesDir: string,
): Promise<void> {
	for (const [originalUrl, localPath] of Object.entries(assetManifest)) {
		try {
			const destPath = join(imagesDir, localPath);
			await mkdir(destPath.split("/").slice(0, -1).join("/"), {
				recursive: true,
			});
			const response = await fetch(originalUrl);
			if (!response.ok) {
				console.warn(`Failed to download ${originalUrl}: ${response.status}`);
				continue;
			}
			const buffer = await response.arrayBuffer();
			await writeFile(destPath, Buffer.from(buffer));
		} catch (err) {
			console.warn(`Failed to download ${originalUrl}: ${String(err)}`);
		}
	}
}

/** Convert an .astro filename to a route path. */
function astroFileToRoute(name: string): string | null {
	const base = name.replace(".astro", "");
	if (base === "index") return "/";
	return `/${base}`;
}

/** Collect generated route paths by scanning actual .astro files in src/pages/. */
async function collectGeneratedRoutesFromDisk(
	pagesDir: string,
): Promise<string[]> {
	const routes: string[] = [];
	try {
		const entries = await readdir(pagesDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(pagesDir, entry.name);
			if (entry.isDirectory()) {
				const subRoutes = await collectGeneratedRoutesFromDisk(fullPath);
				for (const r of subRoutes) {
					routes.push(`/${entry.name}${r === "/" ? "" : r}`);
				}
			} else {
				const route = astroFileToRoute(entry.name);
				if (route !== null) routes.push(route);
			}
		}
	} catch {
		// Pages directory may not exist
	}
	return routes;
}

const IMAGE_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".svg",
	".webp",
	".avif",
	".ico",
]);

/** Collect existing image files from the project's public directory, relative to public/. */
async function collectExistingImageFiles(
	projectDir: string,
): Promise<string[]> {
	const imageFiles: string[] = [];
	const publicDir = join(projectDir, "public");
	await scanImagesRecursive(publicDir, publicDir, imageFiles);
	return imageFiles;
}

async function scanImagesRecursive(
	dir: string,
	publicDir: string,
	imageFiles: string[],
): Promise<void> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				await scanImagesRecursive(fullPath, publicDir, imageFiles);
			} else {
				const ext = entry.name.substring(entry.name.lastIndexOf("."));
				if (IMAGE_EXTENSIONS.has(ext)) {
					// Store path relative to public/ directory
					imageFiles.push(fullPath.slice(publicDir.length + 1));
				}
			}
		}
	} catch {
		// Directory may not exist
	}
}

/** Run Phase 5 shell commands: astro build, bun check, lychee. Returns error strings. */
async function runValidationShellCommands(
	projectDir: string,
): Promise<string[]> {
	const errors: string[] = [];

	// Run full build (astro build + pagefind)
	try {
		await execAsync("bun run build", {
			cwd: projectDir,
			timeout: 120_000,
		});
	} catch (err) {
		errors.push(
			`astro build failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Run bun run check on the generated project
	try {
		await execAsync("bun run check", {
			cwd: projectDir,
			timeout: 60_000,
		});
	} catch (err) {
		errors.push(
			`bun run check failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Run lychee on dist/ for link checking
	const distDir = join(projectDir, "dist");
	if (await exists(distDir)) {
		try {
			await execAsync("npx lychee dist/ --offline", {
				cwd: projectDir,
				timeout: 60_000,
			});
		} catch (err) {
			errors.push(
				`lychee link check failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	return errors;
}

/** Recursively collect content entries from src/content/ for seed completeness validation. */
async function collectContentEntries(
	dir: string,
	relPrefix: string,
	entries: Array<{ path: string }>,
): Promise<void> {
	try {
		const dirents = await readdir(dir, { withFileTypes: true });
		for (const entry of dirents) {
			const fullPath = join(dir, entry.name);
			const relPath = `${relPrefix}${entry.name}`;
			if (entry.isDirectory()) {
				await collectContentEntries(fullPath, `${relPath}/`, entries);
			} else if (entry.name.endsWith(".md") || entry.name.endsWith(".json")) {
				entries.push({ path: `src/content/${relPath}` });
			}
		}
	} catch {
		// Directory may not exist
	}
}

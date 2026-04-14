/**
 * IO shell: analyze segment phase definitions.
 *
 * Three-phase architecture:
 *   1. Scout — identify page types, find reference pages, select design/component pages
 *   2. Extract Design — single agent extracts unified design language from 2-3 pages
 *   3. Discover Components — fan-out across all matched pages to find unique components
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PhaseDef } from "../../engine/types.js";
import { agentQuery } from "../../lib/agent.js";
import { extractJsonArray, extractJsonObject } from "../../lib/json-extract.js";
import { Semaphore } from "../../lib/semaphore.js";
import {
	agentFanOutStep,
	agentStep,
	programmaticStep,
	reviewerStep,
} from "../../steps/step.js";
import type { CatalogWithSelection, ScoutResult } from "./catalog.js";
import {
	buildCatalog,
	extractPageTypes,
	selectDesignPages,
} from "./catalog.js";
import type { PageComponentExtraction } from "./merge.js";
import {
	buildPatternsManifest,
	deduplicateComponents,
	normalizeRawTokens,
} from "./merge.js";
import { validateComponentRecipes, validateDesignOutputs } from "./validate.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ANALYZE_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_CONCURRENT_EXTRACTIONS = 3;
const extractionSemaphore = new Semaphore(MAX_CONCURRENT_EXTRACTIONS);

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

/**
 * Unwrap component-recipes envelope.
 * Agents may wrap in `{ "$schema": "...", "components": { ...recipes } }` but
 * the ComponentRecipesSchema expects the flat record at the root.
 */
function unwrapRecipes(raw: Record<string, unknown>): Record<string, unknown> {
	const unwrapped =
		raw.components && typeof raw.components === "object"
			? (raw.components as Record<string, unknown>)
			: raw;
	delete unwrapped.$schema;
	return unwrapped;
}

// ---------------------------------------------------------------------------
// Phase 1: Scout
// ---------------------------------------------------------------------------

export const scoutPhase: PhaseDef = {
	id: "scout",
	name: "Scout",
	description:
		"Extract page types, scout reference site, and select pages for design extraction and component discovery",
	maxRetries: 5,
	steps: [
		// Step 1a: Programmatic — extract page types
		programmaticStep({
			id: "extract-page-types",
			name: "Extract page types",
			description: "Read structure.json and extract unique page types",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const structurePath = join(ctx.workdir, "structure.json");
					const raw = await readFile(structurePath, "utf-8");
					const structure = JSON.parse(
						raw,
					) as import("../../types.js").StructureData;
					const pageTypes = extractPageTypes(structure);

					await writeFile(
						join(ctx.workdir, "page-types.json"),
						JSON.stringify({ pageTypes }, null, 2),
					);

					return {
						status: "pass",
						duration: Date.now() - start,
					};
				} catch (err) {
					return {
						status: "fail",
						error: `Failed to extract page types: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),

		// Step 1b: Agent — scout reference site
		agentStep({
			id: "scout-reference",
			name: "Scout reference site",
			description: "Identify reference pages matching each source page type",
			buildPrompt: async (ctx) => {
				const pageTypesPath = join(ctx.workdir, "page-types.json");
				const pageTypesRaw = await readFile(pageTypesPath, "utf-8");
				const { pageTypes } = JSON.parse(pageTypesRaw) as {
					pageTypes: string[];
				};
				const referenceUrl = ctx.config.reference ?? "unknown";

				return `You are a design scout. Given the following page types from the source website and a reference URL, identify the best matching pages on the reference site for each type.

Source page types: ${pageTypes.join(", ")}
Reference URL: ${referenceUrl}

For each page type, output a JSON array of mappings:
[
  { "sourceType": "<pagetype>", "referenceUrl": "<matched reference page URL>", "confidence": <0.0-1.0> }
]

Rules:
- confidence >= 0.7: strong match (same visual pattern)
- confidence 0.4-0.7: plausible match but may need adaptation
- confidence < 0.4: weak/no match — skip this type
- Only include types that have some reference equivalent
- Output ONLY the JSON array, no other text`;
			},
			validate: async (ctx, output) => {
				try {
					const mappings = extractJsonArray(output);
					if (!mappings) {
						return {
							status: "reject",
							reviews: [
								{
									reviewerId: "scout-parser",
									verdict: "reject",
									findings: "No JSON array found in scout output",
									rejectionContext: `Output must contain a JSON array of mappings. Received text starts with: ${output.slice(0, 200)}`,
								},
							],
						};
					}

					const parsedMappings = mappings as unknown as ScoutResult["mappings"];

					for (const m of parsedMappings) {
						if (
							!m.sourceType ||
							!m.referenceUrl ||
							typeof m.confidence !== "number"
						) {
							return {
								status: "reject",
								reviews: [
									{
										reviewerId: "scout-parser",
										verdict: "reject",
										findings:
											"Invalid mapping: missing sourceType, referenceUrl, or confidence",
										rejectionContext:
											"Each mapping must have sourceType, referenceUrl, and confidence.",
									},
								],
							};
						}
						if (m.confidence < 0 || m.confidence > 1) {
							return {
								status: "reject",
								reviews: [
									{
										reviewerId: "scout-parser",
										verdict: "reject",
										findings: `Confidence out of range: ${m.confidence}`,
										rejectionContext: "Confidence must be between 0 and 1.",
									},
								],
							};
						}
					}

					// Persist parsed mappings for the build-catalog step
					await writeFile(
						join(ctx.workdir, "scout-mappings.json"),
						JSON.stringify({ mappings: parsedMappings }, null, 2),
					);

					return { status: "pass" };
				} catch (err) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "scout-parser",
								verdict: "reject",
								findings: `Failed to parse scout output: ${String(err)}`,
								rejectionContext: `Output must be a valid JSON array. Received text starts with: ${output.slice(0, 200)}`,
							},
						],
					};
				}
			},
		}),

		// Step 1c: Programmatic — build catalog + select design/component pages
		programmaticStep({
			id: "build-catalog",
			name: "Build extraction catalog",
			description:
				"Build catalog from page types and scout results, select pages for design extraction and component discovery",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const pageTypesRaw = await readFile(
						join(ctx.workdir, "page-types.json"),
						"utf-8",
					);
					const { pageTypes } = JSON.parse(pageTypesRaw) as {
						pageTypes: string[];
					};

					// Read scout mappings persisted by step 1b
					const scoutData = await readJson<{
						mappings: ScoutResult["mappings"];
					}>(ctx.workdir, "scout-mappings.json");
					const scoutResult: ScoutResult = {
						mappings: scoutData?.mappings ?? [],
					};

					const catalog = buildCatalog(pageTypes, scoutResult);
					const catalogWithSelection = selectDesignPages(catalog);

					await writeFile(
						join(ctx.workdir, "catalog.json"),
						JSON.stringify(catalogWithSelection, null, 2),
					);

					return {
						status: "pass",
						duration: Date.now() - start,
					};
				} catch (err) {
					return {
						status: "fail",
						error: `Failed to build catalog: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),
	],
};

// ---------------------------------------------------------------------------
// Phase 2: Extract Design
// ---------------------------------------------------------------------------

export const extractDesignPhase: PhaseDef = {
	id: "extract-design",
	name: "Extract Design",
	description:
		"Extract unified design language from representative pages into style-fingerprint.json and design-tokens.json",
	maxRetries: 5,
	steps: [
		// Step 2a: Agent — extract complete design system
		agentStep({
			id: "extract-design-system",
			name: "Extract design system",
			description:
				"Single agent extracts unified design language from 2-3 representative reference pages",
			buildPrompt: async (ctx) => {
				const catalog = await readJson<CatalogWithSelection>(
					ctx.workdir,
					"catalog.json",
				);
				if (!catalog) {
					throw new Error(
						"catalog.json not found — scout phase must run first",
					);
				}
				const referenceUrl = ctx.config.reference ?? "unknown";
				const designPages = catalog.designPages ?? [];

				if (designPages.length === 0) {
					return "No design pages selected. Write empty JSON objects to _raw-fingerprint.json and _raw-tokens.json.";
				}

				const pageList = designPages
					.map((p) => `- ${p.sourceType}: ${referenceUrl}${p.referenceUrl}`)
					.join("\n");

				const cliPath = join(ANALYZE_DIR, "validate-tokens-cli.ts");

				return `You are a design system analyst. Visit the following reference pages and extract the UNIFIED design language into two JSON files.

## Reference Pages
${pageList}

Extract the GLOBAL design system — not per-page specifics. These pages are representative samples of the same site.

## Output

Write TWO JSON files to your working directory using the Write tool:

### 1. _raw-fingerprint.json (Style Fingerprint)
\`\`\`json
{
  "$schema": "https://mecury.dev/fingerprint.json",
  "style": {
    "primary": "<primary style description, e.g. 'minimal modern'>",
    "secondary": ["<style tags>"],
    "dimensions": {
      "ornament": <0-1>, "playfulness": <0-1>, "warmth": <0-1>,
      "density": <0-1>, "motion": <0-1>, "depth": <0-1>,
      "darkness": <0-1>, "formality": <0-1>
    },
    "treatments": {
      "surface": "<flat|gradient|textured>",
      "corners": "<sharp|rounded|pill>",
      "shadows": "<none|subtle|medium|heavy>",
      "borders": "<none|thin|thick>",
      "gradients": "<none|linear|radial|mesh>",
      "blur": <boolean>,
      "transparency": <boolean>,
      "animation_style": "<none|fade|slide|scale|bounce>"
    }
  },
  "confidence": <0-1>
}
\`\`\`

### 2. _raw-tokens.json (Design Tokens) — 7-layer structure
\`\`\`json
{
  "atomic": {
    "colors": { "<role>": "<oklch(L C H)>" },
    "typography": {
      "fontFamily": { "<name>": "<family>" },
      "fontSize": { "<name>": "<N>px" },
      "fontWeight": { "<name>": <number> }
    },
    "spacing": { "<name>": "<N>px" },
    "borderRadius": { "<name>": "<N>px" },
    "shadows": { "<name>": "<CSS shadow>" }
  },
  "gradients": {
    "<name>": {
      "type": "<linear|radial|conic>",
      "angle": "<Ndeg>",
      "stops": [{ "color": "<oklch(L C H)>", "position": "<N%>" }]
    }
  },
  "layout": {
    "grid": {
      "columns": { "<breakpoint>": "<N>" },
      "gutter": { "<breakpoint>": "<Npx>" }
    },
    "container": { "maxWidth": { "<breakpoint>": "<Npx>" } },
    "breakpoints": { "<name>": "<Npx>" },
    "sections": {
      "<name>": { "top": "<Npx>", "bottom": "<Npx>" }
    },
    "density": { "mode": "<comfortable|compact|spacious>" },
    "rhythm": { "baseUnit": "<Npx>", "verticalRhythm": { "<name>": "<Npx>" } }
  },
  "componentSpacing": {
    "<component>": { "<property>": "<Npx>" }
  },
  "motion": {
    "duration": { "<name>": "<Nms>" },
    "easing": { "<name>": "<cubic-bezier(...)>" },
    "state": { "hover": {}, "focus": {}, "active": {}, "disabled": {} },
    "scroll": {},
    "skeleton": {}
  },
  "surfaces": {
    "glass": { "<variant>": { "<property>": "<value>" } },
    "texture": { "<variant>": { "<property>": "<value>" } },
    "imageTreatment": { "<variant>": { "<property>": "<value>" } }
  },
  "visualIdentity": {
    "colorDistribution": { "dominant": {}, "secondary": {}, "accent": {} },
    "borders": { "<variant>": { "<property>": "<value>" } }
  }
}
\`\`\`

**Type requirements for design tokens (read carefully):**
- \`layout.grid.columns\`: values MUST be strings like \`"12"\`, NOT numbers like \`12\`
- \`layout.sections\`: each entry MUST be \`{ "top": "<Npx>", "bottom": "<Npx>" }\`, NOT a flat string
- \`componentSpacing\`: MUST be nested \`{ "<component>": { "<prop>": "<val>" } }\`, NOT flat
- \`surfaces.glass/texture/imageTreatment\`: MUST be nested \`{ "<variant>": { "<prop>": "<val>" } }\`
- \`visualIdentity.borders\`: MUST be nested \`{ "<variant>": { "<prop>": "<val>" } }\`
- \`gradients\`: MUST be structured objects with \`type\`, \`stops\` — NOT raw CSS gradient strings

## CRITICAL REQUIREMENTS
- ALL colors MUST be in OKLCH format: \`oklch(L C H)\`. No hex, no rgb, no hsl.
- Spacing MUST have at least 4 steps (e.g., xs/sm/md/lg/xl)
- Typography MUST have at least 3 font sizes
- Include foreground, background, primary, secondary, accent, muted, and border colors at minimum

## Self-Validation (MANDATORY)

After writing both files, run this command to validate:
\`\`\`bash
bun run ${cliPath} ${ctx.workdir}
\`\`\`

- If it prints \`PASS\`, you are done.
- If it prints errors, each line shows the exact JSON path that failed (e.g. \`tokens.layout.grid.columns.mobile: expected string, received number\`). Fix the specific fields in \`_raw-tokens.json\` or \`_raw-fingerprint.json\`, then re-run the validator.
- Repeat until the validator prints \`PASS\`. Do NOT finish without a passing validation.`;
			},
			validate: async (ctx) => {
				// The agent writes files directly and self-validates via the CLI.
				// This callback is a safety net — just check files exist and are valid JSON.
				const errors: string[] = [];

				for (const filename of ["_raw-fingerprint.json", "_raw-tokens.json"]) {
					try {
						const raw = await readFile(join(ctx.workdir, filename), "utf-8");
						JSON.parse(raw);
					} catch {
						errors.push(`${filename} missing or invalid JSON`);
					}
				}

				if (errors.length > 0) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "design-file-check",
								verdict: "reject",
								findings: errors.join("\n"),
								rejectionContext: errors.join("; "),
							},
						],
					};
				}

				return { status: "pass" };
			},
		}),

		// Step 2b: Programmatic — normalize design output
		programmaticStep({
			id: "normalize-design",
			name: "Normalize design output",
			description:
				"Apply spacing clustering, color flattening, gradient normalization, and write canonical JSON files",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const rawFingerprint = await readJson<Record<string, unknown>>(
						ctx.workdir,
						"_raw-fingerprint.json",
					);
					const rawTokens = await readJson<Record<string, unknown>>(
						ctx.workdir,
						"_raw-tokens.json",
					);

					if (!rawFingerprint || !rawTokens) {
						return {
							status: "fail",
							error: "Missing raw design output files",
							duration: Date.now() - start,
						};
					}

					const normalized = normalizeRawTokens(rawTokens);

					// Write canonical files
					await writeFile(
						join(ctx.workdir, "style-fingerprint.json"),
						JSON.stringify(rawFingerprint, null, 2),
					);
					await writeFile(
						join(ctx.workdir, "design-tokens.json"),
						JSON.stringify(normalized, null, 2),
					);

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Normalization failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),

		// Step 2c: Programmatic — validate design outputs
		programmaticStep({
			id: "validate-design",
			name: "Validate design outputs",
			description:
				"Run Zod + domain validation on style-fingerprint.json and design-tokens.json",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const fingerprint = await readJson(
						ctx.workdir,
						"style-fingerprint.json",
					);
					const tokens = await readJson(ctx.workdir, "design-tokens.json");

					const validation = validateDesignOutputs(fingerprint, tokens);
					if (!validation.valid) {
						return {
							status: "reject",
							reviews: validation.errors.map((err) => ({
								reviewerId: "design-schema-validator",
								verdict: "reject" as const,
								findings: err,
								rejectionContext: `Schema validation error: ${err}`,
							})),
							duration: Date.now() - start,
						};
					}

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

		// Step 2d: Vision AI review
		reviewerStep({
			id: "vision-review",
			name: "Vision review",
			description: "Vision AI review of extracted design artifacts",
			buildPrompt: async (ctx) => {
				const fingerprintRaw = await readFile(
					join(ctx.workdir, "style-fingerprint.json"),
					"utf-8",
				);
				const tokensRaw = await readFile(
					join(ctx.workdir, "design-tokens.json"),
					"utf-8",
				);

				const referenceUrl = ctx.config.reference ?? "unknown";

				return `You are a design system reviewer. Review these extracted design artifacts for quality and completeness.

Reference site: ${referenceUrl}

## Style Fingerprint
${fingerprintRaw}

## Design Tokens
${tokensRaw}

Check:
1. Color palette completeness (foreground, background, primary, secondary, accent, muted, border)
2. Typography scale coherence (at least 4 sizes with reasonable progression)
3. Spacing scale consistency (at least 4 steps, follows 4/8px grid)
4. Style dimension scores are reasonable (not all 0.5, appropriate for the reference site)
5. All OKLCH colors are valid format
6. Design tokens cover all 7 required layers

Respond with:
VERDICT: PASS — if all checks pass
VERDICT: REJECT — if any issues found

If rejecting, list specific issues and provide REJECTION CONTEXT with actionable fixes.`;
			},
		}),
	],
};

// ---------------------------------------------------------------------------
// Phase 3: Discover Components
// ---------------------------------------------------------------------------

export const discoverComponentsPhase: PhaseDef = {
	id: "discover-components",
	name: "Discover Components",
	description:
		"Fan-out across all matched pages to discover unique UI component patterns",
	maxRetries: 5,
	steps: [
		// Step 3a: Agent fan-out — extract components per page
		agentFanOutStep({
			id: "fan-out-components",
			name: "Fan-out component extraction",
			description:
				"Extract UI component patterns from each matched reference page in parallel",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const catalog = await readJson<CatalogWithSelection>(
						ctx.workdir,
						"catalog.json",
					);
					if (!catalog) {
						return {
							status: "fail",
							error: "catalog.json not found — scout phase must run first",
							duration: Date.now() - start,
						};
					}
					const referenceUrl = ctx.config.reference ?? "";
					const componentPages = catalog.componentPages ?? [];

					if (componentPages.length === 0) {
						ctx.logger.startStep(
							"No matched pages for component extraction — skipping",
						);
						// Write empty recipes so downstream steps don't fail
						await writeFile(
							join(ctx.workdir, "component-recipes.json"),
							JSON.stringify({}, null, 2),
						);
						return { status: "pass", duration: Date.now() - start };
					}

					// Read design tokens for context
					const tokensRaw = await readFile(
						join(ctx.workdir, "design-tokens.json"),
						"utf-8",
					).catch(() => "{}");

					const componentsDir = join(ctx.workdir, "components");
					await mkdir(componentsDir, { recursive: true });

					// Fan-out with semaphore
					const tasks = componentPages.map(async (page) => {
						const release = await extractionSemaphore.acquire();
						try {
							const prompt = `You are a UI component analyst. Extract all unique component patterns from this reference page.

Reference URL: ${referenceUrl}${page.referenceUrl}
Page type: ${page.sourceType}

The site's design tokens are:
${tokensRaw}

Identify all distinct UI components on this page: buttons, cards, navigation bars, forms, heroes, footers, modals, badges, accordions, tabs, etc.

For each component, output a JSON object:
{
  "<ComponentName>": {
    "base": { <default properties: padding, borderRadius, fontSize, colors, etc.> },
    "variants": { <named variants if visible, e.g. "primary", "outline", "ghost"> }
  }
}

Rules:
- Use semantic component names (Button, Card, Hero, Navigation, Footer, etc.)
- Reference design token values where applicable
- Include all visible components, even if they appear only once
- Output ONLY the JSON object, no other text`;

							const output = await agentQuery({
								prompt,
								cwd: ctx.workdir,
								profile: ctx.profile,
								stepName: `analyze/discover-components/${page.sourceType}`,
								logger: ctx.logger,
								config: ctx.config,
							});

							const data = extractJsonObject(output) ?? {};

							await writeFile(
								join(componentsDir, `${page.sourceType}.json`),
								JSON.stringify(data, null, 2),
							);

							return {
								sourceType: page.sourceType,
								success: true,
							};
						} catch (err) {
							ctx.logger.failStep(
								`Component extraction failed for ${page.sourceType}: ${String(err)}`,
							);
							return {
								sourceType: page.sourceType,
								success: false,
								error: String(err),
							};
						} finally {
							release();
						}
					});

					const results = await Promise.all(tasks);
					const failures = results.filter((r) => !r.success);

					if (failures.length > 0) {
						return {
							status: "fail",
							error: `Component extraction failed for:\n${failures.map((f) => `  - ${f.sourceType}: ${f.error ?? "unknown"}`).join("\n")}`,
							duration: Date.now() - start,
						};
					}

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Component extraction failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),

		// Step 3b: Programmatic — merge and deduplicate components
		programmaticStep({
			id: "merge-components",
			name: "Merge components",
			description:
				"Deduplicate component patterns across pages into component-recipes.json",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const catalog = await readJson<CatalogWithSelection>(
						ctx.workdir,
						"catalog.json",
					);
					const componentPages = catalog?.componentPages ?? [];

					const extractions: PageComponentExtraction[] = [];
					for (const page of componentPages) {
						const data = await readJson<Record<string, unknown>>(
							ctx.workdir,
							join("components", `${page.sourceType}.json`),
						);
						if (data) {
							const unwrapped = unwrapRecipes(data);
							extractions.push({
								pageType: page.sourceType,
								components: unwrapped,
							});
						}
					}

					const recipes = deduplicateComponents(extractions);

					await writeFile(
						join(ctx.workdir, "component-recipes.json"),
						JSON.stringify(recipes, null, 2),
					);

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Component merge failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),

		// Step 3c: Programmatic — validate component recipes
		programmaticStep({
			id: "validate-components",
			name: "Validate component recipes",
			description: "Run Zod validation on component-recipes.json",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const recipes = await readJson(ctx.workdir, "component-recipes.json");

					const validation = validateComponentRecipes(recipes);
					if (!validation.valid) {
						return {
							status: "reject",
							reviews: validation.errors.map((err) => ({
								reviewerId: "component-schema-validator",
								verdict: "reject" as const,
								findings: err,
								rejectionContext: `Schema validation error: ${err}`,
							})),
							duration: Date.now() - start,
						};
					}

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

		// Step 3d: Programmatic — build patterns manifest
		programmaticStep({
			id: "build-patterns",
			name: "Build patterns manifest",
			description: "Organize component extraction data into patterns directory",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const patternsDir = join(ctx.workdir, "patterns");
					await mkdir(patternsDir, { recursive: true });

					const catalog = await readJson<CatalogWithSelection>(
						ctx.workdir,
						"catalog.json",
					);
					if (!catalog) {
						return {
							status: "fail",
							error: "catalog.json not found",
							duration: Date.now() - start,
						};
					}

					// Gather component extraction data for buildPatternsManifest
					const extractions: Array<{
						pageId: string;
						pageType: string;
						visualMd: string;
						screenshotPaths: string[];
					}> = [];

					for (const page of catalog.componentPages ?? []) {
						let visualMd = "";
						try {
							visualMd = await readFile(
								join(ctx.workdir, "components", `${page.sourceType}.json`),
								"utf-8",
							);
						} catch {
							// No extraction data for this type
						}
						extractions.push({
							pageId: page.sourceType,
							pageType: page.sourceType,
							visualMd,
							screenshotPaths: [],
						});
					}

					const manifest = buildPatternsManifest(extractions);

					// Write manifest and per-type pattern files
					for (const [pageType, entries] of Object.entries(manifest)) {
						const typeDir = join(patternsDir, pageType);
						await mkdir(typeDir, { recursive: true });
						for (const entry of entries) {
							if (entry.visualMd) {
								await writeFile(join(typeDir, "visual.md"), entry.visualMd);
							}
						}
					}

					// Write manifest index
					await writeFile(
						join(patternsDir, "manifest.json"),
						JSON.stringify(manifest, null, 2),
					);

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Failed to build patterns: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),
	],
};

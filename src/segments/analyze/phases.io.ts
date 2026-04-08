/**
 * IO shell: analyze segment phase definitions.
 *
 * Thin wiring that reads files, calls agents, calls pure functions, writes results.
 * Each phase is a PhaseDef consumed by the engine.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PhaseDef } from "../../engine/types.js";
import { agentQuery } from "../../lib/agent.js";
import { Semaphore } from "../../lib/semaphore.js";
import { agentStep, programmaticStep, reviewerStep } from "../../steps/step.js";
import type { Catalog, ScoutResult } from "./catalog.js";
import { buildCatalog, extractPageTypes } from "./catalog.js";
import type { MeasurementData } from "./merge.js";
import {
	assembleDesignTokens,
	buildPatternsManifest,
	buildTypographyScale,
	clusterSpacing,
	deduplicateColors,
} from "./merge.js";
import { validateAnalyzeOutputs } from "./validate.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_EXTRACTIONS = 3;
const extractionSemaphore = new Semaphore(MAX_CONCURRENT_EXTRACTIONS);

const OUTPUT_FILENAMES = [
	"style-fingerprint.json",
	"design-tokens.json",
	"component-recipes.json",
] as const;

const BLOCK_NAMES = ["fingerprint", "tokens", "recipes"] as const;

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

/** Convert extraction JSON data into MeasurementData for pure merge functions. */
function toMeasurementData(
	sourceType: string,
	extraction: Record<string, unknown>,
): MeasurementData {
	return {
		pageId: sourceType,
		pageType: sourceType,
		spacing: (extraction.spacing as MeasurementData["spacing"]) ?? [],
		colors: (extraction.colors as MeasurementData["colors"]) ?? [],
		typography: (extraction.typography as MeasurementData["typography"]) ?? [],
		components: (extraction.components as MeasurementData["components"]) ?? [],
		fingerprint:
			typeof extraction.fingerprint === "object" &&
			extraction.fingerprint !== null
				? {
						dimensions: ((extraction.fingerprint as Record<string, unknown>)
							.dimensions ?? {}) as Record<string, number>,
						weight:
							((extraction.fingerprint as Record<string, unknown>)
								.weight as number) ?? 1,
					}
				: undefined,
	};
}

/** Deep merge target with source, preferring source values for conflicts. */
function deepMerge(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...target };
	for (const [key, value] of Object.entries(source)) {
		const existing = result[key];
		if (
			typeof existing === "object" &&
			existing !== null &&
			!Array.isArray(existing) &&
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value)
		) {
			result[key] = deepMerge(
				existing as Record<string, unknown>,
				value as Record<string, unknown>,
			);
		} else if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}

/** Parse the 3 JSON blocks from agent separator-delimited output. */
function parseSynthesizedBlocks(parts: string[]): {
	parsed: Record<string, unknown>[];
	errors: string[];
} {
	const errors: string[] = [];
	const parsed: Record<string, unknown>[] = [];

	for (let i = 0; i < 3; i++) {
		const jsonMatch = parts[i]?.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			errors.push(`Block ${i + 1} (${BLOCK_NAMES[i]}): no JSON found`);
			continue;
		}
		try {
			parsed[i] = JSON.parse(jsonMatch[0]);
		} catch (err) {
			errors.push(`Block ${i + 1} (${BLOCK_NAMES[i]}): ${String(err)}`);
		}
	}

	return { parsed, errors };
}

/** Load extractions from workdir and convert to MeasurementData[]. */
async function loadMeasurements(workdir: string): Promise<MeasurementData[]> {
	const catalogData = await readJson<Catalog>(workdir, "catalog.json");
	if (!catalogData) return [];

	const measurements: MeasurementData[] = [];
	for (const entry of catalogData.matched) {
		const extraction = await readJson<Record<string, unknown>>(
			workdir,
			join("extraction", entry.sourceType, "extraction.json"),
		);
		if (extraction) {
			measurements.push(toMeasurementData(entry.sourceType, extraction));
		}
	}
	return measurements;
}

/** Reconcile agent output with pure merge functions, writing output files. */
async function reconcileAndWrite(
	workdir: string,
	parsed: Record<string, unknown>[],
): Promise<void> {
	const measurements = await loadMeasurements(workdir);

	const colors = deduplicateColors(measurements);
	const spacing = clusterSpacing(measurements);
	const typography = buildTypographyScale(measurements);
	const reconciledTokens = assembleDesignTokens({
		colors,
		spacing,
		typography,
	});

	// Merge agent-synthesized tokens over reconciled defaults
	const agentTokens = parsed[1] as Record<string, unknown> | undefined;
	if (agentTokens) {
		parsed[1] = deepMerge(
			reconciledTokens as unknown as Record<string, unknown>,
			agentTokens,
		);
	} else {
		parsed[1] = reconciledTokens as unknown as Record<string, unknown>;
	}

	for (let i = 0; i < 3; i++) {
		if (!parsed[i]) continue;
		await writeFile(
			join(workdir, OUTPUT_FILENAMES[i]),
			JSON.stringify(parsed[i], null, 2),
		);
	}
}

// ---------------------------------------------------------------------------
// Phase 1: Identify + Scout
// ---------------------------------------------------------------------------

export const identifyPhase: PhaseDef = {
	id: "identify",
	name: "Identify + Scout",
	description:
		"Extract page types from structure data and scout reference site for matching pages",
	maxRetries: 1,
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

		// Step 1b: Agent — scout reference site and build catalog
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
					const jsonMatch = output.match(/\[[\s\S]*\]/);
					if (!jsonMatch) {
						return {
							status: "reject",
							reviews: [
								{
									reviewerId: "scout-parser",
									verdict: "reject",
									findings: "No JSON array found in scout output",
									rejectionContext:
										"Output must contain a JSON array of mappings.",
								},
							],
						};
					}

					const mappings = JSON.parse(jsonMatch[0]) as ScoutResult["mappings"];

					for (const m of mappings) {
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
						JSON.stringify({ mappings }, null, 2),
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
								rejectionContext: "Output must be a valid JSON array.",
							},
						],
					};
				}
			},
		}),

		// Step 1c: Programmatic — build catalog from scout results
		programmaticStep({
			id: "build-catalog",
			name: "Build extraction catalog",
			description: "Build catalog from page types and scout results",
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
					await writeFile(
						join(ctx.workdir, "catalog.json"),
						JSON.stringify(catalog, null, 2),
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
// Phase 2: Extract (fan-out)
// ---------------------------------------------------------------------------

export const extractPhase: PhaseDef = {
	id: "extract",
	name: "Extract",
	description: "Fan-out extraction of visual design data from reference pages",
	maxRetries: 1,
	steps: [
		programmaticStep({
			id: "fan-out-extract",
			name: "Fan-out extraction",
			description:
				"Extract visual and measurement data from reference pages in parallel",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const catalogRaw = await readFile(
						join(ctx.workdir, "catalog.json"),
						"utf-8",
					);
					const catalog = JSON.parse(catalogRaw) as Catalog;
					const referenceUrl = ctx.config.reference ?? "";

					const entries = catalog.matched;
					if (entries.length === 0) {
						ctx.logger.startStep("No matched pages to extract — skipping");
						return { status: "pass", duration: Date.now() - start };
					}

					// Fan-out with semaphore
					const tasks = entries.map(async (entry) => {
						const release = await extractionSemaphore.acquire();
						try {
							const dir = join(ctx.workdir, "extraction", entry.sourceType);
							await mkdir(dir, { recursive: true });

							const prompt = `Extract visual design data from this reference page.

Reference URL: ${referenceUrl}${entry.referenceUrl}
Page type: ${entry.sourceType}

Analyze and output:
1. **Spacing measurements**: CSS spacing values (padding, margin, gap) in px
2. **Color palette**: All colors used (as OKLCH values)
3. **Typography**: Font families, sizes, weights
4. **Component patterns**: UI component structures with their properties
5. **Style dimensions**: Score each dimension (ornament, playfulness, warmth, density, motion, depth, darkness, formality) 0-1

Output as a JSON object with keys: spacing, colors, typography, components, fingerprint`;

							const output = await agentQuery({
								prompt,
								cwd: ctx.workdir,
								profile: ctx.profile,
								stepName: `analyze/extract/${entry.sourceType}`,
								logger: ctx.logger,
								config: ctx.config,
							});

							const jsonMatch = output.match(/\{[\s\S]*\}/);
							const data = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

							await writeFile(
								join(dir, "extraction.json"),
								JSON.stringify(data, null, 2),
							);

							return { sourceType: entry.sourceType, success: true };
						} catch (err) {
							ctx.logger.failStep(
								`Extraction failed for ${entry.sourceType}: ${String(err)}`,
							);
							return {
								sourceType: entry.sourceType,
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
							error: `${failures.length}/${entries.length} extractions failed`,
							duration: Date.now() - start,
						};
					}

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Extraction failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),
	],
};

// ---------------------------------------------------------------------------
// Phase 3: Merge
// ---------------------------------------------------------------------------

export const mergePhase: PhaseDef = {
	id: "merge",
	name: "Merge",
	description: "Reconcile extraction data into canonical design artifacts",
	maxRetries: 2,
	steps: [
		// Step 3a: Agent — synthesize extractions into design tokens
		agentStep({
			id: "synthesize-tokens",
			name: "Synthesize design tokens",
			description:
				"Agent merges extraction data into style-fingerprint.json, design-tokens.json, and component-recipes.json",
			buildPrompt: async (ctx) => {
				const catalogRaw = await readFile(
					join(ctx.workdir, "catalog.json"),
					"utf-8",
				);
				const catalog = JSON.parse(catalogRaw) as Catalog;

				const extractionParts: string[] = [];
				for (const entry of catalog.matched) {
					try {
						const data = await readFile(
							join(
								ctx.workdir,
								"extraction",
								entry.sourceType,
								"extraction.json",
							),
							"utf-8",
						);
						extractionParts.push(`## ${entry.sourceType}\n${data}`);
					} catch {
						extractionParts.push(
							`## ${entry.sourceType}\n(No extraction data)`,
						);
					}
				}

				return `You are a design system analyst. Synthesize the following extraction data into three canonical JSON artifacts.

${extractionParts.join("\n\n")}

Output THREE JSON objects separated by \`---SEPARATOR---\`:

1. **Style Fingerprint** (style-fingerprint.json):
{
  "$schema": "https://mecury.dev/fingerprint.json",
  "style": {
    "primary": "<primary style description>",
    "secondary": ["<style tags>"],
    "dimensions": {
      "ornament": <0-1>, "playfulness": <0-1>, "warmth": <0-1>,
      "density": <0-1>, "motion": <0-1>, "depth": <0-1>,
      "darkness": <0-1>, "formality": <0-1>
    },
    "treatments": {
      "surface": "<flat|gradient|textured>", "corners": "<sharp|rounded|pill>",
      "shadows": "<none|subtle|medium|heavy>", "borders": "<none|thin|thick>",
      "gradients": "<none|linear|radial|mesh>", "blur": <bool>, "transparency": <bool>,
      "animation_style": "<none|fade|slide|scale|bounce>"
    }
  },
  "confidence": <0-1>
}

2. **Design Tokens** (design-tokens.json) — 7-layer structure:
- atomic.colors (all OKLCH), atomic.typography, atomic.spacing (≥4 steps), atomic.borderRadius, atomic.shadows
- gradients, layout, componentSpacing, motion, surfaces, visualIdentity

3. **Component Recipes** (component-recipes.json):
Each component must have "base" and "variants" keys.

Output each JSON between \`---SEPARATOR---\` markers. Use ONLY OKLCH colors.`;
			},
			validate: async (ctx, output) => {
				const parts = output.split("---SEPARATOR---");
				if (parts.length < 3) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "merge-parser",
								verdict: "reject",
								findings: "Expected 3 JSON blocks separated by ---SEPARATOR---",
								rejectionContext:
									"Output must contain exactly 3 JSON objects separated by ---SEPARATOR--- markers.",
							},
						],
					};
				}

				const { parsed, errors } = parseSynthesizedBlocks(parts);
				if (errors.length > 0) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "merge-parser",
								verdict: "reject",
								findings: errors.join("\n"),
								rejectionContext: `Parse errors: ${errors.join("; ")}`,
							},
						],
					};
				}

				await reconcileAndWrite(ctx.workdir, parsed);

				return { status: "pass" };
			},
		}),

		// Step 3b: Programmatic — build patterns manifest
		programmaticStep({
			id: "build-patterns",
			name: "Build patterns manifest",
			description: "Organize extraction data into patterns directory",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const patternsDir = join(ctx.workdir, "patterns");
					await mkdir(patternsDir, { recursive: true });

					const catalogData = await readJson<Catalog>(
						ctx.workdir,
						"catalog.json",
					);
					if (!catalogData) {
						return {
							status: "fail",
							error: "catalog.json not found",
							duration: Date.now() - start,
						};
					}

					// Gather extraction data for buildPatternsManifest
					const extractions: Array<{
						pageId: string;
						pageType: string;
						visualMd: string;
						screenshotPaths: string[];
					}> = [];

					for (const entry of catalogData.matched) {
						const typeDir = join(ctx.workdir, "extraction", entry.sourceType);
						let visualMd = "";
						try {
							visualMd = await readFile(
								join(typeDir, "extraction.json"),
								"utf-8",
							);
						} catch {
							// No extraction data for this type
						}
						extractions.push({
							pageId: entry.sourceType,
							pageType: entry.sourceType,
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

// ---------------------------------------------------------------------------
// Phase 4: Validate
// ---------------------------------------------------------------------------

export const validatePhase: PhaseDef = {
	id: "validate",
	name: "Validate",
	description: "Validate analyze outputs with Zod schemas and domain rules",
	maxRetries: 2,
	steps: [
		// Step 4a: Programmatic — Zod + domain validation
		programmaticStep({
			id: "validate-outputs",
			name: "Validate outputs",
			description:
				"Run Zod schema and domain-specific validation on all 3 output JSONs",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const fingerprintRaw = await readFile(
						join(ctx.workdir, "style-fingerprint.json"),
						"utf-8",
					);
					const tokensRaw = await readFile(
						join(ctx.workdir, "design-tokens.json"),
						"utf-8",
					);
					const recipesRaw = await readFile(
						join(ctx.workdir, "component-recipes.json"),
						"utf-8",
					);

					const result = validateAnalyzeOutputs({
						fingerprint: JSON.parse(fingerprintRaw),
						tokens: JSON.parse(tokensRaw),
						recipes: JSON.parse(recipesRaw),
					});

					if (!result.valid) {
						return {
							status: "reject",
							reviews: result.errors.map((err) => ({
								reviewerId: "analyze-validator",
								verdict: "reject" as const,
								findings: err,
								rejectionContext: `Validation error: ${err}. Fix this in the merge step.`,
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

		// Step 4b: Reviewer — vision AI review
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

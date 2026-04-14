/**
 * IO shell: design segment phase definitions.
 *
 * Thin wiring that reads files, calls pure functions, writes results.
 * Each phase is a PhaseDef consumed by the engine.
 */

import {
	type ChildProcess,
	exec as execCallback,
	spawn,
} from "node:child_process";
import {
	access,
	constants,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PhaseDef, StepDef } from "../../engine/types.js";
import { extractJsonObject } from "../../lib/json-extract.js";
import {
	launchBrowser,
	screenshotAtViewports,
} from "../../lib/playwright-utils.js";
import {
	consoleErrorReviewer,
	staticChecksReviewer,
	traceReviewer,
	visionReviewer,
} from "../../lib/reviewers.io.js";
import { evidencePath } from "../../lib/reviewers.js";
import { agentStep, programmaticStep } from "../../steps/step.js";
import type { DesignTokensV2, QualityScores } from "../../types.js";
import {
	applyContrastFixes,
	checkContrast,
	findContrastViolations,
	generateColorSystem,
} from "./color.js";
import { checkLayerIsolation } from "./layers.js";
import { composeFinalGate } from "./quality.js";
import {
	generateFontDeclarations,
	generateLayersFile,
	generateLayersImport,
	generateRootBlock,
	mapToShadcnComponents,
	tokensToCssProperties,
} from "./tokens.js";
import type { ComponentManifestOutput } from "./types.js";

const execAsync = promisify(execCallback);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Standard layer order (broad to specific)
const LAYER_ORDER = [
	"reset",
	"tokens",
	"layout",
	"typography",
	"surfaces",
	"color",
	"motion",
	"components",
] as const;

const ALL_LAYERS = [...LAYER_ORDER];

// Quality thresholds
const DEFAULT_QUALITY_THRESHOLD = 7.0;
const DEFAULT_FIDELITY_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function fileExists(workdir: string, filename: string): Promise<boolean> {
	try {
		await access(join(workdir, filename), constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function runCommand(
	cmd: string,
	cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		// promisify(exec) returns { stdout, stderr } on success — no `code` field.
		// A non-zero exit code causes it to reject with { stdout, stderr, code }.
		const result = (await execAsync(cmd, { cwd })) as {
			stdout: string;
			stderr: string;
		};
		return { stdout: result.stdout, stderr: result.stderr, code: 0 };
	} catch (err: unknown) {
		const error = err as { stdout?: string; stderr?: string; code?: number };
		return {
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? String(err),
			code: error.code ?? 1,
		};
	}
}

/**
 * Split CSS content into leading @import lines and the rest.
 *
 * CSS requires @import to appear before any ordinary rules.
 * This helper separates them so we can insert generated :root blocks
 * between the imports and the rest of the stylesheet.
 */
function splitImports(css: string): { imports: string; rest: string } {
	const lines = css.split("\n");
	let lastImportIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*@import\s/.test(lines[i])) {
			lastImportIdx = i;
		} else if (lines[i].trim() !== "") {
			break;
		}
	}
	if (lastImportIdx === -1) {
		return { imports: "", rest: css };
	}
	return {
		imports: lines.slice(0, lastImportIdx + 1).join("\n"),
		rest: lines.slice(lastImportIdx + 1).join("\n"),
	};
}

/**
 * Replace the template's default color blocks with the generated color system.
 *
 * Per D1, the generated color system is wrapped in `@layer color { ... }`.
 * This function removes template defaults (unlayered :root/.dark containing
 * --background) and inserts the @layer color block, or appends after imports
 * if no template defaults are found.
 */
function replaceColorBlocks(css: string, replacement: string): string {
	let result = css;

	// Remove the template's :root color block (contains --background)
	result = result.replace(/:root\s*\{[^}]*--background[^}]*\}/s, replacement);

	// If the template's .dark block is also present, remove it too
	// (it's already included in the replacement)
	result = result.replace(/\.dark\s*\{[^}]*--background[^}]*\}/s, "");

	// If no template blocks were found, just append after imports
	if (!result.includes(replacement)) {
		const { imports, rest } = splitImports(css);
		return `${imports}\n\n${replacement}\n\n${rest}`;
	}

	return result;
}

function patchFile(
	original: string,
	patch: { before?: string; after?: string; replace?: string },
): string {
	let result = original;
	if (patch.replace) {
		result = patch.replace;
	} else {
		if (patch.before && patch.after) {
			result = result.replace(patch.before, patch.before + patch.after);
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Color contrast helpers
// ---------------------------------------------------------------------------

const COLOR_VAR_PATTERN =
	/(--[\w-]+)\s*:\s*(oklch\([^)]+\)|#[a-f\d]{3,8}|rgb[a]?\([^)]+\))/gi;

const CONTRAST_BACKGROUNDS = [
	"background",
	"card",
	"popover",
	"muted",
	"primary",
	"secondary",
	"accent",
] as const;

const CONTRAST_FOREGROUNDS = [
	"foreground",
	"primary",
	"secondary",
	"accent",
	"destructive",
	"card-foreground",
	"popover-foreground",
	"destructive-foreground",
	"primary-foreground",
	"secondary-foreground",
	"accent-foreground",
	"muted-foreground",
] as const;

/**
 * Build comprehensive fg/bg color pairs for contrast checking.
 */
function buildColorPairs(
	colorMap: Record<string, string>,
): Array<{ foreground: string; background: string; context: string }> {
	const pairs: Array<{
		foreground: string;
		background: string;
		context: string;
	}> = [];
	for (const fgRole of CONTRAST_FOREGROUNDS) {
		for (const bgRole of CONTRAST_BACKGROUNDS) {
			const fgColor = colorMap[`--${fgRole}`] ?? colorMap[`--color-${fgRole}`];
			const bgColor = colorMap[`--${bgRole}`] ?? colorMap[`--color-${bgRole}`];
			if (fgColor && bgColor) {
				pairs.push({
					foreground: fgColor,
					background: bgColor,
					context: `foreground:${fgRole} on background:${bgRole}`,
				});
			}
		}
	}
	return pairs;
}

/** Extract color vars from a CSS block body into a map. */
function extractColorVars(blockBody: string): Record<string, string> {
	const map: Record<string, string> = {};
	for (const m of blockBody.matchAll(COLOR_VAR_PATTERN)) {
		map[m[1]] = m[2];
	}
	return map;
}

/**
 * Parse :root and .dark variable blocks from within `@layer color { ... }`.
 *
 * Per D1, Phase 4a writes `@layer color { :root { ... } .dark { ... } }`.
 * This function extracts the color layer block (using brace-depth counting
 * to handle nested braces), then parses the :root and .dark blocks within it.
 *
 * Returns { light, dark, parsed } where `parsed` indicates whether the
 * @layer color block was found. Callers should reject when `parsed` is false.
 */
function parseColorBlocks(css: string): {
	light: Record<string, string>;
	dark: Record<string, string>;
	parsed: boolean;
} {
	const lightMap: Record<string, string> = {};
	const darkMap: Record<string, string> = {};

	// Extract @layer color { ... } block using brace-depth counting.
	const layerMarker = "@layer color";
	const layerIdx = css.indexOf(layerMarker);
	if (layerIdx === -1) {
		return { light: lightMap, dark: darkMap, parsed: false };
	}

	// Find the opening brace after "@layer color"
	const openBraceIdx = css.indexOf("{", layerIdx + layerMarker.length);
	if (openBraceIdx === -1) {
		return { light: lightMap, dark: darkMap, parsed: false };
	}

	// Count braces to find the matching close
	let depth = 1;
	let i = openBraceIdx + 1;
	while (i < css.length && depth > 0) {
		if (css[i] === "{") depth++;
		else if (css[i] === "}") depth--;
		i++;
	}

	const layerBody = css.slice(openBraceIdx + 1, i - 1);

	// Extract :root { ... } from within the layer body
	const rootMatch = layerBody.match(/:root\s*\{([^}]*)\}/);
	if (rootMatch) Object.assign(lightMap, extractColorVars(rootMatch[1]));

	// Extract .dark { ... } from within the layer body
	const darkMatch = layerBody.match(/\.dark\s*\{([^}]*)\}/);
	if (darkMatch) Object.assign(darkMap, extractColorVars(darkMatch[1]));

	// Only consider parsed if we found at least the :root block with color vars
	const parsed =
		Object.keys(lightMap).length > 0 || Object.keys(darkMap).length > 0;

	return { light: lightMap, dark: darkMap, parsed };
}

/**
 * Write fixed color values back into a specific CSS mode block (:root or .dark).
 * Only replaces variable assignments within the targeted block, avoiding
 * cross-mode corruption (e.g., dark fix overwriting :root values).
 */
function applyFixedColorsMode(
	css: string,
	fixedMap: Record<string, string>,
	mode: "light" | "dark",
): string {
	const blockSelector = mode === "light" ? ":root" : "\\.dark";
	const blockRegex = new RegExp(
		`(${blockSelector}\\s*(?:\\([^)]*\\))?\\s*\\{)([^}]*)\\}`,
		"g",
	);

	return css.replace(blockRegex, (_match, openBrace: string, body: string) => {
		let result = body;
		for (const [key, value] of Object.entries(fixedMap)) {
			const varName = key.startsWith("--") ? key : `--${key}`;
			const regex = new RegExp(
				"(" +
					varName +
					"\\s*:\\s*)(oklch\\([^)]+\\)|#[a-f\\d]{3,8}|rgb[a]?\\([^)]+\\))",
				"gi",
			);
			result = result.replace(regex, `$1${value}`);
		}
		return `${openBrace}${result}}`;
	});
}

/**
 * Compute after-ratios for contrast evidence by re-checking fixed color pairs.
 */
function computeAfterRatios(
	violations: Array<{ context: string; ratio: number; required: number }>,
	fixed: { light: Record<string, string>; dark: Record<string, string> },
): Array<{ context: string; ratio: number; required: number }> {
	return violations.map((v) => {
		const modeMatch = v.context.match(/^(light|dark):/);
		const mode = modeMatch?.[1] ?? "light";
		const fgRole = v.context.replace(/^(light|dark):/, "");
		const fgMatch = fgRole.match(/foreground:(\S+)/);
		const bgMatch = fgRole.match(/on\s+background:(\S+)/);
		const fgKey = fgMatch ? `--${fgMatch[1]}` : "";
		const bgKey = bgMatch ? `--${bgMatch[1]}` : "";
		const map = mode === "dark" ? fixed.dark : fixed.light;
		const fgColor = map[fgKey] ?? "";
		const bgColor = map[bgKey] ?? "";
		let afterRatio = v.ratio;
		if (fgColor && bgColor) {
			const result = checkContrast(fgColor, bgColor);
			afterRatio = result.ratio;
		}
		return { context: v.context, ratio: afterRatio, required: v.required };
	});
}

// ---------------------------------------------------------------------------
// Dev server helper (for Playwright screenshot/review steps)
// ---------------------------------------------------------------------------

type DevServerEntry = { proc: ChildProcess; baseUrl: string };

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, () => {
			const addr = srv.address();
			if (addr && typeof addr === "object") {
				srv.close(() => resolve(addr.port));
			} else {
				srv.close(() => reject(new Error("Could not determine bound port")));
			}
		});
		srv.on("error", reject);
	});
}

function waitForReadyLine(
	proc: ChildProcess,
	requestedPort: number,
	timeout: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let resolved = false;
		const timer = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				proc.kill("SIGTERM");
				reject(
					new Error(
						`Dev server stdout did not contain "Local:" line for port ${requestedPort} within ${timeout}ms`,
					),
				);
			}
		}, timeout);

		if (proc.stdout) {
			proc.stdout.on("data", (chunk: Buffer) => {
				if (resolved) return;
				const portMatch = chunk
					.toString()
					.match(/Local[:\s]+https?:\/\/[^/:\s]+:(\d+)/);
				if (portMatch) {
					const actualPort = Number.parseInt(portMatch[1], 10);
					if (actualPort === requestedPort) {
						resolved = true;
						clearTimeout(timer);
						resolve();
					} else {
						resolved = true;
						clearTimeout(timer);
						proc.kill("SIGTERM");
						reject(
							new Error(
								`Dev server bound to port ${actualPort} instead of requested ${requestedPort}`,
							),
						);
					}
				}
			});
		}

		proc.on("exit", (code) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timer);
				reject(new Error(`Dev server exited prematurely with code ${code}`));
			}
		});
	});
}

async function startDevServer(
	cwd: string,
	timeout = 30_000,
): Promise<DevServerEntry> {
	const port = await findFreePort();
	const baseUrl = `http://localhost:${port}`;
	const proc = spawn("bunx", ["astro", "dev", "--port", String(port)], {
		cwd,
		stdio: "pipe",
	});

	await waitForReadyLine(proc, port, timeout);

	try {
		const res = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) {
			proc.kill("SIGTERM");
			throw new Error(
				`Dev server responded with HTTP ${res.status} at ${baseUrl}`,
			);
		}
	} catch (err) {
		proc.kill("SIGTERM");
		throw new Error(
			`Dev server at ${baseUrl} not responding after ready signal: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return { proc, baseUrl };
}

function stopDevServer(entry: DevServerEntry): void {
	if (!entry.proc.killed) {
		entry.proc.kill("SIGTERM");
	}
}

// ---------------------------------------------------------------------------
// Phase 1: Token Injection + Shadcn Setup
// ---------------------------------------------------------------------------

export const tokenPhase: PhaseDef = {
	id: "token-injection",
	name: "Token Injection + Shadcn Setup",
	description:
		"Convert design tokens to CSS, set up Shadcn components, add fonts",
	maxRetries: 5,
	steps: [
		// Step 1a: Programmatic — tokens → CSS files
		programmaticStep({
			id: "tokens-to-css",
			name: "Convert tokens to CSS",
			description: "Read design-tokens.json and write globals.css + layers.css",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const tokensRaw = await readFile(
						join(ctx.workdir, "design-tokens.json"),
						"utf-8",
					);
					const tokens: DesignTokensV2 = JSON.parse(tokensRaw);

					// Convert tokens to CSS properties
					const props = tokensToCssProperties(tokens);
					const rootBlock = generateRootBlock(props);
					const layersFile = generateLayersFile();
					const layersImport = generateLayersImport();

					// Write globals.css
					const globalsPath = join(
						ctx.workdir,
						"project/src/styles/globals.css",
					);
					const existingGlobals = await readFile(globalsPath, "utf-8").catch(
						() => "",
					);
					// Append root block AFTER existing @import rules.
					// CSS requires @import to appear before ordinary rules like :root {}.
					// If we prepend, the template's @import "tailwindcss" etc. become
					// invalid (ignored by the browser).
					const { imports, rest } = splitImports(existingGlobals);
					await writeFile(globalsPath, `${imports}\n\n${rootBlock}\n\n${rest}`);

					// Write layers.css
					const layersPath = join(ctx.workdir, "project/src/styles/layers.css");
					await mkdir(join(ctx.workdir, "project/src/styles"), {
						recursive: true,
					});
					await writeFile(layersPath, layersFile);

					// Patch Layout.astro with layers import
					const layoutPath = join(
						ctx.workdir,
						"project/src/layouts/Layout.astro",
					);
					const layoutContent = await readFile(layoutPath, "utf-8").catch(
						() => "",
					);
					const patchedLayout = patchFile(layoutContent, {
						before: "---",
						after: `\n${layersImport}`,
					});
					await writeFile(layoutPath, patchedLayout);

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Token injection failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),

		// Step 1b: Agent — install Shadcn components
		agentStep({
			id: "install-shadcn",
			name: "Install Shadcn components",
			description: "Map component manifest to Shadcn and install via CLI",
			buildPrompt: async (ctx) => {
				const manifest = await readJson<ComponentManifestOutput>(
					ctx.workdir,
					"component-manifest.json",
				);
				const components = manifest ? mapToShadcnComponents(manifest) : [];
				const uniqueComponents = [...new Set(components)];
				const componentList =
					uniqueComponents.length > 0
						? uniqueComponents.join(" ")
						: "button card input";

				// cwd is the workdir, not the project dir — must use --cwd flag
				const projectDir = join(ctx.workdir, "project");
				return `Install Shadcn components for an Astro project.

The project is located at: ${projectDir}
The cwd is the workdir, NOT the project directory. Use --cwd to point shadcn at the project:
\`\`\`bash
npx shadcn@latest add ${componentList} --yes --cwd ${projectDir}
\`\`\`

Components to install: ${componentList}

After running, verify the components were installed in ${projectDir}/src/components/ui/.`;
			},
		}),

		// Step 1c: Programmatic — add font declarations
		programmaticStep({
			id: "add-fonts",
			name: "Add font declarations",
			description: "Generate and patch Layout.astro with font loading",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const tokensRaw = await readFile(
						join(ctx.workdir, "design-tokens.json"),
						"utf-8",
					);
					const tokens: DesignTokensV2 = JSON.parse(tokensRaw);
					const fontFamilies = tokens.atomic.typography.fontFamily;

					const { links, fontFaceRules } =
						generateFontDeclarations(fontFamilies);

					// Patch Layout.astro head with font links
					const layoutPath = join(
						ctx.workdir,
						"project/src/layouts/Layout.astro",
					);
					const layoutContent = await readFile(layoutPath, "utf-8").catch(
						() => "",
					);

					let patched = layoutContent;
					if (links.length > 0) {
						const fontLinks = links.join("\n");
						patched = patchFile(patched, {
							before: "<head>",
							after: `\n${fontLinks}`,
						});
					}

					// Write the patched Layout.astro with font links
					await writeFile(layoutPath, patched);

					// Add @font-face rules to globals.css if any
					if (fontFaceRules.length > 0) {
						const globalsPath = join(
							ctx.workdir,
							"project/src/styles/globals.css",
						);
						const globals = await readFile(globalsPath, "utf-8").catch(
							() => "",
						);
						await writeFile(
							globalsPath,
							`${globals}\n\n${fontFaceRules.join("\n\n")}`,
						);
					}

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Font injection failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),

		// Step 1d: Programmatic — run astro build validation
		programmaticStep({
			id: "validate-build",
			name: "Validate Astro build",
			description: "Run astro build and verify Shadcn files exist",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const projectDir = join(ctx.workdir, "project");

					// Check Shadcn files exist
					const uiExists = await fileExists(
						ctx.workdir,
						"project/src/components/ui",
					);
					if (!uiExists) {
						return {
							status: "fail",
							error: "Shadcn components not installed — ui directory missing",
							duration: Date.now() - start,
						};
					}

					// Run astro build
					const build = await runCommand("bun run build", projectDir);
					// Write build evidence per D3
					{
						const buildEvDir = evidencePath(ctx.workdir, ctx.iteration);
						await mkdir(buildEvDir, { recursive: true });
						await writeFile(
							join(buildEvDir, "build.json"),
							JSON.stringify(
								{
									exitCode: build.code,
									stdout: build.stdout,
									stderr: build.stderr,
								},
								null,
								2,
							),
						);
					}
					if (build.code !== 0) {
						return {
							status: "fail",
							error: `Build failed: ${build.stderr}`,
							duration: Date.now() - start,
						};
					}

					// Validate layers import in Layout.astro
					const layoutPath = join(projectDir, "src/layouts/Layout.astro");
					const layout = await readFile(layoutPath, "utf-8").catch(() => "");
					if (!layout.includes("layers.css")) {
						return {
							status: "fail",
							error: "Layout.astro missing layers.css import",
							duration: Date.now() - start,
						};
					}

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Build validation failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),
	],
};

// ---------------------------------------------------------------------------
// Phase 2: Layout
// ---------------------------------------------------------------------------

export const layoutPhase: PhaseDef = {
	id: "layout",
	name: "Layout",
	description: "Apply layout layer — grid, flex, spacing, responsive",
	maxRetries: 5,
	steps: [
		// Step 2a: Agent — global layout
		agentStep({
			id: "global-layout",
			name: "Global layout",
			description: "Apply layout classes and spacing to global layout",
			buildPrompt: async (ctx) => {
				const tokensRaw = await readFile(
					join(ctx.workdir, "design-tokens.json"),
					"utf-8",
				);
				const tokens: DesignTokensV2 = JSON.parse(tokensRaw);

				return `You are a layout engineer. Apply CSS layout classes to the Astro project.

Design tokens available:
- Spacing: ${JSON.stringify(tokens.atomic.spacing, null, 2)}
- Breakpoints: ${JSON.stringify(tokens.layout.breakpoints, null, 2)}
- Sections: ${JSON.stringify(tokens.layout.sections, null, 2)}
- Container: ${JSON.stringify(tokens.layout.container, null, 2)}

Your task:
1. Edit project/src/styles/globals.css — add layout classes inside @layer layout { ... }
2. Use CSS Grid/Flexbox for page structure
3. Apply spacing tokens as CSS custom properties (--spacing-*)
4. Use container max-width tokens for centering
5. Add section top/bottom spacing

CRITICAL: All CSS must be inside @layer layout { ... }. Do not touch other layers.

Write clean, production-ready CSS.`;
			},
			validate: async (ctx, _output) => {
				const globalsPath = join(ctx.workdir, "project/src/styles/globals.css");
				const globals = await readFile(globalsPath, "utf-8").catch(() => "");

				const isolation = checkLayerIsolation(
					{ [globalsPath]: globals },
					"layout",
					ALL_LAYERS,
					{ checkSiblingLayers: true },
				);

				if (!isolation.isolated) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "layer-isolation",
								verdict: "reject",
								findings: `Layer violations: ${JSON.stringify(isolation.violations)}`,
								rejectionContext:
									"All layout CSS must be inside @layer layout { ... }. Fix the violations and retry.",
							},
						],
					};
				}

				return { status: "pass" };
			},
		}),

		// Step 2b: Agent — per-page layout (fan-out)
		agentStep({
			id: "per-page-layout",
			name: "Per-page layout",
			description: "Apply layout to individual page components",
			buildPrompt: async (ctx) => {
				// Get page types from reduced-meta
				const meta = await readJson<{
					page_types: Array<{ pagetype: string }>;
				}>(ctx.workdir, "reduced-meta.json");
				const pageTypes = meta?.page_types?.map((p) => p.pagetype) ?? ["home"];

				const tokensRaw = await readFile(
					join(ctx.workdir, "design-tokens.json"),
					"utf-8",
				);
				const tokens: DesignTokensV2 = JSON.parse(tokensRaw);

				return `Apply per-page layout using CSS classes.

Page types: ${pageTypes.join(" ")}

Spacing tokens: ${JSON.stringify(tokens.atomic.spacing)}

For each page component (src/pages/*.astro, src/components/**/*.astro):
1. Add Tailwind layout classes or CSS Grid/Flexbox inside @layer layout { ... }
2. Apply responsive breakpoints using tokens
3. Use spacing tokens for padding/margin

CRITICAL: All CSS must be inside @layer layout { ... } only.`;
			},
			validate: async (ctx, _output) => {
				const projectDir = join(ctx.workdir, "project");
				const files: Record<string, string> = {};

				try {
					const cssFiles = await readdir(join(projectDir, "src/styles"), {
						recursive: true,
					});
					for (const file of cssFiles) {
						if (String(file).endsWith(".css")) {
							const content = await readFile(
								join(projectDir, "src/styles", file as string),
								"utf-8",
							);
							files[join("src/styles", file as string)] = content;
						}
					}
				} catch {
					// No CSS files yet
				}

				const isolation = checkLayerIsolation(files, "layout", ALL_LAYERS, {
					checkSiblingLayers: true,
				});
				if (!isolation.isolated) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "layer-isolation",
								verdict: "reject",
								findings: `Layout layer violations: ${isolation.violations.length}`,
								rejectionContext: `Fix: ${isolation.violations.map((v) => `${v.file}:${v.line}`).join(" ")}`,
							},
						],
					};
				}

				return { status: "pass" };
			},
		}),

		// Step 2c: Programmatic — build + Playwright screenshots + layer validation
		programmaticStep({
			id: "layout-screenshot",
			name: "Layout screenshot + layer check",
			description:
				"Build, capture Playwright screenshots at 3 viewports, verify layout layer isolation",
			run: async (ctx) => {
				const start = Date.now();
				const projectDir = join(ctx.workdir, "project");
				let server: DevServerEntry | undefined;

				try {
					// Run build to ensure project compiles
					const buildResult = await runCommand("bun run build", projectDir);
					// Write build evidence per D3
					{
						const buildEvDir = evidencePath(ctx.workdir, ctx.iteration);
						await mkdir(buildEvDir, { recursive: true });
						await writeFile(
							join(buildEvDir, "build.json"),
							JSON.stringify(
								{
									exitCode: buildResult.code,
									stdout: buildResult.stdout,
									stderr: buildResult.stderr,
								},
								null,
								2,
							),
						);
					}
					if (buildResult.code !== 0) {
						return {
							status: "fail",
							error: `Build failed after layout phase: ${buildResult.stderr}`,
							duration: Date.now() - start,
						};
					}

					// Start dev server and capture screenshots at 3 viewports
					server = await startDevServer(projectDir);
					const browser = await launchBrowser();
					const context = await browser.newContext({ baseURL: server.baseUrl });
					const page = await context.newPage();

					const evPath = evidencePath(ctx.workdir, ctx.iteration);
					await mkdir(evPath, { recursive: true });
					await screenshotAtViewports(page, "/", undefined, evPath);

					await browser.close();

					// Verify layer isolation across all CSS files
					const files: Record<string, string> = {};
					try {
						const cssFiles = await readdir(join(projectDir, "src/styles"), {
							recursive: true,
						});
						for (const file of cssFiles) {
							if (String(file).endsWith(".css")) {
								const content = await readFile(
									join(projectDir, "src/styles", file as string),
									"utf-8",
								);
								files[join("src/styles", file as string)] = content;
							}
						}
					} catch {
						// No CSS files yet
					}

					// Note: checkSiblingLayers is NOT used here because by step 2c,
					// no sibling layers exist yet — only @layer layout has been written.
					// Nested @layer violations are still caught by the default check.
					const isolation = checkLayerIsolation(files, "layout", ALL_LAYERS);
					const evDir = evidencePath(ctx.workdir, ctx.iteration);
					await mkdir(evDir, { recursive: true });
					await writeFile(
						join(evDir, "layer-isolation.json"),
						JSON.stringify(
							{
								phase: "layout",
								isolated: isolation.isolated,
								violations: isolation.violations,
							},
							null,
							2,
						),
					);
					if (!isolation.isolated) {
						return {
							status: "fail",
							error: `Layout layer isolation broken: ${isolation.violations.map((v) => `${v.file}:${v.line} (${v.layer})`).join(" ")}`,
							duration: Date.now() - start,
						};
					}

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Layout check failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				} finally {
					if (server) stopDevServer(server);
				}
			},
		}),
	],
};

// ---------------------------------------------------------------------------
// Phase 3: Typography + Surfaces
// ---------------------------------------------------------------------------

export const typographyPhase: PhaseDef = {
	id: "typography",
	name: "Typography + Surfaces",
	description:
		"Apply typography scale, Shadcn customization, surface treatments",
	maxRetries: 5,
	steps: [
		// Step 3a: Agent — typography
		agentStep({
			id: "apply-typography",
			name: "Apply typography",
			description: "Apply font sizes, weights, and families",
			buildPrompt: async (ctx) => {
				const tokensRaw = await readFile(
					join(ctx.workdir, "design-tokens.json"),
					"utf-8",
				);
				const tokens: DesignTokensV2 = JSON.parse(tokensRaw);

				return `Apply typography using design tokens.

Typography tokens:
- Font families: ${JSON.stringify(tokens.atomic.typography.fontFamily)}
- Font sizes: ${JSON.stringify(tokens.atomic.typography.fontSize)}
- Font weights: ${JSON.stringify(tokens.atomic.typography.fontWeight)}

Task:
1. Edit globals.css — add typography styles inside @layer typography { ... }
2. Apply font-family tokens (--font-family-*)
3. Apply font-size tokens (--font-size-*)
4. Apply font-weight tokens (--font-weight-*)
5. Set body and heading defaults

CRITICAL: All CSS must be inside @layer typography { ... }.`;
			},
			validate: async (ctx, _output) => {
				const globalsPath = join(ctx.workdir, "project/src/styles/globals.css");
				const globals = await readFile(globalsPath, "utf-8").catch(() => "");

				// Note: checkSiblingLayers is NOT used here because by typography phase,
				// the cumulative file already has @layer layout from layout phase.
				// Using checkSiblingLayers:true would flag @layer layout as a false violation.
				// Nested @layer violations (e.g. @layer layout inside @layer typography)
				// are still caught by the default check.
				const isolation = checkLayerIsolation(
					{ [globalsPath]: globals },
					"typography",
					ALL_LAYERS,
				);
				if (!isolation.isolated) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "layer-isolation",
								verdict: "reject",
								findings: "Typography CSS outside @layer typography",
								rejectionContext:
									"All typography CSS must be inside @layer typography { ... }",
							},
						],
					};
				}
				return { status: "pass" };
			},
		}),

		// Step 3b: Agent — Shadcn customization
		agentStep({
			id: "customize-shadcn",
			name: "Customize Shadcn components",
			description: "Apply design tokens to Shadcn UI components",
			buildPrompt: async (ctx) => {
				const tokensRaw = await readFile(
					join(ctx.workdir, "design-tokens.json"),
					"utf-8",
				);
				const tokens: DesignTokensV2 = JSON.parse(tokensRaw);

				return `Customize Shadcn components with design tokens.

Design tokens:
- Border radius: ${JSON.stringify(tokens.atomic.borderRadius)}
- Shadows: ${JSON.stringify(tokens.atomic.shadows)}
- Colors: ${JSON.stringify(tokens.atomic.colors)}

Task:
1. Edit Shadcn component files in src/components/ui/
2. Apply border-radius tokens (--radius-*)
3. Apply shadow tokens (--shadow-*)
4. Keep components inside @layer components { ... }

CRITICAL: Component styles must be inside @layer components { ... }.`;
			},
		}),

		// Step 3c: Agent — surface treatments
		agentStep({
			id: "apply-surfaces",
			name: "Apply surface treatments",
			description: "Apply glass, texture, and image treatments",
			buildPrompt: async (ctx) => {
				const tokensRaw = await readFile(
					join(ctx.workdir, "design-tokens.json"),
					"utf-8",
				);
				const tokens: DesignTokensV2 = JSON.parse(tokensRaw);

				return `Apply surface treatments using design tokens.

Surface tokens:
- Glass: ${JSON.stringify(tokens.surfaces.glass)}
- Texture: ${JSON.stringify(tokens.surfaces.texture)}
- Image treatment: ${JSON.stringify(tokens.surfaces.imageTreatment)}

Task:
1. Edit globals.css or component files
2. Apply glass effects (backdrop-filter, opacity)
3. Apply texture treatments
4. Add surface CSS inside @layer surfaces { ... }

CRITICAL: All surface CSS must be inside @layer surfaces { ... }.`;
			},
			validate: async (ctx, _output) => {
				const globalsPath = join(ctx.workdir, "project/src/styles/globals.css");
				const globals = await readFile(globalsPath, "utf-8").catch(() => "");

				// Note: checkSiblingLayers is NOT used here because by surfaces phase,
				// the cumulative file already has @layer layout and @layer typography.
				// Using checkSiblingLayers:true would flag these as false violations.
				const isolation = checkLayerIsolation(
					{ [globalsPath]: globals },
					"surfaces",
					ALL_LAYERS,
				);
				if (!isolation.isolated) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "layer-isolation",
								verdict: "reject",
								findings: "Surface CSS outside @layer surfaces",
								rejectionContext:
									"All surface CSS must be inside @layer surfaces { ... }",
							},
						],
					};
				}
				return { status: "pass" };
			},
		}),

		// Step 3d: Vision review — typography + surfaces via Playwright screenshots
		visionReviewer({
			id: "typography-vision-review",
			name: "Typography + surfaces vision review",
			description:
				"Vision AI review of typography and surface application via Playwright screenshots",
			projectDir: "project",
		}),
	],
};

/**
 * Step 4d: Vision review + broad layer-isolation check.
 *
 * Per spec, Phase 4d includes both:
 *   - Light + dark screenshots at 3 viewports with vision review
 *   - checkLayerIsolation(files, "color", allLayers) across ALL CSS + Astro files
 *   - layer-isolation.json evidence
 *
 * This wraps the visionReviewer and adds file-based isolation checking.
 */
/**
 * Scan project directories for CSS and Astro files that may contain style content.
 * Per reviewer-3 (loop-5): color phase may write to layouts, pages, and non-UI components.
 */
async function scanProjectForStyleFiles(
	projectDir: string,
): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	const scanDirs = [
		"src/styles",
		"src/components/ui",
		"src/components",
		"src/layouts",
		"src/pages",
	];
	for (const subdir of scanDirs) {
		try {
			const dir = join(projectDir, subdir);
			const entries = await readdir(dir, { recursive: true });
			for (const entry of entries) {
				if (
					String(entry).endsWith(".css") ||
					String(entry).endsWith(".astro")
				) {
					const content = await readFile(join(dir, entry as string), "utf-8");
					files[join(subdir, entry as string)] = content;
				}
			}
		} catch {
			// Directories may not exist yet
		}
	}
	return files;
}

function colorVisionAndIsolationStep(): StepDef {
	const inner = visionReviewer({
		id: "color-vision-review",
		name: "Color + dark mode vision review",
		description: "Vision review of color application at 3 viewports × 2 modes",
		projectDir: "project",
		colorScheme: "dark",
		discoverRoutes: true,
		maxRoutesPerType: 2,
	});

	return {
		...inner,
		run: async (ctx) => {
			// Run the vision reviewer first
			const visionResult = await inner.run(ctx);

			// Run broad layer-isolation check across ALL CSS + Astro files the color phase may modify.
			const projectDir = join(ctx.workdir, "project");
			const files = await scanProjectForStyleFiles(projectDir);
			const isolation = checkLayerIsolation(files, "color", ALL_LAYERS);

			// Write layer-isolation.json evidence for the color phase
			const evDir = evidencePath(ctx.workdir, ctx.iteration);
			await mkdir(evDir, { recursive: true });
			await writeFile(
				join(evDir, "layer-isolation.json"),
				JSON.stringify(
					{
						phase: "color",
						isolated: isolation.isolated,
						violations: isolation.violations,
						filesChecked: Object.keys(files).length,
					},
					null,
					2,
				),
			);

			// If isolation broken, reject even if vision passed
			if (!isolation.isolated) {
				return {
					status: "reject",
					reviews: [
						...(visionResult.reviews ?? []),
						{
							reviewerId: "layer-isolation",
							verdict: "reject",
							findings: `Color layer isolation violations: ${isolation.violations.map((v) => `${v.file}:${v.line} (${v.layer})`).join("; ")}`,
							rejectionContext:
								"All color CSS must be inside @layer color { ... }",
						},
					],
					duration: visionResult.duration,
				};
			}

			return visionResult;
		},
	};
}

// ---------------------------------------------------------------------------
// Phase 4: Color + Dark Mode
// ---------------------------------------------------------------------------

export const colorPhase: PhaseDef = {
	id: "color",
	name: "Color + Dark Mode",
	description: "Apply color system with WCAG AA contrast and dark mode",
	maxRetries: 5,
	steps: [
		// Step 4a: Programmatic — generate color system
		programmaticStep({
			id: "generate-color-system",
			name: "Generate color system",
			description: "Read tokens and write color variables to globals.css",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const tokensRaw = await readFile(
						join(ctx.workdir, "design-tokens.json"),
						"utf-8",
					);
					const tokens: DesignTokensV2 = JSON.parse(tokensRaw);

					const { light, dark } = generateColorSystem(
						tokens.atomic.colors,
						tokens.visualIdentity,
					);

					// Read existing globals
					const globalsPath = join(
						ctx.workdir,
						"project/src/styles/globals.css",
					);
					const existingCss = await readFile(globalsPath, "utf-8").catch(
						() => "",
					);

					// Generate light mode color block
					const lightEntries = Object.entries(light)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([k, v]) => `  ${k}: ${v};`)
						.join("\n");

					// Generate dark mode color block
					const darkEntries = Object.entries(dark)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([k, v]) => `  ${k}: ${v};`)
						.join("\n");

					const colorBlock = `@layer color {
  /* Generated color system */
  :root {
${lightEntries}
  }

  /* Dark mode */
  .dark {
${darkEntries}
  }
}`;

					// Replace template's color vars (unlayered :root/.dark blocks).
					// CSS cascade: unlayered author rules > layered author rules.
					// Without this replacement, template's :root/.dark defaults would
					// take precedence over the generated color system.
					const finalCss = replaceColorBlocks(existingCss, colorBlock);
					await writeFile(globalsPath, finalCss);

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Color system generation failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),

		// Step 4b: Agent — component color + dark mode toggle
		agentStep({
			id: "apply-colors",
			name: "Apply component colors",
			description:
				"Apply color variables to components and implement dark mode",
			buildPrompt: async (_ctx) => {
				return `Apply color tokens to components and implement dark mode toggle.

Task:
1. Apply CSS color variables (--background, --foreground, --primary, etc.) to all components
2. Implement dark mode toggle in the UI (button or prefers-color-scheme)
3. Ensure dark mode class (.dark) is applied correctly
4. All color CSS must be inside @layer color { ... }

Color application:
- Text: color: var(--foreground)
- Background: background: var(--background)
- Borders: border-color: var(--border)
- Primary actions: background: var(--primary); color: var(--primary-foreground)

CRITICAL: All color CSS must be inside @layer color { ... }.`;
			},
			validate: async (ctx, _output) => {
				const projectDir = join(ctx.workdir, "project");
				const files = await scanProjectForStyleFiles(projectDir);

				// Note: checkSiblingLayers is NOT used here because by color phase,
				// the cumulative file already has @layer layout, @layer typography, @layer surfaces.
				// Using checkSiblingLayers:true would flag these as false violations.
				const isolation = checkLayerIsolation(files, "color", ALL_LAYERS);
				if (!isolation.isolated) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "layer-isolation",
								verdict: "reject",
								findings: `Color CSS outside @layer color: ${isolation.violations.map((v) => `${v.file}:${v.line}`).join(" ")}`,
								rejectionContext:
									"All color CSS must be inside @layer color { ... }",
							},
						],
					};
				}
				return { status: "pass" };
			},
		}),

		// Step 4c: Programmatic — contrast check + auto-fix
		programmaticStep({
			id: "contrast-check",
			name: "WCAG contrast check and auto-fix",
			description:
				"Extract color pairs from generated CSS (both light and dark modes), find allViolations, apply auto-fixes, write back",
			run: async (ctx) => {
				const start = Date.now();
				const evDir = evidencePath(ctx.workdir, ctx.iteration);
				await mkdir(evDir, { recursive: true });
				try {
					const globalsPath = join(
						ctx.workdir,
						"project/src/styles/globals.css",
					);
					let globals = await readFile(globalsPath, "utf-8").catch(() => "");
					if (!globals) {
						await writeFile(
							join(evDir, "contrast-check.json"),
							JSON.stringify(
								{
									violationCount: 0,
									fixesApplied: 0,
									error: "globals.css not found",
									reason: "globals.css not found",
								},
								null,
								2,
							),
						);
						return {
							status: "fail",
							error: "globals.css not found — cannot run contrast check",
							duration: Date.now() - start,
						};
					}

					// Separate :root (light) and .dark color maps
					const {
						light: lightMap,
						dark: darkMap,
						parsed,
					} = parseColorBlocks(globals);

					// Per D2: malformed or missing color blocks must reject
					if (!parsed) {
						await writeFile(
							join(evDir, "contrast-check.json"),
							JSON.stringify(
								{
									violationCount: 0,
									fixesApplied: 0,
									error: "@layer color block not found or empty — parse failed",
								},
								null,
								2,
							),
						);
						return {
							status: "fail",
							error:
								"parseColorBlocks: @layer color block not found or contains no color variables — globals.css may be malformed",
							duration: Date.now() - start,
						};
					}

					// Build contrast pairs for each mode separately
					const lightPairs = buildColorPairs(lightMap);
					const darkPairs = buildColorPairs(darkMap);

					// Tag allViolations with mode so applyContrastFixes knows which map to fix
					const lightViolations = findContrastViolations(
						lightPairs.map((p) => ({ ...p, context: `light:${p.context}` })),
					);
					const darkViolations = findContrastViolations(
						darkPairs.map((p) => ({ ...p, context: `dark:${p.context}` })),
					);
					const allViolations = [...lightViolations, ...darkViolations];

					if (allViolations.length === 0) {
						await writeFile(
							join(evDir, "contrast-check.json"),
							JSON.stringify(
								{
									violationCount: 0,
									fixesApplied: 0,
									pairsChecked: lightPairs.length + darkPairs.length,
								},
								null,
								2,
							),
						);
						return { status: "pass", duration: Date.now() - start };
					}

					const { fixed, changes } = applyContrastFixes(
						{ light: lightMap, dark: darkMap },
						allViolations,
					);

					const beforeRatios = allViolations.map((v) => ({
						context: v.context,
						ratio: v.ratio,
						required: v.required,
					}));

					if (changes.length > 0) {
						globals = applyFixedColorsMode(globals, fixed.light, "light");
						globals = applyFixedColorsMode(globals, fixed.dark, "dark");
						await writeFile(globalsPath, globals);

						// Compute after-ratios for evidence
						const afterRatios = computeAfterRatios(allViolations, fixed);

						await writeFile(
							join(evDir, "contrast-check.json"),
							JSON.stringify(
								{
									violationCount: allViolations.length,
									fixesApplied: changes.length,
									before: beforeRatios,
									after: afterRatios,
									changes,
								},
								null,
								2,
							),
						);
						return {
							status: "pass",
							duration: Date.now() - start,
							metadata: { violationsFixed: allViolations.length, changes },
						};
					}

					await writeFile(
						join(evDir, "contrast-check.json"),
						JSON.stringify(
							{
								violationCount: allViolations.length,
								fixesApplied: 0,
								before: beforeRatios,
								unfixable: true,
							},
							null,
							2,
						),
					);

					return {
						status: "fail",
						error: `${allViolations.length} contrast violation(s) could not be auto-fixed: ${allViolations.map((v) => `${v.context} (${v.ratio}:1)`).join("; ")}`,
						duration: Date.now() - start,
					};
				} catch (err) {
					return {
						status: "fail",
						error: `Contrast check failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),

		// Step 4d: Vision review + broad layer-isolation check
		// Wraps the vision reviewer and adds file-based isolation + evidence.
		colorVisionAndIsolationStep(),
	],
};

// ---------------------------------------------------------------------------
// Phase 5: Motion
// ---------------------------------------------------------------------------

export const motionPhase: PhaseDef = {
	id: "motion",
	name: "Motion",
	description: "Apply transitions, hover/focus states, scroll reveals",
	maxRetries: 5,
	steps: [
		// Step 5a: Agent — global motion
		agentStep({
			id: "apply-global-motion",
			name: "Apply global motion",
			description: "Apply motion duration, easing, and global transitions",
			buildPrompt: async (ctx) => {
				const tokensRaw = await readFile(
					join(ctx.workdir, "design-tokens.json"),
					"utf-8",
				);
				const tokens: DesignTokensV2 = JSON.parse(tokensRaw);

				return `Apply motion design tokens to the project.

Motion tokens:
- Duration: ${JSON.stringify(tokens.motion.duration)}
- Easing: ${JSON.stringify(tokens.motion.easing)}
- State (hover/focus): ${JSON.stringify(tokens.motion.state)}

Task:
1. Edit globals.css
2. Apply motion duration tokens (--motion-duration-*)
3. Apply motion easing tokens (--motion-easing-*)
4. Add global transition declarations
5. Add prefers-reduced-motion media query to disable animations

All motion CSS must be inside @layer motion { ... }.

CRITICAL: Include:
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}`;
			},
			validate: async (ctx, _output) => {
				const globalsPath = join(ctx.workdir, "project/src/styles/globals.css");
				const globals = await readFile(globalsPath, "utf-8").catch(() => "");

				// Note: checkSiblingLayers is NOT used here because by motion phase,
				// the cumulative file already has all previous @layer blocks.
				// Using checkSiblingLayers:true would flag them as false violations.
				const isolation = checkLayerIsolation(
					{ [globalsPath]: globals },
					"motion",
					ALL_LAYERS,
				);
				if (!isolation.isolated) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "layer-isolation",
								verdict: "reject",
								findings: "Motion CSS outside @layer motion",
								rejectionContext:
									"All motion CSS must be inside @layer motion { ... }",
							},
						],
					};
				}
				return { status: "pass" };
			},
		}),

		// Step 5b: Agent — per-component states
		agentStep({
			id: "apply-component-states",
			name: "Apply component motion states",
			description: "Apply hover, focus, active states to components",
			buildPrompt: async (_ctx) => {
				return `Apply hover, focus, and active states to components.

Task:
1. Edit component files in src/components/ui/
2. Add hover states: :hover pseudo-class with transition
3. Add focus states: :focus-visible with outline
4. Add active states: :active with scale/opacity change
5. All state CSS must be inside @layer motion { ... }

Example:
.button {
  transition: background-color var(--motion-duration-fast) var(--motion-easing-out);
}
.button:hover {
  background-color: var(--color-primary-hover);
}
.button:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

CRITICAL: All motion CSS must be inside @layer motion { ... }.`;
			},
			validate: async (ctx, _output) => {
				const projectDir = join(ctx.workdir, "project");
				const files: Record<string, string> = {};

				try {
					for (const subdir of ["src/components/ui", "src/styles"]) {
						const dir = join(projectDir, subdir);
						const entries = await readdir(dir, { recursive: true });
						for (const entry of entries) {
							if (
								String(entry).endsWith(".css") ||
								String(entry).endsWith(".astro")
							) {
								const content = await readFile(
									join(dir, entry as string),
									"utf-8",
								);
								files[join(subdir, entry as string)] = content;
							}
						}
					}
				} catch {
					// Ignore
				}

				// Note: checkSiblingLayers is NOT used here because by step 5b,
				// the cumulative file already has all @layer blocks from earlier phases.
				// Nested @layer violations are still caught by the default check.
				const isolation = checkLayerIsolation(files, "motion", ALL_LAYERS);
				if (!isolation.isolated) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "layer-isolation",
								verdict: "reject",
								findings: "Motion layer violations found",
								rejectionContext: `Fix: ${isolation.violations.map((v) => `${v.file}:${v.line}`).join(" ")}`,
							},
						],
					};
				}
				return { status: "pass" };
			},
		}),

		// Step 5c: Vision review — motion via Playwright screenshots
		visionReviewer({
			id: "motion-vision-review",
			name: "Motion vision review",
			description:
				"Vision AI review of motion and transitions via Playwright screenshots",
			projectDir: "project",
		}),
	],
};

// ---------------------------------------------------------------------------
// Runtime validation helpers (for final gate)
// ---------------------------------------------------------------------------

async function checkDarkModeRuntime(
	browser: import("@playwright/test").Browser,
	baseUrl: string,
): Promise<boolean> {
	const lightPage = await browser.newPage({ baseURL: baseUrl });
	await lightPage.goto("/", { waitUntil: "networkidle" });
	// Template applies bg to body, not html — check body to avoid false failures.
	const lightBg = await lightPage.evaluate(
		() => getComputedStyle(document.body).backgroundColor,
	);

	const darkPage = await browser.newPage({ baseURL: baseUrl });
	await darkPage.goto("/", { waitUntil: "networkidle" });
	await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
	await darkPage.waitForTimeout(500);
	const darkBg = await darkPage.evaluate(
		() => getComputedStyle(document.body).backgroundColor,
	);

	return lightBg !== darkBg;
}

async function checkReducedMotionRuntime(
	browser: import("@playwright/test").Browser,
	baseUrl: string,
): Promise<boolean> {
	const page = await browser.newPage({ baseURL: baseUrl });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto("/", { waitUntil: "networkidle" });
	const violations = await page.evaluate(() => {
		const els = document.querySelectorAll("body *");
		const results: string[] = [];
		for (const el of Array.from(els)) {
			const style = getComputedStyle(el);
			const t = style.transitionDuration;
			const a = style.animationDuration;
			if (t && Number.parseFloat(t) > 0.1) {
				results.push(`${el.tagName} has transition ${t}`);
			}
			if (a && Number.parseFloat(a) > 0.1) {
				results.push(`${el.tagName} has animation ${a}`);
			}
		}
		return results;
	});
	return violations.length === 0;
}

async function checkOverflowRuntime(
	browser: import("@playwright/test").Browser,
	baseUrl: string,
): Promise<boolean> {
	const page = await browser.newPage({ baseURL: baseUrl });
	await page.goto("/", { waitUntil: "networkidle" });
	// Check for unexpected horizontal overflow (layout bug, not normal scroll).
	// Normal vertical scrolling is expected and NOT flagged.
	for (const vp of [
		{ width: 375, height: 812 },
		{ width: 768, height: 1024 },
		{ width: 1440, height: 720 },
	]) {
		await page.setViewportSize(vp);
		await page.waitForTimeout(200);
		const overflow = await page.evaluate(() => {
			const doc = document.documentElement;
			// Flag only HORIZONTAL overflow (content wider than viewport).
			// Vertical scrollHeight > clientHeight is normal — don't flag that.
			return doc.scrollWidth > doc.clientWidth;
		});
		if (overflow) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Phase 6: Final Visual QA
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

export const qaPhase: PhaseDef = {
	id: "qa",
	name: "Final Visual QA",
	description: "Run all reviewers, quality scoring, and final gate",
	maxRetries: 5,
	steps: [
		// Step 6a: Reviewers — all 4 types using IO-shell reviewers with real Playwright/browser automation
		staticChecksReviewer({
			id: "qa-static-checks",
			name: "Static checks reviewer",
			description: "Run bun check, astro build, and lychee link checking",
			projectDir: "project",
		}),

		consoleErrorReviewer({
			id: "qa-console-errors",
			name: "Console errors reviewer",
			description: "Launch Playwright and capture runtime console errors",
			projectDir: "project",
		}),

		traceReviewer({
			id: "qa-trace-review",
			name: "Trace reviewer",
			description:
				"Read generated .astro/.ts/.css files and send to AI for quality analysis",
			projectDir: "project",
		}),

		visionReviewer({
			id: "qa-vision-review",
			name: "Vision QA reviewer",
			description:
				"Take screenshots and send to vision AI for final visual quality assessment",
			projectDir: "project",
		}),

		// Step 6b: Agent — quality scoring
		agentStep({
			id: "quality-scoring",
			name: "Quality scoring",
			description: "Parse reviewer outputs and write quality-scores.json",
			buildPrompt: async (_ctx) => {
				return `Parse the reviewer outputs from Phase 6a and compute quality scores.

Output a JSON object (quality-scores.json):
{
  "overall": <0-10>,
  "dimensions": {
    "layoutConsistency": <0-10>,
    "designTokenUsage": <0-10>,
    "componentComposition": <0-10>,
    "responsiveDesign": <0-10>,
    "semanticHtml": <0-10>,
    "visualAppeal": <0-10>,
    "motionQuality": <0-10>
  }
}

Consider all reviewer feedback when scoring. Scores should reflect real quality.
Output ONLY the JSON object, no other text.`;
			},
			validate: async (ctx, output) => {
				const scores = extractJsonObject(output) as QualityScores | null;
				if (!scores) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "quality-parser",
								verdict: "reject",
								findings: "No JSON found in quality scoring output",
								rejectionContext: `Output must be a valid JSON object. Received text starts with: ${output.slice(0, 200)}`,
							},
						],
					};
				}

				await writeFile(
					join(ctx.workdir, "quality-scores.json"),
					JSON.stringify(scores, null, 2),
				);
				return { status: "pass" };
			},
		}),

		// Step 6c: Agent — fidelity scoring
		agentStep({
			id: "fidelity-scoring",
			name: "Fidelity scoring",
			description: "Vision-based fidelity scoring",
			buildPrompt: async (ctx) => {
				const referenceUrl = ctx.config.reference ?? "unknown";
				return `Score visual fidelity of the generated site against the reference.

Reference: ${referenceUrl}

Score each dimension 0-1:
- layout: grid structure matches reference
- typography: font choices and hierarchy match
- color: color palette and application match
- spacing: spacing scale matches reference
- components: UI components match reference style
- motion: animations match reference feel

Output JSON:
{
  "layout": <0-1>,
  "typography": <0-1>,
  "color": <0-1>,
  "spacing": <0-1>,
  "components": <0-1>,
  "motion": <0-1>
}

Output ONLY the JSON object, no other text.`;
			},
			validate: async (ctx, output) => {
				const fidelityScores = extractJsonObject(output);
				if (!fidelityScores) {
					return {
						status: "reject",
						reviews: [
							{
								reviewerId: "fidelity-parser",
								verdict: "reject",
								findings: "No JSON found in fidelity scoring output",
								rejectionContext: `Output must be a valid JSON object. Received text starts with: ${output.slice(0, 200)}`,
							},
						],
					};
				}

				// Append to existing quality-scores.json
				const existing = await readJson<QualityScores>(
					ctx.workdir,
					"quality-scores.json",
				);
				const merged = existing
					? { ...existing, fidelity: fidelityScores }
					: {
							overall: 0,
							dimensions: {} as QualityScores["dimensions"],
							fidelity: fidelityScores,
						};
				await writeFile(
					join(ctx.workdir, "quality-scores.json"),
					JSON.stringify(merged, null, 2),
				);

				return { status: "pass" };
			},
		}),

		// Step 6d: Programmatic — compose final gate with runtime validation
		programmaticStep({
			id: "final-gate",
			name: "Final gate evaluation",
			description:
				"Build, runtime checks via Playwright (dark mode, reduced motion, overflow), compose final gate",
			run: async (ctx) => {
				const start = Date.now();
				const projectDir = join(ctx.workdir, "project");
				let server: DevServerEntry | undefined;
				let darkModeWorks = false;
				let reducedMotionRespected = false;
				let overflowFree = false;

				try {
					// Run build
					const build = await runCommand("bun run build", projectDir);
					// Write build evidence per D3
					{
						const buildEvDir = evidencePath(ctx.workdir, ctx.iteration);
						await mkdir(buildEvDir, { recursive: true });
						await writeFile(
							join(buildEvDir, "build.json"),
							JSON.stringify(
								{
									exitCode: build.code,
									stdout: build.stdout,
									stderr: build.stderr,
								},
								null,
								2,
							),
						);
					}
					const buildSuccess = build.code === 0;

					// Read scores
					const scores = await readJson<QualityScores>(
						ctx.workdir,
						"quality-scores.json",
					);

					// Runtime validation via Playwright
					server = await startDevServer(projectDir);
					const browser = await launchBrowser();

					try {
						[darkModeWorks, reducedMotionRespected, overflowFree] =
							await Promise.all([
								checkDarkModeRuntime(browser, server.baseUrl),
								checkReducedMotionRuntime(browser, server.baseUrl),
								checkOverflowRuntime(browser, server.baseUrl),
							]);
					} finally {
						await browser.close();
					}

					// Check layer isolation across all CSS files
					const cssFiles: Record<string, string> = {};
					try {
						const styleFiles = await readdir(join(projectDir, "src/styles"), {
							recursive: true,
						});
						for (const file of styleFiles) {
							if (String(file).endsWith(".css")) {
								const fileContent = await readFile(
									join(projectDir, "src/styles", file as string),
									"utf-8",
								);
								cssFiles[String(file)] = fileContent;
							}
						}
					} catch {
						// No styles directory
					}

					let layerIsolated = true;
					for (const layer of ALL_LAYERS) {
						const result = checkLayerIsolation(cssFiles, layer, ALL_LAYERS);
						if (!result.isolated) {
							layerIsolated = false;
							break;
						}
					}

					// Compose gate result
					const gate = composeFinalGate({
						buildSuccess,
						overflowFree,
						darkModeWorks,
						reducedMotionRespected,
						qualityScores: scores ?? {
							overall: 0,
							dimensions: {
								layoutConsistency: 0,
								designTokenUsage: 0,
								componentComposition: 0,
								responsiveDesign: 0,
								semanticHtml: 0,
								visualAppeal: 0,
								motionQuality: 0,
							},
						},
						fidelityScores:
							(scores as { fidelity?: Record<string, number> })?.fidelity ?? {},
						layerIsolation: layerIsolated,
						qualityThreshold: DEFAULT_QUALITY_THRESHOLD,
						fidelityThreshold: DEFAULT_FIDELITY_THRESHOLD,
					});

					if (!gate.passed) {
						return {
							status: "reject",
							reviews: gate.errors.map((err) => ({
								reviewerId: "final-gate",
								verdict: "reject" as const,
								findings: err,
								rejectionContext: `Gate failure: ${err}`,
							})),
							duration: Date.now() - start,
						};
					}

					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `Final gate failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				} finally {
					if (server) stopDevServer(server);
				}
			},
		}),
	],
};

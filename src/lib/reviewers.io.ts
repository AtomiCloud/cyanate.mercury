/**
 * Reviewer IO shell — factory functions that create StepDef objects for
 * common reviewer types: static checks, console errors, vision, and trace.
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { extname, join } from "node:path";
import type { Review, StepDef, StepResult } from "../engine/types.js";
import { agentQuery } from "./agent.js";
import {
	captureConsoleErrors,
	launchBrowser,
	screenshotAtViewports,
} from "./playwright-utils.js";
import {
	aggregateReviewerVerdicts,
	evidencePath,
	parseReviewerVerdict,
	reviewPath,
} from "./reviewers.js";

/**
 * Run a shell command and return its stderr on failure, or undefined on success.
 */
function runCommand(
	command: string,
	cwd: string,
	timeout = 120_000,
): string | undefined {
	try {
		execSync(command, { cwd, timeout, encoding: "utf-8" });
		return undefined;
	} catch (err: unknown) {
		return err instanceof Error ? err.message : String(err);
	}
}

/**
 * Check if a command error indicates the binary is not installed.
 */
function isBinaryNotFoundError(output: string): boolean {
	return (
		output.includes("command not found") ||
		output.includes("No such file or directory") ||
		output.includes("not found")
	);
}

/**
 * Run an optional command (like astro build or lychee) and collect errors.
 * If the command isn't installed, it's silently skipped.
 */
function collectOptionalCommandError(
	command: string,
	cwd: string,
	label: string,
): string | undefined {
	const result = runCommand(command, cwd);
	if (result && !isBinaryNotFoundError(result)) {
		return `${label} failed:\n${result}`;
	}
	return undefined;
}

export interface ReviewerOpts {
	id: string;
	name: string;
	description: string;
	profileKey?: string;
	/** Routes to visit for console/vision reviewers. Falls back to ["/"] if not set. */
	routes?: string[];
	/** Base URL for the dev server (e.g., "http://localhost:4321"). Required for console/vision reviewers. */
	baseUrl?: string;
	/** Subdirectory within workdir to target (e.g., "project"). If set, commands and file reads use this subdir. */
	projectDir?: string;
	/** Color scheme to emulate for vision screenshots. If set, screenshots are taken in this mode. */
	colorScheme?: "light" | "dark";
	/** When true, discover routes from src/pages/ at runtime instead of using static routes list. */
	discoverRoutes?: boolean;
	/** When discoverRoutes is true, keep at most this many routes per page-type group. Default: unlimited. */
	maxRoutesPerType?: number;
}

/** Resolve the effective CWD for reviewer operations. */
function resolveReviewerCwd(workdir: string, projectDir?: string): string {
	return projectDir ? join(workdir, projectDir) : workdir;
}

/**
 * Discover routes by scanning src/pages/ for .astro files and src/content/ for
 * collection entries that back dynamic routes.
 *
 * Converts file paths to URL routes:
 * - index.astro → /
 * - about.astro → /about
 * - blog/[slug].astro + src/content/blog/ entries → /blog/my-post, /blog/another-post
 */
async function discoverRoutesFromPages(projectDir: string): Promise<string[]> {
	const staticRoutes = await scanPagesDir(join(projectDir, "src/pages"), "");
	const concrete = staticRoutes.filter((r) => !r.includes("["));

	// Discover dynamic route concrete URLs by scanning content collections.
	// For each dynamic route pattern like /blog/[slug], look for collection entries
	// in src/content/blog/ to generate /blog/my-post, /blog/another-post, etc.
	const dynamicConcrete = await discoverDynamicRoutes(projectDir, staticRoutes);

	const allRoutes = [...concrete, ...dynamicConcrete];
	return allRoutes.length > 0 ? allRoutes : ["/"];
}

/**
 * Scan content collections to find entry IDs, then map them to dynamic route patterns.
 * For example, if src/pages/blog/[slug].astro exists and src/content/blog/ has
 * my-post.md and another-post.md, this returns /blog/my-post and /blog/another-post.
 */
async function discoverDynamicRoutes(
	projectDir: string,
	staticRoutes: string[],
): Promise<string[]> {
	const concreteRoutes: string[] = [];

	// Find dynamic route patterns (routes containing [)
	const dynamicPatterns = staticRoutes.filter((r) => r.includes("["));
	if (dynamicPatterns.length === 0) return [];

	// Build a map of collection name -> param name for each dynamic pattern
	// e.g., /blog/[slug] -> { collection: "blog", param: "slug" }
	for (const pattern of dynamicPatterns) {
		// Extract the directory and param from patterns like /blog/[slug] or /[slug]
		const paramMatch = pattern.match(/\/([^/]+)\/\[([^\]]+)\]$/);
		if (!paramMatch) continue;

		const [, collection, _param] = paramMatch;
		const contentDir = join(projectDir, "src/content", collection);

		try {
			const entries = await readdir(contentDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isFile()) {
					// Content collection entry ID is the filename without extension
					// e.g., my-post.md -> "my-post"
					const ext = extname(entry.name);
					const entryId = entry.name.slice(0, -ext.length - 1); // remove .md and .
					// Generate route: /blog/my-post
					const route = `/${collection}/${entryId}`;
					if (!concreteRoutes.includes(route)) {
						concreteRoutes.push(route);
					}
				}
			}
		} catch {
			// Collection directory may not exist
		}
	}

	return concreteRoutes;
}

async function scanPagesDir(dir: string, prefix: string): Promise<string[]> {
	const routes: string[] = [];
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const route = astroFileToRoute(entry.name);
			if (route !== null) {
				routes.push(`${prefix}${route}`);
			} else if (entry.isDirectory()) {
				const sub = await scanPagesDir(
					join(dir, entry.name),
					`${prefix}/${entry.name}`,
				);
				routes.push(...sub);
			}
		}
	} catch {
		// Directory may not exist
	}
	return routes;
}

/** Convert an .astro filename to a route path. index.astro → /, about.astro → /about. */
function astroFileToRoute(name: string): string | null {
	if (!name.endsWith(".astro")) return null;
	const base = name.slice(0, -6); // remove .astro
	if (base === "index") return "/";
	return `/${base}`;
}

/**
 * Find a free port by binding a temporary server and immediately closing it.
 * This avoids the race condition where another process grabs the port between
 * probe and use.
 */
function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, () => {
			const addr = srv.address();
			if (addr && typeof addr === "object") {
				const port = addr.port;
				srv.close(() => resolve(port));
			} else {
				srv.close(() => reject(new Error("Could not determine bound port")));
			}
		});
		srv.on("error", reject);
	});
}

/**
 * Wait for the spawned Astro/Vite process to emit its "Local:" line in stdout,
 * confirming it actually bound to the expected port. This is the PRIMARY
 * readiness signal — it proves the process we spawned is the one listening.
 */
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
				const text = chunk.toString();
				// Match both "Local: http://..." (old) and "┃ Local    http://..." (Astro 5+/6 box-drawing)
				const portMatch = text.match(/Local[:\s]+https?:\/\/[^/:\s]+:(\d+)/);
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
				reject(
					new Error(
						`Dev server exited prematurely with code ${code} before emitting ready line`,
					),
				);
			}
		});
	});
}

type DevServerEntry = { proc: ChildProcess; baseUrl: string };

/** Start a dev server in the given directory, waiting until it responds. */
async function startDevServer(
	cwd: string,
	timeout = 30_000,
): Promise<DevServerEntry> {
	// Always pick a free port to avoid colliding with any pre-existing server.
	// This eliminates the class of bug where fetch() succeeds against an
	// unrelated process that was already listening on the requested port.
	const port = await findFreePort();
	const baseUrl = `http://localhost:${port}`;

	const proc = spawn("bunx", ["astro", "dev", "--port", String(port)], {
		cwd,
		stdio: "pipe",
	});

	// Primary readiness signal: wait for Vite's stdout "Local:" line.
	// This proves the spawned process (not something else) is serving.
	await waitForReadyLine(proc, port, timeout);

	// Secondary check: verify the server is actually responsive via HTTP.
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

/** Stop a previously started dev server process. */
function stopDevServer(entry: DevServerEntry): void {
	if (!entry.proc.killed) {
		entry.proc.kill("SIGTERM");
	}
}

/**
 * Static checks reviewer — runs `bun check`, `astro build`, and `lychee` link checking.
 * Returns pass if all commands succeed, reject with error details otherwise.
 */
export function staticChecksReviewer(opts: ReviewerOpts): StepDef {
	const run = async (
		ctx: import("../engine/types.js").StepContext,
	): Promise<StepResult> => {
		const start = Date.now();
		const errors: string[] = [];
		const cwd = resolveReviewerCwd(ctx.workdir, opts.projectDir);

		// Run bun run check (required)
		const checkResult = runCommand("bun run check", cwd);
		if (checkResult) errors.push(`bun run check failed:\n${checkResult}`);

		// Run optional commands
		for (const [cmd, label] of [
			["bunx astro build", "astro build"],
			["lychee . --no-progress --format json", "lychee link check"],
		] as const) {
			const err = collectOptionalCommandError(cmd, cwd, label);
			if (err) errors.push(err);
		}

		// Write evidence
		const evPath = evidencePath(ctx.workdir, ctx.iteration);
		await mkdir(evPath, { recursive: true });
		await writeFile(
			join(evPath, "static-checks.txt"),
			errors.length > 0 ? errors.join("\n\n") : "All checks passed.",
		);

		const duration = Date.now() - start;
		if (errors.length > 0) {
			return {
				status: "reject",
				reviews: [
					{
						reviewerId: opts.id,
						verdict: "reject",
						findings: errors.join("\n\n"),
						rejectionContext: errors.join("\n\n"),
					},
				],
				duration,
			};
		}

		return { status: "pass", duration };
	};

	return {
		id: opts.id,
		name: opts.name,
		description: opts.description,
		type: "reviewer",
		profileKey: opts.profileKey,
		run,
	};
}

/**
 * Console error reviewer — launches Playwright, visits routes, captures console errors.
 */
export function consoleErrorReviewer(opts: ReviewerOpts): StepDef {
	const run = async (
		ctx: import("../engine/types.js").StepContext,
	): Promise<StepResult> => {
		const start = Date.now();
		const cwd = resolveReviewerCwd(ctx.workdir, opts.projectDir);

		// Start dev server if projectDir is set (server isn't running yet)
		let server: DevServerEntry | undefined;
		if (opts.projectDir) {
			try {
				server = await startDevServer(cwd);
			} catch (err) {
				return {
					status: "reject",
					reviews: [
						{
							reviewerId: opts.id,
							verdict: "reject",
							findings: `Dev server failed to start: ${String(err)}`,
							rejectionContext: `Dev server startup failed in ${cwd}`,
						},
					],
					duration: Date.now() - start,
				};
			}
		}

		const baseUrl = server?.baseUrl ?? opts.baseUrl ?? "http://localhost:4321";

		try {
			return await runConsoleErrorChecks(opts, ctx, baseUrl, start);
		} finally {
			if (server) stopDevServer(server);
		}
	};

	return {
		id: opts.id,
		name: opts.name,
		description: opts.description,
		type: "reviewer",
		profileKey: opts.profileKey,
		run,
	};
}

async function runConsoleErrorChecks(
	opts: ReviewerOpts,
	ctx: import("../engine/types.js").StepContext,
	baseUrl: string,
	start: number,
): Promise<StepResult> {
	const browser = await launchBrowser();
	const context = await browser.newContext({ baseURL: baseUrl });
	const page = await context.newPage();

	const routes = opts.discoverRoutes
		? await discoverRoutesFromPages(
				resolveReviewerCwd(ctx.workdir, opts.projectDir),
			)
		: (opts.routes ?? ["/"]);
	const allErrors: string[] = [];

	for (const route of routes) {
		const messages = await captureConsoleErrors(page, route);
		for (const msg of messages) {
			if (msg.type === "error") {
				allErrors.push(`[${route}] ${msg.text}`);
			}
		}
	}

	await browser.close();

	const evPath = evidencePath(ctx.workdir, ctx.iteration);
	await mkdir(evPath, { recursive: true });
	await writeFile(
		join(evPath, "console-errors.json"),
		JSON.stringify({ errors: allErrors }, null, 2),
	);

	const duration = Date.now() - start;
	if (allErrors.length > 0) {
		return {
			status: "reject",
			reviews: [
				{
					reviewerId: opts.id,
					verdict: "reject",
					findings: `Found ${allErrors.length} console error(s):\n${allErrors.join("\n")}`,
					rejectionContext: allErrors.join("\n"),
				},
			],
			duration,
		};
	}

	return { status: "pass", duration };
}

/**
 * Build the vision review prompt for a single route.
 */
function buildVisionPrompt(route: string, screenshotPaths: string[]): string {
	return `Review these screenshots of the generated website at route "${route}".
	Screenshot files:
	${screenshotPaths.join("\n")}

	Use the Read tool to view each screenshot, then evaluate the visual quality.
	Check for: layout alignment, spacing consistency, typography rendering, color accuracy, and overall polish.

	Respond with:
	VERDICT: PASS
	or
	VERDICT: REJECT
	REJECTION CONTEXT: <specific issues found>`;
}

/**
 * Run vision review for a single route — take screenshots, move to evidence dir,
 * send to AI, return the review.
 */
async function reviewVisionRoute(
	page: import("@playwright/test").Page,
	route: string,
	evPath: string,
	opts: ReviewerOpts,
	ctx: import("../engine/types.js").StepContext,
): Promise<Review> {
	const screenshots = await screenshotAtViewports(
		page,
		route,
		undefined,
		evPath,
		opts.colorScheme,
	);

	const screenshotPaths = screenshots.map((s) => s.path);

	const prompt = buildVisionPrompt(route, screenshotPaths);

	try {
		const output = await agentQuery({
			prompt,
			cwd: ctx.workdir,
			profile: ctx.profile,
			stepName: `vision-review/${opts.id}/${route}`,
			logger: ctx.logger,
			maxTurns: 1,
			config: ctx.config,
		});

		const verdict = parseReviewerVerdict(output);

		// Write review evidence
		const revPath = reviewPath(ctx.workdir, ctx.iteration);
		await mkdir(revPath, { recursive: true });
		// Use a clean filename for color vision reviews per D3
		const reviewFilename = opts.id.includes("color-vision")
			? "color-vision-review.md"
			: `vision-${opts.id}-${route.replace(/\//g, "-")}.md`;
		await writeFile(join(revPath, reviewFilename), output);

		return {
			reviewerId: opts.id,
			verdict: verdict.verdict,
			findings: `Viewport: ${route} — ${screenshots.map((s) => s.viewport).join(", ")}`,
			rejectionContext: verdict.rejectionContext,
		};
	} catch (error) {
		return {
			reviewerId: opts.id,
			verdict: "reject",
			findings: `Vision review failed: ${error instanceof Error ? error.message : String(error)}`,
			rejectionContext: `AI vision review crashed for route ${route}`,
		};
	}
}

/**
 * Vision reviewer — takes screenshots and sends them to a vision AI for assessment.
 * Uses agentQuery to have the AI read and review each screenshot file.
 */
export function visionReviewer(opts: ReviewerOpts): StepDef {
	const run = async (
		ctx: import("../engine/types.js").StepContext,
	): Promise<StepResult> => {
		const start = Date.now();
		const cwd = resolveReviewerCwd(ctx.workdir, opts.projectDir);

		// Start dev server if projectDir is set
		let server: DevServerEntry | undefined;
		if (opts.projectDir) {
			try {
				server = await startDevServer(cwd);
			} catch (err) {
				return {
					status: "reject",
					reviews: [
						{
							reviewerId: opts.id,
							verdict: "reject",
							findings: `Dev server failed to start: ${String(err)}`,
							rejectionContext: `Dev server startup failed in ${cwd}`,
						},
					],
					duration: Date.now() - start,
				};
			}
		}

		const baseUrl = server?.baseUrl ?? opts.baseUrl ?? "http://localhost:4321";

		try {
			return await runVisionChecks(opts, ctx, baseUrl, start);
		} finally {
			if (server) stopDevServer(server);
		}
	};

	return {
		id: opts.id,
		name: opts.name,
		description: opts.description,
		type: "reviewer",
		profileKey: opts.profileKey,
		run,
	};
}

/**
 * Group routes by page-type prefix and keep at most `maxPerType` per group.
 *
 * Routes are grouped by their first path segment:
 *   /blog/post-1, /blog/post-2 → group "blog"
 *   /about                   → group "about"
 *   /                        → group "/"  (always included)
 *
 * This ensures vision reviewers sample across page types rather than
 * burning LLM calls on 20 blog posts that share the same template.
 */
function sampleRoutesByType(routes: string[], maxPerType: number): string[] {
	if (maxPerType <= 0 || maxPerType >= Infinity) return routes;

	const groups = new Map<string, string[]>();
	for (const route of routes) {
		// "/" is its own group — always include it
		if (route === "/") {
			groups.set("/", ["/"]);
			continue;
		}
		// Group by first path segment: /blog/post-1 → "blog"
		const key = route.split("/").filter(Boolean)[0] ?? route;
		const group = groups.get(key) ?? [];
		if (group.length < maxPerType) group.push(route);
		groups.set(key, group);
	}

	return [...groups.values()].flat();
}

async function runVisionChecks(
	opts: ReviewerOpts,
	ctx: import("../engine/types.js").StepContext,
	baseUrl: string,
	start: number,
): Promise<StepResult> {
	const browser = await launchBrowser();
	const context = await browser.newContext({ baseURL: baseUrl });
	const page = await context.newPage();

	let routes = opts.discoverRoutes
		? await discoverRoutesFromPages(
				resolveReviewerCwd(ctx.workdir, opts.projectDir),
			)
		: (opts.routes ?? ["/"]);

	if (opts.maxRoutesPerType != null) {
		routes = sampleRoutesByType(routes, opts.maxRoutesPerType);
	}

	const reviews: Review[] = [];
	const evBase = evidencePath(ctx.workdir, ctx.iteration);

	const captureBothModes = opts.colorScheme === "dark";

	// Light mode screenshots
	const lightDir = captureBothModes
		? join(evBase, "screenshots", "light")
		: evBase;
	await mkdir(lightDir, { recursive: true });
	await page.emulateMedia({ colorScheme: "light" });
	for (const route of routes) {
		const review = await reviewVisionRoute(
			page,
			route,
			lightDir,
			{ ...opts, colorScheme: "light" },
			ctx,
		);
		reviews.push(review);
	}

	// Dark mode screenshots (if requested)
	if (captureBothModes) {
		const darkDir = join(evBase, "screenshots", "dark");
		await mkdir(darkDir, { recursive: true });
		await page.emulateMedia({ colorScheme: "dark" });
		for (const route of routes) {
			const review = await reviewVisionRoute(
				page,
				route,
				darkDir,
				{ ...opts, colorScheme: "dark" },
				ctx,
			);
			reviews.push(review);
		}

		// Light-vs-dark comparison review (Step 4d requirement)
		await writeComparisonReview(routes, lightDir, darkDir, opts, ctx);
	}

	await browser.close();
	const duration = Date.now() - start;
	const result = aggregateReviewerVerdicts(reviews);
	result.duration = duration;
	return result;
}

/**
 * Write a light-vs-dark comparison review (Step 4d requirement).
 * Sends both light and dark screenshots to the vision AI for comparison.
 */
async function writeComparisonReview(
	routes: string[],
	lightDir: string,
	darkDir: string,
	opts: ReviewerOpts,
	ctx: import("../engine/types.js").StepContext,
): Promise<void> {
	const revDir = reviewPath(ctx.workdir, ctx.iteration);
	await mkdir(revDir, { recursive: true });

	const routeList = routes.length > 0 ? routes.join(", ") : "/";
	const prompt = `Compare the light and dark mode screenshots for routes: ${routeList}.

Light mode screenshots: ${lightDir}/
Dark mode screenshots: ${darkDir}/

Use the Read tool to view each screenshot, then evaluate:
1. Color coherence between light and dark modes
2. Text readability in both modes
3. No invisible elements or missing contrast in either mode
4. Dark mode toggle visual indicator is present

Respond with:
VERDICT: PASS
or
VERDICT: REJECT
	REJECTION CONTEXT: <specific issues found>`;

	try {
		const output = await agentQuery({
			prompt,
			cwd: ctx.workdir,
			profile: ctx.profile,
			stepName: `color-vision-comparison/${opts.id}`,
			logger: ctx.logger,
			maxTurns: 1,
			config: ctx.config,
		});

		await writeFile(join(revDir, "color-vision-review.md"), output);
	} catch {
		// Comparison review failure is non-blocking
	}
}

/**
 * Content reviewer — validates content completeness, semantic correctness,
 * and that all source content is properly represented in generated pages.
 *
 * Reads source-of-truth data (structure.json, content.json, registry.json,
 * content-model.json) from the workdir AND generated files from projectDir
 * so the reviewer can compare generated output against the source inventory.
 */
export function contentReviewer(opts: ReviewerOpts): StepDef {
	const run = async (
		ctx: import("../engine/types.js").StepContext,
	): Promise<StepResult> => {
		const start = Date.now();
		const cwd = resolveReviewerCwd(ctx.workdir, opts.projectDir);

		// Read source-of-truth data from the base workdir
		const sourceFiles = [
			"structure.json",
			"content.json",
			"reduced-meta.json",
			"registry.json",
			"content-model.json",
		];
		const sourceContents: string[] = [];
		for (const fileName of sourceFiles) {
			try {
				const raw = await readFile(join(ctx.workdir, fileName), "utf-8");
				// Truncate large source files to keep prompt manageable
				sourceContents.push(
					`--- SOURCE: ${fileName} ---\n${raw.slice(0, 5000)}`,
				);
			} catch {
				// Source file may not exist in all contexts
			}
		}

		let fileList = "";
		try {
			fileList = execSync(
				"find src -name '*.astro' -o -name '*.ts' -o -name '*.json' -o -name '*.md' | head -30",
				{
					cwd,
					encoding: "utf-8",
					timeout: 30_000,
				},
			);
		} catch {
			fileList = "";
		}

		const files = fileList.split("\n").filter(Boolean);
		const fileContents: string[] = [];
		for (const file of files.slice(0, 15)) {
			try {
				const content = await readFile(join(cwd, file), "utf-8");
				fileContents.push(
					`--- GENERATED: ${file} ---\n${content.slice(0, 3000)}`,
				);
			} catch {
				// skip unreadable files
			}
		}

		const output = await agentQuery({
			prompt: `You are a content completeness reviewer. Compare the SOURCE data (scraper output, registry, content model) against the GENERATED wireframe files to verify all source content is properly represented.

SOURCE DATA (ground truth — the original scraped content and classification):
${sourceContents.join("\n\n")}

GENERATED FILES (the wireframe output to validate):
${fileContents.join("\n\n")}

Check by comparing source against generated:
1. Every page type from structure.json has corresponding route files in the generated project
2. Content collections contain entries for all pages listed in content.json
3. Registry collections and listings are all represented by generated routes
4. Navigation links are correct and complete
5. Static pages have their content properly rendered
6. No placeholder or lorem ipsum text remains where real content should be
7. All semantic data fields from the source are populated in the generated files

Respond with VERDICT: PASS or VERDICT: REJECT followed by findings.`,
			cwd,
			profile: ctx.profile,
			stepName: `content-review/${opts.id}`,
			logger: ctx.logger,
			maxTurns: 1,
			config: ctx.config,
		});

		// Write review
		const revPath = reviewPath(ctx.workdir, ctx.iteration);
		await mkdir(revPath, { recursive: true });
		await writeFile(join(revPath, `content-${opts.id}.md`), output);

		const verdict = parseReviewerVerdict(output);
		const duration = Date.now() - start;

		return {
			status: verdict.verdict === "pass" ? "pass" : "reject",
			reviews: [
				{
					reviewerId: opts.id,
					verdict: verdict.verdict,
					findings: verdict.findings,
					rejectionContext: verdict.rejectionContext,
				},
			],
			duration,
		};
	};

	return {
		id: opts.id,
		name: opts.name,
		description: opts.description,
		type: "reviewer",
		profileKey: opts.profileKey,
		run,
	};
}

/**
 * Trace reviewer — reads generated files and sends them to an AI for analysis.
 */
export function traceReviewer(opts: ReviewerOpts): StepDef {
	const run = async (
		ctx: import("../engine/types.js").StepContext,
	): Promise<StepResult> => {
		const start = Date.now();
		const cwd = resolveReviewerCwd(ctx.workdir, opts.projectDir);

		let fileList = "";
		try {
			fileList = execSync(
				"find src -name '*.astro' -o -name '*.ts' -o -name '*.css'",
				{
					cwd,
					encoding: "utf-8",
					timeout: 30_000,
				},
			);
		} catch {
			fileList = "";
		}

		const files = fileList.split("\n").filter(Boolean);
		const fileContents: string[] = [];
		for (const file of files.slice(0, 20)) {
			try {
				const content = await readFile(join(cwd, file), "utf-8");
				fileContents.push(`--- ${file} ---\n${content.slice(0, 5000)}`);
			} catch {
				// skip unreadable files
			}
		}

		const output = await agentQuery({
			prompt: `Review these generated files for quality issues:\n\n${fileContents.join("\n\n")}\n\nRespond with VERDICT: PASS or VERDICT: REJECT followed by findings.`,
			cwd,
			profile: ctx.profile,
			stepName: `trace-review/${opts.id}`,
			logger: ctx.logger,
			maxTurns: 1,
			config: ctx.config,
		});

		// Write review
		const revPath = reviewPath(ctx.workdir, ctx.iteration);
		await mkdir(revPath, { recursive: true });
		await writeFile(join(revPath, `${opts.id}.md`), output);

		const verdict = parseReviewerVerdict(output);
		const duration = Date.now() - start;

		return {
			status: verdict.verdict === "pass" ? "pass" : "reject",
			reviews: [
				{
					reviewerId: opts.id,
					verdict: verdict.verdict,
					findings: verdict.findings,
					rejectionContext: verdict.rejectionContext,
				},
			],
			duration,
		};
	};

	return {
		id: opts.id,
		name: opts.name,
		description: opts.description,
		type: "reviewer",
		profileKey: opts.profileKey,
		run,
	};
}

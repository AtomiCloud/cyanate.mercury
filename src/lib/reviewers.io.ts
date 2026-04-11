/**
 * Reviewer IO shell — factory functions that create StepDef objects for
 * common reviewer types: static checks, console errors, vision, and trace.
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
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
}

/** Resolve the effective CWD for reviewer operations. */
function resolveReviewerCwd(workdir: string, projectDir?: string): string {
	return projectDir ? join(workdir, projectDir) : workdir;
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

	const routes = opts.routes ?? ["/"];
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
		await writeFile(
			join(revPath, `vision-${opts.id}-${route.replace(/\//g, "-")}.md`),
			output,
		);

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

async function runVisionChecks(
	opts: ReviewerOpts,
	ctx: import("../engine/types.js").StepContext,
	baseUrl: string,
	start: number,
): Promise<StepResult> {
	const browser = await launchBrowser();
	const context = await browser.newContext({ baseURL: baseUrl });
	const page = await context.newPage();

	const routes = opts.routes ?? ["/"];
	const reviews: Review[] = [];
	const evPath = evidencePath(ctx.workdir, ctx.iteration);
	await mkdir(evPath, { recursive: true });

	for (const route of routes) {
		const review = await reviewVisionRoute(page, route, evPath, opts, ctx);
		reviews.push(review);
	}

	await browser.close();
	const duration = Date.now() - start;
	const result = aggregateReviewerVerdicts(reviews);
	result.duration = duration;
	return result;
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

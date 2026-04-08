/**
 * Reviewer IO shell — factory functions that create StepDef objects for
 * common reviewer types: static checks, console errors, vision, and trace.
 */

import { execSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

		// Run bun run check (required)
		const checkResult = runCommand("bun run check", ctx.workdir);
		if (checkResult) errors.push(`bun run check failed:\n${checkResult}`);

		// Run optional commands
		for (const [cmd, label] of [
			["bunx astro build", "astro build"],
			["lychee . --no-progress --format json", "lychee link check"],
		] as const) {
			const err = collectOptionalCommandError(cmd, ctx.workdir, label);
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
		const browser = await launchBrowser();
		const context = await browser.newContext({
			baseURL: opts.baseUrl,
		});
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

		// Write evidence
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
		const browser = await launchBrowser();
		const context = await browser.newContext({
			baseURL: opts.baseUrl,
		});
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

		let fileList = "";
		try {
			fileList = execSync(
				"find src -name '*.astro' -o -name '*.ts' -o -name '*.css'",
				{
					cwd: ctx.workdir,
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
				const content = await readFile(join(ctx.workdir, file), "utf-8");
				fileContents.push(`--- ${file} ---\n${content.slice(0, 5000)}`);
			} catch {
				// skip unreadable files
			}
		}

		const output = await agentQuery({
			prompt: `Review these generated files for quality issues:\n\n${fileContents.join("\n\n")}\n\nRespond with VERDICT: PASS or VERDICT: REJECT followed by findings.`,
			cwd: ctx.workdir,
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

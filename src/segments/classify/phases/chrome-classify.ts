/**
 * Phase 2 — `chrome-classify`
 *
 * Two steps:
 *   1. `chrome-classify` (agent fan-out)
 *        - Discover every `classify-input/<pagetype>/<hash>/content.json`.
 *        - For each page, loop classify → validate → review (≤2 retries).
 *          Classifier and reviewer use distinct profiles
 *          (`classify.chrome-classify.chrome-classify-agent` and
 *          `classify.chrome-classify.chrome-classify-reviewer`).
 *        - Persist each attempt under `<pageDir>/attempts/<N>/` with
 *          classify.prompt.txt, classify.response.txt, and (on reach)
 *          review.prompt.txt + review.response.txt + review.verdict.txt.
 *        - On pass, promote the winning artifacts to `<pageDir>/output/`:
 *          chrome-classify.json + meta.json.
 *        - Sum turns/tokens/cost across every sub-call and return them on the
 *          single StepResult so the engine records one accurate metric row.
 *
 *   2. `chrome-split` (programmatic)
 *        - Read each page's `content.json` and accepted
 *          `output/chrome-classify.json`.
 *        - Split programmatically into `output/chrome.json` +
 *          `output/body.json`. This is the partition later stages consume.
 *
 * Per-page retry keeps successful pages intact when others fail. Phase-level
 * retry kicks in only if any page exhausts its per-page budget.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveProfile } from "../../../engine/profile.js";
import type {
	PhaseDef,
	Review,
	StepContext,
	StepResult,
} from "../../../engine/types.js";
import { agentQueryWithMetrics } from "../../../lib/agent.js";
import { agentFanOutStep, programmaticStep } from "../../../steps/step.js";
import {
	type AgentCallTotals,
	type AttemptHooks,
	classifyOnePage,
	type PageClassifyInput,
	type PageClassifyResult,
	type RunAgentFn,
} from "../lib/chrome-classify.js";
import { splitByChromePaths } from "../lib/chrome-split.js";

const MAX_PER_PAGE_RETRIES = 5;

interface DiscoveredPage extends PageClassifyInput {
	hash: string;
	pageDir: string;
}

export const chromeClassifyPhase: PhaseDef = {
	id: "chrome-classify",
	name: "Chrome classify",
	description:
		"Per-page chrome classify with inline reviewer, then programmatic split into chrome.json + body.json.",
	maxRetries: 0,
	steps: [
		agentFanOutStep({
			id: "chrome-classify",
			name: "Chrome classify (fan-out)",
			description:
				"One classify→review loop per page; parallel across pages, retries per page without redoing passes.",
			profileKey: "chrome-classify-agent",
			run: runChromeClassify,
		}),
		programmaticStep({
			id: "chrome-split",
			name: "Chrome split",
			description:
				"Split each page's content.json into chrome.json + body.json using the accepted chrome-classify paths.",
			run: runChromeSplit,
		}),
	],
};

// ---------------------------------------------------------------------------
// Step 1 — chrome-classify (agent fan-out)
// ---------------------------------------------------------------------------

async function runChromeClassify(ctx: StepContext): Promise<StepResult> {
	const start = Date.now();
	const totals: AgentCallTotals = {
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
	};

	let pages: DiscoveredPage[];
	try {
		pages = await discoverPages(ctx.workdir);
	} catch (err) {
		return {
			status: "fail",
			error: `chrome-classify discovery failed: ${String(err)}`,
			duration: Date.now() - start,
		};
	}
	if (pages.length === 0) {
		return {
			status: "fail",
			error:
				"chrome-classify: no pages found under classify-input/*/*/content.json",
			duration: Date.now() - start,
		};
	}

	const reviewerProfile = resolveProfile(
		ctx.config,
		"classify",
		"chrome-classify",
		"chrome-classify-reviewer",
	);

	const pageResults = await Promise.all(
		pages.map((page) => processPage(page, ctx, reviewerProfile, totals)),
	);

	const failures = pageResults.filter((r) => r.status === "fail");
	const duration = Date.now() - start;
	const metrics = {
		turns: totals.turns,
		inputTokens: totals.inputTokens,
		outputTokens: totals.outputTokens,
		cost: totals.cost,
	};

	if (failures.length > 0) {
		const reviews: Review[] = failures.map((f) => ({
			reviewerId: `chrome-classify/${f.pagetype}/${f.hash}`,
			verdict: "reject",
			findings:
				f.lastRejection ?? "Exhausted per-page retries without passing review",
			rejectionContext: `${f.pagetype}/${f.hash}: ${f.lastRejection ?? "failed review"}`,
		}));
		return {
			status: "reject",
			reviews,
			duration,
			...metrics,
		};
	}

	return { status: "pass", duration, ...metrics };
}

interface PageOutcome {
	pagetype: string;
	hash: string;
	status: "pass" | "fail";
	lastRejection?: string;
}

async function processPage(
	page: DiscoveredPage,
	ctx: StepContext,
	reviewerProfile: ReturnType<typeof resolveProfile>,
	totals: AgentCallTotals,
): Promise<PageOutcome> {
	const runAgent: RunAgentFn = async ({ prompt, role, attempt }) => {
		const profile = role === "review" ? reviewerProfile : ctx.profile;
		const stepName = `classify/chrome-classify/${role}[${page.pagetype}/${page.hash}]#${attempt}`;
		const call = await agentQueryWithMetrics({
			prompt,
			cwd: ctx.workdir,
			profile,
			stepName,
			logger: ctx.logger,
			maxTurns: profile.maxTurns,
			config: ctx.config,
		});
		return call;
	};

	// Clear any previous run's attempts/output (phase retries start clean).
	await rm(join(page.pageDir, "attempts"), { recursive: true, force: true });
	await rm(join(page.pageDir, "output"), { recursive: true, force: true });

	const hooks = makeAttemptWriter(page.pageDir);

	const result = await classifyOnePage({
		page,
		runAgent,
		maxRetries: MAX_PER_PAGE_RETRIES,
		hooks,
	});

	totals.turns += result.totals.turns;
	totals.inputTokens += result.totals.inputTokens;
	totals.outputTokens += result.totals.outputTokens;
	totals.cost += result.totals.cost;

	if (result.status === "pass" && result.output) {
		await writeAcceptedOutput(page, result);
	}

	return {
		pagetype: page.pagetype,
		hash: page.hash,
		status: result.status,
		lastRejection: result.lastRejection,
	};
}

/**
 * Build an AttemptHooks implementation that streams each artifact to
 * `<pageDir>/attempts/<N>/` the moment it exists:
 *   - prompt is written BEFORE the agent call (visible while the call runs)
 *   - response + parsed/error are written AFTER the agent call returns
 *   - review prompt/response/verdict/findings same pattern
 *
 * This gives live observability for long-running per-page loops: a folder
 * appears per attempt as soon as the prompt is built, and each file lands as
 * soon as its content exists.
 */
function makeAttemptWriter(pageDir: string): AttemptHooks {
	const dirFor = (attempt: number) =>
		join(pageDir, "attempts", String(attempt));

	return {
		beforeClassifyCall: async (attempt, prompt) => {
			const dir = dirFor(attempt);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "classify.prompt.txt"), prompt);
		},
		afterClassifyCall: async (attempt, record) => {
			const dir = dirFor(attempt);
			await writeFile(join(dir, "classify.response.txt"), record.response);
			if (record.parsed) {
				await writeFile(
					join(dir, "classify.parsed.json"),
					JSON.stringify(record.parsed, null, 2),
				);
			}
			if (record.error) {
				await writeFile(join(dir, "classify.error.txt"), record.error);
			}
		},
		beforeReviewCall: async (attempt, prompt) => {
			const dir = dirFor(attempt);
			await writeFile(join(dir, "review.prompt.txt"), prompt);
		},
		afterReviewCall: async (attempt, record) => {
			const dir = dirFor(attempt);
			await writeFile(join(dir, "review.response.txt"), record.response);
			await writeFile(join(dir, "review.verdict.txt"), record.verdict);
			if (record.findings) {
				await writeFile(join(dir, "review.findings.txt"), record.findings);
			}
		},
	};
}

async function writeAcceptedOutput(
	page: DiscoveredPage,
	result: PageClassifyResult,
): Promise<void> {
	const outDir = join(page.pageDir, "output");
	await mkdir(outDir, { recursive: true });

	if (result.output) {
		await writeFile(
			join(outDir, "chrome-classify.json"),
			JSON.stringify(result.output, null, 2),
		);
	}

	const winningAttempt = result.attempts.at(-1);
	const meta = {
		pagetype: page.pagetype,
		url: page.url,
		status: result.status,
		attemptCount: result.attempts.length,
		winningAttempt: winningAttempt?.attempt ?? null,
		totals: result.totals,
	};
	await writeFile(join(outDir, "meta.json"), JSON.stringify(meta, null, 2));
}

// ---------------------------------------------------------------------------
// Step 2 — chrome-split (programmatic)
// ---------------------------------------------------------------------------

async function runChromeSplit(ctx: StepContext): Promise<StepResult> {
	const start = Date.now();
	const root = join(ctx.workdir, "classify-input");
	const pageTypes = await safeReaddir(root);

	let processed = 0;
	const failures: string[] = [];

	for (const pagetype of pageTypes) {
		const ptDir = join(root, pagetype);
		const hashes = await safeReaddir(ptDir);
		for (const hash of hashes) {
			const pageDir = join(ptDir, hash);
			try {
				await splitOnePage(pageDir);
				processed++;
			} catch (err) {
				failures.push(`${pagetype}/${hash}: ${String(err)}`);
			}
		}
	}

	const duration = Date.now() - start;
	if (failures.length > 0) {
		return {
			status: "fail",
			error: `chrome-split failed on ${failures.length} page(s):\n${failures.join("\n")}`,
			duration,
		};
	}
	if (processed === 0) {
		return {
			status: "fail",
			error: "chrome-split: no pages with output/chrome-classify.json found",
			duration,
		};
	}
	return { status: "pass", duration };
}

async function splitOnePage(pageDir: string): Promise<void> {
	const contentRaw = await readFile(join(pageDir, "content.json"), "utf-8");
	const { content } = JSON.parse(contentRaw) as { content: unknown };

	const classifyRaw = await readFile(
		join(pageDir, "output", "chrome-classify.json"),
		"utf-8",
	);
	const classify = JSON.parse(classifyRaw) as {
		chromePaths: Array<{ sourcePath: string }>;
	};
	const chromePaths = classify.chromePaths.map((e) => e.sourcePath);

	const { chrome, body } = splitByChromePaths(content, chromePaths);

	const outDir = join(pageDir, "output");
	await writeFile(join(outDir, "chrome.json"), JSON.stringify(chrome, null, 2));
	await writeFile(join(outDir, "body.json"), JSON.stringify(body, null, 2));
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function discoverPages(workdir: string): Promise<DiscoveredPage[]> {
	const root = join(workdir, "classify-input");
	const pageTypes = await safeReaddir(root);
	const out: DiscoveredPage[] = [];
	for (const pagetype of pageTypes) {
		const ptDir = join(root, pagetype);
		const hashes = await safeReaddir(ptDir);
		for (const hash of hashes) {
			const pageDir = join(ptDir, hash);
			const contentPath = join(pageDir, "content.json");
			const raw = await readFile(contentPath, "utf-8");
			const parsed = JSON.parse(raw) as {
				url: string;
				pagetype: string;
				content: unknown;
			};
			out.push({
				hash,
				pageDir,
				pagetype: parsed.pagetype,
				url: parsed.url,
				content: parsed.content,
			});
		}
	}
	return out;
}

async function safeReaddir(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

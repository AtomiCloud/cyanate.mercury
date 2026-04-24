/**
 * Phase 3 — `chrome-shape-normalize`
 *
 * Per-page agent fan-out that reads the single chrome-only prompt artifact
 * `output/chrome-shape-input.json` and emits a shape-normalized chrome view
 * for later harmonize phases.
 *
 * The phase preserves the exact `sourcePath` set from chrome-classify and
 * only adjusts `suggestedCanonical`, then writes:
 *   - `output/shape-normalized-chrome.json`
 *   - `output/shape-normalized-chrome.materialized.json`
 *   - `output/shape-normalized-chrome.provenance.json`
 *   - `output/shape-ops.json` (flat `ShapeNormalizeOp[]` accepted by the page)
 *   - `output/shape-meta.json`
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
import { agentFanOutStep } from "../../../steps/step.js";
import type {
	AgentCallTotals,
	ClassifierOutput,
	PageClassifyInput,
	RunAgentFn,
} from "../lib/chrome-classify.js";
import { materializeShapeNormalizedChrome } from "../lib/chrome-shape-materialize.js";
import {
	type PageShapeNormalizeResult,
	type ShapeNormalizeAttemptHooks,
	type ShapeNormalizePassId,
	shapeNormalizeOnePage,
} from "../lib/chrome-shape-normalize.js";
import { extractChromeByPaths } from "../lib/chrome-split.js";

const MAX_PER_PAGE_SHAPE_RETRIES = 3;
// Temporary token-saving gate while debugging shape normalization.
// Set to `null` to process every pagetype again.
const SHAPE_NORMALIZE_ALLOWED_PAGETYPES: readonly string[] | null = [
	"blog_post",
	"team_member",
	"service",
];
const SHAPE_NORMALIZE_MAX_PAGES_PER_PAGETYPE = 1;
// Temporary token-saving gate while debugging topology normalization.
// Set to `null` to run every shape-normalize pass again.
const SHAPE_NORMALIZE_ALLOWED_PASS_IDS: readonly ShapeNormalizePassId[] | null =
	null;

interface DiscoveredPage extends PageClassifyInput {
	hash: string;
	pageDir: string;
	chrome: unknown;
	classifyOutput: ClassifierOutput;
}

interface PageOutcome {
	pagetype: string;
	hash: string;
	status: "pass" | "fail";
	lastRejection?: string;
}

export const chromeShapeNormalizePhase: PhaseDef = {
	id: "chrome-shape-normalize",
	name: "Chrome shape normalize",
	description:
		"Per-page shape normalization after chrome split; preserves raw sourcePaths and writes shape-normalized canonicals for harmonize.",
	maxRetries: 0,
	steps: [
		agentFanOutStep({
			id: "chrome-shape-normalize",
			name: "Chrome shape normalize (fan-out)",
			description:
				"One shape-normalize→review→fixer→review loop per page; parallel across pages with bounded retries.",
			profileKey: "chrome-shape-normalize-agent",
			run: runChromeShapeNormalize,
		}),
	],
};

async function runChromeShapeNormalize(ctx: StepContext): Promise<StepResult> {
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
			error: `chrome-shape-normalize discovery failed: ${String(err)}`,
			duration: Date.now() - start,
		};
	}
	if (pages.length === 0) {
		ctx.logger.note(
			"chrome-shape-normalize: no pages matched the progressive rollout gate; skipping",
		);
		return {
			status: "pass",
			duration: Date.now() - start,
		};
	}

	const reviewerProfile = resolveProfile(
		ctx.config,
		"classify",
		"chrome-shape-normalize",
		"chrome-shape-normalize-reviewer",
	);

	const pageResults = await Promise.all(
		pages.map(async (page) => {
			try {
				return await processPage(page, ctx, reviewerProfile, totals);
			} catch (err) {
				return {
					pagetype: page.pagetype,
					hash: page.hash,
					status: "fail",
					lastRejection: `Unhandled shape-normalize error: ${String(err)}`,
				} satisfies PageOutcome;
			}
		}),
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
			reviewerId: `chrome-shape-normalize/${f.pagetype}/${f.hash}`,
			verdict: "reject",
			findings: f.lastRejection ?? "Exhausted per-page shape-normalize retries",
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

async function processPage(
	page: DiscoveredPage,
	ctx: StepContext,
	reviewerProfile: ReturnType<typeof resolveProfile>,
	totals: AgentCallTotals,
): Promise<PageOutcome> {
	const runAgent: RunAgentFn = async ({ prompt, role, attempt, workdir }) => {
		const profile = role === "review" ? reviewerProfile : ctx.profile;
		const stepName = `classify/chrome-shape-normalize/${role}[${page.pagetype}/${page.hash}]#${attempt}`;
		return agentQueryWithMetrics({
			prompt,
			cwd: workdir ?? ctx.workdir,
			profile,
			stepName,
			logger: ctx.logger,
			maxTurns: Math.max(profile.maxTurns ?? 0, 80),
			config: ctx.config,
		});
	};

	await rm(join(page.pageDir, "shape-attempts"), {
		recursive: true,
		force: true,
	});
	await rm(join(page.pageDir, "output", "shape-normalized-chrome.json"), {
		force: true,
	});
	await rm(
		join(page.pageDir, "output", "shape-normalized-chrome.materialized.json"),
		{ force: true },
	);
	await rm(
		join(page.pageDir, "output", "shape-normalized-chrome.provenance.json"),
		{ force: true },
	);
	await rm(join(page.pageDir, "output", "shape-ops.json"), { force: true });
	await rm(join(page.pageDir, "output", "shape-meta.json"), { force: true });

	const result = await shapeNormalizeOnePage({
		page: {
			pagetype: page.pagetype,
			url: page.url,
			content: page.content,
			chrome: page.chrome,
			chromePaths: page.classifyOutput.chromePaths,
		},
		runAgent,
		opsWorkdir: join(page.pageDir, "shape-attempts"),
		maxRetries: MAX_PER_PAGE_SHAPE_RETRIES,
		passIds: SHAPE_NORMALIZE_ALLOWED_PASS_IDS,
		hooks: makeAttemptWriter(page.pageDir),
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

function makeAttemptWriter(pageDir: string): ShapeNormalizeAttemptHooks {
	const dirFor = (attempt: number) =>
		join(pageDir, "shape-attempts", String(attempt));

	return {
		beforeNormalizeCall: async (attempt, prompt) => {
			const dir = dirFor(attempt);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "shape-normalize.prompt.txt"), prompt);
		},
		afterNormalizeCall: async (attempt, record) => {
			const dir = dirFor(attempt);
			await writeFile(
				join(dir, "shape-normalize.response.txt"),
				record.response,
			);
			if (record.parsed) {
				await writeFile(
					join(dir, "shape-normalize.parsed.json"),
					JSON.stringify(record.parsed, null, 2),
				);
			}
			if (record.error) {
				await writeFile(join(dir, "shape-normalize.error.txt"), record.error);
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
		beforeFixCall: async (attempt, prompt) => {
			const dir = dirFor(attempt);
			await writeFile(join(dir, "fix.prompt.txt"), prompt);
		},
		afterFixCall: async (attempt, record) => {
			const dir = dirFor(attempt);
			await writeFile(join(dir, "fix.response.txt"), record.response);
			if (record.parsed) {
				await writeFile(
					join(dir, "fix.parsed.json"),
					JSON.stringify(record.parsed, null, 2),
				);
			}
			if (record.error) {
				await writeFile(join(dir, "fix.error.txt"), record.error);
			}
		},
		beforeFixReviewCall: async (attempt, prompt) => {
			const dir = dirFor(attempt);
			await writeFile(join(dir, "fix-review.prompt.txt"), prompt);
		},
		afterFixReviewCall: async (attempt, record) => {
			const dir = dirFor(attempt);
			await writeFile(join(dir, "fix-review.response.txt"), record.response);
			await writeFile(join(dir, "fix-review.verdict.txt"), record.verdict);
			if (record.findings) {
				await writeFile(join(dir, "fix-review.findings.txt"), record.findings);
			}
		},
	};
}

async function writeAcceptedOutput(
	page: DiscoveredPage,
	result: PageShapeNormalizeResult,
): Promise<void> {
	const outDir = join(page.pageDir, "output");
	await mkdir(outDir, { recursive: true });
	await writeFile(
		join(outDir, "shape-normalized-chrome.json"),
		JSON.stringify(result.output, null, 2),
	);
	await writeFile(
		join(outDir, "shape-ops.json"),
		JSON.stringify(result.ops, null, 2),
	);
	const materialized = materializeShapeNormalizedChrome(
		page.chrome,
		result.output?.chromePaths ?? [],
	);
	if (materialized.collisions.length === 0) {
		await writeFile(
			join(outDir, "shape-normalized-chrome.materialized.json"),
			JSON.stringify(materialized.chrome, null, 2),
		);
		await writeFile(
			join(outDir, "shape-normalized-chrome.provenance.json"),
			JSON.stringify(materialized.provenance, null, 2),
		);
	}
	const winningAttempt = result.attempts.at(-1);
	const meta = {
		pagetype: page.pagetype,
		url: page.url,
		status: result.status,
		attemptCount: result.attempts.length,
		winningAttempt: winningAttempt?.attempt ?? null,
		shapeOpPlanCount: result.ops.length,
		materialized: {
			wroteFiles: materialized.collisions.length === 0,
			collisionCount: materialized.collisions.length,
			collisions: materialized.collisions,
		},
		totals: result.totals,
	};
	await writeFile(
		join(outDir, "shape-meta.json"),
		JSON.stringify(meta, null, 2),
	);
}

async function discoverPages(workdir: string): Promise<DiscoveredPage[]> {
	const root = join(workdir, "classify-input");
	const pageTypes = (await safeReaddir(root)).sort();
	const out: DiscoveredPage[] = [];
	for (const pagetype of pageTypes) {
		if (
			SHAPE_NORMALIZE_ALLOWED_PAGETYPES !== null &&
			!SHAPE_NORMALIZE_ALLOWED_PAGETYPES.includes(pagetype)
		) {
			continue;
		}

		const ptDir = join(root, pagetype);
		const hashes = (await safeReaddir(ptDir)).sort();
		let acceptedForPagetype = 0;
		for (const hash of hashes) {
			if (acceptedForPagetype >= SHAPE_NORMALIZE_MAX_PAGES_PER_PAGETYPE) {
				break;
			}
			const pageDir = join(ptDir, hash);
			try {
				const contentRaw = await readFile(
					join(pageDir, "content.json"),
					"utf-8",
				);
				const parsed = JSON.parse(contentRaw) as {
					url: string;
					pagetype: string;
					content: unknown;
				};
				const classifyRaw = await readFile(
					join(pageDir, "output", "chrome-classify.json"),
					"utf-8",
				);
				const classifyOutput = JSON.parse(classifyRaw) as ClassifierOutput;
				const chrome = extractChromeByPaths(
					parsed.content,
					classifyOutput.chromePaths.map((entry) => entry.sourcePath),
					{ compactArrays: false },
				);
				out.push({
					hash,
					pageDir,
					pagetype: parsed.pagetype,
					url: parsed.url,
					content: chrome,
					chrome,
					classifyOutput,
				});
				acceptedForPagetype++;
				continue;
			} catch {
				// Fall back to the serialized chrome-only prompt artifact for
				// legacy runs that do not have the recomputed source artifacts.
			}

			try {
				const promptInputRaw = await readFile(
					join(pageDir, "output", "chrome-shape-input.json"),
					"utf-8",
				);
				const promptInput = JSON.parse(promptInputRaw) as {
					url: string;
					pagetype: string;
					chrome: unknown;
					chromePaths: ClassifierOutput["chromePaths"];
				};
				out.push({
					hash,
					pageDir,
					pagetype: promptInput.pagetype,
					url: promptInput.url,
					content: promptInput.chrome,
					chrome: promptInput.chrome,
					classifyOutput: { chromePaths: promptInput.chromePaths },
				});
				acceptedForPagetype++;
			} catch {
				// page has not passed chrome-classify/split
			}
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

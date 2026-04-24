/**
 * Domain-ops generator.
 *
 * Produces domain-specific ops (e.g. `RichRenameOp`, `ShapeNormalizeOp`) for a
 * single accepted intent. An LLM generator proposes ops; two independent
 * reviewers score the proposal; AND-consensus is required to accept.
 *
 * Separate from `intent-ops.ts` because this does NOT produce reversible JSON
 * diffs — the "ops" here are the domain objects consumed by downstream phases
 * (harmonize-align, shape-normalize), not patches applied against a document.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractJsonObject } from "../../../lib/json-extract.js";
import { Semaphore } from "../../../lib/semaphore.js";
import type { AgentCallTotals } from "./chrome-classify.js";
import {
	parseReviewerVerdict,
	type ReviewerFinding,
	type ReviewerVerdict,
} from "./intent-ops.js";

export type GenerateAgentRole = "generate" | "review-a" | "review-b";

export type GenerateRunAgentFn = (args: {
	prompt: string;
	role: GenerateAgentRole;
	attempt: number;
	workdir: string;
}) => Promise<{
	output: string;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}>;

export interface DomainDescriptor {
	name: string;
	opSchema: string;
	extraInstructions?: string;
}

export interface GenerateDomainOpsOptions {
	intent: string;
	domain: DomainDescriptor;
	runAgent: GenerateRunAgentFn;
	workdir: string;
	budget?: number;
}

export interface GenerateAttemptRecord {
	attempt: number;
	generator?: { prompt: string; response: string };
	parsed?: unknown[];
	parseError?: string;
	reviewers?: {
		a: { prompt: string; response: string; verdict: ReviewerVerdict };
		b: { prompt: string; response: string; verdict: ReviewerVerdict };
	};
}

export interface GenerateDomainOpsResult<TDomainOp> {
	ops: TDomainOp[];
	totals: AgentCallTotals;
	attempts: GenerateAttemptRecord[];
}

export interface GenerateDomainOpsBatchOptions<TIntent> {
	intents: readonly TIntent[];
	intentToText: (intent: TIntent, index: number) => string;
	domain: DomainDescriptor;
	runAgent: GenerateRunAgentFn;
	workdir: string;
	concurrency?: number;
	budget?: number;
}

export interface GenerateDomainOpsBatchResult<TIntent, TDomainOp> {
	ops: TDomainOp[];
	totals: AgentCallTotals;
	results: Array<{
		index: number;
		intent: TIntent;
		ops: TDomainOp[];
		attempts: GenerateAttemptRecord[];
	}>;
}

const DEFAULT_BUDGET = 3;
const DEFAULT_CONCURRENCY = 4;
const JSON_ONLY_PREAMBLE = `You are a JSON-only responder. Your ENTIRE response MUST be a single JSON
object parseable by JSON.parse. No prose before or after. No markdown fences.`;

export async function generateDomainOps<TDomainOp>(
	opts: GenerateDomainOpsOptions,
): Promise<GenerateDomainOpsResult<TDomainOp>> {
	const budget = opts.budget ?? DEFAULT_BUDGET;
	const totals = emptyTotals();
	const attempts: GenerateAttemptRecord[] = [];
	let rejectionContext: string | undefined;

	for (let attempt = 0; attempt < budget; attempt++) {
		const record: GenerateAttemptRecord = { attempt };
		attempts.push(record);
		const attemptDir = await prepareAttemptDir(opts.workdir, attempt);

		const generatorPrompt = buildGeneratorPrompt(
			opts.intent,
			opts.domain,
			rejectionContext,
		);
		await writeTextArtifact(
			attemptDir,
			"generator.prompt.txt",
			generatorPrompt,
		);
		const generatorCall = await opts.runAgent({
			prompt: generatorPrompt,
			role: "generate",
			attempt,
			workdir: attemptDir,
		});
		addTotals(totals, generatorCall);
		record.generator = {
			prompt: generatorPrompt,
			response: generatorCall.output,
		};
		await writeTextArtifact(
			attemptDir,
			"generator.response.txt",
			generatorCall.output,
		);

		const parsed = parseOpsDocument<TDomainOp>(generatorCall.output);
		if (!parsed.ok) {
			record.parseError = parsed.error;
			await writeTextArtifact(attemptDir, "error.txt", parsed.error);
			rejectionContext = `Generator output failed to parse: ${parsed.error}. Return ONLY a JSON object {"ops": [...]} matching the domain schema.`;
			continue;
		}
		record.parsed = parsed.ops as unknown[];
		await writeJsonArtifact(attemptDir, "ops.json", parsed.ops);

		const reviewerPrompt = buildReviewerPrompt(
			opts.intent,
			opts.domain,
			parsed.ops,
		);
		await writeTextArtifact(attemptDir, "reviewer.prompt.txt", reviewerPrompt);
		const [callA, callB] = await Promise.all([
			opts.runAgent({
				prompt: reviewerPrompt,
				role: "review-a",
				attempt,
				workdir: attemptDir,
			}),
			opts.runAgent({
				prompt: reviewerPrompt,
				role: "review-b",
				attempt,
				workdir: attemptDir,
			}),
		]);
		addTotals(totals, callA);
		addTotals(totals, callB);
		await writeTextArtifact(
			attemptDir,
			"reviewer-a.response.txt",
			callA.output,
		);
		await writeTextArtifact(
			attemptDir,
			"reviewer-b.response.txt",
			callB.output,
		);

		const verdictA = parseReviewerVerdict(callA.output);
		const verdictB = parseReviewerVerdict(callB.output);
		record.reviewers = {
			a: { prompt: reviewerPrompt, response: callA.output, verdict: verdictA },
			b: { prompt: reviewerPrompt, response: callB.output, verdict: verdictB },
		};

		if (verdictA.verdict === "pass" && verdictB.verdict === "pass") {
			return { ops: parsed.ops, totals, attempts };
		}
		rejectionContext = buildReviewerRejectionContext(verdictA, verdictB);
	}

	throw new Error(
		`generateDomainOps exhausted ${budget} attempts: ${rejectionContext ?? "no rejection context"}`,
	);
}

export async function generateDomainOpsBatch<TIntent, TDomainOp>(
	opts: GenerateDomainOpsBatchOptions<TIntent>,
): Promise<GenerateDomainOpsBatchResult<TIntent, TDomainOp>> {
	const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new Error(
			"generateDomainOpsBatch concurrency must be a positive integer",
		);
	}
	const semaphore = new Semaphore(concurrency);
	const jobs = opts.intents.map(async (intent, index) => {
		const release = await semaphore.acquire();
		try {
			const result = await generateDomainOps<TDomainOp>({
				intent: opts.intentToText(intent, index),
				domain: opts.domain,
				runAgent: opts.runAgent,
				workdir: join(opts.workdir, `intent-${index}`),
				budget: opts.budget,
			});
			return {
				index,
				intent,
				ops: result.ops,
				attempts: result.attempts,
				totals: result.totals,
			};
		} catch (err) {
			throw new Error(
				`intent ${index}: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			release();
		}
	});
	const settled = await Promise.all(jobs);
	const ordered = settled.sort((a, b) => a.index - b.index);
	const totals = emptyTotals();
	const ops: TDomainOp[] = [];
	for (const entry of ordered) {
		addTotals(totals, entry.totals);
		ops.push(...entry.ops);
	}
	return {
		ops,
		totals,
		results: ordered.map(({ index, intent, ops: entryOps, attempts }) => ({
			index,
			intent,
			ops: entryOps,
			attempts,
		})),
	};
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseOpsDocument<TDomainOp>(
	response: string,
): { ok: true; ops: TDomainOp[] } | { ok: false; error: string } {
	const parsed = extractJsonObject(response);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: "generator response was not a JSON object" };
	}
	const ops = (parsed as { ops?: unknown }).ops;
	if (!Array.isArray(ops)) {
		return {
			ok: false,
			error: `generator response missing "ops" array`,
		};
	}
	return { ok: true, ops: ops as TDomainOp[] };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildGeneratorPrompt(
	intent: string,
	domain: DomainDescriptor,
	rejectionContext?: string,
): string {
	const body = `${JSON_ONLY_PREAMBLE}

Generate the domain ops needed to accomplish the intent below.

Intent:
${intent}

Domain (${domain.name}) op schema:
${domain.opSchema}
${domain.extraInstructions ? `\nAdditional domain instructions:\n${domain.extraInstructions}\n` : ""}
Return exactly:
{"ops":[<one or more domain ops>]}`;
	if (!rejectionContext) return body;
	return `${body}

Previous attempt failed. Fix this exactly:
${rejectionContext}`;
}

function buildReviewerPrompt(
	intent: string,
	domain: DomainDescriptor,
	ops: unknown[],
): string {
	return `${JSON_ONLY_PREAMBLE}

Review the proposed ${domain.name} ops for this one accepted intent.

Intent:
${intent}

Domain op schema:
${domain.opSchema}
${domain.extraInstructions ? `\nAdditional domain instructions:\n${domain.extraInstructions}\n` : ""}
Proposed ops:
\`\`\`json
${JSON.stringify(ops, null, 2)}
\`\`\`

Check for:
- Ops that do not accomplish the intent.
- Hallucinated paths, fields, or values not present in or called for by the intent.
- Ops outside the scope of this single intent.
- Mismatches with the domain schema.

Enumerate concerns with a short path/location tag. Empty findings means accept.

Return exactly:
{"verdict":"pass","findings":[]}
or
{"verdict":"reject","findings":[{"path":"<short>","issue":"<short>"}, ...]}
`;
}

// ---------------------------------------------------------------------------
// Rejection context
// ---------------------------------------------------------------------------

function buildReviewerRejectionContext(
	a: ReviewerVerdict,
	b: ReviewerVerdict,
): string {
	const parts: string[] = [];
	if (a.verdict === "reject")
		parts.push(formatReviewerFindings("reviewer-a", a));
	if (b.verdict === "reject")
		parts.push(formatReviewerFindings("reviewer-b", b));
	if (parts.length === 0) {
		parts.push(
			"Reviewer disagreement. Tighten the ops to satisfy both reviewers.",
		);
	}
	return `Reviewer consensus failed.\n${parts.join("\n\n")}`;
}

function formatReviewerFindings(
	label: string,
	verdict: ReviewerVerdict,
): string {
	if (verdict.findings.length === 0) {
		return `${label}: rejected without findings`;
	}
	const lines = verdict.findings.map((f: ReviewerFinding) =>
		f.path ? `  - ${f.path}: ${f.issue}` : `  - ${f.issue}`,
	);
	return `${label} (${verdict.verdict}):\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Artifacts + bookkeeping
// ---------------------------------------------------------------------------

async function prepareAttemptDir(
	workdir: string,
	attempt: number,
): Promise<string> {
	const dir = join(workdir, `attempt-${attempt}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

async function writeTextArtifact(
	dir: string,
	name: string,
	value: string,
): Promise<void> {
	await writeFile(join(dir, name), value);
}

async function writeJsonArtifact(
	dir: string,
	name: string,
	value: unknown,
): Promise<void> {
	await writeTextArtifact(dir, name, `${JSON.stringify(value, null, 2)}\n`);
}

function emptyTotals(): AgentCallTotals {
	return { turns: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
}

function addTotals(totals: AgentCallTotals, call: AgentCallTotals): void {
	totals.turns += call.turns;
	totals.inputTokens += call.inputTokens;
	totals.outputTokens += call.outputTokens;
	totals.cost += call.cost;
}

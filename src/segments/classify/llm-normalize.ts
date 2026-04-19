/**
 * Batched per-leaf LLM normalization.
 *
 * Ambiguous leaves are chunked into batches of BATCH_SIZE and each batch is
 * sent to the Anthropic-compatible Messages endpoint as a single one-shot
 * call. On parse/validation failure, the batch retries up to MAX_BATCH_ATTEMPTS
 * times with the failed entries listed in a rejection preface. Token usage is
 * aggregated per batch and surfaced through the logger's Active pane.
 *
 * We bypass the Claude Agent SDK here because each call is a stateless
 * classification — no tools, no multi-turn reasoning, no subprocess needed.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CuiConfig, LLMProfile } from "../../engine/types.js";
import { callMessages } from "../../lib/anthropic-direct.js";
import { extractJsonArray } from "../../lib/json-extract.js";
import type { PipelineLogger, StepHandle } from "../../lib/logger.js";
import type { PreparedPage } from "../prepare/ingest.js";
import type { AmbiguousLeaf } from "./deterministic-normalize.js";
import { readPath } from "./lib/path-utils.js";
import {
	type NormalizationEntry,
	type NormType,
	VALID_NORM_TYPES,
} from "./per-page-classify.js";

const BATCH_SIZE = 10;
const MAX_BATCH_ATTEMPTS = 3;
const MAX_SIBLINGS = 3;

export interface LlmNormalizeOpts {
	page: PreparedPage;
	ambiguous: AmbiguousLeaf[];
	workdir: string;
	attemptDir: string;
	profile: LLMProfile;
	stepNameBase: string;
	logger?: PipelineLogger;
	config?: CuiConfig;
}

export interface LlmNormalizeResult {
	resolved: Record<string, NormalizationEntry>;
	failed: Array<{ path: string; reason: string }>;
	inputTokens: number;
	outputTokens: number;
}

// ---------------------------------------------------------------------------
// sibling collection — same as before, used to enrich batch entries
// ---------------------------------------------------------------------------

function parentPath(path: string): string {
	const lastDot = path.lastIndexOf(".");
	const lastBracket = path.lastIndexOf("[");
	const cut = Math.max(lastDot, lastBracket);
	return cut <= 0 ? "" : path.slice(0, cut);
}

function collectSiblings(
	content: Record<string, unknown>,
	leafPath: string,
): Array<{ path: string; value: unknown }> {
	const parent = parentPath(leafPath);
	const parentValue = parent === "" ? content : readPath(content, parent);
	if (!parentValue || typeof parentValue !== "object") return [];

	const siblings: Array<{ path: string; value: unknown }> = [];
	const entries = Array.isArray(parentValue)
		? parentValue.map((v, i) => [`[${i}]`, v] as const)
		: Object.entries(parentValue as Record<string, unknown>).map(
				([k, v]) => [`.${k}`, v] as const,
			);

	for (const [seg, value] of entries) {
		const siblingPath =
			parent === "" ? seg.replace(/^\./, "") : `${parent}${seg}`;
		if (siblingPath === leafPath) continue;
		if (
			value !== null &&
			typeof value === "object" &&
			Object.keys(value as object).length > 0
		) {
			continue;
		}
		siblings.push({ path: siblingPath, value });
		if (siblings.length >= MAX_SIBLINGS) break;
	}
	return siblings;
}

// ---------------------------------------------------------------------------
// prompt construction
// ---------------------------------------------------------------------------

function renderLeafBlock(
	leaf: AmbiguousLeaf,
	siblings: Array<{ path: string; value: unknown }>,
): string {
	const siblingText =
		siblings.length === 0
			? "  (none)"
			: siblings
					.map((s) => `  ${s.path} = ${JSON.stringify(s.value)}`)
					.join("\n");
	return `- path: ${leaf.path}
  value: ${JSON.stringify(leaf.original)}
  siblings:
${siblingText}`;
}

export function buildBatchPrompt(
	page: PreparedPage,
	leaves: AmbiguousLeaf[],
	content: Record<string, unknown>,
	rejectionContext?: string,
): string {
	const blocks = leaves
		.map((leaf) => renderLeafBlock(leaf, collectSiblings(content, leaf.path)))
		.join("\n");

	const rejection = rejectionContext
		? `\nPREVIOUS ATTEMPT REJECTED:\n${rejectionContext}\n`
		: "";

	return `You are typing field values for page "${page.url}" (pagetype: ${page.pagetype}).

Valid types: string | number | boolean | datetime | currency | string[] | null | object | array | unchanged

Rules (pick the most specific that applies):
- number: numeric value
- boolean: true/false
- datetime: ISO-8601 string (convert natural-language dates to "YYYY-MM-DDTHH:mm:ssZ")
- currency: number (strip symbol from things like "$49.99")
- string[]: array of strings when the value is a comma-joined list of distinct items (NOT a place like "Rochester, NY", NOT a sentence)
- null: null or undefined
- unchanged: plain string that needs no normalization

LEAVES (${leaves.length}):
${blocks}

OUTPUT: Reply with ONE JSON array, no prose, no code fences. One object per leaf, in the same order, each with the leaf's path verbatim:
[{"path": "<leaf-path>", "type": "<type>", "normalized": <value>}, ...]
${rejection}`;
}

// ---------------------------------------------------------------------------
// response parsing + validation
// ---------------------------------------------------------------------------

function validateEntry(
	entry: { type: unknown; normalized: unknown },
	original: unknown,
): NormalizationEntry | string {
	if (typeof entry.type !== "string") return "type is not a string";
	if (!VALID_NORM_TYPES.includes(entry.type as NormType)) {
		return `invalid type "${entry.type}"`;
	}
	const t = entry.type as NormType;

	if (
		(t === "number" || t === "currency") &&
		entry.normalized !== null &&
		typeof entry.normalized !== "number"
	) {
		return `type "${t}" requires numeric normalized, got ${typeof entry.normalized}`;
	}
	if (
		t === "boolean" &&
		entry.normalized !== null &&
		typeof entry.normalized !== "boolean"
	) {
		return `type "boolean" requires boolean normalized, got ${typeof entry.normalized}`;
	}
	if (t === "string[]" && !Array.isArray(entry.normalized)) {
		return 'type "string[]" requires array normalized';
	}
	if (t === "datetime" && typeof entry.normalized === "string") {
		const d = new Date(entry.normalized);
		if (Number.isNaN(d.getTime())) return "datetime is not parseable";
	}

	return { original, normalized: entry.normalized, type: t };
}

export interface BatchParseResult {
	resolved: Record<string, NormalizationEntry>;
	unresolved: Array<{ path: string; reason: string }>;
}

function indexResponseByPath(
	arr: unknown[],
): Map<string, { type: unknown; normalized: unknown }> {
	const byPath = new Map<string, { type: unknown; normalized: unknown }>();
	for (const item of arr) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const obj = item as Record<string, unknown>;
		if (typeof obj.path !== "string") continue;
		if (!("type" in obj) || !("normalized" in obj)) continue;
		byPath.set(obj.path, { type: obj.type, normalized: obj.normalized });
	}
	return byPath;
}

function allMissing(
	leaves: AmbiguousLeaf[],
	reason: string,
): Array<{ path: string; reason: string }> {
	return leaves.map((l) => ({ path: l.path, reason }));
}

export function parseBatchResponse(
	output: string,
	leaves: AmbiguousLeaf[],
): BatchParseResult {
	const arr = extractJsonArray(output);
	if (!Array.isArray(arr)) {
		return {
			resolved: {},
			unresolved: allMissing(leaves, "no JSON array in response"),
		};
	}

	const byPath = indexResponseByPath(arr);
	const resolved: Record<string, NormalizationEntry> = {};
	const unresolved: Array<{ path: string; reason: string }> = [];

	for (const leaf of leaves) {
		const raw = byPath.get(leaf.path);
		if (!raw) {
			unresolved.push({
				path: leaf.path,
				reason: "missing from response",
			});
			continue;
		}
		const validated = validateEntry(raw, leaf.original);
		if (typeof validated === "string") {
			unresolved.push({ path: leaf.path, reason: validated });
		} else {
			resolved[leaf.path] = validated;
		}
	}

	return { resolved, unresolved };
}

// ---------------------------------------------------------------------------
// batch execution with retry
// ---------------------------------------------------------------------------

interface BatchOutcome {
	resolved: Record<string, NormalizationEntry>;
	failed: Array<{ path: string; reason: string }>;
	inputTokens: number;
	outputTokens: number;
}

function formatRejection(
	unresolved: Array<{ path: string; reason: string }>,
): string {
	return unresolved.map((u) => `- ${u.path}: ${u.reason}`).join("\n");
}

async function resolveBatch(
	leaves: AmbiguousLeaf[],
	opts: LlmNormalizeOpts,
	batchIndex: number,
	batchDir: string,
): Promise<BatchOutcome> {
	await mkdir(batchDir, { recursive: true });

	const stepName = `${opts.stepNameBase}/batch-${batchIndex + 1}`;
	const handle: StepHandle | null =
		opts.logger?.startStep(stepName, { kind: "agent" }) ?? null;

	const resolved: Record<string, NormalizationEntry> = {};
	let pending = leaves;
	let rejection: string | undefined;
	let totalInput = 0;
	let totalOutput = 0;

	try {
		for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
			const prompt = buildBatchPrompt(
				opts.page,
				pending,
				opts.page.content,
				rejection,
			);
			await writeFile(join(batchDir, `attempt-${attempt}.prompt.txt`), prompt);

			const call = await callMessages({
				profile: opts.profile,
				user: prompt,
			});
			totalInput += call.inputTokens;
			totalOutput += call.outputTokens;

			if (opts.logger && handle) {
				opts.logger.updateTurn(handle, attempt, totalInput, totalOutput);
			}

			await writeFile(
				join(batchDir, `attempt-${attempt}.response.txt`),
				call.text,
			);

			const parsed = parseBatchResponse(call.text, pending);
			Object.assign(resolved, parsed.resolved);

			if (parsed.unresolved.length === 0) break;

			// Retry only the leaves that failed; the rest stay resolved.
			const stillPendingPaths = new Set(parsed.unresolved.map((u) => u.path));
			pending = pending.filter((l) => stillPendingPaths.has(l.path));
			rejection = formatRejection(parsed.unresolved);
		}

		const failed = pending
			.filter((l) => !(l.path in resolved))
			.map((l) => ({
				path: l.path,
				reason: rejection ?? "unresolved after retries",
			}));

		await writeFile(
			join(batchDir, "verdict.json"),
			JSON.stringify(
				{
					leaves: leaves.length,
					resolved: Object.keys(resolved).length,
					failed: failed.length,
					inputTokens: totalInput,
					outputTokens: totalOutput,
				},
				null,
				2,
			),
		);

		if (opts.logger && handle) opts.logger.completeStep(handle, 0);
		return {
			resolved,
			failed,
			inputTokens: totalInput,
			outputTokens: totalOutput,
		};
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		if (opts.logger && handle) opts.logger.failStep(handle, reason);
		const failed = leaves
			.filter((l) => !(l.path in resolved))
			.map((l) => ({ path: l.path, reason }));
		return {
			resolved,
			failed,
			inputTokens: totalInput,
			outputTokens: totalOutput,
		};
	}
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export function chunkLeaves(
	leaves: AmbiguousLeaf[],
	size = BATCH_SIZE,
): AmbiguousLeaf[][] {
	const batches: AmbiguousLeaf[][] = [];
	for (let i = 0; i < leaves.length; i += size) {
		batches.push(leaves.slice(i, i + size));
	}
	return batches;
}

/**
 * Exposed for unit tests — keep in sync with batch internals.
 * @public
 */
export const __test = {
	collectSiblings,
	parentPath,
	chunkLeaves,
	validateEntry,
} as const;

/**
 * Resolve all ambiguous leaves via batched direct-API calls.
 *
 * Batches of BATCH_SIZE (10) run in parallel. Each batch retries itself
 * internally up to MAX_BATCH_ATTEMPTS times on validation failure.
 */
export async function llmNormalizeLeaves(
	opts: LlmNormalizeOpts,
): Promise<LlmNormalizeResult> {
	const resolved: Record<string, NormalizationEntry> = {};
	const failed: Array<{ path: string; reason: string }> = [];
	let inputTokens = 0;
	let outputTokens = 0;

	if (opts.ambiguous.length === 0) {
		return { resolved, failed, inputTokens, outputTokens };
	}

	const batchesRoot = join(opts.attemptDir, "batches");
	await mkdir(batchesRoot, { recursive: true });

	const batches = chunkLeaves(opts.ambiguous);

	const outcomes = await Promise.all(
		batches.map((batch, i) =>
			resolveBatch(batch, opts, i, join(batchesRoot, `batch-${i + 1}`)),
		),
	);

	for (const outcome of outcomes) {
		Object.assign(resolved, outcome.resolved);
		failed.push(...outcome.failed);
		inputTokens += outcome.inputTokens;
		outputTokens += outcome.outputTokens;
	}

	opts.logger?.note(
		`classify batches: ${batches.length} × ≤${BATCH_SIZE} leaves — tokens ${inputTokens} in / ${outputTokens} out`,
	);

	return { resolved, failed, inputTokens, outputTokens };
}

/**
 * Pure logic for Stage 2 — per-page chrome classify.
 *
 * The classifier's job is to look at ONE page's content and return the dot-paths
 * on that page that are site "chrome" rather than page-unique body. It works on
 * a single page in isolation; cross-page reconciliation is Stage 3's harmonize.
 *
 * This module is pure — no IO. The IO shell at `phases/chrome-classify.ts`
 * supplies a `runAgent` dependency so per-page orchestration can be tested
 * without touching the Claude SDK.
 */

import { isLeaf, readPath } from "./path-utils.js";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface ClassifierPathEntry {
	sourcePath: string;
	suggestedCanonical?: string;
}

export interface ClassifierOutput {
	chromePaths: ClassifierPathEntry[];
}

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}

export interface AgentCallRecord {
	prompt: string;
	response: string;
	tokens: AgentCallTotals;
}

export interface ClassifyAttemptRecord extends AgentCallRecord {
	parsed?: ClassifierOutput;
	error?: string;
}

export interface ReviewAttemptRecord extends AgentCallRecord {
	verdict: "pass" | "reject";
	findings: string;
}

export interface AttemptRecord {
	attempt: number;
	classify: ClassifyAttemptRecord;
	review?: ReviewAttemptRecord;
}

export interface PageClassifyInput {
	pagetype: string;
	url: string;
	content: unknown;
}

export interface PageClassifyResult {
	status: "pass" | "fail";
	output?: ClassifierOutput;
	lastRejection?: string;
	attempts: AttemptRecord[];
	totals: AgentCallTotals;
}

export interface AgentCallTotals {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

/** How the fan-out step reaches the Claude SDK. Injected so tests can stub it. */
export type RunAgentFn = (args: {
	prompt: string;
	role: "classify" | "review";
	attempt: number;
}) => Promise<{
	output: string;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}>;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const CHROME_DEFINITION = `## Chrome definition

A field on a page is CHROME iff a CMS editor does NOT need a per-page editable
value for it:

  - Constant across every page of this page type → CHROME (no editing needed)
  - Varies per page but can be derived from page identity (slug / URL /
    pagetype) → CHROME (computed at render time, no author input)
  - Requires per-page authorial input → BODY (NOT chrome)

Chrome is the site shell: header, navigation, footer, logo, copyright,
legal/social links, site-wide SEO defaults, etc.
Body is page-unique content: page title, body paragraphs, feature lists,
testimonials, per-page CTA copy, per-page images, forms, etc.

When in doubt, prefer CHROME — harmonize (Stage 3) re-examines every chrome
candidate across sibling pages of the same page type and demotes any that
vary per page, so over-inclusion is cheap to recover there. Under-inclusion
is more costly: missed chrome never reaches harmonize. Err on the side of
listing a path as chrome whenever the call is ambiguous.`;

const JSON_ONLY_PREAMBLE = `You are a JSON-only classifier. Your ENTIRE response MUST be a single JSON
object parseable by \`JSON.parse\`. No prose before or after. No markdown code
fences. No explanation. The very first character of your response is \`{\` and
the very last character is \`}\`.`;

export function buildClassifierPrompt(
	input: PageClassifyInput,
	rejectionContext?: string,
): string {
	const arraysBlock = formatArrayLengthsBlock(input.content);

	const body = `${JSON_ONLY_PREAMBLE}

You are classifying fields on a single page into CHROME or BODY.

${CHROME_DEFINITION}

## This page

- page_type: ${input.pagetype}
- url: ${input.url}
- content (JSON):

\`\`\`json
${JSON.stringify(input.content, null, 2)}
\`\`\`
${arraysBlock}
## Output

Return ONLY a JSON object matching this schema (no prose, no code fences,
no explanation):

{
  "chromePaths": [
    { "sourcePath": "<dot-path>", "suggestedCanonical": "<optional>" }
  ]
}

Rules:
  - Each \`sourcePath\` must be a dot-path that terminates at a LEAF on this page
    (primitive value, null, or empty object/array). Do NOT point at a branch
    (non-empty object or array) — pick the individual leaves inside it.
  - Use bracket notation for array indices, e.g. \`nav.links[0].href\`.
  - Every bracketed index MUST be within the lengths listed in "Array lengths"
    above. Do NOT invent indices past the end of any array.
  - \`sourcePath\` values must be unique within the list.
  - \`suggestedCanonical\` is optional. Only include one when the current path
    is awkward or inconsistent — leave it out when the path is already a sane
    canonical name.
  - Omit \`sourcePath\` entirely (do not list it) when unsure.
  - Output the empty object \`{"chromePaths": []}\` if nothing on this page is
    chrome.

Begin.`;

	if (rejectionContext) {
		return `${body}\n\n---\nPREVIOUS ATTEMPT REJECTED. Fix these issues:\n${rejectionContext}`;
	}
	return body;
}

// ---------------------------------------------------------------------------
// Array-length hints — deter path hallucination past array ends
// ---------------------------------------------------------------------------

export interface ArrayLengthEntry {
	path: string;
	length: number;
}

export function collectArrayLengths(content: unknown): ArrayLengthEntry[] {
	const out: ArrayLengthEntry[] = [];
	walkArrays(content, "", out);
	return out;
}

function walkArrays(
	value: unknown,
	prefix: string,
	out: ArrayLengthEntry[],
): void {
	if (Array.isArray(value)) {
		out.push({ path: prefix || "<root>", length: value.length });
		for (let i = 0; i < value.length; i++) {
			walkArrays(value[i], `${prefix}[${i}]`, out);
		}
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			const next = prefix ? `${prefix}.${k}` : k;
			walkArrays(v, next, out);
		}
	}
}

function formatArrayLengthsBlock(content: unknown): string {
	const entries = collectArrayLengths(content);
	if (entries.length === 0) return "";
	const lines = entries
		.map((e) =>
			e.length === 0
				? `  - ${e.path}: length 0 (no valid indices)`
				: `  - ${e.path}: length ${e.length} (valid indices: 0..${e.length - 1})`,
		)
		.join("\n");
	return `\n## Array lengths (do NOT invent out-of-range indices)\n\n${lines}\n`;
}

export function buildReviewerPrompt(
	input: PageClassifyInput,
	candidate: ClassifierOutput,
): string {
	return `You are reviewing a per-page chrome classification produced by another model.

${CHROME_DEFINITION}

## Page under review

- page_type: ${input.pagetype}
- url: ${input.url}
- content (JSON):

\`\`\`json
${JSON.stringify(input.content, null, 2)}
\`\`\`

## Candidate classification

\`\`\`json
${JSON.stringify(candidate, null, 2)}
\`\`\`

## Your task

Decide if the candidate is acceptable. Consider:

  1. Missing chrome — any OBVIOUS chrome left out (header, main nav, footer,
     logo, copyright, site-wide legal/social links, site-wide SEO defaults,
     site-wide CTAs)? This is the primary thing to catch.
  2. Wrongly-tagged chrome — only reject when a listed path is CLEARLY
     per-page authorial content (e.g. this page's unique title, body
     paragraphs, per-page article text). Borderline inclusions (a CTA,
     a "recent posts" block, a payment/contact section that MIGHT be
     site-wide) should PASS — Stage 3 harmonize demotes anything that
     varies across sibling pages, so false-positive chrome is cheap.
  3. Schema issues — paths that don't resolve on this page, container paths
     instead of leaves, duplicates.

Strongly prefer PASS on borderline calls: over-inclusion is recoverable in
Stage 3, under-inclusion is not. Only REJECT when there is clear obvious
chrome missing, or a listed path is unambiguously per-page body.

## Output format

Output EXACTLY one of the following verdict lines on its own line:

  VERDICT: PASS
  VERDICT: REJECT

If REJECT, follow with a short findings summary, then a section starting with
\`REJECTION CONTEXT:\` containing the specific corrections the classifier
should apply on retry (concrete paths, not prose).

Begin.`;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Extract `{ chromePaths: [...] }` from the classifier's raw text output.
 * Returns `null` when the text doesn't contain a valid JSON object matching
 * the required shape. Tolerates surrounding prose / code fences by grabbing
 * the first top-level `{ ... }`.
 */
export function parseClassifierOutput(raw: string): ClassifierOutput | null {
	const jsonText = extractJsonObject(raw);
	if (!jsonText) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const rawPaths = (parsed as Record<string, unknown>).chromePaths;
	if (!Array.isArray(rawPaths)) return null;

	const out: ClassifierPathEntry[] = [];
	for (const entry of rawPaths) {
		const parsedEntry = parseEntry(entry);
		if (!parsedEntry) return null;
		out.push(parsedEntry);
	}
	return { chromePaths: out };
}

function parseEntry(entry: unknown): ClassifierPathEntry | null {
	if (!entry || typeof entry !== "object") return null;
	const e = entry as Record<string, unknown>;
	if (typeof e.sourcePath !== "string") return null;
	const result: ClassifierPathEntry = { sourcePath: e.sourcePath };
	if (!("suggestedCanonical" in e) || e.suggestedCanonical === undefined) {
		return result;
	}
	if (typeof e.suggestedCanonical !== "string") return null;
	result.suggestedCanonical = e.suggestedCanonical;
	return result;
}

/** Find the first balanced `{ ... }` in a string. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: JSON boundary scanner — state machine over string/escape/depth
function extractJsonObject(raw: string): string | null {
	const start = raw.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < raw.length; i++) {
		const ch = raw[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return raw.slice(start, i + 1);
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

const CANONICAL_NAME_RE = /^[A-Za-z0-9._[\]-]+$/;

export function validateClassifierOutput(
	content: unknown,
	output: ClassifierOutput,
): ValidationResult {
	const errors: string[] = [];
	const seen = new Set<string>();

	for (const entry of output.chromePaths) {
		if (!entry.sourcePath) {
			errors.push("Empty sourcePath");
			continue;
		}
		if (seen.has(entry.sourcePath)) {
			errors.push(`Duplicate sourcePath: "${entry.sourcePath}"`);
			continue;
		}
		seen.add(entry.sourcePath);

		const value = readPath(content, entry.sourcePath);
		if (value === undefined) {
			errors.push(
				`sourcePath does not resolve on this page: "${entry.sourcePath}"`,
			);
			continue;
		}
		if (!isLeaf(value)) {
			errors.push(
				`sourcePath points at a non-empty container (branch), not a leaf: "${entry.sourcePath}". Pick the individual leaves inside it.`,
			);
			continue;
		}

		if (
			entry.suggestedCanonical !== undefined &&
			!CANONICAL_NAME_RE.test(entry.suggestedCanonical)
		) {
			errors.push(
				`suggestedCanonical contains unsupported characters: "${entry.suggestedCanonical}"`,
			);
		}
	}

	return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Verdict parsing (lightweight — mirrors lib/reviewers parseReviewerVerdict
// but scoped to the shape we emit in buildReviewerPrompt)
// ---------------------------------------------------------------------------

export interface ReviewerVerdict {
	verdict: "pass" | "reject";
	findings: string;
	rejectionContext?: string;
}

export function parseChromeReviewerVerdict(raw: string): ReviewerVerdict {
	const up = raw.toUpperCase();
	if (up.includes("VERDICT: PASS") || up.includes("VERDICT:PASS")) {
		return { verdict: "pass", findings: raw.trim() };
	}
	if (up.includes("VERDICT: REJECT") || up.includes("VERDICT:REJECT")) {
		const m = raw.match(/REJECTION CONTEXT[:\s\u2014-]*\n?([\s\S]+)$/i);
		const rc = m ? m[1].trim() : undefined;
		return {
			verdict: "reject",
			findings: raw.trim(),
			rejectionContext: rc ?? raw.trim(),
		};
	}
	return {
		verdict: "reject",
		findings: `Malformed reviewer output — missing VERDICT line.\n\n${raw}`,
		rejectionContext:
			'Reviewer output must include exactly one of "VERDICT: PASS" or "VERDICT: REJECT" on its own line.',
	};
}

// ---------------------------------------------------------------------------
// Per-page orchestration — pure, takes a runAgent dep so tests skip the SDK
// ---------------------------------------------------------------------------

/**
 * Lifecycle hooks — fire at each boundary of the per-page loop so an IO shell
 * can stream writes to disk as they happen (prompt before call, response +
 * parse/verdict after). All hooks are optional; lib callers that don't care
 * about live artifacts can omit them and the loop behaves identically.
 */
export interface AttemptHooks {
	beforeClassifyCall?: (
		attempt: number,
		prompt: string,
	) => Promise<void> | void;
	afterClassifyCall?: (
		attempt: number,
		record: ClassifyAttemptRecord,
	) => Promise<void> | void;
	beforeReviewCall?: (attempt: number, prompt: string) => Promise<void> | void;
	afterReviewCall?: (
		attempt: number,
		record: ReviewAttemptRecord,
	) => Promise<void> | void;
}

export interface ClassifyOnePageOptions {
	page: PageClassifyInput;
	runAgent: RunAgentFn;
	maxRetries: number;
	hooks?: AttemptHooks;
}

export async function classifyOnePage(
	opts: ClassifyOnePageOptions,
): Promise<PageClassifyResult> {
	const { page, runAgent, maxRetries, hooks } = opts;
	const attempts: AttemptRecord[] = [];
	const totals: AgentCallTotals = {
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
	};
	let rejectionContext: string | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		// ---- classify ----
		const classifyPrompt = buildClassifierPrompt(page, rejectionContext);
		await hooks?.beforeClassifyCall?.(attempt, classifyPrompt);
		const classifyCall = await runAgent({
			prompt: classifyPrompt,
			role: "classify",
			attempt,
		});
		addTotals(totals, classifyCall);

		const classifyRecord: ClassifyAttemptRecord = {
			prompt: classifyPrompt,
			response: classifyCall.output,
			tokens: metricsOf(classifyCall),
		};

		const parsed = parseClassifierOutput(classifyCall.output);
		if (!parsed) {
			classifyRecord.error = "unparseable";
			await hooks?.afterClassifyCall?.(attempt, classifyRecord);
			attempts.push({ attempt, classify: classifyRecord });
			rejectionContext =
				'Previous output was not valid JSON matching {"chromePaths":[{"sourcePath":"..."}]}. Return ONLY that JSON object, no prose or code fences.';
			continue;
		}

		classifyRecord.parsed = parsed;

		const validation = validateClassifierOutput(page.content, parsed);
		if (!validation.valid) {
			classifyRecord.error = validation.errors.join("; ");
			await hooks?.afterClassifyCall?.(attempt, classifyRecord);
			attempts.push({ attempt, classify: classifyRecord });
			rejectionContext = `Previous output failed validation:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`;
			continue;
		}

		await hooks?.afterClassifyCall?.(attempt, classifyRecord);

		// ---- review ----
		const reviewPrompt = buildReviewerPrompt(page, parsed);
		await hooks?.beforeReviewCall?.(attempt, reviewPrompt);
		const reviewCall = await runAgent({
			prompt: reviewPrompt,
			role: "review",
			attempt,
		});
		addTotals(totals, reviewCall);
		const verdict = parseChromeReviewerVerdict(reviewCall.output);
		const reviewRecord: ReviewAttemptRecord = {
			prompt: reviewPrompt,
			response: reviewCall.output,
			tokens: metricsOf(reviewCall),
			verdict: verdict.verdict,
			findings: verdict.findings,
		};
		await hooks?.afterReviewCall?.(attempt, reviewRecord);
		attempts.push({ attempt, classify: classifyRecord, review: reviewRecord });

		if (verdict.verdict === "pass") {
			return { status: "pass", output: parsed, attempts, totals };
		}

		rejectionContext = verdict.rejectionContext ?? verdict.findings;
	}

	return {
		status: "fail",
		lastRejection: rejectionContext,
		attempts,
		totals,
	};
}

function addTotals(
	totals: AgentCallTotals,
	call: {
		turns: number;
		inputTokens: number;
		outputTokens: number;
		cost: number;
	},
): void {
	totals.turns += call.turns;
	totals.inputTokens += call.inputTokens;
	totals.outputTokens += call.outputTokens;
	totals.cost += call.cost;
}

function metricsOf(call: {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}): AgentCallTotals {
	return {
		turns: call.turns,
		inputTokens: call.inputTokens,
		outputTokens: call.outputTokens,
		cost: call.cost,
	};
}

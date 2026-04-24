/**
 * Intent → ops compiler.
 *
 * Compile pipeline:
 *   1. Project:   (input, intent) → {output, provenance} via an LLM projector
 *                 whose response tags the origin of every output leaf.
 *   2. Provenance: programmatic check — every "from:input" leaf resolves in
 *                 input with an equal value; every "from:intent" phrase is a
 *                 verbatim substring of intent; every "from:derived" has a
 *                 non-empty reason.
 *   3. Review:    two LLM reviewers score the output independently. AND-
 *                 consensus required. Any rejection or disagreement retries
 *                 the projector with the concatenated rejection context.
 *   4. Diff:      pure — fast-json-patch `compare(input, output)` for forward,
 *                 `compare(output, input)` for backward. Attach intent.
 *
 * Public surface: `compileIntentToOps`, `applyOps`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyPatch, compare, type Operation } from "fast-json-patch";
import { extractJsonObject } from "../../../lib/json-extract.js";
import type { AgentCallTotals } from "./chrome-classify.js";
import { isLeaf, readPath } from "./path-utils.js";

export type { Operation } from "fast-json-patch";

export interface IntentOpsPlan {
	intent: string;
	forward: Operation[];
	backward: Operation[];
}

export type ProvenanceEntry =
	| { from: "input"; path: string }
	| { from: "intent"; phrase: string }
	| { from: "derived"; reason: string };

export type Provenance = Record<string, ProvenanceEntry>;

export interface ProjectorOutput {
	output: unknown;
	provenance: Provenance;
}

export type CompileAgentRole = "project" | "review-a" | "review-b";

export type CompileRunAgentFn = (args: {
	prompt: string;
	role: CompileAgentRole;
	attempt: number;
	workdir: string;
}) => Promise<{
	output: string;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}>;

export interface CompileIntentToOpsOptions {
	input: unknown;
	intent: string;
	runAgent: CompileRunAgentFn;
	workdir: string;
	budget?: number;
}

export interface ReviewerFinding {
	path: string;
	issue: string;
}

export type ReviewerVerdict = {
	verdict: "pass" | "reject";
	findings: ReviewerFinding[];
	raw?: string;
};

export interface ReviewerAttempt {
	prompt: string;
	response: string;
	verdict: ReviewerVerdict;
}

export interface CompileAttemptRecord {
	attempt: number;
	projector?: { prompt: string; response: string };
	projection?: ProjectorOutput;
	provenanceErrors?: ReviewerFinding[];
	reviewers?: { a: ReviewerAttempt; b: ReviewerAttempt };
	error?: string;
}

export interface CompileIntentToOpsResult {
	plan: IntentOpsPlan;
	output: unknown;
	provenance: Provenance;
	totals: AgentCallTotals;
	attempts: CompileAttemptRecord[];
}

const DEFAULT_BUDGET = 3;
const JSON_ONLY_PREAMBLE = `You are a JSON-only responder. Your ENTIRE response MUST be a single JSON
object parseable by JSON.parse. No prose before or after. No markdown fences.`;

export async function compileIntentToOps(
	opts: CompileIntentToOpsOptions,
): Promise<CompileIntentToOpsResult> {
	const budget = opts.budget ?? DEFAULT_BUDGET;
	const totals = emptyTotals();
	const attempts: CompileAttemptRecord[] = [];
	let rejectionContext: string | undefined;

	for (let attempt = 0; attempt < budget; attempt++) {
		const record: CompileAttemptRecord = { attempt };
		attempts.push(record);
		const attemptDir = await prepareAttemptDir(opts.workdir, attempt);

		const projectorPrompt = buildProjectorPrompt(
			opts.input,
			opts.intent,
			rejectionContext,
		);
		await writeTextArtifact(
			attemptDir,
			"projector.prompt.txt",
			projectorPrompt,
		);
		const projectorCall = await opts.runAgent({
			prompt: projectorPrompt,
			role: "project",
			attempt,
			workdir: attemptDir,
		});
		addTotals(totals, projectorCall);
		record.projector = {
			prompt: projectorPrompt,
			response: projectorCall.output,
		};
		await writeTextArtifact(
			attemptDir,
			"projector.response.txt",
			projectorCall.output,
		);

		const parsedProjection = parseProjectorOutput(projectorCall.output);
		if (!parsedProjection.ok) {
			record.error = parsedProjection.error;
			await writeTextArtifact(attemptDir, "error.txt", parsedProjection.error);
			rejectionContext = `Projector output failed to parse: ${parsedProjection.error}. Return ONLY a JSON object {output, provenance}, no prose or markdown fences.`;
			continue;
		}
		record.projection = parsedProjection.value;
		await writeJsonArtifact(
			attemptDir,
			"projection.json",
			parsedProjection.value,
		);

		const provenanceErrors = checkProvenance(
			opts.input,
			opts.intent,
			parsedProjection.value,
		);
		if (provenanceErrors.length > 0) {
			record.provenanceErrors = provenanceErrors;
			await writeJsonArtifact(
				attemptDir,
				"provenance-errors.json",
				provenanceErrors,
			);
			rejectionContext = buildProvenanceRejectionContext(provenanceErrors);
			continue;
		}

		const reviewerPrompt = buildReviewerPrompt(
			opts.input,
			opts.intent,
			parsedProjection.value,
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
			const plan = diffToPlan(
				opts.input,
				parsedProjection.value.output,
				opts.intent,
			);
			await writeJsonArtifact(attemptDir, "plan.json", plan);
			return {
				plan,
				output: parsedProjection.value.output,
				provenance: parsedProjection.value.provenance,
				totals,
				attempts,
			};
		}
		rejectionContext = buildReviewerRejectionContext(verdictA, verdictB);
	}

	throw new Error(
		`compileIntentToOps exhausted ${budget} attempts: ${rejectionContext ?? "no rejection context"}`,
	);
}

export function applyOps(
	input: unknown,
	plan: IntentOpsPlan,
	direction: "forward" | "backward",
): unknown {
	const patch = direction === "forward" ? plan.forward : plan.backward;
	const cloned = deepClone(input);
	const result = applyPatch(
		cloned as object,
		patch as Operation[],
		true,
		false,
	);
	return result.newDocument;
}

export function diffToPlan(
	input: unknown,
	output: unknown,
	intent: string,
): IntentOpsPlan {
	return {
		intent,
		forward: compare(input as object, output as object) as Operation[],
		backward: compare(output as object, input as object) as Operation[],
	};
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export function checkProvenance(
	input: unknown,
	intent: string,
	projection: ProjectorOutput,
): ReviewerFinding[] {
	const { output, provenance } = projection;
	if (!isProvenanceObject(provenance)) {
		return [
			{
				path: "",
				issue:
					"provenance must be a JSON object mapping output leaf paths to provenance entries",
			},
		];
	}

	const findings: ReviewerFinding[] = [];
	const leafPaths = enumerateLeafPaths(output);
	const leafPathSet = new Set(leafPaths);

	for (const leafPath of leafPaths) {
		findings.push(
			...checkProvenanceLeaf({
				leafPath,
				entry: provenance[leafPath],
				input,
				intent,
				output,
			}),
		);
	}

	for (const key of Object.keys(provenance)) {
		if (!leafPathSet.has(key)) {
			findings.push({
				path: key,
				issue:
					"provenance entry references a path that is not a leaf of output",
			});
		}
	}

	return findings;
}

function isProvenanceObject(value: unknown): value is Provenance {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function checkProvenanceLeaf(args: {
	leafPath: string;
	entry: ProvenanceEntry | undefined;
	input: unknown;
	intent: string;
	output: unknown;
}): ReviewerFinding[] {
	const { leafPath, entry, input, intent, output } = args;
	if (!entry) {
		return [{ path: leafPath, issue: "output leaf has no provenance entry" }];
	}
	const entryError = validateProvenanceEntry(entry, intent);
	const findings: ReviewerFinding[] = entryError
		? [{ path: leafPath, issue: entryError }]
		: [];
	if (entry.from === "input") {
		const inputFinding = checkInputProvenance({
			leafPath,
			entryPath: entry.path,
			input,
			output,
		});
		if (inputFinding) findings.push(inputFinding);
	}
	return findings;
}

function checkInputProvenance(args: {
	leafPath: string;
	entryPath: string;
	input: unknown;
	output: unknown;
}): ReviewerFinding | null {
	const { leafPath, entryPath, input, output } = args;
	const inputValue = readPath(input, entryPath);
	if (inputValue === undefined) {
		return {
			path: leafPath,
			issue: `provenance claims from=input path=${JSON.stringify(entryPath)} but that path is not present in input`,
		};
	}
	const outputValue = readPath(output, leafPath);
	if (!jsonEqual(inputValue, outputValue)) {
		return {
			path: leafPath,
			issue: `provenance claims from=input path=${JSON.stringify(entryPath)}, but input value ${JSON.stringify(inputValue)} != output value ${JSON.stringify(outputValue)}`,
		};
	}
	return null;
}

function validateProvenanceEntry(
	entry: unknown,
	intent: string,
): string | null {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		return "provenance entry must be an object";
	}
	const from = (entry as { from?: unknown }).from;
	if (from === "input") return validateInputEntry(entry);
	if (from === "intent") return validateIntentEntry(entry, intent);
	if (from === "derived") return validateDerivedEntry(entry);
	return `provenance entry has unknown or missing \`from\` (got ${JSON.stringify(from)}); expected "input" | "intent" | "derived"`;
}

function validateInputEntry(entry: object): string | null {
	const path = (entry as { path?: unknown }).path;
	if (typeof path !== "string" || path.length === 0) {
		return "from=input entry requires non-empty string `path`";
	}
	return null;
}

function validateIntentEntry(entry: object, intent: string): string | null {
	const phrase = (entry as { phrase?: unknown }).phrase;
	if (typeof phrase !== "string" || phrase.length < 3) {
		return "from=intent entry requires string `phrase` of at least 3 characters";
	}
	if (!intent.includes(phrase)) {
		return `from=intent entry cites phrase ${JSON.stringify(phrase)} but it is not a substring of the intent`;
	}
	return null;
}

function validateDerivedEntry(entry: object): string | null {
	const reason = (entry as { reason?: unknown }).reason;
	if (typeof reason !== "string" || reason.length === 0) {
		return "from=derived entry requires non-empty string `reason`";
	}
	return null;
}

export function enumerateLeafPaths(value: unknown, prefix = ""): string[] {
	if (isLeaf(value)) return [prefix];
	if (Array.isArray(value)) {
		if (value.length === 0) return [prefix];
		return value.flatMap((item, index) =>
			enumerateLeafPaths(item, `${prefix}[${index}]`),
		);
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) return [prefix];
		return entries.flatMap(([key, v]) =>
			enumerateLeafPaths(v, prefix === "" ? key : `${prefix}.${key}`),
		);
	}
	return [prefix];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseProjectorOutput(
	response: string,
): { ok: true; value: ProjectorOutput } | { ok: false; error: string } {
	const parsed = extractJsonObject(response);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: "projector response was not a JSON object" };
	}
	const record = parsed as Record<string, unknown>;
	if (!("output" in record)) {
		return { ok: false, error: "projector response missing `output` field" };
	}
	const provenance = record.provenance;
	if (
		!provenance ||
		typeof provenance !== "object" ||
		Array.isArray(provenance)
	) {
		return {
			ok: false,
			error: "projector response missing/invalid `provenance` object",
		};
	}
	return {
		ok: true,
		value: {
			output: record.output,
			provenance: provenance as Provenance,
		},
	};
}

export function parseReviewerVerdict(response: string): ReviewerVerdict {
	const parsed = extractJsonObject(response);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return rejectVerdict(response, "reviewer returned no JSON object");
	}
	const record = parsed as Record<string, unknown>;
	const findings = parseFindingsList(record.findings);
	const verdictRaw = record.verdict;
	if (verdictRaw === "pass") {
		return { verdict: "pass", findings, raw: response };
	}
	if (verdictRaw === "reject") {
		return {
			verdict: "reject",
			findings:
				findings.length > 0
					? findings
					: [{ path: "", issue: "reviewer rejected without findings" }],
			raw: response,
		};
	}
	return rejectVerdict(
		response,
		`reviewer verdict must be "pass" or "reject"; got ${JSON.stringify(verdictRaw)}`,
	);
}

function parseFindingsList(raw: unknown): ReviewerFinding[] {
	if (!Array.isArray(raw)) return [];
	const findings: ReviewerFinding[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const path = (item as { path?: unknown }).path;
		const issue = (item as { issue?: unknown }).issue;
		findings.push({
			path: typeof path === "string" ? path : "",
			issue: typeof issue === "string" ? issue : JSON.stringify(item),
		});
	}
	return findings;
}

function rejectVerdict(raw: string, issue: string): ReviewerVerdict {
	return {
		verdict: "reject",
		findings: [{ path: "", issue }],
		raw,
	};
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function buildProjectorPrompt(
	input: unknown,
	intent: string,
	rejectionContext?: string,
): string {
	const body = `${JSON_ONLY_PREAMBLE}

You are a JSON projector. Given an input JSON value and a natural-language
intent describing how to rewrite it, produce the target output JSON plus a
provenance map that tags the origin of every leaf value.

Input:
\`\`\`json
${JSON.stringify(input, null, 2)}
\`\`\`

Intent:
${intent}

Rules:
- "output" is the rewritten JSON.
- "provenance" is an object keyed by every leaf path in "output" (dot + bracket
  notation, e.g. "items[0].name"). An empty object "{}" and empty array "[]"
  count as leaves and need their own provenance entry.
- Each provenance entry is one of:
    {"from":"input","path":"<path.in.input>"} — the leaf value came verbatim
      from that input path. Value equality is enforced by a programmatic check;
      do not fabricate paths.
    {"from":"intent","phrase":"<verbatim substring of intent>"} — the value
      came from the intent. phrase must be a literal substring of intent, at
      least 3 characters.
    {"from":"derived","reason":"<short reason>"} — the value is computed.
      reason must be non-empty.
- Do NOT invent provenance. A mechanical check rejects any from=input whose
  value does not actually match input at that path, and any from=intent whose
  phrase is not a substring of intent.

Output shape (exact):
{
  "output": <projected JSON>,
  "provenance": {"<leaf.path>": {"from":"input","path":"..."} | {"from":"intent","phrase":"..."} | {"from":"derived","reason":"..."}, ...}
}`;
	if (!rejectionContext) return body;
	return `${body}

Previous attempt failed. Fix this exactly:
${rejectionContext}`;
}

export function buildReviewerPrompt(
	input: unknown,
	intent: string,
	projection: ProjectorOutput,
): string {
	return `${JSON_ONLY_PREAMBLE}

You are a projection reviewer. The projector has produced an output JSON plus
provenance. A mechanical check has already verified every from=input / from=
intent provenance tag resolves correctly. Your remaining job is to identify
values in "output" that are NOT justified by input or by the intent.

Input:
\`\`\`json
${JSON.stringify(input, null, 2)}
\`\`\`

Intent:
${intent}

Output:
\`\`\`json
${JSON.stringify(projection.output, null, 2)}
\`\`\`

Provenance:
\`\`\`json
${JSON.stringify(projection.provenance, null, 2)}
\`\`\`

Check for:
- Values in "output" that do not appear in input and are not called for by the
  intent (hallucinated data).
- Keys or structure in "output" that the intent did not ask for.
- from=derived reasons that do not actually follow from input or intent.
- Missing values that the intent clearly required.

Enumerate each concern with the leaf path it occurs at. Empty findings means
the output is fully justified.

Return exactly:
{"verdict":"pass","findings":[]}
or
{"verdict":"reject","findings":[{"path":"<leaf.path>","issue":"<short>"}, ...]}
`;
}

// ---------------------------------------------------------------------------
// Rejection context builders
// ---------------------------------------------------------------------------

function buildProvenanceRejectionContext(errors: ReviewerFinding[]): string {
	const lines = errors.map((err) =>
		err.path ? `  - ${err.path}: ${err.issue}` : `  - ${err.issue}`,
	);
	return `Provenance check failed. Fix these entries:
${lines.join("\n")}`;
}

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
			"Reviewer disagreement (both returned pass/reject inconsistently). Tighten the output.",
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
	const lines = verdict.findings.map((f) =>
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

function deepClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function jsonEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(
			([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
		);
		return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v)]));
	}
	return value;
}

/**
 * Phase 3c — `harmonize-verdicts`
 *
 * Two steps:
 *   1. `harmonize-verdicts` (agent fan-out across pagetypes).
 *      For each pagetype, the agent sees a digest with post-rename candidates
 *      + distinct values + page hashes. It emits one verdict per candidate.
 *      Programmatic validator runs against the verdicts; retries up to 2 with
 *      targeted rejection context.
 *   2. `harmonize-verdicts-review` (reviewer fan-out across pagetypes).
 *      Semantic quality pass: do `demote` rationales actually describe
 *      per-page content? Is a `keep-static` with `observed: false` a real
 *      normalization, or does it paper over a genuine conflict? Is a
 *      `keep-dynamic` actually chrome, or is it authored content? The
 *      reviewer can only reject the phase (never rewrite); rejections retry
 *      step 1 with the reviewer's findings.
 *
 * Profile keys:
 *   - classify.harmonize-verdicts.verdicts-agent
 *   - classify.harmonize-verdicts.verdicts-reviewer
 *
 * Reads: `classify-output/<pagetype>/{digest.json, rename-table.json}`.
 * Writes: `classify-output/<pagetype>/verdicts.json` + attempts/.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveProfile } from "../../../engine/profile.js";
import type {
	PhaseDef,
	Review,
	StepContext,
	StepResult,
} from "../../../engine/types.js";
import { agentQueryWithMetrics } from "../../../lib/agent.js";
import { extractJsonObject } from "../../../lib/json-extract.js";
import { parseReviewerVerdict } from "../../../lib/reviewers.js";
import { agentFanOutStep } from "../../../steps/step.js";
import { applyRenameTable } from "../lib/harmonize-rename.js";
import type {
	PageTypeDigest,
	RenameTable,
	ValidationResult,
	Verdict,
	VerdictTable,
} from "../lib/harmonize-types.js";
import { validateVerdicts } from "../lib/harmonize-verdicts-validate.js";
import { discoverPagetypeDirs, readDigest } from "./harmonize-shared.js";

// Fail immediately on any verdicts defect. A retry with the same digest
// and prompt rarely produces a different answer — if the agent emitted a
// malformed verdict set once, it signals a real issue (prompt drift,
// model regression, pagetype too dense for one call) that should halt
// the run rather than burn turns.
const MAX_RETRIES = 0;

export const harmonizeVerdictsPhase: PhaseDef = {
	id: "harmonize-verdicts",
	name: "Harmonize verdicts",
	description:
		"Per-pagetype LLM fan-out: emit one verdict per post-rename candidate (keep-static | keep-dynamic | demote | defer-to-operator). Inline reviewer gates semantic quality.",
	maxRetries: 0,
	steps: [
		agentFanOutStep({
			id: "harmonize-verdicts",
			name: "Harmonize verdicts fan-out",
			description:
				"Agent emits verdicts.json per pagetype; programmatic validator enforces coverage + value-key invariants.",
			profileKey: "verdicts-agent",
			run: runVerdicts,
		}),
		agentFanOutStep({
			id: "harmonize-verdicts-review",
			name: "Harmonize verdicts review fan-out",
			description:
				"Reviewer fan-out: audits each pagetype's verdicts.json for semantic quality.",
			profileKey: "verdicts-reviewer",
			run: runVerdictsReview,
		}),
	],
};

interface Totals {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

async function runVerdicts(ctx: StepContext): Promise<StepResult> {
	const start = Date.now();
	const totals: Totals = { turns: 0, inputTokens: 0, outputTokens: 0, cost: 0 };

	const pagetypes = await discoverPagetypeDirs(ctx.workdir);
	if (pagetypes.length === 0) {
		return {
			status: "fail",
			error:
				"harmonize-verdicts: no pagetype digests found; harmonize-prepare must run first",
			duration: Date.now() - start,
		};
	}

	const results = await Promise.all(
		pagetypes.map((pt) => processVerdictsForPagetype(pt, ctx, totals)),
	);

	const duration = Date.now() - start;
	const metrics = {
		turns: totals.turns,
		inputTokens: totals.inputTokens,
		outputTokens: totals.outputTokens,
		cost: totals.cost,
	};

	const failures = results.filter((r) => r.status !== "pass");
	if (failures.length > 0) {
		const reviews: Review[] = failures.map((f) => ({
			reviewerId: `harmonize-verdicts/${f.pagetype}`,
			verdict: "reject",
			findings: f.error ?? "verdicts failed",
			rejectionContext: `${f.pagetype}: ${f.error ?? "verdicts failed"}`,
		}));
		return { status: "reject", reviews, duration, ...metrics };
	}
	return { status: "pass", duration, ...metrics };
}

interface PagetypeOutcome {
	pagetype: string;
	status: "pass" | "fail";
	error?: string;
}

async function processVerdictsForPagetype(
	ptDir: { pagetype: string; outDir: string },
	ctx: StepContext,
	totals: Totals,
): Promise<PagetypeOutcome> {
	let digest: PageTypeDigest;
	let renameTable: RenameTable;
	try {
		digest = await readDigest(ptDir.outDir);
		renameTable = await readRenameTable(ptDir.outDir);
	} catch (err) {
		return {
			pagetype: ptDir.pagetype,
			status: "fail",
			error: `failed to read digest.json or rename-table.json: ${String(err)}`,
		};
	}

	// Single-page pagetypes have no within-pagetype signal to judge
	// chrome-vs-per-page. Skip the LLM verdicts entirely — the per-page
	// "plausible chrome" from chrome-classify stands alone until a future
	// cross-pagetype harmonization resolves these. Downstream phases
	// (harmonize-assemble, chrome-verify) skip pagetypes without verdicts.
	if (digest.totalPages <= 1) {
		return { pagetype: ptDir.pagetype, status: "pass" };
	}

	const renamed = applyRenameTable(digest, renameTable);
	const attemptsDir = join(ptDir.outDir, "attempts", "verdicts");
	let lastValidation: ValidationResult | null = null;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const dir = join(attemptsDir, String(attempt));
		await mkdir(dir, { recursive: true });

		const prompt = buildVerdictsPrompt(renamed, lastValidation);
		await writeFile(join(dir, "verdicts.prompt.txt"), prompt);

		const call = await agentQueryWithMetrics({
			prompt,
			cwd: ctx.workdir,
			profile: ctx.profile,
			stepName: `classify/harmonize-verdicts/verdicts[${ptDir.pagetype}]#${attempt}`,
			logger: ctx.logger,
			maxTurns: ctx.profile.maxTurns,
			config: ctx.config,
		});
		totals.turns += call.turns;
		totals.inputTokens += call.inputTokens;
		totals.outputTokens += call.outputTokens;
		totals.cost += call.cost;

		await writeFile(join(dir, "verdicts.response.txt"), call.output);

		const parsed = extractJsonObject(call.output) as {
			verdicts?: unknown;
		} | null;
		if (!parsed || !Array.isArray(parsed.verdicts)) {
			await writeFile(
				join(dir, "verdicts.error.txt"),
				"response did not contain a JSON object with a verdicts array",
			);
			lastValidation = {
				valid: false,
				errors: [
					"response did not contain a JSON object with a `verdicts` array",
				],
			};
			continue;
		}

		const verdicts = parsed.verdicts as VerdictTable;
		await writeFile(
			join(dir, "verdicts.parsed.json"),
			JSON.stringify(verdicts, null, 2),
		);

		const validation = validateVerdicts(renamed, verdicts);
		if (!validation.valid) {
			await writeFile(
				join(dir, "verdicts.error.txt"),
				validation.errors.join("\n"),
			);
			lastValidation = validation;
			continue;
		}

		await writeFile(
			join(ptDir.outDir, "verdicts.json"),
			JSON.stringify(verdicts, null, 2),
		);
		return { pagetype: ptDir.pagetype, status: "pass" };
	}

	return {
		pagetype: ptDir.pagetype,
		status: "fail",
		error: lastValidation
			? `verdicts exhausted retries:\n${lastValidation.errors.map((e) => `  - ${e}`).join("\n")}`
			: "verdicts exhausted retries without a parseable response",
	};
}

async function readRenameTable(outDir: string): Promise<RenameTable> {
	try {
		const raw = await readFile(join(outDir, "rename-table.json"), "utf-8");
		return JSON.parse(raw) as RenameTable;
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Reviewer step
// ---------------------------------------------------------------------------

async function runVerdictsReview(ctx: StepContext): Promise<StepResult> {
	const start = Date.now();
	const totals: Totals = { turns: 0, inputTokens: 0, outputTokens: 0, cost: 0 };

	const reviewerProfile = resolveProfile(
		ctx.config,
		"classify",
		"harmonize-verdicts",
		"verdicts-reviewer",
	);

	const pagetypes = await discoverPagetypeDirs(ctx.workdir);
	const reviewResults = await Promise.all(
		pagetypes.map(async (pt) => {
			let digest: PageTypeDigest;
			let renameTable: RenameTable;
			let verdicts: VerdictTable;
			try {
				digest = await readDigest(pt.outDir);
				renameTable = await readRenameTable(pt.outDir);
				// Single-page pagetypes skipped verdicts — nothing to review.
				if (digest.totalPages <= 1) {
					return {
						pagetype: pt.pagetype,
						verdict: "pass" as const,
						findings: "",
					};
				}
				const raw = await readFile(join(pt.outDir, "verdicts.json"), "utf-8");
				verdicts = JSON.parse(raw) as VerdictTable;
			} catch (err) {
				return {
					pagetype: pt.pagetype,
					verdict: "reject" as const,
					findings: `reviewer: could not load verdicts for ${pt.pagetype}: ${String(err)}`,
				};
			}
			const renamed = applyRenameTable(digest, renameTable);

			const dir = join(pt.outDir, "attempts", "verdicts-review", "0");
			await mkdir(dir, { recursive: true });
			const prompt = buildReviewerPrompt(renamed, verdicts);
			await writeFile(join(dir, "review.prompt.txt"), prompt);

			const call = await agentQueryWithMetrics({
				prompt,
				cwd: ctx.workdir,
				profile: reviewerProfile,
				stepName: `classify/harmonize-verdicts/review[${pt.pagetype}]#0`,
				logger: ctx.logger,
				maxTurns: reviewerProfile.maxTurns,
				config: ctx.config,
			});
			totals.turns += call.turns;
			totals.inputTokens += call.inputTokens;
			totals.outputTokens += call.outputTokens;
			totals.cost += call.cost;

			await writeFile(join(dir, "review.response.txt"), call.output);
			const verdict = parseReviewerVerdict(call.output);
			await writeFile(join(dir, "review.verdict.txt"), verdict.verdict);
			if (verdict.findings) {
				await writeFile(join(dir, "review.findings.txt"), verdict.findings);
			}
			return {
				pagetype: pt.pagetype,
				verdict: verdict.verdict,
				findings: verdict.findings ?? "",
			};
		}),
	);

	const duration = Date.now() - start;
	const metrics = {
		turns: totals.turns,
		inputTokens: totals.inputTokens,
		outputTokens: totals.outputTokens,
		cost: totals.cost,
	};

	const rejects = reviewResults.filter((r) => r.verdict === "reject");
	if (rejects.length > 0) {
		const reviews: Review[] = rejects.map((r) => ({
			reviewerId: `harmonize-verdicts-review/${r.pagetype}`,
			verdict: "reject",
			findings: r.findings,
			rejectionContext: `${r.pagetype}: ${r.findings}`,
		}));
		return { status: "reject", reviews, duration, ...metrics };
	}
	return { status: "pass", duration, ...metrics };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const JSON_ONLY_PREAMBLE = `You are a JSON-only verdict emitter. Your ENTIRE
response MUST be a single JSON object parseable by \`JSON.parse\`. No prose
before or after. No markdown code fences. No explanation. The very first
character of your response is \`{\` and the very last character is \`}\`.`;

const VERDICT_GUIDE = `## Task

For every candidate canonical path observed in this page type, emit exactly
one verdict from this vocabulary:

- "keep-static"       — chrome with one shared value.
                        REQUIRES an explicit \`value\` key (null is valid —
                        write it, DO NOT omit the key).
                        REQUIRES a boolean \`observed\` flag:
                          observed=true  → \`value\` is byte-equal to one of
                                           the observed distinctValues.
                          observed=false → \`value\` is a normalized canonical
                                           form (e.g. "+1-555-2300" when the
                                           raw pages show "(555) 2300" and
                                           "555.2300"; or a single spelling
                                           of a name / address that pages
                                           wrote slightly differently).
                                           REQUIRES a rationale explaining
                                           why normalization is safe.
                        REQUIRES \`absentFrom\` — page hashes that did NOT
                        have this field; renderer falls back to \`value\`.
                        Use this for logos, copyrights, contact info,
                        nav labels, site title, etc.

- "keep-dynamic"      — chrome STRUCTURALLY (layout reserves space for it,
                        it belongs to the shared template) but the value is
                        per-page BY DESIGN. Do NOT supply a \`value\` — the
                        canonical leaf will be a sentinel; per-page values
                        are materialized in a sidecar artifact.
                        REQUIRES a rationale. Optional \`pattern\` label.
                        Canonical examples:
                          - breadcrumbs (each page has its own trail)
                          - related / suggested posts
                          - pagination ("Page 2 of 17")
                          - next/prev navigation
                          - active-nav indicator (current item highlighted)
                          - table-of-contents drawn from the page's own
                            headings

- "demote"            — the values read as per-page AUTHORED content (a page
                        title, a hero headline, article body). Not chrome
                        at all. Include a rationale.

- "defer-to-operator" — values disagree AND you cannot confidently call
                        static-with-normalization or dynamic-by-design.
                        Include a rationale. Downstream surfaces these in
                        value-conflicts.json for human override.

Coverage rules do NOT drive the verdict. A field on 4 of 9 pages with a
single value is still probably keep-static. Let value agreement + the
semantic read of the value itself guide you.

Key disambiguations:
- keep-dynamic is NOT demote. If the shape is chrome (site template owns
  the slot) but the value is per-page by design, pick keep-dynamic. Only
  demote when the whole field is authored page content.
- keep-static with observed=false is NOT a guess. Only normalize when all
  present-page values are clearly equivalent modulo formatting. If the
  values carry genuinely different information (different area codes,
  different street names), this is defer-to-operator, not normalization.`;

const OUTPUT_SCHEMA = `## Output schema

Return ONLY:

{
  "verdicts": [
    { "candidatePath": "<name>", "kind": "keep-static",       "value": <any>, "observed": true,  "absentFrom": ["<pageHash>", ...] },
    { "candidatePath": "<name>", "kind": "keep-static",       "value": <any>, "observed": false, "absentFrom": ["<pageHash>", ...], "rationale": "<required>" },
    { "candidatePath": "<name>", "kind": "keep-dynamic",      "pattern": "<optional short label>", "rationale": "<required>" },
    { "candidatePath": "<name>", "kind": "demote",            "rationale": "<required>" },
    { "candidatePath": "<name>", "kind": "defer-to-operator", "rationale": "<required>" }
  ]
}

Every candidate listed below MUST appear in verdicts exactly once.
keep-dynamic verdicts MUST NOT carry a "value" key.`;

function buildVerdictsPrompt(
	renamed: PageTypeDigest,
	lastValidation: ValidationResult | null,
): string {
	const body = `${JSON_ONLY_PREAMBLE}

${VERDICT_GUIDE}

## Page type "${renamed.pagetype}" — ${renamed.totalPages} pages total

All page hashes: ${JSON.stringify(renamed.pageHashes)}

## Candidates (post-rename)

${renamed.candidates.map(describeCandidate).join("\n\n")}

${OUTPUT_SCHEMA}`;

	if (!lastValidation || lastValidation.valid) return body;
	return `${body}

---
PREVIOUS ATTEMPT REJECTED. Fix these issues:
${lastValidation.errors.map((e) => `  - ${e}`).join("\n")}`;
}

function describeCandidate(c: PageTypeDigest["candidates"][number]): string {
	const absent =
		c.absentFrom.length > 0
			? `  absentFrom (${c.absentFrom.length}): ${JSON.stringify(c.absentFrom)}`
			: "  absentFrom: []";
	const values = c.distinctValues
		.map(
			(dv) =>
				`    - value: ${truncateJson(dv.value)}  (on ${dv.pageHashes.length} page(s): ${JSON.stringify(dv.pageHashes)})`,
		)
		.join("\n");
	return `- ${c.candidatePath}
  presentOn (${c.presentOn.length}): ${JSON.stringify(c.presentOn)}
${absent}
  distinctValues:
${values}`;
}

function truncateJson(value: unknown, maxLen = 160): string {
	const s = JSON.stringify(value);
	if (s.length <= maxLen) return s;
	return `${s.slice(0, maxLen - 3)}...`;
}

function buildReviewerPrompt(
	renamed: PageTypeDigest,
	verdicts: VerdictTable,
): string {
	const candByPath = new Map(
		renamed.candidates.map((c) => [c.candidatePath, c]),
	);
	const lines: string[] = [];
	for (const v of verdicts) {
		const cand = candByPath.get(v.candidatePath);
		if (!cand) continue;
		lines.push(
			`- ${v.candidatePath} → ${v.kind}${describeVerdict(v)}  (observed: ${cand.distinctValues.map((dv) => truncateJson(dv.value, 60)).join(" | ")})`,
		);
	}

	return `You are reviewing the verdict set a prior agent produced for a chrome
harmonize step on page type "${renamed.pagetype}".

Your ONE job: catch semantic quality problems — cases where the verdict is
structurally valid but the JUDGMENT is wrong. Examples:

- A \`demote\` whose rationale says "per-page" but the values are clearly a
  shared chrome element (copyright notice, contact info, logo).
- A \`keep-dynamic\` whose values are plainly authored per-page content
  (e.g. an article headline, marketing copy) — should have been \`demote\`.
- A \`keep-dynamic\` that clearly has one shared value across all present
  pages — should have been \`keep-static\` with observed=true.
- A \`keep-static\` with \`observed: false\` whose normalization is
  unjustified or changes meaning (e.g. collapsing two genuinely different
  phone numbers to one; picking one address when pages list different
  locations).
- A \`keep-static\` where the single observed value is obviously per-page
  authorial content (a page title, a hero headline) — should have been
  \`demote\`.
- A \`defer-to-operator\` for values that are transparently equivalent modulo
  formatting (phone numbers, name spellings) — should have been
  \`keep-static\` with observed=false + rationale. Or for structurally
  per-page chrome (breadcrumbs, pagination) — should have been
  \`keep-dynamic\`.

Do NOT reject for coverage thresholds. The scraper is unreliable; sparse
coverage with agreed values is chrome.

Verdicts (one per candidate, structurally valid):

${lines.join("\n")}

Return a SHORT review — a single line beginning with exactly "VERDICT: pass"
or "VERDICT: reject", followed on subsequent lines by specific findings
(one per line, referencing candidate paths). If reject, findings MUST be
actionable: which candidate's verdict is wrong and how should it change.`;
}

function describeVerdict(v: Verdict): string {
	switch (v.kind) {
		case "keep-static":
			return ` (value=${truncateJson(v.value, 60)}, observed=${v.observed}, absentFrom=${v.absentFrom.length})`;
		case "keep-dynamic":
			return ` (pattern="${v.pattern ?? ""}", rationale="${v.rationale.slice(0, 60)}")`;
		case "demote":
		case "defer-to-operator":
			return ` (rationale="${v.rationale.slice(0, 80)}")`;
	}
}

#!/usr/bin/env bun
/**
 * CLI: review freeform suggest proposals for the align agent.
 *
 * The outer align agent calls `./suggest` to get freeform proposal text, then
 * `./review` to turn that text into structured accept/reject decisions. The
 * outer agent still owns the final call — it applies each decision via
 * `./ops-ify` — but now has a second opinion grounded in the same
 * digest/ops/rejects context.
 *
 * Usage:
 *   bun run review-align.ts            (zero-arg: autodiscovers inputs in cwd)
 *
 * Resolves inputs from the current attempt directory (process.cwd()):
 *   - digest.json        — candidate set for this batch
 *   - ops.json           — accepted rename ops so far
 *   - rejects.json       — clusters already rejected
 *   - signals.json       — (optional) structural signals
 *   - suggest-agent/<timestamp>/suggestions.txt — latest suggest output; the
 *     most recently modified wins.
 *
 * Stdout (single JSON object, always):
 *   No clusters to review (suggest was done, empty, or missing):
 *     { "decisions": [], "note": "<short>" }
 *   Reviewer produced verdicts:
 *     {
 *       "decisions": [
 *         { "paths": ["a","b"],
 *           "decision": "accept" | "reject",
 *           "suggestedCanonical"?: "a",
 *           "reason": "<short>" }
 *       ]
 *     }
 *
 * Exit code: always 0. Non-zero would bubble through `set -euo pipefail` in
 * the `./review` bash wrapper and the outer agent would see a shell error
 * instead of a JSON envelope it can parse.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../../../config.js";
import { resolveProfile } from "../../../engine/profile.js";
import { agentQueryWithMetrics } from "../../../lib/agent.js";
import { applyRenameTable } from "../lib/harmonize-rename.js";
import type {
	PageTypeDigest,
	RejectEntry,
	RichRenameOp,
	StructuralSignals,
} from "../lib/harmonize-types.js";
import { isDoneSuggestionText } from "../lib/suggest-text.js";

const REVIEW_SEGMENT = "classify";
const REVIEW_PHASE = "harmonize";
const REVIEW_STEP = "review-agent";
const SUB_AGENT_MAX_TURNS = 80;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReviewDecision {
	paths: string[];
	decision: "accept" | "reject";
	suggestedCanonical?: string;
	reason: string;
}

interface ReviewResult {
	decisions: ReviewDecision[];
	note?: string;
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const attemptDir = process.cwd();

	const digestPath = join(attemptDir, "digest.json");
	const opsPath = join(attemptDir, "ops.json");
	const rejectsPath = join(attemptDir, "rejects.json");
	const signalsPath = join(attemptDir, "signals.json");

	const digest = await readJson<PageTypeDigest>(digestPath);
	if (!digest.ok) return emitEmpty({ note: digest.error });

	const ops = await readJsonArray<RichRenameOp>(opsPath);
	if (!ops.ok) return emitEmpty({ note: ops.error });

	const rejects = await readJsonArray<RejectEntry>(rejectsPath);
	if (!rejects.ok) return emitEmpty({ note: rejects.error });

	let signals: StructuralSignals | null = null;
	if (existsSync(signalsPath)) {
		const sig = await readJson<StructuralSignals>(signalsPath);
		if (sig.ok) signals = sig.value;
	}

	const suggestionsPath = await findLatestSuggestions(attemptDir);
	if (!suggestionsPath) {
		return emitEmpty({
			note: "no suggest-agent/*/suggestions.txt found; run ./suggest first",
		});
	}

	const rawSuggestions = await tryReadFile(suggestionsPath);
	if (rawSuggestions === null || rawSuggestions.trim() === "") {
		return emitEmpty({
			note: `suggestions.txt at ${suggestionsPath} is empty`,
		});
	}
	if (isDoneSuggestionText(rawSuggestions)) {
		return emitEmpty({
			note: rawSuggestions.trim(),
		});
	}

	const flat = expandRichToFlat(ops.value, digest.value);
	const materialized = applyRenameTable(digest.value, flat);

	const result = await runReviewAgent({
		attemptDir,
		suggestionsText: rawSuggestions,
		materialized,
		original: digest.value,
		ops: ops.value,
		rejects: rejects.value,
		signals,
	});
	emitResult(result);
}

// ---------------------------------------------------------------------------
// Sub-agent
// ---------------------------------------------------------------------------

interface RunReviewArgs {
	attemptDir: string;
	suggestionsText: string;
	materialized: PageTypeDigest;
	original: PageTypeDigest;
	ops: RichRenameOp[];
	rejects: RejectEntry[];
	signals: StructuralSignals | null;
}

async function runReviewAgent(args: RunReviewArgs): Promise<ReviewResult> {
	const subDir = join(args.attemptDir, "review-agent", timestampId());
	await mkdir(subDir, { recursive: true });

	const suggestionsPath = join(subDir, "suggestions.txt");
	const materializedPath = join(subDir, "materialized-digest.json");
	const originalPath = join(subDir, "original-digest.json");
	const opsPath = join(subDir, "ops.json");
	const rejectsPath = join(subDir, "rejects.json");
	const decisionsPath = join(subDir, "decisions.json");

	await writeFile(suggestionsPath, `${args.suggestionsText.trim()}\n`);
	await writeFile(
		materializedPath,
		`${JSON.stringify(args.materialized, null, 2)}\n`,
	);
	await writeFile(originalPath, `${JSON.stringify(args.original, null, 2)}\n`);
	await writeFile(opsPath, `${JSON.stringify(args.ops, null, 2)}\n`);
	await writeFile(rejectsPath, `${JSON.stringify(args.rejects, null, 2)}\n`);
	if (args.signals) {
		await writeFile(
			join(subDir, "signals.json"),
			`${JSON.stringify(args.signals, null, 2)}\n`,
		);
	}
	await writeFile(decisionsPath, "");

	const configPath = findConfigPath(args.attemptDir);
	const config = loadConfig(configPath);
	const profile = resolveProfile(
		config,
		REVIEW_SEGMENT,
		REVIEW_PHASE,
		REVIEW_STEP,
	);

	const prompt = buildSubAgentPrompt(args.signals !== null);

	try {
		await agentQueryWithMetrics({
			prompt,
			cwd: subDir,
			profile,
			stepName: `${REVIEW_SEGMENT}/${REVIEW_PHASE}/${REVIEW_STEP}`,
			maxTurns: SUB_AGENT_MAX_TURNS,
			tools: ["Read", "Write", "Edit"],
			config,
		});
	} catch (err) {
		return {
			decisions: [],
			note: `review sub-agent failed: ${String(err)}`,
		};
	}

	const raw = await tryReadFile(decisionsPath);
	if (raw === null || raw.trim() === "") {
		return {
			decisions: [],
			note: "review sub-agent did not write decisions.json",
		};
	}

	const parsed = parseDecisions(raw);
	if (!parsed.ok) {
		await writeFile(
			join(subDir, "parse-error.txt"),
			`${parsed.error}\n\nraw:\n${raw}\n`,
		);
		return {
			decisions: [],
			note: `review sub-agent output invalid: ${parsed.error}`,
		};
	}
	return { decisions: parsed.value };
}

function buildSubAgentPrompt(hasSignals: boolean): string {
	const signalsLine = hasSignals
		? "- signals.json             — structural signals for the page type.\n"
		: "";
	return `You are the reviewer for freeform alias-merge suggestions.

A proposer already wrote freeform merge suggestions. Your job is to convert those suggestions into structured accept/reject decisions the outer agent can apply.

Files in your working directory:
- suggestions.txt          — freeform proposal text from the suggest step.
- original-digest.json     — candidate set before any ops were applied.
- materialized-digest.json — candidate set AFTER applying ops.json.
- ops.json                 — rename ops already accepted.
- rejects.json             — path-sets already rejected by the outer agent. Treat any cluster whose exact path-set matches as "reject" with reason "already in rejects.json".
${signalsLine}
## How to judge the proposals

Read suggestions.txt carefully and extract every concrete proposed merge set you can identify. Each decision you emit must name the exact paths you are judging.

ACCEPT when:
- Paths hold the same (or near-identical) values across pages.
- Names are clear variants of the same concept (e.g. \`footer.phone\` / \`footer.mobile\`, \`header.nav\` / \`header.navigation\`).
- Structural role matches (all leaves, all arrays, all objects of the same shape).

REJECT when:
- Values are positionally unstable across pages (e.g. \`[0]\` holds different items on different pages, or one page exposes a handle like \`@foo\` while another exposes a full URL like \`https://...\`).
- Paths live in semantically distinct locations (e.g. header vs footer) even with matching values.
- Evidence is thin — one shared value on one page isn't enough to fuse.
- Paths are structurally different (one is a leaf, the other is an object).

When in doubt, REJECT. A missing alias is recoverable by a later layer; a wrong alias fuses semantically distinct fields and is hard to undo.

## Output — write EXACTLY ONCE to ./decisions.json, then stop

Schema:
{
  "decisions": [
    {
      "paths": ["...", "..."],
      "decision": "accept",
      "suggestedCanonical": "<one of the paths>",
      "reason": "<one short sentence>"
    },
    {
      "paths": ["...", "..."],
      "decision": "reject",
      "reason": "<one short sentence>"
    }
  ]
}

Rules:
- Emit one decision per concrete merge proposal you acceptably extracted from suggestions.txt.
- Every path in every decision must exist in materialized-digest.json.
- Each decision must contain at least 2 paths.
- Sort paths lexically inside each decision.
- "accept" entries MUST include "suggestedCanonical" and it MUST be one of the paths in that cluster. Prefer the shortest path; ties broken by coverage in materialized-digest.json; ties broken by lexical order.
- "reject" entries MUST NOT include "suggestedCanonical".
- "reason" is a required string for every decision.
- Output must be valid JSON. Do NOT print anything to stdout. Do NOT write any other files. Write decisions.json once and stop.`;
}

// ---------------------------------------------------------------------------
// Output parsing + validation
// ---------------------------------------------------------------------------

type Parse<T> = { ok: true; value: T } | { ok: false; error: string };

function parseJsonObject(
	raw: string,
	label: string,
): Parse<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, error: `${label} is not valid JSON: ${String(err)}` };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { ok: false, error: `${label} must be a JSON object` };
	}
	return { ok: true, value: parsed as Record<string, unknown> };
}

function parseDecisions(raw: string): Parse<ReviewDecision[]> {
	const record = parseJsonObject(raw, "decisions.json");
	if (!record.ok) return record;
	if (!Array.isArray(record.value.decisions)) {
		return { ok: false, error: "'decisions' must be an array" };
	}
	const out: ReviewDecision[] = [];
	for (let i = 0; i < record.value.decisions.length; i++) {
		const parsed = parseOneDecision(record.value.decisions[i], i);
		if (!parsed.ok) return parsed;
		out.push(parsed.value);
	}
	return { ok: true, value: out };
}

function parseOneDecision(
	entry: unknown,
	index: number,
): Parse<ReviewDecision> {
	if (typeof entry !== "object" || entry === null) {
		return { ok: false, error: `decisions[${index}] must be an object` };
	}
	const obj = entry as Record<string, unknown>;
	const paths = parseDecisionPaths(obj.paths, index);
	if (!paths.ok) return paths;
	const decision = obj.decision;
	if (decision !== "accept" && decision !== "reject") {
		return {
			ok: false,
			error: `decisions[${index}].decision must be "accept" or "reject"`,
		};
	}
	const reason = typeof obj.reason === "string" ? obj.reason : "";
	if (decision === "reject") {
		return { ok: true, value: { paths: paths.value, decision, reason } };
	}
	const canonical = obj.suggestedCanonical;
	if (typeof canonical !== "string" || !paths.value.includes(canonical)) {
		return {
			ok: false,
			error: `decisions[${index}].suggestedCanonical must be one of the paths on accept`,
		};
	}
	return {
		ok: true,
		value: {
			paths: paths.value,
			decision: "accept",
			suggestedCanonical: canonical,
			reason,
		},
	};
}

function parseDecisionPaths(raw: unknown, index: number): Parse<string[]> {
	if (!Array.isArray(raw) || raw.length < 2) {
		return {
			ok: false,
			error: `decisions[${index}].paths must be an array of >=2 strings`,
		};
	}
	const paths: string[] = [];
	for (const p of raw) {
		if (typeof p !== "string" || p === "") {
			return {
				ok: false,
				error: `decisions[${index}].paths entries must be non-empty strings`,
			};
		}
		paths.push(p);
	}
	return { ok: true, value: [...new Set(paths)].sort() };
}

// ---------------------------------------------------------------------------
// Latest suggestions.txt discovery
// ---------------------------------------------------------------------------

async function findLatestSuggestions(
	attemptDir: string,
): Promise<string | null> {
	const suggestRoot = join(attemptDir, "suggest-agent");
	let entries: string[];
	try {
		entries = await readdir(suggestRoot);
	} catch {
		return null;
	}
	let best: { path: string; mtimeMs: number } | null = null;
	for (const name of entries) {
		const candidate = join(suggestRoot, name, "suggestions.txt");
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(candidate);
		} catch {
			continue;
		}
		if (!info.isFile()) continue;
		if (best === null || info.mtimeMs > best.mtimeMs) {
			best = { path: candidate, mtimeMs: info.mtimeMs };
		}
	}
	return best?.path ?? null;
}

// ---------------------------------------------------------------------------
// Ops expansion — copied verbatim from suggest-folds.ts
// ---------------------------------------------------------------------------

function expandRichToFlat(
	ops: RichRenameOp[],
	digest: PageTypeDigest,
): Array<{ from: string; to: string; reason: string }> {
	const flat: Array<{ from: string; to: string; reason: string }> = [];
	for (const op of ops) {
		if (op.kind === "flat") {
			flat.push({ from: op.from, to: op.to, reason: op.reason });
		} else if (op.kind === "subtree") {
			flat.push(...expandSubtree(op, digest));
		}
	}
	return flat;
}

function expandSubtree(
	op: { fromPrefix: string; toPrefix: string; reason: string },
	digest: PageTypeDigest,
): Array<{ from: string; to: string; reason: string }> {
	const out: Array<{ from: string; to: string; reason: string }> = [];
	for (const cand of digest.candidates) {
		if (!cand.candidatePath.startsWith(op.fromPrefix)) continue;
		const suffix = cand.candidatePath.slice(op.fromPrefix.length);
		if (!isSubtreeBoundary(suffix)) continue;
		out.push({
			from: cand.candidatePath,
			to: `${op.toPrefix}${suffix}`,
			reason: op.reason,
		});
	}
	return out;
}

function isSubtreeBoundary(suffix: string): boolean {
	return (
		suffix.length === 0 || suffix.startsWith(".") || suffix.startsWith("[")
	);
}

// ---------------------------------------------------------------------------
// File + config helpers — copied verbatim from suggest-folds.ts
// ---------------------------------------------------------------------------

type ReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

async function readJson<T>(path: string): Promise<ReadResult<T>> {
	try {
		const raw = await readFile(path, "utf-8");
		return { ok: true, value: JSON.parse(raw) as T };
	} catch (err) {
		return { ok: false, error: `failed to read/parse ${path}: ${String(err)}` };
	}
}

async function readJsonArray<T>(path: string): Promise<ReadResult<T[]>> {
	const parsed = await readJson<unknown>(path);
	if (!parsed.ok) return parsed;
	if (!Array.isArray(parsed.value)) {
		return { ok: false, error: `${path} must contain a JSON array` };
	}
	return { ok: true, value: parsed.value as T[] };
}

async function tryReadFile(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf-8");
	} catch {
		return null;
	}
}

function findConfigPath(startDir: string): string {
	let dir = resolve(startDir);
	while (true) {
		const candidate = join(dir, "cui.yaml");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error(`cui.yaml not found walking up from ${startDir}`);
		}
		dir = parent;
	}
}

function timestampId(): string {
	const iso = new Date().toISOString().replace(/[:.]/g, "-");
	const rand = Math.random().toString(36).slice(2, 8);
	return `${iso}-${rand}`;
}

// ---------------------------------------------------------------------------
// Stdout emitters
//
// Exit code contract: always 0 when we write a valid JSON envelope to stdout.
// Non-zero would bubble through `set -euo pipefail` in the `./review` wrapper
// and the outer align agent would see a shell error instead of the decisions
// payload. "Empty decisions with a note" is a legitimate terminal state.
// ---------------------------------------------------------------------------

function emitResult(result: ReviewResult): void {
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	process.exit(0);
}

function emitEmpty(args: { note: string }): void {
	process.stdout.write(
		`${JSON.stringify({ decisions: [], note: args.note }, null, 2)}\n`,
	);
	process.exit(0);
}

main().catch((err) => {
	process.stdout.write(
		`${JSON.stringify({ decisions: [], note: `cli crashed: ${String(err)}` }, null, 2)}\n`,
	);
	process.exit(0);
});

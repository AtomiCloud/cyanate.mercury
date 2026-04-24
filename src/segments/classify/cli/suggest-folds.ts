#!/usr/bin/env bun
/**
 * CLI: suggest alias-cluster candidates for the align agent.
 *
 * Reads the original digest, the accepted ops so far, and the rejects sidecar.
 * Materializes the current candidate set in memory (by applying ops to the
 * digest), writes a stripped LLM-facing view (paths, compact values, one
 * lightweight coverage signal), then spawns a fresh LLM sub-agent that reads
 * the stripped materialized digest + rejects and proposes more alias clusters.
 * The full materialized digest remains the source of truth for output
 * validation.
 *
 * Usage:
 *   bun run suggest-folds.ts <digest.json> <ops.json> <rejects.json>
 *
 * Stdout (single JSON object, always):
 *   On done: { "done": true, "reason": "<short>" }
 *   Otherwise: { "done": false, "note": "<short>" }
 *
 * Exit code: 0 on success; 1 on sub-agent failure / invalid output.
 *
 * Protocol: the outer align agent should run `./review` after any
 * `{done:false}` result. The suggest sub-agent writes freeform proposals to
 * `suggestions.txt`; the review sub-agent turns that text into structured
 * accept/reject decisions.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../../../config.js";
import { resolveProfile } from "../../../engine/profile.js";
import { agentQueryWithMetrics } from "../../../lib/agent.js";
import { applyRenameTable } from "../lib/harmonize-rename.js";
import type {
	PageTypeDigest,
	RejectEntry,
	RichRenameOp,
	SuggestResult,
} from "../lib/harmonize-types.js";
import {
	interpretSuggestionsText,
	stripDigestForSuggest,
} from "../lib/suggest-text.js";

const SUGGEST_SEGMENT = "classify";
const SUGGEST_PHASE = "harmonize";
const SUGGEST_STEP = "suggest-agent";
const SUB_AGENT_MAX_TURNS = 80;

async function main(): Promise<void> {
	const [, , digestPath, opsPath, rejectsPath] = process.argv;
	if (!digestPath || !opsPath || !rejectsPath) {
		console.error(
			"usage: suggest-folds <digest.json> <ops.json> <rejects.json>",
		);
		process.exit(2);
	}

	const digest = await readJson<PageTypeDigest>(digestPath);
	if (!digest.ok) return emitDone({ error: digest.error });

	const ops = await readJsonArray<RichRenameOp>(opsPath);
	if (!ops.ok) return emitDone({ error: ops.error });

	const rejects = await readJsonArray<RejectEntry>(rejectsPath);
	if (!rejects.ok) return emitDone({ error: rejects.error });

	const flat = expandRichToFlat(ops.value, digest.value);
	const materialized = applyRenameTable(digest.value, flat);

	if (materialized.candidates.length < 2) {
		return emitResult({
			done: true,
			reason: "fewer than 2 candidates remain after applying ops",
		});
	}

	const result = await runSuggestAgent(materialized, rejects.value);
	emitResult(result);
}

// ---------------------------------------------------------------------------
// Sub-agent
// ---------------------------------------------------------------------------

async function runSuggestAgent(
	materialized: PageTypeDigest,
	rejects: RejectEntry[],
): Promise<SuggestResult> {
	const attemptDir = process.cwd();
	const subDir = join(attemptDir, "suggest-agent", timestampId());
	await mkdir(subDir, { recursive: true });

	const materializedPath = join(subDir, "materialized-digest.stripped.json");
	const rejectsPath = join(subDir, "rejects.json");
	const suggestionsPath = join(subDir, "suggestions.txt");

	await writeFile(
		materializedPath,
		`${JSON.stringify(stripDigestForSuggest(materialized), null, 2)}\n`,
	);
	await writeFile(rejectsPath, `${JSON.stringify(rejects, null, 2)}\n`);
	await writeFile(suggestionsPath, "");

	const configPath = findConfigPath(attemptDir);
	const config = loadConfig(configPath);
	const profile = resolveProfile(
		config,
		SUGGEST_SEGMENT,
		SUGGEST_PHASE,
		SUGGEST_STEP,
	);

	const prompt = buildSubAgentPrompt();

	try {
		await agentQueryWithMetrics({
			prompt,
			cwd: subDir,
			profile,
			stepName: `${SUGGEST_SEGMENT}/${SUGGEST_PHASE}/${SUGGEST_STEP}`,
			maxTurns: SUB_AGENT_MAX_TURNS,
			tools: ["Read", "Write", "Edit"],
			config,
		});
	} catch (err) {
		return {
			done: true,
			reason: `suggest sub-agent failed: ${String(err)}`,
		};
	}

	const raw = await tryReadFile(suggestionsPath);
	if (raw === null || raw.trim() === "") {
		return {
			done: true,
			reason: "suggest sub-agent did not write suggestions.txt",
		};
	}

	const interpreted = interpretSuggestionsText(raw);
	if (interpreted.done) {
		return { done: true, reason: interpreted.reason };
	}
	return {
		done: false,
		note: "suggestions written to suggest-agent/*/suggestions.txt",
	};
}

function buildSubAgentPrompt(): string {
	return `You are proposing alias clusters for a chrome-candidate digest.

Read these files in your working directory:
- materialized-digest.stripped.json — candidates still live after the ops accepted so far.
  Each entry has: candidatePath, coverage, and values. Raw page hashes and bookkeeping fields are intentionally stripped.
- rejects.json              — cluster path-sets already rejected. Do NOT re-suggest any cluster whose exact path-set appears here.

A proposal is freeform text describing paths that look like the same field. Use any visible evidence — shared values, naming similarity, and the shape implied by the values themselves. Asymmetric coverage is fine: one side appearing on page A and the other on page B is still a plausible merge if the values tell you they're the same field.

Only group paths you are confident are the same field. When in doubt, skip. The outer agent reviews your output, accepts good clusters, and passes bad ones back as rejects — but wasting its time on implausible guesses costs more than missing a subtle alias.

Rules:
- Every path you mention MUST appear in materialized-digest.stripped.json (exact string match on candidatePath).
- Do NOT re-propose any path-set whose exact set appears in rejects.json.
- Do not output JSON.

Write your proposal to ./suggestions.txt exactly once, then stop.

If you find plausible merges, write short plain text like:

Possible merge:
- a
- b
Why: one short sentence

Possible merge:
- c
- d
- e
Why: one short sentence

If you find nothing worth proposing, write exactly one line:

DONE: <one short sentence>

Output must be plain text. Do NOT print anything to stdout. Do NOT write any other files. Write suggestions.txt once and stop.`;
}

// ---------------------------------------------------------------------------
// Ops expansion (unchanged from prior revision)
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
		// element-key ops are sidecars that don't rename paths — skipped here.
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
// File + config helpers
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
// Exit code contract: always 0 when we write a valid JSON envelope to stdout,
// even on input-file errors. The bash wrapper uses `set -euo pipefail`, and a
// non-zero exit would make the outer align agent see a shell error instead of
// the `{done: true, reason}` payload we just emitted. "Done with a reason" is
// a legitimate terminal state the agent can parse and move on from.
// ---------------------------------------------------------------------------

function emitResult(result: SuggestResult): void {
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	process.exit(0);
}

function emitDone(args: { error: string }): void {
	process.stdout.write(
		`${JSON.stringify({ done: true, reason: args.error }, null, 2)}\n`,
	);
	process.exit(0);
}

main().catch((err) => {
	process.stdout.write(
		`${JSON.stringify({ done: true, reason: `cli crashed: ${String(err)}` }, null, 2)}\n`,
	);
	process.exit(0);
});

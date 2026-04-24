#!/usr/bin/env bun
/**
 * CLI: append one accepted alias cluster to the agent's ops.json.
 *
 * Usage:
 *   bun run ops-ify.ts <ops.json> <cluster.json>
 *   - Reads cluster.json ({paths, suggestedCanonical, reason?}), asks the
 *     domain-ops generator to produce the matching `RichRenameOp[]`, and
 *     appends them to ops.json.
 *
 * Stdout (JSON): { "ok": true, "mode": "accept", "opsAdded"?: N }
 *   or { "ok": false, "error": "..." }.
 * Exit code: 0 on success, 1 on failure.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../../../config.js";
import { resolveProfile } from "../../../engine/profile.js";
import type { CuiConfig, LLMProfile } from "../../../engine/types.js";
import { agentQueryWithMetrics } from "../../../lib/agent.js";
import {
	type DomainDescriptor,
	type GenerateAgentRole,
	type GenerateRunAgentFn,
	generateDomainOps,
} from "../lib/domain-ops-generator.js";
import type { RichRenameOp } from "../lib/harmonize-types.js";

const OPSIFY_SEGMENT = "classify";
const OPSIFY_PHASE = "harmonize-align";
const OPSIFY_STEP_BY_ROLE: Record<GenerateAgentRole, string> = {
	generate: "ops-ify-generate",
	"review-a": "ops-ify-review-a",
	"review-b": "ops-ify-review-b",
};
const OPSIFY_MAX_TURNS = 30;

interface AcceptCluster {
	paths: string[];
	suggestedCanonical: string;
	reason?: string;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length < 2) {
		emitError("usage: ops-ify <ops.json> <cluster.json>");
		return;
	}

	const [opsPath, clusterPath] = args;
	if (!opsPath || !clusterPath) {
		emitError("accept mode requires <ops.json> <cluster.json>");
		return;
	}
	await runAccept(opsPath, clusterPath);
}

async function runAccept(opsPath: string, clusterPath: string): Promise<void> {
	const cluster = await readJson<AcceptCluster>(clusterPath);
	if (!cluster.ok) {
		emitError(cluster.error);
		return;
	}
	if (
		!cluster.value.suggestedCanonical ||
		!Array.isArray(cluster.value.paths)
	) {
		emitError(
			"cluster.json must have {paths: string[], suggestedCanonical: string, reason?: string}",
		);
		return;
	}

	let newOps: RichRenameOp[];
	try {
		newOps = await acceptedClusterToOps(cluster.value);
	} catch (err) {
		emitError(`domain-ops generator failed: ${String(err)}`);
		return;
	}

	const existing = await readJsonArray<RichRenameOp>(opsPath);
	if (!existing.ok) {
		emitError(existing.error);
		return;
	}
	const merged = [...existing.value, ...newOps];
	await writeFile(opsPath, `${JSON.stringify(merged, null, 2)}\n`);
	emitOk({ mode: "accept", opsAdded: newOps.length });
}

async function acceptedClusterToOps(
	cluster: AcceptCluster,
): Promise<RichRenameOp[]> {
	const attemptDir = process.cwd();
	const config = loadConfig(findConfigPath(attemptDir));
	const profilesByRole: Record<GenerateAgentRole, LLMProfile> = {
		generate: resolveRoleProfile(config, "generate"),
		"review-a": resolveRoleProfile(config, "review-a"),
		"review-b": resolveRoleProfile(config, "review-b"),
	};
	const runAgent: GenerateRunAgentFn = (args) =>
		agentQueryWithMetrics({
			prompt: args.prompt,
			cwd: args.workdir,
			profile: profilesByRole[args.role],
			stepName: `classify/harmonize-align/${OPSIFY_STEP_BY_ROLE[args.role]}#${args.attempt}`,
			maxTurns: profilesByRole[args.role].maxTurns ?? OPSIFY_MAX_TURNS,
			config,
		});
	const result = await generateDomainOps<RichRenameOp>({
		intent: buildAcceptedClusterIntent(cluster),
		domain: RICH_RENAME_OP_DOMAIN,
		runAgent,
		workdir: join(attemptDir, "ops-module"),
	});
	return result.ops;
}

function resolveRoleProfile(
	config: CuiConfig,
	role: GenerateAgentRole,
): LLMProfile {
	return resolveProfile(
		config,
		OPSIFY_SEGMENT,
		OPSIFY_PHASE,
		OPSIFY_STEP_BY_ROLE[role],
	);
}

const RICH_RENAME_OP_DOMAIN: DomainDescriptor = {
	name: "rich rename",
	opSchema: `{"ops":[
  {"kind":"flat","from":"<candidate path>","to":"<canonical path>","reason":"<short>"},
  {"kind":"subtree","fromPrefix":"<source prefix>","toPrefix":"<canonical prefix>","reason":"<short>"},
  {"kind":"element-key","arrayPath":"<path ending in [*]>","identifyBy":"<field>","renames":{"<observed>":"<canonical>"},"reason":"<short>"}
]}`,
	extraInstructions: `Generate only the op(s) for this one accepted alias cluster.
- Use flat ops for terminal/path-specific renames.
- Use subtree ops only when all affected descendants share the same suffix and the prefix rewrite is equivalent to many flat ops.
- Use one op per non-canonical source unless one subtree op safely covers that source family.
- Do not generate ops for the suggested canonical itself.`,
};

function buildAcceptedClusterIntent(cluster: AcceptCluster): string {
	return `Accepted harmonize alias cluster.

Cluster:
${JSON.stringify(cluster, null, 2)}

Intent:
Append the RichRenameOp entries needed to rename every non-canonical path in
"paths" to "suggestedCanonical". Preserve this accepted cluster as one isolated
intent; do not add operations for paths outside the cluster.`;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

async function readJson<T>(path: string): Promise<Parsed<T>> {
	try {
		const raw = await readFile(path, "utf-8");
		return { ok: true, value: JSON.parse(raw) as T };
	} catch (err) {
		return { ok: false, error: `failed to read/parse ${path}: ${String(err)}` };
	}
}

async function readJsonArray<T>(path: string): Promise<Parsed<T[]>> {
	const parsed = await readJson<unknown>(path);
	if (!parsed.ok) return parsed;
	if (!Array.isArray(parsed.value)) {
		return { ok: false, error: `${path} must contain a JSON array` };
	}
	return { ok: true, value: parsed.value as T[] };
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

function emitOk(out: { mode: "accept"; opsAdded?: number }): void {
	process.stdout.write(`${JSON.stringify({ ok: true, ...out }, null, 2)}\n`);
	process.exit(0);
}

function emitError(msg: string): void {
	process.stdout.write(
		`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`,
	);
	process.exit(1);
}

main().catch((err) => {
	emitError(`cli crashed: ${String(err)}`);
});

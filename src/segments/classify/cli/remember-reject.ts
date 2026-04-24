#!/usr/bin/env bun
/**
 * CLI: append one rejected cluster to rejects.json.
 *
 * Usage:
 *   bun run remember-reject.ts <rejects.json> <reject.json>
 *
 * `reject.json` must contain:
 *   { "paths": ["a", "b"], "reason"?: "..." }
 */

import { readFile, writeFile } from "node:fs/promises";
import type { RejectEntry } from "../lib/harmonize-types.js";
import { appendRejectEntry } from "../lib/rejects.js";

interface RejectInput {
	paths: string[];
	reason?: string;
}

async function main(): Promise<void> {
	const [rejectsPath, rejectPath] = process.argv.slice(2);
	if (!rejectsPath || !rejectPath) {
		emitError("usage: remember-reject <rejects.json> <reject.json>");
		return;
	}

	const existing = await readJsonArray<RejectEntry>(rejectsPath);
	if (!existing.ok) {
		emitError(existing.error);
		return;
	}
	const next = await readJson<RejectInput>(rejectPath);
	if (!next.ok) {
		emitError(next.error);
		return;
	}

	let merged: RejectEntry[];
	try {
		merged = appendRejectEntry(existing.value, next.value);
	} catch (err) {
		emitError(String(err));
		return;
	}
	await writeFile(rejectsPath, `${JSON.stringify(merged, null, 2)}\n`);
	process.stdout.write(
		`${JSON.stringify({ ok: true, mode: "reject" }, null, 2)}\n`,
	);
	process.exit(0);
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

function emitError(msg: string): void {
	process.stdout.write(
		`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`,
	);
	process.exit(1);
}

main().catch((err) => {
	emitError(`cli crashed: ${String(err)}`);
});

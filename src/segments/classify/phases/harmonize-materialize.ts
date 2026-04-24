/**
 * Phase 3e — `harmonize-materialize`
 *
 * Programmatic. Slots between `harmonize-align` and
 * `harmonize-verdicts`. For each pagetype, reads the composed rename table
 * and every per-page `chrome.json`, then writes:
 *
 *   classify-output/<pagetype>/chrome.aligned/<pageHash>.json
 *   classify-output/<pagetype>/chrome.aligned/<pageHash>.reverse.json
 *   classify-output/<pagetype>/chrome.aligned/<pageHash>.conflicts.json  (only when non-empty)
 *   classify-output/<pagetype>/chrome.compressed.json
 *
 * The aligned file is the per-page chrome with the composed renames
 * applied; the reverse map makes clean renames invertible per page (the
 * global composed table is many-to-one, but a single page only ever
 * instantiates ONE variant out of the N aliases, so the mapping is
 * bijective on that page). Conflicts and dedupes are recorded separately
 * per the user-specified policy — same-value collisions dedupe + note,
 * different-value collisions emit a conflict entry but never halt.
 *
 * The compressed artifact is a pagetype-wide debug view — a path-keyed
 * aggregation mirroring the digest shape so alignment gaps (two paths
 * present that should have been merged) are visible at a glance.
 *
 * Round-trip assertion: for every `reverseMap` entry, aligned[canonical]
 * must deep-equal original[source]. Failure halts the phase — this is a
 * correctness invariant, not a user-reviewable concern.
 */

import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type {
	PhaseDef,
	StepContext,
	StepResult,
} from "../../../engine/types.js";
import { programmaticStep } from "../../../steps/step.js";
import {
	applyRenameToChrome,
	buildCompressedChrome,
	type ConflictNote,
	type DedupeNote,
	indexRenameTable,
	verifyRoundTrip,
} from "../lib/chrome-materialize.js";
import type { RenameTable } from "../lib/harmonize-types.js";

export const harmonizeMaterializePhase: PhaseDef = {
	id: "harmonize-materialize",
	name: "Harmonize materialize",
	description:
		"Apply the composed rename table to each page's chrome.json; write per-page aligned chrome + reverse map + a pagetype-wide compressed debug view. Programmatic, deterministic.",
	maxRetries: 0,
	steps: [
		programmaticStep({
			id: "harmonize-materialize",
			name: "Harmonize materialize",
			description:
				"Materialize per-page aligned chrome from the composed rename table.",
			run: runHarmonizeMaterialize,
		}),
	],
};

interface ComposedFlatRenameTable {
	entries: unknown[];
	flat: RenameTable;
}

async function runHarmonizeMaterialize(ctx: StepContext): Promise<StepResult> {
	const start = Date.now();
	const inputRoot = join(ctx.workdir, "classify-input");
	const outputRoot = join(ctx.workdir, "classify-output");

	const pagetypes = await safeReaddir(outputRoot);
	if (pagetypes.length === 0) {
		return {
			status: "fail",
			error: "harmonize-materialize: no pagetypes found under classify-output/",
			duration: Date.now() - start,
		};
	}

	const failures: string[] = [];
	let processed = 0;

	for (const pagetype of pagetypes) {
		const result = await materializePagetype({
			pagetype,
			ptOutDir: join(outputRoot, pagetype),
			ptInDir: join(inputRoot, pagetype),
		});
		failures.push(...result.failures);
		if (result.processed) processed++;
	}

	return finalizeResult({ start, failures, processed });
}

function finalizeResult(args: {
	start: number;
	failures: string[];
	processed: number;
}): StepResult {
	const duration = Date.now() - args.start;
	if (args.failures.length > 0) {
		return {
			status: "fail",
			error: `harmonize-materialize failed for ${args.failures.length} page(s):\n${args.failures.join("\n")}`,
			duration,
		};
	}
	if (args.processed === 0) {
		return {
			status: "fail",
			error:
				"harmonize-materialize: no pagetypes produced aligned output — check classify-output/*/rename-table.composed.json and classify-input/*/*/output/chrome.json",
			duration,
		};
	}
	return { status: "pass", duration };
}

interface PagetypeResult {
	processed: boolean;
	failures: string[];
}

async function materializePagetype(args: {
	pagetype: string;
	ptOutDir: string;
	ptInDir: string;
}): Promise<PagetypeResult> {
	const isDir = await directoryExists(args.ptOutDir);
	if (!isDir) return { processed: false, failures: [] };

	const renameTable = await loadComposedRenameTable(args.ptOutDir);
	if (renameTable === null) return { processed: false, failures: [] };

	const hashes = await safeReaddir(args.ptInDir);
	if (hashes.length === 0) return { processed: false, failures: [] };

	const renameIndex = indexRenameTable(renameTable);
	const alignedDir = join(args.ptOutDir, "chrome.aligned");
	await rm(alignedDir, { recursive: true, force: true });
	await mkdir(alignedDir, { recursive: true });

	const perPageAligned: Record<string, unknown> = {};
	const perPageIssues: Record<
		string,
		{ conflicts: ConflictNote[]; dedupes: DedupeNote[] }
	> = {};
	const failures: string[] = [];

	for (const pageHash of hashes) {
		const outcome = await materializePage({
			pagetype: args.pagetype,
			pageHash,
			ptInDir: args.ptInDir,
			alignedDir,
			renameIndex,
		});
		if (outcome.kind === "failure") {
			failures.push(outcome.error);
			continue;
		}
		if (outcome.kind === "ok") {
			perPageAligned[pageHash] = outcome.aligned;
			perPageIssues[pageHash] = {
				conflicts: outcome.conflicts,
				dedupes: outcome.dedupes,
			};
		}
	}

	if (Object.keys(perPageAligned).length === 0) {
		return { processed: false, failures };
	}

	const compressed = buildCompressedChrome(perPageAligned, perPageIssues);
	await writeFile(
		join(args.ptOutDir, "chrome.compressed.json"),
		`${JSON.stringify(compressed, null, 2)}\n`,
	);
	return { processed: true, failures };
}

type PageOutcome =
	| {
			kind: "ok";
			aligned: unknown;
			conflicts: ConflictNote[];
			dedupes: DedupeNote[];
	  }
	| { kind: "skip" }
	| { kind: "failure"; error: string };

async function materializePage(args: {
	pagetype: string;
	pageHash: string;
	ptInDir: string;
	alignedDir: string;
	renameIndex: ReturnType<typeof indexRenameTable>;
}): Promise<PageOutcome> {
	const chromePath = join(args.ptInDir, args.pageHash, "output", "chrome.json");
	let chrome: unknown;
	try {
		const raw = await readFile(chromePath, "utf-8");
		chrome = JSON.parse(raw);
	} catch {
		return { kind: "skip" };
	}

	const result = applyRenameToChrome(chrome, args.renameIndex);
	const rt = verifyRoundTrip(chrome, result.aligned, result.reverseMap);
	if (!rt.ok) {
		const first = rt.mismatches[0];
		return {
			kind: "failure",
			error: `${args.pagetype}/${args.pageHash}: round-trip verification failed — ${rt.mismatches.length} mismatch(es). First: canonical="${first.canonical}" source="${first.source}"`,
		};
	}

	await writeFile(
		join(args.alignedDir, `${args.pageHash}.json`),
		`${JSON.stringify(result.aligned, null, 2)}\n`,
	);
	await writeFile(
		join(args.alignedDir, `${args.pageHash}.reverse.json`),
		`${JSON.stringify(result.reverseMap, null, 2)}\n`,
	);
	if (result.conflicts.length > 0 || result.dedupeNotes.length > 0) {
		await writeFile(
			join(args.alignedDir, `${args.pageHash}.conflicts.json`),
			`${JSON.stringify(
				{ conflicts: result.conflicts, dedupes: result.dedupeNotes },
				null,
				2,
			)}\n`,
		);
	}
	return {
		kind: "ok",
		aligned: result.aligned,
		conflicts: result.conflicts,
		dedupes: result.dedupeNotes,
	};
}

async function directoryExists(path: string): Promise<boolean> {
	try {
		const st = await stat(path);
		return st.isDirectory();
	} catch {
		return false;
	}
}

async function loadComposedRenameTable(
	ptOutDir: string,
): Promise<RenameTable | null> {
	const composedPath = join(ptOutDir, "rename-table.composed.json");
	try {
		const raw = await readFile(composedPath, "utf-8");
		const parsed = JSON.parse(raw) as ComposedFlatRenameTable | RenameTable;
		return Array.isArray(parsed) ? parsed : parsed.flat;
	} catch {
		return null;
	}
}

async function safeReaddir(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

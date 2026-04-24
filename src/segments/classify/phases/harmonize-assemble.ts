/**
 * Phase 3d — `harmonize-assemble`
 *
 * Programmatic. Loads `digest.json` + `rename-table.json` + `verdicts.json`
 * per pagetype and deterministically builds the canonical chrome tree +
 * per-page mappers + meta / value-conflicts artifacts. No LLM.
 *
 * Output shape matches what `chrome-verify` (Stage 4) consumes today, so
 * downstream phases need no change:
 *   - classify-output/<pagetype>/chrome.json
 *   - classify-output/<pagetype>/chrome-fields.json
 *   - classify-output/<pagetype>/harmonize-meta.json
 *   - classify-output/<pagetype>/value-conflicts.json
 *   - classify-output/<pagetype>/fold-meta/<hash>.json
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	PhaseDef,
	StepContext,
	StepResult,
} from "../../../engine/types.js";
import { programmaticStep } from "../../../steps/step.js";
import {
	type AssembleInput,
	assemble,
	validateAssembled,
} from "../lib/harmonize-assembler.js";
import { applyRenameTable } from "../lib/harmonize-rename.js";
import type {
	PageTypeDigest,
	RenameTable,
	VerdictTable,
} from "../lib/harmonize-types.js";
import { discoverPagetypeDirs, readDigest } from "./harmonize-shared.js";

export const harmonizeAssemblePhase: PhaseDef = {
	id: "harmonize-assemble",
	name: "Harmonize assemble",
	description:
		"Deterministically build canonical chrome + per-page mappers from verdicts.json. No LLM.",
	maxRetries: 0,
	steps: [
		programmaticStep({
			id: "harmonize-assemble",
			name: "Harmonize assemble",
			description:
				"Per pagetype: assemble canonical tree, chrome fields, mappers; write chrome.json et al.",
			run: runAssemble,
		}),
	],
};

async function runAssemble(ctx: StepContext): Promise<StepResult> {
	const start = Date.now();
	const pagetypes = await discoverPagetypeDirs(ctx.workdir);
	if (pagetypes.length === 0) {
		return {
			status: "fail",
			error:
				"harmonize-assemble: no pagetype digests found; harmonize-prepare must run first",
			duration: Date.now() - start,
		};
	}

	const failures: string[] = [];

	for (const pt of pagetypes) {
		try {
			await assembleOnePagetype(ctx, pt);
		} catch (err) {
			failures.push(`${pt.pagetype}: ${String(err)}`);
		}
	}

	const duration = Date.now() - start;
	if (failures.length > 0) {
		return {
			status: "fail",
			error: `harmonize-assemble failed:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
			duration,
		};
	}
	return { status: "pass", duration };
}

async function assembleOnePagetype(
	ctx: StepContext,
	pt: { pagetype: string; outDir: string },
): Promise<void> {
	const digest: PageTypeDigest = await readDigest(pt.outDir);
	// Single-page pagetypes skip harmonize-verdicts, so there's no verdicts.json
	// to assemble from. Leave them alone — cross-pagetype harmonization will
	// pick these up later. chrome-verify also skips pagetypes without chrome.json.
	if (digest.totalPages <= 1) {
		return;
	}
	const renameTable: RenameTable = await readJsonOr<RenameTable>(
		join(pt.outDir, "rename-table.json"),
		[],
	);
	const verdicts: VerdictTable = await readJsonOr<VerdictTable>(
		join(pt.outDir, "verdicts.json"),
		null as unknown as VerdictTable,
	);
	if (!verdicts) {
		throw new Error(
			`no verdicts.json in ${pt.outDir} — harmonize-verdicts must run first`,
		);
	}

	const renamed = applyRenameTable(digest, renameTable);

	// Build per-page source-path → candidate-path index so the assembler can
	// produce mapper entries per page. Re-scan classify-input to recover the
	// original content + chromePaths per hash.
	const pageContents = await loadPageContents(ctx.workdir, pt.pagetype);

	const input: AssembleInput = {
		pagetype: pt.pagetype,
		renamedDigest: renamed,
		verdicts,
		preRenameDigest: digest,
		renameTable,
		pageContents,
	};
	const result = assemble(input);

	const postValidation = validateAssembled(
		result,
		verdicts,
		new Map(
			[...pageContents.entries()].map(([h, v]) => [
				h,
				{ content: v.content, sourcePaths: v.sourcePaths },
			]),
		),
	);
	if (!postValidation.valid) {
		throw new Error(
			`post-assembly validation failed:\n${postValidation.errors.map((e) => `  - ${e}`).join("\n")}`,
		);
	}

	await writeFile(
		join(pt.outDir, "chrome.json"),
		JSON.stringify(result.canonical, null, 2),
	);
	await writeFile(
		join(pt.outDir, "chrome-dynamic.json"),
		JSON.stringify(result.chromeDynamic, null, 2),
	);
	await writeFile(
		join(pt.outDir, "chrome-fields.json"),
		JSON.stringify(result.chromeFields, null, 2),
	);
	await writeFile(
		join(pt.outDir, "harmonize-meta.json"),
		JSON.stringify(result.meta, null, 2),
	);
	await writeFile(
		join(pt.outDir, "value-conflicts.json"),
		JSON.stringify(result.valueConflicts, null, 2),
	);

	const foldDir = join(pt.outDir, "fold-meta");
	await rm(foldDir, { recursive: true, force: true });
	await mkdir(foldDir, { recursive: true });
	for (const mapper of result.pageMappers) {
		await writeFile(
			join(foldDir, `${mapper.hash}.json`),
			JSON.stringify(mapper, null, 2),
		);
	}
}

async function loadPageContents(
	workdir: string,
	pagetype: string,
): Promise<
	Map<
		string,
		{
			url: string;
			content: unknown;
			sourcePaths: Array<{ sourcePath: string; candidatePath: string }>;
		}
	>
> {
	const root = join(workdir, "classify-input", pagetype);
	const { readdir } = await import("node:fs/promises");
	let hashes: string[];
	try {
		hashes = await readdir(root);
	} catch {
		return new Map();
	}
	const out = new Map<
		string,
		{
			url: string;
			content: unknown;
			sourcePaths: Array<{ sourcePath: string; candidatePath: string }>;
		}
	>();
	for (const hash of hashes) {
		const pageDir = join(root, hash);
		try {
			const raw = await readFile(join(pageDir, "content.json"), "utf-8");
			const { url, content } = JSON.parse(raw) as {
				url: string;
				content: unknown;
			};
			const classifyRaw = await readFile(
				join(pageDir, "output", "chrome-classify.json"),
				"utf-8",
			);
			const classify = JSON.parse(classifyRaw) as {
				chromePaths: Array<{ sourcePath: string; suggestedCanonical?: string }>;
			};
			const sourcePaths = classify.chromePaths.map((e) => ({
				sourcePath: e.sourcePath,
				candidatePath: e.suggestedCanonical ?? e.sourcePath,
			}));
			out.set(hash, { url, content, sourcePaths });
		} catch {
			// skip pages without the expected outputs
		}
	}
	return out;
}

async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
	try {
		const raw = await readFile(path, "utf-8");
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

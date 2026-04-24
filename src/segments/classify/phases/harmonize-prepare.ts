/**
 * Phase 3a — `harmonize-prepare`
 *
 * Programmatic. Scans `<workdir>/classify-input/<pagetype>/<hash>/` for every
 * pagetype and builds a `PageTypeDigest` + flat `OccurrenceTable` using
 * `buildPageTypeDigest`. Writes both JSON files under
 * `classify-output/<pagetype>/`.
 *
 * No LLM, no judgment. Pure organization of what chrome-classify produced
 * so the two LLM phases (3b/3c) can reason over a stable compact shape.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	PhaseDef,
	StepContext,
	StepResult,
} from "../../../engine/types.js";
import { programmaticStep } from "../../../steps/step.js";
import {
	type BuildDigestInput,
	buildPageTypeDigest,
	type HarmonizePageInput,
} from "../lib/harmonize-occurrence.js";

export const harmonizePreparePhase: PhaseDef = {
	id: "harmonize-prepare",
	name: "Harmonize prepare",
	description:
		"Build per-pagetype occurrence tables + value digests from chrome-classify outputs. Programmatic, deterministic.",
	maxRetries: 0,
	steps: [
		programmaticStep({
			id: "harmonize-prepare",
			name: "Harmonize prepare",
			description:
				"For each pagetype: load per-page shape-normalized chrome outputs (fallback raw chrome-classify), emit digest.json + occurrence-table.json.",
			run: runHarmonizePrepare,
		}),
	],
};

async function runHarmonizePrepare(ctx: StepContext): Promise<StepResult> {
	const start = Date.now();
	const root = join(ctx.workdir, "classify-input");
	const pagetypes = await safeReaddir(root);
	if (pagetypes.length === 0) {
		return {
			status: "fail",
			error: "harmonize-prepare: no pagetypes found under classify-input/",
			duration: Date.now() - start,
		};
	}

	const failures: string[] = [];
	let processed = 0;

	for (const pagetype of pagetypes) {
		const ptDir = join(root, pagetype);
		const hashes = await safeReaddir(ptDir);
		const pages: HarmonizePageInput[] = [];
		for (const hash of hashes) {
			const pageDir = join(ptDir, hash);
			const page = await loadPageForHarmonizePrepare(pageDir, hash);
			if (page) pages.push(page);
		}
		if (pages.length === 0) continue;

		const input: BuildDigestInput = { pagetype, pages };
		const { digest, occurrenceTable, signals } = buildPageTypeDigest(input);

		const outDir = join(ctx.workdir, "classify-output", pagetype);
		await mkdir(outDir, { recursive: true });
		await writeFile(
			join(outDir, "digest.json"),
			JSON.stringify(digest, null, 2),
		);
		await writeFile(
			join(outDir, "occurrence-table.json"),
			JSON.stringify(occurrenceTable, null, 2),
		);
		await writeFile(
			join(outDir, "structural-signals.json"),
			JSON.stringify(signals, null, 2),
		);
		processed++;
	}

	const duration = Date.now() - start;
	if (failures.length > 0) {
		return {
			status: "fail",
			error: `harmonize-prepare failed for ${failures.length} pagetype(s):\n${failures.join("\n")}`,
			duration,
		};
	}
	if (processed === 0) {
		return {
			status: "fail",
			error:
				"harmonize-prepare: no pagetypes produced a digest — check classify-input/*/*/output/shape-normalized-chrome.materialized.json + provenance, or fallback output/shape-normalized-chrome.json / output/chrome-classify.json",
			duration,
		};
	}
	return { status: "pass", duration };
}

export async function loadPageForHarmonizePrepare(
	pageDir: string,
	hash: string,
): Promise<HarmonizePageInput | null> {
	let contentJson: { url: string; content: unknown };
	try {
		const raw = await readFile(join(pageDir, "content.json"), "utf-8");
		contentJson = JSON.parse(raw);
	} catch {
		return null;
	}

	const materialized = await readPreferredMaterializedShape(pageDir);
	if (materialized) {
		return {
			hash,
			url: contentJson.url,
			content: materialized.chrome,
			chromePaths: materialized.chromePaths,
		};
	}

	let classifyJson: {
		chromePaths: Array<{ sourcePath: string; suggestedCanonical?: string }>;
	};
	try {
		const raw = await readFile(
			await preferredChromePathsFile(pageDir),
			"utf-8",
		);
		classifyJson = JSON.parse(raw);
	} catch {
		return null;
	}

	return {
		hash,
		url: contentJson.url,
		content: contentJson.content,
		chromePaths: classifyJson.chromePaths,
	};
}

async function safeReaddir(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

interface MaterializedShapeInput {
	chrome: unknown;
	chromePaths: Array<{ sourcePath: string; suggestedCanonical?: string }>;
}

interface ShapeProvenanceEntry {
	sourcePath: string;
	candidatePath: string;
	materializedPath?: string;
	role?: "value" | "identity-key";
}

async function readPreferredMaterializedShape(
	pageDir: string,
): Promise<MaterializedShapeInput | null> {
	try {
		const [chromeRaw, provenanceRaw] = await Promise.all([
			readFile(
				join(pageDir, "output", "shape-normalized-chrome.materialized.json"),
				"utf-8",
			),
			readFile(
				join(pageDir, "output", "shape-normalized-chrome.provenance.json"),
				"utf-8",
			),
		]);
		const chrome = JSON.parse(chromeRaw) as unknown;
		const provenance = JSON.parse(provenanceRaw) as ShapeProvenanceEntry[];
		return {
			chrome,
			chromePaths: provenance
				.filter(
					(entry) => entry.role !== "identity-key" && entry.materializedPath,
				)
				.map((entry) => ({
					sourcePath: entry.materializedPath as string,
					suggestedCanonical: entry.candidatePath,
				})),
		};
	} catch {
		return null;
	}
}

export async function preferredChromePathsFile(
	pageDir: string,
): Promise<string> {
	try {
		await readFile(
			join(pageDir, "output", "shape-normalized-chrome.json"),
			"utf-8",
		);
		return join(pageDir, "output", "shape-normalized-chrome.json");
	} catch {
		return join(pageDir, "output", "chrome-classify.json");
	}
}

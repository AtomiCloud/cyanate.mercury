#!/usr/bin/env bun
/**
 * CLI validator for harmonize-align rename ops.
 *
 * Thin argv wrapper around `validateAlignOps`. The align agent invokes it
 * via `./validate` during its tool-use loop: writes ops.json, runs this,
 * reads stdout, fixes errors, re-runs, submits.
 *
 * Usage:
 *   bun run validate-align-ops.ts <digest.json> <ops.json> [<signals.json>]
 *
 * Stdout (single JSON object, always):
 *   On invalid:
 *     { "valid": false, "errors": ["<sub-check>: <message>", ...] }
 *   On valid (including empty ops):
 *     { "valid": true, "errors": [],
 *       "summary": {
 *         "candidatesBefore": N, "candidatesAfter": M,
 *         "sharedOnAllBefore": X, "sharedOnAllAfter": Y,
 *         "meanJaccardBefore": 0.xxx | null,
 *         "meanJaccardAfter":  0.xxx | null,
 *         "folds": [{ "canonical": "...", "sources": [...], "pagesWithBucket": N }]
 *       }
 *     }
 *
 * Exit code: 0 when valid, 1 when invalid.
 *
 * The summary lets the agent sanity-check its own output: see which paths
 * got merged into which canonicals and how much alias collapse happened,
 * before submitting. It is NOT the convergence reviewer (that's a separate
 * LLM step the runner invokes on the final table).
 */

import { readFile } from "node:fs/promises";
import { validateAlignOps } from "../lib/harmonize-align-validate.js";
import { computeConvergenceMetrics } from "../lib/harmonize-metrics.js";
import type {
	PageTypeDigest,
	RichRenameOp,
	StructuralSignals,
} from "../lib/harmonize-types.js";

interface SummaryFold {
	canonical: string;
	sources: string[];
	pagesWithBucket: number;
}

interface Summary {
	candidatesBefore: number;
	candidatesAfter: number;
	sharedOnAllBefore: number;
	sharedOnAllAfter: number;
	meanJaccardBefore: number | null;
	meanJaccardAfter: number | null;
	folds: SummaryFold[];
}

interface Output {
	valid: boolean;
	errors: string[];
	summary?: Summary;
}

async function main(): Promise<void> {
	const [, , digestPath, opsPath, signalsPath] = process.argv;
	if (!digestPath || !opsPath) {
		console.error(
			"usage: validate-align-ops <digest.json> <ops.json> [<signals.json>]",
		);
		process.exit(2);
	}

	const digest = await readJson<PageTypeDigest>(digestPath);
	if (!digest.ok) return emitAndExit({ valid: false, errors: [digest.error] });

	const opsParsed = await readOps(opsPath);
	if (!opsParsed.ok)
		return emitAndExit({ valid: false, errors: [opsParsed.error] });

	let signals: StructuralSignals | undefined;
	if (signalsPath) {
		const s = await readJson<StructuralSignals>(signalsPath);
		if (s.ok) signals = s.value;
		// Malformed signals.json is ignored — signals are optional.
	}

	const result = validateAlignOps(digest.value, signals, opsParsed.value);
	if (!result.valid) {
		return emitAndExit({ valid: false, errors: result.errors });
	}

	const metrics = computeConvergenceMetrics(
		digest.value,
		result.postDigest,
		result.flat,
	);
	const summary: Summary = {
		candidatesBefore: metrics.candidatesBefore,
		candidatesAfter: metrics.candidatesAfter,
		sharedOnAllBefore: metrics.sharedOnAllBefore,
		sharedOnAllAfter: metrics.sharedOnAllAfter,
		meanJaccardBefore: metrics.meanJaccardBefore,
		meanJaccardAfter: metrics.meanJaccardAfter,
		folds: metrics.foldBuckets.map((b) => ({
			canonical: b.canonical,
			sources: b.sources,
			pagesWithBucket: b.pagesWithBucket,
		})),
	};
	return emitAndExit({ valid: true, errors: [], summary });
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

async function readOps(path: string): Promise<Parsed<RichRenameOp[]>> {
	const parsed = await readJson<unknown>(path);
	if (!parsed.ok) return parsed;
	if (!Array.isArray(parsed.value)) {
		return {
			ok: false,
			error: `${path} must contain a JSON array of rename ops`,
		};
	}
	return { ok: true, value: parsed.value as RichRenameOp[] };
}

function emitAndExit(output: Output): void {
	process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
	process.exit(output.valid ? 0 : 1);
}

main().catch((err) => {
	process.stdout.write(
		`${JSON.stringify({ valid: false, errors: [`cli crashed: ${String(err)}`] })}\n`,
	);
	process.exit(1);
});

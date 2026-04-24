/**
 * Phase 4 — `chrome-verify`
 *
 * Deterministic round-trip verifier. For every page in every page-type:
 *   1. Read classify-input/<pagetype>/<hash>/content.json (original).
 *   2. Read classify-output/<pagetype>/fold-meta/<hash>.json (mapper).
 *   3. Read classify-output/<pagetype>/chrome.json (canonical).
 *   4. Verify every mapper entry's sourcePath resolves on content, its
 *      canonicalField resolves on canonical, and values match (stable hash).
 *   5. Compute per-page body via splitByChromePaths and write
 *      classify-output/<pagetype>/body/<hash>.json.
 *
 * Writes classify-output/<pagetype>/verify-report.json with per-page results.
 *
 * `maxRetries: 0` — a failed verify means Stage 3's output is structurally
 * wrong. Halt for investigation; don't retry.
 */

import {
	access,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type {
	PhaseDef,
	StepContext,
	StepResult,
} from "../../../engine/types.js";
import { programmaticStep } from "../../../steps/step.js";
import { type VerifyPageResult, verifyPageType } from "../lib/chrome-verify.js";
import {
	CHROME_DYNAMIC_SENTINEL,
	type ChromeDynamic,
	type PageMapper,
} from "../lib/harmonize-types.js";

export const chromeVerifyPhase: PhaseDef = {
	id: "chrome-verify",
	name: "Chrome verify",
	description:
		"Deterministic round-trip: body + mapper(canonical) ≡ content. Writes per-page body.json and verify-report.json.",
	maxRetries: 0,
	steps: [
		programmaticStep({
			id: "chrome-verify",
			name: "Chrome verify",
			description:
				"For every page, verify mapper entries resolve and match canonical values. Write per-page body + aggregated report.",
			run: runChromeVerify,
		}),
	],
};

async function runChromeVerify(ctx: StepContext): Promise<StepResult> {
	const start = Date.now();
	const outputRoot = join(ctx.workdir, "classify-output");
	const inputRoot = join(ctx.workdir, "classify-input");

	let pagetypes: string[];
	try {
		pagetypes = await safeReaddir(outputRoot);
	} catch (err) {
		return {
			status: "fail",
			error: `chrome-verify: failed to list classify-output/: ${String(err)}`,
			duration: Date.now() - start,
		};
	}
	if (pagetypes.length === 0) {
		return {
			status: "fail",
			error:
				"chrome-verify: no page-types under classify-output/ — Stage 3 likely did not run",
			duration: Date.now() - start,
		};
	}

	const failures: string[] = [];
	let totalPass = 0;
	let totalFail = 0;

	for (const pagetype of pagetypes) {
		try {
			const result = await verifyOnePageType(
				join(outputRoot, pagetype),
				join(inputRoot, pagetype),
				pagetype,
			);
			if (result.status === "skipped") continue;
			totalPass += result.passCount;
			totalFail += result.failCount;
			if (result.status === "fail") {
				failures.push(
					`${pagetype}: ${result.failCount}/${result.passCount + result.failCount} pages failed`,
				);
			}
		} catch (err) {
			failures.push(`${pagetype}: ${String(err)}`);
		}
	}

	const duration = Date.now() - start;
	if (failures.length > 0) {
		return {
			status: "fail",
			error: `chrome-verify failed:\n${failures.join("\n")}\nTotals: ${totalPass} pass / ${totalFail} fail`,
			duration,
		};
	}
	return { status: "pass", duration };
}

async function verifyOnePageType(
	outputDir: string,
	inputDir: string,
	pagetype: string,
): Promise<{
	status: "pass" | "fail" | "skipped";
	passCount: number;
	failCount: number;
}> {
	const canonicalPath = join(outputDir, "chrome.json");
	try {
		await access(canonicalPath);
	} catch {
		// Single-page pagetypes skip harmonize-verdicts/assemble and so have no
		// chrome.json. Mark as skipped rather than failing the phase; a future
		// cross-pagetype harmonization will produce outputs for these.
		const digestPath = join(outputDir, "digest.json");
		try {
			const digestRaw = await readFile(digestPath, "utf-8");
			const digest = JSON.parse(digestRaw) as { totalPages?: number };
			if ((digest.totalPages ?? 0) <= 1) {
				return { status: "skipped", passCount: 0, failCount: 0 };
			}
		} catch {
			// fall through to the original hard error
		}
		throw new Error(
			`Stage 3 (harmonize-assemble) did not produce outputs for "${pagetype}" — expected ${canonicalPath} to exist. Check Stage 3 artifacts under classify-output/${pagetype}/ (digest.json, rename-table.json, verdicts.json) and attempts/ for per-phase failures.`,
		);
	}
	const canonicalRaw = await readFile(canonicalPath, "utf-8");
	const canonical = JSON.parse(canonicalRaw) as unknown;

	const chromeDynamic = await loadChromeDynamic(outputDir, pagetype, canonical);

	const foldDir = join(outputDir, "fold-meta");
	const mapperFiles = await safeReaddir(foldDir);

	const pages: Array<{ hash: string; content: unknown; mapper: PageMapper }> =
		[];
	for (const file of mapperFiles) {
		if (!file.endsWith(".json")) continue;
		const hash = file.slice(0, -".json".length);
		const mapperRaw = await readFile(join(foldDir, file), "utf-8");
		const mapper = JSON.parse(mapperRaw) as PageMapper;
		const contentRaw = await readFile(
			join(inputDir, hash, "content.json"),
			"utf-8",
		);
		const contentJson = JSON.parse(contentRaw) as {
			url: string;
			pagetype: string;
			content: unknown;
		};
		pages.push({ hash, content: contentJson.content, mapper });
	}

	const verifyResult = verifyPageType({
		pagetype,
		canonical,
		chromeDynamic,
		pages,
	});

	const bodyDir = join(outputDir, "body");
	await rm(bodyDir, { recursive: true, force: true });
	await mkdir(bodyDir, { recursive: true });
	// Write body for every page — including failing ones. `body` is derived
	// deterministically from `splitByChromePaths(content, mapper.entries.sourcePaths)`
	// and is well-defined regardless of whether value-hash checks passed.
	// The failure mode lives in verify-report.json; downstream tools that open
	// body.json on a failing phase get a real file (and the phase failing
	// prevents downstream segments from running anyway).
	for (const per of verifyResult.perPage) {
		await writeFile(
			join(bodyDir, `${per.hash}.json`),
			JSON.stringify(per.body, null, 2),
		);
	}

	const report = {
		pagetype,
		status: verifyResult.status,
		passCount: verifyResult.passCount,
		failCount: verifyResult.failCount,
		perPage: verifyResult.perPage.map((r: VerifyPageResult) => ({
			hash: r.hash,
			status: r.status,
			chromeEntryCount: r.chromeEntryCount,
			demotedCount: r.demotedCount,
			errors: r.errors,
		})),
	};
	await writeFile(
		join(outputDir, "verify-report.json"),
		JSON.stringify(report, null, 2),
	);

	return {
		status: verifyResult.status,
		passCount: verifyResult.passCount,
		failCount: verifyResult.failCount,
	};
}

async function safeReaddir(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

async function loadChromeDynamic(
	outputDir: string,
	pagetype: string,
	canonical: unknown,
): Promise<ChromeDynamic> {
	const dynamicPath = join(outputDir, "chrome-dynamic.json");
	try {
		const raw = await readFile(dynamicPath, "utf-8");
		return JSON.parse(raw) as ChromeDynamic;
	} catch (err) {
		if (canonicalHasDynamicSentinel(canonical)) {
			throw new Error(
				`Stage 3 (harmonize-assemble) did not produce chrome-dynamic.json for "${pagetype}" but canonical contains keep-dynamic sentinels — expected ${dynamicPath} to exist. Cause: ${String(err)}`,
			);
		}
		return {};
	}
}

function canonicalHasDynamicSentinel(value: unknown): boolean {
	if (value === CHROME_DYNAMIC_SENTINEL) return true;
	if (Array.isArray(value)) {
		return value.some(canonicalHasDynamicSentinel);
	}
	if (value !== null && typeof value === "object") {
		return Object.values(value as Record<string, unknown>).some(
			canonicalHasDynamicSentinel,
		);
	}
	return false;
}

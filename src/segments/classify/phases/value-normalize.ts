/**
 * Phase 2 — `per-page-value-normalize`
 *
 * Two steps:
 *   - `a0-normalize`          (agent fan-out): deterministic pre-pass +
 *                             per-leaf LLM batch for ambiguous leaves.
 *                             Winning attempt per unit promotes to
 *                             `normalize/output/normalization.json`.
 *   - `apply-normalizations`  (programmatic): derive per-unit
 *                             `normalize/output/normalized-content.json`
 *                             by applying each entry's normalization.
 *
 * Renamed from `per-page-normalize` in the previous layout. Profile key in
 * `cui.yaml` moves with it: `classify.per-page-value-normalize.a0-normalize`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PhaseDef } from "../../../engine/types.js";
import { agentFanOutStep, programmaticStep } from "../../../steps/step.js";
import type { PreparedPage } from "../../prepare/ingest.js";
import { deterministicNormalize } from "../deterministic-normalize.js";
import { runFanOutWithPerUnitRetry } from "../fan-out.js";
import { llmNormalizeLeaves } from "../llm-normalize.js";
import {
	applyAllNormalizations,
	checkNormalization,
	classifyUnitHash,
	findMissingNormalization,
	getClassifyUnits,
	type NormalizationCheck,
	type NormalizationEntry,
	type PageNormalization,
	parseNormalizationFromAgent,
} from "../per-page-classify.js";
import type { ClassifyUnit } from "../types.js";

const MAX_CLASSIFY_UNIT_ATTEMPTS = 3;

async function readJson<T>(workdir: string, filename: string): Promise<T> {
	const raw = await readFile(join(workdir, filename), "utf-8");
	return JSON.parse(raw) as T;
}

async function readAgentArtifact<T>(
	workdir: string,
	hash: string,
	filename: string,
	parse: (raw: string) => T | null,
): Promise<T | null> {
	try {
		const raw = await readFile(
			join(workdir, "classify-input", hash, filename),
			"utf-8",
		);
		return parse(raw);
	} catch {
		return null;
	}
}

/**
 * Build a concise human summary of a failed normalization check for the
 * `unitErrors` map / rejection context / verdict.json.
 */
function summarizeCheck(check: NormalizationCheck, url: string): string {
	const parts: string[] = [];
	if (check.missing.length > 0) {
		const head = check.missing
			.slice(0, 10)
			.map((p) => `"${p}"`)
			.join(", ");
		const tail =
			check.missing.length > 10 ? ` (+${check.missing.length - 10} more)` : "";
		parts.push(
			`missing ${check.missing.length}/${check.expectedPaths.length} leaf path(s): ${head}${tail}`,
		);
	}
	if (check.extra.length > 0) {
		const head = check.extra
			.slice(0, 10)
			.map((p) => `"${p}"`)
			.join(", ");
		const tail =
			check.extra.length > 10 ? ` (+${check.extra.length - 10} more)` : "";
		parts.push(`extra paths not in content: ${head}${tail}`);
	}
	if (check.typeErrors.length > 0) {
		parts.push(...check.typeErrors.slice(0, 10));
		if (check.typeErrors.length > 10) {
			parts.push(`(+${check.typeErrors.length - 10} more type errors)`);
		}
	}
	if (check.roundTripErrors.length > 0) {
		parts.push(...check.roundTripErrors.slice(0, 10));
		if (check.roundTripErrors.length > 10) {
			parts.push(
				`(+${check.roundTripErrors.length - 10} more round-trip mismatches)`,
			);
		}
	}
	return `Normalization failed for page "${url}":\n${parts.join("\n")}`;
}

export const perPageValueNormalizePhase: PhaseDef = {
	id: "per-page-value-normalize",
	name: "Per-page value normalize",
	description:
		"Value normalization per page with per-attempt papertrail; writes normalize/output/normalization.json on success",
	maxRetries: 2,
	steps: [
		agentFanOutStep({
			id: "a0-normalize",
			name: "Normalize values",
			description:
				"Per-page fan-out: deterministic pre-pass + per-leaf LLM calls for ambiguous leaves; papertrail under classify-input/<hash>/normalize/attempt-<N>/",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const { pages } = await readJson<{ pages: PreparedPage[] }>(
						ctx.workdir,
						"prepared-content.json",
					);
					if (pages.length === 0) {
						return { status: "pass", duration: Date.now() - start };
					}

					const units = getClassifyUnits(pages);
					const unitErrors = new Map<string, string>();

					const runUnit = async (
						unit: ClassifyUnit,
						_rejCtx: string | undefined,
						attemptIndex: number,
					): Promise<PageNormalization | null> => {
						const hashDir = join(ctx.workdir, "classify-input", unit.id);
						const attemptDir = join(
							hashDir,
							"normalize",
							`attempt-${attemptIndex}`,
						);
						const outputDir = join(hashDir, "normalize", "output");
						await mkdir(attemptDir, { recursive: true });

						const det = deterministicNormalize(unit.page.content);
						await writeFile(
							join(attemptDir, "deterministic.json"),
							JSON.stringify(
								{
									resolvedCount: Object.keys(det.resolved).length,
									ambiguousCount: det.ambiguous.length,
									ambiguous: det.ambiguous,
								},
								null,
								2,
							),
						);

						const llm = await llmNormalizeLeaves({
							page: unit.page,
							ambiguous: det.ambiguous,
							workdir: ctx.workdir,
							attemptDir,
							profile: ctx.profile,
							stepNameBase: `${ctx.segmentId}/${ctx.phaseId}/a0-normalize/${unit.id}/attempt-${attemptIndex}`,
							logger: ctx.logger,
							config: ctx.config,
						});

						const entries: Record<string, NormalizationEntry> = {
							...det.resolved,
							...llm.resolved,
						};
						const stitched: PageNormalization = {
							url: unit.page.url,
							pagetype: unit.page.pagetype,
							entries,
						};

						const check = checkNormalization(stitched, unit.page.content);
						await writeFile(
							join(attemptDir, "verdict.json"),
							JSON.stringify({ ...check, llmFailures: llm.failed }, null, 2),
						);

						if (!check.valid || llm.failed.length > 0) {
							const summary = summarizeCheck(check, unit.page.url);
							const failedSummary =
								llm.failed.length > 0
									? `\n${llm.failed.length} leaf(s) failed LLM resolution: ${llm.failed
											.slice(0, 10)
											.map((f) => `"${f.path}" (${f.reason})`)
											.join("; ")}`
									: "";
							unitErrors.set(unit.id, `${summary}${failedSummary}`);
							return null;
						}

						await mkdir(outputDir, { recursive: true });
						await writeFile(
							join(outputDir, "normalization.json"),
							JSON.stringify(stitched, null, 2),
						);
						unitErrors.delete(unit.id);
						return stitched;
					};

					const fanResult = await runFanOutWithPerUnitRetry<
						ClassifyUnit,
						PageNormalization
					>({
						units,
						getUnitId: (u) => u.id,
						maxConcurrent: units.length,
						maxAttempts: MAX_CLASSIFY_UNIT_ATTEMPTS,
						runUnit,
						mergeResult: (_prior, next) => next,
						findMissing: (results) =>
							findMissingNormalization(results, units, unitErrors),
						reviewerIdPrefix: "per-page-value-normalize",
					});

					if (fanResult.status === "reject") {
						return {
							status: "reject",
							reviews: fanResult.reviews,
							duration: Date.now() - start,
						};
					}
					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `a0-normalize failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),

		programmaticStep({
			id: "apply-normalizations",
			name: "Apply normalizations",
			description:
				"Derive normalize/output/normalized-content.json per hash from content.json + normalize/output/normalization.json",
			run: async (ctx) => {
				const start = Date.now();
				try {
					const { pages } = await readJson<{ pages: PreparedPage[] }>(
						ctx.workdir,
						"prepared-content.json",
					);
					for (const page of pages) {
						const hash = classifyUnitHash(page.url);
						const norm = await readAgentArtifact<PageNormalization>(
							ctx.workdir,
							hash,
							"normalize/output/normalization.json",
							(raw) => parseNormalizationFromAgent(raw, page),
						);
						if (!norm) continue;
						const normalizedContent = applyAllNormalizations(
							page.content,
							norm,
						);
						const outputDir = join(
							ctx.workdir,
							"classify-input",
							hash,
							"normalize",
							"output",
						);
						await mkdir(outputDir, { recursive: true });
						await writeFile(
							join(outputDir, "normalized-content.json"),
							JSON.stringify(
								{
									url: page.url,
									pagetype: page.pagetype,
									content: normalizedContent,
								},
								null,
								2,
							),
						);
					}
					return { status: "pass", duration: Date.now() - start };
				} catch (err) {
					return {
						status: "fail",
						error: `apply-normalizations failed: ${String(err)}`,
						duration: Date.now() - start,
					};
				}
			},
		}),
	],
};

/**
 * Classify segment registration.
 *
 * Pipeline wired so far:
 *   1. classify-prepare            (programmatic — write per-page content.json inputs)
 *   2. per-page-value-normalize    (merged value-normalize + noise detection;
 *                                   every leaf is visited by the LLM at most once)
 *
 * Stages 3–5 add phases 4 (chunk-remap), 5 (fate-scope), 6 (shape-and-kind).
 * Stage 6 re-introduces `page-classifications.json` in `extractOutput` with
 * the new `PageClassification[]` shape. See `CLASSIFY-REWRITE-PROGRESS.md`.
 */

import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { registry } from "../../engine/registry.js";
import type { SegmentDef } from "../../engine/types.js";
import {
	classifyPreparePhase,
	perPageValueNormalizePhase,
} from "./phases.io.js";

const classifySegment: SegmentDef = {
	id: "classify",
	name: "Classify",
	description:
		"Per-page AI classification — merged value normalization + noise detection (phases 4–6 land in follow-up stages)",
	depends: ["prepare"],
	phases: [classifyPreparePhase, perPageValueNormalizePhase],
	mergeInputs: async (workdir, deps) => {
		const preparePath = deps.prepare;
		if (!preparePath) return;

		const files = [
			"pages.json",
			"page-type-meta.json",
			"prepared-content.json",
			"asset-manifest.json",
			"structure-map.json",
			"heuristics.json",
		];

		for (const file of files) {
			try {
				await cp(join(preparePath, file), join(workdir, file));
			} catch {
				// Not all files may exist — not fatal at merge time
			}
		}
	},
	extractOutput: async (workdir, outputDir) => {
		await mkdir(outputDir, { recursive: true });

		// Pre-Stage-6: only pass through prepare outputs that downstream segments
		// still depend on. `page-classifications.json` + coverage report are
		// re-introduced in Stage 6 once the full block-level pipeline exists.
		const files = ["asset-manifest.json", "prepared-content.json"];

		for (const file of files) {
			try {
				await cp(join(workdir, file), join(outputDir, file));
			} catch (err) {
				console.warn(
					`[classify:extractOutput] Failed to copy ${file}: ${String(err)}`,
				);
			}
		}
	},
};

registry.register(classifySegment);

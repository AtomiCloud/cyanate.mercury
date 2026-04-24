/**
 * Classify segment registration.
 *
 * Pipeline wired:
 *   1. classify-prepare           (programmatic — write per-page content.json
 *                                   under classify-input/<pagetype>/<hash>/)
 *   2. chrome-classify            (agent fan-out — per-page chrome classify
 *                                   with inline reviewer)
 *   3. chrome-shape-normalize     (agent fan-out — per-page shape normalization
 *                                   with reviewer+fixer)
 *
 * Temporarily stops after `chrome-shape-normalize` while that phase is being
 * debugged, to avoid spending tokens in downstream harmonize/verify phases.
 *
 * Cross-pagetype (global) harmonize lands as a later stage — see
 * `CLASSIFY-PLAN.md`.
 */

import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { registry } from "../../engine/registry.js";
import type { SegmentDef } from "../../engine/types.js";
import {
	chromeClassifyPhase,
	chromeShapeNormalizePhase,
	chromeVerifyPhase,
	classifyPreparePhase,
	harmonizeAlignPhase,
	harmonizeAssemblePhase,
	harmonizeMaterializePhase,
	harmonizePreparePhase,
	harmonizeVerdictsPhase,
} from "./phases.io.js";

// Temporary token-saving gate while debugging shape normalization.
// Set to `false` to restore the full classify pipeline.
const DEBUG_STOP_AFTER_CHROME_SHAPE_NORMALIZE = true;

const classifyPhases = DEBUG_STOP_AFTER_CHROME_SHAPE_NORMALIZE
	? [classifyPreparePhase, chromeClassifyPhase, chromeShapeNormalizePhase]
	: [
			classifyPreparePhase,
			chromeClassifyPhase,
			chromeShapeNormalizePhase,
			harmonizePreparePhase,
			harmonizeAlignPhase,
			harmonizeMaterializePhase,
			harmonizeVerdictsPhase,
			harmonizeAssemblePhase,
			chromeVerifyPhase,
		];

const classifySegment: SegmentDef = {
	id: "classify",
	name: "Classify",
	description:
		"Classify segment — materializes per-page content.json inputs, runs per-page chrome classify, then stops after chrome shape-normalize while that phase is being debugged.",
	depends: ["prepare"],
	phases: classifyPhases,
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

		// Pass through the canonical chrome + mappers + bodies for downstream
		// segments (Layout/Design/Color). The classify-output tree is the single
		// source of truth post-Stage 4.
		try {
			await cp(
				join(workdir, "classify-output"),
				join(outputDir, "classify-output"),
				{ recursive: true },
			);
		} catch (err) {
			console.warn(
				`[classify:extractOutput] Failed to copy classify-output/: ${String(err)}`,
			);
		}
	},
};

registry.register(classifySegment);

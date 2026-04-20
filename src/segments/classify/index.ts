/**
 * Classify segment registration.
 *
 * Pipeline wired:
 *   1. classify-prepare   (programmatic — write per-page content.json inputs
 *                          under classify-input/<pagetype>/<hash>/)
 *
 * Per-page chrome classify, per-pagetype harmonize, materialize + verify,
 * and cross-pagetype harmonize land as later stages — see
 * `CLASSIFY-PLAN.md` at the repo root.
 */

import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { registry } from "../../engine/registry.js";
import type { SegmentDef } from "../../engine/types.js";
import { classifyPreparePhase } from "./phases.io.js";

const classifySegment: SegmentDef = {
	id: "classify",
	name: "Classify",
	description:
		"Classify segment — currently only materializes per-page content.json inputs under classify-input/<pagetype>/<hash>/. Chrome detection + harmonize phases land incrementally.",
	depends: ["prepare"],
	phases: [classifyPreparePhase],
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

		// Pass through prepare artifacts downstream segments still rely on.
		// Chrome/body/template outputs will be added as later stages land.
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

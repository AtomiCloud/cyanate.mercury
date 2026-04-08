/**
 * Analyze segment registration.
 *
 * Segment 1 (FR-4): Extracts a reference website's visual design into
 * canonical JSON artifacts. No dependencies — runs first in the DAG.
 */

import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { registry } from "../../engine/registry.js";
import type { SegmentDef } from "../../engine/types.js";
import {
	extractPhase,
	identifyPhase,
	mergePhase,
	validatePhase,
} from "./phases.io.js";

const analyzeSegment: SegmentDef = {
	id: "analyze",
	name: "Analyze Reference Site",
	description:
		"Extract a reference website's visual design into style-fingerprint.json, design-tokens.json, and component-recipes.json",
	depends: [],
	phases: [identifyPhase, extractPhase, mergePhase, validatePhase],
	mergeInputs: async () => {
		// No-op: analyze has no dependencies
	},
	extractOutput: async (workdir, outputDir) => {
		await mkdir(outputDir, { recursive: true });

		// Copy the 3 canonical JSONs
		const files = [
			"style-fingerprint.json",
			"design-tokens.json",
			"component-recipes.json",
		];
		for (const file of files) {
			try {
				await cp(join(workdir, file), join(outputDir, file));
			} catch (err) {
				console.warn(
					`[analyze:extractOutput] Failed to copy ${file}: ${String(err)}`,
				);
			}
		}

		// Copy patterns directory if it exists
		try {
			await cp(join(workdir, "patterns"), join(outputDir, "patterns"), {
				recursive: true,
			});
		} catch (err) {
			console.warn(
				`[analyze:extractOutput] Failed to copy patterns/: ${String(err)}`,
			);
		}

		// Copy catalog for downstream segments
		try {
			await cp(join(workdir, "catalog.json"), join(outputDir, "catalog.json"));
		} catch (err) {
			console.warn(
				`[analyze:extractOutput] Failed to copy catalog.json: ${String(err)}`,
			);
		}
	},
};

registry.register(analyzeSegment);

/**
 * Prepare segment registration.
 *
 * Fully deterministic (zero-AI) data preparation — downloads all assets,
 * resolves route conflicts, rewrites references, builds structural heuristics.
 * No dependencies — runs in parallel with analyze.
 */

import { access, constants, cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { registry } from "../../engine/registry.js";
import type { SegmentDef } from "../../engine/types.js";
import {
	applyRewritesPhase,
	buildHeuristicsPhase,
	downloadAssetsPhase,
	ingestPhase,
	resolveRoutesPhase,
	validateDatasetPhase,
} from "./phases.io.js";

const prepareSegment: SegmentDef = {
	id: "prepare",
	name: "Prepare Dataset",
	description:
		"Download assets, resolve routes, rewrite references, build heuristics. Fully programmatic — zero AI.",
	depends: [],
	phases: [
		ingestPhase,
		downloadAssetsPhase,
		resolveRoutesPhase,
		applyRewritesPhase,
		buildHeuristicsPhase,
		validateDatasetPhase,
	],
	mergeInputs: async (workdir, _deps, config) => {
		const inputFiles = ["structure.json", "schema.json", "content.json"];
		for (const file of inputFiles) {
			const src = join(config.input, file);
			const dst = join(workdir, file);
			try {
				await access(src, constants.R_OK);
				await cp(src, dst);
			} catch {
				// Input file may not exist — not fatal at merge time
			}
		}
	},
	extractOutput: async (workdir, outputDir) => {
		await mkdir(outputDir, { recursive: true });

		// Copy the 6 output artifacts
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
				await cp(join(workdir, file), join(outputDir, file));
			} catch (err) {
				console.warn(
					`[prepare:extractOutput] Failed to copy ${file}: ${String(err)}`,
				);
			}
		}

		// Copy images directory
		try {
			await cp(join(workdir, "images"), join(outputDir, "images"), {
				recursive: true,
			});
		} catch (err) {
			console.warn(
				`[prepare:extractOutput] Failed to copy images/: ${String(err)}`,
			);
		}
	},
};

registry.register(prepareSegment);

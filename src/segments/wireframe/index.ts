/**
 * Wireframe segment registration.
 *
 * Segment 2 (FR-5): Transforms scraper output into a working unstyled Astro project.
 * No dependencies — runs independently in the DAG.
 */

import { copyFile, cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { registry } from "../../engine/registry.js";
import type { SegmentDef } from "../../engine/types.js";
import {
	classifyPhase,
	generatePhase,
	reducePhase,
	seedPhase,
	validatePhase,
} from "./phases.io.js";

const wireframeSegment: SegmentDef = {
	id: "wireframe",
	name: "Wireframe",
	description:
		"Transform scraper output into an unstyled Astro project with content collections, routes, and wireframe components",
	depends: [],
	phases: [reducePhase, classifyPhase, seedPhase, generatePhase, validatePhase],
	mergeInputs: async (_workdir, _deps, _config) => {
		// No-op: wireframe has no dependencies
		// Input files are copied at step time by copyInputFilesToWorkdir()
	},
	extractOutput: async (workdir, outputDir) => {
		await mkdir(outputDir, { recursive: true });

		// Copy the Astro project
		const projectDir = join(workdir, "project");
		try {
			await cp(projectDir, join(outputDir, "project"), {
				recursive: true,
			});
		} catch (err) {
			console.warn(
				`[wireframe:extractOutput] Failed to copy project/: ${String(err)}`,
			);
		}

		// Copy manifest files
		const manifestFiles = [
			"registry.json",
			"content-model.json",
			"asset-manifest.json",
			"reduced-meta.json",
			"registry-draft.json",
			"listing-pairings.json",
		];
		for (const file of manifestFiles) {
			try {
				await copyFile(join(workdir, file), join(outputDir, file));
			} catch {
				// Manifest may not exist
			}
		}
	},
};

registry.register(wireframeSegment);
